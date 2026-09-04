// generateShippingLabel buys by rate id and does not re-rate, so a shipping
// quote left on an order after the boxes were re-measured buys a label at the
// old size and weight. These cases pin the two directions that cost money:
// a changed parcel MUST drop the quote, and a purchased label must NEVER be
// touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldClearShippingRates } from '../../src/parcelRates.js';

const box = (o) => ({ length: 12, width: 12, height: 12, weight: 20, ...o });
const quoted = () => ({
  shippingLabel: { labelStatus: 'rates_ready', rates: [{ amount: '42.10' }] },
  boxDetails: { 1: box() },
});
const purchased = () => ({
  shippingLabel: { labelStatus: 'purchased', trackingNumber: '1Z999', labelUrl: 'https://x/label.pdf' },
  boxDetails: { 1: box() },
});

test('a heavier box drops an unbought quote', () => {
  assert.equal(shouldClearShippingRates(quoted(), { boxDetails: { 1: box({ weight: 40 }) } }), true);
});

test('a bigger box drops an unbought quote', () => {
  assert.equal(shouldClearShippingRates(quoted(), { boxDetails: { 1: box({ length: 24 }) } }), true);
});

test('an added box drops an unbought quote', () => {
  assert.equal(shouldClearShippingRates(quoted(), { boxDetails: { 1: box(), 2: box({ weight: 3 }) } }), true);
});

test('switching to triwalls drops an unbought quote', () => {
  assert.equal(shouldClearShippingRates(quoted(), {
    packingMode: 'triwalls',
    triwalls: [{ length: 48, width: 40, height: 36, weight: 600 }],
  }), true);
});

test('a triwall reweigh drops an unbought quote', () => {
  const before = {
    shippingLabel: { labelStatus: 'rates_ready' },
    packingMode: 'triwalls',
    triwalls: [{ length: 48, width: 40, height: 36, weight: 600 }],
  };
  assert.equal(shouldClearShippingRates(before, {
    triwalls: [{ length: 48, width: 40, height: 36, weight: 900 }],
  }), true);
});

test('changed insurance drops an unbought quote', () => {
  assert.equal(shouldClearShippingRates(quoted(), { boxInsurance: { 1: 500 } }), true);
});

test('a purchased label is never cleared', () => {
  assert.equal(shouldClearShippingRates(purchased(), { boxDetails: { 1: box({ weight: 999 }) } }), false);
});

test('re-saving the same dimensions does not churn the quote', () => {
  assert.equal(shouldClearShippingRates(quoted(), { boxDetails: { 1: box() } }), false);
});

test('the form writes strings, and "12" is not a change from 12', () => {
  assert.equal(shouldClearShippingRates(quoted(), {
    boxDetails: { 1: { length: '12', width: '12', height: '12', weight: '20' } },
  }), false);
});

test('contentsValue moves on every save and must not drop the quote', () => {
  assert.equal(shouldClearShippingRates(quoted(), {
    boxDetails: { 1: box({ contentsValue: 1500 }) },
  }), false);
});

test('unrelated edits leave the quote alone', () => {
  assert.equal(shouldClearShippingRates(quoted(), { status: 'packed', notes: 'ready' }), false);
});

test('an order with no quote has nothing to clear', () => {
  assert.equal(shouldClearShippingRates({ boxDetails: {} }, { boxDetails: { 1: box() } }), false);
});
