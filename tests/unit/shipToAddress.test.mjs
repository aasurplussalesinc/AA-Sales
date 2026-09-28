// The recipient block of a carrier label. The request (Alan, 2026-09-28): a
// customer's unit / suite and an "Attention" person were missing from the
// printed label. These pin where each lands and that orders written before
// the fields existed still produce exactly the label they always did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { addressWithUnit } from '../../functions/orderDocument.mjs';
const {
  buildOrderToAddress, mergeValidatedAddress, resolveToAddress, formatAddressForShippo
} = createRequire(import.meta.url)('../../functions/shipToAddress.js');

const base = {
  poNumber: 'AA7000',
  customerName: 'Acme Surplus',
  customerEmail: 'buyer@example.com',
  customerPhone: '704-555-0100',
  customerAddress: '4913 Chastain Ave, Charlotte, NC, 28217'
};

test('no unit, no attention: identical to the legacy parse', () => {
  const legacy = formatAddressForShippo(base.customerName, base.customerAddress, base.customerEmail, base.customerPhone, base.customerName);
  assert.deepEqual(buildOrderToAddress(base), legacy);
  assert.equal(legacy.name, 'Acme Surplus');
  assert.equal(legacy.company, 'Acme Surplus');
  assert.equal(legacy.street1, '4913 Chastain Ave');
  assert.equal('street2' in legacy, false);
});

test('legacy drop-ship with no new fields is unchanged', () => {
  const o = { ...base, customerContact: 'Bob', shipToAddress: '12 Oak St\nAustin, TX 78701', shipToCompany: 'The Camo Shop' };
  const a = buildOrderToAddress(o);
  assert.deepEqual(a, formatAddressForShippo('Bob', o.shipToAddress, o.customerEmail, o.customerPhone, 'The Camo Shop'));
  assert.equal(a.name, 'Bob');
  assert.equal(a.company, 'The Camo Shop');
});

test('customer unit goes to street2, not street1', () => {
  const a = buildOrderToAddress({ ...base, customerAddressUnit: 'Suite 25' });
  assert.equal(a.street1, '4913 Chastain Ave');
  assert.equal(a.street2, 'Suite 25');
  assert.equal(a.city, 'Charlotte');
  assert.equal(a.zip, '28217');
});

test('attention becomes the label name and the business stays in company', () => {
  const a = buildOrderToAddress({ ...base, customerAttention: 'Jane Doe' });
  assert.equal(a.name, 'Jane Doe');
  assert.equal(a.company, 'Acme Surplus');
});

test('a unit already typed on the street is not printed twice', () => {
  const o = { ...base, customerAddress: '4913 Chastain Ave Ste 25, Charlotte, NC, 28217', customerAddressUnit: 'Suite 25' };
  const a = buildOrderToAddress(o);
  assert.equal(a.street1, '4913 Chastain Ave');
  assert.equal(a.street2, 'Suite 25');
});

test('an old single-line unit with no explicit field still parses as before', () => {
  const a = buildOrderToAddress({ ...base, customerAddress: '4913 Chastain Ave Ste 25, Charlotte, NC, 28217' });
  assert.equal(a.street1, '4913 Chastain Ave Ste 25');
  assert.equal('street2' in a, false);
});

test('a different unit on the street is left alone', () => {
  const a = buildOrderToAddress({ ...base, customerAddress: '4913 Chastain Ave Ste 25, Charlotte, NC, 28217', customerAddressUnit: 'Bldg C' });
  assert.equal(a.street1, '4913 Chastain Ave Ste 25');
  assert.equal(a.street2, 'Bldg C');
});

test('drop-ship unit and attention win; the customer ones are not used', () => {
  const o = {
    ...base, customerAddressUnit: 'Suite 25', customerAttention: 'Jane Doe', customerContact: 'Bob',
    shipToAddress: '12 Oak St, Austin, TX 78701', shipToCompany: 'The Camo Shop',
    shipToUnit: 'Unit 4', shipToAttention: 'Receiving'
  };
  const a = buildOrderToAddress(o);
  assert.equal(a.street1, '12 Oak St');
  assert.equal(a.street2, 'Unit 4');
  assert.equal(a.name, 'Receiving');
  assert.equal(a.company, 'The Camo Shop');
});

test('drop-ship without its own unit/attention does not borrow the customer ones', () => {
  const o = { ...base, customerAddressUnit: 'Suite 25', customerAttention: 'Jane Doe', customerContact: 'Bob',
    shipToAddress: '12 Oak St, Austin, TX 78701', shipToCompany: 'The Camo Shop' };
  const a = buildOrderToAddress(o);
  assert.equal('street2' in a, false);
  assert.equal(a.name, 'Bob');
  assert.equal(a.company, 'The Camo Shop');
});

