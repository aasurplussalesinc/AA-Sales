// SKU 4634 (NEW) and SKU 4412 (#1) are both "PARKA PRIMALOFT GEN III FOLIAGE
// ARMY LR". The Movements page showed names only, so their histories could not
// be told apart, and the agent had no way to read stock history at all. These
// pin the helpers behind the SKU column and the get_item_history tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  stockChangeMovement, enrichMovements, itemsWithExactSku,
  movementMatchesSearch, movementTypeOptions
} from '../../src/movementHistory.js';
const H = createRequire(import.meta.url)('../../functions/itemHistory.js');

const PARKA = 'PARKA PRIMALOFT GEN III FOLIAGE ARMY LR';
const items = [
  { id: 'a', partNumber: '4634', name: PARKA, grade: 'NEW' },
  { id: 'b', partNumber: '4412', name: PARKA, grade: '#1' },
  { id: 'c', partNumber: '44', name: 'CANTEEN', grade: '' }
];
const byId = Object.fromEntries(items.map(i => [i.id, i]));

// ---- client: direct-write movements ---------------------------------------

test('a save that changes nothing on the shelves logs nothing', () => {
  const s = { stock: 10, locations: [{ code: 'W1-R1-A1', qty: 10 }] };
  assert.equal(stockChangeMovement(s, { ...s }, { type: 'ADJUST' }), null);
});

test('a quantity edit records before, after and the shelf it came off', () => {
  const mv = stockChangeMovement(
    { stock: 10, locations: [{ code: 'W1-R1-A1', qty: 10 }] },
    { stock: 7, locations: [{ code: 'W1-R1-A1', qty: 7 }] },
    { type: 'ADJUST', reason: 'Item edited' });
  assert.equal(mv.type, 'ADJUST');
  assert.equal(mv.quantity, 3);
  assert.equal(mv.beforeQty, 10);
  assert.equal(mv.afterQty, 7);
  assert.equal(mv.fromLocation, 'W1-R1-A1');
  assert.equal(mv.toLocation, '');
  assert.equal(mv.reason, 'Item edited');
});

test('a relocation with the same total is still recorded, quantity 0', () => {
  const mv = stockChangeMovement(
    { stock: 5, locations: [{ code: 'W1-R1-A1', qty: 5 }] },
    { stock: 5, locations: [{ code: 'W2-R1-A1', qty: 5 }] },
    { type: 'IMPORT' });
  assert.equal(mv.quantity, 0);
  assert.equal(mv.fromLocation, 'W1-R1-A1');
  assert.equal(mv.toLocation, 'W2-R1-A1');
});

// ---- client: display enrichment and search ---------------------------------

test('old movements get sku and grade from the item; stored values win', () => {
  const out = enrichMovements([
    { id: 1, itemId: 'a', itemName: PARKA },
    { id: 2, itemId: 'b', itemName: PARKA },
    { id: 3, itemId: 'a', itemName: PARKA, sku: '4634-OLD', grade: '' },
    { id: 4, itemId: 'gone', itemName: 'DELETED ITEM' }
  ], byId);
  assert.deepEqual(out.map(m => [m.sku, m.grade]),
    [['4634', 'NEW'], ['4412', '#1'], ['4634-OLD', ''], ['', '']]);
});

test('an exact SKU matches only that item, not every SKU containing it', () => {
  const hits = itemsWithExactSku(items, ' 44 ');
  assert.deepEqual(hits.map(i => i.id), ['c']);
  const ids = new Set(hits.map(i => i.id));
  const moves = enrichMovements([{ itemId: 'b', itemName: PARKA }, { itemId: 'c', itemName: 'CANTEEN' }], byId);
  assert.deepEqual(moves.filter(m => movementMatchesSearch(m, '44', ids)).map(m => m.itemId), ['c']);
});

test('same-named parkas are separated by SKU search', () => {
  const moves = enrichMovements([{ itemId: 'a', itemName: PARKA }, { itemId: 'b', itemName: PARKA }], byId);
  const ids = new Set(itemsWithExactSku(items, '4412').map(i => i.id));
  assert.deepEqual(moves.filter(m => movementMatchesSearch(m, '4412', ids)).map(m => m.itemId), ['b']);
  // A name search still finds both.
  assert.equal(moves.filter(m => movementMatchesSearch(m, 'parka', new Set())).length, 2);
});

test('type filter lists every known type plus anything in the data', () => {
  const t = movementTypeOptions([{ type: 'PICK' }, { type: 'WEIRD' }]);
  for (const k of ['ADJUST', 'IMPORT', 'MOVE', 'PICK', 'RECEIVE', 'RESTORE', 'WEIRD']) assert.ok(t.includes(k), k);
});

// ---- server: summary -------------------------------------------------------

