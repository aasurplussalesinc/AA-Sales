/**
 * SkidSling - tenant isolation for callable Cloud Functions.
 *
 * Callables run with the Admin SDK, which bypasses Firestore rules completely.
 * Checking context.auth only proves SOMEONE is signed in; it says nothing about
 * WHICH tenant they belong to. Every callable that accepts an orgId must prove
 * membership itself, or any signed-in user of any tenant can pass another
 * tenant's orgId and act on their data, their carrier accounts and their
 * Stripe subscription.
 *
 * Kept in its own module so it can be unit tested, and so there is exactly one
 * definition of what "may this caller act on this org" means.
 */

var ROLE_RANK = { staff: 1, manager: 2, admin: 3 };

module.exports = function createAuthz(deps) {
  var functions = deps.functions;
  var db = deps.db;

  function assertOrgId(orgId) {
    if (typeof orgId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(orgId)) {
      throw new functions.https.HttpsError('invalid-argument', 'orgId must be a plain document id');
    }
    return orgId;
  }

  /**
   * Throws unless the caller is an ACTIVE member of orgId with at least minRole.
   * Returns the membership data so callers can branch on role if they need to.
   */
  async function assertOrgMember(context, orgId, minRole) {
    if (!context || !context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    assertOrgId(orgId);
    var snap = await db.collection('orgMembers').doc(orgId + '_' + context.auth.uid).get();
    if (!snap.exists) {
      throw new functions.https.HttpsError('permission-denied', 'Not a member of this organization');
    }
    var m = snap.data() || {};
    // Off-boarding sets status to 'removed' rather than deleting the row, so an
    // existence check alone would keep a former employee fully authorised.
    if (m.status && m.status !== 'active') {
      throw new functions.https.HttpsError('permission-denied',
        'Your membership of this organization is ' + m.status);
    }
    var need = ROLE_RANK[minRole || 'staff'] || 1;
    var have = ROLE_RANK[m.role] || 0;
    if (have < need) {
      throw new functions.https.HttpsError('permission-denied',
        'This action requires ' + (minRole || 'staff') + ' access');
    }
    return m;
  }

  /**
   * Confirms a purchase order actually belongs to the org the caller proved
   * membership of - stops a known document id reaching across tenants.
   */
  async function assertOrderInOrg(orderId, orgId) {
    if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(orderId)) {
      throw new functions.https.HttpsError('invalid-argument', 'orderId must be a plain document id');
    }
    var snap = await db.collection('purchaseOrders').doc(orderId).get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Order not found');
    var o = snap.data();
    if (o.orgId !== orgId) throw new functions.https.HttpsError('not-found', 'Order not found');
    return Object.assign({ id: snap.id }, o);
  }

  return {
    ROLE_RANK: ROLE_RANK,
    assertOrgId: assertOrgId,
    assertOrgMember: assertOrgMember,
    assertOrderInOrg: assertOrderInOrg
  };
};
