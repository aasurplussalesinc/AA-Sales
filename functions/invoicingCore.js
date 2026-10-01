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
  var out = {
    chargesEnabled: !!acct.charges_enabled,
    payoutsEnabled: !!acct.payouts_enabled,
    detailsSubmitted: !!acct.details_submitted,
    currentlyDue: Array.isArray(req.currently_due) ? req.currently_due.slice(0, 20) : [],
    disabledReason: req.disabled_reason || null
  };
  // The company's brand color from its own Stripe branding settings (also used
  // by Stripe Checkout). Only set when present, so a refresh never clears it.
  var color = acct.settings && acct.settings.branding && acct.settings.branding.primary_color;
  if (hexColor(color)) out.brandColor = hexColor(color);
  return out;
}

/** '#1a2b3c' (lower case) or null. */
function hexColor(v) {
  var s = String(v || '').trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

/** Connected / Needs info / Disconnected, as the settings page shows it. */
function connectionState(payments) {
  var p = payments || {};
  if (!p.stripeAccountId || p.connected === false) return 'disconnected';
  if (p.chargesEnabled && p.detailsSubmitted) return 'connected';
  return 'needs_info';
}

var ALLOWED_METHODS = ['card', 'us_bank_account'];

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
  if (input.cardSurcharge !== undefined) {
    // Built, but ships OFF: surcharging has card-network rules, a 3% US cap
    // and state restrictions - Alan's/accountant's decision before it is used.
    var cs = input.cardSurcharge || {};
    var pct = Number(cs.percent);
    if (cs.percent !== undefined && cs.percent !== '' && (!isFinite(pct) || pct < 0 || pct > 3)) {
      throw new Error('Card surcharge must be between 0% and 3%');
    }
    var max = cs.maxInvoiceForCards;
    var maxCents = (max === null || max === undefined || max === '') ? null : toCents(max);
    if (maxCents !== null && maxCents < 0) throw new Error('Card limit must be 0 or more');
    out.cardSurcharge = { enabled: cs.enabled === true, percent: isFinite(pct) ? pct : 0, maxInvoiceForCardsCents: maxCents };
  }
  // Automatic collections: every switch defaults OFF.
  if (input.autoSend !== undefined) out.autoSend = sanitizeAutoSend(input.autoSend, current.autoSend);
  return out;
}

// ────────────────────────────────────────────────────────────── money ────

/** Dollars (number or numeric string) to integer cents, rounded like toFixed(2). */
function toCents(v) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(n)) return 0;
  return Math.round(Number(n.toFixed(2)) * 100);
}
function centsToDollars(c) { return Math.round(Number(c) || 0) / 100; }
function formatCents(c) {
  var n = Math.round(Number(c) || 0);
  var s = (Math.abs(n) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-$' : '$') + s;
}

/**
 * What the INVOICE says the customer owes, in cents. Exactly the arithmetic of
 * renderOrderDocument(order, 'invoice') in orderDocument.mjs - shipped
 * quantity x unit price, plus tax and shipping, less credit and discount -
 * rounded the way the document prints its Total. The printed invoice is the
 * source of truth; Stripe only collects what it says.
 */
function invoiceTotalCents(order) {
  var o = order || {};
  var subtotal = (o.items || []).reduce(function (sum, item) {
    var qty = Number(item && item.qtyShipped) || 0;
    var price = parseFloat(item && item.unitPrice) || 0;
    return sum + qty * price;
  }, 0);
  var total = subtotal + (parseFloat(o.tax) || 0) + (parseFloat(o.shipping) || 0)
    - (parseFloat(o.credit) || 0) - (parseFloat(o.discount) || 0);
  return toCents(total);
}

// ────────────────────────────────────────────────────────────── dates ────
// Invoices are dated in whole days. A "day number" is days since 1970-01-01
// for a calendar date, so due-date arithmetic never trips over time zones or
// daylight saving. Timestamps become calendar dates in the org's time zone.

var DAY_MS = 86400000;
var DEFAULT_TZ = 'America/New_York';

function isoToDay(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return isFinite(t) ? Math.floor(t / DAY_MS) : null;
}
function dayToIso(day) {
  if (day === null || day === undefined || !isFinite(day)) return '';
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}
/** Calendar date (day number) of a moment, in a time zone. */
function localDay(ms, tz) {
  if (ms === null || ms === undefined || !isFinite(ms)) return null;
  var parts = new Intl.DateTimeFormat('en-CA', { timeZone: validTimeZone(tz) ? tz : DEFAULT_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  return isoToDay(parts);
}
function localHour(ms, tz) {
  return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: validTimeZone(tz) ? tz : DEFAULT_TZ,
    hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)), 10) % 24;
}
/** A stored date in any of the shapes orders use: 'YYYY-MM-DD', ms, ISO string, Firestore Timestamp. */
function anyToDay(v, tz) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') {
    var d = isoToDay(v.slice(0, 10));
    if (d !== null && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return d;
    var t = Date.parse(v);
    return isFinite(t) ? localDay(t, tz) : null;
  }
  if (typeof v === 'number') return localDay(v, tz);
  if (typeof v.toMillis === 'function') return localDay(v.toMillis(), tz);
  if (typeof v.toDate === 'function') return localDay(v.toDate().getTime(), tz);
  var secs = v.seconds !== undefined ? v.seconds : v._seconds;
  if (secs !== undefined) return localDay(Number(secs) * 1000, tz);
  return null;
}

/** Days allowed by payment terms. "Net 30" -> 30, "Due on Receipt" -> 0; blank or unknown -> 30 (the documents' default). */
function termsDays(terms) {
  var t = String(terms || '').trim();
  if (!t) return 30;
  var m = /net\s*(\d{1,3})/i.exec(t) || /^(\d{1,3})\s*days?$/i.exec(t);
  if (m) return Math.min(parseInt(m[1], 10), 365);
  if (/receipt|cod\b|c\.o\.d|prepaid|pre-paid|immediate|due now|upon/i.test(t)) return 0;
  return 30;
}

/** The invoice date: invoiceDate if set, else when it shipped, else when it was issued/created. */
function invoiceIssueDay(order, tz) {
  var o = order || {};
  return anyToDay(o.invoiceDate, tz)
    ?? anyToDay(o.shippedAt, tz)
    ?? anyToDay(o.invoice && o.invoice.issuedAt, tz)
    ?? anyToDay(o.createdAt, tz);
}
/** Due date: an explicit order.dueDate wins, else invoice date + terms. */
function invoiceDueDay(order, tz) {
  var o = order || {};
  var explicit = anyToDay(o.dueDate, tz);
  if (explicit !== null) return explicit;
  var issue = invoiceIssueDay(o, tz);
  if (issue === null) return null;
  return issue + termsDays(o.terms);
}

// ───────────────────────────────────────────────────────────── ledger ────

/**
 * A payment's status from the facts recorded on it. Facts only accumulate
 * (succeededAt, failedAt, refundedCents only grows), which is what makes the
 * webhook processing order-independent: however events arrive, the same facts
 * give the same status. A success outranks a failure - a declined card
 * followed by a good one on the same payment intent is a payment.
 */
/** Money taken back after a payment: refunds plus a lost dispute. */
function refundedOf(p) {
  var amount = Number(p.amountCents) || 0;
  return Math.min((Number(p.refundedCents) || 0) + (Number(p.disputeLostCents) || 0), amount);
}

