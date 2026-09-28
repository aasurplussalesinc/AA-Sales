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

  // ─────────────────────────────────────────────────────────── email ────

  // Brevo (the same transactional email service index.js uses). Invoice email
  // is sent from SkidSling's verified sender under the company's name, with
  // replies going to the company's billing address. Injected in tests.
  var sendEmailImpl = deps.sendEmail || async function brevoSend(msg) {
    var apiKey = env.BREVO_API_KEY;
    if (!apiKey) {
      console.log('[invoice email skipped - no BREVO_API_KEY] ' + msg.subject);
      return { skipped: true };
    }
    var fetch = require('node-fetch');
    var body = {
      sender: { name: String(msg.fromName || 'SkidSling').slice(0, 70), email: env.INVOICE_EMAIL_FROM || 'info@skidsling.com' },
      to: msg.to.map(function (e) { return { email: e }; }),
      subject: msg.subject,
      htmlContent: msg.html
    };
    if (msg.replyTo) body.replyTo = { email: msg.replyTo };
    if (msg.attachments && msg.attachments.length) {
      body.attachment = msg.attachments.map(function (a) { return { name: a.name, content: a.contentBase64 }; });
    }
    try {
      var res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) { var t = await res.text(); console.error('Brevo error ' + res.status + ':', t); return { success: false, error: 'Email service error ' + res.status }; }
      var j = await res.json();
      return { success: true, id: j.messageId || null };
    } catch (e) {
      console.error('Brevo send failed:', e.message);
      return { success: false, error: e.message };
    }
  };

  // Brevo's free tier allows 300 emails a day for the WHOLE SkidSling account
  // (trial emails included). Invoicing stops at INVOICE_EMAIL_DAILY_CAP
  // (default 250) and leaves the rest for tomorrow; reminders catch up.
  async function takeEmailQuota(n) {
    var cap = parseInt(env.INVOICE_EMAIL_DAILY_CAP, 10);
    if (!(cap > 0)) cap = 250;
    var dayKey = new Date(nowFn()).toISOString().slice(0, 10);
    var ref = db.collection('invoiceEmailQuota').doc(dayKey);
    return db.runTransaction(async function (tx) {
      var snap = await tx.get(ref);
      var used = snap.exists ? (snap.data().count || 0) : 0;
      if (used + n > cap) return false;
      tx.set(ref, { count: used + n, cap: cap, updatedAt: nowFn() }, { merge: true });
      return true;
    });
  }

  async function sendEmail(msg) {
    if (!msg.to || !msg.to.length) return { success: false, error: 'No email address' };
    if (!(await takeEmailQuota(1))) return { success: false, capped: true, error: 'Daily email limit reached - it will go out tomorrow' };
    return sendEmailImpl(msg);
  }

  function orgReplyTo(org) {
    var p = (org && org.payments) || {};
    var e = (p.billingEmail || (org && org.email) || '').trim().toLowerCase();
    return CORE.isEmail(e) ? e : null;
  }

  var METHOD_WORDS = { card: 'card', ach: 'bank transfer (ACH)', check: 'check', cash: 'cash', zelle: 'Zelle', wire: 'wire', other: 'other' };

  /**
   * Tell the company about a payment event: an activity-log entry (in-app),
   * plus an email to its billing address when it turned that on. Never the
   * customer.
   */
  async function notifyPayment(orgId, payment, transitions, wasPending) {
    if (!transitions || !transitions.length) return;
    var org;
    try { org = await loadOrg(orgId); } catch (e) { return; }
    var label = (CORE.paymentAllocations(payment).map(function (a) { return a.orderNumber; }).filter(Boolean).join(', ')) ||
      payment.orderNumber || 'An invoice';
    var amt = CORE.formatCents(payment.amountCents);
    var how = METHOD_WORDS[payment.method] || 'online payment';
    var lines = [];
    transitions.forEach(function (t) {
      if (t === 'succeeded') lines.push({ action: 'PAYMENT_RECEIVED', text: label + ' paid ' + amt + ' by ' + how });
      else if (t === 'pending') lines.push({ action: 'PAYMENT_PENDING', text: label + ': ' + amt + ' ' + how + ' started - it clears in a few business days' });
      else if (t === 'failed' && wasPending) lines.push({ action: 'PAYMENT_FAILED', text: label + ': ' + amt + ' ' + how + ' FAILED' + (payment.failureMessage ? ' (' + payment.failureMessage + ')' : '') + ' - the balance is due again' });
      else if (t === 'refunded' || t === 'partially_refunded') lines.push({ action: 'PAYMENT_REFUNDED', text: label + ': ' + CORE.formatCents(payment.refundedCents) + ' refunded of ' + amt });
      else if (t === 'disputed') lines.push({ action: 'PAYMENT_DISPUTED', text: label + ': the customer disputed the ' + amt + ' payment with their bank. Respond in your Stripe dashboard.' });
    });
    var p = org.payments || {};
    var to = orgReplyTo(org);
    for (var i = 0; i < lines.length; i++) {
      await logActivity(orgId, lines[i].action, { message: lines[i].text,
        paymentId: payment.stripe && payment.stripe.paymentIntentId ? 'stripe_' + payment.stripe.paymentIntentId : null,
        orderIds: payment.orderIds || [], amountCents: payment.amountCents });
      if (p.notifyOnPayment && to) {
        await sendEmail({ to: [to], fromName: 'SkidSling', subject: lines[i].text,
          html: '<p>' + CORE.escapeHtml(lines[i].text) + '.</p><p style="color:#777;font-size:13px">SkidSling payments &middot; ' +
            CORE.escapeHtml(org.name || '') + '. You get these because "Email the billing address when a payment arrives" is on in Settings &gt; Payments.</p>' });
      }
    }
  }

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
        if (CORE.PAYMENT_EVENT_TYPES.indexOf(event.type) !== -1) return handlePaymentEvent(orgId, event);
        return 'ignored:unhandled-type';
    }
  }

  /**
   * checkout.session.*, payment_intent.*, charge.refunded, charge.dispute.*
   * -> one row in `payments` (keyed by payment intent) -> every order it
   * covers is re-derived. Idempotent and order-independent: the row is a
   * merge of facts (see CORE.mergePaymentFacts) and the orders are recomputed
   * from the whole ledger, never incremented.
   */
  async function handlePaymentEvent(orgId, event) {
    var facts = CORE.paymentFactsFromEvent(event);
    if (!facts) return 'ignored:not-an-invoice-payment';
    if (!facts.paymentIntentId) return 'ignored:no-payment-intent';
    var ref = db.collection('payments').doc('stripe_' + facts.paymentIntentId);

    var meta = facts.meta;
    if (!meta) {
      // Charge / dispute events may not repeat our metadata. Use the row we
      // already have, else ask Stripe for the payment intent.
      var ex = await ref.get();
      if (ex.exists) {
        var e0 = ex.data();
        meta = { orgId: e0.orgId, kind: e0.kind, orderId: e0.orderId, orderNumber: e0.orderNumber,
                 customerId: e0.customerId, surchargeCents: e0.surchargeCents };
      } else {
        var s = connectStripe();
        var pi = await s.stripe.paymentIntents.retrieve(facts.paymentIntentId, {}, { stripeAccount: event.account });
        meta = CORE.paymentMetaFromStripe(pi && pi.metadata);
        if (!meta) return 'ignored:not-an-invoice-payment';
        if (pi.amount !== undefined && facts.set.grossCents === undefined) facts.set.grossCents = Number(pi.amount) || 0;
      }
    }
    // The metadata names an org; the connected account names an org. They
    // must agree, or the event is not processed at all.
    if (meta.orgId !== orgId) {
      console.warn('stripeConnectWebhook: ' + event.id + ' metadata org ' + meta.orgId + ' does not match account owner ' + orgId + ' - ignored');
      return 'ignored:org-mismatch';
    }
    if (meta.kind === 'invoice') {
      if (!meta.orderId || !ID_RE.test(meta.orderId)) return 'ignored:no-order';
      var osnap = await db.collection('purchaseOrders').doc(meta.orderId).get();
      if (!osnap.exists || osnap.data().orgId !== orgId) {
        console.warn('stripeConnectWebhook: ' + event.id + ' names order ' + meta.orderId + ' which is not in org ' + orgId + ' - ignored');
        return 'ignored:unknown-order';
      }
    }

    var out = await db.runTransaction(async function (tx) {
      var cur = await tx.get(ref);
      var before = cur.exists ? cur.data() : null;
      if (before && before.orgId && before.orgId !== orgId) return null;
      var after = CORE.mergePaymentFacts(before, facts, meta);
      after.orgId = orgId;
      after.stripe.accountId = event.account;
      if (after.kind === 'invoice') {
        after.orderIds = [after.orderId];
      } else if (!Array.isArray(after.orderIds) || !after.allocations || !after.allocations.length) {
        await allocateStatementPayment(tx, orgId, after);
      }
      tx.set(ref, after);
      return { before: before, after: after };
    });
    if (!out) return 'ignored:org-mismatch';


    // Stripe's fee, the net and the exact method from the charge (best
    // effort) - before the orders are recomputed, so a paid order records how.
    if (out.after.succeededAt && out.after.feeCents === undefined && out.after.stripe.chargeId) {
      try {
        var s2 = connectStripe();
        var ch = await s2.stripe.charges.retrieve(out.after.stripe.chargeId, { expand: ['balance_transaction'] }, { stripeAccount: event.account });
        var bt = ch && ch.balance_transaction;
        var feePatch = {};
        if (bt && typeof bt === 'object') { feePatch.feeCents = Number(bt.fee) || 0; feePatch.netCents = Number(bt.net) || 0; }
        if (ch && ch.payment_method_details && ch.payment_method_details.type) {
          feePatch.method = ({ card: 'card', us_bank_account: 'ach' })[ch.payment_method_details.type] || 'other';
          feePatch.methodExact = true;
        }
        if (Object.keys(feePatch).length) { await ref.set(feePatch, { merge: true }); Object.assign(out.after, feePatch); }
      } catch (e) { console.warn('stripeConnectWebhook: fee lookup failed for ' + out.after.stripe.chargeId + ': ' + e.message); }
    }


    var ids = out.after.orderIds || [];
    for (var i = 0; i < ids.length; i++) await recomputeOrder(orgId, ids[i], { flipStatus: true });

    var wasPending = !!(out.before && CORE.paymentStatus(out.before) === 'pending' && out.before.pendingAt);
    await notifyPayment(orgId, out.after, CORE.paymentTransition(out.before, out.after), wasPending);
    return 'payment:' + out.after.status;
  }

  // Statement payments (phase 5) cover several invoices; until then a
  // statement payment has nothing to allocate.
  async function allocateStatementPayment(tx, orgId, payment) {
    payment.orderIds = payment.orderIds || [];
  }


  // ─────────────────────────────── Phase 4: sending invoices & reminders ────

  var renderPdf = deps.renderPdf || function (html) { return require('./pdf').htmlToPdf(html); };

  /** The invoice PDF - the same template the Purchase Orders print button uses. */
  async function renderInvoicePdf(orgId, order, org) {
    var ids = (order.items || []).map(function (l) { return l.itemId; })
      .filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });
    var items = [];
    for (var i = 0; i < ids.length; i++) {
      var sn = await db.collection('items').doc(String(ids[i])).get();
      if (sn.exists && sn.data().orgId === orgId) items.push(Object.assign({ id: sn.id }, sn.data()));
    }
    var DOC = await import('./orderDocument.mjs');
    var html = DOC.renderOrderDocument(order, 'invoice', { items: items, organization: org, branding: DOC.brandingHtml });
    var buf = await renderPdf(html);
    return { name: 'Invoice-' + String(order.poNumber || 'invoice').replace(/[^A-Za-z0-9_-]/g, '') + '.pdf',
             contentBase64: Buffer.from(buf).toString('base64') };
  }

  function lastEmailDay(inv, tz) {
    return [inv.sentAt, inv.lastReminderAt, inv.lastEmail && inv.lastEmail.at, inv.emailClaimAt]
      .map(function (t) { return CORE.localDay(t, tz); })
      .filter(function (d) { return d !== null; })
      .reduce(function (m, d) { return Math.max(m, d); }, -Infinity);
  }

  /**
   * Email an invoice (kind 'invoice') or a reminder (kind 'reminder') with the
   * PDF attached and the Pay online button. Hard rules enforced here, whoever
   * calls it: invoicing must be on for the org; never a paid or void invoice;
   * at most ONE email per invoice per day (a transaction claims the day before
   * anything is sent, and releases it only if the send failed).
   * Returns { sent, reason?, to?, messageId?, capped? }.
   */
  async function sendInvoiceEmail(orgId, orderId, opts) {
    opts = opts || {};
    var kind = opts.kind === 'reminder' ? 'reminder' : 'invoice';
    var org = await loadOrg(orgId);
    var p = org.payments || {};
    if (!p.enabled) return { sent: false, reason: 'Invoicing is turned off for this company (Settings > Payments).' };
    var o = await ensureIssued(orgId, orderId);
    var tz = orgTz(org);
    var today = CORE.localDay(nowFn(), tz);
    var psnap = await paymentsQuery(orgId, orderId).get();
    var st = CORE.invoiceState(o, CORE.orderLedger(orderId, psnap.docs.map(function (d) { return d.data(); })), today, tz);
    if (st.status === 'void') return { sent: false, reason: 'This invoice is void.' };
    if (st.balanceCents <= 0) return { sent: false, reason: 'This invoice is already paid.' };
    if (kind === 'reminder' && st.collectibleCents <= 0) return { sent: false, reason: 'A bank transfer for the balance is still clearing.' };
    var customer = await loadCustomer(orgId, o.customerId);
    var to = billingRecipients(o, customer);
    if (!to.length) return { sent: false, reason: 'No email address for this customer. Add a billing email on the customer (or an email on the order).' };

    var ref = db.collection('purchaseOrders').doc(orderId);
    var claim = await db.runTransaction(async function (tx) {
      var snap = await tx.get(ref);
      var inv = (snap.data() && snap.data().invoice) || {};
      if (lastEmailDay(inv, tz) >= today) return null;
      tx.set(ref, { invoice: { emailClaimAt: nowFn() } }, { merge: true });
      return { prev: inv.emailClaimAt || null };
    });
    if (!claim) return { sent: false, reason: 'This invoice was already emailed today (limit: one email per invoice per day).' };

    var res;
    try {
      var online = onlineState(org);
      var content = CORE.invoiceEmailContent({ kind: kind, step: opts.step, final: !!opts.final, order: o, org: org, state: st,
        payUrl: online.ready ? (o.invoice && o.invoice.payUrl) : null });
      var pdf = await renderInvoicePdf(orgId, o, org);
      res = await sendEmail({ to: to, fromName: org.name || 'SkidSling', replyTo: orgReplyTo(org),
        subject: content.subject, html: content.html, attachments: [pdf] });
    } catch (e) {
      console.error('sendInvoiceEmail ' + orderId + ':', e);
      res = { success: false, error: e.message };
    }
    if (!res || !res.success) {
      await ref.set({ invoice: { emailClaimAt: claim.prev } }, { merge: true });
      return { sent: false, capped: !!(res && res.capped),
               reason: (res && (res.error || (res.skipped && 'Email is not configured on the server (BREVO_API_KEY)'))) || 'Not sent' };
    }

    var at = nowFn();
    var entry = { at: at, kind: kind, step: kind === 'reminder' ? opts.step : null, to: to, messageId: res.id || null, by: opts.by || null };
    await db.runTransaction(async function (tx) {
      var snap = await tx.get(ref);
      var inv = (snap.data() && snap.data().invoice) || {};
      var patch = { lastEmail: entry, emailLog: (inv.emailLog || []).concat([entry]).slice(-20) };
      if (kind === 'invoice' && !inv.sentAt) { patch.sentAt = at; patch.sentTo = to; }
      if (kind === 'reminder') {
        patch.lastReminderAt = at;
        patch.reminderCount = (inv.reminderCount || 0) + 1;
        var rem = {};
        rem[String(opts.step)] = at;
        (opts.skip || []).forEach(function (s) { rem[String(s)] = 'skipped'; });
        patch.reminders = rem;
      }
      tx.set(ref, { invoice: patch }, { merge: true });
    });
    await recomputeOrder(orgId, orderId);
    var what = kind === 'invoice' ? 'Invoice ' + (o.poNumber || '') + ' emailed to ' + to.join(', ')
      : 'Reminder (' + (opts.step > 0 ? '+' : '') + opts.step + ' days) for ' + (o.poNumber || '') + ' emailed to ' + to.join(', ');
    await logActivity(orgId, kind === 'invoice' ? 'INVOICE_SENT' : 'INVOICE_REMINDER_SENT',
      { message: what, poId: orderId, poNumber: o.poNumber || '', to: to, step: entry.step, balanceCents: st.balanceCents },
      opts.by || 'SkidSling payments');
    return { sent: true, to: to, messageId: res.id || null };
  }

  var invoiceSend = functions.runWith({ timeoutSeconds: 120, memory: '1GB' }).https.onCall(async function (data, context) {
    data = data || {};
    await AUTHZ.assertOrgMember(context, data.orgId, 'manager');
    await loadOrderInOrg(data.orgId, data.orderId);
    return sendInvoiceEmail(data.orgId, data.orderId, { kind: 'invoice', by: callerEmail(context) });
  });

  var invoiceSetReminderPause = functions.https.onCall(async function (data, context) {
    data = data || {};
    await AUTHZ.assertOrgMember(context, data.orgId, 'manager');
    var o = await loadOrderInOrg(data.orgId, data.orderId);
    var paused = data.paused === true;
    await db.collection('purchaseOrders').doc(o.id).set({ invoice: { remindersPaused: paused, remindersPausedAt: paused ? nowFn() : null } }, { merge: true });
    await logActivity(data.orgId, paused ? 'INVOICE_REMINDERS_PAUSED' : 'INVOICE_REMINDERS_RESUMED',
      { message: (paused ? 'Reminders paused for ' : 'Reminders resumed for ') + (o.poNumber || o.id), poId: o.id }, callerEmail(context));
    return { ok: true, paused: paused };
  });

  /**
   * One org's reminders for today. dryRun reports what WOULD go out.
   * Every send goes through sendInvoiceEmail, so its one-a-day and
   * never-when-paid rules hold however this is triggered.
   */
  async function runRemindersForOrg(orgId, org, opts) {
    opts = opts || {};
    var settings = (org.payments && org.payments.autoSend) || {};
    var tz = orgTz(org);
    var q = await db.collection('purchaseOrders').where('orgId', '==', orgId)
      .where('invoice.status', 'in', ['sent', 'partially_paid', 'overdue']).get();
    var custSnap = await db.collection('customers').where('orgId', '==', orgId).get();
    var customers = {};
    custSnap.docs.forEach(function (d) { customers[d.id] = d.data(); });
    var out = { checked: 0, sent: 0, failed: 0, capped: false, plans: [] };
    for (var i = 0; i < q.docs.length; i++) {
      var id = q.docs[i].id;
      out.checked++;
      var r = await recomputeOrder(orgId, id);
      if (!r) continue;
      var o = r.order;
      var plan = CORE.planReminder({ settings: settings, invoice: o.invoice, state: r.state,
        customer: customers[o.customerId] || null, now: nowFn(), tz: tz });
      var row = { orderId: id, orderNumber: o.poNumber || '', customer: o.customerName || '', balanceCents: r.state.balanceCents,
                  daysOverdue: r.state.daysOverdue, send: plan.send, step: plan.step, reason: plan.reason, next: plan.next };
      if (plan.send && !opts.dryRun && !out.capped) {
        var res = await sendInvoiceEmail(orgId, id, { kind: 'reminder', step: plan.step, skip: plan.skip, final: plan.final,
          by: opts.by || 'automatic reminders' });
        row.result = res.sent ? 'sent' : res.reason;
        if (res.sent) out.sent++; else out.failed++;
        if (res.capped) out.capped = true;
      }
      out.plans.push(row);
    }
    return out;
  }

  var invoiceRunRemindersNow = functions.runWith({ timeoutSeconds: 540, memory: '1GB' }).https.onCall(async function (data, context) {
    data = data || {};
    await AUTHZ.assertOrgMember(context, data.orgId, 'admin');
    var org = await loadOrg(data.orgId);
    var p = org.payments || {};
    if (!p.enabled) throw new HttpsError('failed-precondition', 'Invoicing is turned off for this company.');
    if (!data.dryRun && !(p.autoSend && p.autoSend.reminders)) {
      throw new HttpsError('failed-precondition', 'Automatic reminders are off. Turn them on in Settings > Payments, or use "Preview" to see what would be sent.');
    }
    return runRemindersForOrg(data.orgId, org, { dryRun: data.dryRun === true, by: callerEmail(context) });
  });

  // Hourly; each org is handled from its own send hour (default 9am in its
  // time zone) until 6pm, so a day capped by the email limit catches up later.
  var invoiceRemindersScheduled = functions.runWith({ timeoutSeconds: 540, memory: '1GB' }).pubsub
    .schedule('every 1 hours').timeZone('America/New_York').onRun(async function () {
      var snap = await db.collection('organizations').where('payments.enabled', '==', true).get();
      var stats = { orgs: 0, sent: 0 };
      for (var i = 0; i < snap.docs.length; i++) {
        var org = snap.docs[i].data();
        var a = (org.payments && org.payments.autoSend) || {};
        if (!a.reminders) continue;
        var hour = CORE.localHour(nowFn(), orgTz(org));
        var start = a.sendHour === undefined ? 9 : a.sendHour;
        if (hour < start || hour >= Math.max(start + 1, 18)) continue;
        try {
          var r = await runRemindersForOrg(snap.docs[i].id, org, {});
          stats.orgs++; stats.sent += r.sent;
          if (r.capped) break;
        } catch (e) { console.error('reminders for ' + snap.docs[i].id + ':', e); }
      }
      console.log('invoiceRemindersScheduled:', JSON.stringify(stats));
      return null;
    });

  /**
   * Order changes that matter to its invoice:
   *  - shipped (first time): issue the invoice; email it if the org turned on
   *    "send automatically when an order ships";
   *  - cancelled: void the invoice and revoke its pay link; restored: un-void;
   *  - prices / quantities / terms / dates edited: re-derive the balance.
   * Does nothing at all for an org that has not turned invoicing on (beyond
   * keeping an already-issued invoice's numbers right).
   */
  async function handleOrderChange(orgId, orderId, before, after) {
    var inv = after.invoice || {};
    var ref = db.collection('purchaseOrders').doc(orderId);
    if (after.status === 'cancelled' && before.status !== 'cancelled' && inv.issuedAt && !inv.voidedAt) {
      await ref.set({ invoice: { voidedAt: nowFn(), linkNonce: crypto.randomBytes(9).toString('hex'), payUrl: null } }, { merge: true });
      await recomputeOrder(orgId, orderId);
      await logActivity(orgId, 'INVOICE_VOIDED', { message: 'Invoice ' + (after.poNumber || orderId) + ' voided (order cancelled); its pay link no longer works', poId: orderId });
      return 'voided';
    }
    if (before.status === 'cancelled' && after.status !== 'cancelled' && inv.voidedAt) {
      await ref.set({ invoice: { voidedAt: null } }, { merge: true });
      await recomputeOrder(orgId, orderId);
      return 'unvoided';
    }
    var shippedNow = after.status === 'shipped' && before.status !== 'shipped' &&
      before.status !== 'paid' && before.status !== 'cancelled' && !inv.issuedAt;
    if (shippedNow) {
      var org = await loadOrg(orgId);
      var p = org.payments || {};
      if (!p.enabled) return 'invoicing-off';
      if (CORE.invoiceTotalCents(after) <= 0) {
        await logActivity(orgId, 'INVOICE_NOT_SENT', { message: (after.poNumber || orderId) +
          ' shipped, but its invoice is $0.00 (no shipped quantities) - not issued. Set shipped quantities, then use Send invoice.', poId: orderId });
        return 'zero-total';
      }
      await ensureIssued(orgId, orderId);
      if (p.autoSend && p.autoSend.sendOnShip) {
        var r = await sendInvoiceEmail(orgId, orderId, { kind: 'invoice', by: 'sent automatically when shipped' });
        if (!r.sent) await logActivity(orgId, 'INVOICE_NOT_SENT', { message: 'Invoice ' + (after.poNumber || orderId) + ' was not emailed: ' + r.reason, poId: orderId });
        return r.sent ? 'sent' : 'not-sent';
      }
      return 'issued';
    }
    if (inv.issuedAt || after.amountPaidCents !== undefined) {
      var keys = ['items', 'tax', 'shipping', 'credit', 'discount', 'terms', 'invoiceDate', 'dueDate', 'status', 'paidVia'];
      var changed = keys.some(function (k) { return JSON.stringify(before[k]) !== JSON.stringify(after[k]); });
      if (changed) { await recomputeOrder(orgId, orderId); return 'recomputed'; }
    }
    return null;
  }

  var invoiceOnOrderUpdate = functions.runWith({ timeoutSeconds: 120, memory: '1GB' }).firestore
    .document('purchaseOrders/{orderId}').onUpdate(async function (change, context) {
      var before = change.before.data() || {};
      var after = change.after.data() || {};
      if (!after.orgId || before.orgId !== after.orgId) return null;
      try {
        return await handleOrderChange(after.orgId, context.params.orderId, before, after);
      } catch (e) {
        console.error('invoiceOnOrderUpdate ' + context.params.orderId + ':', e);
        return null;
      }
    });

  // ───────────────────────────────── daily: sent invoices past due -> overdue ────

  async function runOverdueSweep(onlyOrgId) {
    var orgs = [];
    if (onlyOrgId) {
      var one = await db.collection('organizations').doc(onlyOrgId).get();
      if (one.exists) orgs.push({ id: one.id, data: one.data() });
    } else {
      var snap = await db.collection('organizations').where('payments.enabled', '==', true).get();
      snap.docs.forEach(function (d) { orgs.push({ id: d.id, data: d.data() }); });
    }
    var stats = { orgs: orgs.length, checked: 0, changed: 0, overdue: 0 };
    for (var i = 0; i < orgs.length; i++) {
      var q = await db.collection('purchaseOrders').where('orgId', '==', orgs[i].id)
        .where('invoice.status', 'in', CORE.OPEN_INVOICE_STATUSES).get();
      for (var j = 0; j < q.docs.length; j++) {
        stats.checked++;
        try {
          var r = await recomputeOrder(orgs[i].id, q.docs[j].id);
          if (r && r.changed) stats.changed++;
          if (r && r.state && r.state.status === 'overdue') stats.overdue++;
        } catch (e) { console.error('overdue sweep ' + q.docs[j].id + ':', e.message); }
      }
    }
    return stats;
  }

  var invoiceOverdueScheduled = functions.pubsub.schedule('0 6 * * *').timeZone('America/New_York').onRun(async function () {
    var stats = await runOverdueSweep();
    console.log('invoiceOverdueScheduled:', JSON.stringify(stats));
    return null;
  });

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
    invoiceOverdueScheduled: invoiceOverdueScheduled,
    invoiceSend: invoiceSend,
    invoiceSetReminderPause: invoiceSetReminderPause,
    invoiceRunRemindersNow: invoiceRunRemindersNow,
    invoiceRemindersScheduled: invoiceRemindersScheduled,
    invoiceOnOrderUpdate: invoiceOnOrderUpdate,
    // For tests
    _internal: { handleConnectEvent: handleConnectEvent, claimAccount: claimAccount,
                 recomputeOrder: recomputeOrder, ensureIssued: ensureIssued, runOverdueSweep: runOverdueSweep,
                 sendEmail: sendEmail, sendInvoiceEmail: sendInvoiceEmail, runRemindersForOrg: runRemindersForOrg,
                 handleOrderChange: handleOrderChange }
  };
};
