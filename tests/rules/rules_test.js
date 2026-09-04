'use strict';
const { loadRules, evaluate } = require('./rulesengine.js');
const P = '/databases/(default)/documents/';

const DB = {};
const put = (p, d) => { DB[P + p] = d; };
put('organizations/acme',   { id:'acme', name:'Acme', createdBy:'alice', plan:'trial', status:'active', stripeCustomerId:'cus_1', onboardingStep:1, updatedAt:1 });
put('organizations/victim', { id:'victim', name:'Victim', createdBy:'bob', plan:'pro', status:'active', updatedAt:1 });
put('organizations/aa-surplus-sales', { id:'aa-surplus-sales', createdBy:'owner', plan:'owner', status:'active', updatedAt:1 });
put('organizations/zoeco',  { id:'zoeco', name:'ZoeCo', createdBy:'zoe', plan:'trial', status:'active', updatedAt:1 });
put('orgMembers/acme_alice',  { orgId:'acme', userId:'alice', role:'admin',   status:'active' });
put('orgMembers/acme_dave',   { orgId:'acme', userId:'dave',  role:'manager', status:'active' });
put('orgMembers/acme_carol',  { orgId:'acme', userId:'carol', role:'staff',   status:'active' });
put('orgMembers/acme_erin',   { orgId:'acme', userId:'erin',  role:'staff',   status:'removed' });
put('orgMembers/acme_frank',  { orgId:'acme', userId:'frank', role:'staff' });
put('orgMembers/victim_bob',  { orgId:'victim', userId:'bob', role:'admin',   status:'active' });
put('orgMembers/aa-surplus-sales_owner', { orgId:'aa-surplus-sales', userId:'owner', role:'admin', status:'active' });
put('orgMembers/aa-surplus-sales_ops',   { orgId:'aa-surplus-sales', userId:'ops',   role:'staff', status:'active' });
put('inviteCodes/GOOD-CODE', { code:'GOOD-CODE', orgId:'acme', role:'staff', status:'active', uses:0, maxUses:5, updatedAt:1 });
put('inviteCodes/DEAD-CODE', { code:'DEAD-CODE', orgId:'acme', role:'admin', status:'revoked', uses:1, maxUses:1, updatedAt:1 });
put('invitations/inv1', { orgId:'acme', role:'staff', status:'pending', email:'newbie@x.com', token:'t1' });
put('items/item1',   { orgId:'acme',   sku:'2091', quantity:5 });
put('items/item2',   { orgId:'victim', sku:'9999', quantity:7 });
put('expenses/exp1', { orgId:'acme', amount:100 });
put('apiKeys/key1',  { orgId:'acme', hash:'x', scope:'read', revoked:false, updatedAt:1 });
put('movements/mv1', { orgId:'acme', delta:-1 });
put('activityLog/log1', { orgId:'acme', action:'x' });

const U = (uid, email, verified) => ({ uid, token:{ email: email || (uid + '@x.com'), email_verified: verified === undefined ? true : verified } });
const alice = U('alice'), dave = U('dave'), carol = U('carol'), erin = U('erin'), frank = U('frank');
const bob = U('bob'), owner = U('owner'), ops = U('ops'), zoe = U('zoe');
const mallory = U('mallory');
const newbie = U('newbie', 'newbie@x.com');
const newbieUnverified = U('newbie', 'newbie@x.com', false);
const D = (p) => DB[P + p];

const CASES = [];
const T = (name, expect, req) => CASES.push([name, expect, req]);

