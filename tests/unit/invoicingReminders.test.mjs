// Phase 4: automatic sending & reminders - "without me having to call each
// one". Driven with a fake clock, day by day. Pins: the right reminder on the
// right day; never two emails for one invoice in a day; nothing once it is
// paid / void / do-not-remind; nothing at all unless the org turned it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../../functions/invoicingCore.js');
const { build } = require('./_fakes/invoicingHarness.cjs');

const TZ = 'America/New_York';
const at = (iso, hourUtc = 14) => Date.parse(iso + 'T' + String(hourUtc).padStart(2, '0') + ':00:00Z');   // 10am New York
const addDays = (iso, n) => C.dayToIso(C.isoToDay(iso) + n);
const ON = { reminders: true, schedule: [-3, 0, 7, 14, 30] };
const state = (over = {}) => ({ status: 'sent', balanceCents: 5000, collectibleCents: 5000, dueDay: C.isoToDay('2026-10-01'), dueDate: '2026-10-01', ...over });

// ---- pure planner ---------------------------------------------------------------------

test('planner: each step on its day, nothing in between (sent a month early)', () => {
  let inv = { sentAt: at('2026-09-01') };
  const sent = {};
  for (let d = 0; d < 75; d++) {
    const day = addDays('2026-09-01', d);
    const plan = C.planReminder({ settings: ON, invoice: inv, state: state(), now: at(day), tz: TZ });
    if (plan.send) {
      sent[day] = plan.step;
      const rem = { ...(inv.reminders || {}) };
      rem[plan.step] = at(day);
      plan.skip.forEach(s => { rem[s] = 'skipped'; });
      inv = { ...inv, reminders: rem, lastReminderAt: at(day) };
    }
  }
  assert.deepEqual(sent, { '2026-09-28': -3, '2026-10-01': 0, '2026-10-08': 7, '2026-10-15': 14, '2026-10-31': 30 });
});

test('planner: the last step is the final notice', () => {
  const inv = { sentAt: at('2026-09-01'), reminders: { '-3': 1, '0': 1, '7': 1, '14': 1 } };
  const plan = C.planReminder({ settings: ON, invoice: inv, state: state({ status: 'overdue' }), now: at('2026-10-31'), tz: TZ });
  assert.equal(plan.step, 30);
  assert.equal(plan.final, true);
});

test('planner: never two emails on the same day, whatever triggered the first', () => {
  const base = { settings: ON, state: state(), tz: TZ };
  assert.equal(C.planReminder({ ...base, invoice: { sentAt: at('2026-09-28', 13) }, now: at('2026-09-28', 20) }).send, false,
    'the invoice itself went out today');
  const r = C.planReminder({ ...base, invoice: { sentAt: at('2026-09-01'), lastReminderAt: at('2026-10-01', 13) }, now: at('2026-10-01', 21) });
  assert.equal(r.send, false);
  assert.equal(r.reason, 'Already emailed today');
});

test('planner: "today" is the org\'s calendar day, not UTC', () => {
  // 11:30pm in New York on Sep 30 is already Oct 1 in UTC; the due-today step waits for NY's Oct 1.
  const plan = C.planReminder({ settings: ON, invoice: { sentAt: at('2026-09-01'), reminders: { '-3': 1 } }, state: state(),
    now: Date.parse('2026-10-01T03:30:00Z'), tz: TZ });
  assert.equal(plan.send, false);
  assert.equal(plan.reason, 'Nothing due today');
});

test('planner: an invoice sent after its due date gets ONE catch-up reminder, not a burst', () => {
  // due Sep 10 (invoice dated Aug 11, Net 30), emailed Sep 28.
  const st = state({ status: 'overdue', dueDay: C.isoToDay('2026-09-10'), dueDate: '2026-09-10' });
  let inv = { sentAt: at('2026-09-28') };
  assert.equal(C.planReminder({ settings: ON, invoice: inv, state: st, now: at('2026-09-28'), tz: TZ }).send, false);
  const next = C.planReminder({ settings: ON, invoice: inv, state: st, now: at('2026-09-29'), tz: TZ });
  assert.equal(next.send, true);
  assert.equal(next.step, 14, 'the latest step that has come due');
  assert.deepEqual(next.skip, [7], 'friendly pre-due notes were covered by the invoice itself');
  inv = { ...inv, reminders: { '14': at('2026-09-29'), '7': 'skipped' }, lastReminderAt: at('2026-09-29') };
  const later = C.planReminder({ settings: ON, invoice: inv, state: st, now: at('2026-09-30'), tz: TZ });
  assert.equal(later.send, false);
  assert.deepEqual(later.next, { step: 30, date: '2026-10-10' });
});

