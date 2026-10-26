// Plan -> Stripe price (functions/billingPlans.js), plan matrix 2026-10-26: Business moves to new $400 / $4,000
// prices set in env, old Business prices keep mapping to 'business', Enterprise is never sold through checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const BP = require('../../functions/billingPlans.js');
const createBillingEventHandler = require('../../functions/stripeBilling.js');
const { createFakeDb, FieldValue } = require('./_fakes/fakeFirestore.cjs');

const env = {
  STRIPE_PRICE_STARTER_MONTHLY: 'price_s_m', STRIPE_PRICE_STARTER_ANNUAL: 'price_s_a',
  STRIPE_PRICE_PRO_MONTHLY: 'price_p_m', STRIPE_PRICE_PRO_ANNUAL: 'price_p_a',
  STRIPE_PRICE_BUSINESS_MONTHLY: 'price_b400_m', STRIPE_PRICE_BUSINESS_ANNUAL: 'price_b4000_a',
  STRIPE_PRICE_BUSINESS_MONTHLY_LEGACY: 'price_b350_m', STRIPE_PRICE_BUSINESS_ANNUAL_LEGACY: 'price_b3500_a',
  STRIPE_PRICE_ENTERPRISE_MONTHLY: 'price_e_m',
};

test('checkout uses the Business price ids from env (the new $400 / $4,000 ones)', () => {
  const ids = BP.priceIdsFromEnv(env);
  assert.deepEqual(BP.checkoutPrice(ids, 'Business', 'monthly'), { priceId: 'price_b400_m', plan: 'business' });
  assert.deepEqual(BP.checkoutPrice(ids, 'business', 'annual'), { priceId: 'price_b4000_a', plan: 'business' });
  assert.equal(BP.checkoutPrice(ids, 'starter', 'monthly').priceId, 'price_s_m');
  assert.equal(BP.checkoutPrice(ids, 'pro', 'annual').priceId, 'price_p_a');
});

test('Enterprise is refused at checkout even with a price configured', () => {
  const ids = BP.priceIdsFromEnv(env);
  const r = BP.checkoutPrice(ids, 'enterprise', 'monthly');
  assert.equal(r.priceId, undefined);
  assert.equal(r.error.code, 'failed-precondition');
  assert.match(r.error.message, /info@skidsling\.com/);
  assert.equal(BP.checkoutPrice(ids, 'ENTERPRISE', 'annual').error.code, 'failed-precondition');
});

test('unknown plans, bad cycles and missing prices are refused', () => {
  const ids = BP.priceIdsFromEnv(env);
  assert.equal(BP.checkoutPrice(ids, 'owner', 'monthly').error.code, 'invalid-argument');
  assert.equal(BP.checkoutPrice(ids, 'pro', 'weekly').error.code, 'invalid-argument');
  assert.match(BP.checkoutPrice(BP.priceIdsFromEnv({}), 'pro', 'monthly').error.message, /No monthly price/);
});

test('webhook map: new, legacy Business and Enterprise prices all resolve', () => {
  const map = BP.priceToPlanFromEnv(env);
  assert.deepEqual(map.price_b400_m, { plan: 'business', billingCycle: 'monthly' });
  assert.deepEqual(map.price_b4000_a, { plan: 'business', billingCycle: 'annual' });
  assert.deepEqual(map.price_b350_m, { plan: 'business', billingCycle: 'monthly' });
  assert.deepEqual(map.price_b3500_a, { plan: 'business', billingCycle: 'annual' });
  assert.deepEqual(map.price_e_m, { plan: 'enterprise', billingCycle: 'monthly' });
});

test('a subscription.updated on the new $400 price still lands as business', async () => {
  const db = createFakeDb({ 'organizations/acme': { plan: 'pro', status: 'active', stripeCustomerId: 'cus_A' } });
  const { handleBillingEvent } = createBillingEventHandler({ db, admin: { firestore: { FieldValue } }, PRICE_TO_PLAN: BP.priceToPlanFromEnv(env) });
  await handleBillingEvent({ id: 'e1', type: 'customer.subscription.updated',
    data: { object: { id: 'sub_1', customer: 'cus_A', status: 'active', items: { data: [{ price: { id: 'price_b400_m' } }] } } } });
  assert.equal(db.data('organizations/acme').plan, 'business');
  // an old $350 subscriber renewing keeps business too
  await handleBillingEvent({ id: 'e2', type: 'customer.subscription.updated',
    data: { object: { id: 'sub_1', customer: 'cus_A', status: 'active', items: { data: [{ price: { id: 'price_b350_m' } }] } } } });
  assert.equal(db.data('organizations/acme').plan, 'business');
});

test('createCheckoutSession goes through checkoutPrice', () => {
  const src = readFileSync(new URL('../../functions/index.js', import.meta.url), 'utf8');
  assert.match(src, /BILLING_PLANS\.checkoutPrice\(PRICE_IDS, plan, billingCycle\)/);
});
