/**
 * Recount organizations/{orgId}.usage for every org (plan caps, audit 2026-10-07). Safe to re-run any time.
 *     cd functions && node scripts/recount-usage.js
 */
const { db } = require('./_cred');
const { recountUsage } = require('../planLimits');

(async () => {
  const orgs = await db.collection('organizations').get();
  for (const o of orgs.docs) {
    const u = await recountUsage(db, o.id);
    console.log(o.id.padEnd(28), JSON.stringify({ users: u.users, items: u.items, locations: u.locations, orders: u.orders }));
  }
  process.exit(0);
})().catch((e) => { console.error(e.message.split('\n')[0]); process.exit(1); });