test('planner: stops for paid, void, a clearing bank transfer, paused, do-not-remind, phone-only, reminders off', () => {
  const base = { settings: ON, invoice: { sentAt: at('2026-09-01') }, now: at('2026-10-08'), tz: TZ };
  const why = (over) => C.planReminder({ ...base, ...over }).reason;
  assert.equal(C.planReminder({ ...base, state: state() }).send, true);
  assert.equal(why({ state: state({ status: 'paid', balanceCents: 0, collectibleCents: 0 }) }), 'Paid');
  assert.equal(why({ state: state({ status: 'void', balanceCents: 0, collectibleCents: 0 }) }), 'Invoice is void');
  assert.equal(why({ state: state({ collectibleCents: 0 }) }), 'Payment pending (bank transfer)');
  assert.equal(why({ state: state(), invoice: { ...base.invoice, remindersPaused: true } }), 'Reminders paused');
  assert.equal(why({ state: state(), customer: { doNotRemind: true } }), 'Customer marked "Do not remind"');
  assert.equal(why({ state: state(), customer: { remindByPhone: true } }), 'Customer prefers a phone call');
  assert.equal(why({ state: state(), settings: { ...ON, reminders: false } }), 'Automatic reminders are off');
  assert.equal(why({ state: state(), invoice: {} }), 'Invoice not sent yet');
});

test('settings: automatic collections default off; schedule is validated', () => {
  const a = C.sanitizeAutoSend({});
  assert.deepEqual(a, { sendOnShip: false, reminders: false, schedule: [-3, 0, 7, 14, 30], sendHour: 9, timeZone: 'America/New_York' });
  assert.deepEqual(C.sanitizeAutoSend({ schedule: '+30, -3, 7, 7' }).schedule, [-3, 7, 30]);
  assert.throws(() => C.sanitizeAutoSend({ schedule: '1.5' }), /whole numbers/);
  assert.throws(() => C.sanitizeAutoSend({ schedule: '400' }), /between/);
  assert.throws(() => C.sanitizeAutoSend({ sendHour: 3 }), /Send hour/);
  assert.throws(() => C.sanitizeAutoSend({ timeZone: 'Mars/Olympus' }), /time zone/);
});

test('email content: right subject for each step, and every customer value escaped', () => {
  const o = { poNumber: 'AA6676', customerPO: '<b>KB</b>', customerName: 'A&B <script>x</script>' };
  const st = { totalCents: 120000, paidCents: 0, balanceCents: 120000, collectibleCents: 120000, dueDate: '2026-10-01', daysOverdue: 14 };
  const inv = C.invoiceEmailContent({ kind: 'invoice', order: o, org: { name: 'Acme' }, state: { ...st, daysOverdue: 0 }, payUrl: 'https://app.test/pay/a/b?t=x' });
  assert.equal(inv.subject, 'Invoice AA6676 from Acme - $1,200.00 due October 1, 2026');
  assert.ok(inv.html.includes('A&amp;B &lt;script&gt;'));
  assert.ok(!inv.html.includes('<script>x'));
  assert.ok(inv.html.includes('href="https://app.test/pay/a/b?t=x"'));
  assert.match(C.invoiceEmailContent({ kind: 'reminder', step: -3, order: o, org: {}, state: st }).subject, /^Reminder: invoice AA6676 is due October 1, 2026/);
  assert.match(C.invoiceEmailContent({ kind: 'reminder', step: 0, order: o, org: {}, state: st }).subject, /is due today/);
  assert.match(C.invoiceEmailContent({ kind: 'reminder', step: 14, order: o, org: {}, state: st }).subject, /^Overdue: invoice AA6676 \(\$1,200\.00, 14 days past due\)/);
  assert.match(C.invoiceEmailContent({ kind: 'reminder', step: 30, final: true, order: o, org: {}, state: st }).subject, /^Final notice/);
  assert.ok(!C.invoiceEmailContent({ kind: 'invoice', order: o, org: {}, state: st, payUrl: 'javascript:alert(1)' }).html.includes('javascript:'));
});

