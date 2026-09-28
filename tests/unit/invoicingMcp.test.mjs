// The AA Chief of Staff's overdue report reads invoices through MCP. These pin
// that list_orders and list_open_invoices report the real payment status from
// the ledger (not a guess from order.status), and stay inside the org.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createFakeDb } = require('./_fakes/fakeFirestore.cjs');
const { fakeFunctions } = require('./_fakes/invoicingHarness.cjs');
const createMcp = require('../../functions/mcp.js');

const seed = {
  'organizations/acme': { name: 'Acme', payments: { enabled: true } },
  'customers/c1': { orgId: 'acme', company: 'Slow Payer', doNotRemind: false, remindByPhone: true },
  // Old-style order someone marked paid by hand - no ledger fields at all.
  'purchaseOrders/legacyPaid': { orgId: 'acme', poNumber: 'AA6001', customerName: 'Cash Co', status: 'paid', paymentMethod: 'check',
    invoiceDate: '2020-01-01', items: [{ qtyShipped: 1, unitPrice: 500 }] },
  // Shipped before invoicing existed: open, dated from its invoice date.
  'purchaseOrders/legacyOpen': { orgId: 'acme', poNumber: 'AA6002', customerName: 'Slow Payer', customerId: 'c1', status: 'shipped',
    terms: 'Net 30', invoiceDate: '2020-01-01', items: [{ qtyShipped: 2, unitPrice: 100 }] },
  // Part-paid through the ledger.
  'purchaseOrders/part': { orgId: 'acme', poNumber: 'AA6003', customerName: 'Slow Payer', customerId: 'c1', status: 'shipped',
    terms: 'Net 30', invoiceDate: '2020-02-01', items: [{ qtyShipped: 10, unitPrice: 100 }],
    amountPaidCents: 40000, balanceDueCents: 60000, pendingCents: 10000,
    invoice: { issuedAt: 1, sentAt: 1577900000000, lastReminderAt: 1580000000000, reminderCount: 2, status: 'overdue' } },
  'purchaseOrders/draft': { orgId: 'acme', poNumber: 'AA6004', status: 'draft', items: [{ quantity: 3, unitPrice: 5 }] },
  'purchaseOrders/other': { orgId: 'victim', poNumber: 'V1', status: 'shipped', invoiceDate: '2020-01-01', items: [{ qtyShipped: 1, unitPrice: 99 }] }
};

async function call(tool, args) {
  const db = createFakeDb(seed);
  const handler = createMcp({ functions: fakeFunctions(), db, publicItem: (id, d) => ({ id, ...d }),
    resolveApiKey: async () => ({ orgId: 'acme', scope: 'read', keyId: 'k1', label: 'test' }) });
  const req = { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args || {} } },
    get: () => undefined };
  let out;
  const res = { set() { return this; }, status() { return this; }, json(b) { out = b; return this; }, send() { return this; } };
  await handler(req, res);
  const text = out.result.content[0].text;
  assert.equal(out.result.isError, false, text);
  return JSON.parse(text);
}

test('list_open_invoices: what is owed, from the ledger, most overdue first', async () => {
  const r = await call('list_open_invoices');
  assert.deepEqual(r.invoices.map(i => i.orderNumber), ['AA6002', 'AA6003']);
  const part = r.invoices.find(i => i.orderNumber === 'AA6003');
  assert.equal(part.balanceDue, 600);
  assert.equal(part.amountPaid, 400);
  assert.equal(part.paymentPending, true);
  assert.equal(part.pendingAmount, 100);
  assert.equal(part.reminderCount, 2);
  assert.equal(part.dueDate, '2020-03-02');
  assert.equal(part.agingBucket, '90+');
  assert.equal(part.remindByPhone, true);
  assert.equal(r.totalOutstanding, 800);
  assert.equal(r.outstandingByAge['90+'], 800);
  assert.ok(!r.invoices.some(i => i.orderNumber === 'V1'), 'never another org');
  assert.ok(!r.invoices.some(i => i.orderNumber === 'AA6001'), 'marked paid by hand = paid');
});

test('list_orders carries invoice status on shipped/paid orders only', async () => {
  const r = await call('list_orders', { limit: 200 });
  const by = Object.fromEntries(r.orders.map(o => [o.orderNumber, o]));
  assert.equal(by.AA6001.invoice.status, 'paid');
  assert.equal(by.AA6001.invoice.markedPaidByHand, true);
  assert.equal(by.AA6002.invoice.status, 'overdue');
  assert.equal(by.AA6002.invoice.balanceDue, 200);
  assert.ok(by.AA6002.invoice.daysOverdue > 2000);
  assert.equal(by.AA6004.invoice, undefined, 'a draft has no invoice yet');
});

test('filters: overdueOnly, customer and minDaysOverdue', async () => {
  const r = await call('list_open_invoices', { customer: 'slow', minDaysOverdue: 1, overdueOnly: true, limit: 1 });
  assert.equal(r.matched, 2);
  assert.equal(r.returned, 1);
});