// ---- tenant isolation on business data ---------------------------------
T('staff reads own org item',      true,  { path:P+'items/item1', op:'get', auth:carol, resource:D('items/item1') });
T('staff reads other org item',    false, { path:P+'items/item2', op:'get', auth:carol, resource:D('items/item2') });
T('admin of other org reads item', false, { path:P+'items/item1', op:'get', auth:bob,   resource:D('items/item1') });
T('unauthenticated reads item',    false, { path:P+'items/item1', op:'get', auth:null,  resource:D('items/item1') });
T('staff cannot update item',      false, { path:P+'items/item1', op:'update', auth:carol, resource:D('items/item1'), request_resource:{ orgId:'acme', sku:'2091', quantity:6 } });
T('manager updates item',          true,  { path:P+'items/item1', op:'update', auth:dave,  resource:D('items/item1'), request_resource:{ orgId:'acme', sku:'2091', quantity:6 } });
T('manager cannot move item to another org', false, { path:P+'items/item1', op:'update', auth:dave, resource:D('items/item1'), request_resource:{ orgId:'victim', sku:'2091', quantity:6 } });
T('manager cannot delete item',    false, { path:P+'items/item1', op:'delete', auth:dave, resource:D('items/item1') });
T('admin deletes item',            true,  { path:P+'items/item1', op:'delete', auth:alice, resource:D('items/item1') });
T('staff creates PO in own org',   true,  { path:P+'purchaseOrders/po9', op:'create', auth:carol, request_resource:{ orgId:'acme', number:'AA1' } });
T('staff creates PO in other org', false, { path:P+'purchaseOrders/po9', op:'create', auth:carol, request_resource:{ orgId:'victim', number:'AA1' } });

// ---- off-boarded and legacy members ------------------------------------
T('removed member cannot read',    false, { path:P+'items/item1', op:'get', auth:erin,  resource:D('items/item1') });
T('legacy member without status can read', true, { path:P+'items/item1', op:'get', auth:frank, resource:D('items/item1') });

// ---- THE HOLE: minting your own membership -----------------------------
T('outsider mints admin membership in another org', false,
  { path:P+'orgMembers/victim_mallory', op:'create', auth:mallory,
    request_resource:{ orgId:'victim', userId:'mallory', role:'admin', status:'active' } });
T('acme staff mints admin membership in victim org', false,
  { path:P+'orgMembers/victim_carol', op:'create', auth:carol,
    request_resource:{ orgId:'victim', userId:'carol', role:'admin', status:'active' } });
T('staff promotes self to admin in own org', false,
  { path:P+'orgMembers/acme_carol', op:'update', auth:carol,
    resource:D('orgMembers/acme_carol'), request_resource:{ orgId:'acme', userId:'carol', role:'admin', status:'active' } });
T('membership id must match its own orgId/userId', false,
  { path:P+'orgMembers/acme_mallory', op:'create', auth:mallory,
    request_resource:{ orgId:'victim', userId:'mallory', role:'admin', status:'active' } });

// ---- the legitimate ways a membership appears --------------------------
T('admin adds a member', true,
  { path:P+'orgMembers/acme_newguy', op:'create', auth:alice,
    request_resource:{ orgId:'acme', userId:'newguy', role:'staff', status:'active' } });
T('org creator becomes first admin', true,
  { path:P+'orgMembers/zoeco_zoe', op:'create', auth:zoe,
    request_resource:{ orgId:'zoeco', userId:'zoe', role:'admin', status:'active' } });
T('non-creator cannot claim first admin', false,
  { path:P+'orgMembers/zoeco_mallory', op:'create', auth:mallory,
    request_resource:{ orgId:'zoeco', userId:'mallory', role:'admin', status:'active' } });
T('self-join with a live invite code', true,
  { path:P+'orgMembers/acme_newbie', op:'create', auth:newbie,
    request_resource:{ orgId:'acme', userId:'newbie', role:'staff', status:'active', inviteCode:'GOOD-CODE' } });
T('self-join with a revoked invite code', false,
  { path:P+'orgMembers/acme_newbie', op:'create', auth:newbie,
    request_resource:{ orgId:'acme', userId:'newbie', role:'admin', status:'active', inviteCode:'DEAD-CODE' } });
T('invite code cannot be upgraded to a better role', false,
  { path:P+'orgMembers/acme_newbie', op:'create', auth:newbie,
    request_resource:{ orgId:'acme', userId:'newbie', role:'admin', status:'active', inviteCode:'GOOD-CODE' } });
T("invite code for another org cannot join this one", false,
  { path:P+'orgMembers/victim_newbie', op:'create', auth:newbie,
    request_resource:{ orgId:'victim', userId:'newbie', role:'staff', status:'active', inviteCode:'GOOD-CODE' } });
T('self-join with no invite code at all', false,
  { path:P+'orgMembers/acme_newbie', op:'create', auth:newbie,
    request_resource:{ orgId:'acme', userId:'newbie', role:'staff', status:'active' } });
T('membership cannot be created already removed', false,
  { path:P+'orgMembers/acme_newguy', op:'create', auth:alice,
    request_resource:{ orgId:'acme', userId:'newguy', role:'staff', status:'removed' } });
