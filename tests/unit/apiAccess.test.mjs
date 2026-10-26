// AI assistant access (plan matrix 2026-10-26, functions/apiAccess.js + functions/mcp.js):
//  - Starter (below Pro) keys are read-only whatever was stored; orders / invoices need Pro+
//  - writes need a write key AND Pro+; owner and trial count as Pro+
//  - MCP instructions name the key's own organization; AA's conventions are AA's default notes only
//  - a per-key hourly safety limit answers 429
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const ACCESS = require('../../functions/apiAccess.js');
const createMcp = require('../../functions/mcp.js');
const { createFakeDb, FieldValue } = require('./_fakes/fakeFirestore.cjs');
const { fakeFunctions } = require('./_fakes/invoicingHarness.cjs');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const NOW = Date.UTC(2026, 9, 26, 15, 20);   // 15:20 UTC
const HOUR = Math.floor(NOW / 3600000);

const seed = () => ({
  'organizations/starterco': { name: 'Starter Co', plan: 'starter' },
  'organizations/proco': { name: 'Pro Co', plan: 'pro', aiNotes: 'Bins are labelled by colour.' },
  'organizations/expiredco': { name: 'Gone Co', plan: 'expired' },
  'organizations/aa-surplus-sales': { name: 'AA Surplus Sales Inc.', plan: 'owner' },
  'apiKeys/k_starter_w': { orgId: 'starterco', scope: 'write', keyHash: sha('sk_rw_starter'), label: 'starter write', revoked: false },
  'apiKeys/k_pro_r': { orgId: 'proco', scope: 'read', keyHash: sha('sk_ro_pro'), label: 'pro read', revoked: false },
  'apiKeys/k_pro_w': { orgId: 'proco', scope: 'write', keyHash: sha('sk_rw_pro'), label: 'pro write', revoked: false },
  'apiKeys/k_expired_w': { orgId: 'expiredco', scope: 'write', keyHash: sha('sk_rw_gone'), label: 'gone', revoked: false },
  'apiKeys/k_aa': { orgId: 'aa-surplus-sales', scope: 'write', keyHash: sha('sk_rw_aa'), label: 'aa', revoked: false },
  'apiKeys/k_busy': { orgId: 'proco', scope: 'write', keyHash: sha('sk_rw_busy'), label: 'busy', revoked: false,
    rateHour: HOUR, rateHourCount: ACCESS.RATE_LIMIT_PER_HOUR },
  'apiKeys/k_old': { orgId: 'proco', scope: 'read', keyHash: sha('sk_ro_old'), label: 'old hour', revoked: false,
    rateHour: HOUR - 1, rateHourCount: ACCESS.RATE_LIMIT_PER_HOUR },
  'items/i1': { orgId: 'starterco', partNumber: '100', name: 'Widget', stock: 4, locations: [{ code: 'W1-R1-A1', qty: 4 }] },
  'items/p1': { orgId: 'proco', partNumber: '200', name: 'Gadget', stock: 5, locations: [{ code: 'W1-R1-A1', qty: 5 }] },
  'purchaseOrders/o1': { orgId: 'starterco', poNumber: 'S1', status: 'draft', items: [] },
});

function setup() {
  const db = createFakeDb(seed());
  const resolveApiKey = ACCESS.makeResolveApiKey({ db, FieldValue, sha256Hex: sha, now: () => NOW });
  const handler = createMcp({ functions: fakeFunctions(), db, publicItem: (id, d) => ({ id, sku: d.partNumber, name: d.name, quantity: d.stock, locations: d.locations || [] }), resolveApiKey });
  async function rpc(key, method, params) {
    const req = { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params: params || {} },
      get: (h) => (h === 'Authorization' ? 'Bearer ' + key : undefined) };
    let out, status = 200;
    const headers = {};
    const res = { set(k, v) { headers[k] = v; return this; }, status(c) { status = c; return this; },
      json(b) { out = b; return this; }, send() { return this; } };
    await handler(req, res);
    return { status, out, headers };
  }
  async function tool(key, name, args) {
    const r = await rpc(key, 'tools/call', { name, arguments: args || {} });
    const text = r.out.result.content[0].text;
    return { isError: r.out.result.isError, body: JSON.parse(text) };
  }
  return { db, resolveApiKey, rpc, tool };
}

