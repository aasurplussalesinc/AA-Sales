// Phase 2, end to end against fakes: the pay link opens a Checkout Session for
// the balance at that moment ON the company's connected account; manual
// payments land in the ledger and move the order; a paid invoice's link says
// "Paid"; nothing crosses tenants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../../functions/invoicingCore.js');
const { build } = require('./_fakes/invoicingHarness.cjs');

const ACCT = 'acct_acme_test';
function seed(over = {}) {
  return Object.assign({
    'organizations/acme': { name: 'Acme Surplus', email: 'office@acme.test',
      payments: { enabled: true, stripeAccountId: ACCT, mode: 'test', connected: true, chargesEnabled: true, detailsSubmitted: true,
        methods: ['card', 'us_bank_account'] } },
    'organizations/victim': { name: 'Victim Co', payments: { enabled: true, stripeAccountId: 'acct_victim', mode: 'test', chargesEnabled: true, detailsSubmitted: true } },
    'stripeAccounts/acct_acme_test': { orgId: 'acme' },
    'orgMembers/acme_alice': { orgId: 'acme', userId: 'alice', role: 'admin', status: 'active' },
    'orgMembers/acme_dave': { orgId: 'acme', userId: 'dave', role: 'manager', status: 'active' },
    'orgMembers/acme_carol': { orgId: 'acme', userId: 'carol', role: 'staff', status: 'active' },
    'orgMembers/victim_bob': { orgId: 'victim', userId: 'bob', role: 'admin', status: 'active' },
    'customers/c1': { orgId: 'acme', company: 'Buyer LLC', email: 'buyer@buyer.test', billingEmails: ['ap@buyer.test'] },
    'purchaseOrders/o1': { orgId: 'acme', poNumber: 'AA6676', customerPO: 'KB-15317', customerId: 'c1', customerName: 'Buyer LLC',
      customerEmail: 'buyer@buyer.test', status: 'shipped', terms: 'Net 30', invoiceDate: '2026-09-20',
      items: [{ qtyShipped: 10, quantity: 10, unitPrice: 100 }, { qtyShipped: 1, unitPrice: 200 }], shipping: 0, tax: 0 },
    'purchaseOrders/o2': { orgId: 'victim', poNumber: 'VX1', status: 'shipped', items: [{ qtyShipped: 1, unitPrice: 50 }] },
    'purchaseOrders/draft': { orgId: 'acme', poNumber: 'AA6677', status: 'draft', items: [{ quantity: 3, qtyShipped: '', unitPrice: 5 }] }
  }, over);
}
const TOTAL = 120000;

async function payLink(h, orderId = 'o1') {
  const r = await h.inv.invoiceGetPayLink({ orgId: 'acme', orderId }, h.ctx('dave'));
  const u = new URL(r.url);
  return { url: r.url, t: u.searchParams.get('t'), path: u.pathname };
}

test('pay link: issued with a signed token, and the invoice gets its number and due date', async () => {
  const h = build({ seed: seed() });
  const { url, t, path } = await payLink(h);
  assert.equal(path, '/pay/acme/o1');
  assert.ok(url.startsWith('https://app.test/pay/acme/o1?t='));
  const o = h.db.data('purchaseOrders/o1');
  assert.equal(o.invoice.number, 'AA6676');
  assert.equal(o.invoice.dueDate, '2026-10-20');
  assert.equal(o.invoice.payUrl, url);
  assert.equal(o.balanceDueCents, TOTAL);
  assert.ok(C.verifyPayToken('link-secret-for-tests', 'invoice', 'acme', 'o1', o.invoice.linkNonce, t));
});

test('pay link: refused for an order with nothing shipped, and for staff', async () => {
  const h = build({ seed: seed() });
  await assert.rejects(h.inv.invoiceGetPayLink({ orgId: 'acme', orderId: 'draft' }, h.ctx('dave')), /Nothing to invoice yet/);
  await assert.rejects(h.inv.invoiceGetPayLink({ orgId: 'acme', orderId: 'o1' }, h.ctx('carol')), /requires manager/);
});

test('pay page: shows the balance and opens Checkout on the CONNECTED account for exactly that amount', async () => {
  const h = build({ seed: seed() });
  const { t } = await payLink(h);
  const view = await h.inv.invoicePayLinkStatus({ orgId: 'acme', orderId: 'o1', t }, {});
  assert.equal(view.balanceCents, TOTAL);
  assert.equal(view.canPay, true);
  assert.equal(view.testMode, true);
  assert.deepEqual(view.options.map(o => o.method), ['any']);
  const r = await h.inv.invoicePayLinkCheckout({ orgId: 'acme', orderId: 'o1', t, method: 'any' }, {});
  assert.match(r.url, /^https:\/\/checkout\.stripe\.com/);
  const call = h.stripe.calls.find(c => c.fn === 'checkout.sessions.create');
  assert.deepEqual(call.opts, { stripeAccount: ACCT });
  assert.equal(call.params.line_items[0].price_data.unit_amount, TOTAL);
  assert.equal(call.params.line_items[0].price_data.product_data.name, 'Invoice AA6676 (PO KB-15317)');
  assert.equal(call.params.customer_email, 'ap@buyer.test', 'the customer billing address, not the ordering contact');
  assert.equal(call.params.metadata.orgId, 'acme');
  assert.equal(call.params.metadata.orderId, 'o1');
  assert.ok(call.params.success_url.startsWith('https://app.test/pay/acme/o1?t='));
});

