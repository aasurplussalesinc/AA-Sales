// Phase 3: Stripe webhooks -> payments ledger -> order status. This is what
// ends the manual chasing, so it is pinned hard: Stripe-shaped fixture events
// go through the real signature check (stripe SDK, local HMAC) and the real
// handler against an in-memory Firestore. Replays change nothing; any delivery
// order converges on the same state; an ACH failure puts the balance back;
// refunds reduce what was paid; nothing crosses tenants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../../functions/invoicingCore.js');
const { build } = require('./_fakes/invoicingHarness.cjs');

const ACCT = 'acct_acme_test';
const T0 = 1790000000;                      // event.created, seconds
function seed(extra = {}) {
  return Object.assign({
    'organizations/acme': { name: 'Acme Surplus', email: 'office@acme.test',
      payments: { enabled: true, stripeAccountId: ACCT, mode: 'test', connected: true, chargesEnabled: true, detailsSubmitted: true,
        billingEmail: 'ar@acme.test', notifyOnPayment: true } },
    'organizations/victim': { name: 'Victim', payments: { enabled: true, stripeAccountId: 'acct_victim' } },
    'stripeAccounts/acct_acme_test': { orgId: 'acme' },
    'stripeAccounts/acct_victim': { orgId: 'victim' },
    'orgMembers/acme_dave': { orgId: 'acme', userId: 'dave', role: 'manager', status: 'active' },
    'purchaseOrders/o1': { orgId: 'acme', poNumber: 'AA6676', customerPO: 'KB-15317', customerId: 'c1', customerName: 'Buyer LLC',
      status: 'shipped', terms: 'Net 30', invoiceDate: '2026-09-20', shipping: 0, tax: 0,
      items: [{ qtyShipped: 12, unitPrice: 100 }], invoice: { issuedAt: 1, sentAt: 2, linkNonce: 'n1', number: 'AA6676' } },
    'purchaseOrders/v1': { orgId: 'victim', poNumber: 'V1', status: 'shipped', items: [{ qtyShipped: 1, unitPrice: 999 }] }
  }, extra);
}
const TOTAL = 120000;
const meta = (over = {}) => ({ skidsling: 'invoice-payment', kind: 'invoice', orgId: 'acme', orderId: 'o1', orderNumber: 'AA6676', customerId: 'c1', surchargeCents: '0', ...over });

let n = 0;
const ev = (type, object, dt = 0, over = {}) => ({ id: 'evt_' + type.replace(/\W/g, '_') + '_' + (++n), object: 'event', type,
  account: ACCT, livemode: false, created: T0 + dt, data: { object }, ...over });

// Stripe-shaped objects
const session = (pi, amount, paymentStatus, m = meta()) => ({ id: 'cs_test_' + pi, object: 'checkout.session', mode: 'payment',
  payment_intent: pi, amount_total: amount, payment_status: paymentStatus, metadata: m, customer_details: { email: 'AP@buyer.test' } });
const intent = (pi, amount, m = meta(), extra = {}) => ({ id: pi, object: 'payment_intent', amount, amount_received: amount,
  metadata: m, latest_charge: 'ch_' + pi, payment_method_types: ['card', 'us_bank_account'], ...extra });
const charge = (pi, amount, refunded) => ({ id: 'ch_' + pi, object: 'charge', payment_intent: pi, amount, amount_refunded: refunded,
  metadata: {}, payment_method_details: { type: 'card' } });

function withCharge(h, pi, amount, type = 'card') {
  h.stripe.charges._store['ch_' + pi] = { id: 'ch_' + pi, payment_method_details: { type },
    balance_transaction: { id: 'txn_' + pi, fee: Math.round(amount * 0.029) + 30, net: amount - (Math.round(amount * 0.029) + 30) } };
}
const order = (h) => h.db.data('purchaseOrders/o1');
const acts = (h, action) => Object.keys(h.db.store).filter(k => k.startsWith('activityLog/')).map(k => h.db.store[k]).filter(a => a.action === action);

// ---- pure: facts & merge ---------------------------------------------------------

