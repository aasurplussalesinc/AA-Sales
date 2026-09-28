// SKU 4634 ended up ~10 units high: 19 after the Aug 25 import, 21 on Aug 28,
// ~29 before Sep 10, most likely an order restore adding back stock that had
// already gone back (or had never been taken). Restores added onto `stock`
// alone (a string stock concatenates), ignored the shelves, and had no memory
// of an earlier restore. These pin the pure rules behind the fixes: restores
// come from the order's PICK movements minus its RESTORE movements, counts set
// a shelf, adjustments keep stock == sum(locations).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  toQty, cleanEntries, sumEntries, seedUnshelved, addAtShelf, removeFromShelf,
  applyCount, planQuickAdjust, planOrderRestore, restoreShelf, unitsPicked
} from '../../src/stockLedger.js';
import { stockChangeMovement } from '../../src/movementHistory.js';
const H = createRequire(import.meta.url)('../../functions/itemHistory.js');

const ORDER = 'po-1';
const pick = (itemId, shelf, before, after, t, extra = {}) => ({
  type: 'PICK', orderId: ORDER, itemId, itemName: 'PARKA', sku: '4634', grade: 'NEW',
  fromLocation: shelf, quantity: before - after, beforeQty: before, afterQty: after, timestamp: t, ...extra
});
const restore = (itemId, shelf, before, after, t, extra = {}) => ({
  type: 'RESTORE', orderId: ORDER, itemId, toLocation: shelf, pickShelf: shelf,
  quantity: after - before, beforeQty: before, afterQty: after, timestamp: t, ...extra
});

// ---- numeric safety ------------------------------------------------------

test('toQty: string stock is numeric, NaN and junk are 0', () => {
  assert.equal(toQty('19'), 19);
  assert.equal(toQty(' 21 '), 21);
  assert.equal(toQty('abc'), 0);
  assert.equal(toQty(undefined), 0);
  assert.equal(toQty(null), 0);
  assert.equal(toQty(NaN), 0);
  assert.equal(toQty(Infinity), 0);
  assert.equal(toQty(7.9), 7);
});

test('THE BUG: a string stock plus a restore adds, never concatenates', () => {
  // (dbItem.stock || 0) + qty with stock "19" gave "1910".
  const r = addAtShelf([{ code: 'W4-R1-F2', qty: '19' }], 'W4-R1-F2', '10');
  assert.equal(r.after, 29);
  assert.equal(r.entries[0].qty, 29);
  assert.equal(typeof r.entries[0].qty, 'number');
});

test('cleanEntries merges duplicates, drops blanks and qty <= 0, reads old shape', () => {
  const c = cleanEntries([
    { code: 'A', qty: '3' }, { code: 'A', qty: 2 }, { code: '', qty: 5 },
    { code: 'B', qty: 0 }, { code: 'C', qty: -4 }, { location: 'D', quantity: '6' }
  ]);
  assert.deepEqual(c, [{ code: 'A', qty: 5 }, { code: 'D', qty: 6 }]);
  assert.equal(sumEntries(c), 11);
});

// ---- counts ----------------------------------------------------------------

test('count sets the shelf and recomputes the total from all shelves', () => {
  const r = applyCount([{ code: 'A', qty: 10 }, { code: 'B', qty: 5 }], 'A', 7);
  assert.deepEqual(r.entries, [{ code: 'A', qty: 7 }, { code: 'B', qty: 5 }]);
  assert.equal(r.before, 15);
  assert.equal(r.after, 12);
  assert.equal(r.shelfBefore, 10);
  assert.equal(r.shelfAfter, 7);
  assert.equal(r.changed, true);
});

test('count of 0 drops the shelf entry', () => {
  const r = applyCount([{ code: 'A', qty: 10 }, { code: 'B', qty: 5 }], 'A', 0);
  assert.deepEqual(r.entries, [{ code: 'B', qty: 5 }]);
  assert.equal(r.after, 5);
});

test('count at a shelf the item is not listed on adds it', () => {
  const r = applyCount([{ code: 'A', qty: 4 }], 'W2-R1-C3', '6');
  assert.deepEqual(r.entries, [{ code: 'A', qty: 4 }, { code: 'W2-R1-C3', qty: 6 }]);
  assert.equal(r.shelfBefore, 0);
  assert.equal(r.after, 10);
});

test('count equal to what is there is not a change; negative counts are 0', () => {
  assert.equal(applyCount([{ code: 'A', qty: 4 }], 'A', 4).changed, false);
  const r = applyCount([{ code: 'A', qty: 4 }], 'A', -3);
  assert.deepEqual(r.entries, []);
  assert.equal(r.after, 0);
});

// ---- shelf-aware adjust ----------------------------------------------------

const invariant = (r) => assert.equal(r.after, sumEntries(r.entries));

