/**
 * SkidSling - item stock history (the `movements` ledger). Pure, no Firestore.
 *
 * Used by the MCP get_item_history tool and by the API/MCP adjust routes when
 * they write their ADJUST movement. Kept free of I/O so it can be unit tested.
 *
 * Movement types in the ledger:
 *   RECEIVE  stock added to a shelf (receiving, voice/quick add, cancel restore)
 *   PICK     stock taken off a shelf (pick lists, order deduction)
 *   MOVE     shelf to shelf, total unchanged
 *   ADD      Items tab quick "add" (legacy, stock field only)
 *   ADJUST   Items tab quick "remove" (legacy: no before/after, always a removal),
 *            and from 2026-09-28 every direct edit / API / MCP adjustment, which
 *            carry beforeQty/afterQty
 *   RESTORE  stock put back when an order is deleted
 *   IMPORT   CSV import changed an existing item's quantity or shelves
 *   CREATE   item created with opening stock
 */

// Direction of a movement that has no before/after recorded.
var SIGN = { RECEIVE: 1, ADD: 1, RESTORE: 1, CREATE: 1, PICK: -1, MOVE: 0 };

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function millis(t) {
  if (t && typeof t.toMillis === 'function') return t.toMillis();
  var n = num(t);
  return n === null ? 0 : n;
}

// Signed change to the item total. null when the direction cannot be known.
function movementDelta(m) {
  var b = num(m.beforeQty), a = num(m.afterQty);
  if (b !== null && a !== null) return a - b;
  var t = String(m.type || '').toUpperCase();
  var q = parseInt(m.quantity) || 0;
  if (Object.prototype.hasOwnProperty.call(SIGN, t)) return SIGN[t] * q;
  if (t === 'ADJUST') return -q; // legacy quick-remove from the Items tab
  return null;
}

// Stock before/after from an ITEM_UPDATED activity-log entry, or null when the
// entry did not touch the quantity.
function auditStockChange(entry) {
  var d = (entry && entry.details) || {};
  var upd = d.updates || {};
  if (upd.stock === undefined) return null;
  var after = parseInt(upd.stock);
  var before = d.before && d.before.stock !== undefined ? parseInt(d.before.stock) : null;
  if (isNaN(after)) return null;
  if (before !== null && isNaN(before)) before = null;
  var ts = millis(entry.timestamp);
  return {
    time: ts ? new Date(ts).toISOString() : null,
    timestamp: ts,
    user: entry.userEmail || '',
    source: d.source || 'app',
    beforeQty: before,
    afterQty: after,
    delta: before === null ? null : after - before,
    shelf: d.shelf || null,
    shelfBefore: d.shelfBefore !== undefined ? d.shelfBefore : null,
    shelfAfter: d.shelfAfter !== undefined ? d.shelfAfter : null,
    reason: d.reason || ''
  };
}

// Audit-log stock edits that no movement accounts for. From this change on,
// every such edit also writes a movement with beforeQty/afterQty at the same
// moment; older ones (API/MCP adjustments, item edits) exist only in the log.
function unmatchedAuditEdits(auditChanges, movements, windowMs) {
  var w = windowMs || 10000;
  var used = {};
  return (auditChanges || []).filter(function (a) {
    // No before recorded (older in-app edits): still listed, delta unknown.
    if (!a || (a.beforeQty !== null && a.beforeQty === a.afterQty)) return false;
    for (var i = 0; i < (movements || []).length; i++) {
      if (used[i]) continue;
      var m = movements[i];
      // Same resulting quantity at the same moment. beforeQty is not compared:
      // movements record the shelf total, the audit log the stored stock field.
      if (num(m.afterQty) === a.afterQty && Math.abs(millis(m.timestamp) - a.timestamp) <= w) {
        used[i] = true;
        return false;
      }
    }
    return true;
  });
}

