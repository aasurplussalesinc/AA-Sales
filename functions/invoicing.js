/**
 * SkidSling - invoicing & automatic collections (Stripe Connect).
 *
 * A company (tenant) connects its OWN Stripe account (Connect, Standard). Its
 * customers pay SkidSling invoices through Stripe-hosted Checkout on that
 * account; every payment lands in the `payments` ledger and back on the order.
 *
 * Kept completely apart from SkidSling's own subscription billing:
 *   - its own Stripe key (STRIPE_CONNECT_SECRET_KEY) and client instance,
 *   - its own webhook endpoint (stripeConnectWebhook) and secret
 *     (STRIPE_CONNECT_WEBHOOK_SECRET), registered in Stripe as a Connect
 *     webhook ("events on connected accounts"),
 *   - its own org fields (organizations/{id}.payments.*), never
 *     stripeCustomerId / stripeSubscriptionId / plan.
 * The platform endpoint (stripeWebhook) ignores connected-account events, and
 * this endpoint ignores platform events. See docs/PLAN_stripe_invoicing.md.
 *
 * Tenant isolation: every callable proves org membership (authz.js); every
 * Stripe call for a company passes that company's account id as
 * `stripeAccount`; every webhook event is mapped to exactly one org through
 * stripeAccounts/{accountId} and ignored when the account is unknown.
 *
 * The decisions (money, statuses, reminders, tokens) live in invoicingCore.js.
 */

var CORE = require('./invoicingCore');

