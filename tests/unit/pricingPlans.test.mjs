// The plans as sold (src/pricingPlans.js, used by the landing page and the in-app plan picker) against the
// approved matrix 2026-10-26 and the caps the app enforces (src/useTier.js LIMITS).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLANS, FOUNDERS_LINE, ENTERPRISE_MAILTO, EVERY_PLAN_LINE } from '../../src/pricingPlans.js';

const tierSrc = readFileSync(new URL('../../src/useTier.js', import.meta.url), 'utf8');
const LIMITS = Function(`return ${tierSrc.slice(tierSrc.indexOf('{', tierSrc.indexOf('export const LIMITS')), tierSrc.indexOf('};', tierSrc.indexOf('export const LIMITS')) + 1)}`)();
const byKey = Object.fromEntries(PLANS.map((p) => [p.key, p]));
const landing = readFileSync(new URL('../../src/pages/LandingPage.jsx', import.meta.url), 'utf8');
const picker = readFileSync(new URL('../../src/pages/SubscriptionRequired.jsx', import.meta.url), 'utf8');

test('prices: Starter 100, Pro 250, Business 400; annual = 10x monthly; Enterprise contact us', () => {
  assert.deepEqual(PLANS.map((p) => p.key), ['starter', 'pro', 'business', 'enterprise']);
  assert.equal(byKey.starter.monthly, 100);
  assert.equal(byKey.pro.monthly, 250);
  assert.equal(byKey.business.monthly, 400);
  for (const k of ['starter', 'pro', 'business']) assert.equal(byKey[k].annual, byKey[k].monthly * 10, k);
  assert.equal(byKey.enterprise.contact, true);
  assert.equal(byKey.enterprise.monthly, undefined);
  assert.equal(ENTERPRISE_MAILTO, 'mailto:info@skidsling.com?subject=SkidSling%20Enterprise');
});

test('limits lines match the caps the app enforces', () => {
  const fmt = (n) => n.toLocaleString('en-US');
  for (const k of ['starter', 'pro', 'business']) {
    const l = LIMITS[k];
    const want = `${l.users} users · ${fmt(l.items)} SKUs · ${l.warehouses} warehouse${l.warehouses === 1 ? '' : 's'} · Unlimited orders`;
    assert.equal(byKey[k].limits, want, k);
  }
  assert.match(byKey.enterprise.limits, /Unlimited users · Unlimited SKUs · Unlimited warehouses · Unlimited orders/);
});

test('AI lines: read-only on Starter, full control from Pro', () => {
  assert.ok(byKey.starter.features.some((f) => /AI assistant: read-only/.test(f)));
  assert.ok(byKey.pro.features.some((f) => /AI assistant: full control/.test(f)));
  assert.ok(byKey.business.service.some((f) => /AI assistant set up for you/.test(f)));
});

test('features sit on the plan the gates put them on', () => {
  const has = (k, re) => byKey[k].features.some((f) => re.test(f));
  assert.ok(has('pro', /Triwall/) && !has('business', /Triwall/));
  assert.ok(has('business', /dead stock/i) && !has('pro', /Reports/));
  assert.ok(has('business', /UPS account/) && has('business', /Dual insurance/));
  assert.ok(has('business', /Voice/) && has('business', /Blind drop-ship/));
  assert.ok(has('pro', /card \/ ACH \+ automatic reminders/));
  assert.ok(has('starter', /logo/i), 'logo branding listed');
  assert.ok(byKey.enterprise.comingSoon.some((f) => /Shopify, eBay, Squarespace/.test(f)));
  assert.ok(byKey.enterprise.comingSoon.some((f) => /Several companies under one login/.test(f)));
  assert.deepEqual(byKey.business.service.map((f) => f.replace(/^\S+\s/, '')),
    ['Done-for-you setup', 'AI assistant set up for you', 'Priority direct line']);
});

test('founders line and every-plan line are the approved wording, on both pages', () => {
  assert.equal(FOUNDERS_LINE, 'Founding customers (first 10): free done-for-you setup, AI assistant setup and a direct line, on any plan.');
  assert.match(EVERY_PLAN_LINE, /logo/);
  for (const page of [landing, picker]) {
    assert.match(page, /from '\.\.\/pricingPlans'/);
    assert.match(page, /\{FOUNDERS_LINE\}/);
    assert.match(page, /ENTERPRISE_MAILTO/);
  }
  assert.match(landing, /\$100\/mo', label: 'Starting Price'/);
  assert.match(landing, /title: 'AI Assistant'/);
  assert.match(landing, /Connect your own AI \(Claude, ChatGPT and other assistants that support connectors\) to your warehouse: ask about stock on any plan, let it run orders and invoices on Pro and up\./);
});