test('facts: a card checkout is paid now; a bank checkout completes unpaid (pending)', () => {
  const card = C.paymentFactsFromEvent(ev('checkout.session.completed', session('pi_1', 5000, 'paid')));
  assert.equal(card.paymentIntentId, 'pi_1');
  assert.ok(card.set.succeededAt);
  const bank = C.paymentFactsFromEvent(ev('checkout.session.completed', session('pi_2', 5000, 'unpaid')));
  assert.equal(bank.set.succeededAt, undefined);
  assert.ok(bank.set.pendingAt);
  assert.equal(bank.set.methodGuess, 'ach');
});

test('facts: events that are not SkidSling invoice payments are ignored', () => {
  assert.equal(C.paymentFactsFromEvent(ev('checkout.session.completed', session('pi_x', 5000, 'paid', { some: 'shop order' }))), null);
  assert.equal(C.paymentFactsFromEvent(ev('checkout.session.completed', { ...session('pi_x', 1, 'paid'), mode: 'subscription' })), null);
  assert.equal(C.paymentFactsFromEvent(ev('invoice.paid', {})), null);
  assert.equal(C.paymentFactsFromEvent(ev('payment_intent.succeeded', intent('pi_x', 5, {}))), null);
});

function permutations(a) {
  if (a.length <= 1) return [a];
  return a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
}
function reduceAll(events) {
  let row = null;
  for (const e of events) {
    const f = C.paymentFactsFromEvent(e);
    row = C.mergePaymentFacts(row, f, f.meta || (row && { orgId: row.orgId, kind: row.kind, orderId: row.orderId }));
  }
  return row;
}

test('merge: every delivery order of the same events gives the same payment row', () => {
  const evs = [
    ev('checkout.session.completed', session('pi_3', 70000, 'unpaid'), 0),
    ev('payment_intent.processing', intent('pi_3', 70000, meta(), { payment_method_types: ['us_bank_account'] }), 1),
    ev('payment_intent.succeeded', intent('pi_3', 70000, meta(), { payment_method_types: ['us_bank_account'] }), 300000),
    ev('charge.refunded', { ...charge('pi_3', 70000, 20000), metadata: meta(), payment_method_details: { type: 'us_bank_account' } }, 400000)
  ];
  const want = reduceAll(evs);
  for (const p of permutations(evs)) assert.deepStrictEqual(reduceAll(p), want);
  const row = want;
  assert.equal(row.status, 'partially_refunded');
  assert.equal(row.method, 'ach');
  assert.equal(row.amountCents, 70000);
  assert.equal(row.refundedCents, 20000);
});

test('merge: replaying an event is a no-op', () => {
  const e = ev('payment_intent.succeeded', intent('pi_4', 1000));
  const once = reduceAll([e]);
  assert.deepEqual(reduceAll([e, e, e]), once);
});

test('merge: a declined card then a good one is a payment, in either order', () => {
  const fail = ev('payment_intent.payment_failed', intent('pi_5', 1000, meta(), { last_payment_error: { message: 'Your card was declined.' } }), 0);
  const ok = ev('payment_intent.succeeded', intent('pi_5', 1000), 60);
  assert.equal(reduceAll([fail, ok]).status, 'succeeded');
  assert.equal(reduceAll([ok, fail]).status, 'succeeded');
});

test('merge: a card surcharge is not credited against the invoice', () => {
  const m = meta({ surchargeCents: '300' });
  const row = reduceAll([ev('checkout.session.completed', session('pi_6', 10300, 'paid', m))]);
  assert.equal(row.grossCents, 10300);
  assert.equal(row.amountCents, 10000);
  assert.equal(row.surchargeCents, 300);
});

// ---- end to end through the webhook endpoint -----------------------------------------

