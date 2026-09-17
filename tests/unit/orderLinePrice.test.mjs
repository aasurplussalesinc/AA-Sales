import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const orders = require('../../functions/orders.js');

// Minimal Firestore stand-in: one catalogue item, poncho at $25.00, 108 on hand.
const ITEM = { orgId: 'org1', price: 25, stock: 108, partNumber: '3377',
               name: 'PONCHO ACU #1', grade: '#1', location: 'W4-R1-Q2', weight: 2, cost: 9 };
const db = {
  collection: () => ({
    doc: () => ({ get: async () => ({ exists: true, id: 'itm1', data: () => ITEM }) })
  })
};
const auth = { orgId: 'org1', keyId: 'k', label: 'test' };

// buildLines isn't exported; drive it through createDraftOrder's line builder by
// calling the module's internal path via a tiny order create with a stub writer.
const build = async (lines) => {
  const mod = require('../../functions/orders.js');
  // createDraftOrder needs more of the db surface than we want to fake, so reach
  // the pure function directly off the module source.
  return await mod.__buildLinesForTest(db, auth, lines);
};

test('no unitPrice: catalogue price wins', async () => {
  const { lines, warnings } = await build([{ itemId: 'itm1', quantity: 10 }]);
  assert.equal(lines[0].unitPrice, 25);
  assert.equal(lines[0].estTotal, 250);
  assert.equal(warnings.filter(w => w.type === 'price_override').length, 0);
});

test('explicit unitPrice is honoured and flagged', async () => {
  const { lines, warnings } = await build([{ itemId: 'itm1', quantity: 96, unitPrice: 12.75 }]);
  assert.equal(lines[0].unitPrice, 12.75);
  assert.equal(lines[0].estTotal, 1224);
  const o = warnings.find(w => w.type === 'price_override');
  assert.ok(o, 'expected a price_override warning');
  assert.equal(o.catalogPrice, 25);
  assert.equal(o.unitPrice, 12.75);
});

test('unitPrice of 0 is a real override, not "absent"', async () => {
  const { lines } = await build([{ itemId: 'itm1', quantity: 5, unitPrice: 0 }]);
  assert.equal(lines[0].unitPrice, 0);
  assert.equal(lines[0].estTotal, 0);
});

test('negative unitPrice is rejected', async () => {
  await assert.rejects(() => build([{ itemId: 'itm1', quantity: 1, unitPrice: -5 }]),
    /unitPrice must be a number of 0 or more/);
});

test('quotedPrice still never sets the price', async () => {
  const { lines, warnings } = await build([{ itemId: 'itm1', quantity: 4, quotedPrice: 12.75 }]);
  assert.equal(lines[0].unitPrice, 25, 'quoted price must not become the line price');
  assert.equal(lines[0].quotedPrice, 12.75);
  assert.ok(warnings.find(w => w.type === 'price_mismatch'));
});

test('quoted matching an explicit override raises no mismatch', async () => {
  const { warnings } = await build([{ itemId: 'itm1', quantity: 4, unitPrice: 12.75, quotedPrice: 12.75 }]);
  assert.equal(warnings.filter(w => w.type === 'price_mismatch').length, 0);
  assert.equal(warnings.filter(w => w.type === 'price_override').length, 1);
});

test('short stock still warns and still keeps the line', async () => {
  const { lines, warnings } = await build([{ itemId: 'itm1', quantity: 240, unitPrice: 12.75 }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 240);
  assert.ok(warnings.find(w => w.type === 'insufficient_stock'));
});
