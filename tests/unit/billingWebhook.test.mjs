// Regression guard for SkidSling's OWN subscription billing. Invoicing
// (Stripe Connect) was added beside it on the same platform Stripe account, and
// Alan's rule is that subscription billing must not change. The event handling
// moved from inline in stripeWebhook to functions/stripeBilling.js unchanged;
// these pin exactly what each subscription event writes, and that events from
// connected accounts (a tenant's customers paying invoices) write nothing here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const createBillingEventHandler = require('../../functions/stripeBilling.js');
const { createFakeDb, FieldValue } = require('./_fakes/fakeFirestore.cjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', '..', p), 'utf8');

const PRICE_TO_PLAN = {
  price_pro_m: { plan: 'pro', billingCycle: 'monthly' },
  price_biz_a: { plan: 'business', billingCycle: 'annual' }
};
function setup() {
  const db = createFakeDb({
    'organizations/acme': { name: 'Acme', plan: 'trial', status: 'active', stripeCustomerId: 'cus_A',
      payments: { enabled: true, stripeAccountId: 'acct_T' } },
    'organizations/other': { name: 'Other', plan: 'pro', status: 'active', stripeCustomerId: 'cus_B' }
  });
  const admin = { firestore: { FieldValue } };
  const { handleBillingEvent } = createBillingEventHandler({ db, admin, PRICE_TO_PLAN });
  return { db, handleBillingEvent };
}
const ev = (type, object, extra = {}) => ({ id: 'evt_' + type, type, data: { object }, ...extra });

test('checkout.session.completed activates the plan exactly as before', async () => {
  const { db, handleBillingEvent } = setup();
  await handleBillingEvent(ev('checkout.session.completed', {
    metadata: { orgId: 'acme', plan: 'pro', billingCycle: 'annual' }, subscription: 'sub_1', customer: 'cus_A'
  }));
  assert.equal(db.writes.length, 1);
  assert.deepEqual(db.writes[0], { op: 'update', path: 'organizations/acme', data: {
    plan: 'pro', billingCycle: 'annual', status: 'active', stripeSubscriptionId: 'sub_1',
    stripeCustomerId: 'cus_A', subscriptionStartedAt: { __sentinel: 'serverTimestamp' }, trialEndsAt: null } });
});

test('checkout.session.completed defaults the cycle to monthly and ignores sessions without a plan', async () => {
  const { db, handleBillingEvent } = setup();
  await handleBillingEvent(ev('checkout.session.completed', { metadata: { orgId: 'acme', plan: 'pro' }, subscription: 's', customer: 'cus_A' }));
  assert.equal(db.writes[0].data.billingCycle, 'monthly');
  await handleBillingEvent(ev('checkout.session.completed', { metadata: { orgId: 'acme' }, subscription: 's', customer: 'cus_A' }));
  assert.equal(db.writes.length, 1);
});

test('customer.subscription.updated maps the price back to plan and cycle', async () => {
  const { db, handleBillingEvent } = setup();
  await handleBillingEvent(ev('customer.subscription.updated', {
    id: 'sub_9', customer: 'cus_A', status: 'active', items: { data: [{ price: { id: 'price_biz_a' } }] }
  }));
  assert.deepEqual(db.writes, [{ op: 'update', path: 'organizations/acme',
    data: { stripeSubscriptionId: 'sub_9', status: 'active', plan: 'business', billingCycle: 'annual' } }]);
});

test('customer.subscription.updated with an unknown price keeps the plan and passes the status through', async () => {
  const { db, handleBillingEvent } = setup();
  await handleBillingEvent(ev('customer.subscription.updated', {
    id: 'sub_9', customer: 'cus_B', status: 'past_due', items: { data: [{ price: { id: 'price_unknown' } }] }
  }));
  assert.deepEqual(db.writes, [{ op: 'update', path: 'organizations/other',
    data: { stripeSubscriptionId: 'sub_9', status: 'past_due' } }]);
});

test('customer.subscription.deleted expires the org', async () => {
  const { db, handleBillingEvent } = setup();
  await handleBillingEvent(ev('customer.subscription.deleted', { id: 'sub_9', customer: 'cus_A' }));
  assert.deepEqual(db.writes, [{ op: 'update', path: 'organizations/acme',
    data: { plan: 'expired', status: 'cancelled', stripeSubscriptionId: null } }]);
});

test('invoice.payment_failed marks past_due; payment_succeeded only reactivates on a cycle renewal', async () => {
  const { db, handleBillingEvent } = setup();
  await handleBillingEvent(ev('invoice.payment_failed', { customer: 'cus_A' }));
  await handleBillingEvent(ev('invoice.payment_succeeded', { customer: 'cus_A', billing_reason: 'subscription_create' }));
  await handleBillingEvent(ev('invoice.payment_succeeded', { customer: 'cus_A', billing_reason: 'subscription_cycle' }));
  assert.deepEqual(db.writes, [
    { op: 'update', path: 'organizations/acme', data: { status: 'past_due' } },
    { op: 'update', path: 'organizations/acme', data: { status: 'active' } }
  ]);
});

test('events for an unknown Stripe customer write nothing', async () => {
  const { db, handleBillingEvent } = setup();
  await handleBillingEvent(ev('customer.subscription.deleted', { id: 's', customer: 'cus_nobody' }));
  await handleBillingEvent(ev('invoice.payment_failed', { customer: 'cus_nobody' }));
  assert.equal(db.writes.length, 0);
});

test('connected-account events are ignored: a tenant customer paying an invoice never touches a plan', async () => {
  const { db, handleBillingEvent } = setup();
  const acct = { account: 'acct_T' };
  const r = await handleBillingEvent(ev('checkout.session.completed', {
    metadata: { orgId: 'acme', plan: 'enterprise', orderId: 'po1' }, subscription: null, customer: 'cus_A'
  }, acct));
  assert.equal(r.ignored, 'connected-account event');
  await handleBillingEvent(ev('invoice.payment_failed', { customer: 'cus_A' }, acct));
  await handleBillingEvent(ev('customer.subscription.deleted', { id: 's', customer: 'cus_A' }, acct));
  assert.equal(db.writes.length, 0);
  assert.equal(db.data('organizations/acme').plan, 'trial');
});

test('stripeWebhook still uses the subscription key and secret; invoicing never does', () => {
  const index = read('functions/index.js');
  assert.match(index, /const stripe = require\('stripe'\)\(process\.env\.STRIPE_SECRET_KEY\);/);
  assert.match(index, /const webhookSecret = process\.env\.STRIPE_WEBHOOK_SECRET;/);
  assert.match(index, /event = stripe\.webhooks\.constructEvent\(req\.rawBody, sig, webhookSecret\);/);
  assert.match(index, /await BILLING\.handleBillingEvent\(event\);/);
  for (const f of ['functions/invoicing.js', 'functions/invoicingCore.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /process\.env\.STRIPE_SECRET_KEY|process\.env\.STRIPE_WEBHOOK_SECRET|STRIPE_PRICE_/, f);
    // Invoicing may mention the billing fields in comments, never write them.
    assert.doesNotMatch(src, /stripeCustomerId\s*:|stripeSubscriptionId\s*:|['"]stripeCustomerId['"]|['"]stripeSubscriptionId['"]/, f);
    assert.doesNotMatch(src, /\bplan\s*:\s*['"]/, f);
  }
});
