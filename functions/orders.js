/**
 * SkidSling - draft order creation, shared by the REST API and the MCP tool.
 *
 * Hard rule: this module creates orders with status 'draft' and nothing else.
 * There is deliberately no parameter for status. Confirm & Pick stays a human
 * step in the app, so an inbound email can never move stock on its own.
 */

function bad(message, statusCode) {
  var e = new Error(message);
  e.statusCode = statusCode || 400;
  return e;
}

async function buildLines(db, auth, rawLines) {
  var warnings = [];
  var lines = [];
  for (var i = 0; i < rawLines.length; i++) {
    var L = rawLines[i];
    var qty = parseInt(L.quantity);
    if (!isFinite(qty) || qty <= 0) throw bad('Line ' + (i + 1) + ': quantity must be a positive whole number');
    var lineId = 'line_' + Date.now() + '_' + (i + 1) + Math.random().toString(36).substr(2, 6);

    if (L.itemId) {
      var idoc = await db.collection('items').doc(String(L.itemId)).get();
      if (!idoc.exists) throw bad('Line ' + (i + 1) + ': item not found (' + L.itemId + ')');
      var d = idoc.data();
      if (d.orgId !== auth.orgId) throw bad('Line ' + (i + 1) + ': item not found (' + L.itemId + ')');

      var catalogPrice = parseFloat(d.price) || 0;
      var onHand = parseInt(d.stock) || 0;
      var label = (d.partNumber || '') + ' ' + (d.name || '');

      // Catalogue price wins. A price quoted in the email is recorded on the
      // line for the paper trail but never becomes the invoice price.
      var quoted = (L.quotedPrice !== undefined && L.quotedPrice !== null && L.quotedPrice !== '')
        ? parseFloat(L.quotedPrice) : null;
      if (quoted !== null && isFinite(quoted) && Math.abs(quoted - catalogPrice) > 0.005) {
        warnings.push({ type: 'price_mismatch', line: i + 1, item: label,
          catalogPrice: catalogPrice, quotedPrice: quoted,
          note: 'Order uses the catalogue price; the quoted price is recorded on the line only.' });
      }
      if (onHand < qty) {
        warnings.push({ type: 'insufficient_stock', line: i + 1, item: label,
          ordered: qty, onHand: onHand,
          note: 'Line kept so the order shows what was actually asked for.' });
      }

      lines.push({
        lineId: lineId,
        itemId: idoc.id, itemName: d.name || '', partNumber: d.partNumber || '',
        location: d.location || '', grade: d.grade || '',
        quantity: qty, qtyShipped: '', unitPrice: catalogPrice,
        estTotal: qty * catalogPrice, lineTotal: 0,
        source: 'inventory', contractId: '', contractNumber: '', costPerLb: 0,
        weightPerItem: d.weight || '', itemCost: d.cost || 0,
        quotedPrice: (quoted !== null && isFinite(quoted)) ? quoted : null,
        notes: L.notes || ''
      });

    } else {
      var text = String(L.description || L.itemName || '').trim();
      if (!text) throw bad('Line ' + (i + 1) + ': needs either an itemId or a description');
      var mprice = parseFloat(L.unitPrice) || 0;
      lines.push({
        lineId: lineId,
        itemId: '', itemName: text.slice(0, 200), partNumber: '', location: '', grade: '',
        quantity: qty, qtyShipped: qty, unitPrice: mprice,
        estTotal: qty * mprice, lineTotal: qty * mprice,
        source: 'manual', contractId: '', contractNumber: '', costPerLb: 0,
        weightPerItem: '', itemCost: 0, notes: L.notes || ''
      });
      warnings.push({ type: 'unmatched_line', line: i + 1, text: text,
        note: 'Added as a free-text line with no inventory item behind it.' });
    }
  }
  return { lines: lines, warnings: warnings };
}