test('card: checkout + payment_intent.succeeded -> order Paid, fee recorded, company told', async () => {
  const h = build({ seed: seed() });
  withCharge(h, 'pi_c1', TOTAL);
  const r1 = await h.deliver(ev('checkout.session.completed', session('pi_c1', TOTAL, 'paid')));
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.body.outcome, 'payment:succeeded');
  await h.deliver(ev('payment_intent.succeeded', intent('pi_c1', TOTAL), 2));
  const o = order(h);
  assert.equal(o.status, 'paid');
  assert.equal(o.paymentMethod, 'credit_card');
  assert.equal(o.balanceDueCents, 0);
  assert.equal(o.invoice.status, 'paid');
  const p = h.db.data('payments/stripe_pi_c1');
  assert.equal(p.orgId, 'acme');
  assert.equal(p.method, 'card');
  assert.equal(p.feeCents, Math.round(TOTAL * 0.029) + 30);
  assert.equal(p.netCents, TOTAL - p.feeCents);
  assert.equal(p.stripe.accountId, ACCT);
  const lookups = h.stripe.calls.filter(c => c.fn === 'charges.retrieve');
  assert.deepEqual(lookups[0].opts, { stripeAccount: ACCT }, 'Stripe calls go to the connected account');
  assert.equal(acts(h, 'PAYMENT_RECEIVED').length, 1, 'one notification, not one per event');
  assert.match(acts(h, 'PAYMENT_RECEIVED')[0].details.message, /AA6676 paid \$1,200\.00 by card/);
  assert.equal(h.emails.length, 1);
  assert.deepEqual(h.emails[0].to, ['ar@acme.test'], 'the company, never the customer');
});

test('replaying every event (Stripe retries) changes nothing', async () => {
  const h = build({ seed: seed() });
  withCharge(h, 'pi_r', TOTAL);
  const evs = [ev('checkout.session.completed', session('pi_r', TOTAL, 'paid')), ev('payment_intent.succeeded', intent('pi_r', TOTAL), 1)];
  for (const e of evs) await h.deliver(e);
  const snapshot = JSON.stringify(h.db.store);
  for (const e of evs) {
    const r = await h.deliver(e);
    assert.equal(r.body.outcome, 'duplicate');
  }
  assert.equal(JSON.stringify(h.db.store), snapshot);
});

test('the same payment delivered in reverse order ends in the same order state', async () => {
  const mk = () => [
    ev('checkout.session.completed', session('pi_o', 50000, 'unpaid'), 0),
    ev('payment_intent.processing', intent('pi_o', 50000, meta(), { payment_method_types: ['us_bank_account'] }), 1),
    ev('payment_intent.succeeded', intent('pi_o', 50000, meta(), { payment_method_types: ['us_bank_account'] }), 400000)
  ];
  const a = build({ seed: seed() }); withCharge(a, 'pi_o', 50000, 'us_bank_account');
  const b = build({ seed: seed() }); withCharge(b, 'pi_o', 50000, 'us_bank_account');
  for (const e of mk()) await a.deliver(e);
  for (const e of mk().reverse()) await b.deliver(e);
  const pick = (h) => { const o = order(h); return [o.amountPaidCents, o.balanceDueCents, o.pendingCents, o.invoice.status, o.status]; };
  assert.deepEqual(pick(a), pick(b));
  assert.deepEqual(pick(a), [50000, TOTAL - 50000, 0, 'partially_paid', 'shipped']);
  const strip = (p) => { const { feeCents, netCents, ...rest } = p; return rest; };
  assert.deepEqual(strip(a.db.data('payments/stripe_pi_o')), strip(b.db.data('payments/stripe_pi_o')));
});

test('ACH: pending shows as pending; a failure days later restores the balance', async () => {
  const h = build({ seed: seed() });
  await h.deliver(ev('checkout.session.completed', session('pi_a', 60000, 'unpaid')));
  let o = order(h);
  assert.equal(o.pendingCents, 60000);
  assert.equal(o.balanceDueCents, TOTAL, 'pending money is not paid money');
  assert.equal(o.invoice.paymentPending, true);
  assert.equal(o.status, 'shipped');
  assert.equal(acts(h, 'PAYMENT_PENDING').length, 1);

  await h.deliver(ev('payment_intent.payment_failed', intent('pi_a', 60000, meta(), {
    payment_method_types: ['us_bank_account'], last_payment_error: { code: 'insufficient_funds', message: 'Insufficient funds' } }), 4 * 86400));
  o = order(h);
  assert.equal(o.pendingCents, 0);
  assert.equal(o.balanceDueCents, TOTAL);
  assert.equal(o.invoice.paymentPending, false);
  assert.equal(h.db.data('payments/stripe_pi_a').status, 'failed');
  const failed = acts(h, 'PAYMENT_FAILED');
  assert.equal(failed.length, 1);
  assert.match(failed[0].details.message, /FAILED \(Insufficient funds\) - the balance is due again/);
});