test('quick add with no shelf goes to STAGING and keeps stock == sum(locations)', () => {
  const r = planQuickAdjust([{ code: 'A', qty: 3 }], { type: 'add', qty: 5, stock: 3 });
  assert.deepEqual(r.entries, [{ code: 'A', qty: 3 }, { code: 'STAGING', qty: 5 }]);
  assert.equal(r.before, 3);
  assert.equal(r.after, 8);
  assert.equal(r.toLocation, 'STAGING');
  invariant(r);
});

test('quick add to a chosen shelf', () => {
  const r = planQuickAdjust([{ code: 'A', qty: 3 }], { type: 'add', qty: '2', shelf: 'A', stock: '3' });
  assert.deepEqual(r.entries, [{ code: 'A', qty: 5 }]);
  invariant(r);
});

test('quick remove with no shelf takes the primary shelf first, then spills', () => {
  const r = planQuickAdjust([{ code: 'A', qty: 2 }, { code: 'B', qty: 6 }], { type: 'remove', qty: 7, stock: 8 });
  assert.deepEqual(r.taken, [{ code: 'B', qty: 6 }, { code: 'A', qty: 1 }]);
  assert.deepEqual(r.entries, [{ code: 'A', qty: 1 }]);
  assert.equal(r.after, 1);
  assert.equal(r.removed, 7);
  invariant(r);
});

test('quick remove never goes below zero', () => {
  const r = planQuickAdjust([{ code: 'A', qty: 2 }], { type: 'remove', qty: 9, stock: 2 });
  assert.equal(r.after, 0);
  assert.equal(r.removed, 2);
  assert.deepEqual(r.entries, []);
  invariant(r);
});

test('remove from a named shelf stops at that shelf without spill', () => {
  const r = removeFromShelf([{ code: 'A', qty: 2 }, { code: 'B', qty: 6 }], 'A', 5);
  assert.equal(r.removed, 2);
  assert.deepEqual(r.entries, [{ code: 'B', qty: 6 }]);
  invariant(r);
});

test('unshelved stock is placed in STAGING before a write, never dropped', () => {
  // stock 10 with no shelf: re-deriving stock from shelves would make it 5.
  const r = planQuickAdjust([], { type: 'add', qty: 5, shelf: 'W1-R1-A1', stock: '10' });
  assert.equal(r.seeded, 10);
  assert.equal(r.before, 10);
  assert.equal(r.after, 15);
  assert.deepEqual(r.entries, [{ code: 'STAGING', qty: 10 }, { code: 'W1-R1-A1', qty: 5 }]);
  invariant(r);
  assert.deepEqual(seedUnshelved([{ code: 'A', qty: 1 }], 99).entries, [{ code: 'A', qty: 1 }]);
  // An item whose location field names a shelf keeps its stock there.
  const q = planQuickAdjust([], { type: 'remove', qty: 3, stock: 10, seedCode: 'W1-R2-B3' });
  assert.deepEqual(q.entries, [{ code: 'W1-R2-B3', qty: 7 }]);
  invariant(q);
});

// ---- order restores --------------------------------------------------------

test('never-picked order restores nothing', () => {
  const p = planOrderRestore({ id: ORDER }, []);
  assert.deepEqual(p.lines, []);
  assert.equal(p.skipped, 'nothing-picked');
  assert.equal(p.unverifiable, false);
});

test('deducted but no tagged pick: nothing restored, flagged for a human', () => {
  const p = planOrderRestore({ id: ORDER, stockDeducted: true }, []);
  assert.deepEqual(p.lines, []);
  assert.equal(p.unverifiable, true);
});

test('restores go back to the shelf each unit was picked from', () => {
  const p = planOrderRestore({ id: ORDER }, [
    pick('i1', 'W4-R1-F2', 21, 16, 1),
    pick('i1', 'W4-R2-A1', 16, 13, 2),
    pick('i2', 'W1-R1-B1', 8, 6, 3)
  ]);
  assert.deepEqual(p.lines.map(l => [l.itemId, l.pickShelf, l.qty]), [
    ['i1', 'W4-R1-F2', 5], ['i1', 'W4-R2-A1', 3], ['i2', 'W1-R1-B1', 2]
  ]);
  assert.equal(p.outstandingUnits, 10);
  assert.equal(p.lines[0].sku, '4634');
});

test('THE BUG: a second restore for the same order restores nothing', () => {
  const movs = [pick('i1', 'W4-R1-F2', 21, 11, 1), restore('i1', 'W4-R1-F2', 11, 21, 2)];
  const p = planOrderRestore({ id: ORDER }, movs);
  assert.deepEqual(p.lines, []);
  assert.equal(p.skipped, 'already-restored');
  assert.equal(p.restoredUnits, 10);
});

test('the stockRestored flag alone also blocks a second restore', () => {
  const p = planOrderRestore({ id: ORDER, stockRestored: true, stockRestoredAt: 5 }, [pick('i1', 'A', 10, 7, 1)]);
  assert.deepEqual(p.lines, []);
  assert.equal(p.skipped, 'already-restored');
});