// ---- end to end with the fake clock ---------------------------------------------------------

const ACCT = 'acct_acme_test';
function seed(autoSend, extra = {}) {
  return Object.assign({
    'organizations/acme': { name: 'Acme Surplus', email: 'office@acme.test',
      payments: { enabled: true, stripeAccountId: ACCT, mode: 'test', connected: true, chargesEnabled: true, detailsSubmitted: true,
        billingEmail: 'ar@acme.test', autoSend: { sendHour: 9, timeZone: TZ, schedule: [-3, 0, 7, 14, 30], ...autoSend } } },
    'stripeAccounts/acct_acme_test': { orgId: 'acme' },
    'orgMembers/acme_alice': { orgId: 'acme', userId: 'alice', role: 'admin', status: 'active' },
    'orgMembers/acme_dave': { orgId: 'acme', userId: 'dave', role: 'manager', status: 'active' },
    'orgMembers/acme_carol': { orgId: 'acme', userId: 'carol', role: 'staff', status: 'active' },
    'customers/c1': { orgId: 'acme', company: 'Buyer LLC', email: 'buyer@buyer.test', billingEmails: ['ap@buyer.test'] },
    'purchaseOrders/o1': { orgId: 'acme', poNumber: 'AA6676', customerId: 'c1', customerName: 'Buyer LLC', customerEmail: 'buyer@buyer.test',
      status: 'packed', terms: 'Net 30', invoiceDate: '2026-09-01', shipping: 0, tax: 0, items: [{ qtyShipped: 5, unitPrice: 100 }] }
  }, extra);
}
async function ship(h, id = 'o1') {
  const before = h.db.data('purchaseOrders/' + id);
  h.db.store['purchaseOrders/' + id].status = 'shipped';
  h.db.store['purchaseOrders/' + id].shippedAt = h.clock.now;
  return h.inv._internal.handleOrderChange('acme', id, before, h.db.data('purchaseOrders/' + id));
}

test('ship -> invoice issued and emailed (when turned on) with the PDF, pay button and reply-to', async () => {
  const h = build({ seed: seed({ sendOnShip: true }), now: at('2026-09-01') });
  assert.equal(await ship(h), 'sent');
  assert.equal(h.emails.length, 1);
  const m = h.emails[0];
  assert.deepEqual(m.to, ['ap@buyer.test'], 'the customer billing address');
  assert.equal(m.replyTo, 'ar@acme.test');
  assert.equal(m.fromName, 'Acme Surplus');
  assert.equal(m.attachments[0].name, 'Invoice-AA6676.pdf');
  assert.equal(Buffer.from(m.attachments[0].contentBase64, 'base64').toString(), '%PDF-fake');
  assert.ok(m.html.includes('/pay/acme/o1?t='));
  assert.ok(h.pdfs[0].includes('Pay online'), 'the PDF carries the pay link too');
  const o = h.db.data('purchaseOrders/o1');
  assert.equal(o.invoice.status, 'sent');
  assert.deepEqual(o.invoice.sentTo, ['ap@buyer.test']);
  assert.ok(o.invoice.lastEmail.messageId);
});

test('ship with automatic sending off: invoice issued, nothing emailed', async () => {
  const h = build({ seed: seed({ sendOnShip: false }), now: at('2026-09-01') });
  assert.equal(await ship(h), 'issued');
  assert.equal(h.emails.length, 0);
  assert.ok(h.db.data('purchaseOrders/o1').invoice.payUrl);
});

test('an org that never turned invoicing on: shipping writes nothing and emails nobody', async () => {
  const s = seed({ sendOnShip: true });
  s['organizations/acme'].payments.enabled = false;
  const h = build({ seed: s, now: at('2026-09-01') });
  const writes = h.db.writes.length;
  assert.equal(await ship(h), 'invoicing-off');
  assert.equal(h.db.writes.length, writes);
  assert.equal(h.emails.length, 0);
});

