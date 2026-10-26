// Feature gates of the plan matrix approved 2026-10-26 (src/useTier.js). useTier is a React hook, so this reads
// the source: each flag's minimum plan, and featurePlan() used for upgrade prompts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../src/useTier.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
const picks = readFileSync(new URL('../../src/pages/PickLists.jsx', import.meta.url), 'utf8');
const audit = readFileSync(new URL('../../src/pages/ActivityLog.jsx', import.meta.url), 'utf8');

const flag = (name) => {
  const m = src.match(new RegExp(name + String.raw`:\s*(true|atLeast\('(\w+)'\))`));
  assert.ok(m, name + ' missing');
  return m[1] === 'true' ? 'all' : m[2];
};
const map = Function(`return ${src.slice(src.indexOf('{', src.indexOf('const map =')), src.indexOf('};', src.indexOf('const map =')) + 1)}`)();
const rank = Function(`return ${src.slice(src.indexOf('{', src.indexOf('const TIER_RANK')), src.indexOf('};', src.indexOf('const TIER_RANK')) + 1)}`)();

test('every plan: inventory, receiving, CSV, CRM, roles & audit log', () => {
  for (const f of ['canUseInventory', 'canUseQR', 'canUseCustomers', 'canUseCSV', 'canUseActivityLog', 'canUseReceiving']) {
    assert.equal(flag(f), 'all', f);
  }
});

test('Pro: orders, pick lists, packing, triwall, invoices, AI full control', () => {
  for (const f of ['canUseOrders', 'canUsePickLists', 'canUsePacking', 'canUseTriwall', 'canUseInvoices', 'canUseAIWrite']) {
    assert.equal(flag(f), 'pro', f);
  }
  for (const k of ['orders', 'pickLists', 'packing', 'triwall', 'invoices', 'aiWrite']) assert.equal(map[k], 'Pro', k);
});

test('Business: reports, voice, shipping, UPS account billing, dual insurance, contracts', () => {
  for (const f of ['canUseReports', 'canUseVoice', 'canUseShipping', 'canUseUPSAccount', 'canUseContracts',
    'canUseInternational', 'canUseBatchLabels', 'canUseAutoShipping', 'canUseThirdPartyBilling', 'canUseDualInsurance']) {
    assert.equal(flag(f), 'business', f);
  }
  for (const k of ['reports', 'voice', 'shipping', 'upsAccount', 'contracts', 'thirdPartyBilling', 'dualInsurance']) {
    assert.equal(map[k], 'Business', k);
  }
  assert.ok(!Object.values(map).includes('Enterprise'), 'nothing is Enterprise-only any more');
});

test('trial keeps Business-level features; the owner org (AA Surplus Sales) has everything', () => {
  assert.equal(rank.trial, rank.business);
  assert.ok(rank.owner > rank.enterprise);
  assert.match(src, /const atLeast = \(tier\) => isOwner \|\|/);
});

test('the gates are wired where the app uses them', () => {
  assert.match(app, /<TierGate feature="reports" requiredPlan="Business">/);
  assert.match(picks, /tier\.canUseTriwall/);
  assert.match(audit, /canUseActivityLog/);
});
