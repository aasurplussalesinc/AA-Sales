// Pure stock arithmetic for shelf-aware writes. No Firestore here, so every
// rule can be unit tested; orgDb.js does the reads, writes and movements.
//
// The invariant these protect: an item's `stock` equals the sum of its
// `locations[].qty`, and a shelf entry at qty <= 0 is dropped. Every helper
// takes the item's current entries and returns the new entries plus the
// before/after numbers the movement records.
//
// Why this exists: SKU 4634 ended up ~10 units high after stock was put back
// for an order whose units had already been restored or never taken. Restores
// used `stock = dbItem.stock + qty` (a string stock concatenates), ignored the
// shelves, and had no memory of what had already been put back.

// Number() with NaN/Infinity treated as 0, truncated to a whole unit. A stock
// field stored as the string "19" must add as 19, never concatenate to "195".
export function toQty(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

const id = (c) => String(c || '').trim();

// Merge duplicate codes, drop blanks and qty <= 0. `canon` canonicalises codes
// (orgDb passes canonicalLocationCode); entries may use {code, qty} or the
// older {location, quantity}.
export function cleanEntries(entries, canon = id) {
  const out = [];
  (entries || []).forEach(e => {
    if (!e) return;
    const code = canon(e.code || e.location || '');
    const qty = toQty(e.qty !== undefined ? e.qty : e.quantity);
    if (!code || qty <= 0) return;
    const hit = out.find(o => o.code === code);
    if (hit) hit.qty += qty; else out.push({ code, qty });
  });
  return out;
}

export function sumEntries(entries) {
  return (entries || []).reduce((s, e) => s + toQty(e && e.qty), 0);
}

export function shelfQty(entries, code) {
  const hit = (entries || []).find(e => e.code === code);
  return hit ? toQty(hit.qty) : 0;
}

// The largest holding - what `item.location` points at.
export function primaryShelf(entries) {
  const top = (entries || []).slice().sort((a, b) => toQty(b.qty) - toQty(a.qty))[0];
  return top ? top.code : '';
}

// An item with stock but no shelf at all (the "stock but no shelf assigned"
// class) would lose that stock the moment its shelves are rewritten, because
// stock is re-derived from the shelves. Put the unshelved units in STAGING
// first so a write only ever changes what it means to change.
export function seedUnshelved(entries, stock, stagingCode = 'STAGING') {
  const clean = cleanEntries(entries);
  const s = toQty(stock);
  if (clean.length || s <= 0) return { entries: clean, seeded: 0 };
  return { entries: [{ code: stagingCode, qty: s }], seeded: s };
}

function copy(entries) { return cleanEntries(entries).map(e => ({ ...e })); }

// Add qty at a shelf (created if missing).
export function addAtShelf(entries, code, qty) {
  const amount = toQty(qty);
  const cur = copy(entries);
  const before = sumEntries(cur);
  const shelfBefore = shelfQty(cur, code);
  if (!code || amount <= 0) {
    return { entries: cur, before, after: before, shelfBefore, shelfAfter: shelfBefore, added: 0 };
  }
  const hit = cur.find(e => e.code === code);
  if (hit) hit.qty += amount; else cur.push({ code, qty: amount });
  return { entries: cur, before, after: sumEntries(cur), shelfBefore, shelfAfter: shelfQty(cur, code), added: amount };
}

// Take qty off a shelf. The named shelf if the item is on it, else the largest
// holding. With `spill`, anything the first shelf can't cover comes off the
// other shelves, largest first; without it the removal stops at that shelf's
// quantity. `removed` is what actually came off, never more than was there.
export function removeFromShelf(entries, code, qty, opts = {}) {
  const amount = toQty(qty);
  const cur = copy(entries);
  const before = sumEntries(cur);
  const taken = [];
  if (amount <= 0 || !cur.length) {
    return { entries: cur, before, after: before, removed: 0, taken, shelf: code || '' };
  }
  let first = cur.find(e => e.code === code);
  if (!first) first = cur.slice().sort((a, b) => b.qty - a.qty)[0];
  const order = [first];
  if (opts.spill) {
    cur.filter(e => e !== first).sort((a, b) => b.qty - a.qty).forEach(e => order.push(e));
  }
  let left = amount;
  for (const e of order) {
    if (left <= 0) break;
    const take = Math.min(e.qty, left);
    if (take <= 0) continue;
    e.qty -= take;
    left -= take;
    taken.push({ code: e.code, qty: take });
  }
  const next = cur.filter(e => e.qty > 0);
  return { entries: next, before, after: sumEntries(next), removed: amount - left, taken, shelf: first.code };
}

// A physical count is the truth for that shelf: set it to the counted number
// (drop it at 0, add it if the item wasn't listed there). The item total is
// re-derived from the shelves, so other shelves are untouched.
export function applyCount(entries, code, counted) {
  const cur = copy(entries);
  const n = Math.max(0, toQty(counted));
  const before = sumEntries(cur);
  const shelfBefore = shelfQty(cur, code);
  let next = cur.filter(e => e.code !== code);
  if (n > 0) {
    const idx = cur.findIndex(e => e.code === code);
    const entry = { code, qty: n };
    if (idx >= 0) next.splice(Math.min(idx, next.length), 0, entry); else next.push(entry);
  }
  const after = sumEntries(next);
  return { entries: next, before, after, shelfBefore, shelfAfter: n, changed: shelfBefore !== n };
}

// Items tab quick +/- . A chosen shelf is used as given. With no shelf:
// additions go to STAGING (received, not yet put away) and removals come off
// the primary shelf, spilling onto the others so the total drops by exactly
// what was asked (never below zero).
// `seedCode`: where unshelved stock is placed first (default STAGING).
export function planQuickAdjust(entries, { type, qty, shelf, stock, stagingCode = 'STAGING', seedCode } = {}) {
  const seed = seedUnshelved(entries, stock, seedCode || stagingCode);
  const amount = toQty(qty);
  if (type === 'add') {
    const target = shelf || stagingCode;
    const r = addAtShelf(seed.entries, target, amount);
    return { ...r, delta: r.after - r.before, fromLocation: '', toLocation: target, seeded: seed.seeded };
  }
  const target = shelf || primaryShelf(seed.entries);
  const r = removeFromShelf(seed.entries, target, amount, { spill: !shelf });
  return {
    ...r, delta: r.after - r.before,
    fromLocation: r.taken.map(t => t.code).join(', '), toLocation: '', seeded: seed.seeded
  };
}

// ── Order restores ─────────────────────────────────────────────────────────
// What a PICK movement actually took. before/after are the item totals around
// the write, so their difference is the real removal even when the shelf held
// less than was asked for; older movements without them fall back to quantity.
export function unitsPicked(m) {
  const b = m && m.beforeQty, a = m && m.afterQty;
  if (b !== undefined && b !== null && b !== '' && a !== undefined && a !== null && a !== '') {
    return Math.max(0, toQty(b) - toQty(a));
  }
  return Math.max(0, toQty(m && m.quantity));
}

export function unitsRestored(m) {
  const b = m && m.beforeQty, a = m && m.afterQty;
  if (b !== undefined && b !== null && b !== '' && a !== undefined && a !== null && a !== '') {
    return Math.max(0, toQty(a) - toQty(b));
  }
  return Math.max(0, toQty(m && m.quantity));
}

// What may be put back for an order, from the ledger rather than from what the
// order says it shipped. Inputs: the order and every movement tagged with its
// id (PICK movements carry orderId since 9d59998; RESTORE movements from this
// change on). Per item and per shelf picked from:
//   outstanding = units picked for this order - units already restored for it
// so a second restore (cancel then delete, a double click, two tabs) finds
// nothing left. Orders with no tagged PICK movement restore nothing - either
// nothing was taken, or it was taken before picks were tagged and the ledger
// can't say how much; `unverifiable` flags the second case for a human.
export function planOrderRestore(order, movements) {
  const o = order || {};
  const mine = (movements || []).filter(m => m && (!o.id || m.orderId === o.id));
  const picks = mine.filter(m => String(m.type || '').toUpperCase() === 'PICK');
  const restores = mine.filter(m => String(m.type || '').toUpperCase() === 'RESTORE');

  const base = { lines: [], pickedUnits: 0, restoredUnits: 0, outstandingUnits: 0, skipped: null, unverifiable: false };

  if (!picks.length) {
    return { ...base, skipped: 'nothing-picked', unverifiable: !!o.stockDeducted };
  }
  // The flag short-circuits only when nothing was picked after the restore it
  // records (an order cancelled, reopened and picked again must restore the
  // new picks). The ledger arithmetic below would reach the same answer; the
  // flag is a second, independent guard.
  if (o.stockRestored) {
    const at = toQty(o.stockRestoredAt);
    if (!picks.some(m => toQty(m.timestamp) > at)) {
      return { ...base, skipped: 'already-restored' };
    }
  }

  const items = new Map(); // itemId -> { info, shelves: Map(shelfKey -> picked), restoredByShelf, restoredTotal }
  const itemFor = (m) => {
    if (!items.has(m.itemId)) {
      items.set(m.itemId, {
        itemId: m.itemId, itemName: m.itemName || '', sku: m.sku || '', grade: m.grade || '',
        shelves: new Map(), restoredByShelf: new Map(), restoredTotal: 0
      });
    }
    return items.get(m.itemId);
  };

  picks.slice().sort((a, b) => toQty(a.timestamp) - toQty(b.timestamp)).forEach(m => {
    if (!m.itemId) return;
    const q = unitsPicked(m);
    if (q <= 0) return;
    const it = itemFor(m);
    const key = String(m.fromLocation || '');
    it.shelves.set(key, (it.shelves.get(key) || 0) + q);
  });
  restores.forEach(m => {
    if (!m.itemId) return;
    const q = unitsRestored(m);
    if (q <= 0) return;
    const it = itemFor(m);
    const key = String(m.pickShelf !== undefined ? m.pickShelf : (m.toLocation || ''));
    it.restoredByShelf.set(key, (it.restoredByShelf.get(key) || 0) + q);
    it.restoredTotal += q;
  });

  let pickedUnits = 0, restoredUnits = 0;
  const lines = [];
  for (const it of items.values()) {
    const pickedTotal = [...it.shelves.values()].reduce((s, q) => s + q, 0);
    pickedUnits += pickedTotal;
    restoredUnits += Math.min(it.restoredTotal, pickedTotal);
    // Restores matched to the shelf they were for first, then any remainder
    // (e.g. a restore that recorded a different key) off the other shelves.
    const net = new Map();
    let unmatched = 0;
    for (const [key, q] of it.restoredByShelf) {
      const p = it.shelves.get(key) || 0;
      const used = Math.min(p, q);
      unmatched += q - used;
      if (p) net.set(key, p - used);
    }
    for (const [key, p] of it.shelves) if (!net.has(key)) net.set(key, p);
    for (const [key, left] of net) {
      if (unmatched <= 0) break;
      const used = Math.min(left, unmatched);
      net.set(key, left - used);
      unmatched -= used;
    }
    for (const [key, q] of net) {
      if (q > 0) lines.push({ itemId: it.itemId, itemName: it.itemName, sku: it.sku, grade: it.grade, pickShelf: key, qty: q });
    }
  }
  const outstandingUnits = lines.reduce((s, l) => s + l.qty, 0);
  return {
    ...base, lines, pickedUnits, restoredUnits, outstandingUnits,
    skipped: outstandingUnits > 0 ? null : 'already-restored'
  };
}

// Where a restored line goes: the shelf it was picked from; a pick with no
// shelf recorded goes to the item's primary shelf, else STAGING.
export function restoreShelf(pickShelf, entries, stagingCode = 'STAGING') {
  // A removal that spilled over several shelves records "A, B"; the first is
  // the one it was aimed at.
  const first = String(pickShelf || '').split(',')[0].trim();
  if (first) return first;
  return primaryShelf(cleanEntries(entries)) || stagingCode;
}