function paymentStatus(p) {
  p = p || {};
  if (p.voidedAt) return 'voided';
  var amount = Number(p.amountCents) || 0;
  var refunded = refundedOf(p);
  if (p.succeededAt) {
    if (amount > 0 && refunded >= amount) return 'refunded';
    if (refunded > 0) return 'partially_refunded';
    return 'succeeded';
  }
  if (p.failedAt) return 'failed';
  return 'pending';
}

/** How a payment is split across invoices, oldest first. Single-invoice payments carry the whole amount. */
function paymentAllocations(p) {
  if (Array.isArray(p.allocations) && p.allocations.length) return p.allocations;
  if (p.orderId) return [{ orderId: p.orderId, cents: Number(p.amountCents) || 0 }];
  return [];
}

/**
 * What one payment contributes to one order: { paid, pending }. Refunds come
 * off the END of the allocation list (the newest invoice a statement payment
 * covered, after any unallocated credit), so earlier invoices stay paid.
 */
function paymentShare(p, orderId) {
  var st = paymentStatus(p);
  var allocs = paymentAllocations(p);
  var out = { paid: 0, pending: 0 };
  if (st === 'pending') {
    allocs.forEach(function (a) { if (a.orderId === orderId) out.pending += Number(a.cents) || 0; });
    return out;
  }
  if (st !== 'succeeded' && st !== 'partially_refunded' && st !== 'refunded') return out;
  var amount = Number(p.amountCents) || 0;
  var allocated = allocs.reduce(function (s, a) { return s + (Number(a.cents) || 0); }, 0);
  var credit = Math.max(0, amount - allocated);
  var refunded = refundedOf(p);
  var refundLeft = Math.max(0, refunded - credit);        // credit is refunded first
  var effective = allocs.map(function (a) { return Number(a.cents) || 0; });
  for (var i = effective.length - 1; i >= 0 && refundLeft > 0; i--) {
    var take = Math.min(effective[i], refundLeft);
    effective[i] -= take; refundLeft -= take;
  }
  allocs.forEach(function (a, i) { if (a.orderId === orderId) out.paid += effective[i]; });
  return out;
}

/** Totals for one order across the ledger. */
function orderLedger(orderId, payments) {
  var led = { paidCents: 0, pendingCents: 0, paymentCount: 0, lastPaymentAt: null, lastMethod: null, disputed: false };
  (payments || []).forEach(function (p) {
    var ids = Array.isArray(p.orderIds) ? p.orderIds : [p.orderId];
    if (ids.indexOf(orderId) === -1) return;
    var share = paymentShare(p, orderId);
    led.paidCents += share.paid;
    led.pendingCents += share.pending;
    var st = paymentStatus(p);
    if (st !== 'voided' && st !== 'failed') led.paymentCount++;
    if (p.disputed && !p.disputeClosed) led.disputed = true;
    var at = p.succeededAt || null;
    if (at && (!led.lastPaymentAt || at > led.lastPaymentAt)) { led.lastPaymentAt = at; led.lastMethod = p.method || null; }
  });
  return led;
}

var INVOICE_STATUSES = ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void'];
var OPEN_INVOICE_STATUSES = ['draft', 'sent', 'partially_paid', 'overdue'];

/**
 * Everything about an invoice's money and status, from the order, its ledger
 * totals and today's date (a day number in the org's time zone).
 *
 *   void            order cancelled, or invoice voided
 *   draft           not issued yet (not shipped), nothing on it, or issued but not sent and not yet due
 *   paid            balance is zero (by the ledger, or an order someone marked Paid by hand)
 *   overdue         past due with a balance
 *   partially_paid  something paid, not yet due
 *   sent            emailed, nothing paid, not yet due
 */
function invoiceState(order, ledger, today, tz) {
  var o = order || {};
  var inv = o.invoice || {};
  var led = ledger || { paidCents: Number(o.amountPaidCents) || 0, pendingCents: Number(o.pendingCents) || 0 };
  var totalCents = invoiceTotalCents(o);
  var paid = Number(led.paidCents) || 0;
  var pending = Number(led.pendingCents) || 0;
  // "Mark Paid" in the app (no ledger entry) is a person saying it's settled.
  var manualPaid = o.status === 'paid' && o.paidVia !== 'ledger';
  var voided = o.status === 'cancelled' || !!inv.voidedAt;
  var issued = !!inv.issuedAt || o.status === 'shipped' || o.status === 'paid';
  var raw = totalCents - paid;
  var balance = manualPaid ? 0 : Math.max(0, raw);
  var credit = raw < 0 ? -raw : 0;
  var dueDay = invoiceDueDay(o, tz);
  var collectible = voided ? 0 : Math.max(0, balance - pending);
  var daysOverdue = (issued && !voided && balance > 0 && dueDay !== null && today !== null && today > dueDay) ? today - dueDay : 0;

  var status;
  if (voided) status = 'void';
  else if (!issued || totalCents <= 0) status = manualPaid ? 'paid' : 'draft';
  else if (balance === 0) status = 'paid';
  else if (daysOverdue > 0) status = 'overdue';
  else if (paid > 0) status = 'partially_paid';
  else if (inv.sentAt) status = 'sent';
  else status = 'draft';

  return {
    status: status,
    totalCents: totalCents,
    paidCents: paid,
    pendingCents: pending,
    balanceCents: voided ? 0 : balance,
    collectibleCents: collectible,
    creditCents: credit,
    paymentPending: pending > 0 && !voided,
    issued: issued,
    zeroTotal: totalCents <= 0,
    manualPaid: manualPaid,
    dueDate: dayToIso(dueDay),
    dueDay: dueDay,
    daysOverdue: daysOverdue
  };
}

// ─────────────────────────────────────────────────────── pay links ────

/**
 * The customer-facing pay link carries an HMAC of what it is for (one
 * invoice, or one customer's statement) so it cannot be edited to point at a
 * different order or org. `nonce` lets an invoice's link be revoked (void)
 * by changing it. No expiry: the link always charges the balance at the
 * moment it is opened, so it cannot go stale.
 */
function payTokenMessage(kind, orgId, id, nonce) {
  return ['pay', 'v1', kind, orgId, id, nonce || ''].join('|');
}
function signPayToken(secret, kind, orgId, id, nonce) {
  if (!secret) throw new Error('INVOICE_LINK_SECRET is not set');
  return hmac(secret, payTokenMessage(kind, orgId, id, nonce)).slice(0, 32);
}
function verifyPayToken(secret, kind, orgId, id, nonce, token) {
  if (!secret || typeof token !== 'string' || token.length !== 32) return false;
  return safeEqual(token, signPayToken(secret, kind, orgId, id, nonce));
}
function invoicePayUrl(base, secret, orgId, orderId, nonce) {
  return base + '/pay/' + encodeURIComponent(orgId) + '/' + encodeURIComponent(orderId) +
    '?t=' + signPayToken(secret, 'invoice', orgId, orderId, nonce);
}
function statementPayUrl(base, secret, orgId, customerId) {
  return base + '/pay/' + encodeURIComponent(orgId) + '/statement/' + encodeURIComponent(customerId) +
    '?t=' + signPayToken(secret, 'statement', orgId, customerId, '');
}

// ──────────────────────────────────────────────────── checkout options ────

/** Card surcharge in cents. Ships OFF; capped at 3% (US card-network cap) even if set higher. */
function cardSurchargeCents(balanceCents, cardSurcharge) {
  var cs = cardSurcharge || {};
  if (!cs.enabled) return 0;
  var pct = Math.min(3, Math.max(0, Number(cs.percent) || 0));
  return Math.round((Number(balanceCents) || 0) * pct / 100);
}

