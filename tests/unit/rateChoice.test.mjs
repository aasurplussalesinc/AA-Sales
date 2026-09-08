// Which rate gets bought decides who pays the freight. The bug these pin: an
// order whose customer supplied a working carrier account was still billed to
// AA, because selection looked only at carrier and price and third-party
// billing quotes the same amount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chooseRate } = createRequire(import.meta.url)('../../functions/rateChoice.js');

const r = (provider, amount, billedTo) => ({ provider, amount, billedTo, rateId: `${provider}-${amount}-${billedTo}` });
// processPackedOrder sorts cheapest-first before choosing, so fixtures are sorted.

test('a tie between our account and theirs goes to theirs', () => {
  // The exact shape of the bug: same carrier, same price, ours listed first.
  const rates = [r('UPS', '42.10', 'AA'), r('UPS', '42.10', 'Customer')];
  assert.equal(chooseRate(rates, 'ups').billedTo, 'Customer');
});

test('their account wins even when our rate is cheaper', () => {
  const rates = [r('UPS', '38.00', 'AA'), r('UPS', '42.10', 'Customer')];
  const pick = chooseRate(rates, 'ups');
  assert.equal(pick.billedTo, 'Customer');
  assert.equal(pick.amount, '42.10');
});

test('their account declined, so we pay - cheapest preferred carrier', () => {
  const rates = [r('USPS', '30.00', 'AA'), r('UPS', '38.00', 'AA')];
  const pick = chooseRate(rates, 'ups');
  assert.equal(pick.billedTo, 'AA');
  assert.equal(pick.provider, 'UPS');
});

test('carrier preference still applies inside their account', () => {
  const rates = [r('FedEx', '35.00', 'Customer'), r('UPS', '41.00', 'Customer')];
  assert.equal(chooseRate(rates, 'ups').provider, 'UPS');
});

test('their account not quoting the preferred carrier still beats ours', () => {
  // Staying on their invoice matters more than which carrier carries it.
  const rates = [r('UPS', '39.00', 'AA'), r('FedEx', '44.00', 'Customer')];
  const pick = chooseRate(rates, 'ups');
  assert.equal(pick.billedTo, 'Customer');
  assert.equal(pick.provider, 'FedEx');
});

test('cheapest of their rates when none match the preferred carrier', () => {
  const rates = [r('DHL', '33.00', 'Customer'), r('FedEx', '44.00', 'Customer')];
  assert.equal(chooseRate(rates, 'ups').amount, '33.00');
});

test('no preferred carrier match anywhere falls back to cheapest', () => {
  const rates = [r('USPS', '12.00', 'AA'), r('FedEx', '30.00', 'AA')];
  assert.equal(chooseRate(rates, 'ups').provider, 'USPS');
});

test('carrier match is case-insensitive and partial', () => {
  const rates = [r('ups', '20.00', 'AA')];
  assert.equal(chooseRate(rates, 'UPS').provider, 'ups');
});

test('no rates at all returns null rather than undefined', () => {
  assert.equal(chooseRate([], 'ups'), null);
  assert.equal(chooseRate(null, 'ups'), null);
});

test('a null entry in the list does not crash the pick', () => {
  const rates = [null, r('UPS', '25.00', 'Customer')];
  assert.equal(chooseRate(rates, 'ups').billedTo, 'Customer');
});

test('missing preferred carrier defaults to ups', () => {
  const rates = [r('USPS', '10.00', 'AA'), r('UPS', '20.00', 'AA')];
  assert.equal(chooseRate(rates, undefined).provider, 'UPS');
});
