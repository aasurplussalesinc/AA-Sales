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

// ── Simple in-memory rate limiter (per function instance) ──
// Resets when the function instance recycles — good enough for burst protection
const rateLimitMap = {};
function checkRateLimit(key, maxCalls, windowMs) {
  const now = Date.now();
  if (!rateLimitMap[key]) rateLimitMap[key] = [];
  // Remove entries outside the window
  rateLimitMap[key] = rateLimitMap[key].filter(t => now - t < windowMs);
  if (rateLimitMap[key].length >= maxCalls) return false;
  rateLimitMap[key].push(now);
  return true;
}

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

function formatAddressForShippo(customerName, addressString, email, phone, company) {
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
    return { name: customerName || 'Customer', company: company || '', street1: street1, city: city, state: state, zip: zip, country: country, email: email || '', phone: phone || '', is_residential: false };
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
  
  return { name: customerName || 'Customer', company: company || '', street1: street1, city: city, state: state, zip: zip, country: country, email: email || '', phone: phone || '', is_residential: false };
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
  // For drop-shipping: when shipToCompany is set, it goes on the label as the recipient business name,
  // and customerName/contact is used as the "Attention To" person name.
  // When no shipToCompany is set, customerName is both the name and company on the label.
  if (order.shipToAddress) {
    var recipientName = order.customerContact || order.customerName;
    var recipientCompany = order.shipToCompany || order.customerName;
    toAddressRaw = formatAddressForShippo(recipientName, order.shipToAddress, order.customerEmail, order.customerPhone, recipientCompany);
  }
  else if (order.customerAddress) toAddressRaw = formatAddressForShippo(order.customerName, order.customerAddress, order.customerEmail, order.customerPhone, order.customerName);
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
        company: toAddressRaw.company || '',
        street1: validated.street1 || toAddressRaw.street1,
        street2: validated.street2 || '',
        city: validated.city || toAddressRaw.city,
        state: validated.state || toAddressRaw.state,
        zip: validated.zip || toAddressRaw.zip,
        country: validated.country || toAddressRaw.country,
        email: toAddressRaw.email || '',
        phone: toAddressRaw.phone || '',
        is_residential: false
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

  // Billing contexts: always fetch AA account rates, also fetch customer-billed rates if they have a UPS account
  var hasInsurance = insuranceAmount > 0 || (order.boxInsurance && Object.keys(order.boxInsurance).length > 0);
  var customerBilling = (order.thirdPartyBilling && order.thirdPartyBilling.account) ? order.thirdPartyBilling : null;

  // Helper to map rates with labels
  function mapRates(shipment, billedTo, insProvider) {
    return (shipment.rates || []).map(function(r) {
      return {
        rateId: r.object_id, provider: r.provider,
        servicelevel: (r.servicelevel && r.servicelevel.name) || (r.servicelevel && r.servicelevel.token) || '',
        amount: r.amount, currency: r.currency, estimatedDays: r.estimated_days, durationTerms: r.duration_terms,
        insuranceProvider: insProvider,
        billedTo: billedTo,
        shipmentId: shipment.object_id
      };
    });
  }

  // --- AA Account rates (no third-party billing) ---
  // Carrier-agnostic insurance (no forced UPS provider) so every carrier — UPS, FedEx, USPS,
  // DHL — can quote. Forcing UPS-provider insurance previously made non-UPS carriers decline
  // the entire shipment.
  var parcelsUPS = formatParcelsFromOrder(order, insuranceAmount, null);
  var shipmentAAUPS = await createShipment(apiKey, fromFormatted, toAddressRaw, parcelsUPS, customsDeclarationId, null, carrierAccountIds);
  var allRates = mapRates(shipmentAAUPS, 'AA', hasInsurance ? 'native' : 'none');

  console.log('=== SHIPPO DEBUG (AA Account / UPS Insurance) ===');
  console.log('Shipment ID:', shipmentAAUPS.object_id);
  console.log('Total rates returned:', (shipmentAAUPS.rates || []).length);
  console.log('Shipment messages:', JSON.stringify(shipmentAAUPS.messages || []));
  console.log('Insurance amount used:', insuranceAmount);
  console.log('Parcels sent:', JSON.stringify(parcelsUPS));
  console.log('=== END DEBUG ===');

  // ── SAFETY-NET CALL: the primary call above already uses carrier-agnostic insurance, so all
  // carriers should quote there. This second provider-agnostic pass catches any carrier that was
  // missed and merges in providers not already present. Usually redundant now, but harmless.
  try {
    var parcelsAgnostic = formatParcelsFromOrder(order, hasInsurance ? insuranceAmount : 0, null);
    var shipmentAgnostic = await createShipment(apiKey, fromFormatted, toAddressRaw, parcelsAgnostic, customsDeclarationId, null, carrierAccountIds);
    var agnosticRates = mapRates(shipmentAgnostic, 'AA', hasInsurance ? 'native' : 'none');

    console.log('=== SHIPPO DEBUG (AA Account / Carrier-Native Insurance) ===');
    console.log('Total rates returned:', (shipmentAgnostic.rates || []).length);
    console.log('=== END DEBUG ===');

    // Add any rates from carriers we don't already have (USPS, FedEx, DHL, etc.)
    var existingProviders = {};
    allRates.forEach(function(r) {
      var key = (r.provider || '') + '|' + (typeof r.servicelevel === 'object' ? (r.servicelevel.token || r.servicelevel.name) : r.servicelevel) + '|' + r.billedTo;
      existingProviders[key] = true;
    });
    agnosticRates.forEach(function(r) {
      var key = (r.provider || '') + '|' + (typeof r.servicelevel === 'object' ? (r.servicelevel.token || r.servicelevel.name) : r.servicelevel) + '|' + r.billedTo;
      if (!existingProviders[key]) allRates.push(r);
    });
  } catch (e) {
    console.log('Agnostic-insurance shipment failed (non-critical):', e.message);
  }

  // FALLBACK: if insurance is set but no rates returned, retry without insurance
  // This commonly happens when insurance amount exceeds carrier max or causes Shippo validation errors
  var insuranceFallbackUsed = false;
  if (hasInsurance && allRates.length === 0) {
    console.log('No rates with insurance — retrying without insurance as fallback');
    try {
      var parcelsNoIns = formatParcelsFromOrder(order, 0, null);
      var shipmentFallback = await createShipment(apiKey, fromFormatted, toAddressRaw, parcelsNoIns, customsDeclarationId, null, carrierAccountIds);
      var fallbackRates = mapRates(shipmentFallback, 'AA', 'none');
      if (fallbackRates.length > 0) {
        allRates = fallbackRates;
        insuranceFallbackUsed = true;
        console.log('Fallback succeeded — got ' + fallbackRates.length + ' rates without insurance');
      } else {
        console.log('Fallback also returned 0 rates. Messages:', JSON.stringify(shipmentFallback.messages || []));
      }
    } catch (fallbackErr) {
      console.log('Fallback retry error:', fallbackErr.message);
    }
  }

  // AA Account + XCover insurance
  if (hasInsurance) {
    try {
      var parcelsAAXCover = formatParcelsFromOrder(order, insuranceAmount, null);
      var shipmentAAXCover = await createShipment(apiKey, fromFormatted, toAddressRaw, parcelsAAXCover, customsDeclarationId, null, carrierAccountIds);
      allRates = allRates.concat(mapRates(shipmentAAXCover, 'AA', 'XCover'));
      console.log('=== SHIPPO DEBUG (AA Account / XCover Insurance) ===');
      console.log('Total rates returned:', (shipmentAAXCover.rates || []).length);
      console.log('=== END DEBUG ===');
    } catch (e) {
      console.log('AA XCover shipment failed (non-critical):', e.message);
    }
  }

  // --- Customer Account rates (third-party billing) ---
  // Track the outcome so the UI can tell you whether the customer's account
  // will actually be billed, or whether it silently fell back to AA.
  var billing = { requested: !!customerBilling, account: customerBilling ? customerBilling.account : null, customerRateCount: 0, error: null };
  if (customerBilling) {
    try {
      var parcelsCustUPS = formatParcelsFromOrder(order, insuranceAmount, null);
      var shipmentCustUPS = await createShipment(apiKey, fromFormatted, toAddressRaw, parcelsCustUPS, customsDeclarationId, customerBilling, carrierAccountIds);
      var custRates = mapRates(shipmentCustUPS, 'Customer', hasInsurance ? 'native' : 'none');
      billing.customerRateCount += custRates.length;
      allRates = allRates.concat(custRates);
      // Capture any carrier message that explains a decline (account not authorized, etc.)
      var custMsgs = (shipmentCustUPS.messages || []).map(function(m) { return m.text || JSON.stringify(m); });
      if (custRates.length === 0 && custMsgs.length > 0) billing.error = custMsgs.join(' | ');
      console.log('=== SHIPPO DEBUG (Customer Account / UPS Insurance) ===');
      console.log('Customer account:', customerBilling.account);
      console.log('Total rates returned:', (shipmentCustUPS.rates || []).length);
      console.log('=== END DEBUG ===');
    } catch (e) {
      billing.error = e.message;
      console.log('Customer UPS billing shipment failed (non-critical):', e.message);
    }

    // Customer Account + XCover insurance
    if (hasInsurance) {
      try {
        var parcelsCustXCover = formatParcelsFromOrder(order, insuranceAmount, null);
        var shipmentCustXCover = await createShipment(apiKey, fromFormatted, toAddressRaw, parcelsCustXCover, customsDeclarationId, customerBilling, carrierAccountIds);
        var custXRates = mapRates(shipmentCustXCover, 'Customer', 'XCover');
        billing.customerRateCount += custXRates.length;
        allRates = allRates.concat(custXRates);
        console.log('=== SHIPPO DEBUG (Customer Account / XCover Insurance) ===');
        console.log('Total rates returned:', (shipmentCustXCover.rates || []).length);
        console.log('=== END DEBUG ===');
      } catch (e) {
        if (!billing.error) billing.error = e.message;
        console.log('Customer XCover shipment failed (non-critical):', e.message);
      }
    }
  }

  // Resolve a plain-English billing status for the UI.
  // not_requested: no customer account on file → AA is billed (normal)
  // billed_to_customer: customer account returned rates → they can be billed
  // declined: customer account was set but returned NO rates → would fall back to AA
  billing.status = !billing.requested ? 'not_requested'
    : (billing.customerRateCount > 0 ? 'billed_to_customer' : 'declined');

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

  // If auto-purchase is on but rating produced nothing, fail with a clear reason
  // instead of later sending an empty rate to Shippo ("rate: This field is required").
  if (orgSettings.autoPurchaseLabels && !selectedRate) {
    throw new Error('No shipping rates were returned for this order — check the from-address, package weight/dimensions, and connected carrier account.');
  }

  var result = {
    shipmentId: shipmentAAUPS.object_id, international: international,
    customerBillingAccount: customerBilling ? customerBilling.account : null,
    customsDeclarationId: customsDeclarationId, destinationCountry: toAddressRaw.country,
    rates: allRates,
    selectedRate: selectedRate,
    parcels: parcelsUPS.length, toAddress: toAddressRaw, createdAt: Date.now(),
    insuranceAmount: insuranceFallbackUsed ? 0 : insuranceAmount,
    insuranceFallbackUsed: insuranceFallbackUsed,
    shippoMessages: (shipmentAAUPS.messages || []).map(function(m) { return m.text || JSON.stringify(m); }),
    billing: billing,
  };

  if (orgSettings.autoPurchaseLabels && selectedRate) {
    // Per-box spending guard: block auto-purchase if the rate exceeds
    // $45 x (number of boxes). Catches mispriced/oversized shipments before
    // any money is spent; the user buys these manually if they're legitimate.
    var boxCount = parcelsUPS.length || 1;
    // Configurable in Settings → Shipping. Falls back to $45 so existing orgs
    // behave exactly as before; 0 or blank disables the guard entirely.
    var configured = parseFloat(orgSettings.autoPurchaseMaxPerBox);
    var perBoxLimit = isFinite(configured) && configured > 0 ? configured : 45;
    var maxAllowed = perBoxLimit * boxCount;
    var rateAmount = parseFloat(selectedRate.amount) || 0;
    var capDisabled = isFinite(configured) && configured === 0;
    if (!capDisabled && rateAmount > maxAllowed) {
      throw new Error('Rate $' + rateAmount.toFixed(2) + ' exceeds the $' + perBoxLimit + '/box limit ($' + maxAllowed.toFixed(2) + ' for ' + boxCount + ' box' + (boxCount === 1 ? '' : 'es') + '). Purchase this label manually if it is correct.');
    }
    // mapRates() stores Shippo's rate id under `rateId` (not `object_id`), so read
    // that first. Falling back to object_id keeps older/raw rate shapes working.
    var rateObjectId = selectedRate.rateId || selectedRate.object_id;
    if (!rateObjectId) {
      throw new Error('No purchasable shipping rate was returned for this order. Check the from-address, package weight, and that a carrier account is connected.');
    }
    var transaction = await purchaseLabel(apiKey, rateObjectId);
    if (transaction.status === 'SUCCESS') {
      result.labelUrl = transaction.label_url; result.trackingNumber = transaction.tracking_number;
      result.trackingUrl = transaction.tracking_url_provider; result.transactionId = transaction.object_id;
      result.labelStatus = 'purchased'; result.purchasedAt = Date.now();
      result.labelPageCount = parcelsUPS.length;
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
    result.labelPageCount = parcelsUPS.length;
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
// Compute the customer-facing shipping charge from the real carrier cost plus the
// org's markup (percent and/or flat). Returns a number rounded to cents.
function customerShippingCharge(realCost, orgData) {
  var cost = parseFloat(realCost) || 0;
  var m = (orgData && orgData.shippingMarkup) || {};
  var pct = parseFloat(m.percent) || 0;
  var flat = parseFloat(m.flat) || 0;
  var charge = cost * (1 + pct / 100) + flat;
  if (m.roundUp) charge = Math.ceil(charge);
  return Math.round(charge * 100) / 100;
}

// Given the order and the just-purchased shippingLabel, produce the fields to write
// so the invoice's shipping line reflects cost + markup — while RESPECTING a shipping
// amount a user typed manually (never silently overwrite it).
function shippingChargeUpdate(order, shippingLabel, orgData) {
  var rate = shippingLabel && shippingLabel.selectedRate;
  var realCost = rate ? parseFloat(rate.amount) : NaN;
  if (!isFinite(realCost) || realCost <= 0) return {};
  var charge = customerShippingCharge(realCost, orgData);
  var update = { shippingCost: realCost, shippingChargeAuto: charge };
  // Respect a manual override: only auto-fill the shipping line when the user
  // hasn't set one themselves (or when a prior auto value is being refreshed).
  var manual = parseFloat(order.shipping);
  var manuallySet = order.shippingManual === true;
  var priorAuto = parseFloat(order.shippingChargeAuto);
  var canWrite = !manuallySet && (!(manual > 0) || (isFinite(priorAuto) && Math.abs(manual - priorAuto) < 0.005));
  if (canWrite) update.shipping = charge;
  return update;
}

exports.generateShippingLabel = functions.https.onCall(async function(data, context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  // Rate limit: 60 label requests per user per 10 minutes
  if (!checkRateLimit('label_' + context.auth.uid, 60, 10 * 60 * 1000)) {
    throw new functions.https.HttpsError('resource-exhausted', 'Too many requests. Please wait a moment.');
  }
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
    var orgSettings = { shippingFromAddress: (orgData.settings && orgData.settings.shippingFromAddress) || null, preferredCarrier: (orgData.settings && orgData.settings.preferredCarrier) || 'ups', autoPurchaseLabels: !!rateId, preferredService: '' , autoPurchaseMaxPerBox: orgData.autoPurchaseMaxPerBox};

    if (rateId) {
      var transaction = await purchaseLabel(apiKey, rateId);
      var parcelCount = (order.boxDetails ? Object.keys(order.boxDetails).length : 0) || (order.triwalls ? order.triwalls.length : 0) || 1;

      // Fetch the actual rate details so we can update selectedRate with what was REALLY purchased
      // (not what was auto-picked during initial rate shopping)
      var purchasedRate = null;
      try {
        purchasedRate = await shippoRequest(apiKey, '/rates/' + rateId, 'GET');
      } catch (rateErr) {
        console.warn('Could not fetch purchased rate details:', rateErr.message);
      }

      var newSelectedRate = order.shippingLabel && order.shippingLabel.selectedRate ? order.shippingLabel.selectedRate : {};
      if (purchasedRate) {
        newSelectedRate = {
          object_id: purchasedRate.object_id,
          provider: purchasedRate.provider,
          servicelevel: purchasedRate.servicelevel,
          servicelevelName: (purchasedRate.servicelevel && purchasedRate.servicelevel.name) || (purchasedRate.servicelevel && purchasedRate.servicelevel.token) || '',
          amount: purchasedRate.amount,
          currency: purchasedRate.currency,
          estimatedDays: purchasedRate.estimated_days,
          durationTerms: purchasedRate.duration_terms,
        };
      }

      var result = Object.assign({}, order.shippingLabel || {}, {
        labelUrl: transaction.label_url, trackingNumber: transaction.tracking_number,
        trackingUrl: transaction.tracking_url_provider, transactionId: transaction.object_id,
        labelStatus: transaction.status === 'SUCCESS' ? 'purchased' : 'failed',
        labelError: transaction.status !== 'SUCCESS' ? (transaction.messages || []).map(function(m) { return m.text; }).join('; ') : null,
        purchasedAt: Date.now(), labelPageCount: parcelCount,
        allLabels: (transaction.allLabels && transaction.allLabels.length > 0) ? transaction.allLabels : null,
        selectedRate: newSelectedRate,
      });
      var chargeUpd_a = (result.labelStatus === 'purchased') ? shippingChargeUpdate(order, result, orgData) : {};
      await db.collection('purchaseOrders').doc(orderId).update(Object.assign({ shippingLabel: result, shippingStatus: result.labelStatus, updatedAt: Date.now() }, chargeUpd_a));
      return result;
    }

    var shippingResult = await processPackedOrder(apiKey, order, orgSettings);
    var chargeUpd_b = (shippingResult.labelStatus === 'purchased') ? shippingChargeUpdate(order, shippingResult, orgData) : {};
    await db.collection('purchaseOrders').doc(orderId).update(Object.assign({ shippingLabel: shippingResult, shippingStatus: shippingResult.labelStatus, updatedAt: Date.now() }, chargeUpd_b));
    return shippingResult;
  } catch (error) { console.error('generateShippingLabel error:', error); throw new functions.https.HttpsError('internal', error.message); }
});

exports.batchGenerateLabels = functions.runWith({ timeoutSeconds: 300, memory: '512MB' }).https.onCall(async function(data, context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  var orderIds = data.orderIds, orgId = data.orgId, autoPurchase = data.autoPurchase;
  if (!orderIds || !orderIds.length || !orgId) throw new functions.https.HttpsError('invalid-argument', 'orderIds and orgId required');
  try {
    var orgDoc = await db.collection('organizations').doc(orgId).get();
    if (!orgDoc.exists) throw new functions.https.HttpsError('not-found', 'Org not found');
    var orgData = orgDoc.data(); var apiKey = getOrgShippoKey(orgData);
    if (!apiKey) throw new functions.https.HttpsError('failed-precondition', 'Shippo API key not configured.');
    var orgSettings = { shippingFromAddress: (orgData.settings && orgData.settings.shippingFromAddress) || null, preferredCarrier: (orgData.settings && orgData.settings.preferredCarrier) || 'ups', autoPurchaseLabels: !!autoPurchase, preferredService: '' , autoPurchaseMaxPerBox: orgData.autoPurchaseMaxPerBox};

    var results = { success: [], failed: [], total: orderIds.length };
    for (var i = 0; i < orderIds.length; i++) {
      var oid = orderIds[i];
      try {
        var oDoc = await db.collection('purchaseOrders').doc(oid).get();
        if (!oDoc.exists) { results.failed.push({ orderId: oid, error: 'Not found' }); continue; }
        var o = Object.assign({ id: oDoc.id }, oDoc.data());
        if (o.orgId !== orgId) { results.failed.push({ orderId: oid, error: 'Wrong org' }); continue; }
        // Idempotency guard: never re-buy a label for an order that already has one.
        // Makes a partially-failed batch safe to retry without double charges.
        if (autoPurchase && o.shippingLabel && o.shippingLabel.labelStatus === 'purchased' && o.shippingLabel.trackingNumber) {
          results.success.push({ orderId: oid, poNumber: o.poNumber, labelStatus: 'purchased', trackingNumber: o.shippingLabel.trackingNumber, amount: (o.shippingLabel.selectedRate && o.shippingLabel.selectedRate.amount) || null, carrier: (o.shippingLabel.selectedRate && o.shippingLabel.selectedRate.provider) || null, skipped: true });
          continue;
        }
        var sr = await processPackedOrder(apiKey, o, orgSettings);
        var chargeUpd_batch = (sr.labelStatus === 'purchased') ? shippingChargeUpdate(o, sr, orgData) : {};
        await db.collection('purchaseOrders').doc(oid).update(Object.assign({ shippingLabel: sr, shippingStatus: sr.labelStatus, updatedAt: Date.now() }, chargeUpd_batch));
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
  // Rate limit: 30 rate requests per user per 5 minutes
  if (!checkRateLimit('rates_' + context.auth.uid, 30, 5 * 60 * 1000)) {
    throw new functions.https.HttpsError('resource-exhausted', 'Too many rate requests. Please wait a moment.');
  }
  try {
    var orderDoc = await db.collection('purchaseOrders').doc(data.orderId).get();
    if (!orderDoc.exists) throw new Error('Order not found');
    var order = Object.assign({ id: orderDoc.id }, orderDoc.data());
    var orgDoc = await db.collection('organizations').doc(data.orgId).get();
    var orgData = orgDoc.data(); var apiKey = getOrgShippoKey(orgData);
    if (!apiKey) throw new Error('Shippo API key not configured.');
    var orgSettings = { shippingFromAddress: (orgData.settings && orgData.settings.shippingFromAddress) || null, preferredCarrier: (orgData.settings && orgData.settings.preferredCarrier) || 'ups', autoPurchaseLabels: false, preferredService: '' , autoPurchaseMaxPerBox: orgData.autoPurchaseMaxPerBox};
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


// ═══════════════════════════════════════════════════════════
// STRIPE INTEGRATION
// ═══════════════════════════════════════════════════════════

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Price IDs from environment variables — nested by billing cycle
const PRICE_IDS = {
  starter: {
    monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY,
    annual:  process.env.STRIPE_PRICE_STARTER_ANNUAL,
  },
  pro: {
    monthly: process.env.STRIPE_PRICE_PRO_MONTHLY,
    annual:  process.env.STRIPE_PRICE_PRO_ANNUAL,
  },
  business: {
    monthly: process.env.STRIPE_PRICE_BUSINESS_MONTHLY,
    annual:  process.env.STRIPE_PRICE_BUSINESS_ANNUAL,
  },
  enterprise: {
    monthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY,
    annual:  process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL,
  },
};

// Reverse lookup: price_id -> { plan, billingCycle }
// Built once at module load so the webhook can map a Stripe price back to our plan.
const PRICE_TO_PLAN = {};
for (const [plan, cycles] of Object.entries(PRICE_IDS)) {
  for (const [cycle, id] of Object.entries(cycles)) {
    if (id) PRICE_TO_PLAN[id] = { plan, billingCycle: cycle };
  }
}

// ── Create Stripe Checkout Session ──
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const { plan, orgId, orgName, billingCycle = 'monthly' } = data;

  if (!plan || !orgId) {
    throw new functions.https.HttpsError('invalid-argument', 'plan and orgId required');
  }

  if (!['monthly', 'annual'].includes(billingCycle)) {
    throw new functions.https.HttpsError('invalid-argument', `Invalid billingCycle: ${billingCycle}`);
  }

  const planCycles = PRICE_IDS[plan.toLowerCase()];
  if (!planCycles) {
    throw new functions.https.HttpsError('invalid-argument', `Unknown plan: ${plan}`);
  }
  const priceId = planCycles[billingCycle];
  if (!priceId) {
    throw new functions.https.HttpsError('invalid-argument', `No ${billingCycle} price configured for plan: ${plan}`);
  }

  try {
    // Check if org already has a Stripe customer ID
    const orgRef = db.collection('organizations').doc(orgId);
    const orgDoc = await orgRef.get();
    const orgData = orgDoc.data();
    let customerId = orgData?.stripeCustomerId;

    // Create Stripe customer if doesn't exist
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: context.auth.token.email,
        name: orgName || orgId,
        metadata: {
          orgId,
          firebaseUid: context.auth.uid,
        },
      });
      customerId = customer.id;
      await orgRef.update({ stripeCustomerId: customerId });
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `https://skidsling.com/billing-success?session_id={CHECKOUT_SESSION_ID}&org=${orgId}`,
      cancel_url: `https://skidsling.com/subscription-required`,
      metadata: {
        orgId,
        plan: plan.toLowerCase(),
        billingCycle,
        firebaseUid: context.auth.uid,
      },
      subscription_data: {
        // No Stripe trial — users already get a 14-day free trial in-app
        // before they upgrade. Upgrading means immediate payment.
        metadata: {
          orgId,
          plan: plan.toLowerCase(),
          billingCycle,
        },
      },
      payment_method_collection: 'always',
      allow_promotion_codes: true,
    });

    return { sessionId: session.id, url: session.url };
  } catch (error) {
    console.error('createCheckoutSession error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ── Create Billing Portal Session (manage/cancel subscription) ──
exports.createBillingPortalSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const { orgId } = data;

  try {
    const orgDoc = await db.collection('organizations').doc(orgId).get();
    const customerId = orgDoc.data()?.stripeCustomerId;

    if (!customerId) {
      throw new functions.https.HttpsError('not-found', 'No billing account found');
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: 'https://skidsling.com/settings',
    });

    return { url: session.url };
  } catch (error) {
    console.error('createBillingPortalSession error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ── Stripe Webhook Handler ──
// Receives events from Stripe and updates Firestore
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Stripe event received:', event.type);

  try {
    switch (event.type) {

      // ── Payment succeeded — activate subscription ──
      case 'checkout.session.completed': {
        const session = event.data.object;
        const orgId = session.metadata?.orgId;
        const plan = session.metadata?.plan;
        const billingCycle = session.metadata?.billingCycle || 'monthly';

        if (orgId && plan) {
          await db.collection('organizations').doc(orgId).update({
            plan: plan,
            billingCycle: billingCycle,
            status: 'active',
            stripeSubscriptionId: session.subscription,
            stripeCustomerId: session.customer,
            subscriptionStartedAt: admin.firestore.FieldValue.serverTimestamp(),
            trialEndsAt: null,
          });
          console.log(`Activated ${plan} (${billingCycle}) for org ${orgId}`);
        }
        break;
      }

      // ── Subscription updated (upgrade/downgrade) ──
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const orgSnap = await db.collection('organizations')
          .where('stripeCustomerId', '==', sub.customer)
          .limit(1).get();

        if (!orgSnap.empty) {
          const orgRef = orgSnap.docs[0].ref;
          // Map Stripe price ID back to our { plan, billingCycle }
          const priceId = sub.items.data[0]?.price?.id;
          const mapped = priceId ? PRICE_TO_PLAN[priceId] : null;

          const updateData = {
            stripeSubscriptionId: sub.id,
            status: sub.status === 'active' ? 'active' : sub.status,
          };
          if (mapped) {
            updateData.plan = mapped.plan;
            updateData.billingCycle = mapped.billingCycle;
          }

          await orgRef.update(updateData);
          console.log(`Updated subscription for customer ${sub.customer}`);
        }
        break;
      }

      // ── Subscription cancelled or payment failed ──
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const orgSnap = await db.collection('organizations')
          .where('stripeCustomerId', '==', sub.customer)
          .limit(1).get();

        if (!orgSnap.empty) {
          await orgSnap.docs[0].ref.update({
            plan: 'expired',
            status: 'cancelled',
            stripeSubscriptionId: null,
          });
          console.log(`Cancelled subscription for customer ${sub.customer}`);
        }
        break;
      }

      // ── Payment failed ──
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const orgSnap = await db.collection('organizations')
          .where('stripeCustomerId', '==', invoice.customer)
          .limit(1).get();

        if (!orgSnap.empty) {
          await orgSnap.docs[0].ref.update({
            status: 'past_due',
          });
          console.log(`Payment failed for customer ${invoice.customer}`);
        }
        break;
      }

      // ── Payment recovered ──
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.billing_reason === 'subscription_cycle') {
          const orgSnap = await db.collection('organizations')
            .where('stripeCustomerId', '==', invoice.customer)
            .limit(1).get();

          if (!orgSnap.empty) {
            await orgSnap.docs[0].ref.update({
              status: 'active',
            });
          }
        }
        break;
      }

      default:
        console.log(`Unhandled event: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    res.status(500).send('Webhook handler error');
  }
});


// ═══════════════════════════════════════════════════════════
// SHIPSTATION INTEGRATION
// ShipStation V2 API — api.shipstation.com
// Auth: single API key in header "API-Key: {key}"
// ═══════════════════════════════════════════════════════════

const SS_BASE = 'https://api.shipstation.com';

async function shipstationRequest(apiKey, endpoint, method = 'GET', body = null) {
  if (!apiKey) throw new Error('ShipStation API key not configured. Go to Shipping Settings and enter your ShipStation API key.');
  const options = {
    method,
    headers: {
      'API-Key': apiKey,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${SS_BASE}${endpoint}`, options);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ShipStation API error ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Get ShipStation Rates ──
exports.getShipStationRates = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');

  if (!checkRateLimit('ss_rates_' + context.auth.uid, 30, 5 * 60 * 1000)) {
    throw new functions.https.HttpsError('resource-exhausted', 'Too many rate requests. Please wait a moment.');
  }

  const { orgId, orderId, toAddress, parcels } = data;

  try {
    // Get org's ShipStation API key
    const orgDoc = await db.collection('organizations').doc(orgId).get();
    const apiKey = orgDoc.data()?.settings?.shipstationApiKey;
    if (!apiKey) throw new Error('ShipStation API key not configured');

    const fromAddr = orgDoc.data()?.settings?.shippingFromAddress;
    if (!fromAddr?.street1) throw new Error('Shipping from address not configured');

    // Get all connected carriers
    const carriersRes = await shipstationRequest(apiKey, '/v2/carriers');
    const carriers = carriersRes.carriers || [];

    if (carriers.length === 0) {
      throw new Error('No carriers connected to your ShipStation account. Add carriers in ShipStation Settings.');
    }

    // Get rates for each carrier
    const allRates = [];
    for (const carrier of carriers.slice(0, 5)) { // limit to 5 carriers
      try {
        const shipment = {
          carrier_id: carrier.carrier_id,
          from_country_code: 'US',
          from_postal_code: fromAddr.zip,
          from_city_locality: fromAddr.city,
          from_state_province: fromAddr.state,
          to_country_code: toAddress.country || 'US',
          to_postal_code: toAddress.zip,
          to_city_locality: toAddress.city,
          to_state_province: toAddress.state,
          weight: { value: parcels[0]?.weight || 1, unit: 'pound' },
          dimensions: parcels[0]?.length ? {
            unit: 'inch',
            length: parcels[0].length,
            width: parcels[0].width,
            height: parcels[0].height,
          } : undefined,
        };

        const rateRes = await shipstationRequest(apiKey, '/v2/rates/estimate', 'POST', shipment);
        const rates = rateRes.rate_response?.rates || [];

        rates.forEach(rate => {
          allRates.push({
            provider: 'shipstation',
            rateId: rate.rate_id,
            carrier: rate.carrier_friendly_name || carrier.friendly_name,
            carrierId: rate.carrier_id,
            service: rate.service_type,
            serviceCode: rate.service_code,
            amount: rate.shipping_amount?.amount || 0,
            currency: 'USD',
            estimatedDays: rate.delivery_days,
            deliveryDate: rate.estimated_delivery_date,
          });
        });
      } catch (carrierErr) {
        console.warn(`ShipStation rate error for carrier ${carrier.carrier_id}:`, carrierErr.message);
      }
    }

    allRates.sort((a, b) => a.amount - b.amount);
    return { rates: allRates, provider: 'shipstation' };

  } catch (error) {
    console.error('getShipStationRates error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ── Generate ShipStation Label ──
exports.generateShipStationLabel = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');

  if (!checkRateLimit('ss_label_' + context.auth.uid, 60, 10 * 60 * 1000)) {
    throw new functions.https.HttpsError('resource-exhausted', 'Too many label requests. Please wait a moment.');
  }

  const { orgId, orderId, rateId, toAddress, parcels, orderRef } = data;

  try {
    const orgDoc = await db.collection('organizations').doc(orgId).get();
    const apiKey = orgDoc.data()?.settings?.shipstationApiKey;
    if (!apiKey) throw new Error('ShipStation API key not configured');

    const fromAddr = orgDoc.data()?.settings?.shippingFromAddress;

    // Purchase label using rate ID
    const labelReq = {
      rate_id: rateId,
      validate_address: 'no_validation',
      label_layout: '4x6',
      label_format: 'pdf',
      label_download_type: 'url',
      ship_to: {
        name: toAddress.name,
        company_name: toAddress.company || '',
        address_line1: toAddress.street1,
        address_line2: toAddress.street2 || '',
        city_locality: toAddress.city,
        state_province: toAddress.state,
        postal_code: toAddress.zip,
        country_code: toAddress.country || 'US',
        phone: toAddress.phone || '',
      },
      ship_from: {
        name: fromAddr.name,
        company_name: fromAddr.company || '',
        address_line1: fromAddr.street1,
        city_locality: fromAddr.city,
        state_province: fromAddr.state,
        postal_code: fromAddr.zip,
        country_code: 'US',
        phone: fromAddr.phone || '',
      },
      packages: parcels.map(p => ({
        weight: { value: p.weight || 1, unit: 'pound' },
        dimensions: p.length ? {
          unit: 'inch',
          length: p.length,
          width: p.width,
          height: p.height,
        } : undefined,
      })),
    };

    const label = await shipstationRequest(apiKey, '/v2/labels', 'POST', labelReq);

    // Update order in Firestore
    if (orderId) {
      await db.collection('purchaseOrders').doc(orderId).update({
        shippingLabel: {
          trackingNumber: label.tracking_number,
          labelUrl: label.label_download?.pdf || label.label_download?.href,
          carrier: label.carrier_code,
          service: label.service_code,
          cost: label.shipment_cost?.amount || 0,
          labelId: label.label_id,
          provider: 'shipstation',
          createdAt: Date.now(),
        },
        status: 'shipped',
        updatedAt: Date.now(),
      });
    }

    return {
      success: true,
      trackingNumber: label.tracking_number,
      labelUrl: label.label_download?.pdf || label.label_download?.href,
      labelId: label.label_id,
      carrier: label.carrier_code,
      cost: label.shipment_cost?.amount || 0,
      provider: 'shipstation',
    };

  } catch (error) {
    console.error('generateShipStationLabel error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});


// ═══════════════════════════════════════════════════════════
// EASYPOST INTEGRATION
// EasyPost REST API v2 — api.easypost.com
// Auth: Basic auth, API key as username, empty password
// Flow: Create Shipment (gets rates) → Buy label (gets label URL)
// ═══════════════════════════════════════════════════════════

const EP_BASE = 'https://api.easypost.com/v2';

async function easypostRequest(apiKey, endpoint, method = 'GET', body = null) {
  if (!apiKey) throw new Error('EasyPost API key not configured. Go to Shipping Settings and enter your EasyPost API key.');
  const credentials = Buffer.from(`${apiKey}:`).toString('base64');
  const options = {
    method,
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${EP_BASE}${endpoint}`, options);
  const data = await res.json();
  if (!res.ok) {
    const errMsg = data?.error?.message || data?.error || `EasyPost API error ${res.status}`;
    throw new Error(errMsg);
  }
  return data;
}

// ── Get EasyPost Rates ──
// Creates a shipment on EasyPost to get rates, stores shipment ID for label purchase
exports.getEasyPostRates = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');

  if (!checkRateLimit('ep_rates_' + context.auth.uid, 30, 5 * 60 * 1000)) {
    throw new functions.https.HttpsError('resource-exhausted', 'Too many rate requests. Please wait a moment.');
  }

  const { orgId, orderId, toAddress, parcels } = data;

  try {
    const orgDoc = await db.collection('organizations').doc(orgId).get();
    const apiKey = orgDoc.data()?.settings?.easypostApiKey;
    if (!apiKey) throw new Error('EasyPost API key not configured. Go to Shipping Settings and enter your EasyPost API key.');

    const fromAddr = orgDoc.data()?.settings?.shippingFromAddress;
    if (!fromAddr?.street1) throw new Error('Shipping from address not configured. Go to Shipping Settings.');

    const parcel = parcels && parcels[0] ? parcels[0] : { weight: 1 };

    // Create shipment on EasyPost — returns shipment with rates
    const shipmentPayload = {
      shipment: {
        to_address: {
          name: toAddress.name || toAddress.company || 'Recipient',
          company: toAddress.company || '',
          street1: toAddress.street1,
          street2: toAddress.street2 || '',
          city: toAddress.city,
          state: toAddress.state,
          zip: toAddress.zip,
          country: toAddress.country || 'US',
          phone: toAddress.phone || '',
          email: toAddress.email || '',
          residential: toAddress.residential || false,
        },
        from_address: {
          name: fromAddr.name || fromAddr.company || 'Sender',
          company: fromAddr.company || '',
          street1: fromAddr.street1,
          street2: fromAddr.street2 || '',
          city: fromAddr.city,
          state: fromAddr.state,
          zip: fromAddr.zip,
          country: 'US',
          phone: fromAddr.phone || '',
          email: fromAddr.email || '',
          residential: false,
        },
        parcel: {
          weight: parseFloat(parcel.weight) * 16 || 16, // EasyPost uses oz
          ...(parcel.length && {
            length: parseFloat(parcel.length),
            width: parseFloat(parcel.width),
            height: parseFloat(parcel.height),
          }),
        },
        options: {
          label_format: 'PDF',
          label_size: '4x6',
        },
      },
    };

    const shipment = await easypostRequest(apiKey, '/shipments', 'POST', shipmentPayload);

    if (!shipment.rates || shipment.rates.length === 0) {
      throw new Error('No rates returned from EasyPost. Check your address and package details.');
    }

    // Store the EasyPost shipment ID temporarily so we can buy the label later
    if (orderId) {
      await db.collection('purchaseOrders').doc(orderId).update({
        easypostShipmentId: shipment.id,
        updatedAt: Date.now(),
      });
    }

    // Format rates to match SkidSling's rate format
    const rates = shipment.rates.map(rate => ({
      provider: 'easypost',
      rateId: rate.id,
      shipmentId: shipment.id,
      carrier: rate.carrier,
      service: rate.service,
      serviceCode: rate.service,
      amount: parseFloat(rate.rate),
      listRate: parseFloat(rate.list_rate || rate.rate),
      retailRate: parseFloat(rate.retail_rate || rate.rate),
      currency: rate.currency || 'USD',
      estimatedDays: rate.delivery_days || rate.est_delivery_days,
      deliveryDate: rate.delivery_date,
      billingType: rate.billing_type,
    })).sort((a, b) => a.amount - b.amount);

    return {
      rates,
      shipmentId: shipment.id,
      provider: 'easypost',
      messages: shipment.messages || [],
    };

  } catch (error) {
    console.error('getEasyPostRates error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ── Generate EasyPost Label ──
// Buys the label using the shipment ID and rate ID from getEasyPostRates
exports.generateEasyPostLabel = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');

  if (!checkRateLimit('ep_label_' + context.auth.uid, 60, 10 * 60 * 1000)) {
    throw new functions.https.HttpsError('resource-exhausted', 'Too many label requests. Please wait a moment.');
  }

  const { orgId, orderId, shipmentId, rateId, insuranceAmount } = data;

  try {
    const orgDoc = await db.collection('organizations').doc(orgId).get();
    const apiKey = orgDoc.data()?.settings?.easypostApiKey;
    if (!apiKey) throw new Error('EasyPost API key not configured');

    // Buy the label
    const buyPayload = {
      rate: { id: rateId },
      ...(insuranceAmount && { insurance: String(insuranceAmount) }),
    };

    const purchased = await easypostRequest(apiKey, `/shipments/${shipmentId}/buy`, 'POST', buyPayload);

    const labelUrl = purchased.postage_label?.label_url;
    const labelPdfUrl = purchased.postage_label?.label_pdf_url || labelUrl;
    const trackingCode = purchased.tracking_code;

    if (!labelUrl && !labelPdfUrl) {
      throw new Error('Label generated but URL not returned. Check your EasyPost dashboard.');
    }

    // Update the order in Firestore
    if (orderId) {
      await db.collection('purchaseOrders').doc(orderId).update({
        shippingLabel: {
          trackingNumber: trackingCode,
          labelUrl: labelPdfUrl || labelUrl,
          labelPngUrl: labelUrl,
          carrier: purchased.selected_rate?.carrier || '',
          service: purchased.selected_rate?.service || '',
          cost: parseFloat(purchased.selected_rate?.rate || 0),
          shipmentId: purchased.id,
          rateId: rateId,
          trackerId: purchased.tracker?.id || '',
          provider: 'easypost',
          createdAt: Date.now(),
        },
        status: 'shipped',
        easypostShipmentId: purchased.id,
        updatedAt: Date.now(),
      });
    }

    return {
      success: true,
      trackingNumber: trackingCode,
      labelUrl: labelPdfUrl || labelUrl,
      labelPngUrl: labelUrl,
      shipmentId: purchased.id,
      trackerId: purchased.tracker?.id,
      carrier: purchased.selected_rate?.carrier,
      service: purchased.selected_rate?.service,
      cost: parseFloat(purchased.selected_rate?.rate || 0),
      provider: 'easypost',
    };

  } catch (error) {
    console.error('generateEasyPostLabel error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ── Validate Address via EasyPost ──
exports.validateEasyPostAddress = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');

  const { orgId, address } = data;

  try {
    const orgDoc = await db.collection('organizations').doc(orgId).get();
    const apiKey = orgDoc.data()?.settings?.easypostApiKey;
    if (!apiKey) throw new Error('EasyPost API key not configured');

    const result = await easypostRequest(apiKey, '/addresses', 'POST', {
      address: {
        street1: address.street1,
        street2: address.street2 || '',
        city: address.city,
        state: address.state,
        zip: address.zip,
        country: address.country || 'US',
      },
      verify: ['delivery'],
    });

    return {
      success: result.verifications?.delivery?.success || false,
      errors: result.verifications?.delivery?.errors || [],
      address: {
        street1: result.street1,
        street2: result.street2,
        city: result.city,
        state: result.state,
        zip: result.zip,
        residential: result.residential,
      },
    };
  } catch (error) {
    console.error('validateEasyPostAddress error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});


// ═══════════════════════════════════════════════════════════
// TRIAL LIFECYCLE MANAGEMENT
// Daily scheduled function checks all orgs and:
//   1. Sends day-7 check-in email (trial midway)
//   2. Sends day-11 "trial ends in 3 days" email
//   3. Sends day-13 "last day" email
//   4. Sends day-15+1 "trial ended, data preserved 30 days" email
//   5. After day 45 (15 trial + 30 grace), marks org for deletion
// ═══════════════════════════════════════════════════════════

/**
 * Send a transactional email via Brevo (formerly Sendinblue).
 * Set BREVO_API_KEY in functions/.env to enable. If not set, just logs.
 * Brevo Free tier: 300 emails/day, 9,000/month, no credit card required.
 */
async function sendTrialEmail({ to, subject, html, fromName = 'SkidSling' }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.log(`[email skipped — no BREVO_API_KEY] ${subject} -> ${to}`);
    return { skipped: true };
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: fromName, email: 'info@skidsling.com' },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`Brevo error ${res.status}:`, errText);
      return { success: false, error: errText };
    }
    const result = await res.json();
    return { success: true, id: result.messageId };
  } catch (err) {
    console.error('sendTrialEmail error:', err);
    return { success: false, error: err.message };
  }
}

/** Build the email HTML for a given trial milestone */
function buildTrialEmailHtml(milestone, orgName, daysLeft) {
  const upgradeUrl = 'https://skidsling.com/subscription-required';
  let title, body, ctaText;

  if (milestone === 'day7_checkin') {
    title = `How's your SkidSling trial going?`;
    body = `<p>Hi there,</p>
      <p>You're a week into your SkidSling free trial. We hope you're finding it useful for managing your warehouse operations.</p>
      <p>A few things our customers love most:</p>
      <ul>
        <li><strong>Pick lists & packing</strong> — turn orders into action lists in one click</li>
        <li><strong>Multi-location inventory</strong> — track stock across racks, bays, and shelves</li>
        <li><strong>Shipping integrations</strong> — print labels directly from the order</li>
      </ul>
      <p>If you have questions or want a quick demo, just reply to this email.</p>`;
    ctaText = 'Open SkidSling';
  } else if (milestone === 'day11_warning') {
    title = `Your trial ends in 3 days`;
    body = `<p>Hi there,</p>
      <p>Your SkidSling free trial ends in <strong>3 days</strong>. After your trial ends, you'll lose access to your data unless you upgrade.</p>
      <p>The good news: all your items, orders, customers, and locations are saved and ready when you upgrade. Pick a plan that fits your business below.</p>`;
    ctaText = 'View Plans';
  } else if (milestone === 'day13_lastday') {
    title = `Last day of your free trial`;
    body = `<p>Hi there,</p>
      <p>Today is the last day of your SkidSling free trial. Your account access ends tomorrow.</p>
      <p>To keep using SkidSling and preserve all your data, please choose a plan now. We've held a spot for you.</p>`;
    ctaText = 'Choose a Plan';
  } else if (milestone === 'expired_grace') {
    title = `Your free trial has ended`;
    body = `<p>Hi there,</p>
      <p>Your SkidSling free trial has ended. We've paused your account access, but <strong>your data is safe for the next 30 days</strong>.</p>
      <p>If you choose a plan within 30 days, everything will be exactly as you left it. After 30 days, your data will be permanently deleted.</p>
      <p>You can also export your data to CSV anytime by signing in.</p>`;
    ctaText = 'Reactivate Account';
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;margin:0;padding:0">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
    <div style="background:#0d7a52;padding:24px;text-align:center">
      <h1 style="color:#fff;font-size:24px;margin:0;letter-spacing:0.5px">
        <span style="color:#fff">Skid</span><span style="color:#34d399">Sling</span>
      </h1>
    </div>
    <div style="padding:32px 28px">
      <h2 style="color:#0d1b17;font-size:20px;margin:0 0 16px">${title}${orgName ? ` — ${orgName}` : ''}</h2>
      <div style="color:#555;line-height:1.6;font-size:15px">${body}</div>
      <div style="text-align:center;margin:32px 0 16px">
        <a href="${upgradeUrl}" style="display:inline-block;padding:14px 28px;background:#0d7a52;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px">${ctaText}</a>
      </div>
      <p style="color:#888;font-size:13px;text-align:center;margin:24px 0 0;border-top:1px solid #eee;padding-top:20px">Questions? Reply to this email.<br/>SkidSling · AA Innovation Group LLC</p>
    </div>
  </div>
</body></html>`;
}

/**
 * Daily scheduled trial lifecycle function — runs once per day at 9:00 AM EST.
 * Checks all orgs, sends appropriate emails, marks expired trials.
 */
exports.processTrialLifecycle = functions.pubsub.schedule('0 9 * * *')
  .timeZone('America/New_York')
  .onRun(async (context) => {
    console.log('processTrialLifecycle: starting');
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;

    try {
      // Get all orgs on trial
      const snap = await db.collection('organizations').where('plan', '==', 'trial').get();
      console.log(`Found ${snap.size} trial orgs to process`);

      const stats = { day7: 0, day11: 0, day13: 0, expired: 0, deleted: 0, errors: 0 };

      for (const doc of snap.docs) {
        const org = doc.data();
        const orgId = doc.id;
        if (!org.trialEndsAt || !org.email) continue;

        const trialEnd = new Date(org.trialEndsAt).getTime();
        const trialStart = trialEnd - (14 * ONE_DAY);
        const daysSinceStart = Math.floor((now - trialStart) / ONE_DAY);
        const daysUntilEnd = Math.ceil((trialEnd - now) / ONE_DAY);
        const sentReminders = org.trialEmailsSent || {};

        try {
          // Day 7 check-in
          if (daysSinceStart >= 7 && daysSinceStart < 11 && !sentReminders.day7_checkin) {
            await sendTrialEmail({
              to: org.email,
              subject: `How's your SkidSling trial going?`,
              html: buildTrialEmailHtml('day7_checkin', org.name, daysUntilEnd),
            });
            await doc.ref.update({ 'trialEmailsSent.day7_checkin': now });
            stats.day7++;
          }

          // Day 11 warning (3 days left)
          if (daysSinceStart >= 11 && daysSinceStart < 13 && !sentReminders.day11_warning) {
            await sendTrialEmail({
              to: org.email,
              subject: `Your SkidSling trial ends in 3 days`,
              html: buildTrialEmailHtml('day11_warning', org.name, daysUntilEnd),
            });
            await doc.ref.update({ 'trialEmailsSent.day11_warning': now });
            stats.day11++;
          }

          // Day 13 last-day reminder
          if (daysSinceStart >= 13 && daysSinceStart < 14 && !sentReminders.day13_lastday) {
            await sendTrialEmail({
              to: org.email,
              subject: `Last day of your SkidSling free trial`,
              html: buildTrialEmailHtml('day13_lastday', org.name, daysUntilEnd),
            });
            await doc.ref.update({ 'trialEmailsSent.day13_lastday': now });
            stats.day13++;
          }

          // Trial expired — send "data preserved 30 days" email and mark expired
          if (now > trialEnd && org.status !== 'trial_expired' && !sentReminders.expired_grace) {
            await sendTrialEmail({
              to: org.email,
              subject: `Your SkidSling trial has ended`,
              html: buildTrialEmailHtml('expired_grace', org.name, 0),
            });
            await doc.ref.update({
              status: 'trial_expired',
              trialExpiredAt: now,
              gracePeriodEndsAt: now + (30 * ONE_DAY),
              'trialEmailsSent.expired_grace': now,
            });
            stats.expired++;
          }

          // Grace period ended — schedule for deletion (45 days after trial start)
          if (org.status === 'trial_expired' && org.gracePeriodEndsAt && now > org.gracePeriodEndsAt) {
            await doc.ref.update({
              status: 'pending_deletion',
              pendingDeletionAt: now,
            });
            stats.deleted++;
          }
        } catch (err) {
          console.error(`Error processing org ${orgId}:`, err);
          stats.errors++;
        }
      }

      console.log('processTrialLifecycle complete:', stats);
      return stats;
    } catch (error) {
      console.error('processTrialLifecycle error:', error);
      throw error;
    }
  });

/**
 * Export an org's data to CSV (for trial users wanting to keep their data).
 * Returns multi-tab CSV blobs the frontend can stitch together as a ZIP.
 */
exports.exportOrgData = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  const { orgId } = data;
  if (!orgId) throw new functions.https.HttpsError('invalid-argument', 'orgId required');

  // Verify user is a member of this org
  const memberDoc = await db.collection('orgMembers').doc(`${orgId}_${context.auth.uid}`).get();
  if (!memberDoc.exists) throw new functions.https.HttpsError('permission-denied', 'Not a member of this org');

  const csvEscape = (val) => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const toCSV = (rows, headers) => {
    if (!rows.length) return headers.join(',') + '\n';
    const headerLine = headers.join(',');
    const dataLines = rows.map(row => headers.map(h => csvEscape(row[h])).join(','));
    return [headerLine, ...dataLines].join('\n');
  };

  try {
    const exports_data = {};

    // Items
    const itemsSnap = await db.collection('items').where('orgId', '==', orgId).get();
    const items = itemsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    exports_data.items = toCSV(items, ['id', 'partNumber', 'name', 'category', 'stock', 'price', 'cost', 'weight', 'location', 'lowStockThreshold', 'reorderPoint']);

    // Customers
    const custSnap = await db.collection('customers').where('orgId', '==', orgId).get();
    const customers = custSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    exports_data.customers = toCSV(customers, ['id', 'name', 'contactName', 'email', 'phone', 'address']);

    // Locations
    const locSnap = await db.collection('locations').where('orgId', '==', orgId).get();
    const locations = locSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    exports_data.locations = toCSV(locations, ['id', 'locationCode', 'warehouse', 'rack', 'letter', 'shelf', 'description']);

    // Purchase Orders
    const poSnap = await db.collection('purchaseOrders').where('orgId', '==', orgId).get();
    const orders = poSnap.docs.map(d => {
      const o = d.data();
      return {
        id: d.id,
        poNumber: o.poNumber,
        customerPO: o.customerPO || '',
        customerName: o.customerName,
        status: o.status,
        invoiceDate: o.invoiceDate,
        terms: o.terms,
        subtotal: o.subtotal,
        tax: o.tax,
        shipping: o.shipping,
        credit: o.credit,
        discount: o.discount,
        total: o.total,
        notes: o.notes,
        itemCount: (o.items || []).length,
      };
    });
    exports_data.orders = toCSV(orders, ['id', 'poNumber', 'customerPO', 'customerName', 'status', 'invoiceDate', 'terms', 'subtotal', 'tax', 'shipping', 'credit', 'discount', 'total', 'notes', 'itemCount']);

    return { success: true, csvData: exports_data };
  } catch (error) {
    console.error('exportOrgData error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});


// ═══════════════════════════════════════════════════════════
// WELCOME EMAIL — fires on new organization creation
// ═══════════════════════════════════════════════════════════

/** Welcome email HTML template */
function buildWelcomeEmailHtml(orgName, userName) {
  const dashboardUrl = 'https://skidsling.com/dashboard';
  const loginUrl = 'https://skidsling.com/login';
  const greeting = userName ? `Hi ${userName},` : 'Hi there,';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Welcome to SkidSling</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;margin:0;padding:0">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
    <div style="background:#0d7a52;padding:32px;text-align:center">
      <h1 style="color:#fff;font-size:28px;margin:0;letter-spacing:0.5px">
        <span style="color:#fff">Skid</span><span style="color:#34d399">Sling</span>
      </h1>
      <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px">Warehouse Management That Ships</p>
    </div>
    <div style="padding:36px 32px">
      <h2 style="color:#0d1b17;font-size:22px;margin:0 0 16px">Welcome${orgName ? `, ${orgName}` : ''}! 🎉</h2>
      <div style="color:#444;line-height:1.6;font-size:15px">
        <p>${greeting}</p>
        <p>Thanks for signing up for SkidSling. Your free 14-day trial is now active and includes <strong>full Business-tier access</strong> — no credit card required.</p>

        <h3 style="color:#0d1b17;font-size:16px;margin:28px 0 12px">Get started in 3 steps:</h3>
        <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin-bottom:16px">
          <p style="margin:0 0 4px"><strong>1. Set up your warehouse</strong></p>
          <p style="margin:0;font-size:14px;color:#666">Add your locations (warehouse → rack → bay → shelf)</p>
        </div>
        <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin-bottom:16px">
          <p style="margin:0 0 4px"><strong>2. Add your inventory</strong></p>
          <p style="margin:0;font-size:14px;color:#666">Manually, by CSV import, or by scanning barcodes</p>
        </div>
        <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin-bottom:16px">
          <p style="margin:0 0 4px"><strong>3. Create your first order</strong></p>
          <p style="margin:0;font-size:14px;color:#666">Build pick lists, pack orders, print shipping labels</p>
        </div>

        <h3 style="color:#0d1b17;font-size:16px;margin:28px 0 12px">What's unlocked during your trial:</h3>
        <ul style="color:#555;line-height:1.8;margin:0 0 16px;padding-left:20px">
          <li>Unlimited locations across multiple warehouses</li>
          <li>Up to 2,000 inventory items</li>
          <li>Up to 1,000 orders per month</li>
          <li>Pick lists, packing slips, invoices</li>
          <li>Shipping label generation (Shippo, ShipStation, EasyPost)</li>
          <li>Reports and activity logs</li>
        </ul>
      </div>

      <div style="text-align:center;margin:32px 0 16px">
        <a href="${dashboardUrl}" style="display:inline-block;padding:14px 32px;background:#0d7a52;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px">Open SkidSling →</a>
      </div>

      <div style="background:#f0f9f4;border-left:3px solid #34d399;padding:14px 16px;margin:24px 0;border-radius:4px">
        <p style="margin:0;color:#0d1b17;font-size:14px"><strong>Need help getting set up?</strong><br/>
        Reply to this email and we'll help you out. We typically respond within a few hours.</p>
      </div>

      <p style="color:#888;font-size:13px;text-align:center;margin:24px 0 0;border-top:1px solid #eee;padding-top:20px">
        SkidSling · AA Innovation Group LLC<br/>
        <a href="${loginUrl}" style="color:#34d399;text-decoration:none">Sign in</a> · <a href="https://skidsling.com/terms" style="color:#34d399;text-decoration:none">Terms</a> · <a href="https://skidsling.com/privacy" style="color:#34d399;text-decoration:none">Privacy</a>
      </p>
    </div>
  </div>
</body></html>`;
}

/**
 * Firestore trigger — fires when a new org doc is created.
 * Sends a welcome email to the org's email address.
 */
exports.sendWelcomeEmailOnSignup = functions.firestore
  .document('organizations/{orgId}')
  .onCreate(async (snap, context) => {
    const org = snap.data();
    const orgId = context.params.orgId;

    // Don't send for the owner org
    if (orgId === 'aa-surplus-sales') {
      console.log('Skipping welcome email for owner org');
      return null;
    }

    if (!org.email) {
      console.log(`Skipping welcome email — no email on org ${orgId}`);
      return null;
    }

    // Don't send if already sent (idempotency safeguard)
    if (org.welcomeEmailSentAt) {
      console.log(`Welcome email already sent for ${orgId}`);
      return null;
    }

    try {
      const result = await sendTrialEmail({
        to: org.email,
        subject: `Welcome to SkidSling, ${org.name || 'there'}! Your trial is active`,
        html: buildWelcomeEmailHtml(org.name, org.contactName || org.ownerName),
      });

      // Mark as sent
      await snap.ref.update({
        welcomeEmailSentAt: Date.now(),
        welcomeEmailStatus: result.skipped ? 'skipped_no_api_key' : (result.success ? 'sent' : 'failed'),
      });

      console.log(`Welcome email sent to ${org.email} for org ${orgId}`);
      return result;
    } catch (err) {
      console.error(`sendWelcomeEmailOnSignup error for ${orgId}:`, err);
      await snap.ref.update({
        welcomeEmailStatus: 'error',
        welcomeEmailError: err.message,
      });
      return null;
    }
  });


// ═══════════════════════════════════════════════════════════
// ADMIN: DELETE ORGANIZATION (cascading)
// Owner-only. Deletes the org plus ALL related data across:
//   organizations, orgMembers, items, locations, customers,
//   purchaseOrders, pickLists, receivings, contracts, movements,
//   activityLog, counts, invitations, inviteCodes, quickSales
// Also cancels any active Stripe subscription.
// ═══════════════════════════════════════════════════════════

exports.adminDeleteOrganization = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');

  const { orgId, confirmName } = data;
  if (!orgId) throw new functions.https.HttpsError('invalid-argument', 'orgId required');

  // Verify caller is a member of the owner org (SkidSling admin)
  const callerOwnerMember = await db.collection('orgMembers')
    .doc(`aa-surplus-sales_${context.auth.uid}`).get();
  if (!callerOwnerMember.exists) {
    throw new functions.https.HttpsError('permission-denied', 'Only SkidSling owner users can delete organizations');
  }

  // Hard guard: never delete the owner org itself
  if (orgId === 'aa-surplus-sales') {
    throw new functions.https.HttpsError('permission-denied', 'Cannot delete the owner org');
  }

  // Verify the org exists and the confirm name matches (extra safety)
  const orgDoc = await db.collection('organizations').doc(orgId).get();
  if (!orgDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Organization not found');
  }
  const org = orgDoc.data();
  if (confirmName && org.name && confirmName.trim().toLowerCase() !== org.name.trim().toLowerCase()) {
    throw new functions.https.HttpsError('invalid-argument', `Name confirmation does not match. Expected: ${org.name}`);
  }

  // Cancel Stripe subscription if exists
  let stripeCancelled = false;
  if (org.stripeSubscriptionId) {
    try {
      await stripe.subscriptions.cancel(org.stripeSubscriptionId);
      stripeCancelled = true;
      console.log(`Cancelled Stripe subscription ${org.stripeSubscriptionId} for org ${orgId}`);
    } catch (err) {
      console.warn(`Stripe cancellation warning for ${orgId}:`, err.message);
      // Continue with deletion even if Stripe cancellation fails
    }
  }

  // STEP 1: Capture user IDs of all members BEFORE deleting orgMembers
  // We'll use this to clean up Firebase Auth accounts for users who only belong to this org
  let memberUserIds = [];
  try {
    const memberSnap = await db.collection('orgMembers').where('orgId', '==', orgId).get();
    memberUserIds = memberSnap.docs.map(d => d.data().userId).filter(Boolean);
    console.log(`Found ${memberUserIds.length} members to evaluate for auth cleanup`);
  } catch (err) {
    console.error('Could not load member user IDs:', err);
  }

  // Collections to clean up (everything scoped by orgId)
  const orgScopedCollections = [
    'orgMembers',
    'items',
    'locations',
    'customers',
    'purchaseOrders',
    'pickLists',
    'receivings',
    'contracts',
    'movements',
    'activityLog',
    'counts',
    'invitations',
    'inviteCodes',
    'quickSales',
  ];

  const stats = { stripeCancelled, orgId, deletedDocs: {}, deletedAuthUsers: [], skippedAuthUsers: [] };

  // Helper — delete in batches of 400 (Firestore batch limit is 500)
  async function deleteCollectionByOrgId(collectionName) {
    const snap = await db.collection(collectionName).where('orgId', '==', orgId).get();
    if (snap.empty) return 0;

    let count = 0;
    let batch = db.batch();
    let opsInBatch = 0;

    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      opsInBatch++;
      count++;
      if (opsInBatch >= 400) {
        await batch.commit();
        batch = db.batch();
        opsInBatch = 0;
      }
    }
    if (opsInBatch > 0) await batch.commit();
    return count;
  }

  // Delete from each collection
  for (const coll of orgScopedCollections) {
    try {
      const n = await deleteCollectionByOrgId(coll);
      stats.deletedDocs[coll] = n;
      console.log(`Deleted ${n} docs from ${coll} for org ${orgId}`);
    } catch (err) {
      console.error(`Error deleting from ${coll}:`, err);
      stats.deletedDocs[coll] = `ERROR: ${err.message}`;
    }
  }

  // Finally, delete the org doc itself
  try {
    await db.collection('organizations').doc(orgId).delete();
    stats.orgDocDeleted = true;
    console.log(`Deleted org doc ${orgId}`);
  } catch (err) {
    console.error(`Error deleting org doc ${orgId}:`, err);
    stats.orgDocDeleted = false;
    stats.orgDocError = err.message;
  }

  // STEP 2: Delete Firebase Auth users who belonged ONLY to this org
  // Skip the caller (SkidSling admin) and skip any user that still has membership in another org
  for (const userId of memberUserIds) {
    // Never delete the calling admin's auth account
    if (userId === context.auth.uid) {
      stats.skippedAuthUsers.push({ userId, reason: 'caller (admin)' });
      continue;
    }
    try {
      // Check if user belongs to any OTHER org
      const otherMemberships = await db.collection('orgMembers').where('userId', '==', userId).get();
      if (!otherMemberships.empty) {
        stats.skippedAuthUsers.push({ userId, reason: `still member of ${otherMemberships.size} other org(s)` });
        console.log(`Skipping auth deletion for ${userId} — still in ${otherMemberships.size} other org(s)`);
        continue;
      }
      // No other orgs — delete the auth account
      try {
        await admin.auth().deleteUser(userId);
        stats.deletedAuthUsers.push(userId);
        console.log(`Deleted Firebase Auth user ${userId}`);
      } catch (authErr) {
        // user-not-found is OK (already deleted, never existed)
        if (authErr.code === 'auth/user-not-found') {
          stats.skippedAuthUsers.push({ userId, reason: 'auth user not found (already deleted)' });
        } else {
          console.error(`Auth deletion failed for ${userId}:`, authErr);
          stats.skippedAuthUsers.push({ userId, reason: `error: ${authErr.message}` });
        }
      }
    } catch (err) {
      console.error(`Error checking memberships for ${userId}:`, err);
      stats.skippedAuthUsers.push({ userId, reason: `check error: ${err.message}` });
    }
  }

  // Log the deletion in the OWNER org's activity log (audit trail)
  try {
    await db.collection('activityLog').add({
      orgId: 'aa-surplus-sales',
      action: 'ORG_DELETED',
      userEmail: context.auth.token.email || 'unknown',
      userId: context.auth.uid,
      timestamp: Date.now(),
      details: {
        deletedOrgId: orgId,
        deletedOrgName: org.name,
        deletedOrgEmail: org.email,
        stats,
      },
    });
  } catch (err) {
    console.warn('Could not write audit log:', err);
  }

  return stats;
});

// ════════════════════════════════════════════════════════════════════
// GOOGLE SPEECH-TO-TEXT — voice receiving
// Transcribes a short spoken command. Uses speech adaptation (phrase
// hints) built from the org's own SKUs and item names, which is what
// makes warehouse jargon (MOLLE, MARPAT, FROG, ALICE) recognizable.
// Auth: uses the function's own service account via the metadata server,
// so there are no API keys or service-account JSON files to manage.
// Requires: Speech-to-Text API enabled on the Firebase/GCP project.
// ════════════════════════════════════════════════════════════════════

var _sttTokenCache = { token: null, expires: 0 };

async function getGoogleAccessToken() {
  var now = Date.now();
  if (_sttTokenCache.token && now < _sttTokenCache.expires) return _sttTokenCache.token;
  var res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if (!res.ok) throw new Error('Could not obtain Google access token (' + res.status + ')');
  var json = await res.json();
  _sttTokenCache = {
    token: json.access_token,
    // refresh a minute before actual expiry
    expires: now + (Math.max(60, (json.expires_in || 3600) - 60) * 1000)
  };
  return json.access_token;
}

exports.transcribeVoice = functions
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .https.onCall(async function (data, context) {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    // Generous but bounded: 150 commands per user per 5 minutes
    if (!checkRateLimit('stt_' + context.auth.uid, 150, 5 * 60 * 1000)) {
      throw new functions.https.HttpsError('resource-exhausted', 'Too many voice requests. Please wait a moment.');
    }

    var audioBase64 = data && data.audioBase64;
    if (!audioBase64) {
      throw new functions.https.HttpsError('invalid-argument', 'No audio provided');
    }

    // Phrase hints: cap length/count to stay inside Speech API limits
    var phrases = Array.isArray(data.phrases) ? data.phrases : [];
    phrases = phrases
      .filter(function (p) { return typeof p === 'string' && p.trim().length > 0; })
      .map(function (p) { return p.trim().slice(0, 100); });
    if (phrases.length > 2000) phrases = phrases.slice(0, 2000);

    var config = {
      languageCode: 'en-US',
      // standard (cheapest) model, tuned for short commands rather than dictation
      model: 'command_and_search',
      maxAlternatives: 1,
      profanityFilter: false,
      enableAutomaticPunctuation: false,
      encoding: data.encoding || 'WEBM_OPUS'
    };
    // For WEBM_OPUS the sample rate is read from the container header —
    // sending a mismatched value causes errors, so only set it when given.
    if (data.sampleRateHertz && config.encoding !== 'WEBM_OPUS') {
      config.sampleRateHertz = data.sampleRateHertz;
    }
    if (phrases.length > 0) {
      config.speechContexts = [{ phrases: phrases, boost: 18 }];
    }

    try {
      var token = await getGoogleAccessToken();
      var resp = await fetch('https://speech.googleapis.com/v1/speech:recognize', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ config: config, audio: { content: audioBase64 } })
      });

      var json = await resp.json();
      if (!resp.ok) {
        var msg = (json && json.error && json.error.message) || ('Speech API error ' + resp.status);
        console.warn('transcribeVoice error:', msg);
        throw new functions.https.HttpsError('internal', msg);
      }

      var results = json.results || [];
      var transcript = results
        .map(function (r) {
          return (r.alternatives && r.alternatives[0] && r.alternatives[0].transcript) || '';
        })
        .join(' ')
        .trim();
      var confidence =
        (results[0] && results[0].alternatives && results[0].alternatives[0] &&
          results[0].alternatives[0].confidence) || null;

      return { transcript: transcript, confidence: confidence };
    } catch (error) {
      if (error instanceof functions.https.HttpsError) throw error;
      throw new functions.https.HttpsError('internal', error.message || 'Transcription failed');
    }
  });

// ════════════════════════════════════════════════════════════════════
// RECEIPT OCR — reads a photographed receipt / invoice / bill and
// returns the fields to pre-fill an expense with.
// Uses Document AI's receipt parser when a processor is configured
// (best accuracy on crumpled thermal receipts); otherwise falls back to
// Cloud Vision text detection with parsing rules.
// Auth: the function's own service account — no keys to manage.
// ════════════════════════════════════════════════════════════════════

function _money(str) {
  if (!str) return null;
  var m = String(str).replace(/[, ]/g, '').match(/-?\d+(\.\d{1,2})?/);
  return m ? parseFloat(m[0]) : null;
}

// Pull the likely total, tax, date and vendor out of raw OCR text.
// Money is only taken from $-amounts or 2-decimal figures, so "9.20 hrs"
// can never be mistaken for a dollar total.
function _amountsIn(line) {
  var out = [];
  var re = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+\.\d{2})|(?:^|\s)(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})(?=\s|$)/g;
  var m;
  while ((m = re.exec(line)) !== null) {
    var v = parseFloat(String(m[1] || m[2]).replace(/,/g, ''));
    if (!isNaN(v)) out.push(v);
  }
  return out;
}

// Find an explicit "amount due / balance due" figure. This is what the customer
// actually owes, and it beats a billed total whenever both are present.
function _amountDue(text) {
  if (!text) return null;
  var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  var label = /(total\s+amount\s+due|amount\s+due|balance\s+due|total\s+due|please\s+pay|pay\s+this\s+amount)/i;
  var neg = /\(\s*\$?\s?[\d,]+\.\d{2}\s*\)/;
  var hits = [];
  for (var i = 0; i < lines.length; i++) {
    if (!label.test(lines[i]) || neg.test(lines[i])) continue;
    var here = _amountsIn(lines[i]);
    if (here.length) { hits.push(here[here.length - 1]); continue; }
    // amount may sit on the next line or two (two-column layouts)
    for (var k = 1; k <= 2 && i + k < lines.length; k++) {
      var nxt = lines[i + k];
      if (neg.test(nxt) || /discount|credit|less\s*:/i.test(nxt)) continue;
      var a = _amountsIn(nxt);
      if (a.length && nxt.replace(/[^A-Za-z]/g, '').length <= 3) { hits.push(a[a.length - 1]); break; }
    }
  }
  return hits.length ? hits[hits.length - 1] : null;
}

function parseReceiptText(text) {
  var out = { vendor: '', date: '', total: null, tax: null };
  if (!text) return out;
  var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);

  // Vendor: first meaningful line at the top
  for (var i = 0; i < Math.min(lines.length, 6); i++) {
    var l0 = lines[i];
    if (/[A-Za-z]{3}/.test(l0) && !/^\d/.test(l0) &&
        !/receipt|invoice|order|tel|phone|www\.|@|store\s*#/i.test(l0)) {
      out.vendor = l0.replace(/[^\w &'.,-]/g, '').trim().slice(0, 60);
      break;
    }
  }

  var skip = /sub\s*total|subtotal|\btax\b|\bhrs?\b|hours|discount|less\s*:|credit|adjustment/i;
  // A figure in parentheses is a negative (discount/credit) — never a total.
  var isNegative = function (l) { return /\(\s*\$?\s?[\d,]+\.\d{2}\s*\)/.test(l); };

  // Find the amount for a label line. Two-column invoices put the figure on a
  // LATER line than its label, so look ahead a couple of lines if needed.
  function amountFor(idx) {
    if (isNegative(lines[idx])) return null;
    var here = _amountsIn(lines[idx]);
    if (here.length) return here[here.length - 1];
    for (var k = 1; k <= 2 && idx + k < lines.length; k++) {
      var nxt = lines[idx + k];
      if (skip.test(nxt) || isNegative(nxt)) continue;   // skip discounts/credits
      var a = _amountsIn(nxt);
      // a bare amount line (mostly just the number) belongs to the label above
      if (a.length && nxt.replace(/[^A-Za-z]/g, '').length <= 3) return a[a.length - 1];
    }
    return null;
  }

  // Priority tiers — "amount due" beats a generic "Total" line.
  var tiers = [
    /(total\s+amount\s+due|amount\s+due|balance\s+due|total\s+due|grand\s+total|new\s+charges)/i,
    /\btotal\b/i
  ];
  for (var t = 0; t < tiers.length && out.total == null; t++) {
    var hits = [];
    for (var j = 0; j < lines.length; j++) {
      if (!tiers[t].test(lines[j])) continue;
      if (skip.test(lines[j])) continue;
      var v = amountFor(j);
      if (v != null) hits.push(v);
    }
    if (hits.length) out.total = hits[hits.length - 1];
  }

  if (out.total == null) {
    var all = [];
    lines.forEach(function (l) { if (!isNegative(l)) all = all.concat(_amountsIn(l)); });
    if (all.length) out.total = Math.max.apply(null, all);
  }

  // Tax
  for (var q = 0; q < lines.length; q++) {
    if (/\btax\b/i.test(lines[q]) && !/tax\s*id|taxable/i.test(lines[q])) {
      var tv = amountFor(q);
      if (tv != null && (out.tax == null || tv > out.tax)) out.tax = tv;
    }
  }

  // ---- Date ----
  // Prefer a date in the header (top ~12 lines) — line-item dates further down
  // are transaction dates, not the invoice date.
  var MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  function findDate(chunk) {
    var m = chunk.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(20\d{2})\b/);
    if (m) {
      var mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (mo) return m[3] + '-' + ('0' + mo).slice(-2) + '-' + ('0' + m[2]).slice(-2);
    }
    m = chunk.match(/\b(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})\b/);
    if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    m = chunk.match(/\b(\d{1,2})[-\/](\d{1,2})[-\/](20\d{2}|\d{2})\b/);
    if (m) {
      var yr = m[3].length === 2 ? '20' + m[3] : m[3];
      return yr + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
    }
    return '';
  }
  out.date = findDate(lines.slice(0, 12).join('\n')) || findDate(text);

  return out;
}

exports.parseReceipt = functions
  .runWith({ timeoutSeconds: 60, memory: '512MB' })
  .https.onCall(async function (data, context) {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    if (!checkRateLimit('ocr_' + context.auth.uid, 60, 10 * 60 * 1000)) {
      throw new functions.https.HttpsError('resource-exhausted', 'Too many receipt scans. Please wait a moment.');
    }
    var b64 = data && data.imageBase64;
    if (!b64) throw new functions.https.HttpsError('invalid-argument', 'No image provided');
    var mime = (data && data.mimeType) || 'image/jpeg';

    var token = await getGoogleAccessToken();
    // Read the Document AI setting from either the legacy config or env vars.
    var cfgAll = {};
    try { cfgAll = (functions.config && functions.config()) || {}; } catch (e) { cfgAll = {}; }
    var cfg = cfgAll.docai || {};
    // Fallback to environment variables (works on newer SDKs where
    // functions.config() returns nothing).
    var procId = cfg.processor || process.env.DOCAI_PROCESSOR || '';
    var procLoc = cfg.location || process.env.DOCAI_LOCATION || 'us';
    var projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;

    console.log('parseReceipt: docai configured =', !!procId,
                '| processor =', procId ? procId.slice(0, 6) + '…' : '(none)',
                '| location =', procLoc,
                '| config keys =', Object.keys(cfgAll).join(',') || '(empty)');

    // ---------- Preferred: Document AI receipt/invoice processor ----------
    if (procId) {
      try {
        var url = 'https://' + procLoc + '-documentai.googleapis.com/v1/projects/' +
          projectId + '/locations/' + procLoc + '/processors/' + procId + ':process';
        console.log('parseReceipt: calling Document AI ->', url);
        var r = await fetch(url, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ rawDocument: { content: b64, mimeType: mime } })
        });
        var j = await r.json();
        if (r.ok && j.document) {
          var fields = {};
          (j.document.entities || []).forEach(function (e) {
            var val = (e.normalizedValue && e.normalizedValue.text) ? e.normalizedValue.text : e.mentionText;
            // keep the first occurrence of each type (Doc AI can repeat them)
            if (fields[e.type] === undefined) fields[e.type] = val;
          });
          var docText = j.document.text || '';
          var parsed = parseReceiptText(docText);

          // ---- Choose the amount the customer actually owes ----------------
          // Document AI's total_amount is the billed total, which on invoices
          // carrying a discount/credit is NOT what's due. An explicit
          // "amount due / balance due" line always wins when one exists.
          var dueFromText = _amountDue(docText);
          var docTotal = _money(fields.total_amount);
          var netTotal = _money(fields.net_amount);
          var chosen = null, why = '';

          if (dueFromText != null) { chosen = dueFromText; why = 'text:amount-due'; }
          else if (docTotal != null && netTotal != null && netTotal < docTotal) {
            // a net lower than the total implies a credit was applied
            chosen = netTotal; why = 'docai:net_amount';
          }
          else if (docTotal != null) { chosen = docTotal; why = 'docai:total_amount'; }
          else if (parsed.total != null) { chosen = parsed.total; why = 'text:parsed'; }

          console.log('parseReceipt: amount chosen =', chosen, 'via', why,
                      '| docai total_amount =', docTotal, '| net_amount =', netTotal,
                      '| text amount-due =', dueFromText);

          return {
            engine: 'documentai',
            vendor: fields.supplier_name || parsed.vendor || '',
            date: fields.receipt_date || fields.invoice_date || parsed.date || '',
            total: chosen,
            tax: _money(fields.total_tax_amount) != null ? _money(fields.total_tax_amount) : parsed.tax,
            reference: fields.invoice_id || fields.receipt_id || '',
            amountSource: why,
            text: docText.slice(0, 4000)
          };
        }
        console.warn('Document AI HTTP', r.status, '- falling back to Vision:', JSON.stringify(j.error || {}).slice(0, 500));
      } catch (e) {
        console.warn('Document AI error, falling back to Vision:', e.message);
      }
    }

    // ---------- Fallback: Cloud Vision text detection ----------
    // PDFs must go to files:annotate — images:annotate only accepts images,
    // which is why PDF invoices previously came back with no text at all.
    var text = '';
    if (mime === 'application/pdf' || mime === 'image/tiff') {
      var fr = await fetch('https://vision.googleapis.com/v1/files:annotate', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            inputConfig: { content: b64, mimeType: mime },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            pages: [1, 2, 3, 4, 5]
          }]
        })
      });
      var fj = await fr.json();
      if (!fr.ok) {
        var fmsg = (fj && fj.error && fj.error.message) || ('Vision file API error ' + fr.status);
        throw new functions.https.HttpsError('internal', fmsg);
      }
      var pages = (fj.responses && fj.responses[0] && fj.responses[0].responses) || [];
      text = pages.map(function (pg) {
        return (pg.fullTextAnnotation && pg.fullTextAnnotation.text) || '';
      }).join('\n');
    } else {
      var vr = await fetch('https://vision.googleapis.com/v1/images:annotate', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{ image: { content: b64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }]
        })
      });
      var vj = await vr.json();
      if (!vr.ok) {
        var msg = (vj && vj.error && vj.error.message) || ('Vision API error ' + vr.status);
        throw new functions.https.HttpsError('internal', msg);
      }
      var ann = (vj.responses && vj.responses[0]) || {};
      text = (ann.fullTextAnnotation && ann.fullTextAnnotation.text) || '';
    }

    var p = parseReceiptText(text);
    return { engine: 'vision', vendor: p.vendor, date: p.date, total: p.total, tax: p.tax, reference: '', text: text.slice(0, 4000) };
  });

// ════════════════════════════════════════════════════════════════════
// PUBLIC API — lets a subscriber's own agent read and write their data.
//
// SECURITY MODEL (the part that matters):
//   • Auth is an API key sent as `Authorization: Bearer sk_...`.
//   • Only the SHA-256 hash of a key is stored, so a DB leak isn't replayable.
//   • The org id is derived FROM THE KEY and never read from the request.
//     Every query is scoped to that org, so one tenant can't reach another's
//     data even by guessing document ids.
//   • Read keys (sk_ro_) cannot write. Write access is checked per route.
//   • Rate limited per key.
// ════════════════════════════════════════════════════════════════════

var crypto = require('crypto');
var INV = require('./inventory');
var ORD = require('./orders');
var PDF = require('./pdf');

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Resolve a bearer token to its org. Returns null if unknown or revoked.
async function resolveApiKey(authHeader) {
  if (!authHeader || authHeader.indexOf('Bearer ') !== 0) return null;
  var raw = authHeader.slice(7).trim();
  if (!raw) return null;

  var snap = await db.collection('apiKeys')
    .where('keyHash', '==', sha256Hex(raw))
    .limit(1).get();
  if (snap.empty) return null;

  var docSnap = snap.docs[0];
  var data = docSnap.data();
  if (data.revoked) return null;

  // Fire-and-forget usage stamp; never block the request on it.
  docSnap.ref.update({
    lastUsedAt: Date.now(),
    callCount: (data.callCount || 0) + 1
  }).catch(function () {});

  return { orgId: data.orgId, scope: data.scope || 'read', keyId: docSnap.id, label: data.label };
}

function apiError(res, code, message) {
  return res.status(code).json({ error: message });
}

// Only the fields an agent has any business seeing.
function publicItem(id, d) {
  return {
    id: id,
    sku: d.partNumber || '',
    name: d.name || '',
    grade: d.grade || '',
    category: d.category || '',
    quantity: parseInt(d.stock) || 0,
    price: parseFloat(d.price) || 0,
    location: d.location || '',
    locations: Array.isArray(d.locations) ? d.locations : [],
    lowStockThreshold: parseInt(d.lowStockThreshold) || 0,
    updatedAt: d.updatedAt || null
  };
}

exports.api = functions
  .runWith({ timeoutSeconds: 120, memory: '1GB' })
  .https.onRequest(async function (req, res) {
    // CORS — agents often call from a browser context.
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).send('');

    var auth;
    try {
      auth = await resolveApiKey(req.get('Authorization'));
    } catch (e) {
      console.error('API key lookup failed:', e.message);
      return apiError(res, 500, 'Authentication failed');
    }
    if (!auth) return apiError(res, 401, 'Invalid or missing API key');

    if (!checkRateLimit('api_' + auth.keyId, 300, 60 * 1000)) {
      return apiError(res, 429, 'Rate limit exceeded — 300 requests per minute');
    }

    // Route: everything after /api
    var path = (req.path || '/').replace(/\/+$/, '') || '/';
    var needsWrite = req.method === 'POST' || req.method === 'PATCH';
    if (needsWrite && auth.scope !== 'write') {
      return apiError(res, 403, 'This key is read-only');
    }

    try {
      // ---- GET /items ---------------------------------------------------
      // Cost: Firestore has no full-text index, so a free-text `search` is the
      // one query that must read the collection. Everything else is served by
      // an indexed query that reads only what it returns — pick the narrowest
      // one available, then apply any remaining filters to that small set.
      if (req.method === 'GET' && (path === '/' || path === '/items')) {
        var limitN = Math.min(parseInt(req.query.limit) || 100, 500);
        var offsetN = Math.max(parseInt(req.query.offset) || 0, 0);
        var search = (req.query.search || '').toLowerCase().trim();
        var wantLoc = req.query.location ? INV.canonicalLocationCode(String(req.query.location)) : '';
        var wantLow = req.query.lowStock === 'true';
        var base = db.collection('items').where('orgId', '==', auth.orgId);
        var items, scanned, counted = true;

        if (req.query.sku) {
          // Exact SKU — indexed, reads only the matching documents.
          var skuSnap = await base.where('partNumber', '==', String(req.query.sku).trim()).get();
          items = skuSnap.docs.map(function (d) { return publicItem(d.id, d.data()); });
          scanned = skuSnap.size;

        } else if (wantLoc) {
          // locationCodes mirrors EVERY shelf an item holds stock on, so this
          // single indexed query is both cheap and complete. Querying the
          // primary `location` field instead would silently miss an item whose
          // largest holding is elsewhere but which still has stock here.
          var locSnap = await base.where('locationCodes', 'array-contains', wantLoc).get();
          items = locSnap.docs.map(function (d) { return publicItem(d.id, d.data()); });
          scanned = locSnap.size;

        } else if (wantLow) {
          // Only items with a threshold can ever be "low", and that field is
          // indexable — so read those, not all 2,000.
          var thrSnap = await base.where('lowStockThreshold', '>', 0).get();
          items = thrSnap.docs.map(function (d) { return publicItem(d.id, d.data()); });
          scanned = thrSnap.size;

        } else if (!search) {
          // Unfiltered listing — let Firestore cap the read.
          var pageSnap = await base.limit(offsetN + limitN).get();
          items = pageSnap.docs.map(function (d) { return publicItem(d.id, d.data()); });
          scanned = pageSnap.size;
          counted = false;   // the catalogue was never fully read

        } else {
          // Free-text only — no index can help.
          var fullSnap = await base.get();
          scanned = fullSnap.size;
          items = fullSnap.docs.map(function (d) { return publicItem(d.id, d.data()); });
        }

        // Remaining filters, applied to whatever the cheapest query returned.
        if (search) {
          var tokens = search.split(/[^a-z0-9#]+/).filter(Boolean);
          items = items.filter(function (it) {
            var hay = (it.sku + ' ' + it.name + ' ' + it.grade + ' ' + it.category).toLowerCase();
            return tokens.every(function (t) { return hay.indexOf(t) !== -1; });
          });
        }
        if (wantLoc) {
          items = items.filter(function (it) {
            return (it.location || '').toUpperCase() === wantLoc ||
              (it.locations || []).some(function (e) {
                return INV.canonicalLocationCode(e.code || '') === wantLoc;
              });
          });
        }
        if (wantLow) {
          items = items.filter(function (it) {
            return it.lowStockThreshold > 0 && it.quantity <= it.lowStockThreshold;
          });
        }

        var matched = items.length;
        var page = items.slice(offsetN, offsetN + limitN);
        return res.json({
          count: page.length,                       // how many are in THIS response
          total: counted ? matched : null,          // null = not counted, don't report it as a catalogue total
          offset: offsetN,
          truncated: counted ? (matched > offsetN + page.length) : (scanned >= offsetN + limitN),
          documentsRead: scanned,                   // so a caller can see what a query costs
          note: wantLow
            ? 'Only items with a reorder threshold set can appear here; items with no threshold are invisible to this filter.'
            : undefined,
          items: page
        });
      }

      // ---- GET /items/:id -----------------------------------------------
      var mItem = path.match(/^\/items\/([A-Za-z0-9_-]+)$/);
      if (req.method === 'GET' && mItem) {
        var docRef = await db.collection('items').doc(mItem[1]).get();
        if (!docRef.exists) return apiError(res, 404, 'Item not found');
        var dd = docRef.data();
        // Never leak another org's document, even with a valid id.
        if (dd.orgId !== auth.orgId) return apiError(res, 404, 'Item not found');
        return res.json(publicItem(docRef.id, dd));
      }

      // ---- GET /locations -------------------------------------------------
      if (req.method === 'GET' && path === '/locations') {
        var lsnap = await db.collection('locations').where('orgId', '==', auth.orgId).get();
        var isnap = await db.collection('items').where('orgId', '==', auth.orgId).get();

        var totals = {};
        isnap.docs.forEach(function (d) {
          var it = d.data();
          var entries = Array.isArray(it.locations) ? it.locations : [];
          entries.forEach(function (e) {
            var c = String(e.code || '').toUpperCase();
            var q = parseInt(e.qty) || 0;
            if (!c || q <= 0) return;
            if (!totals[c]) totals[c] = { total: 0, items: 0 };
            totals[c].total += q;
            totals[c].items += 1;
          });
        });

        var locs = lsnap.docs.map(function (d) {
          var l = d.data();
          var code = (l.locationCode || '').toUpperCase();
          var t = totals[code] || { total: 0, items: 0 };
          return {
            id: d.id, code: l.locationCode || '', warehouse: l.warehouse || '',
            rack: l.rack || '', bay: l.letter || '', shelf: l.shelf || '',
            totalUnits: t.total, itemCount: t.items
          };
        });
        return res.json({ count: locs.length, locations: locs });
      }

      // ---- GET /orders ----------------------------------------------------
      if (req.method === 'GET' && path === '/orders') {
        var limitO = Math.min(parseInt(req.query.limit) || 50, 200);
        var osnap = await db.collection('purchaseOrders').where('orgId', '==', auth.orgId).get();
        var orders = osnap.docs.map(function (d) {
          var o = d.data();
          return {
            id: d.id, orderNumber: o.poNumber || '', customerPO: o.customerPO || '',
            customer: o.customerName || '', status: o.status || '',
            createdAt: o.createdAt || null, total: parseFloat(o.total) || 0,
            itemCount: (o.items || []).length
          };
        });
        if (req.query.status) {
          orders = orders.filter(function (o) { return o.status === req.query.status; });
        }
        orders.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        return res.json({ count: orders.length, orders: orders.slice(0, limitO) });
      }

      // ---- POST /items/:id/adjust  { delta | quantity, location, reason } --
      // The shelf quantities are the source of truth; `stock` and `location`
      // are derived from them on every write. Writing `stock` on its own (what
      // this route used to do) is what left items reading 0 while their shelves
      // still held units.
      var mAdj = path.match(/^\/items\/([A-Za-z0-9_-]+)\/adjust$/);
      if (req.method === 'POST' && mAdj) {
        var ref = db.collection('items').doc(mAdj[1]);
        var cur = await ref.get();
        if (!cur.exists) return apiError(res, 404, 'Item not found');
        var c = cur.data();
        if (c.orgId !== auth.orgId) return apiError(res, 404, 'Item not found');

        var body = req.body || {};
        var beforeStock = parseInt(c.stock) || 0;
        var beforeShelves = INV.itemLocations(c);

        var plan;
        try {
          plan = INV.applyAdjustment(c, { delta: body.delta, quantity: body.quantity, location: body.location });
        } catch (e) {
          return apiError(res, 400, e.message);
        }

        await INV.writeItemLocations(db, ref.id, plan.derived.locations);
        await db.collection('activityLog').add({
          orgId: auth.orgId, action: 'ITEM_UPDATED',
          details: {
            itemId: ref.id,
            updates: { stock: plan.derived.stock, location: plan.derived.location, locations: plan.derived.locations },
            before: { stock: beforeStock, locations: beforeShelves },
            shelf: plan.shelf, shelfBefore: plan.shelfBefore, shelfAfter: plan.shelfAfter,
            source: 'api', apiKey: auth.label, reason: body.reason || ''
          },
          userEmail: 'API: ' + (auth.label || auth.keyId),
          timestamp: Date.now(), createdAt: new Date().toISOString()
        });

        return res.json({
          id: ref.id,
          sku: c.partNumber || '', name: c.name || '', grade: c.grade || '',
          shelf: plan.shelf, shelfPreviousQuantity: plan.shelfBefore, shelfQuantity: plan.shelfAfter,
          createdShelf: plan.createdShelf, clearedShelf: plan.clearedShelf,
          previousQuantity: beforeStock, quantity: plan.derived.stock,
          primaryLocation: plan.derived.location,
          locations: plan.derived.locations,
          reason: body.reason || ''
        });
      }

      // ---- GET /customers -------------------------------------------------
      // Needed to attach an order to an existing customer record rather than
      // creating a near-duplicate. `search` matches name, contact or email.
      if (req.method === 'GET' && path === '/customers') {
        var csnap = await db.collection('customers').where('orgId', '==', auth.orgId).get();
        // The customers collection stores the business as `company` and the
        // contact person as `customerName` - there is no `name` field. This
        // mirrors selectCustomerForPO() in PurchaseOrders.jsx exactly, so an
        // order built from here matches one built by hand in the app.
        var custs = csnap.docs.map(function (d) {
          var c = d.data();
          return {
            id: d.id,
            company: c.company || '',
            contactName: c.customerName || '',
            orderCustomerName: c.company || c.customerName || '',
            orderCustomerContact: c.company ? (c.customerName || '') : '',
            email: c.email || '', phone: c.phone || '',
            address: [c.address, c.city, c.state, c.zipCode].filter(Boolean).join(', '),
            upsAccount: c.upsAccount || '', fedexAccount: c.fedexAccount || '',
            notes: c.notes || ''
          };
        });
        var cq = (req.query.search || '').toLowerCase().trim();
        if (cq) {
          var ctok = cq.split(/[^a-z0-9@.]+/).filter(Boolean);
          custs = custs.filter(function (c) {
            var hay = (c.company + ' ' + c.contactName + ' ' + c.email).toLowerCase();
            return ctok.every(function (t) { return hay.indexOf(t) !== -1; });
          });
        }
        var climit = Math.min(parseInt(req.query.limit) || 50, 200);
        return res.json({ count: Math.min(custs.length, climit), total: custs.length,
                          documentsRead: csnap.size, customers: custs.slice(0, climit) });
      }

      // ---- POST /orders ---------------------------------------------------
      // Creates a purchase order as a DRAFT and nothing further. The logic
      // lives in ./orders.js so the MCP tool and this route cannot drift.
      if (req.method === 'POST' && path === '/orders') {
        var built;
        try {
          built = await ORD.createDraftOrder(db, auth, req.body || {});
        } catch (e) {
          return apiError(res, e.statusCode || 400, e.message);
        }
        return res.json(built);
      }

      // ---- PATCH/POST /orders/:id  (revise a draft) ------------------------
      var mUpd = path.match(/^\/orders\/([A-Za-z0-9_-]+)$/);
      if ((req.method === 'PATCH' || req.method === 'POST') && mUpd) {
        var upd;
        try {
          upd = await ORD.updateDraftOrder(db, auth, mUpd[1], req.body || {});
        } catch (e) {
          return apiError(res, e.statusCode || 400, e.message);
        }
        return res.json(upd);
      }

      // ---- GET /orders/:id  and  /orders/:id/document ----------------------
      // The document route renders the SAME template the Purchase Orders screen
      // prints (functions/orderDocument.mjs), so an emailed estimate or invoice
      // is byte-for-byte what comes out of the UI.
      var mOrd = path.match(/^\/orders\/([A-Za-z0-9_-]+)(\/document)?$/);
      if (req.method === 'GET' && mOrd) {
        var odoc = await db.collection('purchaseOrders').doc(mOrd[1]).get();
        if (!odoc.exists) return apiError(res, 404, 'Order not found');
        var od = odoc.data();
        if (od.orgId !== auth.orgId) return apiError(res, 404, 'Order not found');
        var order = Object.assign({ id: odoc.id }, od);

        if (!mOrd[2]) {
          return res.json({ order: order, documentsRead: 1 });
        }

        var dtype = req.query.type === 'invoice' ? 'invoice' : 'estimate';

        // Grade can be blank on a line written before grades were captured; the
        // template falls back to the catalogue row, so fetch just those items.
        var ids = (order.items || []).map(function (l) { return l.itemId; })
          .filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });
        var lineItems = [];
        for (var ii = 0; ii < ids.length; ii++) {
          var isnap2 = await db.collection('items').doc(ids[ii]).get();
          if (isnap2.exists && isnap2.data().orgId === auth.orgId) {
            lineItems.push(Object.assign({ id: isnap2.id }, isnap2.data()));
          }
        }

        var orgSnap = await db.collection('organizations').doc(auth.orgId).get();
        var orgData = orgSnap.exists ? orgSnap.data() : {};

        var DOC = await import('./orderDocument.mjs');
        var html = DOC.renderOrderDocument(order, dtype, {
          items: lineItems,
          organization: orgData,
          branding: DOC.brandingHtml
        });

        var payload = {
          poNumber: order.poNumber || '', status: order.status || '', type: dtype,
          customerName: order.customerName || '', customerEmail: order.customerEmail || '',
          customerContact: order.customerContact || '',
          documentsRead: 2 + lineItems.length
        };

        // ?format=pdf renders the same HTML through headless Chrome, so the
        // attachment matches what the print button produces.
        if (req.query.format === 'pdf') {
          var pdfBuf = await PDF.htmlToPdf(html);
          payload.filename = (dtype === 'invoice' ? 'Invoice-' : 'Estimate-') + (order.poNumber || 'order') + '.pdf';
          payload.mimeType = 'application/pdf';
          payload.bytes = pdfBuf.length;
          payload.pdfBase64 = pdfBuf.toString('base64');
          return res.json(payload);
        }

        payload.html = html;
        return res.json(payload);
      }

      // ---- POST /maintenance/backfill-location-codes ----------------------
      // One-time (idempotent) migration: populate `locationCodes` on existing
      // items from the shelf array they already have, so shelf lookups can use
      // an indexed array-contains query instead of scanning the collection.
      // Deliberately writes ONLY locationCodes — it does not touch stock, so
      // items whose total disagrees with their shelves stay visibly wrong
      // rather than being silently "corrected" by a migration.
      if (req.method === 'POST' && path === '/maintenance/backfill-location-codes') {
        var dryRun = (req.body || {}).dryRun === true;
        var msnap = await db.collection('items').where('orgId', '==', auth.orgId).get();
        var toWrite = [];
        var already = 0;
        msnap.docs.forEach(function (d) {
          var data = d.data();
          var want = INV.itemLocations(data).map(function (e) { return e.code; });
          var have = Array.isArray(data.locationCodes) ? data.locationCodes : null;
          var same = have && have.length === want.length && have.every(function (v, i) { return v === want[i]; });
          if (same) { already++; return; }
          toWrite.push({ ref: d.ref, codes: want });
        });

        if (dryRun) {
          return res.json({
            dryRun: true, scanned: msnap.size, alreadyCorrect: already,
            wouldUpdate: toWrite.length,
            sample: toWrite.slice(0, 10).map(function (w) { return { id: w.ref.id, locationCodes: w.codes }; })
          });
        }

        var written = 0;
        for (var i = 0; i < toWrite.length; i += 400) {
          var batch = db.batch();
          toWrite.slice(i, i + 400).forEach(function (w) {
            batch.update(w.ref, { locationCodes: w.codes });
          });
          await batch.commit();
          written += Math.min(400, toWrite.length - i);
        }

        await db.collection('activityLog').add({
          orgId: auth.orgId, action: 'MAINTENANCE',
          details: { task: 'backfill-location-codes', scanned: msnap.size, updated: written, alreadyCorrect: already, source: 'api', apiKey: auth.label },
          userEmail: 'API: ' + (auth.label || auth.keyId),
          timestamp: Date.now(), createdAt: new Date().toISOString()
        });

        return res.json({ scanned: msnap.size, updated: written, alreadyCorrect: already, documentsRead: msnap.size });
      }

      // ---- GET /  (discovery) ---------------------------------------------
      if (req.method === 'GET' && path === '/ping') {
        return res.json({ ok: true, org: auth.orgId, scope: auth.scope });
      }

      return apiError(res, 404, 'Unknown endpoint: ' + req.method + ' ' + path);
    } catch (err) {
      console.error('API error:', err);
      return apiError(res, 500, 'Internal error');
    }
  });

// ── MCP endpoint ──────────────────────────────────────────────────────────
// Same data and same apiKeys auth as exports.api, exposed as MCP tools so
// Claude and other MCP clients can reach the inventory natively from any
// device. Tool layer lives in ./mcp.js.
exports.mcp = require('./mcp')({
  functions: functions,
  db: db,
  resolveApiKey: resolveApiKey,
  publicItem: publicItem
});
