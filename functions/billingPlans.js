/**
 * SkidSling subscription plans -> Stripe price ids (the platform Stripe account).
 *
 * Price ids come from functions/.env, never from code:
 *   STRIPE_PRICE_<PLAN>_MONTHLY / STRIPE_PRICE_<PLAN>_ANNUAL      the prices new checkouts use
 *   STRIPE_PRICE_BUSINESS_MONTHLY_LEGACY / _ANNUAL_LEGACY           Business before 2026-10-26 ($350 / $3,500)
 *
 * Plan matrix 2026-10-26: Starter $100, Pro $250, Business $400 ($4,000/yr), Enterprise "Contact us".
 * - Only Starter, Pro and Business can be bought online. Enterprise is sold by hand (custom price), so a
 *   checkout request for it is refused here, whatever the browser sends.
 * - The webhook maps a subscription's price back to a plan. Old Business prices (legacy env) and any
 *   Enterprise price still map, so a subscriber on an old price keeps the right plan.
 */

var SELF_SERVE_PLANS = ['starter', 'pro', 'business'];
var CYCLES = ['monthly', 'annual'];

function priceIdsFromEnv(env) {
  env = env || {};
  return {
    starter:    { monthly: env.STRIPE_PRICE_STARTER_MONTHLY,    annual: env.STRIPE_PRICE_STARTER_ANNUAL },
    pro:        { monthly: env.STRIPE_PRICE_PRO_MONTHLY,        annual: env.STRIPE_PRICE_PRO_ANNUAL },
    business:   { monthly: env.STRIPE_PRICE_BUSINESS_MONTHLY,   annual: env.STRIPE_PRICE_BUSINESS_ANNUAL },
    enterprise: { monthly: env.STRIPE_PRICE_ENTERPRISE_MONTHLY, annual: env.STRIPE_PRICE_ENTERPRISE_ANNUAL },
  };
}

/** price id -> { plan, billingCycle } for the webhook. Includes legacy Business and Enterprise prices. */
function priceToPlanFromEnv(env) {
  env = env || {};
  var out = {};
  var ids = priceIdsFromEnv(env);
  Object.keys(ids).forEach(function (plan) {
    CYCLES.forEach(function (cycle) { if (ids[plan][cycle]) out[ids[plan][cycle]] = { plan: plan, billingCycle: cycle }; });
  });
  var legacy = { monthly: env.STRIPE_PRICE_BUSINESS_MONTHLY_LEGACY, annual: env.STRIPE_PRICE_BUSINESS_ANNUAL_LEGACY };
  CYCLES.forEach(function (cycle) {
    if (legacy[cycle] && !out[legacy[cycle]]) out[legacy[cycle]] = { plan: 'business', billingCycle: cycle };
  });
  return out;
}

/**
 * The price a new checkout uses. Returns { priceId } or { error: { code, message } } with an HttpsError code.
 */
function checkoutPrice(priceIds, plan, billingCycle) {
  var p = String(plan || '').toLowerCase();
  if (CYCLES.indexOf(billingCycle) === -1) {
    return { error: { code: 'invalid-argument', message: 'Invalid billingCycle: ' + billingCycle } };
  }
  if (p === 'enterprise') {
    return { error: { code: 'failed-precondition',
      message: 'Enterprise is set up with our team. Email info@skidsling.com and we will get you started.' } };
  }
  if (SELF_SERVE_PLANS.indexOf(p) === -1) {
    return { error: { code: 'invalid-argument', message: 'Unknown plan: ' + plan } };
  }
  var id = priceIds[p] && priceIds[p][billingCycle];
  if (!id) return { error: { code: 'invalid-argument', message: 'No ' + billingCycle + ' price configured for plan: ' + plan } };
  return { priceId: id, plan: p };
}

module.exports = {
  SELF_SERVE_PLANS: SELF_SERVE_PLANS,
  priceIdsFromEnv: priceIdsFromEnv,
  priceToPlanFromEnv: priceToPlanFromEnv,
  checkoutPrice: checkoutPrice,
};
