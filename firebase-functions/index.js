/**
 * AA Surplus Sales - Shippo Shipping Integration
 * Firebase Cloud Functions
 * 
 * Features:
 * - Scheduled daily check for packed orders (default 3:00 PM EST)
 * - Configurable check time via Firestore settings
 * - Shippo API integration for label generation
 * - Manual trigger endpoint for on-demand label generation
 * - Webhook handler for Shippo tracking updates
 * 
 * SETUP:
 * 1. Create a .env file in firebase-functions/ with: SHIPPO_API_KEY=your_key_here
 * 2. Deploy: firebase deploy --only functions
 * 3. In the app, go to Shipping Settings and configure your "From" address
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
require('dotenv').config();

admin.initializeApp();
const db = admin.firestore();

// ==================== CONFIGURATION ====================

const SHIPPO_BASE_URL = 'https://api.goshippo.com';

// Get Shippo API key from .env file
function getShippoApiKey() {
  return process.env.SHIPPO_API_KEY || '';
}

// ==================== SHIPPO API HELPERS ====================

async function shippoRequest(endpoint, method = 'GET', body = null) {
  const apiKey = getShippoApiKey();
  if (!apiKey) throw new Error('Shippo API key not configured. Add SHIPPO_API_KEY to your .env file in firebase-functions/');

  const options = {
    method,
    headers: {
      'Authorization': `ShippoToken ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${SHIPPO_BASE_URL}${endpoint}`, options);
  const data = await response.json();

  if (!response.ok) {
    console.error('Shippo API error:', JSON.stringify(data));
    throw new Error(`Shippo API error: ${data.detail || data.message || JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Create a Shippo shipment and get rates
 */
async function createShipment(fromAddress, toAddress, parcels) {
  return shippoRequest('/shipments/', 'POST', {
    address_from: fromAddress,
    address_to: toAddress,
    parcels: parcels,
    async: false,
  });
}

/**
 * Purchase a shipping label from a rate
 */
async function purchaseLabel(rateId) {
  return shippoRequest('/transactions/', 'POST', {
    rate: rateId,
    label_file_type: 'PDF',
    async: false,
  });
}

/**
 * Validate an address via Shippo
 */
async function validateAddress(address) {
  return shippoRequest('/addresses/', 'POST', {
    ...address,
    validate: true,
  });
}

// ==================== ADDRESS FORMATTING ====================

function formatAddressForShippo(customerName, addressString, email, phone) {
  // Parse address string like "123 Main St, City, ST 12345" or structured
  const parts = addressString.split(',').map(p => p.trim());

  let street1 = parts[0] || '';
  let city = '';
  let state = '';
  let zip = '';
  let country = 'US';

  if (parts.length >= 3) {
    city = parts[1] || '';
    // Last part might be "ST 12345" or just state
    const stateZip = parts[2] || '';
    const stateZipMatch = stateZip.match(/^([A-Z]{2})\s*(\d{5}(-\d{4})?)$/i);
    if (stateZipMatch) {
      state = stateZipMatch[1];
      zip = stateZipMatch[2];
    } else {
      state = stateZip;
      zip = parts[3] || '';
    }
  } else if (parts.length === 2) {
    city = parts[1] || '';
  }

  // Check for country in last part
  if (parts.length >= 4) {
    const lastPart = parts[parts.length - 1].trim().toUpperCase();
    if (lastPart.length === 2 && lastPart !== state) {
      country = lastPart;
    }
  }

  return {
    name: customerName || 'Customer',
    street1: street1,
    city: city,
    state: state,
    zip: zip,
    country: country,
    email: email || '',
    phone: phone || '',
  };
}

function formatStructuredAddress(data) {
  return {
    name: data.name || data.customerName || '',
    company: data.company || '',
    street1: data.street1 || data.address || '',
    street2: data.street2 || '',
    city: data.city || '',
    state: data.state || '',
    zip: data.zip || data.zipCode || '',
    country: data.country || 'US',
    email: data.email || '',
    phone: data.phone || '',
  };
}

// ==================== PARCEL FORMATTING ====================

function formatParcelsFromOrder(order) {
  const parcels = [];

  if (order.packingMode === 'triwalls' && order.triwalls?.length > 0) {
    // Triwall packing mode
    order.triwalls.forEach((tw, idx) => {
      parcels.push({
        length: parseFloat(tw.length) || 48,
        width: parseFloat(tw.width) || 40,
        height: parseFloat(tw.height) || 36,
        weight: parseFloat(tw.weight) || 50,
        distance_unit: 'in',
        mass_unit: 'lb',
      });
    });
  } else if (order.boxDetails && Object.keys(order.boxDetails).length > 0) {
    // Box packing mode
    Object.entries(order.boxDetails).forEach(([boxNum, box]) => {
      parcels.push({
        length: parseFloat(box.length) || 12,
        width: parseFloat(box.width) || 12,
        height: parseFloat(box.height) || 12,
        weight: parseFloat(box.weight) || 5,
        distance_unit: 'in',
        mass_unit: 'lb',
      });
    });
  } else {
    // Default single parcel - estimate from order
    parcels.push({
      length: 12,
      width: 12,
      height: 12,
      weight: 5,
      distance_unit: 'in',
      mass_unit: 'lb',
    });
  }

  return parcels;
}

