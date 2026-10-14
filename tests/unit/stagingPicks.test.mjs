// AA Surplus picks can always come from STAGING, and a line with nothing on any
// shelf picks from staging by itself (Alan 2026-10-14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withStagingOption, needsLocationChoice, resolveStagingAwarePick, STAGING } from '../../src/pickDeduction.js';
import { takeFromStaging } from '../../src/stockLedger.js';

test('staging is always offered, once', () => {
  assert.deepEqual(withStagingOption([{ code: 'A1', qty: 4 }]).map(o => o.code), ['A1', STAGING]);
  assert.deepEqual(withStagingOption([]).map(o => o.code), [STAGING]);
  assert.equal(withStagingOption([{ code: 'STAGING', qty: 3 }]).length, 1);
});

test('adding staging at 0 never forces a choice on a single-shelf item', () => {
  assert.equal(needsLocationChoice(withStagingOption([{ code: 'A1', qty: 4 }])), false);
  assert.equal(needsLocationChoice([{ code: 'A1', qty: 4 }, { code: 'B2', qty: 1 }]), true);
  assert.equal(needsLocationChoice([{ code: 'A1', qty: 4 }, { code: STAGING, qty: 2 }]), true);
});

test('0 in stock picks from staging automatically', () => {
  assert.equal(resolveStagingAwarePick({ location: '' }, withStagingOption([])), STAGING);
});

test('one stocked shelf is picked from by default; an explicit choice wins', () => {
  const opts = withStagingOption([{ code: 'A1', qty: 4 }]);
  assert.equal(resolveStagingAwarePick({}, opts), 'A1');
  assert.equal(resolveStagingAwarePick({ pickLocation: STAGING }, opts), STAGING);
});

test('takeFromStaging only touches staging, never another shelf', () => {
  const r = takeFromStaging([{ code: 'A1', qty: 5 }, { code: STAGING, qty: 2 }], 3);
  assert.equal(r.removed, 2);
  assert.equal(r.unrecorded, 1);
  assert.deepEqual(r.entries, [{ code: 'A1', qty: 5 }]);
  assert.equal(r.after, 5);
});

test('0 stock: nothing comes off, all units are unrecorded, stock stays 0', () => {
  const r = takeFromStaging([], 4);
  assert.deepEqual(r, { entries: [], before: 0, after: 0, removed: 0, unrecorded: 4 });
});
