/**
 * SkidSling - invoicing & collections: the PURE rules.
 *
 * Nothing in this file touches Firestore, Stripe, email or the clock (the
 * caller passes `now`). Every decision that moves money or emails a customer
 * is made here, so it can be unit tested the way stockLedger.js is
 * (tests/unit/invoicing*.test.mjs). invoicing.js is the thin I/O layer.
 *
 * Money is integer CENTS everywhere in here. Order documents keep their
 * existing dollar floats (total, tax, unitPrice...) and are converted once, on
 * the way in, with the same rounding the printed invoice uses.
 */

var crypto = require('crypto');

// ─────────────────────────────────────────────────────────────── config ────

var STRIPE_KEY_PREFIX = { test: ['sk_test_', 'rk_test_'], live: ['sk_live_', 'rk_live_'] };

/**
 * Invoicing runs on its OWN Stripe key (STRIPE_CONNECT_SECRET_KEY), separate
 * from the subscription key, so it can sit in test mode while SkidSling's own
 * billing stays live. INVOICING_MODE says which one it is meant to be, and the
 * key has to agree - a live key in test mode (or the reverse) is refused
 * outright rather than quietly moving real money.
 */
function invoicingConfig(env) {
  env = env || {};
  var errors = [];
  var mode = String(env.INVOICING_MODE || '').trim().toLowerCase();
  if (mode !== 'test' && mode !== 'live') {
    errors.push('INVOICING_MODE must be "test" or "live"');
  }
  var key = String(env.STRIPE_CONNECT_SECRET_KEY || '').trim();
  if (!key) {
    errors.push('STRIPE_CONNECT_SECRET_KEY is not set');
  } else if (mode === 'test' || mode === 'live') {
    var ok = STRIPE_KEY_PREFIX[mode].some(function (p) { return key.indexOf(p) === 0; });
    if (!ok) errors.push('STRIPE_CONNECT_SECRET_KEY does not look like a ' + mode + ' key; refusing to start invoicing in ' + mode + ' mode');
  }
  var base = String(env.APP_BASE_URL || 'https://skidsling.com').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(base)) errors.push('APP_BASE_URL must be an http(s) URL');
  return {
    ok: errors.length === 0,
    errors: errors,
    mode: mode,
    livemode: mode === 'live',
    secretKey: key,
    webhookSecret: String(env.STRIPE_CONNECT_WEBHOOK_SECRET || '').trim(),
    clientId: String(env.STRIPE_CONNECT_CLIENT_ID || '').trim(),
    linkSecret: String(env.INVOICE_LINK_SECRET || '').trim(),
    appBaseUrl: base
  };
}

// ───────────────────────────────────────────────────────────── signing ────

function hmac(secret, message) {
  return crypto.createHmac('sha256', String(secret)).update(String(message)).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function safeEqual(a, b) {
  var x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * OAuth `state` for "Connect an existing Stripe account": binds the round trip
 * to one org and one signed-in user, and expires, so a callback cannot be
 * replayed into a different tenant.
 */
function signOAuthState(secret, orgId, uid, issuedAtMs) {
  var body = [orgId, uid, String(issuedAtMs)].join('.');
  return Buffer.from(body).toString('base64').replace(/=+$/, '') + '.' + hmac(secret, 'oauth|' + body);
}
function verifyOAuthState(secret, state, uid, nowMs, maxAgeMs) {
  var s = String(state || '');
  var dot = s.lastIndexOf('.');
  if (dot <= 0) return null;
  var body;
  try { body = Buffer.from(s.slice(0, dot), 'base64').toString('utf8'); } catch (e) { return null; }
  if (!safeEqual(s.slice(dot + 1), hmac(secret, 'oauth|' + body))) return null;
  var parts = body.split('.');
  if (parts.length !== 3) return null;
  if (parts[1] !== uid) return null;
  var at = Number(parts[2]);
  if (!isFinite(at) || nowMs - at > (maxAgeMs || 30 * 60 * 1000) || at - nowMs > 60 * 1000) return null;
  return { orgId: parts[0], uid: parts[1], issuedAt: at };
}

// ─────────────────────────────────────────────────── connected account ────

/** The flags SkidSling keeps about a tenant's connected Stripe account. */
function accountFlags(acct) {
  acct = acct || {};
  var req = acct.requirements || {};
  return {
    chargesEnabled: !!acct.charges_enabled,
    payoutsEnabled: !!acct.payouts_enabled,
    detailsSubmitted: !!acct.details_submitted,
    currentlyDue: Array.isArray(req.currently_due) ? req.currently_due.slice(0, 20) : [],
    disabledReason: req.disabled_reason || null
  };
}

/** Connected / Needs info / Disconnected, as the settings page shows it. */
function connectionState(payments) {
  var p = payments || {};
  if (!p.stripeAccountId || p.connected === false) return 'disconnected';
  if (p.chargesEnabled && p.detailsSubmitted) return 'connected';
  return 'needs_info';
}

var ALLOWED_METHODS = ['card', 'us_bank_account'];

var EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
function isEmail(v) { return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v.trim()); }

/** A list of addresses from an array or a comma/semicolon/space separated string. */
function emailList(v) {
  var raw = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,;\s]+/);
  var out = [];
  raw.forEach(function (e) {
    var t = String(e || '').trim().toLowerCase();
    if (t && isEmail(t) && out.indexOf(t) === -1) out.push(t);
  });
  return out.slice(0, 10);
}

/**
 * The org-editable part of organizations/{id}.payments. Anything not listed
 * here (the connected account, its flags, the mode) is server-owned and cannot
 * be set through this path. Throws with a readable message on bad input.
 */
function sanitizePaymentSettings(input, current) {
  input = input || {};
  current = current || {};
  var out = {};
  if (input.enabled !== undefined) out.enabled = input.enabled === true;
  if (input.methods !== undefined) {
    if (!Array.isArray(input.methods)) throw new Error('methods must be a list');
    var m = input.methods.filter(function (x) { return ALLOWED_METHODS.indexOf(x) !== -1; })
      .filter(function (x, i, a) { return a.indexOf(x) === i; });
    if (m.length === 0) throw new Error('Pick at least one payment method (card or bank transfer)');
    out.methods = m;
  }
  if (input.billingEmail !== undefined) {
    var be = String(input.billingEmail || '').trim().toLowerCase();
    if (be && !isEmail(be)) throw new Error('Billing email is not a valid address');
    out.billingEmail = be;
  }
  if (input.notifyOnPayment !== undefined) out.notifyOnPayment = input.notifyOnPayment === true;
  return out;
}

module.exports = {
  invoicingConfig: invoicingConfig,
  hmac: hmac,
  safeEqual: safeEqual,
  signOAuthState: signOAuthState,
  verifyOAuthState: verifyOAuthState,
  accountFlags: accountFlags,
  connectionState: connectionState,
  ALLOWED_METHODS: ALLOWED_METHODS,
  isEmail: isEmail,
  emailList: emailList,
  sanitizePaymentSettings: sanitizePaymentSettings
};