// ==================== CORE LABEL GENERATION ====================

/**
 * Process a single packed order - create shipment, get rates, optionally auto-purchase
 */
async function processPackedOrder(order, orgSettings) {
  const fromAddress = orgSettings.shippingFromAddress;
  if (!fromAddress || !fromAddress.street1) {
    throw new Error('Shipping "From" address not configured. Go to Shipping Settings in the app.');
  }

  // Determine destination address
  let toAddressRaw;
  if (order.shipToAddress) {
    toAddressRaw = formatAddressForShippo(
      order.customerName,
      order.shipToAddress,
      order.customerEmail,
      order.customerPhone
    );
  } else if (order.customerAddress) {
    toAddressRaw = formatAddressForShippo(
      order.customerName,
      order.customerAddress,
      order.customerEmail,
      order.customerPhone
    );
  } else {
    throw new Error(`Order ${order.poNumber} has no shipping address`);
  }

  // Format parcels from packing data
  const parcels = formatParcelsFromOrder(order);

  // Create shipment in Shippo
  const shipment = await createShipment(
    formatStructuredAddress(fromAddress),
    toAddressRaw,
    parcels
  );

  // Get the cheapest rate, or preferred carrier rate
  const preferredCarrier = orgSettings.preferredCarrier || 'ups';
  let selectedRate = null;

  if (shipment.rates && shipment.rates.length > 0) {
    // Try to find preferred carrier rate
    selectedRate = shipment.rates.find(r =>
      r.provider.toLowerCase().includes(preferredCarrier.toLowerCase())
    );
    // Fall back to cheapest
    if (!selectedRate) {
      selectedRate = shipment.rates.sort((a, b) =>
        parseFloat(a.amount) - parseFloat(b.amount)
      )[0];
    }
  }

  const result = {
    shipmentId: shipment.object_id,
    rates: shipment.rates?.map(r => ({
      rateId: r.object_id,
      provider: r.provider,
      servicelevel: r.servicelevel?.name || r.servicelevel?.token,
      amount: r.amount,
      currency: r.currency,
      estimatedDays: r.estimated_days,
      durationTerms: r.duration_terms,
    })) || [],
    selectedRate: selectedRate ? {
      rateId: selectedRate.object_id,
      provider: selectedRate.provider,
      servicelevel: selectedRate.servicelevel?.name || selectedRate.servicelevel?.token,
      amount: selectedRate.amount,
      currency: selectedRate.currency,
    } : null,
    parcels: parcels.length,
    toAddress: toAddressRaw,
    createdAt: Date.now(),
  };

  // Auto-purchase label if setting enabled
  if (orgSettings.autoPurchaseLabels && selectedRate) {
    const transaction = await purchaseLabel(selectedRate.object_id);

    if (transaction.status === 'SUCCESS') {
      result.labelUrl = transaction.label_url;
      result.trackingNumber = transaction.tracking_number;
      result.trackingUrl = transaction.tracking_url_provider;
      result.transactionId = transaction.object_id;
      result.labelStatus = 'purchased';
      result.purchasedAt = Date.now();
    } else {
      result.labelStatus = 'failed';
      result.labelError = transaction.messages?.map(m => m.text).join('; ') || 'Unknown error';
    }
  } else {
    result.labelStatus = 'rates_ready';
  }

  return result;
}

// ==================== SCHEDULED FUNCTION ====================

/**
 * Runs daily to check for packed orders and generate shipping labels.
 * Default: 3:00 PM EST (20:00 UTC)
 * 
 * The schedule is configured via Firestore at:
 *   organizations/{orgId} -> settings.shippingCheckSchedule
 * 
 * NOTE: Firebase scheduled functions use a fixed cron. To support
 * user-configurable times, this function runs every hour and checks
 * if it's the configured time for each org.
 */
