/**
 * SkidSling - shared inventory write logic for the backend.
 *
 * The model, matching the app (src/orgDb.js setItemLocations):
 *
 *   item.locations      [{ code, qty }]  ← THE SOURCE OF TRUTH
 *   item.locationCodes  ['W4-R1-B1', …]  ← flat mirror, so Firestore can index it
 *   item.stock          derived: sum of the shelf quantities
 *   item.location       derived: the shelf holding the most
 *
 * Anything that changes a quantity must go through applyAdjustment() +
 * writeItemLocations() so the derived fields can never drift from the shelves.
 * Writing `stock` on its own is what produced the quantity-vs-shelf mismatches
 * sitting in the data today.
 */

var STAGING_CODE = 'STAGING';

// Mirror of src/orgDb.js canonicalLocationCode — keep the two in step.
function canonicalLocationCode(code) {
  if (!code) return '';
  code = String(code).trim();
  var m = code.match(/^([A-Z]+\d+)-R(\d+)-([A-Z])-?(\d+)$/i);
  if (m) return m[1].toUpperCase() + '-R' + m[2] + '-' + m[3].toUpperCase() + m[4];
  m = code.match(/^([A-Z]+\d+)\s*R(\d+)\s*([A-Z])(\d+)$/i);
  if (m) return m[1].toUpperCase() + '-R' + m[2] + '-' + m[3].toUpperCase() + m[4];
  var parts = code.split('-').filter(function (p) { return p; });
  if (parts.length >= 3) {
    var w = parts[0].toUpperCase();
    var r = parts[1].replace(/^R/i, '');
    var ls = parts.slice(2).join('').match(/([A-Z])(\d+)/i);
    if (ls && /^[A-Z]+\d+$/i.test(w) && /^\d+$/.test(r)) {
      return w + '-R' + r + '-' + ls[1].toUpperCase() + ls[2];
    }
  }
  return code.toUpperCase();
}

// Normalise whatever an item currently holds into a clean [{code, qty}] array.
function itemLocations(d) {
  if (!d) return [];
  if (Array.isArray(d.locations)) {
    return d.locations
      .map(function (e) {
        return { code: canonicalLocationCode(e.code || e.location || ''), qty: parseInt(e.qty != null ? e.qty : e.quantity) || 0 };
      })
      .filter(function (e) { return e.code && e.qty > 0; });
  }
  var stock = parseInt(d.stock) || 0;
  var code = canonicalLocationCode(d.location || '');
  return (code && stock > 0) ? [{ code: code, qty: stock }] : [];
}

function derive(entries) {
  var clean = [];
  (entries || []).forEach(function (e) {
    var code = canonicalLocationCode(e.code || '');
    var qty = parseInt(e.qty) || 0;
    if (!code || qty <= 0) return;
    var found = clean.filter(function (c) { return c.code === code; })[0];
    if (found) found.qty += qty; else clean.push({ code: code, qty: qty });
  });
  var stock = clean.reduce(function (s, e) { return s + e.qty; }, 0);
  var primary = clean.slice().sort(function (a, b) { return b.qty - a.qty; })[0];
  return {
    locations: clean,
    locationCodes: clean.map(function (e) { return e.code; }),
    stock: stock,
    location: primary ? primary.code : ''
  };
}

/**
 * Work out the new shelf layout for an adjustment. Pure — writes nothing.
 *
 * opts: { delta | quantity, location }
 *   delta     relative change, may be positive or negative
 *   quantity  absolute value for the named shelf
 *   location  which shelf to apply it to
 *
 * When no shelf is named: an item on exactly one shelf uses that shelf, an
 * item on none routes an increase to STAGING, and an item spread across
 * several shelves is refused rather than guessed at — picking a shelf on the
 * operator's behalf is how stock silently ends up in the wrong bay.
 */
function applyAdjustment(itemData, opts) {
  var entries = itemLocations(itemData);
  var wantCode = opts.location ? canonicalLocationCode(opts.location) : '';
  var hasDelta = opts.delta !== undefined && opts.delta !== null && opts.delta !== '';
  var hasAbs = opts.quantity !== undefined && opts.quantity !== null && opts.quantity !== '';

  if (!hasDelta && !hasAbs) {
    throw new Error('Provide either "delta" (add or subtract) or "quantity" (set an absolute amount).');
  }
  if (hasDelta && hasAbs) {
    throw new Error('Provide "delta" or "quantity", not both.');
  }

  var target = wantCode;
  if (!target) {
    if (entries.length === 1) {
      target = entries[0].code;
    } else if (entries.length === 0) {
      var incoming = hasDelta ? parseInt(opts.delta) : parseInt(opts.quantity);
      if (!(incoming > 0)) {
        throw new Error('This item has no stock on any shelf, so there is nothing to remove.');
      }
      target = STAGING_CODE;
    } else {
      throw new Error(
        'This item sits on ' + entries.length + ' shelves (' +
        entries.map(function (e) { return e.code + ': ' + e.qty; }).join(', ') +
        '). Say which shelf the change applies to — pass "location".'
      );
    }
  }

  var existing = entries.filter(function (e) { return e.code === target; })[0];
  var before = existing ? existing.qty : 0;
  var after;

  if (hasDelta) {
    var delta = parseInt(opts.delta);
    if (!isFinite(delta)) throw new Error('"delta" must be a whole number.');
    if (delta === 0) throw new Error('A delta of 0 would change nothing.');
    after = before + delta;
    if (after < 0) {
      throw new Error(target + ' holds ' + before + ' of this item, so ' + Math.abs(delta) + ' cannot be removed from it.');
    }
  } else {
    after = parseInt(opts.quantity);
    if (!isFinite(after) || after < 0) throw new Error('"quantity" must be 0 or more.');
  }

  if (existing) existing.qty = after;
  else if (after > 0) entries.push({ code: target, qty: after });

  var derived = derive(entries);
  return {
    shelf: target,
    shelfBefore: before,
    shelfAfter: after,
    createdShelf: !existing && after > 0,
    clearedShelf: !!existing && after === 0,
    derived: derived
  };
}

// Persist a shelf layout and its derived fields in one write.
async function writeItemLocations(db, itemId, entries) {
  var derived = derive(entries);
  await db.collection('items').doc(itemId).update({
    locations: derived.locations,
    locationCodes: derived.locationCodes,
    stock: derived.stock,
    location: derived.location,
    updatedAt: Date.now()
  });
  return derived;
}

module.exports = {
  STAGING_CODE: STAGING_CODE,
  canonicalLocationCode: canonicalLocationCode,
  itemLocations: itemLocations,
  derive: derive,
  applyAdjustment: applyAdjustment,
  writeItemLocations: writeItemLocations
};