/**
 * The ways a customer may pay this balance. When nothing about cards is
 * special there is one option with every enabled method; otherwise bank
 * transfer and card are offered separately so a surcharge (if the org turned
 * one on) is only ever added to a card payment.
 */
function paymentOptions(methods, cardSurcharge, balanceCents) {
  var ms = (Array.isArray(methods) && methods.length ? methods : ALLOWED_METHODS)
    .filter(function (m) { return ALLOWED_METHODS.indexOf(m) !== -1; });
  var cs = cardSurcharge || {};
  var maxCard = cs.maxInvoiceForCardsCents === null || cs.maxInvoiceForCardsCents === undefined ? null : Number(cs.maxInvoiceForCardsCents);
  var cardAllowed = ms.indexOf('card') !== -1 && !(maxCard !== null && isFinite(maxCard) && balanceCents > maxCard);
  var bankAllowed = ms.indexOf('us_bank_account') !== -1;
  var surcharge = cardAllowed ? cardSurchargeCents(balanceCents, cs) : 0;
  var opts = [];
  if (bankAllowed && cardAllowed && surcharge === 0 && maxCard === null) {
    opts.push({ method: 'any', methods: ['us_bank_account', 'card'], label: 'Pay now (bank transfer or card)', surchargeCents: 0 });
    return opts;
  }
  if (bankAllowed) opts.push({ method: 'us_bank_account', methods: ['us_bank_account'], label: 'Pay by bank transfer (ACH)', surchargeCents: 0 });
  if (cardAllowed) opts.push({ method: 'card', methods: ['card'], label: 'Pay by card', surchargeCents: surcharge });
  return opts;
}

function invoiceLineName(order) {
  var o = order || {};
  var name = 'Invoice ' + (o.poNumber || '');
  if (o.customerPO) name += ' (PO ' + String(o.customerPO).slice(0, 60) + ')';
  return name.trim();
}

/**
 * Stripe Checkout Session parameters (created ON the connected account by the
 * caller). The session charges exactly the collectible balance; metadata ties
 * every resulting event back to the org and order(s).
 */
function buildCheckoutParams(a) {
  var surcharge = a.option.surchargeCents || 0;
  var meta = {
    skidsling: 'invoice-payment',
    kind: a.kind,                           // 'invoice' | 'statement'
    orgId: a.orgId,
    orderId: a.orderId || '',
    orderNumber: a.orderNumber || '',
    customerId: a.customerId || '',
    surchargeCents: String(surcharge)
  };
  var lines = [{
    price_data: { currency: 'usd', unit_amount: a.amountCents, product_data: { name: a.lineName } },
    quantity: 1
  }];
  if (surcharge > 0) {
    lines.push({ price_data: { currency: 'usd', unit_amount: surcharge,
      product_data: { name: 'Card processing fee' } }, quantity: 1 });
  }
  var params = {
    mode: 'payment',
    payment_method_types: a.option.methods.slice(),
    line_items: lines,
    metadata: meta,
    payment_intent_data: { metadata: meta, description: a.lineName },
    success_url: a.successUrl,
    cancel_url: a.cancelUrl
  };
  if (a.customerEmail && isEmail(a.customerEmail)) params.customer_email = a.customerEmail.trim();
  return params;
}

// ────────────────────────────────────────── Stripe events -> ledger facts ────

var PAYMENT_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'payment_intent.processing',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed'
];

function idOf(v) { return v && typeof v === 'object' ? v.id : (v || null); }
function stripeMethod(type) {
  if (type === 'us_bank_account' || type === 'ach_debit' || type === 'ach_credit_transfer') return 'ach';
  if (type === 'card') return 'card';
  return type ? 'other' : null;
}
function metaFrom(m) {
  m = m || {};
  if (m.skidsling !== 'invoice-payment' || !m.orgId) return null;
  return { orgId: String(m.orgId), kind: m.kind === 'statement' ? 'statement' : 'invoice',
           orderId: m.orderId || '', orderNumber: m.orderNumber || '', customerId: m.customerId || '',
           surchargeCents: Math.max(0, parseInt(m.surchargeCents, 10) || 0) };
}

/**
 * The facts one Stripe event states about one payment (keyed by payment
 * intent). Pure: uses only the event, never the clock, so replaying events
 * in any order gives identical facts. Returns null for anything that is not
 * a SkidSling invoice payment (e.g. the company's own unrelated Stripe sales).
 *
 * `meta` is null when the event itself does not say which org/order it is
 * for (charge and dispute events); the caller then looks the payment up.
 */
function paymentFactsFromEvent(event) {
  if (!event || PAYMENT_EVENT_TYPES.indexOf(event.type) === -1) return null;
  var o = (event.data && event.data.object) || {};
  var at = (Number(event.created) || 0) * 1000;
  var f = { paymentIntentId: null, meta: null, at: at, set: {} };

  if (event.type.indexOf('checkout.session.') === 0) {
    if (o.mode && o.mode !== 'payment') return null;
    f.meta = metaFrom(o.metadata);
    if (!f.meta) return null;
    f.paymentIntentId = idOf(o.payment_intent);
    f.set.checkoutSessionId = o.id || null;
    if (o.amount_total !== undefined && o.amount_total !== null) f.set.grossCents = Number(o.amount_total) || 0;
    if (event.type === 'checkout.session.completed') {
      // Paid on completion means a card (bank debits always complete unpaid).
      if (o.payment_status === 'paid' || o.payment_status === 'no_payment_required') { f.set.succeededAt = at; f.set.methodGuess = 'card'; }
      else { f.set.pendingAt = at; f.set.methodGuess = 'ach'; }   // async (bank) payments complete unpaid
    } else if (event.type === 'checkout.session.async_payment_succeeded') {
      f.set.succeededAt = at;
    } else {
      f.set.failedAt = at;
      f.set.failureMessage = 'Bank payment failed';
    }
    if (o.customer_details && o.customer_details.email) f.set.payerEmail = String(o.customer_details.email).toLowerCase();
    return f;
  }

  if (event.type.indexOf('payment_intent.') === 0) {
    f.meta = metaFrom(o.metadata);
    if (!f.meta) return null;
    f.paymentIntentId = o.id || null;
    if (o.amount !== undefined) f.set.grossCents = Number(o.amount) || 0;
    if (o.latest_charge) f.set.chargeId = idOf(o.latest_charge);
    var types = o.payment_method_types || [];
    if (event.type === 'payment_intent.processing') {
      f.set.pendingAt = at;
      if (types.length === 1) f.set.methodGuess = stripeMethod(types[0]);
      else f.set.methodGuess = 'ach';                            // only bank debits sit in processing
    } else if (event.type === 'payment_intent.succeeded') {
      f.set.succeededAt = at;
      if (o.amount_received) f.set.grossCents = Number(o.amount_received) || 0;
      if (types.length === 1) f.set.methodGuess = stripeMethod(types[0]);
    } else {
      f.set.failedAt = at;
      var err = o.last_payment_error || {};
      f.set.failureMessage = String(err.message || err.code || 'Payment failed').slice(0, 200);
      if (err.payment_method && err.payment_method.type) f.set.methodGuess = stripeMethod(err.payment_method.type);
    }
    return f;
  }

  if (event.type === 'charge.refunded') {
    f.paymentIntentId = idOf(o.payment_intent);
    f.meta = metaFrom(o.metadata);                  // present only if Stripe copied it
    f.set.chargeId = o.id || null;
    f.set.refundedGrossCents = Number(o.amount_refunded) || 0;
    if (o.payment_method_details && o.payment_method_details.type) f.set.method = stripeMethod(o.payment_method_details.type);
    return f;
  }

  // disputes
  f.paymentIntentId = idOf(o.payment_intent);
  f.meta = metaFrom(o.metadata);
  f.set.chargeId = idOf(o.charge);
  if (event.type === 'charge.dispute.created') {
    f.set.disputed = true;
    f.set.disputeAmountCents = Number(o.amount) || 0;
  } else {
    f.set.disputed = true;
    f.set.disputeClosed = true;
    f.set.disputeStatus = o.status || null;
    if (o.status === 'lost') f.set.disputeLostCents = Number(o.amount) || 0;
  }
  return f;
}