test('effective scope: write only for write keys on Pro or higher', () => {
  assert.equal(ACCESS.effectiveScope('starter', 'write'), 'read');
  assert.equal(ACCESS.effectiveScope('expired', 'write'), 'read');
  assert.equal(ACCESS.effectiveScope('pro', 'write'), 'write');
  assert.equal(ACCESS.effectiveScope('pro', 'read'), 'read');
  for (const p of ['trial', 'business', 'enterprise', 'owner']) assert.equal(ACCESS.effectiveScope(p, 'write'), 'write', p);
  assert.equal(ACCESS.effectiveScope(undefined, 'write'), 'write', 'no plan field = trial, as in the app');
});

test('resolveApiKey reads the plan from the org and downgrades a Starter write key', async () => {
  const { resolveApiKey } = setup();
  const a = await resolveApiKey('Bearer sk_rw_starter');
  assert.equal(a.plan, 'starter');
  assert.equal(a.storedScope, 'write');
  assert.equal(a.scope, 'read');
  assert.equal(a.orgName, 'Starter Co');
  const b = await resolveApiKey('Bearer sk_rw_pro');
  assert.equal(b.scope, 'write');
  assert.equal(await resolveApiKey('Bearer nope'), null);
});

test('Starter: tools/list shows only read-only inventory tools', async () => {
  const { rpc } = setup();
  const names = (await rpc('sk_rw_starter', 'tools/list')).out.result.tools.map((t) => t.name);
  for (const n of [...ACCESS.PRO_TOOLS, ...ACCESS.WRITE_TOOLS]) assert.ok(!names.includes(n), n + ' hidden');
  for (const n of ['search_items', 'get_item', 'list_locations', 'search_customers', 'get_item_history']) assert.ok(names.includes(n), n);
});

test('Starter: reads work, every order / invoice / write tool is refused with an upgrade hint', async () => {
  const { tool, db } = setup();
  const ok = await tool('sk_rw_starter', 'get_item', { itemId: 'i1' });
  assert.equal(ok.isError, false);
  for (const [name, args] of [
    ['adjust_item_quantity', { itemId: 'i1', delta: 1, reason: 'x' }],
    ['create_item', { name: 'New', reason: 'x' }],
    ['create_draft_order', { customerName: 'C', lines: [{ description: 'x', quantity: 1 }] }],
    ['update_draft_order', { orderId: 'o1', notes: 'x' }],
    ['list_orders', {}], ['list_open_invoices', {}], ['get_order_document', { orderId: 'o1' }],
  ]) {
    const r = await tool('sk_rw_starter', name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.body.error, /Pro plan or higher/, name);
    assert.match(r.body.error, /Starter/, name);
  }
  assert.equal(db.data('items/i1').stock, 4, 'nothing changed');
});

test('an expired org is read-only too', async () => {
  const { tool } = setup();
  const r = await tool('sk_rw_gone', 'adjust_item_quantity', { itemId: 'x', delta: 1, reason: 'x' });
  assert.match(r.body.error, /Pro plan or higher/);
});

test('Pro: a read key can read orders but not write; a write key adjusts stock', async () => {
  const { tool, db } = setup();
  assert.equal((await tool('sk_ro_pro', 'list_orders')).isError, false);
  const ro = await tool('sk_ro_pro', 'adjust_item_quantity', { itemId: 'p1', delta: 1, reason: 'count' });
  assert.equal(ro.isError, true);
  assert.match(ro.body.error, /read-only/);
  assert.doesNotMatch(ro.body.error, /Alan/);
  const rw = await tool('sk_rw_pro', 'adjust_item_quantity', { itemId: 'p1', delta: 2, reason: 'count' });
  assert.equal(rw.isError, false, JSON.stringify(rw.body));
  assert.equal(db.data('items/p1').stock, 7);
});