test('ACH half now, card for the rest: partially paid, then paid', async () => {
  const h = build({ seed: seed() });
  withCharge(h, 'pi_h1', 60000, 'us_bank_account');
  withCharge(h, 'pi_h2', 60000);
  await h.deliver(ev('checkout.session.completed', session('pi_h1', 60000, 'unpaid')));
  await h.deliver(ev('checkout.session.async_payment_succeeded', session('pi_h1', 60000, 'paid'), 300000));
  assert.equal(order(h).invoice.status, 'partially_paid');
  assert.equal(order(h).balanceDueCents, 60000);
  await h.deliver(ev('checkout.session.completed', session('pi_h2', 60000, 'paid'), 300100));
  assert.equal(order(h).invoice.status, 'paid');
  assert.equal(order(h).status, 'paid');
});

test('refund: amountPaid drops, the order goes back to shipped, the company is told', async () => {
  const h = build({ seed: seed() });
  withCharge(h, 'pi_f', TOTAL);
  await h.deliver(ev('checkout.session.completed', session('pi_f', TOTAL, 'paid')));
  assert.equal(order(h).status, 'paid');
  await h.deliver(ev('charge.refunded', charge('pi_f', TOTAL, 30000), 100));
  const o = order(h);
  assert.equal(o.amountPaidCents, TOTAL - 30000);
  assert.equal(o.balanceDueCents, 30000);
  assert.equal(o.status, 'shipped');
  assert.equal(acts(h, 'PAYMENT_REFUNDED').length, 1);
});

test('a refund that arrives before anything else is resolved through Stripe, not guessed', async () => {
  const h = build({ seed: seed() });
  h.stripe.paymentIntents._store.pi_early = intent('pi_early', TOTAL);
  const r = await h.deliver(ev('charge.refunded', charge('pi_early', TOTAL, TOTAL)));
  assert.equal(r.body.outcome, 'payment:pending');
  assert.deepEqual(h.stripe.calls.find(c => c.fn === 'paymentIntents.retrieve').opts, { stripeAccount: ACCT });
  await h.deliver(ev('payment_intent.succeeded', intent('pi_early', TOTAL), -10));
  assert.equal(h.db.data('payments/stripe_pi_early').status, 'refunded');
  assert.equal(order(h).balanceDueCents, TOTAL);
});

test('dispute: flagged on the payment and the invoice; a lost dispute takes the money back', async () => {
  const h = build({ seed: seed() });
  withCharge(h, 'pi_d', TOTAL);
  await h.deliver(ev('checkout.session.completed', session('pi_d', TOTAL, 'paid')));
  await h.deliver(ev('charge.dispute.created', { id: 'dp_1', object: 'dispute', charge: 'ch_pi_d', payment_intent: 'pi_d', amount: TOTAL, status: 'needs_response' }, 10));
  assert.equal(h.db.data('payments/stripe_pi_d').disputed, true);
  assert.equal(order(h).invoice.disputed, true);
  assert.equal(acts(h, 'PAYMENT_DISPUTED').length, 1);
  await h.deliver(ev('charge.dispute.closed', { id: 'dp_1', object: 'dispute', charge: 'ch_pi_d', payment_intent: 'pi_d', amount: TOTAL, status: 'lost' }, 20));
  assert.equal(order(h).balanceDueCents, TOTAL);
});