test('pay page: a second checkout expires the first, so one balance cannot be paid twice', async () => {
  const h = build({ seed: seed() });
  const { t } = await payLink(h);
  await h.inv.invoicePayLinkCheckout({ orgId: 'acme', orderId: 'o1', t }, {});
  await h.inv.invoicePayLinkCheckout({ orgId: 'acme', orderId: 'o1', t }, {});
  const exp = h.stripe.calls.filter(c => c.fn === 'checkout.sessions.expire');
  assert.equal(exp.length, 1);
  assert.deepEqual(exp[0].opts, { stripeAccount: ACCT });
});

test('pay page: a tampered or cross-org token is refused', async () => {
  const h = build({ seed: seed() });
  const { t } = await payLink(h);
  await assert.rejects(h.inv.invoicePayLinkStatus({ orgId: 'acme', orderId: 'o1', t: t.replace(/.$/, t.endsWith('A') ? 'B' : 'A') }, {}), /not valid/);
  await assert.rejects(h.inv.invoicePayLinkStatus({ orgId: 'victim', orderId: 'o1', t }, {}), /not valid/);
  await assert.rejects(h.inv.invoicePayLinkStatus({ orgId: 'acme', orderId: 'o2', t }, {}), /not valid/);
  await assert.rejects(h.inv.invoicePayLinkCheckout({ orgId: 'acme', orderId: 'o1', t: 'x'.repeat(32) }, {}), /not valid/);
  assert.equal(h.stripe.calls.filter(c => c.fn === 'checkout.sessions.create').length, 0);
});

test('partial manual payment, then the rest: balance, status and the order all follow', async () => {
  const h = build({ seed: seed() });
  const { t } = await payLink(h);
  await h.inv.invoiceRecordManualPayment({ orgId: 'acme', orderId: 'o1', amount: '500.00', method: 'check', note: 'chk 1042' }, h.ctx('dave'));
  let o = h.db.data('purchaseOrders/o1');
  assert.equal(o.amountPaidCents, 50000);
  assert.equal(o.balanceDueCents, TOTAL - 50000);
  assert.equal(o.balanceDue, 700);
  assert.equal(o.invoice.status, 'partially_paid');
  assert.equal(o.status, 'shipped');
  let view = await h.inv.invoicePayLinkStatus({ orgId: 'acme', orderId: 'o1', t }, {});
  assert.equal(view.amountDueNowCents, 70000);

  h.clock.now += 3600 * 1000;
  await h.inv.invoiceRecordManualPayment({ orgId: 'acme', orderId: 'o1', amount: 700, method: 'zelle' }, h.ctx('dave'));
  o = h.db.data('purchaseOrders/o1');
  assert.equal(o.balanceDueCents, 0);
  assert.equal(o.invoice.status, 'paid');
  assert.equal(o.status, 'paid', 'a fully paid shipped order moves to Paid, like the Mark Paid button');
  assert.equal(o.paymentMethod, 'zelle');
  assert.equal(o.paidVia, 'ledger');
  view = await h.inv.invoicePayLinkStatus({ orgId: 'acme', orderId: 'o1', t }, {});
  assert.equal(view.canPay, false);
  assert.equal(view.balanceCents, 0);
  assert.equal(view.reason, null, 'the page says Paid, thank you - not an error');
  await assert.rejects(h.inv.invoicePayLinkCheckout({ orgId: 'acme', orderId: 'o1', t }, {}), /Nothing to pay/);
});

test('reversing a manual payment reopens the balance and un-pays an order the ledger had paid', async () => {
  const h = build({ seed: seed() });
  const r = await h.inv.invoiceRecordManualPayment({ orgId: 'acme', orderId: 'o1', amount: 1200, method: 'check' }, h.ctx('dave'));
  assert.equal(h.db.data('purchaseOrders/o1').status, 'paid');
  await h.inv.invoiceReverseManualPayment({ orgId: 'acme', paymentId: r.paymentId, reason: 'bounced' }, h.ctx('dave'));
  const o = h.db.data('purchaseOrders/o1');
  assert.equal(o.status, 'shipped');
  assert.equal(o.balanceDueCents, TOTAL);
  assert.equal(h.db.data('payments/' + r.paymentId).status, 'voided');
});

