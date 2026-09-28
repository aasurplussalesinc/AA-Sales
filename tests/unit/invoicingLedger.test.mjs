// The money rules behind "Pay online": what an invoice totals, what a set of
// payments leaves owing, the invoice status that follows, and the signed pay
// link. Pure functions (functions/invoicingCore.js), integer cents throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderOrderDocument } from '../../functions/orderDocument.mjs';
const require = createRequire(import.meta.url);
const C = require('../../functions/invoicingCore.js');

const TZ = 'America/New_York';
const day = (iso) => C.isoToDay(iso);
const order = (over = {}) => ({
  poNumber: 'AA6676', customerPO: 'KB-15317', status: 'shipped', terms: 'Net 30', invoiceDate: '2026-09-01',
  items: [{ qtyShipped: 10, quantity: 12, unitPrice: 100 }, { qtyShipped: 3, unitPrice: 33.33 }],
  tax: 0, shipping: 25.5, credit: 0, discount: 0, ...over
});
const pay = (over = {}) => ({ orderId: 'o1', orderIds: ['o1'], amountCents: 0, succeededAt: 1, ...over });

// ---- invoice total = the printed invoice ------------------------------------------

test('invoice total matches what the printed invoice says, to the cent', () => {
  const cases = [
    order(),
    order({ items: [{ qtyShipped: 3, unitPrice: 10.75 }, { qtyShipped: '7', unitPrice: 6.75 }], tax: 1.1, discount: 2 }),
    order({ items: [{ qtyShipped: 1, unitPrice: 0.1 }, { qtyShipped: 1, unitPrice: 0.2 }] }),
    order({ items: [{ qtyShipped: '', quantity: 5, unitPrice: 10 }], shipping: 0 })
  ];
  for (const o of cases) {
    const html = renderOrderDocument(o, 'invoice', { branding: () => ({ logo: '', details: '' }) });
    const printed = html.match(/<span>Total<\/span><span>\$([\d.-]+)<\/span>/)[1];
    assert.equal(C.invoiceTotalCents(o), Math.round(parseFloat(printed) * 100), printed);
  }
});

test('an invoice prices what SHIPPED, not what was ordered', () => {
  assert.equal(C.invoiceTotalCents(order({ items: [{ qtyShipped: '', quantity: 5, unitPrice: 10 }], shipping: 0 })), 0);
  assert.equal(C.invoiceTotalCents(order({ items: [{ qtyShipped: 2, quantity: 5, unitPrice: 10 }], shipping: 0 })), 2000);
});

test('toCents rounds like the document does', () => {
  assert.equal(C.toCents('12.345'), 1235);
  assert.equal(C.toCents(0.1 + 0.2), 30);
  assert.equal(C.toCents('abc'), 0);
  assert.equal(C.formatCents(123456), '$1,234.56');
  assert.equal(C.formatCents(-5), '-$0.05');
});

// ---- terms & due dates ---------------------------------------------------------------

test('terms: Net N, due on receipt, blank defaults to Net 30', () => {
  assert.equal(C.termsDays('Net 30'), 30);
  assert.equal(C.termsDays('net15'), 15);
  assert.equal(C.termsDays('Due on Receipt'), 0);
  assert.equal(C.termsDays('COD'), 0);
  assert.equal(C.termsDays(''), 30);
  assert.equal(C.termsDays('45 days'), 45);
});

test('due date: explicit dueDate wins, else invoice date + terms, else shipped date', () => {
  assert.equal(C.dayToIso(C.invoiceDueDay(order(), TZ)), '2026-10-01');
  assert.equal(C.dayToIso(C.invoiceDueDay(order({ dueDate: '2026-09-15' }), TZ)), '2026-09-15');
  assert.equal(C.dayToIso(C.invoiceDueDay(order({ invoiceDate: '', shippedAt: Date.UTC(2026, 8, 10, 15) }), TZ)), '2026-10-10');
  // shipped late evening New York time is still that New York day
  assert.equal(C.dayToIso(C.invoiceDueDay(order({ invoiceDate: '', terms: 'Due on Receipt', shippedAt: Date.UTC(2026, 8, 11, 2) }), TZ)), '2026-09-10');
});