T('membership cannot carry an unknown role', false,
  { path:P+'orgMembers/acme_newguy', op:'create', auth:alice,
    request_resource:{ orgId:'acme', userId:'newguy', role:'superadmin', status:'active' } });

// ---- legacy invitation flow --------------------------------------------
T('legacy invitation accept, verified email', true,
  { path:P+'orgMembers/acme_newbie', op:'create', auth:newbie,
    request_resource:{ orgId:'acme', userId:'newbie', role:'staff', status:'active', invitationId:'inv1' } });
T('legacy invitation accept, unverified email', false,
  { path:P+'orgMembers/acme_newbie', op:'create', auth:newbieUnverified,
    request_resource:{ orgId:'acme', userId:'newbie', role:'staff', status:'active', invitationId:'inv1' } });
T("someone else's invitation", false,
  { path:P+'orgMembers/acme_mallory', op:'create', auth:mallory,
    request_resource:{ orgId:'acme', userId:'mallory', role:'staff', status:'active', invitationId:'inv1' } });
T('invitation cannot be redeemed at a higher role', false,
  { path:P+'orgMembers/acme_newbie', op:'create', auth:newbie,
    request_resource:{ orgId:'acme', userId:'newbie', role:'admin', status:'active', invitationId:'inv1' } });

// ---- membership reads / deletes ----------------------------------------
T('member reads own membership row', true, { path:P+'orgMembers/acme_carol', op:'get', auth:carol, resource:D('orgMembers/acme_carol') });
T('member cannot read a row in another org', false, { path:P+'orgMembers/victim_bob', op:'get', auth:carol, resource:D('orgMembers/victim_bob') });
T('admin reads any row in their org', true, { path:P+'orgMembers/acme_carol', op:'get', auth:alice, resource:D('orgMembers/acme_carol') });
T('member may remove their own membership', true, { path:P+'orgMembers/acme_carol', op:'delete', auth:carol, resource:D('orgMembers/acme_carol') });
T('staff cannot remove a colleague', false, { path:P+'orgMembers/acme_dave', op:'delete', auth:carol, resource:D('orgMembers/acme_dave') });
T('admin off-boards a member', true, { path:P+'orgMembers/acme_carol', op:'update', auth:alice, resource:D('orgMembers/acme_carol'), request_resource:{ orgId:'acme', userId:'carol', role:'staff', status:'removed' } });
T('admin cannot repoint a row at another user', false, { path:P+'orgMembers/acme_carol', op:'update', auth:alice, resource:D('orgMembers/acme_carol'), request_resource:{ orgId:'acme', userId:'mallory', role:'staff', status:'active' } });

// ---- invite codes -------------------------------------------------------
T('any signed-in user may fetch a code by id', true, { path:P+'inviteCodes/GOOD-CODE', op:'get', auth:mallory, resource:D('inviteCodes/GOOD-CODE') });
T('listing every invite code on the platform', false, { path:P+'inviteCodes/GOOD-CODE', op:'list', auth:mallory, resource:D('inviteCodes/GOOD-CODE') });
T('admin lists their own org codes', true, { path:P+'inviteCodes/GOOD-CODE', op:'list', auth:alice, resource:D('inviteCodes/GOOD-CODE') });
T('redeeming a code bumps uses by one', true,
  { path:P+'inviteCodes/GOOD-CODE', op:'update', auth:newbie, resource:D('inviteCodes/GOOD-CODE'),
    request_resource:{ code:'GOOD-CODE', orgId:'acme', role:'staff', status:'active', uses:1, maxUses:5, updatedAt:2 } });
T('redemption cannot rewrite the granted role', false,
  { path:P+'inviteCodes/GOOD-CODE', op:'update', auth:newbie, resource:D('inviteCodes/GOOD-CODE'),
    request_resource:{ code:'GOOD-CODE', orgId:'acme', role:'admin', status:'active', uses:1, maxUses:5, updatedAt:2 } });
T('redemption cannot rewind the counter', false,
  { path:P+'inviteCodes/GOOD-CODE', op:'update', auth:newbie, resource:D('inviteCodes/GOOD-CODE'),
    request_resource:{ code:'GOOD-CODE', orgId:'acme', role:'staff', status:'active', uses:0, maxUses:5, updatedAt:2 } });
