/**
 * AA Surplus Sales - Shippo Shipping Integration v4
 * Firebase Cloud Functions
 * 
 * Features:
 * - Per-organization Shippo API keys
 * - International shipping with customs declarations
 * - Batch label generation
 * - Scheduled daily check for packed orders
 * - Configurable check time via Firestore settings
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

const SHIPPO_BASE_URL = 'https://api.goshippo.com';

async function shippoRequest(apiKey, endpoint, method = 'GET', body = null) {
  if (!apiKey) throw new Error('Shippo API key not configured. Go to Shipping Settings and enter your Shippo API key.');
  const options = {
    method,
    headers: { 'Authorization': 'ShippoToken ' + apiKey, 'Content-Type': 'application/json' },
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(SHIPPO_BASE_URL + endpoint, options);
  const data = await response.json();
  if (!response.ok) {
    console.error('Shippo API error:', JSON.stringify(data));
    throw new Error('Shippo API error: ' + (data.detail || data.message || JSON.stringify(data)));
  }
  return data;
}

async function createCustomsDeclaration(apiKey, order, orgSettings) {
  const customsItems = (order.items || []).map(function(item) {
    return {
      description: item.itemName || item.name || 'Military surplus goods',
      quantity: item.qtyShipped || item.quantity || 1,
      net_weight: String(Math.max(1, Math.round(parseFloat(item.weight) || 2))),
      mass_unit: 'lb',
      value_amount: String(parseFloat(item.unitPrice) || 10),
      value_currency: 'USD',
      origin_country: 'US',
      tariff_number: item.tariffNumber || (order.customsInfo && order.customsInfo.defaultTariffNumber) || '',
    };
  });
  if (customsItems.length === 0) {
    customsItems.push({
      description: (order.customsInfo && order.customsInfo.description) || 'Military surplus goods',
      quantity: 1, net_weight: '5', mass_unit: 'lb',
      value_amount: String(order.subtotal || order.total || 50),
      value_currency: 'USD', origin_country: 'US',
    });
  }
  var declaration = {
    contents_type: (order.customsInfo && order.customsInfo.contentsType) || 'MERCHANDISE',
    contents_explanation: (order.customsInfo && order.customsInfo.description) || 'Military surplus tactical gear and equipment',
    non_delivery_option: (order.customsInfo && order.customsInfo.nonDeliveryOption) || 'RETURN',
    certify: true,
    certify_signer: (orgSettings.shippingFromAddress && orgSettings.shippingFromAddress.name) || 'AA Surplus Sales',
    items: customsItems,
    incoterm: (order.customsInfo && order.customsInfo.incoterm) || 'DDU',
  };
  if (order.customsInfo && order.customsInfo.eelPfc) {
    declaration.eel_pfc = order.customsInfo.eelPfc;
  }
  return shippoRequest(apiKey, '/customs/declarations/', 'POST', declaration);
}

async function createShipment(apiKey, fromAddress, toAddress, parcels, customsDeclarationId) {
  var shipmentData = {
    address_from: fromAddress, address_to: toAddress, parcels: parcels, async: false,
  };
  if (customsDeclarationId) shipmentData.customs_declaration = customsDeclarationId;
  return shippoRequest(apiKey, '/shipments/', 'POST', shipmentData);
}

async function purchaseLabel(apiKey, rateId) {
  return shippoRequest(apiKey, '/transactions/', 'POST', { rate: rateId, label_file_type: 'PDF', async: false });
}

async function validateAddress(apiKey, address) {
  return shippoRequest(apiKey, '/addresses/', 'POST', Object.assign({}, address, { validate: true }));
}

function getOrgShippoKey(orgData) {
  return (orgData.settings && orgData.settings.shippoApiKey) || '';
}

function formatAddressForShippo(customerName, addressString, email, phone) {
  var parts = addressString.split(',').map(function(p) { return p.trim(); });
  var street1 = parts[0] || '';
  var city = '', state = '', zip = '', country = 'US';
  if (parts.length >= 3) {
    city = parts[1] || '';
    var stateZip = parts[2] || '';
    var stateZipMatch = stateZip.match(/^([A-Z]{2})\s*(\d{5}(-\d{4})?)$/i);
    if (stateZipMatch) { state = stateZipMatch[1]; zip = stateZipMatch[2]; }
    else { state = stateZip; zip = parts[3] || ''; }
  } else if (parts.length === 2) { city = parts[1] || ''; }
  if (parts.length >= 4) {
    var lastPart = parts[parts.length - 1].trim().toUpperCase();
    if (lastPart.length === 2 && lastPart !== state) country = lastPart;
  }
  var allText = parts.join(' ');
  var canadianPostal = allText.match(/([A-Z]\d[A-Z]\s?\d[A-Z]\d)/i);
  if (canadianPostal) {
    country = 'CA'; zip = canadianPostal[1].toUpperCase();
    var provinces = ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'];
    for (var i = 0; i < parts.length; i++) {
      var trimmed = parts[i].trim().toUpperCase();
      if (provinces.indexOf(trimmed) >= 0) { state = trimmed; break; }
    }
  }
  return { name: customerName || 'Customer', street1: street1, city: city, state: state, zip: zip, country: country, email: email || '', phone: phone || '' };
}

function formatStructuredAddress(data) {
  return {
    name: data.name || data.customerName || '', company: data.company || '',
    street1: data.street1 || data.address || '', street2: data.street2 || '',
    city: data.city || '', state: data.state || '',
    zip: data.zip || data.zipCode || '', country: data.country || 'US',
    email: data.email || '', phone: data.phone || '',
  };
}

function isInternational(fromCountry, toCountry) {
  return (fromCountry || 'US').toUpperCase() !== (toCountry || 'US').toUpperCase();
}

function formatParcelsFromOrder(order) {
  var parcels = [];
  if (order.packingMode === 'triwalls' && order.triwalls && order.triwalls.length > 0) {
    order.triwalls.forEach(function(tw) {
      parcels.push({ length: parseFloat(tw.length) || 48, width: parseFloat(tw.width) || 40, height: parseFloat(tw.height) || 36, weight: parseFloat(tw.weight) || 50, distance_unit: 'in', mass_unit: 'lb' });
    });
  } else if (order.boxDetails && Object.keys(order.boxDetails).length > 0) {
    Object.entries(order.boxDetails).forEach(function(entry) {
      var box = entry[1];
      parcels.push({ length: parseFloat(box.length) || 12, width: parseFloat(box.width) || 12, height: parseFloat(box.height) || 12, weight: parseFloat(box.weight) || 5, distance_unit: 'in', mass_unit: 'lb' });
    });
  } else {
    parcels.push({ length: 12, width: 12, height: 12, weight: 5, distance_unit: 'in', mass_unit: 'lb' });
  }
  return parcels;
}

async function processPackedOrder(apiKey, order, orgSettings) {
  var fromAddress = orgSettings.shippingFromAddress;
  if (!fromAddress || !fromAddress.street1) throw new Error('Shipping "From" address not configured.');

  var toAddressRaw;
  if (order.shipToAddress) toAddressRaw = formatAddressForShippo(order.customerName, order.shipToAddress, order.customerEmail, order.customerPhone);
  else if (order.customerAddress) toAddressRaw = formatAddressForShippo(order.customerName, order.customerAddress, order.customerEmail, order.customerPhone);
  else throw new Error('Order ' + order.poNumber + ' has no shipping address');

  if (order.customsInfo && order.customsInfo.destinationCountry) toAddressRaw.country = order.customsInfo.destinationCountry;

  var parcels = formatParcelsFromOrder(order);
  var fromFormatted = formatStructuredAddress(fromAddress);
  var international = isInternational(fromFormatted.country, toAddressRaw.country);
  var customsDeclarationId = null;

  if (international) {
    console.log('  International shipment to ' + toAddressRaw.country);
    var customs = await createCustomsDeclaration(apiKey, order, orgSettings);
    customsDeclarationId = customs.object_id;
  }

  var shipment = await createShipment(apiKey, fromFormatted, toAddressRaw, parcels, customsDeclarationId);
  var preferredCarrier = orgSettings.preferredCarrier || 'ups';
  var selectedRate = null;

  if (shipment.rates && shipment.rates.length > 0) {
    selectedRate = shipment.rates.find(function(r) { return r.provider.toLowerCase().indexOf(preferredCarrier.toLowerCase()) >= 0; });
    if (!selectedRate) selectedRate = shipment.rates.sort(function(a, b) { return parseFloat(a.amount) - parseFloat(b.amount); })[0];
  }

  var result = {
    shipmentId: shipment.object_id, international: international,
    customsDeclarationId: customsDeclarationId, destinationCountry: toAddressRaw.country,
    rates: (shipment.rates || []).map(function(r) {
      return { rateId: r.object_id, provider: r.provider, servicelevel: (r.servicelevel && r.servicelevel.name) || (r.servicelevel && r.servicelevel.token) || '', amount: r.amount, currency: r.currency, estimatedDays: r.estimated_days, durationTerms: r.duration_terms };
    }),
    selectedRate: selectedRate ? { rateId: selectedRate.object_id, provider: selectedRate.provider, servicelevel: (selectedRate.servicelevel && selectedRate.servicelevel.name) || (selectedRate.servicelevel && selectedRate.servicelevel.token) || '', amount: selectedRate.amount, currency: selectedRate.currency } : null,
    parcels: parcels.length, toAddress: toAddressRaw, createdAt: Date.now(),
  };

  if (orgSettings.autoPurchaseLabels && selectedRate) {
    var transaction = await purchaseLabel(apiKey, selectedRate.object_id);
    if (transaction.status === 'SUCCESS') {
      result.labelUrl = transaction.label_url; result.trackingNumber = transaction.tracking_number;
      result.trackingUrl = transaction.tracking_url_provider; result.transactionId = transaction.object_id;
      result.labelStatus = 'purchased'; result.purchasedAt = Date.now();
    } else {
      result.labelStatus = 'failed';
      result.labelError = (transaction.messages || []).map(function(m) { return m.text; }).join('; ') || 'Unknown error';
    }
  } else { result.labelStatus = 'rates_ready'; }

  return result;
}

// SCHEDULED
exports.checkPackedOrdersScheduled = functions.pubsub.schedule('every 1 hours').timeZone('America/New_York').onRun(async function(context) {
  console.log('Hourly shipping check triggered');
  try {
    var now = new Date();
    var estHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
    var orgsSnapshot = await db.collection('organizations').get();
    for (var i = 0; i < orgsSnapshot.docs.length; i++) {
      var orgDoc = orgsSnapshot.docs[i];
      var org = orgDoc.data(); var orgId = orgDoc.id;
      var checkHour = (org.settings && org.settings.shippingCheckHour !== undefined) ? org.settings.shippingCheckHour : 15;
      if (estHour !== checkHour) continue;
      if (!(org.settings && org.settings.shippingEnabled)) continue;
      var apiKey = getOrgShippoKey(org);
      if (!apiKey) continue;
      await processOrgPackedOrders(orgId, org, apiKey);
    }
  } catch (error) { console.error('Scheduled shipping check failed:', error); }
});

// CALLABLE FUNCTIONS
exports.generateShippingLabel = functions.https.onCall(async function(data, context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  var orderId = data.orderId, orgId = data.orgId, rateId = data.rateId;
  if (!orderId || !orgId) throw new functions.https.HttpsError('invalid-argument', 'orderId and orgId required');
  try {
    var orderDoc = await db.collection('purchaseOrders').doc(orderId).get();
    if (!orderDoc.exists) throw new functions.https.HttpsError('not-found', 'Order not found');
    var order = Object.assign({ id: orderDoc.id }, orderDoc.data());
    if (order.orgId !== orgId) throw new functions.https.HttpsError('permission-denied', 'Wrong org');
    var orgDoc = await db.collection('organizations').doc(orgId).get();
    var orgData = orgDoc.data(); var apiKey = getOrgShippoKey(orgData);
    if (!apiKey) throw new functions.https.HttpsError('failed-precondition', 'Shippo API key not configured.');
    var orgSettings = { shippingFromAddress: (orgData.settings && orgData.settings.shippingFromAddress) || null, preferredCarrier: (orgData.settings && orgData.settings.preferredCarrier) || 'ups', autoPurchaseLabels: !!rateId, preferredService: '' };

    if (rateId) {
      var transaction = await purchaseLabel(apiKey, rateId);
      var result = Object.assign({}, order.shippingLabel || {}, {
        labelUrl: transaction.label_url, trackingNumber: transaction.tracking_number,
        trackingUrl: transaction.tracking_url_provider, transactionId: transaction.object_id,
        labelStatus: transaction.status === 'SUCCESS' ? 'purchased' : 'failed',
        labelError: transaction.status !== 'SUCCESS' ? (transaction.messages || []).map(function(m) { return m.text; }).join('; ') : null,
        purchasedAt: Date.now(),
      });
      await db.collection('purchaseOrders').doc(orderId).update({ shippingLabel: result, shippingStatus: result.labelStatus, updatedAt: Date.now() });
      return result;
    }

    var shippingResult = await processPackedOrder(apiKey, order, orgSettings);
    await db.collection('purchaseOrders').doc(orderId).update({ shippingLabel: shippingResult, shippingStatus: shippingResult.labelStatus, updatedAt: Date.now() });
    return shippingResult;
  } catch (error) { console.error('generateShippingLabel error:', error); throw new functions.https.HttpsError('internal', error.message); }
});

exports.batchGenerateLabels = functions.https.onCall(async function(data, context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  var orderIds = data.orderIds, orgId = data.orgId, autoPurchase = data.autoPurchase;
  if (!orderIds || !orderIds.length || !orgId) throw new functions.https.HttpsError('invalid-argument', 'orderIds and orgId required');
  try {
    var orgDoc = await db.collection('organizations').doc(orgId).get();
    if (!orgDoc.exists) throw new functions.https.HttpsError('not-found', 'Org not found');
    var orgData = orgDoc.data(); var apiKey = getOrgShippoKey(orgData);
    if (!apiKey) throw new functions.https.HttpsError('failed-precondition', 'Shippo API key not configured.');
    var orgSettings = { shippingFromAddress: (orgData.settings && orgData.settings.shippingFromAddress) || null, preferredCarrier: (orgData.settings && orgData.settings.preferredCarrier) || 'ups', autoPurchaseLabels: !!autoPurchase, preferredService: '' };

    var results = { success: [], failed: [], total: orderIds.length };
    for (var i = 0; i < orderIds.length; i++) {
      var oid = orderIds[i];
      try {
        var oDoc = await db.collection('purchaseOrders').doc(oid).get();
        if (!oDoc.exists) { results.failed.push({ orderId: oid, error: 'Not found' }); continue; }
        var o = Object.assign({ id: oDoc.id }, oDoc.data());
        if (o.orgId !== orgId) { results.failed.push({ orderId: oid, error: 'Wrong org' }); continue; }
        var sr = await processPackedOrder(apiKey, o, orgSettings);
        await db.collection('purchaseOrders').doc(oid).update({ shippingLabel: sr, shippingStatus: sr.labelStatus, updatedAt: Date.now() });
        results.success.push({ orderId: oid, poNumber: o.poNumber, labelStatus: sr.labelStatus, trackingNumber: sr.trackingNumber || null, amount: (sr.selectedRate && sr.selectedRate.amount) || null, carrier: (sr.selectedRate && sr.selectedRate.provider) || null });
      } catch (oe) {
        results.failed.push({ orderId: oid, error: oe.message });
        await db.collection('purchaseOrders').doc(oid).update({ shippingLabel: { labelStatus: 'error', error: oe.message, createdAt: Date.now() }, shippingStatus: 'error', updatedAt: Date.now() });
      }
    }
    await db.collection('activityLog').add({ orgId: orgId, action: 'BATCH_SHIPPING_LABELS', details: { total: results.total, success: results.success.length, failed: results.failed.length, triggeredBy: context.auth.token.email || context.auth.uid }, userId: context.auth.uid, userEmail: context.auth.token.email || 'Unknown', timestamp: Date.now(), createdAt: new Date().toISOString() });
    return results;
  } catch (error) { console.error('batchGenerateLabels error:', error); throw new functions.https.HttpsError('internal', error.message); }
});

exports.saveCustomsInfo = functions.https.onCall(async function(data, context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  var orderId = data.orderId, orgId = data.orgId, customsInfo = data.customsInfo;
  if (!orderId || !orgId) throw new functions.https.HttpsError('invalid-argument', 'orderId and orgId required');
  try {
    await db.collection('purchaseOrders').doc(orderId).update({ customsInfo: customsInfo, updatedAt: Date.now() });
    return { success: true };
  } catch (error) { throw new functions.https.HttpsError('internal', error.message); }
});

exports.triggerShippingCheck = functions.https.onCall(async function(data, context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  var orgId = data.orgId;
  if (!orgId) throw new functions.https.HttpsError('invalid-argument', 'orgId required');
  try {
    var orgDoc = await db.collection('organizations').doc(orgId).get();
    if (!orgDoc.exists) throw new functions.https.HttpsError('not-found', 'Org not found');
    var orgData = orgDoc.data(); var apiKey = getOrgShippoKey(orgData);
    if (!apiKey) throw new functions.https.HttpsError('failed-precondition', 'No API key');
    await processOrgPackedOrders(orgId, orgData, apiKey);
    return { success: true };
  } catch (error) { throw new functions.https.HttpsError('internal', error.message); }
});

exports.updateShippingSchedule = functions.https.onCall(async function(data, context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  var orgId = data.orgId;
  if (!orgId) throw new functions.https.HttpsError('invalid-argument', 'orgId required');
  try {
    var updates = {}; updates['updatedAt'] = Date.now();
    if (data.checkHour !== undefined) updates['settings.shippingCheckHour'] = parseInt(data.checkHour);
    if (data.checkMinute !== undefined) updates['settings.shippingCheckMinute'] = parseInt(data.checkMinute);
    if (data.enabled !== undefined) updates['settings.shippingEnabled'] = !!data.enabled;
    await db.collection('organizations').doc(orgId).update(updates);
    return { success: true };
  } catch (error) { throw new functions.https.HttpsError('internal', error.message); }
});

exports.validateShippingAddress = functions.https.onCall(async function(data, context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  try {
    var orgDoc = await db.collection('organizations').doc(data.orgId).get();
    var apiKey = getOrgShippoKey(orgDoc.data());
    if (!apiKey) throw new functions.https.HttpsError('failed-precondition', 'No API key');
    var result = await validateAddress(apiKey, data.address);
    return { isValid: (result.validation_results && result.validation_results.is_valid) || false, messages: (result.validation_results && result.validation_results.messages) || [], suggestedAddress: result };
  } catch (error) { throw new functions.https.HttpsError('internal', error.message); }
});

exports.getShippingRates = functions.https.onCall(async function(data, context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  try {
    var orderDoc = await db.collection('purchaseOrders').doc(data.orderId).get();
    if (!orderDoc.exists) throw new Error('Order not found');
    var order = Object.assign({ id: orderDoc.id }, orderDoc.data());
    var orgDoc = await db.collection('organizations').doc(data.orgId).get();
    var orgData = orgDoc.data(); var apiKey = getOrgShippoKey(orgData);
    if (!apiKey) throw new Error('Shippo API key not configured.');
    var orgSettings = { shippingFromAddress: (orgData.settings && orgData.settings.shippingFromAddress) || null, preferredCarrier: (orgData.settings && orgData.settings.preferredCarrier) || 'ups', autoPurchaseLabels: false, preferredService: '' };
    var result = await processPackedOrder(apiKey, order, orgSettings);
    await db.collection('purchaseOrders').doc(data.orderId).update({ shippingLabel: result, shippingStatus: 'rates_ready', updatedAt: Date.now() });
    return result;
  } catch (error) { throw new functions.https.HttpsError('internal', error.message); }
});
