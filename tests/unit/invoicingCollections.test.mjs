// Phase 5: the Collections view and customer statements. Pins the aging
// buckets, the oldest-first split of one statement payment over several
// invoices (and refunds coming off the newest), one statement per customer
// per day/month, and the From/Reply-To of every invoicing email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const C = require('../../functions/invoicingCore.js');
const { build } = require('./_fakes/invoicingHarness.cjs');

const TZ = 'America/New_York';
const at = (iso, h = 14) => Date.parse(iso + 'T' + String(h).padStart(2, '0') + ':00:00Z');

// ---- pure ----------------------------------------------------------------------------

test('allocation: oldest first, never more than an invoice owes, leftover is credit', () => {
  const inv = [
    { orderId: 'b', orderNumber: 'AA2', dueDay: 200, balanceCents: 3000 },
    { orderId: 'a', orderNumber: 'AA1', dueDay: 100, balanceCents: 5000 },
    { orderId: 'c', orderNumber: 'AA3', dueDay: 300, balanceCents: 0 }
  ];
  assert.deepEqual(C.allocateOldestFirst(inv, 6000), { allocations: [
    { orderId: 'a', orderNumber: 'AA1', cents: 5000 }, { orderId: 'b', orderNumber: 'AA2', cents: 1000 }], unallocatedCents: 0 });
  assert.deepEqual(C.allocateOldestFirst(inv, 9000).unallocatedCents, 1000);
  assert.deepEqual(C.allocateOldestFirst(inv, 0).allocations, []);
  // a bank transfer still clearing on an invoice is not allocated to again
  assert.deepEqual(C.allocateOldestFirst([{ orderId: 'a', dueDay: 1, balanceCents: 5000, collectibleCents: 1000 }], 5000),
    { allocations: [{ orderId: 'a', orderNumber: '', cents: 1000 }], unallocatedCents: 4000 });
});

test('collections report: aged by customer, paid/void/unshipped left out, $0 shipped flagged', () => {
  const orders = [
    { id: 'o1', data: { poNumber: 'AA1', customerId: 'c1', customerName: 'Buyer', status: 'shipped', invoiceDate: '2026-08-01', terms: 'Net 30', items: [{ qtyShipped: 1, unitPrice: 100 }] } },   // due Aug 31 -> 28 days
    { id: 'o2', data: { poNumber: 'AA2', customerId: 'c1', customerName: 'Buyer', status: 'shipped', invoiceDate: '2026-06-01', terms: 'Net 30', items: [{ qtyShipped: 1, unitPrice: 50 }], amountPaidCents: 1000 } }, // due Jul 1 -> 89 days
    { id: 'o3', data: { poNumber: 'AA3', customerName: 'Walk-in Co', status: 'shipped', invoiceDate: '2026-09-20', items: [{ qtyShipped: 2, unitPrice: 10 }] } },
    { id: 'o4', data: { poNumber: 'AA4', customerId: 'c1', status: 'paid', invoiceDate: '2026-01-01', items: [{ qtyShipped: 1, unitPrice: 999 }] } },
    { id: 'o5', data: { poNumber: 'AA5', customerId: 'c1', status: 'cancelled', invoice: { issuedAt: 1 }, items: [{ qtyShipped: 1, unitPrice: 999 }] } },
    { id: 'o6', data: { poNumber: 'AA6', customerId: 'c1', status: 'confirmed', items: [{ qtyShipped: 1, unitPrice: 999 }] } },
    { id: 'o7', data: { poNumber: 'AA7', customerId: 'c1', status: 'shipped', items: [{ qtyShipped: '', quantity: 3, unitPrice: 999 }] } }
  ];
  const r = C.collectionsReport(orders, { c1: { company: 'Buyer LLC', remindByPhone: true, billingEmails: ['ap@b.test'] } },
    { now: at('2026-09-28'), tz: TZ, settings: { reminders: true } });
  assert.equal(r.totals.totalCents, 10000 + 4000 + 2000);
  assert.equal(r.totals['1-30'], 10000);
  assert.equal(r.totals['61-90'], 4000);
  assert.equal(r.totals.current, 2000);
  assert.deepEqual(r.customers.map(c => c.customerName), ['Buyer LLC', 'Walk-in Co'], 'most overdue first');
  const b = r.customers[0];
  assert.equal(b.remindByPhone, true);
  assert.deepEqual(b.billingEmails, ['ap@b.test']);
  assert.deepEqual(b.invoices.map(i => i.orderNumber), ['AA2', 'AA1']);
  assert.deepEqual(r.zeroTotalShipped, ['AA7']);
});

// ---- statements end to end --------------------------------------------------------------

