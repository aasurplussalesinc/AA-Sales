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
    // For tests
    _internal: { handleConnectEvent: handleConnectEvent, claimAccount: claimAccount }
  };
};