// Totals per type and the net change the ledger implies, compared with the
// item's current quantity. The comparison is only meaningful when the ledger
// covers the item's whole life (no date filter, not truncated by the limit).
function summarizeHistory(movements, currentQty, opts) {
  opts = opts || {};
  var byType = {};
  var net = 0, unknown = 0;
  (movements || []).forEach(function (m) {
    var t = String(m.type || 'UNKNOWN').toUpperCase();
    var q = parseInt(m.quantity) || 0;
    var s = byType[t] || (byType[t] = { count: 0, units: 0, netChange: 0 });
    s.count++;
    s.units += q;
    var d = movementDelta(m);
    if (d === null) { unknown++; return; }
    s.netChange += d;
    net += d;
  });
  var audit = opts.auditOnlyEdits || [];
  var auditNet = audit.reduce(function (sum, a) { return sum + (a.delta || 0); }, 0);
  var full = !!opts.coversFullHistory;
  var cur = parseInt(currentQty) || 0;
  var explained = net + auditNet;
  return {
    movementCount: (movements || []).length,
    byType: byType,
    netChangeFromMovements: net,
    netChangeFromAuditLogOnly: auditNet,
    movementsWithUnknownDirection: unknown,
    currentQuantity: cur,
    coversFullHistory: full,
    unexplainedDifference: full ? cur - explained : null,
    note: full
      ? (cur === explained
          ? 'Movements (plus audit-log-only edits) add up to the current quantity.'
          : 'MISMATCH: current quantity minus everything recorded is ' + (cur - explained) +
            '. Some change was never logged (e.g. an item created with stock before CREATE movements existed, a legacy stock-only write, or a bulk import). Report it; do not fix it.')
      : 'Filtered by date or truncated by the limit, so the ledger cannot be compared with the current quantity. Call again without since/until and with a higher limit to check.'
  };
}

// Shape one movement document for output.
function formatMovement(id, m, orderNumbers) {
  var ts = millis(m.timestamp);
  var out = {
    id: id,
    time: ts ? new Date(ts).toISOString() : null,
    timestamp: ts,
    type: m.type || '',
    quantity: parseInt(m.quantity) || 0,
    fromLocation: m.fromLocation || '',
    toLocation: m.toLocation || '',
    user: m.userEmail || ''
  };
  if (m.orderId) {
    out.orderId = m.orderId;
    out.orderNumber = m.orderNumber || (orderNumbers && orderNumbers[m.orderId]) || '';
  }
  var reason = m.reason || '';
  var notes = m.notes || m.note || '';
  if (reason) out.reason = reason;
  if (notes && notes !== reason) out.notes = notes;
  if (num(m.beforeQty) !== null) out.beforeQty = num(m.beforeQty);
  if (num(m.afterQty) !== null) out.afterQty = num(m.afterQty);
  if (m.source) out.source = m.source;
  return out;
}

// The movement an API/MCP adjustment writes, alongside its audit-log entry.
// beforeQty is the shelf total, not the stored `stock` field: the adjustment
// re-derives stock from the shelves, so on an item whose stock field had
// drifted, stock-before vs shelves-after would record a change nobody made.
function adjustMovement(item, itemId, orgId, plan, beforeShelves, reason, source, user, now) {
  var down = plan.shelfAfter < plan.shelfBefore;
  var beforeStock = (beforeShelves || []).reduce(function (s, e) { return s + (parseInt(e.qty) || 0); }, 0);
  return {
    orgId: orgId,
    itemId: itemId,
    itemName: item.name || '',
    sku: item.partNumber || '',
    grade: item.grade || '',
    type: 'ADJUST',
    quantity: Math.abs(plan.derived.stock - beforeStock),
    beforeQty: beforeStock,
    afterQty: plan.derived.stock,
    fromLocation: down ? plan.shelf : '',
    toLocation: down ? '' : plan.shelf,
    shelfBefore: plan.shelfBefore,
    shelfAfter: plan.shelfAfter,
    reason: reason || '',
    source: source,
    userId: null,
    userEmail: user,
    timestamp: now
  };
}

module.exports = {
  movementDelta: movementDelta,
  auditStockChange: auditStockChange,
  unmatchedAuditEdits: unmatchedAuditEdits,
  summarizeHistory: summarizeHistory,
  formatMovement: formatMovement,
  adjustMovement: adjustMovement
};