const ACCT = 'acct_acme_test';
function seed(extra = {}) {
  return Object.assign({
    'organizations/acme': { name: 'AA Surplus Sales Inc.', email: 'office@acme.test',
      payments: { enabled: true, stripeAccountId: ACCT, mode: 'test', connected: true, chargesEnabled: true, detailsSubmitted: true,
        billingEmail: 'ar@acme.test', autoSend: { timeZone: TZ, statementMonthly: true } } },
    'stripeAccounts/acct_acme_test': { orgId: 'acme' },
    'orgMembers/acme_dave': { orgId: 'acme', userId: 'dave', role: 'manager', status: 'active' },
    'orgMembers/acme_carol': { orgId: 'acme', userId: 'carol', role: 'staff', status: 'active' },
    'customers/c1': { orgId: 'acme', company: 'Buyer LLC', customerName: 'Pat', email: 'pat@buyer.test', billingEmails: ['ap@buyer.test'] },
    'customers/c2': { orgId: 'acme', company: 'Quiet Co', email: 'q@quiet.test', doNotRemind: true },
    'purchaseOrders/old': { orgId: 'acme', poNumber: 'AA6601', customerId: 'c1', customerName: 'Buyer LLC', status: 'shipped', terms: 'Net 30',
      invoiceDate: '2026-07-01', items: [{ qtyShipped: 1, unitPrice: 300 }] },
    'purchaseOrders/new': { orgId: 'acme', poNumber: 'AA6650', customerId: 'c1', customerName: 'Buyer LLC', status: 'shipped', terms: 'Net 30',
      invoiceDate: '2026-09-15', items: [{ qtyShipped: 1, unitPrice: 500 }] },
    'purchaseOrders/q1': { orgId: 'acme', poNumber: 'AA6660', customerId: 'c2', customerName: 'Quiet Co', status: 'shipped',
      invoiceDate: '2026-08-01', items: [{ qtyShipped: 1, unitPrice: 70 }] }
  }, extra);
}
let n = 0;
const ev = (type, object, dt = 0) => ({ id: 'evt_s_' + (++n), type, account: ACCT, livemode: false, created: 1790000000 + dt, data: { object } });
const stmtMeta = { skidsling: 'invoice-payment', kind: 'statement', orgId: 'acme', orderId: '', orderNumber: '', customerId: 'c1', surchargeCents: '0' };
const stmtSession = (pi, amount) => ({ id: 'cs_' + pi, object: 'checkout.session', mode: 'payment', payment_intent: pi, amount_total: amount, payment_status: 'paid', metadata: stmtMeta });

test('statement: one email, every open invoice, one pay link; once a day', async () => {
  const h = build({ seed: seed(), now: at('2026-09-28') });
  await assert.rejects(h.inv.statementSend({ orgId: 'acme', customerId: 'c1' }, h.ctx('carol')), /requires manager/);
  const r = await h.inv.statementSend({ orgId: 'acme', customerId: 'c1' }, h.ctx('dave'));
  assert.equal(r.sent, true);
  assert.equal(r.invoices, 2);
  const m = h.emails[0];
  assert.deepEqual(m.to, ['ap@buyer.test']);
  assert.equal(m.replyTo, 'ar@acme.test');
  assert.equal(m.subject, 'Statement from AA Surplus Sales Inc.: 2 open invoices, $800.00 (1 past due)');
  assert.ok(m.html.indexOf('AA6601') < m.html.indexOf('AA6650'), 'oldest first');
  assert.match(m.html, /https:\/\/app\.test\/pay\/acme\/statement\/c1\?t=/);
  const again = await h.inv.statementSend({ orgId: 'acme', customerId: 'c1' }, h.ctx('dave'));
  assert.equal(again.sent, false);
  assert.match(again.reason, /already went to this customer today/);
});