test('an order marked Paid by hand is never un-paid by the ledger', async () => {
  const s = seed();
  s['purchaseOrders/o1'].status = 'paid';
  s['purchaseOrders/o1'].paymentMethod = 'check';
  const h = build({ seed: s });
  const r = await h.inv.invoiceRecordManualPayment({ orgId: 'acme', orderId: 'o1', amount: 10, method: 'cash' }, h.ctx('dave'));
  await h.inv.invoiceReverseManualPayment({ orgId: 'acme', paymentId: r.paymentId }, h.ctx('dave'));
  assert.equal(h.db.data('purchaseOrders/o1').status, 'paid');
});

test('manual payments: manager+ only, own org only, sane amounts', async () => {
  const h = build({ seed: seed() });
  await assert.rejects(h.inv.invoiceRecordManualPayment({ orgId: 'acme', orderId: 'o1', amount: 5, method: 'cash' }, h.ctx('carol')), /requires manager/);
  await assert.rejects(h.inv.invoiceRecordManualPayment({ orgId: 'victim', orderId: 'o2', amount: 5, method: 'cash' }, h.ctx('dave')), /Not a member/);
  await assert.rejects(h.inv.invoiceRecordManualPayment({ orgId: 'acme', orderId: 'o2', amount: 5, method: 'cash' }, h.ctx('dave')), /not found/);
  await assert.rejects(h.inv.invoiceRecordManualPayment({ orgId: 'acme', orderId: 'o1', amount: 0, method: 'cash' }, h.ctx('dave')), /more than/);
  await assert.rejects(h.inv.invoiceRecordManualPayment({ orgId: 'acme', orderId: 'o1', amount: 5, method: 'bitcoin' }, h.ctx('dave')), /Method must be/);
  const p = Object.keys(h.db.store).filter(k => k.startsWith('payments/'));
  assert.equal(p.length, 0);
});

test('details: staff of the org see the ledger; other tenants cannot', async () => {
  const h = build({ seed: seed() });
  await h.inv.invoiceRecordManualPayment({ orgId: 'acme', orderId: 'o1', amount: 100, method: 'check' }, h.ctx('dave'));
  const d = await h.inv.invoiceGetDetails({ orgId: 'acme', orderId: 'o1' }, h.ctx('carol'));
  assert.equal(d.state.paidCents, 10000);
  assert.equal(d.payments.length, 1);
  assert.equal(d.payments[0].method, 'check');
  assert.equal(d.online.ready, true);
  await assert.rejects(h.inv.invoiceGetDetails({ orgId: 'acme', orderId: 'o1' }, h.ctx('bob')), /Not a member/);
  await assert.rejects(h.inv.invoiceGetDetails({ orgId: 'victim', orderId: 'o1' }, h.ctx('bob')), /not found/);
});

test('pay online is unavailable while Stripe is disconnected or payments are off', async () => {
  const s = seed();
  s['organizations/acme'].payments.connected = false;
  const h = build({ seed: s });
  await assert.rejects(h.inv.invoiceGetPayLink({ orgId: 'acme', orderId: 'o1' }, h.ctx('dave')), /not connected/);
  const s2 = seed();
  s2['organizations/acme'].payments.enabled = false;
  const h2 = build({ seed: s2 });
  await assert.rejects(h2.inv.invoiceGetPayLink({ orgId: 'acme', orderId: 'o1' }, h2.ctx('dave')), /turned off/);
});

test('a cancelled order: the link stops offering payment', async () => {
  const h = build({ seed: seed() });
  const { t } = await payLink(h);
  h.db.store['purchaseOrders/o1'].status = 'cancelled';
  const view = await h.inv.invoicePayLinkStatus({ orgId: 'acme', orderId: 'o1', t }, {});
  assert.equal(view.canPay, false);
  assert.equal(view.status, 'void');
  await assert.rejects(h.inv.invoicePayLinkCheckout({ orgId: 'acme', orderId: 'o1', t }, {}), /cancelled/);
});

test('pay page: a customer may pay part of the balance, never more than is owed', async () => {
  const h = build({ seed: seed() });
  const { t } = await payLink(h);
  await h.inv.invoicePayLinkCheckout({ orgId: 'acme', orderId: 'o1', t, amountCents: 60000 }, {});
  const call = h.stripe.calls.find(c => c.fn === 'checkout.sessions.create');
  assert.equal(call.params.line_items[0].price_data.unit_amount, 60000);
  await assert.rejects(h.inv.invoicePayLinkCheckout({ orgId: 'acme', orderId: 'o1', t, amountCents: TOTAL + 1 }, {}), /between \$1\.00 and \$1,200\.00/);
  await assert.rejects(h.inv.invoicePayLinkCheckout({ orgId: 'acme', orderId: 'o1', t, amountCents: 50 }, {}), /between/);
});
