// Blind drop-ship labels (Alan 2026-10-14): the customer's name as sender, our address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { labelSender } = createRequire(import.meta.url)('../../functions/shipToAddress.js');

const ours = { name: 'Alan Artieda', company: 'AA Surplus Sales', street1: '2153 Pond Road', city: 'Ronkonkoma', state: 'NY', zip: '11779', phone: '5165550000' };

test('a normal order ships under our own name', () => {
  assert.deepEqual(labelSender(ours, { customerName: 'Billings Army Navy' }), ours);
  assert.deepEqual(labelSender(ours, null), ours);
});

test('blind drop-ship: customer name as sender, our address kept for pickup and returns', () => {
  const f = labelSender(ours, { blindShip: true, shipAsName: 'Billings Army Navy' });
  assert.equal(f.name, 'Billings Army Navy');
  assert.equal(f.company, 'Billings Army Navy');
  assert.equal(f.street1, '2153 Pond Road');
  assert.equal(f.zip, '11779');
  assert.equal(ours.company, 'AA Surplus Sales'); // the org settings object is never mutated
});

test('blind with no name given falls back to the billing customer', () => {
  assert.equal(labelSender(ours, { blindShip: true, customerName: 'Billings Army Navy' }).company, 'Billings Army Navy');
});

const { labelReturnAddress } = createRequire(import.meta.url)('../../functions/shipToAddress.js');

test('blind drop-ship returns go to the customer\'s billing address under their name', () => {
  const r = labelReturnAddress({ blindShip: true, shipAsName: 'Billings Army Navy', customerName: 'Billings Army Navy',
    customerAddress: '2601 Minnesota Ave, Billings, MT 59101', customerAddressUnit: 'Suite 4', customerPhone: '4065550100' });
  assert.equal(r.company, 'Billings Army Navy');
  assert.equal(r.street1, '2601 Minnesota Ave');
  assert.equal(r.street2, 'Suite 4');
  assert.equal(r.city, 'Billings');
  assert.equal(r.state, 'MT');
  assert.equal(r.zip, '59101');
});

test('no return override for normal orders or a blind order with no billing address', () => {
  assert.equal(labelReturnAddress({ customerAddress: '1 Main St, Town, NY 11111' }), null);
  assert.equal(labelReturnAddress({ blindShip: true, shipAsName: 'X' }), null);
});