async function createDraftOrder(db, auth, body) {
  if (auth.scope !== 'write') throw bad('This API key is read-only.', 403);
  if (!body.customerName || !String(body.customerName).trim()) throw bad('customerName is required');
  if (!Array.isArray(body.lines) || body.lines.length === 0) throw bad('lines must be a non-empty array');
  if (body.lines.length > 200) throw bad('Too many lines (max 200)');

  // Duplicate guard: the same email must not quietly become two orders.
  if (body.sourceRef) {
    var dupe = await db.collection('purchaseOrders')
      .where('orgId', '==', auth.orgId)
      .where('sourceRef', '==', String(body.sourceRef))
      .limit(1).get();
    if (!dupe.empty) {
      var d0 = dupe.docs[0];
      throw bad('An order was already created from this source (' +
        (d0.data().poNumber || d0.id) + '). Use a different sourceRef, or omit it to create anyway.', 409);
    }
  }

  var built = await buildLines(db, auth, body.lines);
  var warnings = built.warnings;
  var lines = built.lines;
  var estSubtotal = lines.reduce(function (t, l) { return t + (parseFloat(l.estTotal) || 0); }, 0);
  var shipSubtotal = lines.reduce(function (t, l) { return t + (parseFloat(l.lineTotal) || 0); }, 0);
  var tax = parseFloat(body.tax) || 0, shipping = parseFloat(body.shipping) || 0;
  var credit = parseFloat(body.credit) || 0, discount = parseFloat(body.discount) || 0;

  // Continue the existing AA#### sequence.
  var posnap = await db.collection('purchaseOrders').where('orgId', '==', auth.orgId).get();
  var maxNum = 6399;
  posnap.docs.forEach(function (doc) {
    var m = String(doc.data().poNumber || '').match(/^AA(\d+)$/);
    if (m && parseInt(m[1]) > maxNum) maxNum = parseInt(m[1]);
  });
  var poNumber = 'AA' + (maxNum + 1);

  var orderDoc = {
    poNumber: poNumber,
    status: 'draft',
    orgId: auth.orgId,
    customerId: body.customerId || '',
    customerName: String(body.customerName).trim(),
    customerContact: body.customerContact || '',
    customerEmail: body.customerEmail || '',
    customerPhone: body.customerPhone || '',
    customerAddress: body.customerAddress || '',
    shipToAddress: body.shipToAddress || '',
    shipToCompany: body.shipToCompany || '',
    useShipTo: !!body.shipToAddress,
    customerPO: body.customerPO || '',
    dueDate: body.dueDate || '',
    invoiceDate: body.invoiceDate || '',
    terms: body.terms || 'Net 30',
    notes: body.notes || '',
    items: lines,
    estSubtotal: estSubtotal, subtotal: shipSubtotal,
    tax: tax, shipping: shipping, credit: credit, discount: discount,
    estTotal: estSubtotal + tax + shipping - credit - discount,
    total: shipSubtotal + tax + shipping - credit - discount,
    sourceRef: body.sourceRef ? String(body.sourceRef) : '',
    createdBy: 'API: ' + (auth.label || auth.keyId),
    createdAt: Date.now(), updatedAt: Date.now()
  };

  var ref = await db.collection('purchaseOrders').add(orderDoc);
  await db.collection('activityLog').add({
    orgId: auth.orgId, action: 'PO_CREATED',
    details: { poId: ref.id, poNumber: poNumber, customerName: orderDoc.customerName,
      lineCount: lines.length, estTotal: orderDoc.estTotal,
      source: body.source || 'api', apiKey: auth.label, sourceRef: orderDoc.sourceRef },
    userEmail: 'API: ' + (auth.label || auth.keyId),
    timestamp: Date.now(), createdAt: new Date().toISOString()
  });

  return {
    id: ref.id, poNumber: poNumber, status: 'draft',
    customerName: orderDoc.customerName, lineCount: lines.length,
    estSubtotal: estSubtotal, estTotal: orderDoc.estTotal,
    warnings: warnings,
    items: lines.map(function (l) {
      return { sku: l.partNumber, name: l.itemName, grade: l.grade, quantity: l.quantity,
        unitPrice: l.unitPrice, estTotal: l.estTotal, source: l.source,
        quotedPrice: l.quotedPrice || undefined };
    }),
    note: 'Created as a draft. Nothing is reserved or picked until someone presses Confirm & Pick in SkidSling.'
  };
}



/**
 * Revise a DRAFT order. Only drafts are touchable - once an order has been
 * confirmed, picked, packed or shipped it is a record of what happened, and an
 * agent editing it after the fact would destroy the trail. Status is never
 * settable here either: moving an order forward stays a human action in the app.
 */