T('redemption cannot raise maxUses', false,
  { path:P+'inviteCodes/GOOD-CODE', op:'update', auth:newbie, resource:D('inviteCodes/GOOD-CODE'),
    request_resource:{ code:'GOOD-CODE', orgId:'acme', role:'staff', status:'active', uses:1, maxUses:500, updatedAt:2 } });
T('a revoked code cannot be redeemed', false,
  { path:P+'inviteCodes/DEAD-CODE', op:'update', auth:newbie, resource:D('inviteCodes/DEAD-CODE'),
    request_resource:{ code:'DEAD-CODE', orgId:'acme', role:'admin', status:'revoked', uses:2, maxUses:1, updatedAt:2 } });
T('admin revokes a code', true,
  { path:P+'inviteCodes/GOOD-CODE', op:'update', auth:alice, resource:D('inviteCodes/GOOD-CODE'),
    request_resource:{ code:'GOOD-CODE', orgId:'acme', role:'staff', status:'revoked', uses:0, maxUses:5, updatedAt:2 } });
T('outsider cannot create a code for an org', false,
  { path:P+'inviteCodes/NEW-CODE', op:'create', auth:carol, request_resource:{ orgId:'acme', role:'staff', status:'active', uses:0 } });

// ---- organizations / billing --------------------------------------------
const acmeOrg = D('organizations/acme');
const orgWith = (o) => Object.assign({}, acmeOrg, o, { updatedAt:2 });
T('admin edits org settings', true, { path:P+'organizations/acme', op:'update', auth:alice, resource:acmeOrg, request_resource:orgWith({ name:'Acme Inc' }) });
T('admin cannot grant themselves a plan', false, { path:P+'organizations/acme', op:'update', auth:alice, resource:acmeOrg, request_resource:orgWith({ plan:'enterprise' }) });
T('admin cannot rewrite the Stripe customer id', false, { path:P+'organizations/acme', op:'update', auth:alice, resource:acmeOrg, request_resource:orgWith({ stripeCustomerId:'cus_hijack' }) });
T('admin cannot reassign org ownership', false, { path:P+'organizations/acme', op:'update', auth:alice, resource:acmeOrg, request_resource:orgWith({ createdBy:'mallory' }) });
T('staff cannot edit org settings', false, { path:P+'organizations/acme', op:'update', auth:carol, resource:acmeOrg, request_resource:orgWith({ name:'Acme Inc' }) });
T('signup creates an org on a trial', true, { path:P+'organizations/newco', op:'create', auth:zoe, request_resource:{ id:'newco', createdBy:'zoe', plan:'trial', status:'active' } });
T('signup cannot start on a paid plan', false, { path:P+'organizations/newco', op:'create', auth:zoe, request_resource:{ id:'newco', createdBy:'zoe', plan:'enterprise', status:'active' } });
T('cannot create an org owned by someone else', false, { path:P+'organizations/newco', op:'create', auth:mallory, request_resource:{ id:'newco', createdBy:'alice', plan:'trial', status:'active' } });
T('nobody deletes an org from the client', false, { path:P+'organizations/acme', op:'delete', auth:alice, resource:acmeOrg });
T('outsider cannot read an org', false, { path:P+'organizations/acme', op:'get', auth:mallory, resource:acmeOrg });
T('member reads their own org', true, { path:P+'organizations/acme', op:'get', auth:carol, resource:acmeOrg });

// ---- SkidSling operator access -------------------------------------------
T('owner-org admin can read any tenant org', true, { path:P+'organizations/acme', op:'get', auth:owner, resource:acmeOrg });
T('owner-org staff cannot', false, { path:P+'organizations/acme', op:'get', auth:ops, resource:acmeOrg });

