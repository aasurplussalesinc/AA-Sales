// The plan caps live in three places: src/useTier.js (the app), functions/planLimits.js (server writers) and
// firestore.rules planCap() (the database). This keeps them identical. (Security audit 2026-10-07; plan matrix
// 2026-10-26: orders unlimited everywhere, Starter 5,000 SKUs, warehouse cap enforced on the server.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PLAN = require('../../functions/planLimits.js');
const server = PLAN.LIMITS;
const { createFakeDb } = require('./_fakes/fakeFirestore.cjs');
const appSrc = readFileSync(new URL('../../src/useTier.js', import.meta.url), 'utf8');
const app = Function(`return ${appSrc.slice(appSrc.indexOf('{', appSrc.indexOf('export const LIMITS')), appSrc.indexOf('};', appSrc.indexOf('export const LIMITS')) + 1)}`)();
const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');

test('app and server limits are identical', () => {
  assert.deepEqual(server, app);
});

test('the approved matrix (2026-10-26)', () => {
  const pick = (p) => ({ users: app[p].users, items: app[p].items, warehouses: app[p].warehouses });
  assert.deepEqual(pick('starter'),  { users: 2,  items: 5000,  warehouses: 1 });
  assert.deepEqual(pick('pro'),      { users: 5,  items: 10000, warehouses: 3 });
  assert.deepEqual(pick('business'), { users: 15, items: 50000, warehouses: 10 });
  for (const p of ['enterprise', 'owner']) {
    assert.deepEqual(app[p], { users: null, orders: null, items: null, warehouses: null, locations: null }, p);
  }
  // trial keeps its own limits, minus the order cap
  assert.deepEqual(app.trial, { users: 15, orders: null, items: 10000, warehouses: 2, locations: 500 });
});

test('orders are unlimited on every plan, and the rules no longer cap them', () => {
  for (const p of Object.keys(app)) assert.equal(app[p].orders, null, p);
  assert.equal(PLAN.limitFor('starter', 'orders'), null);
  assert.doesNotMatch(rules, /kind == 'orders'/);
  assert.doesNotMatch(rules, /hasRoom\([^)]*'orders'\)/);
});

test('firestore.rules caps match (starter, pro, business, trial)', () => {
  const row = (kind) => rules.match(new RegExp(String.raw`kind == '${kind}' \? \[([\d, ]+)\]`))?.[1].split(',').map(Number);
  const last = rules.match(/: \[([\d, ]+)\]\[planIdx\(plan\)\]\)\);/)[1].split(',').map(Number);   // locations
  const order = ['starter', 'pro', 'business', 'trial'];
  for (const kind of ['users', 'items', 'warehouses']) {
    assert.deepEqual(row(kind), order.map((p) => app[p][kind]), kind);
  }
  assert.deepEqual(last, order.map((p) => app[p].locations), 'locations');
  for (const p of ['enterprise', 'owner']) assert.match(rules, new RegExp(`'${p}'`));
});

test('assertUnderLimit never refuses an order', async () => {
  const db = createFakeDb({ 'organizations/s': { plan: 'starter', usage: { orders: 9999 } } });
  await PLAN.assertUnderLimit(db, 's', 'orders', (m) => new Error(m));   // resolves
});

// ---- warehouse list kept for the rules (2026-10-26) ----
const seed = () => ({
  'organizations/o': { plan: 'starter' },
  'locations/l1': { orgId: 'o', warehouse: 'W1', locationCode: 'W1-R1-A1' },
  'locations/l2': { orgId: 'o', warehouse: 'W1', locationCode: 'W1-R1-A2' },
  'locations/l3': { orgId: 'o', warehouse: 'W2', locationCode: 'W2-R1-A1' },
  'locations/st': { orgId: 'o', isStaging: true, warehouse: '', locationCode: 'STAGING' },
  'locations/x':  { orgId: 'other', warehouse: 'W9' },
});

test('recountWarehouses: distinct first-level values, STAGING and other orgs excluded', async () => {
  const db = createFakeDb(seed());
  assert.deepEqual(await PLAN.recountWarehouses(db, 'o'), ['W1', 'W2']);
  assert.deepEqual(db.data('organizations/o').usage, { warehouseKey: 'warehouse', warehouseKeys: ['W1', 'W2'], warehouses: 2 });
});

test('recountWarehouses follows a custom location schema', async () => {
  const db = createFakeDb({
    'organizations/o': { plan: 'pro', locationSchema: { levels: [{ key: 'site' }, { key: 'aisle' }] } },
    'locations/a': { orgId: 'o', site: 'North', aisle: '1' },
    'locations/b': { orgId: 'o', site: 'South', aisle: '1' },
  });
  assert.deepEqual(await PLAN.recountWarehouses(db, 'o'), ['North', 'South']);
  assert.equal(db.data('organizations/o').usage.warehouseKey, 'site');
});

test('syncWarehouses: first run recounts; a shelf in a known warehouse writes nothing', async () => {
  const db = createFakeDb(seed());
  assert.deepEqual(await PLAN.syncWarehouses(db, 'o', null, { orgId: 'o', warehouse: 'W1' }), ['W1', 'W2']);
  const writes = db.writes.length;
  assert.deepEqual(await PLAN.syncWarehouses(db, 'o', null, { orgId: 'o', warehouse: 'W2' }), ['W1', 'W2']);
  assert.equal(db.writes.length, writes, 'no write when nothing changed');
});

test('syncWarehouses: a new warehouse is added, and dropped again when its last shelf goes', async () => {
  const db = createFakeDb(seed());
  await PLAN.recountWarehouses(db, 'o');
  await db.collection('locations').doc('l4').set({ orgId: 'o', warehouse: 'W3' });
  assert.deepEqual(await PLAN.syncWarehouses(db, 'o', null, { orgId: 'o', warehouse: 'W3' }), ['W1', 'W2', 'W3']);
  await db.collection('locations').doc('l4').delete();
  assert.deepEqual(await PLAN.syncWarehouses(db, 'o', { orgId: 'o', warehouse: 'W3' }, null), ['W1', 'W2']);
  // W1 still has a shelf, so deleting one W1 shelf keeps it
  await db.collection('locations').doc('l1').delete();
  assert.deepEqual(await PLAN.syncWarehouses(db, 'o', { orgId: 'o', warehouse: 'W1' }, null), ['W1', 'W2']);
  assert.equal(db.data('organizations/o').usage.warehouses, 2);
});

test('syncWarehouses: moving the only W2 shelf to W5 swaps them', async () => {
  const db = createFakeDb(seed());
  await PLAN.recountWarehouses(db, 'o');
  await db.collection('locations').doc('l3').set({ orgId: 'o', warehouse: 'W5' });
  assert.deepEqual(await PLAN.syncWarehouses(db, 'o', { orgId: 'o', warehouse: 'W2' }, { orgId: 'o', warehouse: 'W5' }), ['W1', 'W5']);
});

test('assertUnderLimit enforces the warehouse cap for server writers', async () => {
  const db = createFakeDb(seed());   // starter = 1 warehouse, it already has 2
  await assert.rejects(PLAN.assertUnderLimit(db, 'o', 'warehouses', (m) => new Error(m)), /1 warehouses/);
});