// ---- balance math ---------------------------------------------------------------------

const total = C.invoiceTotalCents(order());   // 100000 + 9999 + 2550 = 112549

test('partial payments leave the right balance; a second payment clears it', () => {
  const p1 = pay({ amountCents: 50000 });
  let led = C.orderLedger('o1', [p1]);
  let st = C.invoiceState(order(), led, day('2026-09-10'), TZ);
  assert.equal(st.balanceCents, total - 50000);
  assert.equal(st.status, 'partially_paid');
  led = C.orderLedger('o1', [p1, pay({ amountCents: total - 50000 })]);
  st = C.invoiceState(order(), led, day('2026-09-10'), TZ);
  assert.equal(st.balanceCents, 0);
  assert.equal(st.status, 'paid');
});

test('refunds reduce what was paid; a full refund restores the whole balance', () => {
  const led1 = C.orderLedger('o1', [pay({ amountCents: total, refundedCents: 20000 })]);
  assert.equal(led1.paidCents, total - 20000);
  const led2 = C.orderLedger('o1', [pay({ amountCents: total, refundedCents: total })]);
  assert.equal(led2.paidCents, 0);
  assert.equal(C.paymentStatus(pay({ amountCents: 100, refundedCents: 100 })), 'refunded');
  assert.equal(C.paymentStatus(pay({ amountCents: 100, refundedCents: 40 })), 'partially_refunded');
  assert.equal(C.invoiceState(order(), led2, day('2026-09-10'), TZ).balanceCents, total);
});

test('overpayment becomes a credit, never a negative balance', () => {
  const st = C.invoiceState(order(), C.orderLedger('o1', [pay({ amountCents: total + 1500 })]), day('2026-09-10'), TZ);
  assert.equal(st.balanceCents, 0);
  assert.equal(st.creditCents, 1500);
  assert.equal(st.status, 'paid');
});

test('a pending bank transfer is not paid, but is not owed twice either', () => {
  const led = C.orderLedger('o1', [pay({ amountCents: 60000, succeededAt: null })]);
  assert.equal(led.paidCents, 0);
  assert.equal(led.pendingCents, 60000);
  const st = C.invoiceState(order(), led, day('2026-09-10'), TZ);
  assert.equal(st.balanceCents, total);
  assert.equal(st.collectibleCents, total - 60000);
  assert.equal(st.paymentPending, true);
});

test('failed and reversed payments count for nothing', () => {
  const led = C.orderLedger('o1', [pay({ amountCents: 5000, succeededAt: null, failedAt: 5 }),
                                   pay({ amountCents: 7000, voidedAt: 9 })]);
  assert.equal(led.paidCents, 0);
  assert.equal(led.pendingCents, 0);
});

test('a success outranks an earlier failure on the same payment (declined card, then a good one)', () => {
  assert.equal(C.paymentStatus({ amountCents: 1, failedAt: 5, succeededAt: 9 }), 'succeeded');
  assert.equal(C.paymentStatus({ amountCents: 1, failedAt: 9 }), 'failed');
  assert.equal(C.paymentStatus({ amountCents: 1 }), 'pending');
});

test('a statement payment is split oldest-first; a refund comes off the newest invoice', () => {
  const p = { orderIds: ['a', 'b'], amountCents: 30000, succeededAt: 1,
    allocations: [{ orderId: 'a', cents: 10000 }, { orderId: 'b', cents: 20000 }] };
  assert.deepEqual(C.paymentShare(p, 'a'), { paid: 10000, pending: 0 });
  assert.deepEqual(C.paymentShare(p, 'b'), { paid: 20000, pending: 0 });
  const refunded = { ...p, refundedCents: 25000 };
  assert.deepEqual(C.paymentShare(refunded, 'b'), { paid: 0, pending: 0 });
  assert.deepEqual(C.paymentShare(refunded, 'a'), { paid: 5000, pending: 0 });
});

