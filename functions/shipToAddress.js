'use strict';
// The ship-to address that goes on a carrier label.
//
// Pure functions, kept out of index.js so every label path (Shippo, the batch
// and scheduled runs, ShipStation, EasyPost) builds the recipient the same way
// and the rules can be unit-tested:
//
//   - A unit / suite / apt goes to street2, never into street1.
//   - An "Attention" person goes in the label's name, with the business kept in
//     company, so UPS prints both lines. With no attention the name/company pair
//     is exactly what it was before these fields existed.
//   - A drop-ship (order.shipToAddress) uses only the drop-ship unit and
//     attention; the billing customer's unit/attention belong to a different
//     address.
//
// Old orders carry none of the new fields and must produce the same label they
// always did.

function formatAddressForShippo(customerName, addressString, email, phone, company) {
  // Normalize: replace newlines with commas, strip periods after state codes, collapse multiple commas/spaces
  var normalized = (addressString || '').replace(/[\r\n]+/g, ', ').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').trim();
  // Strip periods after 2-letter state codes (e.g., "NC. 28546" -> "NC 28546")
  normalized = normalized.replace(/\b([A-Z]{2})\.\s*/gi, '$1 ');
  var parts = normalized.split(',').map(function(p) { return p.trim(); }).filter(function(p) { return p.length > 0; });
  
  var street1 = '', street2 = '', city = '', state = '', zip = '', country = 'US';
  var allText = parts.join(' ');
  
  // Check for Canadian postal code anywhere in the address
  var canadianPostal = allText.match(/([A-Z]\d[A-Z]\s?\d[A-Z]\d)/i);
  if (canadianPostal) {
    country = 'CA';
    zip = canadianPostal[1].toUpperCase().replace(/\s/, ' ');
    var provinces = ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'];
    for (var i = 0; i < parts.length; i++) {
      var trimmed = parts[i].trim().toUpperCase();
      if (provinces.indexOf(trimmed) >= 0) { state = trimmed; break; }
      for (var p = 0; p < provinces.length; p++) {
        if (trimmed.indexOf(provinces[p]) === 0) { state = provinces[p]; break; }
      }
      if (state) break;
    }
    street1 = parts[0] || '';
    if (parts.length >= 3) city = parts[parts.length - 3] || parts[1] || '';
    else if (parts.length >= 2) city = parts[1] || '';
    return { name: customerName || 'Customer', company: company || '', street1: street1, city: city, state: state, zip: zip, country: country, email: email || '', phone: phone || '', is_residential: false };
  }
  
  // Try to extract US zip code from anywhere in the text
  var usZipMatch = allText.match(/\b(\d{5}(-\d{4})?)\b/);
  if (usZipMatch) zip = usZipMatch[1];
  
  // Try to extract 2-letter state code
  var stateMatch = allText.match(/\b([A-Z]{2})\s+\d{5}/i);
  if (stateMatch) state = stateMatch[1].toUpperCase();
  
  // Check if last part is a 2-letter country code (not a US state)
  var usStates = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP'];
  if (parts.length >= 4) {
    var lastPart = parts[parts.length - 1].trim().toUpperCase();
    if (lastPart.length === 2 && usStates.indexOf(lastPart) < 0 && lastPart !== state) {
      country = lastPart;
    }
  }
  
  // Parse parts based on count
  if (parts.length >= 4) {
    street1 = parts[0] || '';
    city = parts[1] || '';
    if (!state) {
      var p2Match = parts[2].match(/^([A-Z]{2})\s*(\d{5}(-\d{4})?)?\s*$/i);
      if (p2Match) { state = p2Match[1].toUpperCase(); if (p2Match[2] && !zip) zip = p2Match[2]; }
      else state = parts[2];
    }
    if (!zip && parts[3]) {
      var p3Zip = parts[3].match(/\d{5}(-\d{4})?/);
      if (p3Zip) zip = p3Zip[0];
    }
  } else if (parts.length === 3) {
    street1 = parts[0] || '';
    city = parts[1] || '';
    var stateZip = parts[2] || '';
    var stateZipMatch = stateZip.match(/^([A-Z]{2})\s*(\d{5}(-\d{4})?)$/i);
    if (stateZipMatch) { if (!state) state = stateZipMatch[1]; if (!zip) zip = stateZipMatch[2]; }
    else if (!state) { state = stateZip; }
  } else if (parts.length === 2) {
    street1 = parts[0] || '';
    var part1Match = parts[1].match(/^(.+?)\s+([A-Z]{2})\s+(\d{5}(-\d{4})?)$/i);
    if (part1Match) { city = part1Match[1]; if (!state) state = part1Match[2]; if (!zip) zip = part1Match[3]; }
    else city = parts[1] || '';
  } else if (parts.length === 1) {
    street1 = parts[0] || '';
  }
  
  // Clean up final values
  state = (state || '').replace(/\./g, '').trim();
  zip = (zip || '').trim();
  city = (city || '').trim();
  
  return { name: customerName || 'Customer', company: company || '', street1: street1, city: city, state: state, zip: zip, country: country, email: email || '', phone: phone || '', is_residential: false };
}