/**
 * Merge an event's facts into a payment row. Every rule is commutative and
 * idempotent (earliest success, latest failure, largest refund, flags only
 * ever turn on), which is what makes out-of-order and repeated webhook
 * deliveries converge on the same row.
 */
function mergePaymentFacts(existing, facts, meta) {
  var p = JSON.parse(JSON.stringify(existing || {}));
  var s = facts.set || {};
  var m = meta || facts.meta || {};
  var minT = function (a, b) { return a && b ? Math.min(a, b) : (a || b || null); };
  var maxT = function (a, b) { return a && b ? Math.max(a, b) : (a || b || null); };
  var maxN = function (a, b) { return Math.max(Number(a) || 0, Number(b) || 0); };

  p.source = 'stripe';
  p.currency = 'usd';
  if (!p.orgId && m.orgId) p.orgId = m.orgId;
  if (!p.kind) p.kind = m.kind || 'invoice';
  if (!p.orderId && m.orderId) p.orderId = m.orderId;
  if (!p.orderNumber && m.orderNumber) p.orderNumber = m.orderNumber;
  if (!p.customerId && m.customerId) p.customerId = m.customerId;
  if (p.surchargeCents === undefined && m.surchargeCents !== undefined) p.surchargeCents = m.surchargeCents;
  p.stripe = p.stripe || {};
  if (facts.paymentIntentId) p.stripe.paymentIntentId = facts.paymentIntentId;
  if (s.checkoutSessionId) p.stripe.checkoutSessionId = s.checkoutSessionId;
  if (s.chargeId) p.stripe.chargeId = s.chargeId;

  if (s.grossCents !== undefined) p.grossCents = maxN(p.grossCents, s.grossCents);
  var surcharge = Number(p.surchargeCents) || 0;
  if (p.grossCents !== undefined) p.amountCents = Math.max(0, p.grossCents - surcharge);

  p.firstEventAt = minT(p.firstEventAt, facts.at);
  p.createdAt = p.firstEventAt;
  if (s.pendingAt) p.pendingAt = minT(p.pendingAt, s.pendingAt);
  if (s.succeededAt) p.succeededAt = minT(p.succeededAt, s.succeededAt);
  if (s.failedAt) {
    // Latest failure's message wins; a tie is broken by the text itself so
    // the result does not depend on delivery order.
    if (!p.failedAt || s.failedAt > p.failedAt) p.failureMessage = s.failureMessage || null;
    else if (s.failedAt === p.failedAt && String(s.failureMessage || '') > String(p.failureMessage || '')) p.failureMessage = s.failureMessage;
    p.failedAt = maxT(p.failedAt, s.failedAt);
  }
  if (s.refundedGrossCents !== undefined) p.refundedGrossCents = maxN(p.refundedGrossCents, s.refundedGrossCents);
  if (p.refundedGrossCents !== undefined) p.refundedCents = Math.min(Number(p.refundedGrossCents) || 0, Number(p.amountCents) || 0);
  if (s.disputed) p.disputed = true;
  if (s.disputeClosed) p.disputeClosed = true;
  if (s.disputeStatus) p.disputeStatus = s.disputeStatus;
  if (s.disputeAmountCents !== undefined) p.disputeAmountCents = maxN(p.disputeAmountCents, s.disputeAmountCents);
  if (s.disputeLostCents !== undefined) p.disputeLostCents = maxN(p.disputeLostCents, s.disputeLostCents);
  if (s.payerEmail && !p.payerEmail) p.payerEmail = s.payerEmail;
  // Exact method (from the charge) beats a guess; among guesses, bank wins
  // because only bank debits ever sit in "processing".
  if (s.method) { p.method = s.method; p.methodExact = true; }
  else if (s.methodGuess && !p.methodExact && (!p.method || s.methodGuess === 'ach')) p.method = s.methodGuess;
  p.status = paymentStatus(p);
  return p;
}

/** What changed, for notifications: the status moves between the two rows. */
function paymentTransition(before, after) {
  var a = before ? paymentStatus(before) : null;
  var b = paymentStatus(after);
  var out = [];
  if (a !== b) out.push(b);
  if (after.disputed && !(before && before.disputed)) out.push('disputed');
  if ((Number(after.refundedCents) || 0) > (Number(before && before.refundedCents) || 0) && b === 'partially_refunded' && a === b) out.push('partially_refunded');
  return out;
}

/** Aging bucket for collections: current / 1-30 / 31-60 / 61-90 / 90+. */
function agingBucket(daysOverdue) {
  var d = Number(daysOverdue) || 0;
  if (d <= 0) return 'current';
  if (d <= 30) return '1-30';
  if (d <= 60) return '31-60';
  if (d <= 90) return '61-90';
  return '90+';
}
var AGING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'];

// ─────────────────────────────────────────── automatic collections ────

var DEFAULT_SCHEDULE = [-3, 0, 7, 14, 30];

/** Reminder days relative to the due date: whole numbers, -30..180, unique, sorted, 1-8 of them. */
function normalizeSchedule(v) {
  var raw = Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? DEFAULT_SCHEDULE : String(v).split(/[,;\s]+/));
  var out = [];
  raw.forEach(function (x) {
    if (x === '' || x === null || x === undefined) return;
    var n = Number(String(x).replace(/^\+/, ''));
    if (!isFinite(n) || Math.floor(n) !== n) throw new Error('Reminder days must be whole numbers, e.g. -3, 0, 7, 14, 30');
    if (n < -30 || n > 180) throw new Error('Reminder days must be between -30 and 180');
    if (out.indexOf(n) === -1) out.push(n);
  });
  if (out.length === 0) throw new Error('Add at least one reminder day');
  if (out.length > 8) throw new Error('At most 8 reminder days');
  return out.sort(function (a, b) { return a - b; });
}

function sanitizeAutoSend(a, cur) {
  a = a || {};
  cur = cur || {};
  var hour = a.sendHour === undefined || a.sendHour === '' ? (cur.sendHour === undefined ? 9 : cur.sendHour) : Number(a.sendHour);
  if (!isFinite(hour) || Math.floor(hour) !== hour || hour < 6 || hour > 18) throw new Error('Send hour must be between 6 (6am) and 18 (6pm)');
  var tz = a.timeZone || cur.timeZone || DEFAULT_TZ;
  if (!validTimeZone(tz)) throw new Error('Unknown time zone: ' + tz);
  return {
    sendOnShip: a.sendOnShip === true,
    reminders: a.reminders === true,
    schedule: normalizeSchedule(a.schedule !== undefined ? a.schedule : cur.schedule),
    sendHour: hour,
    timeZone: tz,
    statementMonthly: a.statementMonthly === true
  };
}

