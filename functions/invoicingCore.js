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
    timeZone: tz
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
  var payUrl = a.payUrl && /^https?:\/\/[^\s"'<>]+$/.test(a.payUrl) ? a.payUrl : '';
  var row = function (k, v, strong) {
    var st2 = 'padding:' + (strong ? '8px' : '4px') + ' 0;' + (strong ? 'font-weight:700;border-top:2px solid #222;' : '');
    return '<tr><td style="' + st2 + (strong ? '' : 'color:#555') + '">' + e(k) + '</td><td style="' + st2 + 'text-align:right">' + e(v) + '</td></tr>';
  };
  var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + e(subject) + '</title></head>' +
    '<body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;background:#f5f5f5;margin:0;padding:0;color:#222">' +
    '<div style="max-width:560px;margin:30px auto;background:#fff;border-radius:8px;padding:28px">' +
    '<div style="font-size:18px;font-weight:700;margin-bottom:18px">' + e(org.name || '') + '</div>' +
    '<p>Hello ' + e(who) + ',</p><p>' + e(lead) + '</p>' +
    '<table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:15px">' +
    row('Invoice', num) +
    (o.customerPO ? row('Your PO', o.customerPO) : '') +
    row('Invoice total', formatCents(st.totalCents)) +
    (st.paidCents > 0 ? row('Paid so far', formatCents(st.paidCents)) : '') +
    row('Balance due', formatCents(st.balanceCents), true) +
    (dueText ? row('Due date', dueText) : '') +
    '</table>' +
    (payUrl ? '<div style="text-align:center;margin:26px 0"><a href="' + e(payUrl) + '" style="display:inline-block;background:#0d7a52;color:#fff;text-decoration:none;padding:14px 30px;border-radius:6px;font-weight:700;font-size:16px">Pay ' + e(amount) + ' online</a>' +
      '<div style="font-size:12px;color:#777;margin-top:8px">Bank transfer (ACH) or card, processed securely by Stripe.</div></div>' : '') +
    '<p style="font-size:14px;color:#555">The invoice is attached as a PDF. Questions about it? Just reply to this email.</p>' +
    '<p style="font-size:14px">Thank you,<br>' + e(org.name || '') + (org.phone ? '<br>' + e(org.phone) : '') + '</p>' +
    '</div><div style="text-align:center;font-size:11px;color:#999;margin-bottom:30px">Sent by SkidSling on behalf of ' + e(org.name || '') + '</div>' +
    '</body></html>';
  return { subject: subject, html: html };
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
  invoiceEmailContent: invoiceEmailContent
};