test('a pick made after an earlier restore is restorable (cancel, reopen, re-pick)', () => {
  const movs = [
    pick('i1', 'A', 10, 7, 1), restore('i1', 'A', 7, 10, 2),
    pick('i1', 'A', 10, 6, 9)
  ];
  const p = planOrderRestore({ id: ORDER, stockRestored: true, stockRestoredAt: 3 }, movs);
  assert.deepEqual(p.lines.map(l => [l.pickShelf, l.qty]), [['A', 4]]);
});

test('partial picks restore only what was actually taken', () => {
  // Ordered 10, the shelf held 4: the PICK asked for 10 but before/after show 4.
  const p = planOrderRestore({ id: ORDER }, [pick('i1', 'A', 4, 0, 1, { quantity: 10 })]);
  assert.deepEqual(p.lines.map(l => l.qty), [4]);
  assert.equal(unitsPicked({ quantity: '6' }), 6); // older PICK with no before/after
});

test('a partly restored order restores only the remainder', () => {
  const movs = [
    pick('i1', 'A', 10, 5, 1), pick('i1', 'B', 5, 2, 2),
    restore('i1', 'A', 2, 7, 3)
  ];
  const p = planOrderRestore({ id: ORDER }, movs);
  assert.deepEqual(p.lines.map(l => [l.pickShelf, l.qty]), [['B', 3]]);
});

test('movements of another order are ignored', () => {
  const p = planOrderRestore({ id: ORDER }, [pick('i1', 'A', 10, 5, 1, { orderId: 'other' })]);
  assert.deepEqual(p.lines, []);
});

test('restore shelf: picked shelf, else primary, else STAGING', () => {
  assert.equal(restoreShelf('W4-R1-F2', [{ code: 'B', qty: 9 }]), 'W4-R1-F2');
  assert.equal(restoreShelf('', [{ code: 'A', qty: 2 }, { code: 'B', qty: 9 }]), 'B');
  assert.equal(restoreShelf('', []), 'STAGING');
  assert.equal(restoreShelf('A, B', []), 'A');
});

// ---- ledger helpers --------------------------------------------------------

test('stockChangeMovement AUTO: MOVE when the total is unchanged, ADJUST otherwise', () => {
  const b = { stock: '5', locations: [{ code: 'A', qty: 5 }] };
  assert.equal(stockChangeMovement(b, { stock: 5, locations: [{ code: 'B', qty: 5 }] }, { type: 'AUTO' }).type, 'MOVE');
  assert.equal(stockChangeMovement(b, { stock: 7, locations: [{ code: 'B', qty: 7 }] }, { type: 'AUTO' }).type, 'ADJUST');
  assert.equal(stockChangeMovement({ stock: 0, locations: [] }, b, { type: 'CREATE' }).afterQty, 5);
});

test('reconcileLedger: a chain that adds up reconciles', () => {
  const r = H.reconcileLedger([
    { type: 'CREATE', beforeQty: 0, afterQty: 19, timestamp: 1 },
    { type: 'RECEIVE', beforeQty: 19, afterQty: 21, timestamp: 2 },
    { type: 'PICK', beforeQty: 21, afterQty: 16, timestamp: 3 },
    { type: 'MOVE', quantity: 4, timestamp: 4 }
  ], 16);
  assert.equal(r.reconciles, true);
  assert.deepEqual(r.chainBreaks, []);
});

test('reconcileLedger: THE 4634 SIGNATURE - stock rose with nothing logged', () => {
  const r = H.reconcileLedger([
    { id: 'm1', type: 'IMPORT', beforeQty: 0, afterQty: 19, timestamp: 1 },
    { id: 'm2', type: 'RECEIVE', beforeQty: 19, afterQty: 21, timestamp: 2 },
    { id: 'm3', type: 'PICK', beforeQty: 29, afterQty: 27, timestamp: 3 }
  ], 27);
  assert.equal(r.reconciles, false);
  assert.equal(r.chainBreaks.length, 1);
  assert.equal(r.chainBreaks[0].movementId, 'm3');
  assert.equal(r.chainBreaks[0].unloggedChange, 8);
});

test('reconcileLedger: current quantity differs from the last movement', () => {
  const r = H.reconcileLedger([{ type: 'RECEIVE', beforeQty: 0, afterQty: 5, timestamp: 1 }], '9');
  assert.equal(r.reconciles, false);
  assert.equal(r.unloggedSinceLastMovement, 4);
});

test('reconcileLedger: same-millisecond movements are ordered by the chain', () => {
  const r = H.reconcileLedger([
    { type: 'PICK', beforeQty: 8, afterQty: 6, timestamp: 5 },
    { type: 'PICK', beforeQty: 10, afterQty: 8, timestamp: 5 }
  ], 6);
  assert.equal(r.reconciles, true);
});