/**
 * Which reminder (if any) goes out TODAY for one invoice. Pure: the caller
 * passes the invoice as stored, its state, the customer, the org's settings,
 * `now` and the org's time zone.
 *
 * Rules:
 *  - nothing unless reminders are on, the invoice was sent, has a collectible
 *    balance (not paid, not void, not covered by a clearing bank transfer),
 *    is not paused, and the customer is not "do not remind" / "remind by phone";
 *  - at most one email per invoice per day - the day the invoice itself went
 *    out counts;
 *  - a step is due on (due date + step days). Friendly pre-due / due-today
 *    steps that fell on or before the day the invoice was sent are covered by
 *    the invoice email itself;
 *  - if several steps are due (reminders were off, the job missed a day, the
 *    invoice went out late), only the LATEST is sent and the earlier ones are
 *    marked skipped - never a burst of catch-up emails.
 */
function planReminder(a) {
  var s = a.settings || {};
  var inv = a.invoice || {};
  var st = a.state || {};
  var tz = a.tz || DEFAULT_TZ;
  var schedule;
  try { schedule = normalizeSchedule(s.schedule); } catch (e) { schedule = DEFAULT_SCHEDULE.slice(); }
  var today = localDay(a.now, tz);
  var done = inv.reminders || {};
  var due = st.dueDay;
  var out = { send: false, step: null, skip: [], reason: null, next: null, final: false };

  var sentDay = localDay(inv.sentAt, tz);
  var pending = schedule.filter(function (step) {
    if (done[String(step)] !== undefined) return false;
    if (due === null || due === undefined) return false;
    if (step <= 0 && sentDay !== null && due + step <= sentDay) return false;
    return true;
  });
  var dueNow = pending.filter(function (step) { return due + step <= today; });
  var later = pending.filter(function (step) { return due + step > today; });
  if (later.length) out.next = { step: later[0], date: dayToIso(due + later[0]) };

  var block = null;
  if (!s.reminders) block = 'Automatic reminders are off';
  else if (st.status === 'void') block = 'Invoice is void';
  else if (!(st.balanceCents > 0)) block = 'Paid';
  else if (!(st.collectibleCents > 0)) block = 'Payment pending (bank transfer)';
  else if (!inv.sentAt) block = 'Invoice not sent yet';
  else if (inv.remindersPaused) block = 'Reminders paused';
  else if (a.customer && a.customer.doNotRemind) block = 'Customer marked "Do not remind"';
  else if (a.customer && a.customer.remindByPhone) block = 'Customer prefers a phone call';
  else if (due === null || due === undefined) block = 'No due date';
  if (block) {
    out.reason = block;
    // Keep "next" only where it still means something to a person (a phone
    // call to make); otherwise there is no next reminder.
    if (block !== 'Customer prefers a phone call') out.next = null;
    else if (dueNow.length) out.next = { step: dueNow[dueNow.length - 1], date: dayToIso(today) };
    return out;
  }

  if (!dueNow.length) { out.reason = 'Nothing due today'; return out; }
  var lastEmailDay = [sentDay, localDay(inv.lastReminderAt, tz), localDay(inv.lastEmail && inv.lastEmail.at, tz)]
    .filter(function (d) { return d !== null; }).reduce(function (m, d) { return Math.max(m, d); }, -Infinity);
  if (lastEmailDay >= today) {
    out.reason = 'Already emailed today';
    out.next = { step: dueNow[dueNow.length - 1], date: dayToIso(today + 1) };
    return out;
  }
  out.send = true;
  out.step = dueNow[dueNow.length - 1];
  out.skip = dueNow.slice(0, -1);
  out.final = out.step === schedule[schedule.length - 1] && out.step > 0;
  out.next = later.length ? { step: later[0], date: dayToIso(due + later[0]) } : null;
  return out;
}

function prettyDate(iso) {
  var d = isoToDay(iso);
  if (d === null) return '';
  var m = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var dt = new Date(d * DAY_MS);
  return m[dt.getUTCMonth()] + ' ' + dt.getUTCDate() + ', ' + dt.getUTCFullYear();
}

// ─────────────────────────────────────────────────────── email layout ────

var SKIDSLING_URL = 'https://skidsling.com';
var SKIDSLING_GREEN = '#0d7a52';
var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The company's accent: its Stripe brand color, else SkidSling green. */
function brandColor(org) {
  return hexColor(org && org.payments && org.payments.brandColor) || SKIDSLING_GREEN;
}

/** White or near-black text, whichever reads better on `hex`. */
function textOn(hex) {
  var n = parseInt(hex.slice(1), 16);
  var lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? '#111827' : '#ffffff';
}

function safeUrl(u) { return u && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : ''; }

function emailButton(href, label, color) {
  var e = escapeHtml;
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto 8px"><tr><td style="border-radius:8px;background:' + color + '">' +
    '<a href="' + e(href) + '" style="display:inline-block;padding:14px 34px;font-family:' + FONT + ';font-size:16px;font-weight:700;color:' + textOn(color) +
    ';text-decoration:none;border-radius:8px">' + e(label) + '</a></td></tr></table>';
}

/** Big "amount due" panel. `sub` is the line under it; `alert` turns it red. */
function amountPanel(label, amount, sub, alert) {
  var e = escapeHtml;
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #eef0f3;border-radius:10px;margin:20px 0 4px">' +
    '<tr><td style="padding:20px 22px;text-align:center">' +
    '<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">' + e(label) + '</div>' +
    '<div style="font-size:34px;font-weight:800;color:#111827;margin:4px 0 2px">' + e(amount) + '</div>' +
    (sub ? '<div style="font-size:14px;color:' + (alert ? '#b91c1c;font-weight:600' : '#4b5563') + '">' + e(sub) + '</div>' : '') +
    '</td></tr></table>';
}

/** Label / value rows. rows: [label, value, strong?] (values already plain text). */
function detailRows(rows) {
  var e = escapeHtml;
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:18px 0 6px">' +
    rows.filter(Boolean).map(function (r) {
      var strong = r[2];
      var td = 'padding:9px 0;border-top:1px solid ' + (strong ? '#d1d5db' : '#f0f1f3') + ';';
      return '<tr><td style="' + td + 'color:' + (strong ? '#111827;font-weight:700' : '#6b7280') + '">' + e(r[0]) + '</td>' +
        '<td style="' + td + 'text-align:right;color:#111827' + (strong ? ';font-weight:700' : '') + '">' + e(r[1]) + '</td></tr>';
    }).join('') + '</table>';
}

/**
 * One layout for every invoicing email. The company is the sender (its logo,
 * name, brand color and contact details); SkidSling signs the footer.
 *   org, title (tab title), preheader (inbox preview line), label (top right,
 *   e.g. "Invoice"), body (HTML), sender: 'company' | 'skidsling'
 */