// "Ste 25", "Suite 25", "Apt 4B", "#12", "Unit C" at the end of a street line.
var UNIT_TAIL = /\s*,?\s+(?:#|(?:ste|suite|apt|apartment|unit|rm|room|fl|floor|bldg|building|spc|space|lot|trlr|dept)\.?\s*#?)\s*([A-Za-z0-9-]+)\s*$/i;

function clean(v) { return String(v == null ? '' : v).trim(); }

// The identifying part of a unit: "Suite 25" -> "25", "#4B" -> "4b".
function unitValue(unit) {
  var m = clean(unit).match(/([A-Za-z0-9-]+)\s*$/);
  return m ? m[1].toLowerCase() : '';
}

// Put an explicit unit in street2. If an old single-line address already had
// the same unit typed onto the street ("4913 Chastain Ave Ste 25"), take it
// off street1 so the label does not print it twice. A different unit on the
// street is left alone - it is not ours to delete.
function placeUnit(street1, unit) {
  var s1 = clean(street1), u = clean(unit);
  if (!u) return { street1: street1, street2: undefined };
  var m = s1.match(UNIT_TAIL);
  if (m && m[1].toLowerCase() === unitValue(u) && m.index > 0) s1 = s1.slice(0, m.index).trim();
  return { street1: s1, street2: u };
}

// The recipient fields an order ships to: which address string, which unit,
// who it is attention to and which business. Mirrors the choice
// processPackedOrder has always made between a drop-ship and the customer.
function orderShipTo(order) {
  var o = order || {};
  if (o.shipToAddress) {
    return {
      address: o.shipToAddress,
      unit: clean(o.shipToUnit),
      attention: clean(o.shipToAttention),
      // Legacy: the contact (or customer) was the label name on a drop-ship.
      name: o.customerContact || o.customerName,
      company: o.shipToCompany || o.customerName,
      dropShip: true
    };
  }
  return {
    address: o.customerAddress || '',
    unit: clean(o.customerAddressUnit),
    attention: clean(o.customerAttention),
    name: o.customerName,
    company: o.customerName,
    dropShip: false
  };
}

// Apply unit and attention to an address already in label shape
// ({ name, company, street1, street2, ... }). Returns a new object.
function applyUnitAndAttention(addr, unit, attention, company) {
  var out = Object.assign({}, addr);
  if (clean(unit)) {
    var placed = placeUnit(out.street1, unit);
    out.street1 = placed.street1;
    out.street2 = placed.street2;
  }
  if (clean(attention)) {
    out.name = clean(attention);
    out.company = company || out.company || '';
  }
  return out;
}

// The Shippo address_to for an order, before validation. Returns null when the
// order has no address at all.
function buildOrderToAddress(order) {
  var st = orderShipTo(order);
  if (!st.address) return null;
  var o = order || {};
  var base = formatAddressForShippo(st.name, st.address, o.customerEmail, o.customerPhone, st.company);
  return applyUnitAndAttention(base, st.unit, st.attention, st.company);
}

// Merge Shippo's validated address over what we sent. Shippo corrects the
// street, city, state and zip; the unit we sent must survive when the
// validator returns no street2 of its own.
function mergeValidatedAddress(original, validated) {
  var v = validated || {};
  var merged = {
    name: v.name || original.name,
    company: original.company || '',
    street1: v.street1 || original.street1,
    street2: v.street2 || original.street2 || '',
    city: v.city || original.city,
    state: v.state || original.state,
    zip: v.zip || original.zip,
    country: v.country || original.country,
    email: original.email || '',
    phone: original.phone || '',
    is_residential: false
  };
  // The validator may fold our unit back into street1 ("... STE 25"); do not
  // then print it a second time from street2.
  if (!v.street2 && merged.street2) {
    var m = clean(merged.street1).match(UNIT_TAIL);
    if (m && m[1].toLowerCase() === unitValue(merged.street2)) merged.street2 = '';
  }
  return merged;
}

// ShipStation and EasyPost take a structured toAddress from the caller. When
// the caller sends one it is used as given; when it sends only an orderId (as
// the Shipping page does) the address is built from the order the same way the
// Shippo path builds it.
function resolveToAddress(toAddress, order) {
  if (toAddress && toAddress.street1) return toAddress;
  var built = order ? buildOrderToAddress(order) : null;
  if (!built) throw new Error('No ship-to address: pass toAddress or an order that has one');
  return built;
}

module.exports = {
  formatAddressForShippo: formatAddressForShippo,
  orderShipTo: orderShipTo,
  placeUnit: placeUnit,
  applyUnitAndAttention: applyUnitAndAttention,
  buildOrderToAddress: buildOrderToAddress,
  mergeValidatedAddress: mergeValidatedAddress,
  resolveToAddress: resolveToAddress
};