module.exports = function createInvoicing(deps) {
  var functions = deps.functions;
  var db = deps.db;
  var AUTHZ = deps.AUTHZ;
  var env = deps.env || process.env;
  var nowFn = deps.now || function () { return Date.now(); };
  // Injected in tests; in production a real Stripe client for the CONNECT key.
  var stripeFactory = deps.stripeFactory || function (key) { return require('stripe')(key); };

  var HttpsError = functions.https.HttpsError;

  // ─────────────────────────────────────────────────────── plumbing ────

  var _stripe = null, _stripeKey = null;
  function config() { return CORE.invoicingConfig(env); }

  /** The Connect-key Stripe client, or a clear refusal if the env is wrong. */
  function connectStripe() {
    var cfg = config();
    if (!cfg.ok) {
      throw new HttpsError('failed-precondition',
        'Online payments are not configured on the server: ' + cfg.errors.join('; '));
    }
    if (!_stripe || _stripeKey !== cfg.secretKey) {
      _stripe = stripeFactory(cfg.secretKey);
      _stripeKey = cfg.secretKey;
    }
    return { stripe: _stripe, cfg: cfg };
  }

  async function loadOrg(orgId) {
    var snap = await db.collection('organizations').doc(orgId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Organization not found');
    return snap.data() || {};
  }

  function orgPaymentsView(org) {
    var p = org.payments || {};
    return {
      enabled: !!p.enabled,
      state: CORE.connectionState(p),
      stripeAccountId: p.stripeAccountId || null,
      mode: p.mode || null,
      chargesEnabled: !!p.chargesEnabled,
      payoutsEnabled: !!p.payoutsEnabled,
      detailsSubmitted: !!p.detailsSubmitted,
      currentlyDue: p.currentlyDue || [],
      connectedAt: p.connectedAt || null
    };
  }

  // Merge into organizations/{orgId}.payments without touching anything else
  // on the org doc (billing fields in particular).
  async function mergeOrgPayments(orgId, patch) {
    await db.collection('organizations').doc(orgId).set({ payments: patch, updatedAt: nowFn() }, { merge: true });
  }

  async function logActivity(orgId, action, details, who) {
    try {
      await db.collection('activityLog').add({
        orgId: orgId, action: action, details: details || {},
        userEmail: who || 'SkidSling payments',
        timestamp: nowFn(), createdAt: new Date(nowFn()).toISOString()
      });
    } catch (e) { console.warn('activityLog write failed:', e.message); }
  }

  function callerEmail(context) {
    return (context && context.auth && context.auth.token && context.auth.token.email) || 'Unknown';
  }

  // ─────────────────────────────────────── Phase 1: Connect onboarding ────

  /**
   * Record that a Stripe account belongs to an org. One account, one org:
   * a second org trying to claim an account already mapped elsewhere is
   * refused, so webhook events can never be attributed to the wrong tenant.
   */
  async function claimAccount(orgId, accountId, mode, via) {
    var ref = db.collection('stripeAccounts').doc(accountId);
    await db.runTransaction(async function (tx) {
      var cur = await tx.get(ref);
      if (cur.exists && cur.data().orgId !== orgId) {
        throw new HttpsError('already-exists', 'That Stripe account is already connected to another SkidSling organization.');
      }
      tx.set(ref, { orgId: orgId, accountId: accountId, mode: mode, via: via,
                    active: true, updatedAt: nowFn(),
                    createdAt: cur.exists ? (cur.data().createdAt || nowFn()) : nowFn() }, { merge: true });
    });
  }

  async function refreshAccountFlags(orgId, accountId) {
    var s = connectStripe();
    var acct = await s.stripe.accounts.retrieve(accountId);
    var flags = CORE.accountFlags(acct);
    var patch = Object.assign({}, flags, { flagsUpdatedAt: nowFn() });
    var org = await loadOrg(orgId);
    var p = org.payments || {};
    if (flags.chargesEnabled && !p.connectedAt) patch.connectedAt = nowFn();
    await mergeOrgPayments(orgId, patch);
    return Object.assign({}, p, patch);
  }

  var paymentsConnectStart = functions.https.onCall(async function (data, context) {
    data = data || {};
    await AUTHZ.assertOrgMember(context, data.orgId, 'admin');
    var s = connectStripe();
    var cfg = s.cfg;
    var orgId = data.orgId;
    var org = await loadOrg(orgId);
    var p = org.payments || {};
    var returnBase = cfg.appBaseUrl + '/settings/payments';

    if (data.method === 'oauth') {
      // Connect an EXISTING Standard account. Needs the platform's Connect
      // client id, and a secret to sign the state parameter.
      if (!cfg.clientId) throw new HttpsError('failed-precondition', 'STRIPE_CONNECT_CLIENT_ID is not set, so connecting an existing Stripe account is unavailable. Use "Connect with Stripe" instead.');
      if (!cfg.linkSecret) throw new HttpsError('failed-precondition', 'INVOICE_LINK_SECRET is not set on the server.');
      var state = CORE.signOAuthState(cfg.linkSecret, orgId, context.auth.uid, nowFn());
      var url = 'https://connect.stripe.com/oauth/authorize?response_type=code' +
        '&client_id=' + encodeURIComponent(cfg.clientId) +
        '&scope=read_write' +
        '&redirect_uri=' + encodeURIComponent(returnBase) +
        '&state=' + encodeURIComponent(state);
      return { url: url };
    }

    // An account connected through OAuth is the company's own pre-existing
    // Stripe account; SkidSling cannot open Stripe's onboarding for it, so
    // "finish setup" means the company's own Stripe dashboard.
    if (p.stripeAccountId && p.mode === cfg.mode && p.connectedVia === 'oauth') {
      if (p.connected === false) await mergeOrgPayments(orgId, { connected: true, reconnectedAt: nowFn() });
      return { url: 'https://dashboard.stripe.com/', stripeAccountId: p.stripeAccountId };
    }

    // Account Links: SkidSling creates a Standard account for the company (or
    // reuses the one it already made in this mode) and sends them to Stripe's
    // hosted onboarding. SkidSling never sees bank or identity details.
    var accountId = (p.stripeAccountId && p.mode === cfg.mode) ? p.stripeAccountId : null;
    if (!accountId) {
      var acct = await s.stripe.accounts.create({
        type: 'standard',
        email: org.email || undefined,
        business_profile: { name: org.name || undefined },
        metadata: { skidslingOrgId: orgId }
      });
      accountId = acct.id;
      await claimAccount(orgId, accountId, cfg.mode, 'account_link');
      await mergeOrgPayments(orgId, {
        stripeAccountId: accountId, mode: cfg.mode, connected: true, connectedVia: 'account_link',
        chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
        accountCreatedAt: nowFn()
      });
      await logActivity(orgId, 'PAYMENTS_ACCOUNT_CREATED', { stripeAccountId: accountId, mode: cfg.mode }, callerEmail(context));
    } else if (p.connected === false) {
      await mergeOrgPayments(orgId, { connected: true, reconnectedAt: nowFn() });
    }
    var link = await s.stripe.accountLinks.create({
      account: accountId,
      refresh_url: returnBase + '?connect=refresh',
      return_url: returnBase + '?connect=return',
      type: 'account_onboarding'
    });
    return { url: link.url, stripeAccountId: accountId };
  });

  var paymentsOAuthComplete = functions.https.onCall(async function (data, context) {
    data = data || {};
    await AUTHZ.assertOrgMember(context, data.orgId, 'admin');
    var s = connectStripe();
    if (!s.cfg.linkSecret) throw new HttpsError('failed-precondition', 'INVOICE_LINK_SECRET is not set on the server.');
    var st = CORE.verifyOAuthState(s.cfg.linkSecret, data.state, context.auth.uid, nowFn());
    if (!st || st.orgId !== data.orgId) throw new HttpsError('permission-denied', 'This Stripe connection link has expired or belongs to another organization. Start again from Settings > Payments.');
    if (typeof data.code !== 'string' || !/^[A-Za-z0-9_]{5,200}$/.test(data.code)) throw new HttpsError('invalid-argument', 'Missing authorization code');
    var tok = await s.stripe.oauth.token({ grant_type: 'authorization_code', code: data.code });
    var accountId = tok.stripe_user_id;
    if (!accountId) throw new HttpsError('internal', 'Stripe did not return an account id');
    if (tok.livemode !== undefined && !!tok.livemode !== s.cfg.livemode) {
      throw new HttpsError('failed-precondition', 'That Stripe connection is ' + (tok.livemode ? 'live' : 'test') + ' but invoicing is in ' + s.cfg.mode + ' mode.');
    }
    await claimAccount(data.orgId, accountId, s.cfg.mode, 'oauth');
    await mergeOrgPayments(data.orgId, { stripeAccountId: accountId, mode: s.cfg.mode, connected: true, connectedVia: 'oauth' });
    await logActivity(data.orgId, 'PAYMENTS_CONNECTED', { stripeAccountId: accountId, via: 'oauth', mode: s.cfg.mode }, callerEmail(context));
    var p = await refreshAccountFlags(data.orgId, accountId);
    return orgPaymentsView({ payments: p });
  });

  var paymentsRefreshAccount = functions.https.onCall(async function (data, context) {
    data = data || {};
    await AUTHZ.assertOrgMember(context, data.orgId, 'admin');
    var org = await loadOrg(data.orgId);
    var p = org.payments || {};
    if (!p.stripeAccountId) return orgPaymentsView(org);
    var s = connectStripe();
    if (p.mode && p.mode !== s.cfg.mode) {
      throw new HttpsError('failed-precondition', 'This organization connected Stripe in ' + p.mode + ' mode, but invoicing now runs in ' + s.cfg.mode + ' mode. Disconnect and connect again.');
    }
    var fresh = await refreshAccountFlags(data.orgId, p.stripeAccountId);
    return orgPaymentsView({ payments: fresh });
  });

  // "Disconnect" stops NEW pay links. Past payments, refunds and late ACH
  // results for that account still map to this org (stripeAccounts keeps the
  // mapping), so the ledger stays right.
  var paymentsDisconnect = functions.https.onCall(async function (data, context) {
    data = data || {};
    await AUTHZ.assertOrgMember(context, data.orgId, 'admin');
    var org = await loadOrg(data.orgId);
    var p = org.payments || {};
    await mergeOrgPayments(data.orgId, { connected: false, disconnectedAt: nowFn() });
    await logActivity(data.orgId, 'PAYMENTS_DISCONNECTED', { stripeAccountId: p.stripeAccountId || null }, callerEmail(context));
    return orgPaymentsView({ payments: Object.assign({}, p, { connected: false }) });
  });

  var paymentsSaveSettings = functions.https.onCall(async function (data, context) {
    data = data || {};
    await AUTHZ.assertOrgMember(context, data.orgId, 'admin');
    var org = await loadOrg(data.orgId);
    var clean;
    try { clean = CORE.sanitizePaymentSettings(data.settings || {}, org.payments || {}); }
    catch (e) { throw new HttpsError('invalid-argument', e.message); }
    await mergeOrgPayments(data.orgId, clean);
    await logActivity(data.orgId, 'PAYMENTS_SETTINGS_UPDATED', { settings: clean }, callerEmail(context));
    return { ok: true, settings: clean };
  });

  // ───────────────────────────────────── Phase 2: invoices & pay online ────

  var crypto = require('crypto');
  var ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
  var MANUAL_METHODS = ['check', 'cash', 'zelle', 'ach', 'wire', 'card', 'other'];
  // The app's existing order.paymentMethod keys (PurchaseOrders.jsx labels).
  var METHOD_TO_ORDER_KEY = { card: 'credit_card', ach: 'ach', check: 'check', cash: 'cash', zelle: 'zelle', wire: 'wire', other: 'other' };

  // Per-instance burst limiter for the public pay-link endpoints.
  var hits = {};
  function rateLimited(key, max, windowMs) {
    var t = nowFn();
    hits[key] = (hits[key] || []).filter(function (x) { return t - x < windowMs; });
    if (hits[key].length >= max) return true;
    hits[key].push(t);
    return false;
  }
  function callerIp(context) {
    var r = context && context.rawRequest;
    return (r && (r.ip || (r.headers && r.headers['x-forwarded-for']))) || 'unknown';
  }

  function orgTz(org) {
    var tz = org && org.payments && org.payments.autoSend && org.payments.autoSend.timeZone;
    return CORE.validTimeZone(tz) ? tz : CORE.DEFAULT_TZ;
  }

  function paymentsQuery(orgId, orderId) {
    return db.collection('payments').where('orgId', '==', orgId).where('orderIds', 'array-contains', orderId);
  }

  async function loadOrderInOrg(orgId, orderId) {
    if (typeof orderId !== 'string' || !ID_RE.test(orderId)) throw new HttpsError('invalid-argument', 'orderId must be a plain document id');
    var snap = await db.collection('purchaseOrders').doc(orderId).get();
    if (!snap.exists || snap.data().orgId !== orgId) throw new HttpsError('not-found', 'Order not found');
    return Object.assign({ id: snap.id }, snap.data());
  }

  async function loadCustomer(orgId, customerId) {
    if (!customerId || typeof customerId !== 'string' || !ID_RE.test(customerId)) return null;
    var snap = await db.collection('customers').doc(customerId).get();
    if (!snap.exists || snap.data().orgId !== orgId) return null;
    return Object.assign({ id: snap.id }, snap.data());
  }

  /** Where invoice email goes: the customer's billing addresses, else the order's email. */
  function billingRecipients(order, customer) {
    var list = CORE.emailList(customer && customer.billingEmails);
    if (list.length) return list;
    return CORE.emailList(order && order.customerEmail);
  }

  // Fields the payments ledger owns on an order. Never written by the client
  // (orgDb.js strips them; firestore.rules refuses them).
  function derivedFields(state, led) {
    return {
      amountPaidCents: state.paidCents,
      balanceDueCents: state.balanceCents,
      amountPaid: CORE.centsToDollars(state.paidCents),
      balanceDue: CORE.centsToDollars(state.balanceCents),
      creditCents: state.creditCents,
      pendingCents: state.pendingCents
    };
  }

  /**
   * Re-derive an order's paid / balance / invoice status from the ledger.
   * Deterministic from (order, payments, today), which is why webhook events
   * arriving twice or out of order still converge on the same order state.
   *
   * flipStatus: a ledger change (payment, refund, ACH failure) may also move
   * the order between 'shipped' and 'paid', exactly like the Mark Paid /
   * Mark Unpaid buttons - but only an order the ledger itself marked paid is
   * ever moved back, never one a person marked paid by hand.
   */
  async function recomputeOrder(orgId, orderId, opts) {
    opts = opts || {};
    var ref = db.collection('purchaseOrders').doc(orderId);
    var orgRef = db.collection('organizations').doc(orgId);
    return db.runTransaction(async function (tx) {
      var snap = await tx.get(ref);
      if (!snap.exists || snap.data().orgId !== orgId) return null;
      var o = snap.data();
      var orgSnap = await tx.get(orgRef);
      var org = orgSnap.exists ? orgSnap.data() : {};
      var psnap = await tx.get(paymentsQuery(orgId, orderId));
      var payments = psnap.docs.map(function (d) { return d.data(); });
      var tz = orgTz(org);
      var today = CORE.localDay(nowFn(), tz);
      var led = CORE.orderLedger(orderId, payments);
      var patch = {};
      var st = CORE.invoiceState(o, led, today, tz);

      if (opts.flipStatus) {
        if (st.status === 'paid' && !st.manualPaid && led.paidCents > 0 && o.status === 'shipped') {
          patch.status = 'paid'; patch.paidAt = nowFn(); patch.paidVia = 'ledger';
          patch.paymentMethod = METHOD_TO_ORDER_KEY[led.lastMethod] || 'other';
        } else if (o.status === 'paid' && o.paidVia === 'ledger' && st.balanceCents > 0) {
          patch.status = 'shipped'; patch.paidAt = null; patch.paidVia = null; patch.paymentMethod = '';
        }
        if (Object.keys(patch).length) st = CORE.invoiceState(Object.assign({}, o, patch), led, today, tz);
      }

      var d = derivedFields(st, led);
      Object.keys(d).forEach(function (k) { if (o[k] !== d[k]) patch[k] = d[k]; });
      var inv = o.invoice || {};
      var invPatch = {};
      if (inv.status !== st.status) invPatch.status = st.status;
      if ((inv.paymentPending || false) !== st.paymentPending) invPatch.paymentPending = st.paymentPending;
      if ((inv.totalCents === undefined ? null : inv.totalCents) !== st.totalCents) invPatch.totalCents = st.totalCents;
      if ((inv.dueDate || '') !== st.dueDate) invPatch.dueDate = st.dueDate;
      if ((inv.disputed || false) !== led.disputed) invPatch.disputed = led.disputed;
      if (led.lastPaymentAt && inv.lastPaymentAt !== led.lastPaymentAt) invPatch.lastPaymentAt = led.lastPaymentAt;
      if (Object.keys(invPatch).length) patch.invoice = invPatch;

      if (Object.keys(patch).length === 0) return { changed: false, state: st, order: o };
      patch.payStatusUpdatedAt = nowFn();
      tx.set(ref, patch, { merge: true });
      return { changed: true, state: st, order: Object.assign({}, o, patch), before: o };
    });
  }

  /**
   * Give an order its invoice identity: number, issue date, terms, a pay-link
   * nonce and the signed pay URL. Additive; an order that already has one
   * keeps it. Refuses a cancelled order and one with nothing on the invoice.
   */
  async function ensureIssued(orgId, orderId) {
    var cfg = config();
    var ref = db.collection('purchaseOrders').doc(orderId);
    await db.runTransaction(async function (tx) {
      var snap = await tx.get(ref);
      if (!snap.exists || snap.data().orgId !== orgId) throw new HttpsError('not-found', 'Order not found');
      var o = snap.data();
      if (o.status === 'cancelled') throw new HttpsError('failed-precondition', 'This order is cancelled.');
      if (CORE.invoiceTotalCents(o) <= 0) {
        throw new HttpsError('failed-precondition', 'Nothing to invoice yet: the invoice prices shipped quantities, and no line on ' +
          (o.poNumber || 'this order') + ' has a shipped quantity. Pack the order (or set shipped quantities) first.');
      }
      var inv = o.invoice || {};
      var patch = {};
      if (!inv.issuedAt) {
        patch.number = o.poNumber || orderId;
        patch.issuedAt = nowFn();
        patch.terms = o.terms || 'Net 30';
      }
      var nonce = inv.linkNonce;
      if (!nonce) { nonce = crypto.randomBytes(9).toString('hex'); patch.linkNonce = nonce; }
      if (cfg.linkSecret) {
        var url = CORE.invoicePayUrl(cfg.appBaseUrl, cfg.linkSecret, orgId, orderId, nonce);
        if (inv.payUrl !== url) patch.payUrl = url;
      }
      if (Object.keys(patch).length) tx.set(ref, { invoice: patch }, { merge: true });
    });
    await recomputeOrder(orgId, orderId);
    return loadOrderInOrg(orgId, orderId);
  }

  function publicPayment(id, p) {
    return {
      id: id, amountCents: p.amountCents || 0, method: p.method || null, source: p.source || null,
      kind: p.kind || 'invoice', status: CORE.paymentStatus(p),
      allocations: CORE.paymentAllocations(p), refundedCents: p.refundedCents || 0,
      feeCents: p.feeCents === undefined ? null : p.feeCents, netCents: p.netCents === undefined ? null : p.netCents,
      surchargeCents: p.surchargeCents || 0,
      createdAt: p.createdAt || null, succeededAt: p.succeededAt || null, failedAt: p.failedAt || null,
      failureMessage: p.failureMessage || null, disputed: !!p.disputed,
      note: p.note || '', createdBy: p.createdBy || '', voidedAt: p.voidedAt || null,
      stripePaymentIntentId: (p.stripe && p.stripe.paymentIntentId) || null
    };
  }

  function onlineState(org) {
    var cfg = config();
    var p = (org && org.payments) || {};
    var state = CORE.connectionState(p);
    var ready = !!p.enabled && state === 'connected' && cfg.ok && !!cfg.linkSecret && (!p.mode || p.mode === cfg.mode);
    var reason = null;
    if (!p.enabled) reason = 'Online payments are turned off for this company.';
    else if (state !== 'connected') reason = 'Stripe is not connected.';
    else if (!cfg.ok || !cfg.linkSecret) reason = 'Online payments are not configured on the server.';
    else if (p.mode && p.mode !== cfg.mode) reason = 'Stripe was connected in ' + p.mode + ' mode; invoicing now runs in ' + cfg.mode + ' mode.';
    return { enabled: !!p.enabled, connection: state, ready: ready, reason: reason, mode: p.mode || null };
  }

  var invoiceGetDetails = functions.https.onCall(async function (data, context) {
    data = data || {};
    await AUTHZ.assertOrgMember(context, data.orgId, 'staff');
    var o = await loadOrderInOrg(data.orgId, data.orderId);
    var org = await loadOrg(data.orgId);
    var psnap = await paymentsQuery(data.orgId, o.id).get();
    var payments = psnap.docs.map(function (d) { return { id: d.id, data: d.data() }; });
    var tz = orgTz(org);
    var led = CORE.orderLedger(o.id, payments.map(function (x) { return x.data; }));
    var st = CORE.invoiceState(o, led, CORE.localDay(nowFn(), tz), tz);
    var inv = o.invoice || {};
    payments.sort(function (a, b) { return (b.data.createdAt || 0) - (a.data.createdAt || 0); });
    return {
      state: st,
      invoice: {
        number: inv.number || o.poNumber || '', issuedAt: inv.issuedAt || null, sentAt: inv.sentAt || null,
        sentTo: inv.sentTo || [], lastReminderAt: inv.lastReminderAt || null, reminderCount: inv.reminderCount || 0,
        remindersPaused: !!inv.remindersPaused, payUrl: st.status === 'void' ? null : (inv.payUrl || null),
        lastEmail: inv.lastEmail || null
      },
      payments: payments.map(function (x) { return publicPayment(x.id, x.data); }),
      online: onlineState(org)
    };
  });

  var invoiceGetPayLink = functions.https.onCall(async function (data, context) {
    data = data || {};
    await AUTHZ.assertOrgMember(context, data.orgId, 'manager');
    var org = await loadOrg(data.orgId);
    var online = onlineState(org);
    if (!online.ready) throw new HttpsError('failed-precondition', online.reason);
    var o = await ensureIssued(data.orgId, data.orderId);
    return { url: o.invoice && o.invoice.payUrl };
  });

  var invoiceRecordManualPayment = functions.https.onCall(async function (data, context) {
    data = data || {};
    await AUTHZ.assertOrgMember(context, data.orgId, 'manager');
    var o = await loadOrderInOrg(data.orgId, data.orderId);
    if (o.status === 'cancelled') throw new HttpsError('failed-precondition', 'This order is cancelled.');
    var cents = CORE.toCents(data.amount);
    if (!(cents > 0) || cents > 100000000) throw new HttpsError('invalid-argument', 'Amount must be more than $0.00');
    var method = MANUAL_METHODS.indexOf(data.method) !== -1 ? data.method : null;
    if (!method) throw new HttpsError('invalid-argument', 'Method must be one of: ' + MANUAL_METHODS.join(', '));
    var received = CORE.isoToDay(data.receivedDate);
    var receivedAt = received !== null ? received * 86400000 + 12 * 3600000 : nowFn();
    var doc = {
      orgId: data.orgId, orderId: o.id, orderIds: [o.id], orderNumber: o.poNumber || '',
      customerId: o.customerId || '', customerName: o.customerName || '',
      amountCents: cents, currency: 'usd', method: method, source: 'manual', kind: 'invoice',
      allocations: [{ orderId: o.id, orderNumber: o.poNumber || '', cents: cents }],
      succeededAt: receivedAt, createdAt: nowFn(),
      note: String(data.note || '').slice(0, 500), createdBy: callerEmail(context)
    };
    doc.status = CORE.paymentStatus(doc);
    var ref = await db.collection('payments').add(doc);
    var r = await recomputeOrder(data.orgId, o.id, { flipStatus: true });
    await logActivity(data.orgId, 'PAYMENT_RECORDED', { poId: o.id, poNumber: o.poNumber || '', paymentId: ref.id,
      amountCents: cents, method: method, source: 'manual' }, callerEmail(context));
    return { paymentId: ref.id, state: r && r.state };
  });

  var invoiceReverseManualPayment = functions.https.onCall(async function (data, context) {
    data = data || {};
    await AUTHZ.assertOrgMember(context, data.orgId, 'manager');
    if (typeof data.paymentId !== 'string' || !ID_RE.test(data.paymentId)) throw new HttpsError('invalid-argument', 'paymentId required');
    var ref = db.collection('payments').doc(data.paymentId);
    var snap = await ref.get();
    if (!snap.exists || snap.data().orgId !== data.orgId) throw new HttpsError('not-found', 'Payment not found');
    var p = snap.data();
    if (p.source !== 'manual') throw new HttpsError('failed-precondition', 'Online payments are refunded in Stripe, not reversed here. The refund updates the balance automatically.');
    if (p.voidedAt) return { ok: true };
    await ref.set({ voidedAt: nowFn(), voidedBy: callerEmail(context), voidReason: String(data.reason || '').slice(0, 300), status: 'voided' }, { merge: true });
    var ids = Array.isArray(p.orderIds) ? p.orderIds : [p.orderId];
    for (var i = 0; i < ids.length; i++) await recomputeOrder(data.orgId, ids[i], { flipStatus: true });
    await logActivity(data.orgId, 'PAYMENT_REVERSED', { paymentId: data.paymentId, orderIds: ids, amountCents: p.amountCents,
      reason: String(data.reason || '').slice(0, 300) }, callerEmail(context));
    return { ok: true };
  });

  // ── public pay link (no sign-in: the signed token is the credential) ──

  async function resolvePayLink(data, context) {
    data = data || {};
    if (rateLimited('pay:' + callerIp(context), 60, 60 * 1000)) throw new HttpsError('resource-exhausted', 'Too many requests. Please wait a minute.');
    var cfg = config();
    var invalid = new HttpsError('not-found', 'This payment link is not valid. Please contact the company that sent it.');
    if (typeof data.orgId !== 'string' || !ID_RE.test(data.orgId)) throw invalid;
    if (!cfg.linkSecret) throw new HttpsError('unavailable', 'Online payment is temporarily unavailable. Please contact the company that sent this invoice.');
    var kind = data.customerId ? 'statement' : 'invoice';
    var id = kind === 'statement' ? data.customerId : data.orderId;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw invalid;

    var org;
    try { org = await loadOrg(data.orgId); } catch (e) { throw invalid; }
    var tz = orgTz(org);
    var today = CORE.localDay(nowFn(), tz);
    var p = org.payments || {};
    var online = onlineState(org);

    if (kind === 'invoice') {
      var snap = await db.collection('purchaseOrders').doc(id).get();
      if (!snap.exists || snap.data().orgId !== data.orgId) throw invalid;
      var o = Object.assign({ id: snap.id }, snap.data());
      var nonce = o.invoice && o.invoice.linkNonce;
      if (!nonce || !CORE.verifyPayToken(cfg.linkSecret, 'invoice', data.orgId, id, nonce, data.t)) throw invalid;
      var psnap = await paymentsQuery(data.orgId, id).get();
      var led = CORE.orderLedger(id, psnap.docs.map(function (d) { return d.data(); }));
      var st = CORE.invoiceState(o, led, today, tz);
      return { kind: kind, cfg: cfg, org: org, payments: p, online: online, order: o, state: st,
               amountCents: st.collectibleCents, customerId: o.customerId || '' };
    }
    throw invalid;   // statement links arrive with phase 5
  }

  // Why the pay button is not shown. Paid, or covered by a bank transfer still
  // clearing, is not a problem to explain - the page says so on its own.
  function payBlockedReason(canPay, voided, amountCents, online) {
    if (canPay) return null;
    if (voided) return 'This invoice has been cancelled.';
    if (amountCents <= 0) return null;
    return online.reason;
  }

  function payPageView(r) {
    var base = {
      kind: r.kind,
      orgName: r.org.name || '', orgEmail: (r.payments.billingEmail || r.org.email || ''), orgPhone: r.org.phone || '',
      logoUrl: r.org.logoUrl || '',
      testMode: (r.online.mode || r.cfg.mode) === 'test'
    };
    var canPay = r.online.ready && r.amountCents > 0;
    var options = canPay ? CORE.paymentOptions(r.payments.methods, r.payments.cardSurcharge, r.amountCents) : [];
    if (r.kind === 'invoice') {
      var st = r.state;
      if (st.status === 'void') { canPay = false; options = []; }
      return Object.assign(base, {
        orderNumber: r.order.poNumber || '', customerPO: r.order.customerPO || '', customerName: r.order.customerName || '',
        status: st.status, totalCents: st.totalCents, paidCents: st.paidCents, pendingCents: st.pendingCents,
        balanceCents: st.balanceCents, amountDueNowCents: r.amountCents, dueDate: st.dueDate,
        canPay: canPay && options.length > 0, options: options,
        reason: payBlockedReason(canPay, st.status === 'void', r.amountCents, r.online)
      });
    }
    return base;
  }

  var invoicePayLinkStatus = functions.https.onCall(async function (data, context) {
    return payPageView(await resolvePayLink(data, context));
  });

  var invoicePayLinkCheckout = functions.https.onCall(async function (data, context) {
    data = data || {};
    if (rateLimited('checkout:' + callerIp(context), 10, 60 * 1000)) throw new HttpsError('resource-exhausted', 'Too many requests. Please wait a minute.');
    var r = await resolvePayLink(data, context);
    var view = payPageView(r);
    if (!view.canPay) throw new HttpsError('failed-precondition', view.reason || 'Nothing to pay on this invoice.');
    var option = view.options.find(function (o) { return o.method === data.method; }) || (view.options.length === 1 ? view.options[0] : null);
    if (!option) throw new HttpsError('invalid-argument', 'Choose how you want to pay.');
    var s = connectStripe();
    var customer = r.kind === 'invoice' ? await loadCustomer(data.orgId, r.customerId) : r.customer;
    var recipients = r.kind === 'invoice' ? billingRecipients(r.order, customer) : CORE.emailList(customer && (customer.billingEmails && customer.billingEmails.length ? customer.billingEmails : customer.email));
    var pageUrl = s.cfg.appBaseUrl + '/pay/' + encodeURIComponent(data.orgId) + '/' +
      (r.kind === 'invoice' ? encodeURIComponent(data.orderId) : 'statement/' + encodeURIComponent(data.customerId)) +
      '?t=' + encodeURIComponent(data.t);
    var params = CORE.buildCheckoutParams({
      kind: r.kind, orgId: data.orgId,
      orderId: r.kind === 'invoice' ? r.order.id : '', orderNumber: r.kind === 'invoice' ? (r.order.poNumber || '') : '',
      customerId: r.customerId || '',
      amountCents: r.amountCents, option: option,
      lineName: r.kind === 'invoice' ? CORE.invoiceLineName(r.order)
        : 'Statement - ' + r.statement.invoices.length + ' invoice' + (r.statement.invoices.length === 1 ? '' : 's'),
      customerEmail: recipients[0] || '',
      successUrl: pageUrl + '&paid=1',
      cancelUrl: pageUrl + '&cancelled=1'
    });
    var session = await s.stripe.checkout.sessions.create(params, { stripeAccount: r.payments.stripeAccountId });
    if (r.kind === 'invoice') {
      // One live checkout per invoice: expire the previous one so a customer
      // with two tabs open cannot pay the same balance twice.
      var prev = r.order.invoice && r.order.invoice.lastCheckoutSessionId;
      if (prev && prev !== session.id) {
        try { await s.stripe.checkout.sessions.expire(prev, {}, { stripeAccount: r.payments.stripeAccountId }); }
        catch (e) { /* already completed or expired - fine */ }
      }
      await db.collection('purchaseOrders').doc(r.order.id).set({ invoice: {
        lastCheckoutSessionId: session.id, lastCheckoutAt: nowFn() } }, { merge: true });
    }
    return { url: session.url };
  });

  // ─────────────────────────────────────────────── Connect webhook ────

  /**
   * One Connect event. Returns a short outcome string (also used by tests).
   * Never throws for "not ours" - those are acknowledged so Stripe stops
   * retrying - but does throw on real processing failures so Stripe retries.
   */
  async function handleConnectEvent(event) {
    var cfg = config();
    if (!event || !event.id || !event.type) return 'ignored:malformed';
    // Platform events (no account) belong to stripeWebhook, never here.
    if (!event.account) return 'ignored:platform-event';
    if (cfg.mode && !!event.livemode !== cfg.livemode) {
      console.warn('stripeConnectWebhook: ' + (event.livemode ? 'live' : 'test') + ' event in ' + cfg.mode + ' mode ignored: ' + event.id);
      return 'ignored:mode-mismatch';
    }
    var mapSnap = await db.collection('stripeAccounts').doc(event.account).get();
    if (!mapSnap.exists || !mapSnap.data().orgId) {
      console.warn('stripeConnectWebhook: unknown account ' + event.account + ' for ' + event.type + ' ' + event.id + ' - ignored');
      return 'ignored:unknown-account';
    }
    var orgId = mapSnap.data().orgId;

    // Already fully processed? (Processing is idempotent anyway; this just
    // saves the work on Stripe's retries and replays.)
    var evRef = db.collection('stripeEvents').doc(event.id);
    var seen = await evRef.get();
    if (seen.exists) return 'duplicate';

    var outcome = await dispatchEvent(orgId, event);

    await evRef.set({ orgId: orgId, type: event.type, account: event.account,
                      livemode: !!event.livemode, created: event.created || null,
                      outcome: outcome, processedAt: nowFn() });
    return outcome;
  }

  async function dispatchEvent(orgId, event) {
    var obj = (event.data && event.data.object) || {};
    switch (event.type) {
      case 'account.updated': {
        var org = await loadOrg(orgId);
        var p = org.payments || {};
        // Only the account this org is actually using drives its flags.
        if (p.stripeAccountId !== event.account) return 'ignored:not-current-account';
        var flags = CORE.accountFlags(obj);
        var patch = Object.assign({}, flags, { flagsUpdatedAt: nowFn() });
        if (flags.chargesEnabled && !p.connectedAt) patch.connectedAt = nowFn();
        await mergeOrgPayments(orgId, patch);
        return 'account:flags';
      }
      case 'account.application.deauthorized': {
        var org2 = await loadOrg(orgId);
        if ((org2.payments || {}).stripeAccountId === event.account) {
          await mergeOrgPayments(orgId, { connected: false, disconnectedAt: nowFn(), deauthorized: true });
          await logActivity(orgId, 'PAYMENTS_DISCONNECTED', { stripeAccountId: event.account, reason: 'deauthorized in Stripe' });
        }
        return 'account:deauthorized';
      }
      default:
        return 'ignored:unhandled-type';
    }
  }

  var stripeConnectWebhook = functions.https.onRequest(async function (req, res) {
    var cfg = config();
    if (!cfg.webhookSecret) {
      console.error('stripeConnectWebhook: STRIPE_CONNECT_WEBHOOK_SECRET is not set');
      return res.status(500).send('Webhook not configured');
    }
    var event;
    try {
      // constructEvent is a local HMAC check; any client instance can run it.
      // A misconfigured key must not stop Stripe hearing a 400 for a forged
      // request, so the verifier does not depend on the mode guard.
      var verifier = stripeFactory(cfg.secretKey || 'sk_test_signature_only');
      event = verifier.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], cfg.webhookSecret);
    } catch (err) {
      console.error('stripeConnectWebhook signature verification failed:', err.message);
      return res.status(400).send('Webhook Error: ' + err.message);
    }
    try {
      var outcome = await handleConnectEvent(event);
      console.log('stripeConnectWebhook ' + event.type + ' ' + event.id + ' -> ' + outcome);
      return res.json({ received: true, outcome: outcome });
    } catch (e) {
      console.error('stripeConnectWebhook handler error for ' + event.type + ' ' + event.id + ':', e);
      return res.status(500).send('Webhook handler error');
    }
  });

  return {
    // Cloud Functions (wired up in index.js)
    paymentsConnectStart: paymentsConnectStart,
    paymentsOAuthComplete: paymentsOAuthComplete,
    paymentsRefreshAccount: paymentsRefreshAccount,
    paymentsDisconnect: paymentsDisconnect,
    paymentsSaveSettings: paymentsSaveSettings,
    stripeConnectWebhook: stripeConnectWebhook,
    invoiceGetDetails: invoiceGetDetails,
    invoiceGetPayLink: invoiceGetPayLink,
    invoiceRecordManualPayment: invoiceRecordManualPayment,
    invoiceReverseManualPayment: invoiceReverseManualPayment,
    invoicePayLinkStatus: invoicePayLinkStatus,
    invoicePayLinkCheckout: invoicePayLinkCheckout,
    // For tests
    _internal: { handleConnectEvent: handleConnectEvent, claimAccount: claimAccount,
                 recomputeOrder: recomputeOrder, ensureIssued: ensureIssued }
  };
};
