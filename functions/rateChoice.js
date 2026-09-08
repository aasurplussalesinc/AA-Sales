'use strict';
// Which shipping rate actually gets bought when nobody picks one by hand.
//
// Extracted from processPackedOrder so it can be tested: this decides who pays
// for the freight, and it used to get that wrong. Selection looked only at
// carrier and price, but third-party billing usually quotes the same amount as
// our own account - and because our rates are added to the list first and
// Array#sort is stable, every tie fell to us. An order with a perfectly good
// customer carrier account could still be billed to AA.
//
// `rates` is expected already sorted cheapest-first, as processPackedOrder sorts it.
function chooseRate(rates, preferredCarrier) {
  var all = Array.isArray(rates) ? rates.filter(Boolean) : [];
  if (all.length === 0) return null;

  // The customer's own account wins over the carrier preference. Getting the
  // freight onto their invoice matters more than which carrier carries it; the
  // preference only breaks ties within whichever account is paying.
  var customerRates = all.filter(function (r) { return r.billedTo === 'Customer'; });
  var pool = customerRates.length > 0 ? customerRates : all;

  var pref = String(preferredCarrier || 'ups').toLowerCase();
  var byCarrier = pool.filter(function (r) {
    return String(r.provider || '').toLowerCase().indexOf(pref) >= 0;
  });

  return byCarrier.length > 0 ? byCarrier[0] : pool[0];
}

module.exports = { chooseRate: chooseRate };
