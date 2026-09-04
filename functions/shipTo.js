'use strict';
// Ship-to details that have to be repaired at send time.
//
// An order stores a snapshot of the customer taken when it was written, and the
// order-creation API accepts a customerId without ever loading the record - so
// an order can carry a blank phone while the customer record has one. UPS
// rejects an international label with no ship-to phone (error 120209), which is
// invisible on domestic shipments and fatal on international ones.
//
// Extracted from index.js so the tenant check below is unit-testable: this is a
// read of a document the caller named, so it must never return data belonging
// to another organization.
module.exports = function createShipTo(deps) {
  var db = deps.db;

  async function shipToPhoneFallback(order) {
    if (!order || !order.customerId) return '';
    var customerId = String(order.customerId);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(customerId)) return '';
    try {
      var snap = await db.collection('customers').doc(customerId).get();
      if (!snap.exists) return '';
      var c = snap.data() || {};
      if (c.orgId !== order.orgId) return '';
      return String(c.phone || '').trim();
    } catch (e) {
      console.error('Could not read the customer record for a phone fallback:', e && e.message);
      return '';
    }
  }

  return { shipToPhoneFallback: shipToPhoneFallback };
};
