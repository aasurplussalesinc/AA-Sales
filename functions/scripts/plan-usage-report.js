/**
 * Read-only: every organization's plan, status and usage against the plan limits (audit 2026-10-07).
 *     cd functions && node scripts/plan-usage-report.js
 * Prints org ids, plans and counts only (no names, emails or keys).
 */
const { LIMITS, monthKey } = require('../planLimits');
const { db, FieldValue } = require('./_cred');

(async () => {
  const orgs = await db.collection('organizations').get();
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  for (const o of orgs.docs) {
    const d = o.data();
    const plan = d.plan || 'trial';
    const lim = LIMITS[plan] || LIMITS.trial;
    const cnt = async (col, extra) => {
      let q = db.collection(col).where('orgId', '==', o.id);
      if (extra) q = extra(q);
      return (await q.count().get()).data().count;
    };
    const users = await cnt('orgMembers', (q) => q.where('status', '==', 'active'));
    const items = await cnt('items');
    const locations = await cnt('locations');
    const orders = (await db.collection('purchaseOrders').where('orgId', '==', o.id).get())
      .docs.filter((p) => monthKey(p.data().createdAt) === monthKey(new Date())).length;
    const over = [];
    for (const [k, v] of Object.entries({ users, items, locations, orders })) {
      if (lim[k] != null && v > lim[k]) over.push(`${k} ${v}/${lim[k]}`);
    }
    console.log(`${o.id.padEnd(28)} ${plan.padEnd(10)} ${(d.status || '').padEnd(10)} users ${users}  items ${items}  locations ${locations}  orders(this month) ${orders}${over.length ? '   OVER: ' + over.join(', ') : ''}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