var EDITABLE = ['customerName', 'customerContact', 'customerEmail', 'customerPhone',
  'customerAddress', 'shipToAddress', 'shipToCompany', 'customerPO', 'terms',
  'notes', 'dueDate', 'invoiceDate'];
var NUMERIC = ['tax', 'shipping', 'credit', 'discount'];

async function updateDraftOrder(db, auth, orderId, body) {
  if (auth.scope !== 'write') throw bad('This API key is read-only.', 403);
  if (!orderId) throw bad('orderId is required');

  var ref = db.collection('purchaseOrders').doc(String(orderId));
  var snap = await ref.get();
  if (!snap.exists) throw bad('Order not found', 404);
  var cur = snap.data();
  if (cur.orgId !== auth.orgId) throw bad('Order not found', 404);
  if ((cur.status || 'draft') !== 'draft') {
    throw bad('Order ' + (cur.poNumber || orderId) + ' is ' + cur.status +
      ', not a draft. Orders past draft are a record of what happened and are edited in SkidSling, not through the API.', 409);
  }

  var updates = { updatedAt: Date.now() };
  var changed = [];
  EDITABLE.forEach(function (k) {
    if (body[k] !== undefined) {
      updates[k] = body[k] === null ? '' : String(body[k]);
      changed.push(k);
    }
  });
  NUMERIC.forEach(function (k) {
    if (body[k] !== undefined) { updates[k] = parseFloat(body[k]) || 0; changed.push(k); }
  });
  if (body.shipToAddress !== undefined) updates.useShipTo = !!body.shipToAddress;

  var warnings = [];
  var lines = cur.items || [];
  if (body.lines !== undefined) {
    if (!Array.isArray(body.lines) || body.lines.length === 0) throw bad('lines must be a non-empty array');
    if (body.lines.length > 200) throw bad('Too many lines (max 200)');
    var rebuilt = await buildLines(db, auth, body.lines);
    lines = rebuilt.lines;
    warnings = rebuilt.warnings;
    updates.items = lines;
    changed.push('lines');
  }

  var estSubtotal = lines.reduce(function (t, l) { return t + (parseFloat(l.estTotal) || 0); }, 0);
  var shipSubtotal = lines.reduce(function (t, l) { return t + (parseFloat(l.lineTotal) || 0); }, 0);
  var tax = updates.tax !== undefined ? updates.tax : (parseFloat(cur.tax) || 0);
  var shipping = updates.shipping !== undefined ? updates.shipping : (parseFloat(cur.shipping) || 0);
  var credit = updates.credit !== undefined ? updates.credit : (parseFloat(cur.credit) || 0);
  var discount = updates.discount !== undefined ? updates.discount : (parseFloat(cur.discount) || 0);
  updates.estSubtotal = estSubtotal;
  updates.subtotal = shipSubtotal;
  updates.estTotal = estSubtotal + tax + shipping - credit - discount;
  updates.total = shipSubtotal + tax + shipping - credit - discount;

  if (changed.length === 0) throw bad('Nothing to update. Provide at least one of: ' + EDITABLE.concat(NUMERIC).join(', ') + ', lines.');

  await ref.update(updates);
  await db.collection('activityLog').add({
    orgId: auth.orgId, action: 'PO_UPDATED',
    details: { poId: ref.id, poNumber: cur.poNumber || '', fields: changed,
      lineCount: lines.length, estTotal: updates.estTotal,
      source: body.source || 'api', apiKey: auth.label },
    userEmail: 'API: ' + (auth.label || auth.keyId),
    timestamp: Date.now(), createdAt: new Date().toISOString()
  });

  return {
    id: ref.id, poNumber: cur.poNumber || '', status: 'draft',
    updated: changed, lineCount: lines.length,
    estSubtotal: estSubtotal, estTotal: updates.estTotal,
    warnings: warnings,
    note: 'Still a draft. Nothing is reserved or picked until someone presses Confirm & Pick in SkidSling.'
  };
}

module.exports = { createDraftOrder: createDraftOrder, updateDraftOrder: updateDraftOrder };
