/**
 * Plan limits - the server's copy of src/useTier.js LIMITS (keep the two in step; tests/unit/planLimits.test.mjs
 * checks they match). null = unlimited. 'orders' = purchase orders created per calendar month (UTC).
 * Server enforcement added in the 2026-10-07 security audit: until then these were only checked in the browser.
 */
const LIMITS = {
  trial:      { users: 15,   orders: 1000, items: 10000, warehouses: 2,    locations: 500   },
  starter:    { users: 2,    orders: 50,   items: 2000,  warehouses: 1,    locations: 250   },
  pro:        { users: 5,    orders: 200,  items: 10000, warehouses: 3,    locations: 2000  },
  business:   { users: 15,   orders: 1000, items: 50000, warehouses: 10,   locations: 20000 },
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
  const usage = await recountUsage(db, orgId);
  const used = usage ? usage[kind] : 0;
  if (used >= lim) {
    const label = { orders: 'orders this month', items: 'items', users: 'users', locations: 'locations' }[kind] || kind;
    throw makeError(`Your ${d.plan || 'trial'} plan includes ${lim} ${label} (you have ${used}). Upgrade to add more.`, 403);
  }
}

module.exports.recountUsage = recountUsage;
module.exports.assertUnderLimit = assertUnderLimit;