test('net change uses before/after when present, else the type direction', () => {
  assert.equal(H.movementDelta({ type: 'PICK', quantity: 5 }), -5);
  assert.equal(H.movementDelta({ type: 'RECEIVE', quantity: 5 }), 5);
  assert.equal(H.movementDelta({ type: 'MOVE', quantity: 5 }), 0);
  assert.equal(H.movementDelta({ type: 'ADJUST', quantity: 2 }), -2); // legacy quick-remove
  assert.equal(H.movementDelta({ type: 'ADJUST', quantity: 2, beforeQty: 3, afterQty: 5 }), 2);
  assert.equal(H.movementDelta({ type: 'SOMETHING', quantity: 2 }), null);
});

test('a full ledger that adds up reports no mismatch', () => {
  const s = H.summarizeHistory([
    { type: 'PICK', quantity: 4 },
    { type: 'RECEIVE', quantity: 10 },
    { type: 'MOVE', quantity: 10 }
  ], 6, { coversFullHistory: true });
  assert.equal(s.netChangeFromMovements, 6);
  assert.equal(s.unexplainedDifference, 0);
  assert.deepEqual(s.byType.PICK, { count: 1, units: 4, netChange: -4 });
  assert.equal(s.byType.MOVE.netChange, 0);
});

test('an unlogged change shows as a mismatch', () => {
  const s = H.summarizeHistory([{ type: 'RECEIVE', quantity: 10 }], 25, { coversFullHistory: true });
  assert.equal(s.unexplainedDifference, 15);
  assert.match(s.note, /MISMATCH/);
});

test('a filtered or truncated ledger is never compared with the quantity', () => {
  const s = H.summarizeHistory([{ type: 'RECEIVE', quantity: 10 }], 25, { coversFullHistory: false });
  assert.equal(s.unexplainedDifference, null);
});

test('audit-log-only edits count towards the explanation', () => {
  const audit = [{ beforeQty: 10, afterQty: 25, delta: 15, timestamp: 1 }];
  const s = H.summarizeHistory([{ type: 'RECEIVE', quantity: 10 }], 25, { coversFullHistory: true, auditOnlyEdits: audit });
  assert.equal(s.netChangeFromAuditLogOnly, 15);
  assert.equal(s.unexplainedDifference, 0);
});

// ---- server: audit log vs movements ---------------------------------------

test('an audit entry that has a matching movement is not double counted', () => {
  const a = H.auditStockChange({
    timestamp: 1000, userEmail: 'MCP: agent',
    details: { itemId: 'a', updates: { stock: 7 }, before: { stock: 10 }, reason: 'damaged', source: 'mcp' }
  });
  assert.equal(a.delta, -3);
  assert.equal(H.unmatchedAuditEdits([a], [{ type: 'ADJUST', beforeQty: 10, afterQty: 7, timestamp: 1004 }]).length, 0);
  // Before this change there was no movement: it is surfaced.
  assert.equal(H.unmatchedAuditEdits([a], []).length, 1);
});

test('audit entries that did not touch the quantity are ignored', () => {
  assert.equal(H.auditStockChange({ timestamp: 1, details: { updates: { price: 5 } } }), null);
  const same = H.auditStockChange({ timestamp: 1, details: { updates: { stock: 4 }, before: { stock: 4 } } });
  assert.equal(H.unmatchedAuditEdits([same], []).length, 0);
});

// ---- server: output shape and the adjust movement --------------------------

test('formatMovement gives ISO time, ms, order number and before/after', () => {
  const f = H.formatMovement('m1', {
    type: 'PICK', quantity: 2, fromLocation: 'W1-R1-A1', userEmail: 'x@y',
    orderId: 'o1', timestamp: Date.UTC(2026, 8, 28, 12), beforeQty: 5, afterQty: 3, note: 'n'
  }, { o1: 'AA6700' });
  assert.equal(f.time, '2026-09-28T12:00:00.000Z');
  assert.equal(f.timestamp, Date.UTC(2026, 8, 28, 12));
  assert.equal(f.orderNumber, 'AA6700');
  assert.equal(f.beforeQty, 5);
  assert.equal(f.afterQty, 3);
  assert.equal(f.notes, 'n');
});

test('adjust movement carries sku/grade and measures from the shelves, not a drifted stock field', () => {
  const plan = { shelf: 'W1-R1-A1', shelfBefore: 8, shelfAfter: 5, derived: { stock: 5 } };
  const m = H.adjustMovement({ name: PARKA, partNumber: '4412', grade: '#1', stock: 0 }, 'b', 'org1', plan,
    [{ code: 'W1-R1-A1', qty: 8 }], 'damaged', 'mcp', 'MCP: agent', 123);
  assert.equal(m.orgId, 'org1');
  assert.equal(m.sku, '4412');
  assert.equal(m.grade, '#1');
  assert.equal(m.beforeQty, 8);
  assert.equal(m.afterQty, 5);
  assert.equal(m.quantity, 3);
  assert.equal(m.fromLocation, 'W1-R1-A1');
  assert.equal(H.movementDelta(m), -3);
});
