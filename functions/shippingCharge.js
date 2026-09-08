'use strict';
// What the customer is charged for freight once a label is bought.
//
// Pure functions, kept out of index.js so they can be tested: these decide an
// amount that lands on an invoice.

// The customer-facing price of freight: real carrier cost plus the org's markup.
function customerShippingCharge(realCost, orgData) {
  var cost = parseFloat(realCost) || 0;
  var m = (orgData && orgData.shippingMarkup) || {};
  var pct = parseFloat(m.percent) || 0;
  var flat = parseFloat(m.flat) || 0;
  var charge = cost * (1 + pct / 100) + flat;
  if (m.roundUp) charge = Math.ceil(charge);
  return Math.round(charge * 100) / 100;
}

// A shipping figure someone typed by hand is never overwritten. A figure this
// function wrote last time is fair game to refresh.
function canOverwriteShipping(order) {
  if (!order || order.shippingManual === true) return false;
  var manual = parseFloat(order.shipping);
  var priorAuto = parseFloat(order.shippingChargeAuto);
  return !(manual > 0) || (isFinite(priorAuto) && Math.abs(manual - priorAuto) < 0.005);
}

// Given the order and the just-purchased label, the fields to write so the
// invoice's shipping line is right.
function shippingChargeUpdate(order, shippingLabel, orgData) {
  var rate = shippingLabel && shippingLabel.selectedRate;
  var realCost = rate ? parseFloat(rate.amount) : NaN;
  if (!isFinite(realCost) || realCost <= 0) return {};

  // Freight on the customer's own carrier account is invoiced to them by the
  // carrier. Adding a shipping line here as well bills them twice for one
  // shipment - and it costs us nothing, so it is not our cost either.
  if (rate.billedTo === 'Customer') {
    // shippingBilledToCustomer is the flag the estimate/invoice template and the
    // order screen already read to print "Billed to your carrier account" in
    // place of a freight line. Both have been waiting on a writer.
    var billed = {
      shippingBilledToCustomer: true,
      shippingCarrierAmount: realCost, // what the carrier will bill THEM, for reference
      shippingCost: 0,
      shippingChargeAuto: 0
    };
    if (canOverwriteShipping(order)) billed.shipping = 0;
    return billed;
  }

  var charge = customerShippingCharge(realCost, orgData);
  var update = { shippingBilledToCustomer: false, shippingCost: realCost, shippingChargeAuto: charge };
  if (canOverwriteShipping(order)) update.shipping = charge;
  return update;
}

module.exports = {
  customerShippingCharge: customerShippingCharge,
  canOverwriteShipping: canOverwriteShipping,
  shippingChargeUpdate: shippingChargeUpdate
};
