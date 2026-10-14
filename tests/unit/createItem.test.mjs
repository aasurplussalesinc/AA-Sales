// MCP create_item (2026-10-14): SKU numbering and the duplicate guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const INV = createRequire(import.meta.url)('../../functions/inventory.js');

test('next SKU follows the app: highest numeric SKU in the series + 1', () => {
  assert.equal(INV.nextSku(['4823', '3346', 'ABC', '999'], 1000), '4824');
  assert.equal(INV.nextSku([], 4000), '4000');
  assert.equal(INV.nextSku(['12', '15'], 1000), '1000');
});

test('same name in a different grade is a different item', () => {
  assert.equal(INV.sameProduct({ name: 'POLY FROG TOP COYOTE LG', grade: '#1' }, { name: 'POLY FROG TOP COYOTE LG', grade: 'NEW' }), false);
  assert.equal(INV.sameProduct({ name: 'poly  frog top ', grade: 'new' }, { name: 'POLY FROG TOP', grade: 'NEW' }), true);
});