test('Mark Unpaid (paid -> shipped) does not re-send; a $0 invoice is not sent', async () => {
  const h = build({ seed: seed({ sendOnShip: true }), now: at('2026-09-01') });
  const b = h.db.data('purchaseOrders/o1');
  h.db.store['purchaseOrders/o1'].status = 'shipped';
  const r1 = await h.inv._internal.handleOrderChange('acme', 'o1', { ...b, status: 'paid' }, h.db.data('purchaseOrders/o1'));
  assert.notEqual(r1, 'sent');
  const h2 = build({ seed: seed({ sendOnShip: true }, { 'purchaseOrders/o1': { ...seed({})['purchaseOrders/o1'], items: [{ qtyShipped: '', quantity: 5, unitPrice: 100 }] } }), now: at('2026-09-01') });
  assert.equal(await ship(h2), 'zero-total');
  assert.equal(h2.emails.length, 0);
});

test('cancelling the order voids the invoice and kills its pay link', async () => {
  const h = build({ seed: seed({ sendOnShip: false }), now: at('2026-09-01') });
  await ship(h);
  const t = new URL(h.db.data('purchaseOrders/o1').invoice.payUrl).searchParams.get('t');
  const before = h.db.data('purchaseOrders/o1');
  h.db.store['purchaseOrders/o1'].status = 'cancelled';
  assert.equal(await h.inv._internal.handleOrderChange('acme', 'o1', before, h.db.data('purchaseOrders/o1')), 'voided');
  const o = h.db.data('purchaseOrders/o1');
  assert.equal(o.invoice.status, 'void');
  assert.equal(o.invoice.payUrl, null);
  await assert.rejects(h.inv.invoicePayLinkStatus({ orgId: 'acme', orderId: 'o1', t }, {}), /not valid/);
});

test('editing a price on a sent invoice re-derives the balance', async () => {
  const h = build({ seed: seed({ sendOnShip: true }), now: at('2026-09-01') });
  await ship(h);
  const before = h.db.data('purchaseOrders/o1');
  h.db.store['purchaseOrders/o1'].items = [{ qtyShipped: 5, unitPrice: 80 }];
  assert.equal(await h.inv._internal.handleOrderChange('acme', 'o1', before, h.db.data('purchaseOrders/o1')), 'recomputed');
  assert.equal(h.db.data('purchaseOrders/o1').balanceDueCents, 40000);
});

test('send invoice by hand: manager only, one email per invoice per day, failure does not burn the day', async () => {
  const failing = { n: 0 };
  const h = build({ seed: seed({}), now: at('2026-09-01'),
    sendEmail: async (m) => (failing.n++ === 0 ? { success: false, error: 'Brevo 500' } : { success: true, id: 'm2' }) });
  await ship(h);
  await assert.rejects(h.inv.invoiceSend({ orgId: 'acme', orderId: 'o1' }, h.ctx('carol')), /requires manager/);
  const r1 = await h.inv.invoiceSend({ orgId: 'acme', orderId: 'o1' }, h.ctx('dave'));
  assert.equal(r1.sent, false);
  assert.match(r1.reason, /Brevo 500/);
  const r2 = await h.inv.invoiceSend({ orgId: 'acme', orderId: 'o1' }, h.ctx('dave'));
  assert.equal(r2.sent, true, 'the failed attempt released the day');
  const r3 = await h.inv.invoiceSend({ orgId: 'acme', orderId: 'o1' }, h.ctx('dave'));
  assert.equal(r3.sent, false);
  assert.match(r3.reason, /already emailed today/);
});

test('a paid invoice is never emailed', async () => {
  const h = build({ seed: seed({}), now: at('2026-09-01') });
  await ship(h);
  await h.inv.invoiceRecordManualPayment({ orgId: 'acme', orderId: 'o1', amount: 500, method: 'check' }, h.ctx('dave'));
  const r = await h.inv.invoiceSend({ orgId: 'acme', orderId: 'o1' }, h.ctx('dave'));
  assert.equal(r.sent, false);
  assert.match(r.reason, /already paid/);
  assert.equal(h.emails.length, 0);
});

