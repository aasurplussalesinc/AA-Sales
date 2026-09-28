// Pure helpers for the stock-history ledger (the `movements` collection).
// No Firestore here, so they can be unit tested; orgDb.js and Movements.jsx
// do the reads and writes.
//
// Two items can share a name (SKU 4634 NEW and SKU 4412 #1 are both
// "PARKA PRIMALOFT GEN III FOLIAGE ARMY LR"), so every movement written from
// 2026-09-28 carries `sku` and `grade`, and older ones are filled in from the
// item for display.

// Every type the app, API and MCP write. The Movements filter lists these
// plus anything else found in the data.
export const MOVEMENT_TYPES = ['ADD', 'ADJUST', 'CREATE', 'IMPORT', 'MOVE', 'PICK', 'RECEIVE', 'RESTORE'];

function shelfMap(entries) {
  const m = {};
  (entries || []).forEach(e => {
    const code = String(e.code || '');
    if (!code) return;
    m[code] = (m[code] || 0) + (parseInt(e.qty) || 0);
  });
  return m;
}

// The movement to log for a path that writes the item directly (edit form,
// grid, CSV import). `before` / `after` are { stock, locations: [{code, qty}] }
// with codes already canonical. Returns null when neither the total nor any
// shelf changed, so a save that touched only the name or price logs nothing.
export function stockChangeMovement(before, after, meta = {}) {
  const bq = parseInt(before && before.stock) || 0;
  const aq = parseInt(after && after.stock) || 0;
  const bm = shelfMap(before && before.locations);
  const am = shelfMap(after && after.locations);
  const codes = [...new Set([...Object.keys(bm), ...Object.keys(am)])].sort();
  const down = codes.filter(c => (am[c] || 0) < (bm[c] || 0));
  const up = codes.filter(c => (am[c] || 0) > (bm[c] || 0));
  if (bq === aq && !down.length && !up.length) return null;
  const out = {
    type: meta.type || 'ADJUST',
    quantity: Math.abs(aq - bq),
    beforeQty: bq,
    afterQty: aq,
    fromLocation: down.join(', '),
    toLocation: up.join(', '),
    beforeLocations: codes.filter(c => bm[c]).map(c => ({ code: c, qty: bm[c] })),
    afterLocations: codes.filter(c => am[c]).map(c => ({ code: c, qty: am[c] }))
  };
  if (meta.reason) out.reason = meta.reason;
  return out;
}

// Old movements carry only itemId/itemName. Fill sku/grade from the item so
// same-named items can be told apart. A stored value always wins.
export function enrichMovements(movements, itemsById) {
  return (movements || []).map(m => {
    const it = (itemsById && m.itemId && itemsById[m.itemId]) || null;
    return {
      ...m,
      sku: m.sku !== undefined && m.sku !== null ? m.sku : (it ? (it.partNumber || '') : ''),
      grade: m.grade !== undefined && m.grade !== null ? m.grade : (it ? (it.grade || '') : '')
    };
  });
}

// Items whose SKU is exactly what was typed (trimmed, case-insensitive).
export function itemsWithExactSku(items, search) {
  const s = String(search || '').trim().toLowerCase();
  if (!s) return [];
  return (items || []).filter(i => String(i.partNumber || '').trim().toLowerCase() === s);
}

// Free-text match on an (enriched) movement. When the text is an exact SKU,
// only that item's movements match - a SKU of "44" must not pull in "4412".
export function movementMatchesSearch(m, search, exactSkuItemIds) {
  const s = String(search || '').trim().toLowerCase();
  if (!s) return true;
  if (exactSkuItemIds && exactSkuItemIds.size) {
    return exactSkuItemIds.has(m.itemId) || String(m.sku || '').trim().toLowerCase() === s;
  }
  return [m.itemName, m.sku, m.grade, m.fromLocation, m.toLocation, m.orderNumber]
    .some(v => String(v || '').toLowerCase().includes(s));
}

export function movementTypeOptions(movements) {
  const present = (movements || []).map(m => m.type).filter(Boolean);
  return [...new Set([...MOVEMENT_TYPES, ...present])].sort();
}