test('unallocated credit on a statement payment is refunded before any invoice', () => {
  const p = { orderIds: ['a'], amountCents: 12000, succeededAt: 1, refundedCents: 2000,
    allocations: [{ orderId: 'a', cents: 10000 }] };
  assert.equal(C.paymentShare(p, 'a').paid, 10000);
});

// ---- invoice status transitions -----------------------------------------------------------

test('status walks draft -> sent -> partially_paid -> overdue -> paid, and void wins', () => {
  const t = day('2026-09-10');
  const unshipped = order({ status: 'packed' });
  assert.equal(C.invoiceState(unshipped, null, t, TZ).status, 'draft');
  const issuedUnsent = order({ invoice: { issuedAt: 1 } });
  assert.equal(C.invoiceState(issuedUnsent, C.orderLedger('o1', []), t, TZ).status, 'draft');
  const sent = order({ invoice: { issuedAt: 1, sentAt: 2 } });
  assert.equal(C.invoiceState(sent, C.orderLedger('o1', []), t, TZ).status, 'sent');
  const partLed = C.orderLedger('o1', [pay({ amountCents: 100 })]);
  assert.equal(C.invoiceState(sent, partLed, t, TZ).status, 'partially_paid');
  const late = C.invoiceState(sent, partLed, day('2026-10-05'), TZ);
  assert.equal(late.status, 'overdue');
  assert.equal(late.daysOverdue, 4);
  assert.equal(C.invoiceState(sent, C.orderLedger('o1', [pay({ amountCents: total })]), day('2026-10-05'), TZ).status, 'paid');
  const cancelled = order({ status: 'cancelled', invoice: { issuedAt: 1, sentAt: 2 } });
  const v = C.invoiceState(cancelled, partLed, day('2026-12-01'), TZ);
  assert.equal(v.status, 'void');
  assert.equal(v.collectibleCents, 0);
  assert.equal(v.daysOverdue, 0);
});

test('due today is not overdue; the day after is', () => {
  const sent = order({ invoice: { issuedAt: 1, sentAt: 2 } });
  assert.equal(C.invoiceState(sent, C.orderLedger('o1', []), day('2026-10-01'), TZ).status, 'sent');
  assert.equal(C.invoiceState(sent, C.orderLedger('o1', []), day('2026-10-02'), TZ).status, 'overdue');
});

test('an order someone marked Paid by hand has nothing to collect (existing orders keep working)', () => {
  const legacy = order({ status: 'paid', paymentMethod: 'check' });   // no ledger, no invoice field
  const st = C.invoiceState(legacy, C.orderLedger('o1', []), day('2026-12-01'), TZ);
  assert.equal(st.status, 'paid');
  assert.equal(st.balanceCents, 0);
  assert.equal(st.manualPaid, true);
});

test('a legacy shipped order with no invoice field is an open, dated invoice', () => {
  const st = C.invoiceState(order(), null, day('2026-10-20'), TZ);
  assert.equal(st.issued, true);
  assert.equal(st.balanceCents, total);
  assert.equal(st.status, 'overdue');
  assert.equal(st.daysOverdue, 19);
});

test('a shipped order with nothing shipped on it is flagged, not chased', () => {
  const st = C.invoiceState(order({ items: [{ qtyShipped: '', quantity: 4, unitPrice: 10 }], shipping: 0 }), null, day('2026-12-01'), TZ);
  assert.equal(st.zeroTotal, true);
  assert.equal(st.status, 'draft');
  assert.equal(st.balanceCents, 0);
});

// ---- pay link token -------------------------------------------------------------------------