function emailShell(a) {
  var e = escapeHtml;
  var org = a.org || {};
  var fromSkid = a.sender === 'skidsling';
  // The company's logo/name always sits on top, even on SkidSling's own payment alerts; SkidSling signs the bottom.
  var color = brandColor(org);
  var logo = safeUrl(org.logoUrl);
  var name = org.name || (fromSkid ? 'SkidSling' : '');
  var brand = logo
    ? '<img src="' + e(logo) + '" alt="' + e(name) + '" height="' + 44 + '" style="display:block;height:' + 44 + 'px;max-width:200px;border:0">'
    : '<div style="font-size:20px;font-weight:800;color:#111827">' + e(name) + '</div>';
  var p = org.payments || {};
  var contact = [org.name, org.phone, (p.billingEmail || org.email)].filter(Boolean).map(e).join(' &nbsp;&middot;&nbsp; ');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light"><title>' + e(a.title || '') + '</title></head>' +
    '<body style="margin:0;padding:0;background:#f3f4f6;font-family:' + FONT + ';color:#1f2937">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + e(a.preheader || '') + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:32px 12px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">' +
    '<tr><td style="height:5px;background:' + color + ';font-size:0;line-height:0">&nbsp;</td></tr>' +
    '<tr><td style="padding:26px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td style="vertical-align:middle">' + brand + '</td>' +
    (a.label ? '<td style="vertical-align:middle;text-align:right;font-size:12px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;color:' + color + '">' + e(a.label) + '</td>' : '') +
    '</tr></table></td></tr>' +
    '<tr><td style="padding:22px 32px 30px;font-size:15px;line-height:1.55">' + a.body + '</td></tr>' +
    (!fromSkid && contact ? '<tr><td style="padding:16px 32px;background:#f9fafb;border-top:1px solid #eef0f3;font-size:12px;color:#6b7280;text-align:center">' + contact + '</td></tr>' : '') +
    '</table>' +
    (fromSkid ? skidSlingSignature() : skidSlingPromo(a.campaign) +
      '<div style="max-width:480px;font-size:11px;color:#9ca3af;margin-top:10px;line-height:1.5">Sent on behalf of ' + e(org.name || 'the sender') +
      '. Payments are processed by Stripe; nobody will ever ask for your card or bank details by email.</div>') +
    '</td></tr></table></body></html>';
}

var SKIDSLING_TAGLINE = 'Enterprise power. Small-business speed.';

/** skidsling.com link tagged so sign-ups from invoices show up in analytics. */
function skidSlingLink(campaign) {
  return SKIDSLING_URL + '/?utm_source=skidsling_invoice&utm_medium=email&utm_campaign=' + encodeURIComponent(campaign || 'invoice');
}

/**
 * Below every customer-facing email: the people paying invoices run
 * warehouses too. Logo, tagline, one line of pitch, the free trial.
 */
function skidSlingPromo(campaign) {
  var href = skidSlingLink(campaign);
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin-top:18px;background:#0f1f18;border-radius:12px">' +
    '<tr><td style="padding:20px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td style="width:52px;vertical-align:middle;padding-right:14px"><a href="' + href + '"><img src="' + SKIDSLING_URL + '/logo.png" alt="SkidSling" width="44" height="44" style="display:block;border:0"></a></td>' +
    '<td style="vertical-align:middle">' +
    '<div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6ee7b7">Invoicing powered by</div>' +
    '<div style="font-size:19px;font-weight:800;color:#ffffff;line-height:1.2">SkidSling <span style="font-weight:500;color:#a7f3d0;font-size:14px">&middot; ' + SKIDSLING_TAGLINE + '</span></div>' +
    '</td></tr></table>' +
    '<div style="font-size:13px;color:#d1fae5;line-height:1.55;margin-top:12px">Inventory by shelf, pick &amp; pack, shipping labels, and automated invoicing. Built for wholesalers and warehouses.</div>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px"><tr><td style="border-radius:7px;background:#34d399">' +
    '<a href="' + href + '" style="display:inline-block;padding:10px 20px;font-family:' + FONT + ';font-size:14px;font-weight:700;color:#0f1f18;text-decoration:none">Start a free 14-day trial &rarr;</a>' +
    '</td></tr></table>' +
    '</td></tr></table>';
}

/** Footer for SkidSling's own notes to a company (already a customer). */
function skidSlingSignature() {
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr>' +
    '<td style="vertical-align:middle;padding-right:8px"><a href="' + SKIDSLING_URL + '"><img src="' + SKIDSLING_URL + '/logo.png" alt="SkidSling" width="22" height="22" style="display:block;border:0"></a></td>' +
    '<td style="vertical-align:middle;font-size:12px;color:#6b7280"><a href="' + SKIDSLING_URL + '" style="color:' + SKIDSLING_GREEN + ';font-weight:700;text-decoration:none">SkidSling</a> &middot; ' + SKIDSLING_TAGLINE + '</td></tr></table>';
}

/**
 * Subject and HTML for an invoice or reminder email. Every value is escaped:
 * names, POs and notes are tenant/customer text.
 *   kind: 'invoice' | 'reminder';  step: reminder day (reminders only)
 */
function invoiceEmailContent(a) {
  var o = a.order || {};
  var org = a.org || {};
  var st = a.state || {};
  var e = escapeHtml;
  var num = o.poNumber || (o.invoice && o.invoice.number) || '';
  var orgName = org.name || 'us';
  var amount = formatCents(st.collectibleCents > 0 ? st.collectibleCents : st.balanceCents);
  var dueText = st.dueDate ? prettyDate(st.dueDate) : '';
  var who = o.customerAttention || o.customerContact || o.customerName || 'there';
  var poText = o.customerPO ? ' (your PO ' + o.customerPO + ')' : '';
  var subject, lead;
  if (a.kind === 'invoice') {
    subject = 'Invoice ' + num + ' from ' + orgName + ' - ' + amount + (dueText ? ' due ' + dueText : '');
    lead = 'Thank you for your order. Your invoice ' + num + poText + ' for ' + amount + ' is attached' +
      (st.daysOverdue > 0 ? ' and was due on ' + dueText + '.' : (dueText ? ' and is due on ' + dueText + '.' : '.'));
  } else if (a.step < 0) {
    subject = 'Reminder: invoice ' + num + ' is due ' + dueText + ' (' + amount + ')';
    lead = 'A friendly reminder that invoice ' + num + poText + ' for ' + amount + ' is coming due on ' + dueText + '.';
  } else if (a.step === 0) {
    subject = 'Invoice ' + num + ' is due today (' + amount + ')';
    lead = 'Invoice ' + num + poText + ' for ' + amount + ' is due today.';
  } else if (a.final) {
    subject = 'Final notice: invoice ' + num + ' is ' + st.daysOverdue + ' days past due';
    lead = 'Invoice ' + num + poText + ' for ' + amount + ' is now ' + st.daysOverdue + ' days past due (it was due on ' + dueText +
      '). Please arrange payment right away, or reply to this email if there is a problem with the invoice.';
  } else {
    subject = 'Overdue: invoice ' + num + ' (' + amount + ', ' + st.daysOverdue + ' days past due)';
    lead = 'Our records show invoice ' + num + poText + ' for ' + amount + ' was due on ' + dueText +
      ' and is now ' + st.daysOverdue + ' days past due. If you have already sent payment, thank you - please disregard this note.';
  }
  var payUrl = safeUrl(a.payUrl);
  var color = brandColor(org);
  var overdue = st.daysOverdue > 0;
  var sub = overdue ? st.daysOverdue + ' day' + (st.daysOverdue === 1 ? '' : 's') + ' past due' + (dueText ? ' (due ' + dueText + ')' : '')
    : (dueText ? 'Due ' + dueText : '');
  var label = a.kind === 'invoice' ? 'Invoice' : (a.final ? 'Final notice' : (overdue ? 'Past due' : 'Reminder'));
  var body =
    '<p style="margin:0 0 12px">Hello ' + e(who) + ',</p>' +
    '<p style="margin:0">' + e(lead) + '</p>' +
    amountPanel(st.paidCents > 0 ? 'Balance due' : 'Amount due', amount, sub, overdue) +
    (payUrl ? emailButton(payUrl, 'Pay ' + amount + ' online', color) +
      '<div style="text-align:center;font-size:12px;color:#6b7280">Card or bank transfer (ACH) &middot; secured by Stripe</div>' : '') +
    detailRows([
      ['Invoice', num],
      o.customerPO ? ['Your PO', o.customerPO] : null,
      ['Invoice total', formatCents(st.totalCents)],
      st.paidCents > 0 ? ['Paid so far', formatCents(st.paidCents)] : null,
      ['Balance due', formatCents(st.balanceCents), true]
    ]) +
    '<p style="margin:18px 0 0;font-size:14px;color:#4b5563">The invoice PDF is attached. Questions about it? Just reply to this email.</p>' +
    '<p style="margin:16px 0 0;font-size:14px">Thank you,<br><strong>' + e(org.name || '') + '</strong></p>';
  var html = emailShell({ org: org, title: subject, label: label, body: body, campaign: a.kind === 'invoice' ? 'invoice' : 'reminder',
    preheader: (payUrl ? 'Pay ' + amount + ' online' : amount + ' due') + (sub ? ' - ' + sub : '') + '. Invoice ' + num + ' from ' + orgName + '.' });
  return { subject: subject, html: html };
}