exports.checkPackedOrdersScheduled = functions.pubsub
  .schedule('every 1 hours')
  .timeZone('America/New_York')
  .onRun(async (context) => {
    console.log('⏰ Hourly shipping check triggered');

    try {
      // Get current hour in EST
      const now = new Date();
      const estHour = parseInt(
        now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
      );
      const estMinute = parseInt(
        now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' })
      );

      console.log(`Current EST time: ${estHour}:${estMinute.toString().padStart(2, '0')}`);

      // Get all organizations
      const orgsSnapshot = await db.collection('organizations').get();

      for (const orgDoc of orgsSnapshot.docs) {
        const org = orgDoc.data();
        const orgId = orgDoc.id;

        // Get configured check time (default 15:00 = 3 PM)
        const checkHour = org.settings?.shippingCheckHour ?? 15;
        const checkMinute = org.settings?.shippingCheckMinute ?? 0;

        // Only process if current hour matches configured hour
        // (with 30-min tolerance since we run hourly)
        if (estHour !== checkHour) {
          continue;
        }

        console.log(`🏢 Processing org: ${org.name} (${orgId}) - check time: ${checkHour}:${checkMinute.toString().padStart(2, '0')}`);

        // Check if shipping is enabled for this org
        if (!org.settings?.shippingEnabled) {
          console.log(`  ⏭️ Shipping not enabled for ${orgId}, skipping`);
          continue;
        }

        await processOrgPackedOrders(orgId, org);
      }

      console.log('✅ Scheduled shipping check complete');
    } catch (error) {
      console.error('❌ Scheduled shipping check failed:', error);
    }
  });

/**
 * Process all packed orders for a given organization
 */
async function processOrgPackedOrders(orgId, orgData) {
  try {
    // Get packed orders that haven't had labels generated yet
    const ordersSnapshot = await db.collection('purchaseOrders')
      .where('orgId', '==', orgId)
      .where('status', '==', 'packed')
      .get();

    const packedOrders = ordersSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(order => !order.shippingLabel); // Skip orders that already have labels

    if (packedOrders.length === 0) {
      console.log(`  📭 No new packed orders for ${orgId}`);
      return;
    }

    console.log(`  📦 Found ${packedOrders.length} packed orders to process`);

    const orgSettings = {
      shippingFromAddress: orgData.settings?.shippingFromAddress || null,
      preferredCarrier: orgData.settings?.preferredCarrier || 'ups',
      autoPurchaseLabels: orgData.settings?.autoPurchaseLabels || false,
      preferredService: orgData.settings?.preferredService || '',
    };

    let successCount = 0;
    let errorCount = 0;

    for (const order of packedOrders) {
      try {
        console.log(`  🔄 Processing order ${order.poNumber}...`);

        const shippingResult = await processPackedOrder(order, orgSettings);

        // Save shipping data to the order
        await db.collection('purchaseOrders').doc(order.id).update({
          shippingLabel: shippingResult,
          shippingStatus: shippingResult.labelStatus,
          updatedAt: Date.now(),
        });

        // Log the activity
        await db.collection('activityLog').add({
          orgId: orgId,
          action: 'SHIPPING_LABEL_GENERATED',
          details: {
            poId: order.id,
            poNumber: order.poNumber,
            carrier: shippingResult.selectedRate?.provider || 'N/A',
            trackingNumber: shippingResult.trackingNumber || 'N/A',
            labelStatus: shippingResult.labelStatus,
          },
          userId: 'system',
          userEmail: 'Automated Shipping System',
          timestamp: Date.now(),
          createdAt: new Date().toISOString(),
        });

        successCount++;
        console.log(`  ✅ Label ${shippingResult.labelStatus} for ${order.poNumber}`);
      } catch (orderError) {
        errorCount++;
        console.error(`  ❌ Failed to process ${order.poNumber}:`, orderError.message);

        // Save the error to the order
        await db.collection('purchaseOrders').doc(order.id).update({
          shippingLabel: {
            labelStatus: 'error',
            error: orderError.message,
            createdAt: Date.now(),
          },
          shippingStatus: 'error',
          updatedAt: Date.now(),
        });
      }
    }

    console.log(`  📊 Results: ${successCount} success, ${errorCount} errors`);
  } catch (error) {
    console.error(`  ❌ Error processing org ${orgId}:`, error);
  }
}

// ==================== HTTP CALLABLE FUNCTIONS ====================

/**
 * Manually trigger label generation for a specific order
 * Called from the frontend when user clicks "Generate Label"
 */
