/**
 * Move carrier API keys out of organizations/{orgId}.settings into orgSecrets/{orgId} (audit 2026-10-07).
 * Run AFTER the new functions are deployed AND the new Shipping page is live (pushed), so nothing reads the old
 * field any more:
 *     cd functions && node scripts/migrate-carrier-keys.js          (dry run: lists what would move)
 *     cd functions && node scripts/migrate-carrier-keys.js --apply
 * Uses the default credentials of `firebase login` / GOOGLE_APPLICATION_CREDENTIALS. Prints no key values.
 */
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
const FIELDS = ['shippoApiKey', 'shipstationApiKey', 'easypostApiKey'];
const apply = process.argv.includes('--apply');
const hint = (v) => (v ? `${String(v).slice(0, 4)}…${String(v).slice(-4)}` : '');

(async () => {
  const orgs = await db.collection('organizations').get();
  let moved = 0;
  for (const o of orgs.docs) {
    const st = o.data().settings || {};
    const found = FIELDS.filter((f) => typeof st[f] === 'string' && st[f]);
    const blank = FIELDS.filter((f) => f in st && !st[f]);
    if (!found.length && !blank.length) continue;
    console.log(`${o.id}: ${found.join(', ') || '(only empty fields)'}${apply ? '' : '  [dry run]'}`);
    if (!apply) continue;
    const secrets = {}; const upd = {};
    for (const f of found) { secrets[f] = st[f]; upd[`settings.carrierKeyHints.${f}`] = hint(st[f]); }
    for (const f of [...found, ...blank]) upd[`settings.${f}`] = admin.firestore.FieldValue.delete();
    if (found.length) {
      await db.collection('orgSecrets').doc(o.id).set({ ...secrets, migratedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    await o.ref.update(upd);
    moved++;
  }
  console.log(apply ? `moved keys for ${moved} org(s)` : 'dry run only; add --apply to move');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