// ─────────────────────────────────────── statements & collections ────

/** Oldest first: by due date, then invoice date, then number. */
function oldestFirst(a, b) {
  var ad = a.dueDay === null || a.dueDay === undefined ? Infinity : a.dueDay;
  var bd = b.dueDay === null || b.dueDay === undefined ? Infinity : b.dueDay;
  if (ad !== bd) return ad - bd;
  var ai = a.issueDay === null || a.issueDay === undefined ? Infinity : a.issueDay;
  var bi = b.issueDay === null || b.issueDay === undefined ? Infinity : b.issueDay;
  if (ai !== bi) return ai - bi;
  return String(a.orderNumber || '').localeCompare(String(b.orderNumber || ''));
}

/**
 * Split one statement payment across a customer's open invoices, oldest
 * first. Each invoice takes at most what is still collectible on it; anything
 * left over is unallocated credit (never silently put on an invoice).
 */
function allocateOldestFirst(invoices, amountCents) {
  var left = Math.max(0, Math.round(Number(amountCents) || 0));
  var allocations = [];
  (invoices || []).slice().sort(oldestFirst).forEach(function (inv) {
    if (left <= 0) return;
    var owe = Math.max(0, Math.round(Number(inv.collectibleCents !== undefined ? inv.collectibleCents : inv.balanceCents) || 0));
    if (owe <= 0) return;
    var take = Math.min(owe, left);
    allocations.push({ orderId: inv.orderId, orderNumber: inv.orderNumber || '', cents: take });
    left -= take;
  });
  return { allocations: allocations, unallocatedCents: left };
}

/** One statement line from an order (null if nothing is owed on it). */
function statementLine(orderId, o, today, tz) {
  var st = invoiceState(o, null, today, tz);
  if (!st.issued || st.status === 'void' || st.balanceCents <= 0) return null;
  return {
    orderId: orderId, orderNumber: o.poNumber || '', customerPO: o.customerPO || '',
    issueDay: invoiceIssueDay(o, tz), dueDay: st.dueDay, dueDate: st.dueDate,
    totalCents: st.totalCents, paidCents: st.paidCents, balanceCents: st.balanceCents, pendingCents: st.pendingCents,
    collectibleCents: st.collectibleCents, daysOverdue: st.daysOverdue, status: st.status,
    payUrl: (o.invoice && o.invoice.payUrl) || null
  };
}

/**
 * The Collections view: every open invoice grouped by customer, aged into
 * current / 1-30 / 31-60 / 61-90 / 90+, with the last and next reminder.
 * `orders` are {id, data}; `customers` is a map id -> customer.
 */
function collectionsReport(orders, customers, opts) {
  opts = opts || {};
  var tz = opts.tz || DEFAULT_TZ;
  var today = localDay(opts.now, tz);
  var settings = opts.settings || {};
  var groups = {};
  var totals = { totalCents: 0, invoices: 0 };
  AGING_BUCKETS.forEach(function (b) { totals[b] = 0; });
  var zeroTotalShipped = [];
  (orders || []).forEach(function (row) {
    var o = row.data || {};
    var st = invoiceState(o, null, today, tz);
    if (st.issued && st.zeroTotal && st.status !== 'void' && !st.manualPaid) zeroTotalShipped.push(o.poNumber || row.id);
    if (!st.issued || st.status === 'void' || st.balanceCents <= 0) return;
    var cust = (o.customerId && customers && customers[o.customerId]) || null;
    var key = o.customerId && cust ? 'id:' + o.customerId : 'name:' + String(o.customerName || '(no customer)').trim().toLowerCase();
    var g = groups[key];
    if (!g) {
      g = groups[key] = {
        key: key, customerId: cust ? o.customerId : null,
        customerName: cust ? (cust.company || cust.customerName || o.customerName || '') : (o.customerName || '(no customer)'),
        doNotRemind: !!(cust && cust.doNotRemind), remindByPhone: !!(cust && cust.remindByPhone),
        billingEmails: cust ? emailList(cust.billingEmails && cust.billingEmails.length ? cust.billingEmails : cust.email) : emailList(o.customerEmail),
        totalCents: 0, collectibleCents: 0, pendingCents: 0, oldestDaysOverdue: 0, invoices: []
      };
      AGING_BUCKETS.forEach(function (b) { g[b] = 0; });
    }
    var inv = o.invoice || {};
    var bucket = agingBucket(st.daysOverdue);
    var plan = planReminder({ settings: settings, invoice: inv, state: st, customer: cust, now: opts.now, tz: tz });
    g.invoices.push({
      orderId: row.id, orderNumber: o.poNumber || '', customerPO: o.customerPO || '',
      status: st.status, totalCents: st.totalCents, paidCents: st.paidCents, balanceCents: st.balanceCents,
      pendingCents: st.pendingCents, collectibleCents: st.collectibleCents, dueDate: st.dueDate, daysOverdue: st.daysOverdue,
      bucket: bucket, sentAt: inv.sentAt || null, lastReminderAt: inv.lastReminderAt || null, reminderCount: inv.reminderCount || 0,
      remindersPaused: !!inv.remindersPaused, nextReminder: plan.send ? { step: plan.step, date: dayToIso(today) } : plan.next,
      reminderNote: plan.send ? null : plan.reason, disputed: !!inv.disputed
    });
    g[bucket] += st.balanceCents;
    g.totalCents += st.balanceCents;
    g.collectibleCents += st.collectibleCents;
    g.pendingCents += st.pendingCents;
    g.oldestDaysOverdue = Math.max(g.oldestDaysOverdue, st.daysOverdue);
    totals[bucket] += st.balanceCents;
    totals.totalCents += st.balanceCents;
    totals.invoices++;
  });
  var list = Object.keys(groups).map(function (k) {
    groups[k].invoices.sort(function (a, b) { return b.daysOverdue - a.daysOverdue; });
    return groups[k];
  });
  list.sort(function (a, b) { return (b.oldestDaysOverdue - a.oldestDaysOverdue) || (b.totalCents - a.totalCents); });
  return { today: dayToIso(today), totals: totals, customers: list, zeroTotalShipped: zeroTotalShipped };
}