test('statement pay link: shows the total, pays it in one checkout, split oldest-first by the webhook', async () => {
  const h = build({ seed: seed(), now: at('2026-09-28') });
  await h.inv.statementSend({ orgId: 'acme', customerId: 'c1' }, h.ctx('dave'));
  const url = new URL(h.emails[0].html.match(/https:\/\/app\.test\/pay\/acme\/statement\/c1\?t=[A-Za-z0-9_-]+/)[0]);
  const t = url.searchParams.get('t');
  const view = await h.inv.invoicePayLinkStatus({ orgId: 'acme', customerId: 'c1', t }, {});
  assert.equal(view.kind, 'statement');
  assert.equal(view.amountDueNowCents, 80000);
  assert.deepEqual(view.invoices.map(i => i.orderNumber), ['AA6601', 'AA6650']);
  await h.inv.invoicePayLinkCheckout({ orgId: 'acme', customerId: 'c1', t }, {});
  const call = h.stripe.calls.find(c => c.fn === 'checkout.sessions.create');
  assert.equal(call.params.metadata.kind, 'statement');
  assert.equal(call.params.metadata.customerId, 'c1');
  assert.equal(call.params.line_items[0].price_data.unit_amount, 80000);
  assert.deepEqual(call.opts, { stripeAccount: ACCT });
  // The statement token is not an invoice token.
  await assert.rejects(h.inv.invoicePayLinkStatus({ orgId: 'acme', orderId: 'old', t }, {}), /not valid/);

  // Customer pays $500 of the $800: the oldest ($300) is cleared, the newer gets $200.
  await h.deliver(ev('checkout.session.completed', stmtSession('pi_st1', 50000)));
  let p = h.db.data('payments/stripe_pi_st1');
  assert.deepEqual(p.allocations, [{ orderId: 'old', orderNumber: 'AA6601', cents: 30000 }, { orderId: 'new', orderNumber: 'AA6650', cents: 20000 }]);
  assert.equal(h.db.data('purchaseOrders/old').status, 'paid');
  assert.equal(h.db.data('purchaseOrders/new').balanceDueCents, 30000);
  assert.equal(h.db.data('purchaseOrders/new').invoice.status, 'partially_paid');

  // A later event for the same payment never re-splits it.
  await h.deliver(ev('payment_intent.succeeded', { id: 'pi_st1', amount: 50000, amount_received: 50000, metadata: stmtMeta, payment_method_types: ['card'] }, 5));
  p = h.db.data('payments/stripe_pi_st1');
  assert.equal(p.allocations.length, 2);

  // $150 refunded: it comes off the newest invoice first.
  await h.deliver(ev('charge.refunded', { id: 'ch_x', payment_intent: 'pi_st1', amount: 50000, amount_refunded: 15000, metadata: {} }, 10));
  assert.equal(h.db.data('purchaseOrders/old').balanceDueCents, 0);
  assert.equal(h.db.data('purchaseOrders/new').balanceDueCents, 45000);
});

test('monthly statements: once a month, skipping do-not-remind customers', async () => {
  const h = build({ seed: seed(), now: at('2026-10-01') });
  const org = h.db.data('organizations/acme');
  const r1 = await h.inv._internal.sendMonthlyStatements('acme', org);
  assert.equal(r1.sent, 1);
  assert.deepEqual(h.emails.map(e => e.to[0]), ['ap@buyer.test']);
  h.clock.now = at('2026-10-01', 20);
  const r2 = await h.inv._internal.sendMonthlyStatements('acme', org);
  assert.equal(r2.sent, 0);
  assert.equal(h.emails.length, 1);
});

test('collections report: manager+, with recent payments', async () => {
  const h = build({ seed: seed(), now: at('2026-09-28') });
  await h.inv.invoiceRecordManualPayment({ orgId: 'acme', orderId: 'old', amount: 100, method: 'check' }, h.ctx('dave'));
  await assert.rejects(h.inv.collectionsGetReport({ orgId: 'acme' }, h.ctx('carol')), /requires manager/);
  const r = await h.inv.collectionsGetReport({ orgId: 'acme' }, h.ctx('dave'));
  assert.equal(r.totals.totalCents, 20000 + 50000 + 7000);
  assert.equal(r.recentPayments.length, 1);
  assert.deepEqual(r.recentPayments[0].orderNumbers, ['AA6601']);
  const quiet = r.customers.find(c => c.customerName === 'Quiet Co');
  assert.equal(quiet.doNotRemind, true);
});

// ---- From / Reply-To ---------------------------------------------------------------------

test('invoicing email is sent FROM billing@skidsling.com under the company name, replies to the company', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fnRequire = createRequire(path.join(here, '..', '..', 'functions', 'invoicing.js'));
  const fetchPath = fnRequire.resolve('node-fetch');
  const sent = [];
  const fakeFetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, json: async () => ({ messageId: '<m1@brevo>' }), text: async () => '' }; };
  const saved = require.cache[fetchPath];
  require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: fakeFetch };
  try {
    for (const [envFrom, want] of [[undefined, 'billing@skidsling.com'], ['Invoices@Example.test', 'invoices@example.test'], ['not an email', 'billing@skidsling.com']]) {
      const h = build({ seed: seed(), now: at('2026-09-28'), env: envFrom ? { INVOICE_FROM_EMAIL: envFrom } : {}, sendEmail: null });
      // build() injects a recording sender by default; rebuild without it so the real Brevo path runs.
      sent.length = 0;
      const r = await h.inv.statementSend({ orgId: 'acme', customerId: 'c1' }, h.ctx('dave'));
      assert.equal(r.sent, true, JSON.stringify(r));
      assert.equal(sent[0].url, 'https://api.brevo.com/v3/smtp/email');
      assert.deepEqual(sent[0].body.sender, { name: 'AA Surplus Sales Inc.', email: want });
      assert.deepEqual(sent[0].body.replyTo, { email: 'ar@acme.test' });
      assert.deepEqual(sent[0].body.to, [{ email: 'ap@buyer.test' }]);
      assert.equal(sent[0].headers['api-key'], 'brevo-fake');
    }
  } finally {
    if (saved) require.cache[fetchPath] = saved; else delete require.cache[fetchPath];
  }
});