test('pay link token: signs one org+order, verifies, and rejects any change', () => {
  const t = C.signPayToken('secret', 'invoice', 'acme', 'o1', 'n1');
  assert.equal(t.length, 32);
  assert.equal(C.verifyPayToken('secret', 'invoice', 'acme', 'o1', 'n1', t), true);
  assert.equal(C.verifyPayToken('secret', 'invoice', 'acme', 'o2', 'n1', t), false, 'other order');
  assert.equal(C.verifyPayToken('secret', 'invoice', 'victim', 'o1', 'n1', t), false, 'other org');
  assert.equal(C.verifyPayToken('secret', 'invoice', 'acme', 'o1', 'n2', t), false, 'revoked (new nonce)');
  assert.equal(C.verifyPayToken('other', 'invoice', 'acme', 'o1', 'n1', t), false, 'other secret');
  assert.equal(C.verifyPayToken('secret', 'statement', 'acme', 'o1', 'n1', t), false, 'invoice token is not a statement token');
  assert.equal(C.verifyPayToken('secret', 'invoice', 'acme', 'o1', 'n1', t.slice(0, 31) + (t[31] === 'A' ? 'B' : 'A')), false);
  assert.equal(C.verifyPayToken('secret', 'invoice', 'acme', 'o1', 'n1', undefined), false);
  assert.throws(() => C.signPayToken('', 'invoice', 'acme', 'o1', 'n1'), /INVOICE_LINK_SECRET/);
  assert.equal(C.invoicePayUrl('https://app.test', 'secret', 'acme', 'o1', 'n1'), 'https://app.test/pay/acme/o1?t=' + t);
});

// ---- checkout options ----------------------------------------------------------------------

test('surcharge ships off, and is capped at 3% when on', () => {
  assert.equal(C.cardSurchargeCents(100000, undefined), 0);
  assert.equal(C.cardSurchargeCents(100000, { enabled: false, percent: 3.5 }), 0);
  assert.equal(C.cardSurchargeCents(100000, { enabled: true, percent: 3.5 }), 3000);
  assert.equal(C.cardSurchargeCents(100000, { enabled: true, percent: 2 }), 2000);
});

test('payment options: one button normally; separate card/bank when a surcharge or card limit applies', () => {
  assert.deepEqual(C.paymentOptions(['card', 'us_bank_account'], {}, 5000).map(o => o.method), ['any']);
  const withFee = C.paymentOptions(['card', 'us_bank_account'], { enabled: true, percent: 3 }, 10000);
  assert.deepEqual(withFee.map(o => [o.method, o.surchargeCents]), [['us_bank_account', 0], ['card', 300]]);
  const bigInvoice = C.paymentOptions(['card', 'us_bank_account'], { maxInvoiceForCardsCents: 250000 }, 300000);
  assert.deepEqual(bigInvoice.map(o => o.method), ['us_bank_account']);
  assert.deepEqual(C.paymentOptions(['card'], {}, 5000).map(o => o.method), ['card']);
});

test('checkout params: the balance, one invoice line, metadata tying it to org and order', () => {
  const params = C.buildCheckoutParams({ kind: 'invoice', orgId: 'acme', orderId: 'o1', orderNumber: 'AA6676', customerId: 'c1',
    amountCents: 62549, option: C.paymentOptions(['card', 'us_bank_account'], {}, 62549)[0],
    lineName: C.invoiceLineName(order()), customerEmail: 'ap@buyer.test', successUrl: 's', cancelUrl: 'c' });
  assert.equal(params.mode, 'payment');
  assert.deepEqual(params.payment_method_types, ['us_bank_account', 'card']);
  assert.equal(params.line_items.length, 1);
  assert.equal(params.line_items[0].price_data.unit_amount, 62549);
  assert.equal(params.line_items[0].price_data.product_data.name, 'Invoice AA6676 (PO KB-15317)');
  assert.equal(params.metadata.orgId, 'acme');
  assert.deepEqual(params.payment_intent_data.metadata, params.metadata);
  assert.equal(params.customer_email, 'ap@buyer.test');
  const card = C.buildCheckoutParams({ kind: 'invoice', orgId: 'acme', orderId: 'o1', amountCents: 10000,
    option: { method: 'card', methods: ['card'], surchargeCents: 300 }, lineName: 'x', successUrl: 's', cancelUrl: 'c' });
  assert.equal(card.line_items[1].price_data.unit_amount, 300);
  assert.equal(card.metadata.surchargeCents, '300');
});
