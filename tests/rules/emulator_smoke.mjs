// Emulator check of the 2026-10-26 plan rules (warehouse cap, unlimited orders, write keys Pro+, founder,
// usage protection) against the REAL Firestore emulator - the ground truth the engine in rules_test.js stands in for.
// Run from the repo root (Windows needs a short unix-socket dir: mkdir C:\jtmp first):
//   set JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\jtmp
//   firebase emulators:exec --only firestore --project demo-ss "node tests/rules/emulator_smoke.mjs"
// demo-ss is a demo project id: nothing touches the live project.
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = 'demo-ss';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

function enc(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}
const fields = (o) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, enc(x)]));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid) {
  const now = Math.floor(Date.now() / 1000);
  return b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({ sub: uid, user_id: uid, email: uid + '@x.com', email_verified: true,
    iat: now, exp: now + 3600, auth_time: now, aud: PROJECT, iss: 'https://securetoken.google.com/' + PROJECT, firebase: { sign_in_provider: 'password' } }) + '.';
}
async function put(path, data, who) {
  const r = await fetch(`${BASE}/${path}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + (who ? token(who) : 'owner'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fields(data) }) });
  return r.status;
}
async function create(col, id, data, who) {
  const r = await fetch(`${BASE}/${col}?documentId=${id}`, { method: 'POST', headers: { Authorization: 'Bearer ' + token(who), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fields(data) }) });
  return r.status;
}
async function update(path, data, who) {
  const mask = Object.keys(data).map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const r = await fetch(`${BASE}/${path}?${mask}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + token(who), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fields(data) }) });
  return r.status;
}

// seed (admin bypass)
await put('organizations/aa-surplus-sales', { plan: 'owner', createdBy: 'owner' });
await put('orgMembers/aa-surplus-sales_owner', { orgId: 'aa-surplus-sales', userId: 'owner', role: 'admin', status: 'active' });
await put('organizations/prowh', { plan: 'pro', createdBy: 'hal', name: 'ProWH', usage: { warehouseKey: 'site', warehouseKeys: ['A', 'B', 'C'], warehouses: 3, locations: 30, items: 1, users: 1 } });
await put('orgMembers/prowh_hal', { orgId: 'prowh', userId: 'hal', role: 'admin', status: 'active' });
await put('locations/locA', { orgId: 'prowh', site: 'A', rack: '1', locationCode: 'A-R1', inventory: {} });
await put('organizations/full', { plan: 'starter', createdBy: 'fay', usage: { items: 5000, users: 2, locations: 10, orders: 900, ordersMonth: 202610, warehouseKey: 'warehouse', warehouseKeys: ['W1'], warehouses: 1 } });
await put('orgMembers/full_fay', { orgId: 'full', userId: 'fay', role: 'admin', status: 'active' });
await put('organizations/fresh', { plan: 'starter', createdBy: 'ivy' });
await put('orgMembers/fresh_ivy', { orgId: 'fresh', userId: 'ivy', role: 'admin', status: 'active' });

const cases = [
  ['pro: shelf in existing warehouse', 200, () => create('locations', 'n1', { orgId: 'prowh', site: 'B', rack: '2' }, 'hal')],
  ['pro: 4th warehouse refused', 403, () => create('locations', 'n2', { orgId: 'prowh', site: 'D', rack: '1' }, 'hal')],
  ['STAGING ok', 200, () => create('locations', 'n3', { orgId: 'prowh', isStaging: true, site: '', locationCode: 'STAGING' }, 'hal')],
  ['no warehouse field ok', 200, () => create('locations', 'n4', { orgId: 'prowh', rack: '9' }, 'hal')],
  ['move shelf to 4th warehouse refused', 403, () => update('locations/locA', { site: 'Z', locationCode: 'Z-R1', updatedAt: 2 }, 'hal')],
  ['move shelf between existing ok', 200, () => update('locations/locA', { site: 'C', locationCode: 'C-R1', updatedAt: 3 }, 'hal')],
  ['stock mirror edit ok', 200, () => update('locations/locA', { inventory: { i1: 3 }, updatedAt: 4 }, 'hal')],
  ['starter: 2nd warehouse refused', 403, () => create('locations', 'n5', { orgId: 'full', warehouse: 'W2' }, 'fay')],
  ['fresh starter: first warehouse ok', 200, () => create('locations', 'n6', { orgId: 'fresh', warehouse: 'W1' }, 'ivy')],
  ['owner: unlimited warehouses', 200, () => create('locations', 'n7', { orgId: 'aa-surplus-sales', warehouse: 'W99' }, 'owner')],
  ['starter at 5,000 items: item refused', 403, () => create('items', 'i9', { orgId: 'full', sku: 'X' }, 'fay')],
  ['orders unlimited: starter order ok', 200, () => create('purchaseOrders', 'po1', { orgId: 'full', number: 'AA9' }, 'fay')],
  ['starter: write key refused', 403, () => create('apiKeys', 'k1', { orgId: 'full', scope: 'write', revoked: false }, 'fay')],
  ['starter: read key ok', 200, () => create('apiKeys', 'k2', { orgId: 'full', scope: 'read', revoked: false }, 'fay')],
  ['pro: write key ok', 200, () => create('apiKeys', 'k3', { orgId: 'prowh', scope: 'write', revoked: false }, 'hal')],
  ['admin cannot set founder on own org', 403, () => update('organizations/prowh', { founder: true }, 'hal')],
  ['admin cannot reset usage', 403, () => update('organizations/prowh', { usage: { items: 0 } }, 'hal')],
  ['admin sets aiNotes', 200, () => update('organizations/prowh', { aiNotes: 'Grades A/B', updatedAt: 5 }, 'hal')],
  ['owner sets founder', 200, () => update('organizations/prowh', { founder: true, founderSetAt: 6, updatedAt: 6 }, 'owner')],
  ['owner founder + plan refused', 403, () => update('organizations/prowh', { founder: false, plan: 'enterprise' }, 'owner')],
  ['founder must be bool', 403, () => update('organizations/prowh', { founder: 'yes' }, 'owner')],
  ['signup cannot be founder', 403, () => create('organizations', 'newco', { createdBy: 'zoe', plan: 'trial', founder: true }, 'zoe')],
  ['signup ok', 200, () => create('organizations', 'newco2', { createdBy: 'zoe', plan: 'trial' }, 'zoe')],
];
let fail = 0;
for (const [name, want, fn] of cases) {
  const got = await fn();
  const ok = got === want;
  if (!ok) fail++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + ' (want ' + want + ', got ' + got + ')');
}
console.log(fail ? fail + ' FAILED' : 'all ' + cases.length + ' emulator cases passed');
process.exit(fail ? 1 : 0);
