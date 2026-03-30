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
const { PDFDocument } = require('pdf-lib');

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

async function createShipment(apiKey, fromAddress, toAddress, parcels, customsDeclarationId, thirdPartyBilling, carrierAccountIds) {
  var shipmentData = {
    address_from: fromAddress, address_to: toAddress, parcels: parcels, async: false,
  };
  if (customsDeclarationId) shipmentData.customs_declaration = customsDeclarationId;
  // Force specific carrier accounts if provided
  if (carrierAccountIds && carrierAccountIds.length > 0) {
    shipmentData.carrier_accounts = carrierAccountIds;
  }
  // Add third-party billing if provided
  if (thirdPartyBilling && thirdPartyBilling.account) {
    if (!shipmentData.extra) shipmentData.extra = {};
    shipmentData.extra.billing = {
      type: thirdPartyBilling.type || 'THIRD_PARTY',
      account: thirdPartyBilling.account,
      zip: thirdPartyBilling.zip || '',
      country: thirdPartyBilling.country || 'US'
    };
  }
  return shippoRequest(apiKey, '/shipments/', 'POST', shipmentData);
}

async function purchaseLabel(apiKey, rateId) {
  // Purchase the rate - returns master transaction (first parcel only)
  var masterTransaction = await shippoRequest(apiKey, '/transactions/', 'POST', { rate: rateId, label_file_type: 'PDF_4x6', async: false });

  // For multi-parcel: fetch ALL transactions for this rate to get every parcel's label
  // Wait briefly for Shippo to generate all parcel labels
  await new Promise(function(resolve) { setTimeout(resolve, 3000); });
  var allTransactions = await shippoRequest(apiKey, '/transactions/?rate=' + rateId, 'GET');
  
  // Retry once if we only got 1 result (labels may still be generating)
  if (!allTransactions.results || allTransactions.results.filter(function(t) { return t.status === 'SUCCESS'; }).length <= 1) {
    await new Promise(function(resolve) { setTimeout(resolve, 5000); });
    allTransactions = await shippoRequest(apiKey, '/transactions/?rate=' + rateId, 'GET');
  }

  if (allTransactions.results && allTransactions.results.length > 1) {
    masterTransaction.allLabels = allTransactions.results
      .filter(function(t) { return t.status === 'SUCCESS'; })
      .map(function(t) {
        return {
          labelUrl: t.label_url,
          trackingNumber: t.tracking_number,
          trackingUrl: t.tracking_url_provider,
          transactionId: t.object_id,
        };
      });
  }
  return masterTransaction;
}

async function validateAddress(apiKey, address) {
  return shippoRequest(apiKey, '/addresses/', 'POST', Object.assign({}, address, { validate: true }));
}

function getOrgShippoKey(orgData) {
  return (orgData.settings && orgData.settings.shippoApiKey) || '';
}

