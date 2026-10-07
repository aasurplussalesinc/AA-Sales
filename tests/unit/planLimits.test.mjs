// The plan caps live in three places: src/useTier.js (the app), functions/planLimits.js (server writers) and
// firestore.rules planCap() (the database). This keeps them identical. (Security audit 2026-10-07.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const server = require('../../functions/planLimits.js').LIMITS;
const appSrc = readFileSync(new URL('../../src/useTier.js', import.meta.url), 'utf8');
const app = Function(`return ${appSrc.slice(appSrc.indexOf('{', appSrc.indexOf('export const LIMITS')), appSrc.indexOf('};', appSrc.indexOf('export const LIMITS')) + 1)}`)();
const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');

test('app and server limits are identical', () => {
  assert.deepEqual(server, app);
});

test('firestore.rules caps match (starter, pro, business, trial)', () => {
  const row = (kind) => rules.match(new RegExp(String.raw`kind == '${kind}' \? \[([\d, ]+)\]`))?.[1].split(',').map(Number);
  const last = rules.match(/: \[([\d, ]+)\]\[planIdx\(plan\)\]\)\);/)[1].split(',').map(Number);   // locations
  const order = ['starter', 'pro', 'business', 'trial'];
  for (const kind of ['users', 'orders', 'items']) {
    assert.deepEqual(row(kind), order.map((p) => app[p][kind]), kind);
  }
  assert.deepEqual(last, order.map((p) => app[p].locations), 'locations');
  for (const p of ['enterprise', 'owner']) assert.match(rules, new RegExp(`'${p}'`));
});
