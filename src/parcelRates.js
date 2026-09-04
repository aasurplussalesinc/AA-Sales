// A Shippo rate is bound to the parcels it was quoted on. generateShippingLabel
// buys by rate id and does not re-rate, so a quote fetched before the boxes were
// re-measured buys a label at the OLD size and weight - it ships, the carrier
// reweighs, and the difference lands on the invoice.
//
// So a change to how an order is packed throws away any quote that has not been
// paid for yet. This is the same thing the "re-sync customer" button in
// Shipping.jsx already does deliberately before it re-rates; it just never
// applied to the dimensions.
export const PARCEL_FIELDS = ['boxDetails', 'triwalls', 'packingMode', 'boxInsurance'];

const dims = (b) => [b && b.length, b && b.width, b && b.height, b && b.weight]
  .map((v) => (v === undefined || v === null ? '' : String(v)))
  .join('x');

const byKey = (m, fn) => Object.keys(m || {}).sort()
  .map((k) => k + ':' + fn((m || {})[k]))
  .join('|');

// Everything that changes what the carrier is asked to quote, and nothing else -
// contentsValue and packed-item checkboxes move constantly and must not
// invalidate a rate.
export function parcelSignature(order) {
  const o = order || {};
  return [
    String(o.packingMode || ''),
    (Array.isArray(o.triwalls) ? o.triwalls : []).map(dims).join('|'),
    byKey(o.boxDetails, dims),
    byKey(o.boxInsurance, (v) => (v === undefined || v === null ? '' : String(v))),
  ].join('~');
}

// `before` is the stored order, `updates` the fields about to be written.
// A purchased label is history and is never cleared - only an unbought quote.
export function shouldClearShippingRates(before, updates) {
  if (!before || !updates) return false;
  if (!PARCEL_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(updates, k))) return false;
  const label = before.shippingLabel;
  if (!label || label.trackingNumber) return false;
  return parcelSignature(before) !== parcelSignature(Object.assign({}, before, updates));
}