async function runDays(h, fromIso, days, hookByDay = {}) {
  const log = {};
  for (let d = 0; d < days; d++) {
    const day = addDays(fromIso, d);
    if (hookByDay[day]) await hookByDay[day]();
    for (const hour of [13, 14, 17, 20]) {           // the job runs hourly; several runs a day
      h.clock.now = at(day, hour);
      const before = h.emails.length;
      await h.inv._internal.runRemindersForOrg('acme', h.db.data('organizations/acme'));
      for (const m of h.emails.slice(before)) (log[day] = log[day] || []).push(m.subject.split(':')[0].split(' ')[0]);
    }
  }
  return log;
}

test('reminders: the right email on the right day, one a day at most, and they stop when paid', async () => {
  const h = build({ seed: seed({ sendOnShip: true, reminders: true }), now: at('2026-09-01') });
  await ship(h);                                      // invoice emailed Sep 1, due Oct 1
  const log = await runDays(h, '2026-09-01', 30);
  assert.deepEqual(log, { '2026-09-28': ['Reminder'] }, '-3 only (Sep 1 was the invoice itself)');
  const log2 = await runDays(h, '2026-10-01', 20, {
    '2026-10-10': () => h.inv.invoiceRecordManualPayment({ orgId: 'acme', orderId: 'o1', amount: 500, method: 'check' }, h.ctx('dave'))
  });
  assert.deepEqual(log2, { '2026-10-01': ['Invoice'], '2026-10-08': ['Overdue'] }, 'due today, +7, then paid on Oct 10: no +14');
  const o = h.db.data('purchaseOrders/o1');
  assert.equal(o.invoice.reminderCount, 3);
  assert.equal(o.invoice.status, 'paid');
});

test('reminders: an invoice created with its due date in the past', async () => {
  const s = seed({ sendOnShip: true, reminders: true });
  s['purchaseOrders/o1'].invoiceDate = '2026-08-01';   // due Aug 31
  const h = build({ seed: s, now: at('2026-09-28') });
  await ship(h);                                       // emailed Sep 28, already 28 days late
  const log = await runDays(h, '2026-09-28', 40);
  // Sep 29: one catch-up (+14, skipping +7); Sep 30 is +30 = final notice; then nothing more.
  assert.deepEqual(log, { '2026-09-29': ['Overdue'], '2026-09-30': ['Final'] });
});

test('reminders respect do-not-remind and remind-by-phone on the customer', async () => {
  for (const flag of ['doNotRemind', 'remindByPhone']) {
    const s = seed({ sendOnShip: true, reminders: true });
    s['customers/c1'][flag] = true;
    const h = build({ seed: s, now: at('2026-09-01') });
    await ship(h);
    const log = await runDays(h, '2026-09-25', 20);
    assert.deepEqual(log, {}, flag);
  }
});

test('reminders are off unless turned on; the manual run refuses to send and staff cannot run it', async () => {
  const h = build({ seed: seed({ sendOnShip: true, reminders: false }), now: at('2026-09-01') });
  await ship(h);
  h.clock.now = at('2026-10-08');
  await assert.rejects(h.inv.invoiceRunRemindersNow({ orgId: 'acme' }, h.ctx('alice')), /reminders are off/);
  const preview = await h.inv.invoiceRunRemindersNow({ orgId: 'acme', dryRun: true }, h.ctx('alice'));
  assert.equal(preview.plans[0].send, false);
  assert.equal(preview.plans[0].reason, 'Automatic reminders are off');
  await assert.rejects(h.inv.invoiceRunRemindersNow({ orgId: 'acme', dryRun: true }, h.ctx('dave')), /requires admin/);
  assert.equal(h.emails.length, 1, 'only the invoice itself');
});

test('the daily email cap stops sending and says so', async () => {
  const h = build({ seed: seed({ sendOnShip: true }), now: at('2026-09-01'), env: { INVOICE_EMAIL_DAILY_CAP: '1' } });
  await h.inv._internal.sendEmail({ to: ['x@y.test'], subject: 's', html: 'h' });
  assert.equal(await ship(h), 'not-sent');
  assert.equal(h.emails.length, 1);
  const log = Object.values(h.db.store).filter(v => v.action === 'INVOICE_NOT_SENT');
  assert.match(log[0].details.message, /Daily email limit/);
});
