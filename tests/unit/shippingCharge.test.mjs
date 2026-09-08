// These set an amount that lands on a customer invoice. The bug they pin: a
// label billed to the customer's own carrier account still added a freight line
// to our invoice, so they paid the carrier directly AND paid us for the same
// shipment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { shippingChargeUpdate, customerShippingCharge } =
  createRequire(import.meta.url)('../../functions/shippingCharge.js');

const org = { shippingMarkup: { percent: 20, flat: 5 } };
const label = (amount, billedTo) => ({ selectedRate: { amount, billedTo } });

test('billed to us: cost plus markup lands on the invoice', () => {
  const u = shippingChargeUpdate({}, label('58.03', 'AA'), org);
  assert.equal(u.shippingCost, 58.03);
  assert.equal(u.shipping, 74.64);            // 58.03 * 1.2 + 5
  assert.equal(u.shippingBilledToCustomer, false);
});

test('billed to the customer: no freight line at all', () => {
  const u = shippingChargeUpdate({}, label('58.03', 'Customer'), org);
  assert.equal(u.shipping, 0);
  assert.equal(u.shippingChargeAuto, 0);
  assert.equal(u.shippingBilledToCustomer, true);
});

test('billed to the customer: it cost us nothing', () => {
  const u = shippingChargeUpdate({}, label('58.03', 'Customer'), org);
  assert.equal(u.shippingCost, 0);
  assert.equal(u.shippingCarrierAmount, 58.03); // kept for reference only
});

test('a stale auto charge from an earlier AA label is cleared', () => {
  const order = { shipping: 74.64, shippingChargeAuto: 74.64 };
  assert.equal(shippingChargeUpdate(order, label('58.03', 'Customer'), org).shipping, 0);
});

test('a hand-typed shipping charge is never wiped, even on their account', () => {
  const order = { shipping: 95, shippingManual: true };
  const u = shippingChargeUpdate(order, label('58.03', 'Customer'), org);
  assert.equal('shipping' in u, false);
  assert.equal(u.shippingBilledToCustomer, true); // still recorded
});

test('a hand-typed charge is not overwritten on our own account either', () => {
  const order = { shipping: 95, shippingManual: true };
  assert.equal('shipping' in shippingChargeUpdate(order, label('58.03', 'AA'), org), false);
});

test('an unknown biller falls back to charging, as it did before', () => {
  // Legacy orders bought before billedTo was recorded must not silently lose
  // their freight line.
  const u = shippingChargeUpdate({}, label('58.03', undefined), org);
  assert.equal(u.shippingBilledToCustomer, false);
  assert.equal(u.shipping, 74.64);
});

test('no rate, no update', () => {
  assert.deepEqual(shippingChargeUpdate({}, { selectedRate: null }, org), {});
  assert.deepEqual(shippingChargeUpdate({}, null, org), {});
  assert.deepEqual(shippingChargeUpdate({}, label('0', 'AA'), org), {});
});

test('markup maths: percent, flat and round-up', () => {
  assert.equal(customerShippingCharge(100, { shippingMarkup: { percent: 15 } }), 115);
  assert.equal(customerShippingCharge(100, { shippingMarkup: { flat: 7.5 } }), 107.5);
  assert.equal(customerShippingCharge(58.03, { shippingMarkup: { percent: 20, flat: 5, roundUp: true } }), 75);
  assert.equal(customerShippingCharge(58.03, {}), 58.03);
});
