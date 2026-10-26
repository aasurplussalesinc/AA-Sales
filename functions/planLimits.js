/**
 * Plan limits - the server's copy of src/useTier.js LIMITS (keep the two in step; tests/unit/planLimits.test.mjs
 * checks they match). null = unlimited. 'orders' = purchase orders created per calendar month (UTC) - unlimited on
 * every plan since 2026-10-26, still counted for reporting. 'warehouses' = distinct top-level location values
 * (the first level of the org's location schema, e.g. W1, W2).
 * Server enforcement added in the 2026-10-07 security audit: until then these were only checked in the browser.
 */
const LIMITS = {
  trial:      { users: 15,   orders: null, items: 10000, warehouses: 2,    locations: 500   },
  starter:    { users: 2,    orders: null, items: 5000,  warehouses: 1,    locations: 250   },
  pro:        { users: 5,    orders: null, items: 10000, warehouses: 3,    locations: 2000  },
  business:   { users: 15,   orders: null, items: 50000, warehouses: 10,   locations: 20000 },
  enterprise: { users: null, orders: null, items: null,  warehouses: null, locations: null  },
  owner:      { users: null, orders: null, items: null,  warehouses: null, locations: null  },
};

function limitFor(plan, kind) {
  const l = LIMITS[plan] || LIMITS.trial;
  return l[kind] === undefined ? null : l[kind];
}

function toDate(v) {
  if (!v) return null;
  if (v.toDate) return v.toDate();
  if (typeof v === 'number') return new Date(v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 'YYYY-MM' in UTC, for the monthly order counter. */
function monthKey(v) {
  const d = toDate(v) || new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = { LIMITS, limitFor, monthKey, toDate };

/**
 * Recount an org's usage exactly (count() aggregations, so ~1 read per 1,000 documents) and store it on the org
 * doc as `usage`. firestore.rules reads it to refuse creates past the plan's caps; triggers in index.js call this.
 */
async function recountUsage(db, orgId) {
  if (!orgId) return null;
  const count = async (q) => (await q.count().get()).data().count;
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const [users, items, locations, orders] = await Promise.all([
    count(db.collection('orgMembers').where('orgId', '==', orgId).where('status', '==', 'active')),
    count(db.collection('items').where('orgId', '==', orgId)),
    count(db.collection('locations').where('orgId', '==', orgId)),
    count(db.collection('purchaseOrders').where('orgId', '==', orgId).where('createdAt', '>=', monthStart)),
  ]);
  const usage = {
    users, items, locations, orders,
    ordersMonth: now.getUTCFullYear() * 100 + now.getUTCMonth() + 1,   // yyyymm, compared in the rules
    countedAt: Date.now(),
  };
  await db.collection('organizations').doc(orgId).set({ usage }, { merge: true });
  return usage;
}

/** Throws (via makeError) when creating one more `kind` would exceed the org's plan. Server-side writers use it. */
async function assertUnderLimit(db, orgId, kind, makeError) {
  const org = await db.collection('organizations').doc(orgId).get();
  const d = org.data() || {};
  const lim = limitFor(d.plan || 'trial', kind);
  if (lim == null) return;
  const usage = kind === 'warehouses'
    ? { warehouses: (await recountWarehouses(db, orgId)).length }
    : await recountUsage(db, orgId);
  const used = usage ? usage[kind] : 0;
  if (used >= lim) {
    const label = { orders: 'orders this month', items: 'items', users: 'users', locations: 'locations', warehouses: 'warehouses' }[kind] || kind;
    throw makeError(`Your ${d.plan || 'trial'} plan includes ${lim} ${label} (you have ${used}). Upgrade to add more.`, 403);
  }
}

module.exports.recountUsage = recountUsage;
module.exports.assertUnderLimit = assertUnderLimit;

// ── Warehouse cap (2026-10-26) ──
// A "warehouse" is a distinct value of the first level of the org's location schema (key 'warehouse' by default:
// W1, W2 ...). Until now only the browser checked it. organizations/{orgId}.usage keeps:
//   warehouseKey  - which location field names the warehouse
//   warehouseKeys - the distinct values in use (sorted)
//   warehouses    - how many
// firestore.rules lets a location be created (or moved) into a warehouse that is already in warehouseKeys, or into a
// new one while warehouseKeys is below the plan's cap. STAGING and locations with no warehouse value never count.

/** The location field that names the warehouse: the first level of the org's location schema. */
function warehouseKeyOf(org) {
  const levels = org && org.locationSchema && Array.isArray(org.locationSchema.levels) ? org.locationSchema.levels : [];
  return (levels[0] && levels[0].key) || 'warehouse';
}

/** The warehouse a location sits in, or '' for STAGING / none. */
function warehouseOf(loc, key) {
  if (!loc || loc.isStaging === true) return '';
  const v = loc[key || 'warehouse'];
  return v === undefined || v === null ? '' : String(v).trim();
}

/** Exact recount: reads every location of the org once (only the warehouse field). Rare - see syncWarehouses. */
async function recountWarehouses(db, orgId, org) {
  if (!orgId) return [];
  const orgRef = db.collection('organizations').doc(orgId);
  const data = org || (await orgRef.get()).data() || {};
  const key = warehouseKeyOf(data);
  let q = db.collection('locations').where('orgId', '==', orgId);
  if (typeof q.select === 'function') q = q.select(key, 'isStaging');
  const snap = await q.get();
  const set = new Set();
  snap.docs.forEach((d) => { const w = warehouseOf(d.data(), key); if (w) set.add(w); });
  const keys = Array.from(set).sort();
  await orgRef.set({ usage: { warehouseKey: key, warehouseKeys: keys, warehouses: keys.length } }, { merge: true });
  return keys;
}

/**
 * Keep usage.warehouseKeys right after a location is created, deleted or edited (before/after = document data or
 * null). Cheap in the common case: a new shelf in a warehouse already on the list costs one org read and no write.
 */
async function syncWarehouses(db, orgId, before, after) {
  if (!orgId) return [];
  const orgRef = db.collection('organizations').doc(orgId);
  const org = (await orgRef.get()).data() || {};
  const key = warehouseKeyOf(org);
  const u = org.usage || {};
  const known = Array.isArray(u.warehouseKeys) && u.warehouseKey === key ? u.warehouseKeys : null;
  if (!known) return recountWarehouses(db, orgId, org);              // first time, or the schema's first level changed
  const was = warehouseOf(before, key), now = warehouseOf(after, key);
  if (was === now) return known;
  let keys = known;
  if (now && keys.indexOf(now) === -1) keys = keys.concat([now]).sort();
  if (was && keys.indexOf(was) !== -1) {
    const still = await db.collection('locations').where('orgId', '==', orgId).where(key, '==', was).limit(1).get();
    if (still.empty) keys = keys.filter((k) => k !== was);
  }
  if (keys !== known) await orgRef.set({ usage: { warehouseKey: key, warehouseKeys: keys, warehouses: keys.length } }, { merge: true });
  return keys;
}

module.exports.warehouseKeyOf = warehouseKeyOf;
module.exports.warehouseOf = warehouseOf;
module.exports.recountWarehouses = recountWarehouses;
module.exports.syncWarehouses = syncWarehouses;