exports.generateShippingLabel = functions.https.onCall(async (data, context) => {
  // Verify authentication
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const { orderId, orgId, rateId } = data;

  if (!orderId || !orgId) {
    throw new functions.https.HttpsError('invalid-argument', 'orderId and orgId required');
  }

  try {
    // Get the order
    const orderDoc = await db.collection('purchaseOrders').doc(orderId).get();
    if (!orderDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Order not found');
    }

    const order = { id: orderDoc.id, ...orderDoc.data() };

    // Verify org membership
    if (order.orgId !== orgId) {
      throw new functions.https.HttpsError('permission-denied', 'Order does not belong to this organization');
    }

    // Get org settings
    const orgDoc = await db.collection('organizations').doc(orgId).get();
    const orgData = orgDoc.data();

    const orgSettings = {
      shippingFromAddress: orgData.settings?.shippingFromAddress || null,
      preferredCarrier: orgData.settings?.preferredCarrier || 'ups',
      autoPurchaseLabels: !!rateId, // Auto-purchase if a specific rate was selected
      preferredService: orgData.settings?.preferredService || '',
    };

    // If a specific rate was selected, purchase that label
    if (rateId) {
      const transaction = await purchaseLabel(rateId);

      const result = {
        ...(order.shippingLabel || {}),
        labelUrl: transaction.label_url,
        trackingNumber: transaction.tracking_number,
        trackingUrl: transaction.tracking_url_provider,
        transactionId: transaction.object_id,
        labelStatus: transaction.status === 'SUCCESS' ? 'purchased' : 'failed',
        labelError: transaction.status !== 'SUCCESS'
          ? transaction.messages?.map(m => m.text).join('; ')
          : null,
        purchasedAt: Date.now(),
      };

      await db.collection('purchaseOrders').doc(orderId).update({
        shippingLabel: result,
        shippingStatus: result.labelStatus,
        updatedAt: Date.now(),
      });

      return result;
    }

    // Otherwise, create shipment and get rates
    const shippingResult = await processPackedOrder(order, orgSettings);

    await db.collection('purchaseOrders').doc(orderId).update({
      shippingLabel: shippingResult,
      shippingStatus: shippingResult.labelStatus,
      updatedAt: Date.now(),
    });

    // Log activity
    await db.collection('activityLog').add({
      orgId: orgId,
      action: 'SHIPPING_LABEL_MANUAL',
      details: {
        poId: orderId,
        poNumber: order.poNumber,
        triggeredBy: context.auth.token.email || context.auth.uid,
      },
      userId: context.auth.uid,
      userEmail: context.auth.token.email || 'Unknown',
      timestamp: Date.now(),
      createdAt: new Date().toISOString(),
    });

    return shippingResult;
  } catch (error) {
    console.error('generateShippingLabel error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * Manually trigger the packed orders check for an org (admin use)
 */
exports.triggerShippingCheck = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const { orgId } = data;
  if (!orgId) {
    throw new functions.https.HttpsError('invalid-argument', 'orgId required');
  }

  try {
    const orgDoc = await db.collection('organizations').doc(orgId).get();
    if (!orgDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Organization not found');
    }

    const orgData = orgDoc.data();
    await processOrgPackedOrders(orgId, orgData);

    return { success: true, message: 'Shipping check completed' };
  } catch (error) {
    console.error('triggerShippingCheck error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * Update shipping schedule settings for an org
 */
exports.updateShippingSchedule = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const { orgId, checkHour, checkMinute, enabled } = data;
  if (!orgId) {
    throw new functions.https.HttpsError('invalid-argument', 'orgId required');
  }

  try {
    const updates = {};
    if (checkHour !== undefined) updates['settings.shippingCheckHour'] = parseInt(checkHour);
    if (checkMinute !== undefined) updates['settings.shippingCheckMinute'] = parseInt(checkMinute);
    if (enabled !== undefined) updates['settings.shippingEnabled'] = !!enabled;
    updates['updatedAt'] = Date.now();

    await db.collection('organizations').doc(orgId).update(updates);

    return { success: true };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * Validate a shipping address via Shippo
 */
exports.validateShippingAddress = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  try {
    const result = await validateAddress(data.address);
    return {
      isValid: result.validation_results?.is_valid || false,
      messages: result.validation_results?.messages || [],
      suggestedAddress: result,
    };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * Get available shipping rates for an order (without purchasing)
 */
exports.getShippingRates = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const { orderId, orgId } = data;

  try {
    const orderDoc = await db.collection('purchaseOrders').doc(orderId).get();
    if (!orderDoc.exists) throw new Error('Order not found');

    const order = { id: orderDoc.id, ...orderDoc.data() };
    const orgDoc = await db.collection('organizations').doc(orgId).get();
    const orgData = orgDoc.data();

    const orgSettings = {
      shippingFromAddress: orgData.settings?.shippingFromAddress || null,
      preferredCarrier: orgData.settings?.preferredCarrier || 'ups',
      autoPurchaseLabels: false, // Just get rates
      preferredService: orgData.settings?.preferredService || '',
    };

    const result = await processPackedOrder(order, orgSettings);

    // Save rates to order without purchasing
    await db.collection('purchaseOrders').doc(orderId).update({
      shippingLabel: result,
      shippingStatus: 'rates_ready',
      updatedAt: Date.now(),
    });

    return result;
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});