test('drop-ship attention with no ship-to company keeps the customer as company', () => {
  const a = buildOrderToAddress({ ...base, shipToAddress: '12 Oak St, Austin, TX 78701', shipToAttention: 'Receiving' });
  assert.equal(a.name, 'Receiving');
  assert.equal(a.company, 'Acme Surplus');
});

test('no address at all returns null', () => {
  assert.equal(buildOrderToAddress({ customerName: 'X' }), null);
});

test('validation merge keeps our street2 when the validator returns none', () => {
  const sent = buildOrderToAddress({ ...base, customerAddressUnit: 'Suite 25', customerAttention: 'Jane Doe' });
  const validated = { name: 'Jane Doe', street1: '4913 CHASTAIN AVE', street2: '', city: 'CHARLOTTE', state: 'NC', zip: '28217-1234', country: 'US' };
  const m = mergeValidatedAddress(sent, validated);
  assert.equal(m.street1, '4913 CHASTAIN AVE');
  assert.equal(m.street2, 'Suite 25');
  assert.equal(m.zip, '28217-1234');
  assert.equal(m.name, 'Jane Doe');
  assert.equal(m.company, 'Acme Surplus');
  assert.equal(m.phone, '704-555-0100');
});

test('validation merge prefers the validator street2 when it has one', () => {
  const sent = buildOrderToAddress({ ...base, customerAddressUnit: 'Suite 25' });
  const m = mergeValidatedAddress(sent, { street1: '4913 CHASTAIN AVE', street2: 'STE 25' });
  assert.equal(m.street2, 'STE 25');
});

test('validation merge does not duplicate a unit folded back into street1', () => {
  const sent = buildOrderToAddress({ ...base, customerAddressUnit: 'Suite 25' });
  const m = mergeValidatedAddress(sent, { street1: '4913 CHASTAIN AVE STE 25', street2: '' });
  assert.equal(m.street1, '4913 CHASTAIN AVE STE 25');
  assert.equal(m.street2, '');
});

test('validation merge with no unit anywhere matches the old merge', () => {
  const sent = buildOrderToAddress(base);
  const v = { name: 'Acme Surplus', street1: '4913 CHASTAIN AVE', street2: '', city: 'CHARLOTTE', state: 'NC', zip: '28217', country: 'US' };
  assert.deepEqual(mergeValidatedAddress(sent, v), {
    name: 'Acme Surplus', company: 'Acme Surplus', street1: '4913 CHASTAIN AVE', street2: '',
    city: 'CHARLOTTE', state: 'NC', zip: '28217', country: 'US',
    email: 'buyer@example.com', phone: '704-555-0100', is_residential: false
  });
});

test('ShipStation/EasyPost: an explicit toAddress is used as given', () => {
  const given = { name: 'X', street1: '1 A St', street2: 'Apt 2', city: 'Y', state: 'NC', zip: '27000' };
  assert.equal(resolveToAddress(given, { ...base, customerAddressUnit: 'Suite 25' }), given);
});

test('ShipStation/EasyPost: only an order -> same builder as the Shippo path', () => {
  const o = { ...base, customerAddressUnit: 'Suite 25', customerAttention: 'Jane Doe' };
  assert.deepEqual(resolveToAddress(undefined, o), buildOrderToAddress(o));
  assert.throws(() => resolveToAddress(undefined, null));
});

test('documents: unit printed after the street, only when present', () => {
  assert.equal(addressWithUnit(base.customerAddress, ''), base.customerAddress);
  assert.equal(addressWithUnit(base.customerAddress, undefined), base.customerAddress);
  assert.equal(addressWithUnit(base.customerAddress, 'Suite 25'), '4913 Chastain Ave, Suite 25, Charlotte, NC, 28217');
  assert.equal(addressWithUnit(base.customerAddress, 'Suite 25', '\n'), '4913 Chastain Ave\nSuite 25\nCharlotte, NC, 28217');
  assert.equal(addressWithUnit('12 Oak St\nAustin, TX 78701', 'Unit 4', '\n'), '12 Oak St\nUnit 4\nAustin, TX 78701');
  assert.equal(addressWithUnit('4913 Chastain Ave Ste 25, Charlotte, NC', 'Suite 25'), '4913 Chastain Ave Ste 25, Charlotte, NC');
  assert.equal(addressWithUnit('', 'Suite 25'), 'Suite 25');
});
