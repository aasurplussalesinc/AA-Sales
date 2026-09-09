// AA6645 shipped eight lines and inventory never moved. No error, no log - the
// numbers just stayed put. These pin the two decisions that allowed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePickLocation, shouldFlagStockDeducted } from '../../src/pickDeduction.js';

// ---- the flag ------------------------------------------------------------

test('THE BUG: nothing picked must never flag the order as deducted', () => {
  // Every line skipped, order stamped anyway, deductOrderStock then refused to
  // run for the rest of the order's life.
  assert.equal(shouldFlagStockDeducted(0, 0), false);
});

test('a partial deduction must not flag either', () => {
  // Six of eight lines moved: the order still needs the shipping step to finish
  // the job, so it must stay unflagged.
  assert.equal(shouldFlagStockDeducted(8, 6), false);
});

test('every picked line deducted, so the order is flagged', () => {
  assert.equal(shouldFlagStockDeducted(8, 8), true);
});

test('a single line still counts', () => {
  assert.equal(shouldFlagStockDeducted(1, 1), true);
  assert.equal(shouldFlagStockDeducted(1, 0), false);
});

// ---- which shelf ---------------------------------------------------------

test("the picker's explicit choice wins", () => {
  const item = { pickLocation: 'W4-R1-D1', location: 'W4-R1-A1' };
  assert.equal(resolvePickLocation(item, [{ code: 'W4-R1-A1' }, { code: 'W4-R1-D1' }]), 'W4-R1-D1');
});

test('one shelf only, so no choice is needed', () => {
  assert.equal(resolvePickLocation({ location: 'STALE' }, [{ code: 'W4-R1-E1' }]), 'W4-R1-E1');
});

test('several shelves and no choice falls back to the primary location', () => {
  // 2629 sits on three shelves; without a pick location this is the best guess
  // and removeStockAtLocation takes the largest holding if it is wrong.
  const item = { location: 'W4-R1-F2' };
  assert.equal(resolvePickLocation(item, [{ code: 'W4-R1-A1' }, { code: 'W4-R1-D1' }, { code: 'W4-R1-F2' }]), 'W4-R1-F2');
});

test('nothing known returns empty rather than undefined', () => {
  assert.equal(resolvePickLocation({}, []), '');
  assert.equal(resolvePickLocation(null, null), '');
});

test('STAGING is a valid pick location', () => {
  assert.equal(resolvePickLocation({ pickLocation: 'STAGING' }, [{ code: 'STAGING' }]), 'STAGING');
});