test('tenant isolation: metadata naming another org, or another org\'s order, is ignored', async () => {
  const h = build({ seed: seed() });
  const before = JSON.stringify(h.db.store);
  const r1 = await h.deliver(ev('checkout.session.completed', session('pi_t1', 5000, 'paid', meta({ orgId: 'victim', orderId: 'v1' }))));
  assert.equal(r1.body.outcome, 'ignored:org-mismatch');
  const r2 = await h.deliver(ev('checkout.session.completed', session('pi_t2', 5000, 'paid', meta({ orderId: 'v1' }))));
  assert.equal(r2.body.outcome, 'ignored:unknown-order');
  const r3 = await h.deliver(ev('checkout.session.completed', session('pi_t3', 5000, 'paid'), 0, { account: 'acct_nobody' }));
  assert.equal(r3.body.outcome, 'ignored:unknown-account');
  // Only the idempotency records were written.
  const changed = Object.keys(h.db.store).filter(k => !k.startsWith('stripeEvents/') && JSON.stringify(h.db.store[k]) !== JSON.stringify(JSON.parse(before)[k]));
  assert.deepEqual(changed, []);
  assert.equal(h.db.data('purchaseOrders/v1').amountPaidCents, undefined);
});

test('a company\'s own unrelated Stripe sales on the same account are ignored', async () => {
  const h = build({ seed: seed() });
  const r = await h.deliver(ev('payment_intent.succeeded', intent('pi_shop', 999, { order: 'web-123' })));
  assert.equal(r.body.outcome, 'ignored:not-an-invoice-payment');
  assert.equal(h.db.data('payments/stripe_pi_shop'), undefined);
});

test('no payment email when the company has not turned notifications on', async () => {
  const s = seed();
  s['organizations/acme'].payments.notifyOnPayment = false;
  const h = build({ seed: s });
  await h.deliver(ev('checkout.session.completed', session('pi_q', TOTAL, 'paid')));
  assert.equal(h.emails.length, 0);
  assert.equal(acts(h, 'PAYMENT_RECEIVED').length, 1, 'still logged in-app');
});

// ---- daily overdue sweep --------------------------------------------------------------

test('daily job: a sent invoice past its due date becomes overdue; a paid one does not', async () => {
  const s = seed();
  s['purchaseOrders/o1'].invoice.status = 'sent';
  s['purchaseOrders/o2'] = { ...s['purchaseOrders/o1'], poNumber: 'AA6677', invoice: { ...s['purchaseOrders/o1'].invoice, status: 'sent' } };
  const h = build({ seed: s, now: Date.UTC(2026, 9, 25, 12) });          // Oct 25, due Oct 20
  await h.inv.invoiceRecordManualPayment({ orgId: 'acme', orderId: 'o2', amount: 1200, method: 'check' }, h.ctx('dave'));
  const stats = await h.inv._internal.runOverdueSweep();
  assert.equal(order(h).invoice.status, 'overdue');
  assert.equal(h.db.data('purchaseOrders/o2').invoice.status, 'paid');
  assert.equal(stats.overdue, 1);
});

test('paid online BEFORE shipping: the order flips to Paid when it ships; Mark Unpaid is not undone', async () => {
  const s = seed();
  s['purchaseOrders/o1'].status = 'packed';
  const h = build({ seed: s });
  withCharge(h, 'pi_early', TOTAL);
  await h.deliver(ev('checkout.session.completed', session('pi_early', TOTAL, 'paid')));
  assert.equal(order(h).status, 'packed', 'not shipped yet, so still in the pick/pack flow');
  assert.equal(order(h).invoice.status, 'paid');
  const before = h.db.data('purchaseOrders/o1');
  h.db.store['purchaseOrders/o1'].status = 'shipped';
  assert.equal(await h.inv._internal.handleOrderChange('acme', 'o1', before, h.db.data('purchaseOrders/o1')), 'recomputed-paid-check');
  assert.equal(order(h).status, 'paid');
  assert.equal(order(h).paidVia, 'ledger');
  assert.equal(order(h).paymentMethod, 'credit_card');
  // A person uses Mark Unpaid (paid -> shipped): the trigger leaves it alone.
  const paid = h.db.data('purchaseOrders/o1');
  Object.assign(h.db.store['purchaseOrders/o1'], { status: 'shipped', paidAt: null, paymentMethod: '' });
  await h.inv._internal.handleOrderChange('acme', 'o1', paid, h.db.data('purchaseOrders/o1'));
  assert.equal(order(h).status, 'shipped');
});