test('instructions name the key\'s own organization; AA notes only for AA', async () => {
  const { rpc } = setup();
  const init = async (key) => (await rpc(key, 'initialize', { protocolVersion: '2025-06-18' })).out.result.instructions;
  const pro = await init('sk_rw_pro');
  assert.match(pro, /^SkidSling inventory for Pro Co\./);
  assert.match(pro, /Bins are labelled by colour\./);
  assert.doesNotMatch(pro, /AA Surplus|military|#1 \(good used\)|W4-R1-F2/);
  const starter = await init('sk_rw_starter');
  assert.match(starter, /^SkidSling inventory for Starter Co\./);
  assert.match(starter, /cannot change anything/);
  assert.doesNotMatch(starter, /AA Surplus|military|#1 \(good used\)/);
  const aa = await init('sk_rw_aa');
  assert.match(aa, /^SkidSling inventory for AA Surplus Sales Inc\./);
  assert.match(aa, /military surplus wholesaler/);
  assert.match(aa, /#1 \(good used\)/);
  assert.match(aa, /W4-R1-F2/);
});

test('aiNotes: an org\'s saved notes win, an empty value clears AA\'s default', () => {
  assert.equal(ACCESS.aiNotesFor('aa-surplus-sales', {}), ACCESS.AA_DEFAULT_NOTES);
  assert.equal(ACCESS.aiNotesFor('aa-surplus-sales', { aiNotes: '' }), '');
  assert.equal(ACCESS.aiNotesFor('aa-surplus-sales', { aiNotes: 'Mine' }), 'Mine');
  assert.equal(ACCESS.aiNotesFor('acme', {}), '');
  assert.equal(ACCESS.aiNotesFor('acme', { aiNotes: 'x'.repeat(9000) }).length, ACCESS.MAX_AI_NOTES);
});

test('rate limit: a key at the hourly cap gets a clear 429; a new hour starts over', async () => {
  const { rpc, db } = setup();
  const busy = await rpc('sk_rw_busy', 'tools/list');
  assert.equal(busy.status, 429);
  assert.match(busy.out.error_description, /3000 requests/);
  assert.ok(Number(busy.headers['Retry-After']) > 0);
  assert.equal(db.data('apiKeys/k_busy').rateHourCount, ACCESS.RATE_LIMIT_PER_HOUR, 'a refused call is not counted');
  const fresh = await rpc('sk_ro_old', 'tools/list');
  assert.equal(fresh.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(db.data('apiKeys/k_old').rateHour, HOUR);
  assert.equal(db.data('apiKeys/k_old').rateHourCount, 1);
});

test('rate limit: the counter climbs within the hour and stops at the cap', async () => {
  const db = createFakeDb({ 'organizations/o': { plan: 'pro' },
    'apiKeys/k': { orgId: 'o', scope: 'read', keyHash: sha('sk_ro_k'), revoked: false } });
  const resolve = ACCESS.makeResolveApiKey({ db, FieldValue, sha256Hex: sha, now: () => NOW });
  for (let i = 0; i < 3; i++) { await resolve('Bearer sk_ro_k'); await new Promise((r) => setImmediate(r)); }
  assert.equal(db.data('apiKeys/k').rateHourCount, 3);
  assert.equal(db.data('apiKeys/k').callCount, 3);
  const r = ACCESS.rateCheck({ rateHour: HOUR, rateHourCount: 2999 }, NOW);
  assert.equal(r.allowed, true);
  assert.equal(ACCESS.rateCheck({ rateHour: HOUR, rateHourCount: 3000 }, NOW).allowed, false);
  assert.equal(ACCESS.rateCheck({ rateHour: HOUR, rateHourCount: 3000 }, NOW).retryAfterSeconds, 40 * 60);
});

test('REST: order and invoice routes and all writes need Pro; writes need a write key', () => {
  const starter = ACCESS.applyPlan({ scope: 'write', orgId: 's' }, { plan: 'starter', name: 'S' });
  const proRead = ACCESS.applyPlan({ scope: 'read', orgId: 'p' }, { plan: 'pro' });
  const proWrite = ACCESS.applyPlan({ scope: 'write', orgId: 'p' }, { plan: 'pro' });
  assert.equal(ACCESS.restBlock('GET', '/items', starter), null);
  assert.equal(ACCESS.restBlock('GET', '/customers', starter), null);
  for (const [m, p] of [['GET', '/orders'], ['GET', '/orders/o1/document'], ['POST', '/orders'], ['PATCH', '/orders/o1'],
    ['POST', '/items/i1/adjust'], ['GET', '/diagnostics/stock-deduction']]) {
    assert.equal(ACCESS.restBlock(m, p, starter).status, 403, m + ' ' + p);
  }
  assert.equal(ACCESS.restBlock('GET', '/orders', proRead), null);
  assert.match(ACCESS.restBlock('POST', '/orders', proRead).message, /read-only/);
  assert.equal(ACCESS.restBlock('POST', '/orders', proWrite), null);
});

test('Settings shows the same AA default notes the server uses', async () => {
  const ui = await import('../../src/aiNotesDefaults.js');
  assert.equal(ui.AA_DEFAULT_AI_NOTES, ACCESS.AA_DEFAULT_NOTES);
  assert.equal(ui.MAX_AI_NOTES, ACCESS.MAX_AI_NOTES);
});