function formatAddressForShippo(customerName, addressString, email, phone) {
  // Normalize: replace newlines with commas, strip periods after state codes, collapse multiple commas/spaces
  var normalized = (addressString || '').replace(/[\r\n]+/g, ', ').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').trim();
  // Strip periods after 2-letter state codes (e.g., "NC. 28546" -> "NC 28546")
  normalized = normalized.replace(/\b([A-Z]{2})\.\s*/gi, '$1 ');
  var parts = normalized.split(',').map(function(p) { return p.trim(); }).filter(function(p) { return p.length > 0; });
  
  var street1 = '', street2 = '', city = '', state = '', zip = '', country = 'US';
  var allText = parts.join(' ');
  
  // Check for Canadian postal code anywhere in the address
  var canadianPostal = allText.match(/([A-Z]\d[A-Z]\s?\d[A-Z]\d)/i);
  if (canadianPostal) {
    country = 'CA';
    zip = canadianPostal[1].toUpperCase().replace(/\s/, ' ');
    var provinces = ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'];
    for (var i = 0; i < parts.length; i++) {
      var trimmed = parts[i].trim().toUpperCase();
      if (provinces.indexOf(trimmed) >= 0) { state = trimmed; break; }
      for (var p = 0; p < provinces.length; p++) {
        if (trimmed.indexOf(provinces[p]) === 0) { state = provinces[p]; break; }
      }
      if (state) break;
    }
    street1 = parts[0] || '';
    if (parts.length >= 3) city = parts[parts.length - 3] || parts[1] || '';
    else if (parts.length >= 2) city = parts[1] || '';
    return { name: customerName || 'Customer', street1: street1, city: city, state: state, zip: zip, country: country, email: email || '', phone: phone || '' };
  }
  
  // Try to extract US zip code from anywhere in the text
  var usZipMatch = allText.match(/\b(\d{5}(-\d{4})?)\b/);
  if (usZipMatch) zip = usZipMatch[1];
  
  // Try to extract 2-letter state code
  var stateMatch = allText.match(/\b([A-Z]{2})\s+\d{5}/i);
  if (stateMatch) state = stateMatch[1].toUpperCase();
  
  // Check if last part is a 2-letter country code (not a US state)
  var usStates = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP'];
  if (parts.length >= 4) {
    var lastPart = parts[parts.length - 1].trim().toUpperCase();
    if (lastPart.length === 2 && usStates.indexOf(lastPart) < 0 && lastPart !== state) {
      country = lastPart;
    }
  }
  
  // Parse parts based on count
  if (parts.length >= 4) {
    street1 = parts[0] || '';
    city = parts[1] || '';
    if (!state) {
      var p2Match = parts[2].match(/^([A-Z]{2})\s*(\d{5}(-\d{4})?)?\s*$/i);
      if (p2Match) { state = p2Match[1].toUpperCase(); if (p2Match[2] && !zip) zip = p2Match[2]; }
      else state = parts[2];
    }
    if (!zip && parts[3]) {
      var p3Zip = parts[3].match(/\d{5}(-\d{4})?/);
      if (p3Zip) zip = p3Zip[0];
    }
  } else if (parts.length === 3) {
    street1 = parts[0] || '';
    city = parts[1] || '';
    var stateZip = parts[2] || '';
    var stateZipMatch = stateZip.match(/^([A-Z]{2})\s*(\d{5}(-\d{4})?)$/i);
    if (stateZipMatch) { if (!state) state = stateZipMatch[1]; if (!zip) zip = stateZipMatch[2]; }
    else if (!state) { state = stateZip; }
  } else if (parts.length === 2) {
    street1 = parts[0] || '';
    var part1Match = parts[1].match(/^(.+?)\s+([A-Z]{2})\s+(\d{5}(-\d{4})?)$/i);
    if (part1Match) { city = part1Match[1]; if (!state) state = part1Match[2]; if (!zip) zip = part1Match[3]; }
    else city = parts[1] || '';
  } else if (parts.length === 1) {
    street1 = parts[0] || '';
  }
  
  // Clean up final values
  state = (state || '').replace(/\./g, '').trim();
  zip = (zip || '').trim();
  city = (city || '').trim();
  
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

function formatParcelsFromOrder(order, insuranceAmount, insuranceProvider) {
  var parcels = [];
  var boxNumbers = []; // Track which box number each parcel corresponds to
  if (order.packingMode === 'triwalls' && order.triwalls && order.triwalls.length > 0) {
    order.triwalls.forEach(function(tw, i) {
      parcels.push({ length: parseFloat(tw.length) || 48, width: parseFloat(tw.width) || 40, height: parseFloat(tw.height) || 36, weight: parseFloat(tw.weight) || 50, distance_unit: 'in', mass_unit: 'lb' });
      boxNumbers.push(String(i + 1));
    });
  } else if (order.boxDetails && Object.keys(order.boxDetails).length > 0) {
    Object.entries(order.boxDetails).forEach(function(entry) {
      var boxNum = entry[0];
      var box = entry[1];
      parcels.push({ length: parseFloat(box.length) || 12, width: parseFloat(box.width) || 12, height: parseFloat(box.height) || 12, weight: parseFloat(box.weight) || 5, distance_unit: 'in', mass_unit: 'lb' });
      boxNumbers.push(boxNum);
    });
  } else {
    parcels.push({ length: 12, width: 12, height: 12, weight: 5, distance_unit: 'in', mass_unit: 'lb' });
    boxNumbers.push('1');
  }
  
  // Apply insurance per-box if available, otherwise split evenly
  // insuranceProvider: 'UPS' for UPS native, undefined/null for XCover default
  var boxInsurance = order.boxInsurance || {};
  var hasPerBoxInsurance = Object.keys(boxInsurance).length > 0;
  var insuranceObj = function(amt) {
    var ins = { amount: String(amt), currency: 'USD' };
    if (insuranceProvider) ins.provider = insuranceProvider;
    return ins;
  };
  
  if (hasPerBoxInsurance) {
    parcels.forEach(function(p, i) {
      var boxNum = boxNumbers[i];
      var boxAmt = parseFloat(boxInsurance[boxNum]) || 0;
      if (boxAmt > 0) {
        p.extra = { insurance: insuranceObj(boxAmt) };
      }
    });
  } else if (insuranceAmount && insuranceAmount > 0 && parcels.length > 0) {
    var perParcel = Math.ceil((insuranceAmount / parcels.length) * 100) / 100;
    parcels.forEach(function(p) {
      p.extra = { insurance: insuranceObj(perParcel) };
    });
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

  // Validate and auto-correct the destination address (Shippo's dashboard does this automatically)
  try {
    var validated = await validateAddress(apiKey, toAddressRaw);
    console.log('=== ADDRESS VALIDATION ===');
    console.log('Original:', JSON.stringify(toAddressRaw));
    console.log('Validated:', JSON.stringify({ street1: validated.street1, city: validated.city, state: validated.state, zip: validated.zip, country: validated.country }));
    console.log('Is valid:', validated.validation_results && validated.validation_results.is_valid);
    console.log('Messages:', JSON.stringify((validated.validation_results && validated.validation_results.messages) || []));
    console.log('=== END VALIDATION ===');
    // Use the validated/corrected address if validation passed
    if (validated.validation_results && validated.validation_results.is_valid) {
      toAddressRaw = {
        name: validated.name || toAddressRaw.name,
        street1: validated.street1 || toAddressRaw.street1,
        street2: validated.street2 || '',
        city: validated.city || toAddressRaw.city,
        state: validated.state || toAddressRaw.state,
        zip: validated.zip || toAddressRaw.zip,
        country: validated.country || toAddressRaw.country,
        email: toAddressRaw.email || '',
        phone: toAddressRaw.phone || ''
      };
      console.log('Using validated address');
    } else {
      console.log('Validation failed, using original parsed address');
    }
  } catch (e) {
    console.log('Address validation error (continuing with original):', e.message);
  }

  var insuranceAmount = (order.insuranceAmount !== undefined && order.insuranceAmount !== null && order.insuranceAmount !== '') ? parseFloat(order.insuranceAmount) : (order.subtotal || order.total || 0);
  var fromFormatted = formatStructuredAddress(fromAddress);
  var international = isInternational(fromFormatted.country, toAddressRaw.country);
  var customsDeclarationId = null;

  if (international) {
    console.log('  International shipment to ' + toAddressRaw.country);
    var customs = await createCustomsDeclaration(apiKey, order, orgSettings);
    customsDeclarationId = customs.object_id;
  }

  // Fetch active carrier accounts - prefer user's own accounts over Shippo accounts
  var carrierAccountIds = [];
  try {
    var carriers = await shippoRequest(apiKey, '/carrier_accounts/?results=50', 'GET');
    var activeAccounts = (carriers.results || []).filter(function(c) { return c.active; });
    console.log('=== CARRIER ACCOUNTS ===');
    activeAccounts.forEach(function(c) {
      console.log('  ' + c.carrier + ' | ' + (c.account_id || 'no-id') + ' | object_id: ' + c.object_id + ' | is_shippo: ' + c.is_shippo_account);
    });
    console.log('=== END CARRIER ACCOUNTS ===');
    
    var userOwnCarriers = {};
    activeAccounts.forEach(function(c) {
      if (!c.is_shippo_account) userOwnCarriers[c.carrier] = true;
    });
    
    carrierAccountIds = activeAccounts.filter(function(c) {
      if (c.is_shippo_account && userOwnCarriers[c.carrier]) {
        console.log('  Excluding Shippo account for ' + c.carrier + ' (user has own account)');
        return false;
      }
      return true;
    }).map(function(c) { return c.object_id; });
    
    console.log('Using ' + carrierAccountIds.length + ' carrier accounts for rate request');
  } catch (e) {
    console.log('Could not fetch carrier accounts:', e.message);
  }

  // Create TWO shipments: one with UPS insurance, one with XCover (no provider)
  // This lets the user compare total costs with different insurance providers
  var hasInsurance = insuranceAmount > 0 || (order.boxInsurance && Object.keys(order.boxInsurance).length > 0);
  
  var parcelsUPS = formatParcelsFromOrder(order, insuranceAmount, 'UPS');
  var shipmentUPS = await createShipment(apiKey, fromFormatted, toAddressRaw, parcelsUPS, customsDeclarationId, order.thirdPartyBilling || null, carrierAccountIds);
  
  var allRates = (shipmentUPS.rates || []).map(function(r) {
    return { 
      rateId: r.object_id, provider: r.provider, 
      servicelevel: (r.servicelevel && r.servicelevel.name) || (r.servicelevel && r.servicelevel.token) || '', 
      amount: r.amount, currency: r.currency, estimatedDays: r.estimated_days, durationTerms: r.duration_terms,
      insuranceProvider: hasInsurance ? 'UPS' : 'none',
      shipmentId: shipmentUPS.object_id
    };
  });
  
  console.log('=== SHIPPO DEBUG (UPS Insurance) ===');
  console.log('Shipment ID:', shipmentUPS.object_id);
  console.log('Total rates returned:', (shipmentUPS.rates || []).length);
  console.log('Carriers:', (shipmentUPS.rates || []).map(function(r) { return r.provider; }));
  console.log('=== END DEBUG ===');

  // Only fetch XCover rates if there's insurance to compare
  var shipmentXCover = null;
  if (hasInsurance) {
    try {
      var parcelsXCover = formatParcelsFromOrder(order, insuranceAmount, null); // no provider = XCover
      shipmentXCover = await createShipment(apiKey, fromFormatted, toAddressRaw, parcelsXCover, customsDeclarationId, order.thirdPartyBilling || null, carrierAccountIds);
      
      (shipmentXCover.rates || []).forEach(function(r) {
        allRates.push({
          rateId: r.object_id, provider: r.provider,
          servicelevel: (r.servicelevel && r.servicelevel.name) || (r.servicelevel && r.servicelevel.token) || '',
          amount: r.amount, currency: r.currency, estimatedDays: r.estimated_days, durationTerms: r.duration_terms,
          insuranceProvider: 'XCover',
          shipmentId: shipmentXCover.object_id
        });
      });
      
      console.log('=== SHIPPO DEBUG (XCover Insurance) ===');
      console.log('Shipment ID:', shipmentXCover.object_id);
      console.log('Total rates returned:', (shipmentXCover.rates || []).length);
      console.log('=== END DEBUG ===');
    } catch (e) {
      console.log('XCover shipment failed (non-critical):', e.message);
    }
  }

  // Sort all rates by price
  allRates.sort(function(a, b) { return parseFloat(a.amount) - parseFloat(b.amount); });

  var preferredCarrier = orgSettings.preferredCarrier || 'ups';
  var selectedRate = null;

  if (allRates.length > 0) {
    var carrierRates = allRates.filter(function(r) { return r.provider.toLowerCase().indexOf(preferredCarrier.toLowerCase()) >= 0; });
    if (carrierRates.length > 0) {
      selectedRate = carrierRates[0]; // already sorted cheapest first
    }
    if (!selectedRate) selectedRate = allRates[0];
  }

  var result = {
    shipmentId: shipmentUPS.object_id, international: international,
    xCoverShipmentId: shipmentXCover ? shipmentXCover.object_id : null,
    customsDeclarationId: customsDeclarationId, destinationCountry: toAddressRaw.country,
    rates: allRates,
    selectedRate: selectedRate,
    parcels: parcelsUPS.length, toAddress: toAddressRaw, createdAt: Date.now(),
    insuranceAmount: insuranceAmount,
  };

  if (orgSettings.autoPurchaseLabels && selectedRate) {
    var transaction = await purchaseLabel(apiKey, selectedRate.object_id);
    if (transaction.status === 'SUCCESS') {
      result.labelUrl = transaction.label_url; result.trackingNumber = transaction.tracking_number;
      result.trackingUrl = transaction.tracking_url_provider; result.transactionId = transaction.object_id;
      result.labelStatus = 'purchased'; result.purchasedAt = Date.now();
      result.labelPageCount = parcels.length;
      // Store all parcel labels for multi-piece shipments
      if (transaction.allLabels && transaction.allLabels.length > 0) {
        result.allLabels = transaction.allLabels;
      }
    } else {
      result.labelStatus = 'failed';
      result.labelError = (transaction.messages || []).map(function(m) { return m.text; }).join('; ') || 'Unknown error';
    }
  } else {
    result.labelStatus = 'rates_ready';
    result.labelPageCount = parcels.length;
  }

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
      var parcelCount = (order.boxDetails ? Object.keys(order.boxDetails).length : 0) || (order.triwalls ? order.triwalls.length : 0) || 1;
      var result = Object.assign({}, order.shippingLabel || {}, {
        labelUrl: transaction.label_url, trackingNumber: transaction.tracking_number,
        trackingUrl: transaction.tracking_url_provider, transactionId: transaction.object_id,
        labelStatus: transaction.status === 'SUCCESS' ? 'purchased' : 'failed',
        labelError: transaction.status !== 'SUCCESS' ? (transaction.messages || []).map(function(m) { return m.text; }).join('; ') : null,
        purchasedAt: Date.now(), labelPageCount: parcelCount,
        allLabels: (transaction.allLabels && transaction.allLabels.length > 0) ? transaction.allLabels : null,
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

exports.saveInsurance = functions.https.onCall(async function(data, context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  var orderId = data.orderId, orgId = data.orgId, insuranceAmount = data.insuranceAmount;
  if (!orderId || !orgId) throw new functions.https.HttpsError('invalid-argument', 'orderId and orgId required');
  try {
    var updateObj = { insuranceAmount: parseFloat(insuranceAmount) || 0, updatedAt: Date.now() };
    // Save per-box insurance if provided
    if (data.boxInsurance && typeof data.boxInsurance === 'object') {
      var cleanBoxInsurance = {};
      Object.keys(data.boxInsurance).forEach(function(k) {
        cleanBoxInsurance[k] = parseFloat(data.boxInsurance[k]) || 0;
      });
      updateObj.boxInsurance = cleanBoxInsurance;
    }
    await db.collection('purchaseOrders').doc(orderId).update(updateObj);
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

// Merge multiple label PDFs into a single PDF - returns base64
exports.mergeLabelPdfs = functions.runWith({ timeoutSeconds: 60, memory: '512MB' }).https.onCall(async function(data, context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  var urls = data.urls;
  if (!urls || !Array.isArray(urls) || urls.length === 0) throw new functions.https.HttpsError('invalid-argument', 'No label URLs provided');
  try {
    var mergedPdf = await PDFDocument.create();
    for (var i = 0; i < urls.length; i++) {
      var response = await fetch(urls[i]);
      var pdfBytes = await response.arrayBuffer();
      var srcPdf = await PDFDocument.load(pdfBytes);
      var pages = await mergedPdf.copyPages(srcPdf, srcPdf.getPageIndices());
      pages.forEach(function(p) { mergedPdf.addPage(p); });
    }
    var mergedBytes = await mergedPdf.save();
    var base64 = Buffer.from(mergedBytes).toString('base64');
    return { pdf: base64, pageCount: mergedPdf.getPageCount() };
  } catch (error) { throw new functions.https.HttpsError('internal', 'Failed to merge PDFs: ' + error.message); }
});

// Generate End of Day Driver Summary PDF (4x6 thermal)
exports.generateEndOfDayPdf = functions.runWith({ timeoutSeconds: 30, memory: '256MB' }).https.onCall(async function(data, context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  try {
    var { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    var pdfDoc = await PDFDocument.create();
    // 4x6 inches = 288x432 points
    var page = pdfDoc.addPage([288, 432]);
    var font = await pdfDoc.embedFont(StandardFonts.CourierBold);
    var fontR = await pdfDoc.embedFont(StandardFonts.Courier);
    var y = 415;
    var lh = 13;
    var margin = 15;

    function drawText(text, x, yPos, size, f) {
      page.drawText(text || '', { x: x, y: yPos, size: size || 9, font: f || font, color: rgb(0, 0, 0) });
    }
    function drawLine(yPos) {
      page.drawLine({ start: { x: margin, y: yPos }, end: { x: 273, y: yPos }, thickness: 1.5, color: rgb(0, 0, 0) });
    }

    // Header
    drawText('PICKUP SUMMARY BARCODE REPORT', margin, y, 9); y -= lh;
    drawText('SHIP DATE:  ' + (data.shipDate || ''), margin, y, 9); y -= lh;
    drawText('ACCOUNT NUMBER: ' + (data.accountNumber || ''), margin, y, 9); y -= lh;
    drawText('CUSTOMER', margin, y, 9); y -= lh;
    drawText('  ' + (data.companyName || ''), margin, y, 9); y -= lh;
    drawText('  ' + (data.street || ''), margin, y, 9); y -= lh;
    drawText('  ' + (data.cityStateZip || ''), margin, y, 9); y -= lh * 2;

    // Separator
    drawLine(y + 5);
    y -= lh;

    // Driver Summary
    drawText('DRIVER SUMMARY', margin, y, 11); y -= lh;
    drawText('TOTAL NUMBER OF PACKAGES = ' + (data.totalPackages || 0), margin, y, 10); y -= lh * 1.5;
    drawText('UPS CONTROL LOG REQUIRED', margin, y, 8, fontR); y -= lh * 1.5;

    // Service breakdown
    drawText('1DA  ' + (data.nextDayCount || 0), margin, y, 9);
    drawText("INT'L pkgs " + (data.intlPkgs || 0), margin + 100, y, 9);
    drawText('/shpts ' + (data.intlShpts || 0), margin + 195, y, 9);
    y -= lh;
    drawText('2DA  ' + (data.twoDayCount || 0), margin, y, 9);
    drawText('CODS     0', margin + 100, y, 9);
    y -= lh;
    drawText('3DS  ' + (data.threeDayCount || 0), margin, y, 9);
    y -= lh;
    drawText('GND  ' + (data.groundCount || 0), margin, y, 9);
    y -= lh * 2;

    // Separator
    drawLine(y + 5);
    y -= lh;

    // Shipment details
    drawText('SHIPMENTS:', margin, y, 8, fontR); y -= lh;
    (data.orderDetails || []).forEach(function(od) {
      if (y < 60) return;
      drawText(od.poNumber + ' ' + (od.customer || '').substring(0, 16) + '  x' + od.packages, margin, y, 7, fontR);
      y -= 10;
    });

    y = Math.min(y, 80);
    // Footer
    drawLine(y + 5);
    y -= lh;
    drawText('SHIPMENTS SUBJECT TO TERMS OF', margin, y, 7, fontR); y -= 10;
    drawText('AGREEMENT ON FILE', margin, y, 7, fontR); y -= lh * 1.5;
    drawText('Received By: ____________________', margin, y, 9); y -= lh * 1.5;
    drawText('Pickup Time: ______  Pkgs: ______', margin, y, 9);

    var pdfBytes = await pdfDoc.save();
    var base64 = Buffer.from(pdfBytes).toString('base64');
    return { pdf: base64 };
  } catch (error) { throw new functions.https.HttpsError('internal', 'End of Day PDF failed: ' + error.message); }
});

// One-time utility: Update UPS carrier account with invoice details to enable negotiated rates
exports.updateCarrierInvoice = functions.https.onCall(async function(data, context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  try {
    var orgDoc = await db.collection('organizations').doc(data.orgId).get();
    var apiKey = getOrgShippoKey(orgDoc.data());
    if (!apiKey) throw new Error('Shippo API key not configured.');
    
    var carrierAccountId = data.carrierAccountId;
    if (!carrierAccountId) throw new Error('carrierAccountId required');
    
    // First GET the current carrier account to see its state
    var current = await shippoRequest(apiKey, '/carrier_accounts/' + carrierAccountId, 'GET');
    console.log('Current carrier account:', JSON.stringify({
      carrier: current.carrier,
      account_id: current.account_id,
      object_id: current.object_id,
      active: current.active,
      is_shippo: current.is_shippo_account,
      has_invoice: current.parameters && current.parameters.has_invoice
    }));
    
    // Update with invoice details via PUT
    var updateBody = {
      parameters: Object.assign({}, current.parameters || {}, {
        has_invoice: true,
        invoice_controlid: data.invoiceControlId || '',
        invoice_date: data.invoiceDate || '',
        invoice_number: data.invoiceNumber || '',
        invoice_value: data.invoiceValue || ''
      })
    };
    
    console.log('Updating carrier account with invoice:', JSON.stringify(updateBody));
    var result = await shippoRequest(apiKey, '/carrier_accounts/' + carrierAccountId, 'PUT', updateBody);
    console.log('Update result:', JSON.stringify({ object_id: result.object_id, active: result.active }));
    
    return { success: true, carrierAccountId: result.object_id, message: 'Invoice details updated. Negotiated rates should now be available.' };
  } catch (error) {
    console.error('updateCarrierInvoice error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});