// ---- api keys -------------------------------------------------------------
const key1 = D('apiKeys/key1');
T('admin reads api keys', true,  { path:P+'apiKeys/key1', op:'get', auth:alice, resource:key1 });
T('staff cannot read api keys', false, { path:P+'apiKeys/key1', op:'get', auth:carol, resource:key1 });
T('admin mints a read key', true, { path:P+'apiKeys/key2', op:'create', auth:alice, request_resource:{ orgId:'acme', scope:'read', revoked:false } });
T('a key cannot be minted with an invented scope', false, { path:P+'apiKeys/key2', op:'create', auth:alice, request_resource:{ orgId:'acme', scope:'admin', revoked:false } });
T('a key cannot be silently upgraded to write', false, { path:P+'apiKeys/key1', op:'update', auth:alice, resource:key1, request_resource:Object.assign({}, key1, { scope:'write', updatedAt:2 }) });
T('admin revokes a key', true, { path:P+'apiKeys/key1', op:'update', auth:alice, resource:key1, request_resource:Object.assign({}, key1, { revoked:true, revokedAt:2, updatedAt:2 }) });
T('a revoked key cannot be un-revoked', false, { path:P+'apiKeys/key1', op:'update', auth:alice, resource:Object.assign({}, key1, { revoked:true }), request_resource:Object.assign({}, key1, { revoked:false, updatedAt:2 }) });
T('api keys cannot be deleted', false, { path:P+'apiKeys/key1', op:'delete', auth:alice, resource:key1 });

// ---- expenses are manager+ -------------------------------------------------
T('staff cannot read expenses', false, { path:P+'expenses/exp1', op:'get', auth:carol, resource:D('expenses/exp1') });
T('manager reads expenses',      true, { path:P+'expenses/exp1', op:'get', auth:dave,  resource:D('expenses/exp1') });

// ---- append-only audit trails ----------------------------------------------
T('staff appends a movement', true, { path:P+'movements/mv2', op:'create', auth:carol, request_resource:{ orgId:'acme', delta:-1 } });
T('movements cannot be edited', false, { path:P+'movements/mv1', op:'update', auth:alice, resource:D('movements/mv1'), request_resource:{ orgId:'acme', delta:0 } });
T('movements cannot be deleted', false, { path:P+'movements/mv1', op:'delete', auth:alice, resource:D('movements/mv1') });
T('activity log cannot be rewritten', false, { path:P+'activityLog/log1', op:'update', auth:alice, resource:D('activityLog/log1'), request_resource:{ orgId:'acme', action:'y' } });
T('staff cannot read the activity log', false, { path:P+'activityLog/log1', op:'get', auth:carol, resource:D('activityLog/log1') });
T('manager reads the activity log', true, { path:P+'activityLog/log1', op:'get', auth:dave, resource:D('activityLog/log1') });

// ---- catch-all --------------------------------------------------------------
T('unknown collection is closed', false, { path:P+'secrets/s1', op:'get', auth:alice, resource:{ orgId:'acme' } });
T('unknown collection is closed to writes', false, { path:P+'secrets/s1', op:'create', auth:alice, request_resource:{ orgId:'acme' } });

// ---------------------------------------------------------------------------
function run(rulesFile, label, expectations) {
  const roots = loadRules(rulesFile);
  let pass = 0, fail = 0, maxCalls = 0, worst = '';
  const failures = [];
  for (const [name, expect, req] of CASES) {
    const want = expectations && Object.prototype.hasOwnProperty.call(expectations, name) ? expectations[name] : expect;
    if (want === null) continue;
    let r;
    try { r = evaluate(roots, Object.assign({ db: DB }, req)); }
    catch (e) { fail++; failures.push({ name, expect: want, got: 'THREW: ' + e.message, trace: [] }); continue; }
    if (r.accessCalls > maxCalls) { maxCalls = r.accessCalls; worst = name; }
    if (r.allowed === want) pass++;
    else { fail++; failures.push({ name, expect: want, got: r.allowed, trace: r.trace }); }
  }
  console.log('\n=== ' + label + ' ===');
  for (const f of failures) {
    console.log('FAIL  ' + f.name + '  -- expected ' + (f.expect ? 'ALLOW' : 'DENY') + ', got ' + (f.got === true ? 'ALLOW' : f.got === false ? 'DENY' : f.got));
    f.trace.forEach((t) => console.log('         ' + (t.result ? 'allow' : 'deny ') + '  ' + t.rule + (t.error ? '   [' + t.error + ']' : '')));
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  console.log('worst-case document access calls: ' + maxCalls + ' (limit 10) on: ' + worst);
  return fail;
}

const target = process.argv[2] || require('path').join(__dirname, '..', '..', 'firestore.rules');
const fails = run(target, 'RULES: ' + target);
process.exit(fails ? 1 : 0);