/** Statement email: every open invoice for one customer, one pay link for the total. */
function statementEmailContent(a) {
  var e = escapeHtml;
  var org = a.org || {};
  var c = a.customer || {};
  var s = a.statement || { invoices: [] };
  var who = c.customerName || c.company || 'there';
  var total = formatCents(s.collectibleCents);
  var overdue = s.invoices.filter(function (x) { return x.daysOverdue > 0; }).length;
  var subject = 'Statement from ' + (org.name || 'us') + ': ' + s.invoices.length + ' open invoice' + (s.invoices.length === 1 ? '' : 's') +
    ', ' + total + (overdue ? ' (' + overdue + ' past due)' : '');
  var payUrl = safeUrl(a.payUrl);
  var cell = 'padding:10px 0;border-top:1px solid #f0f1f3;vertical-align:top;';
  var rows = s.invoices.map(function (x) {
    return '<tr><td style="' + cell + '">' + e(x.orderNumber) + (x.customerPO ? '<br><span style="color:#6b7280;font-size:12px">PO ' + e(x.customerPO) + '</span>' : '') + '</td>' +
      '<td style="' + cell + '">' + e(prettyDate(x.dueDate)) + (x.daysOverdue > 0 ? '<br><span style="color:#b91c1c;font-size:12px;font-weight:600">' + x.daysOverdue + ' days past due</span>' : '') + '</td>' +
      '<td style="' + cell + 'text-align:right">' + e(formatCents(x.balanceCents)) + (x.pendingCents > 0 ? '<br><span style="color:#b45309;font-size:12px">' + e(formatCents(x.pendingCents)) + ' clearing</span>' : '') + '</td></tr>';
  }).join('');
  var count = s.invoices.length + ' open invoice' + (s.invoices.length === 1 ? '' : 's');
  var body =
    '<p style="margin:0 0 12px">Hello ' + e(who) + ',</p>' +
    '<p style="margin:0">Here is a statement of your open invoices with ' + e(org.name || 'us') + '.</p>' +
    amountPanel('Total due', total, count + (overdue ? ' · ' + overdue + ' past due' : ''), overdue > 0) +
    (payUrl ? emailButton(payUrl, 'Pay ' + total + ' online', brandColor(org)) +
      '<div style="text-align:center;font-size:12px;color:#6b7280">One payment covers every invoice below, oldest first &middot; secured by Stripe</div>' : '') +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:20px 0 6px">' +
    '<tr style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280"><td style="padding-bottom:6px">Invoice</td><td style="padding-bottom:6px">Due</td><td style="padding-bottom:6px;text-align:right">Balance</td></tr>' +
    rows + '<tr><td colspan="2" style="padding:10px 0;font-weight:700;border-top:1px solid #d1d5db">Total due</td><td style="padding:10px 0;text-align:right;font-weight:700;border-top:1px solid #d1d5db">' + e(total) + '</td></tr></table>' +
    '<p style="margin:18px 0 0;font-size:14px;color:#4b5563">Questions, or already paid? Just reply to this email.</p>' +
    '<p style="margin:16px 0 0;font-size:14px">Thank you,<br><strong>' + e(org.name || '') + '</strong></p>';
  var html = emailShell({ org: org, title: subject, label: 'Statement', body: body, campaign: 'statement',
    preheader: total + ' across ' + count + (overdue ? ', ' + overdue + ' past due' : '') + '.' });
  return { subject: subject, html: html };
}

/**
 * The note to the COMPANY when a payment event happens (never the customer).
 * SkidSling is the sender here. kind: PAYMENT_RECEIVED | PAYMENT_PENDING |
 * PAYMENT_FAILED | PAYMENT_REFUNDED | PAYMENT_DISPUTED
 */
function paymentNoticeContent(a) {
  var e = escapeHtml;
  var org = a.org || {};
  var looks = {
    PAYMENT_RECEIVED: ['Payment received', '#0d7a52'], PAYMENT_PENDING: ['Payment on the way', '#b45309'],
    PAYMENT_FAILED: ['Payment failed', '#b91c1c'], PAYMENT_REFUNDED: ['Refund', '#4b5563'], PAYMENT_DISPUTED: ['Dispute opened', '#b91c1c']
  }[a.kind] || ['Payment update', '#4b5563'];
  var link = safeUrl(a.appBaseUrl) ? a.appBaseUrl.replace(/\/+$/, '') + '/collections' : '';
  var body =
    '<div style="display:inline-block;padding:4px 10px;border-radius:999px;background:' + looks[1] + '1a;color:' + looks[1] + ';font-size:12px;font-weight:700">' + e(looks[0]) + '</div>' +
    (a.amount ? amountPanel(a.label || 'Payment', a.amount, a.method ? 'by ' + a.method : '', a.kind === 'PAYMENT_FAILED' || a.kind === 'PAYMENT_DISPUTED') : '') +
    (a.from || a.payerEmail ? '<p style="margin:14px 0 0;font-size:14px;color:#4b5563">From <strong style="color:#111827">' + e(a.from || a.payerEmail) + '</strong>' +
      (a.from && a.payerEmail ? ' &middot; ' + e(a.payerEmail) : '') + '</p>' : '') +
    '<p style="margin:14px 0 0">' + e(a.text) + '.</p>' +
    (link ? emailButton(link, 'Open Collections', SKIDSLING_GREEN) : '') +
    '<p style="margin:18px 0 0;font-size:12px;color:#9ca3af">For ' + e(org.name || 'your company') +
    '. You get these because "Email the billing address when a payment arrives" is on in Settings &gt; Payments.</p>';
  return { subject: a.text, html: emailShell({ org: org, sender: 'skidsling', title: a.text, label: 'Payments', body: body, preheader: a.text }) };
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
  escapeHtml: escapeHtml,
  emailList: emailList,
  sanitizePaymentSettings: sanitizePaymentSettings,
  // money & dates
  toCents: toCents,
  centsToDollars: centsToDollars,
  formatCents: formatCents,
  invoiceTotalCents: invoiceTotalCents,
  DEFAULT_TZ: DEFAULT_TZ,
  isoToDay: isoToDay,
  dayToIso: dayToIso,
  localDay: localDay,
  localHour: localHour,
  anyToDay: anyToDay,
  validTimeZone: validTimeZone,
  termsDays: termsDays,
  invoiceIssueDay: invoiceIssueDay,
  invoiceDueDay: invoiceDueDay,
  // ledger & status
  paymentStatus: paymentStatus,
  paymentAllocations: paymentAllocations,
  paymentShare: paymentShare,
  orderLedger: orderLedger,
  invoiceState: invoiceState,
  INVOICE_STATUSES: INVOICE_STATUSES,
  OPEN_INVOICE_STATUSES: OPEN_INVOICE_STATUSES,
  // pay links & checkout
  signPayToken: signPayToken,
  verifyPayToken: verifyPayToken,
  invoicePayUrl: invoicePayUrl,
  statementPayUrl: statementPayUrl,
  hexColor: hexColor,
  paymentNoticeContent: paymentNoticeContent,
  cardSurchargeCents: cardSurchargeCents,
  paymentOptions: paymentOptions,
  invoiceLineName: invoiceLineName,
  buildCheckoutParams: buildCheckoutParams,
  // webhook facts
  PAYMENT_EVENT_TYPES: PAYMENT_EVENT_TYPES,
  paymentFactsFromEvent: paymentFactsFromEvent,
  paymentMetaFromStripe: metaFrom,
  mergePaymentFacts: mergePaymentFacts,
  paymentTransition: paymentTransition,
  agingBucket: agingBucket,
  AGING_BUCKETS: AGING_BUCKETS,
  // automatic collections
  DEFAULT_SCHEDULE: DEFAULT_SCHEDULE,
  normalizeSchedule: normalizeSchedule,
  sanitizeAutoSend: sanitizeAutoSend,
  planReminder: planReminder,
  prettyDate: prettyDate,
  invoiceEmailContent: invoiceEmailContent,
  // statements & collections
  oldestFirst: oldestFirst,
  allocateOldestFirst: allocateOldestFirst,
  statementLine: statementLine,
  collectionsReport: collectionsReport,
  statementEmailContent: statementEmailContent
};
