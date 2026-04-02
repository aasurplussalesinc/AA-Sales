import { useState, useEffect } from 'react';
import { OrgDB as DB } from '../orgDb';
import { useAuth } from '../OrgAuthContext';
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions();

export default function Shipping() {
  const { organization, userRole } = useAuth();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState({});
  const [filterStatus, setFilterStatus] = useState('packed');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [customers, setCustomers] = useState([]);

  // Settings state
  const [showSettings, setShowSettings] = useState(false);
  const [shippingEnabled, setShippingEnabled] = useState(false);
  const [checkHour, setCheckHour] = useState(15);
  const [checkMinute, setCheckMinute] = useState(0);
  const [preferredCarrier, setPreferredCarrier] = useState('ups');
  const [autoPurchase, setAutoPurchase] = useState(false);
  const [shippoApiKey, setShippoApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [fromAddress, setFromAddress] = useState({
    name: '', company: '', street1: '', street2: '', city: '', state: '', zip: '', country: 'US', phone: '', email: ''
  });
  const [savingSettings, setSavingSettings] = useState(false);

  // Rate selection modal
  const [showRates, setShowRates] = useState(null); // order ID showing rates
  const [selectedRate, setSelectedRate] = useState(null);
  const [rateSortBy, setRateSortBy] = useState('cheapest'); // cheapest, fastest, carrier
  const [rateFilterCarrier, setRateFilterCarrier] = useState('all'); // all, ups, usps, fedex, dhl
  const [rateFilterBilling, setRateFilterBilling] = useState('all'); // all, AA, Customer
  const [rateViewMode, setRateViewMode] = useState('table'); // table, cards
  const [hideTriwalls, setHideTriwalls] = useState(true); // hide triwall orders by default

  useEffect(() => {
    loadData();
    loadSettings();
  }, [organization]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [ordersData, customersData] = await Promise.all([DB.getPurchaseOrders(), DB.getCustomers()]);
      const sorted = ordersData.sort((a, b) => (b.packedAt || b.updatedAt || 0) - (a.packedAt || a.updatedAt || 0));

      // Auto-detect: if a packed order's customer has a UPS account but order has no thirdPartyBilling, set it
      const autoUpdates = [];
      for (const order of sorted) {
        if (order.status !== 'packed' || order.shippingLabel?.trackingNumber) continue;
        const cust = customersData.find(c => c.id === order.customerId);
        if (!cust?.upsAccount) continue;
        const alreadySet = order.thirdPartyBilling?.account === cust.upsAccount && 
          order.thirdPartyBilling?.zip === (cust.zipCode || '');
        if (!alreadySet) {
          autoUpdates.push(
            DB.updatePurchaseOrder(order.id, {
              thirdPartyBilling: { account: cust.upsAccount, type: 'THIRD_PARTY', country: 'US', zip: cust.zipCode || '' },
              updatedAt: Date.now()
            })
          );
          order.thirdPartyBilling = { account: cust.upsAccount, type: 'THIRD_PARTY', country: 'US', zip: cust.zipCode || '' };
        }
      }
      if (autoUpdates.length > 0) await Promise.all(autoUpdates);

      setOrders(sorted);
      setCustomers(customersData);
    } catch (err) {
      console.error('Error loading orders:', err);
      setError('Failed to load orders');
    }
    setLoading(false);
  };

  const loadSettings = () => {
    if (!organization?.settings) return;
    const s = organization.settings;
    setShippingEnabled(s.shippingEnabled || false);
    setCheckHour(s.shippingCheckHour ?? 15);
    setCheckMinute(s.shippingCheckMinute ?? 0);
    setPreferredCarrier(s.preferredCarrier || 'ups');
    setAutoPurchase(s.autoPurchaseLabels || false);
    setShippoApiKey(s.shippoApiKey || '');
    if (s.shippingFromAddress) {
      setFromAddress({
        name: s.shippingFromAddress.name || '',
        company: s.shippingFromAddress.company || '',
        street1: s.shippingFromAddress.street1 || '',
        street2: s.shippingFromAddress.street2 || '',
        city: s.shippingFromAddress.city || '',
        state: s.shippingFromAddress.state || '',
        zip: s.shippingFromAddress.zip || '',
        country: s.shippingFromAddress.country || 'US',
        phone: s.shippingFromAddress.phone || '',
        email: s.shippingFromAddress.email || '',
      });
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    setError('');
    try {
      if (!shippoApiKey) {
        setError('Shippo API key is required. Get one at goshippo.com');
        setSavingSettings(false);
        return;
      }
      await DB.updateOrganization(organization.id, {
        'settings.shippingEnabled': shippingEnabled,
        'settings.shippingCheckHour': parseInt(checkHour),
        'settings.shippingCheckMinute': parseInt(checkMinute),
        'settings.preferredCarrier': preferredCarrier,
        'settings.autoPurchaseLabels': autoPurchase,
        'settings.shippingFromAddress': fromAddress,
        'settings.shippoApiKey': shippoApiKey,
      });

      // Also update via Cloud Function for the scheduler
      try {
        const updateSchedule = httpsCallable(functions, 'updateShippingSchedule');
        await updateSchedule({
          orgId: organization.id,
          checkHour: parseInt(checkHour),
          checkMinute: parseInt(checkMinute),
          enabled: shippingEnabled,
        });
      } catch (fnErr) {
        console.warn('Cloud function not deployed yet, settings saved locally:', fnErr);
      }

      setMessage('✅ Shipping settings saved!');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setError('Failed to save settings: ' + err.message);
    }
    setSavingSettings(false);
  };

  // Generate label for a single order
  const generateLabel = async (orderId) => {
    setProcessing(prev => ({ ...prev, [orderId]: true }));
    setError('');
    try {
      const generateFn = httpsCallable(functions, 'generateShippingLabel');
      const result = await generateFn({ orderId, orgId: organization.id });
      setMessage(`✅ Shipping label generated for order!`);
      await loadData();
    } catch (err) {
      setError(`Failed to generate label: ${err.message}`);
    }
    setProcessing(prev => ({ ...prev, [orderId]: false }));
  };

  // Get rates for an order
  const getRates = async (orderId) => {
    setProcessing(prev => ({ ...prev, [orderId]: true }));
    setError('');
    try {
      const getRatesFn = httpsCallable(functions, 'getShippingRates');
      const result = await getRatesFn({ orderId, orgId: organization.id });
      await loadData();
      setShowRates(orderId);
    } catch (err) {
      setError(`Failed to get rates: ${err.message}`);
    }
    setProcessing(prev => ({ ...prev, [orderId]: false }));
  };

  // Purchase a specific rate
  const purchaseRate = async (orderId, rateId) => {
    setProcessing(prev => ({ ...prev, [orderId]: true }));
    setError('');
    try {
      const generateFn = httpsCallable(functions, 'generateShippingLabel');
      const result = await generateFn({ orderId, orgId: organization.id, rateId });
      setMessage(`✅ Label purchased successfully!`);
      setShowRates(null);
      await loadData();
    } catch (err) {
      setError(`Failed to purchase label: ${err.message}`);
    }
    setProcessing(prev => ({ ...prev, [orderId]: false }));
  };

  // Trigger manual check for all packed orders
  const triggerManualCheck = async () => {
    setProcessing(prev => ({ ...prev, manual: true }));
    setError('');
    try {
      const triggerFn = httpsCallable(functions, 'triggerShippingCheck');
      await triggerFn({ orgId: organization.id });
      setMessage('✅ Shipping check completed! Refreshing...');
      await loadData();
    } catch (err) {
      setError(`Failed to run shipping check: ${err.message}`);
    }
    setProcessing(prev => ({ ...prev, manual: false }));
  };

  // Mark as shipped
  const markShipped = async (orderId) => {
    if (!window.confirm('Mark this order as shipped?')) return;
    try {
      await DB.markPOShipped(orderId);
      setMessage('✅ Order marked as shipped');
      await loadData();
    } catch (err) {
      setError('Failed to update order: ' + err.message);
    }
  };

  // ==================== BATCH OPERATIONS ====================
  const [selectedOrders, setSelectedOrders] = useState({});
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [batchResults, setBatchResults] = useState(null);

  const toggleOrderSelection = (orderId) => {
    setSelectedOrders(prev => {
      const next = { ...prev };
      if (next[orderId]) delete next[orderId];
      else next[orderId] = true;
      return next;
    });
  };

  const selectAllVisible = () => {
    const newSelection = {};
    filteredOrders.filter(o => o.status === 'packed' && !o.shippingLabel?.trackingNumber).forEach(o => {
      newSelection[o.id] = true;
    });
    setSelectedOrders(newSelection);
  };

  const clearSelection = () => setSelectedOrders({});

  const selectedCount = Object.keys(selectedOrders).length;

  const batchGetRates = async () => {
    const ids = Object.keys(selectedOrders);
    if (ids.length === 0) return;
    setBatchProcessing(true);
    setError('');
    try {
      const batchFn = httpsCallable(functions, 'batchGenerateLabels');
      const result = await batchFn({ orderIds: ids, orgId: organization.id, autoPurchase: false });
      setBatchResults(result.data);
      setMessage(`✅ Batch complete: ${result.data.success.length} succeeded, ${result.data.failed.length} failed`);
      setSelectedOrders({});
      await loadData();
    } catch (err) {
      setError(`Batch failed: ${err.message}`);
    }
    setBatchProcessing(false);
  };

  const batchAutoPurchase = async () => {
    const ids = Object.keys(selectedOrders);
    if (ids.length === 0) return;
    if (!window.confirm(`Purchase labels for ${ids.length} order(s) using your preferred carrier? This will charge your Shippo account.`)) return;
    setBatchProcessing(true);
    setError('');
    try {
      const batchFn = httpsCallable(functions, 'batchGenerateLabels');
      const result = await batchFn({ orderIds: ids, orgId: organization.id, autoPurchase: true });
      setBatchResults(result.data);
      setMessage(`✅ Batch purchase complete: ${result.data.success.length} labels purchased, ${result.data.failed.length} failed`);
      setSelectedOrders({});
      await loadData();
    } catch (err) {
      setError(`Batch purchase failed: ${err.message}`);
    }
    setBatchProcessing(false);
  };

  // ==================== CUSTOMS MODAL ====================
  const [showCustoms, setShowCustoms] = useState(null); // orderId
  const [customsForm, setCustomsForm] = useState({
    description: 'Military surplus tactical gear and equipment',
    contentsType: 'MERCHANDISE',
    nonDeliveryOption: 'RETURN',
    incoterm: 'DDU',
    eelPfc: 'NOEEI_30_37_a',
    destinationCountry: '',
    defaultTariffNumber: '',
  });
  const [savingCustoms, setSavingCustoms] = useState(false);

  const openCustomsModal = (order) => {
    setCustomsForm({
      description: order.customsInfo?.description || 'Military surplus tactical gear and equipment',
      contentsType: order.customsInfo?.contentsType || 'MERCHANDISE',
      nonDeliveryOption: order.customsInfo?.nonDeliveryOption || 'RETURN',
      incoterm: order.customsInfo?.incoterm || 'DDU',
      eelPfc: order.customsInfo?.eelPfc || 'NOEEI_30_37_a',
      destinationCountry: order.customsInfo?.destinationCountry || detectCountry(order) || '',
      defaultTariffNumber: order.customsInfo?.defaultTariffNumber || '',
    });
    setShowCustoms(order.id);
  };

  const detectCountry = (order) => {
    const addr = order.shipToAddress || order.customerAddress || '';
    if (addr.match(/[A-Z]\d[A-Z]\s?\d[A-Z]\d/i)) return 'CA';
    if (addr.toLowerCase().includes('canada')) return 'CA';
    return '';
  };

  const saveCustomsInfo = async () => {
    if (!showCustoms) return;
    setSavingCustoms(true);
    try {
      const saveFn = httpsCallable(functions, 'saveCustomsInfo');
      await saveFn({ orderId: showCustoms, orgId: organization.id, customsInfo: customsForm });
      setMessage('✅ Customs info saved!');
      setShowCustoms(null);
      await loadData();
    } catch (err) {
      setError('Failed to save customs info: ' + err.message);
    }
    setSavingCustoms(false);
  };

  const isLikelyInternational = (order) => {
    const addr = order.shipToAddress || order.customerAddress || '';
    return !!(addr.match(/[A-Z]\d[A-Z]\s?\d[A-Z]\d/i) || addr.toLowerCase().includes('canada') ||
      order.customsInfo?.destinationCountry);
  };

  // ==================== INSURANCE ====================
  const [insuranceEditing, setInsuranceEditing] = useState(null); // orderId being edited
  const [insuranceValue, setInsuranceValue] = useState(''); // legacy single value
  const [boxInsuranceValues, setBoxInsuranceValues] = useState({}); // { boxNum: amount }
  const [savingInsurance, setSavingInsurance] = useState(false);

  const startInsuranceEdit = (order) => {
    setInsuranceEditing(order.id);
    // Load per-box insurance if available, otherwise fall back to single value
    if (order.boxInsurance && Object.keys(order.boxInsurance).length > 0) {
      setBoxInsuranceValues({ ...order.boxInsurance });
      // Also set legacy value as total for display
      const total = Object.values(order.boxInsurance).reduce((s, v) => s + (parseFloat(v) || 0), 0);
      setInsuranceValue(total);
    } else if (order.boxDetails && Object.keys(order.boxDetails).length > 0) {
      // Auto-populate from box contents values
      const autoInsurance = {};
      Object.entries(order.boxDetails).forEach(([boxNum, details]) => {
        autoInsurance[boxNum] = details.contentsValue || 0;
      });
      setBoxInsuranceValues(autoInsurance);
      const total = Object.values(autoInsurance).reduce((s, v) => s + (parseFloat(v) || 0), 0);
      setInsuranceValue(total);
    } else {
      setBoxInsuranceValues({});
      setInsuranceValue((order.insuranceAmount !== undefined && order.insuranceAmount !== null && order.insuranceAmount !== '') ? order.insuranceAmount : (order.subtotal || order.total || ''));
    }
  };

  const updateBoxInsurance = (boxNum, value) => {
    setBoxInsuranceValues(prev => {
      const updated = { ...prev, [boxNum]: value };
      // Update total
      const total = Object.values(updated).reduce((s, v) => s + (parseFloat(v) || 0), 0);
      setInsuranceValue(Math.round(total * 100) / 100);
      return updated;
    });
  };

  const saveInsurance = async (orderId) => {
    setSavingInsurance(true);
    try {
      const saveFn = httpsCallable(functions, 'saveInsurance');
      const hasBoxInsurance = Object.keys(boxInsuranceValues).length > 0;
      const totalInsurance = hasBoxInsurance
        ? Object.values(boxInsuranceValues).reduce((s, v) => s + (parseFloat(v) || 0), 0)
        : parseFloat(insuranceValue) || 0;
      await saveFn({
        orderId, orgId: organization.id,
        insuranceAmount: Math.round(totalInsurance * 100) / 100,
        boxInsurance: hasBoxInsurance ? boxInsuranceValues : null
      });
      setMessage('✅ Insurance values saved! Get Rates again to include insurance.');
      setInsuranceEditing(null);
      await loadData();
    } catch (err) {
      setError('Failed to save insurance: ' + err.message);
    }
    setSavingInsurance(false);
  };

  // Filter orders
  const triwallCount = orders.filter(o => o.packingMode === 'triwalls').length;
  const filteredOrders = orders.filter(order => {
    if (hideTriwalls && order.packingMode === 'triwalls') return false;
    if (filterStatus === 'all') return ['packed', 'shipped'].includes(order.status);
    if (filterStatus === 'packed') return order.status === 'packed';
    if (filterStatus === 'shipped') return order.status === 'shipped';
    if (filterStatus === 'needs_label') return order.status === 'packed' && !order.shippingLabel;
    if (filterStatus === 'has_label') return order.shippingLabel?.labelStatus === 'purchased';
    if (filterStatus === 'error') return order.shippingLabel?.labelStatus === 'error';
    return true;
  });

  const getStatusBadge = (order) => {
    if (!order.shippingLabel) return { text: 'No Label', color: 'var(--text-muted)', bg: '#f5f5f5' };
    switch (order.shippingLabel.labelStatus) {
      case 'purchased': return { text: '✅ Label Ready', color: 'var(--text-badge-green)', bg: '#e8f5e9' };
      case 'rates_ready': return { text: '💰 Rates Available', color: 'var(--text-badge-orange)', bg: '#fff3e0' };
      case 'error': return { text: '❌ Error', color: 'var(--text-error)', bg: '#ffebee' };
      case 'failed': return { text: '⚠️ Failed', color: 'var(--text-error)', bg: '#ffebee' };
      default: return { text: order.shippingLabel.labelStatus, color: 'var(--text-muted)', bg: '#f5f5f5' };
    }
  };

  const formatTime = (hour, minute) => {
    const h = hour % 12 || 12;
    const ampm = hour >= 12 ? 'PM' : 'AM';
    return `${h}:${minute.toString().padStart(2, '0')} ${ampm}`;
  };

  // Get customer's UPS account from customers collection
  const getCustomerCarrierAccount = (order, carrier = 'ups') => {
    if (!order.customerId) return '';
    const cust = customers.find(c => c.id === order.customerId);
    if (!cust) return '';
    return carrier === 'ups' ? (cust.upsAccount || '') : (cust.fedexAccount || '');
  };

  // Save third-party billing info on order
  const saveBillTo = async (orderId, upsAccount) => {
    try {
      await DB.updatePurchaseOrder(orderId, { thirdPartyBilling: upsAccount ? { account: upsAccount, type: 'THIRD_PARTY', country: 'US' } : null, updatedAt: Date.now() });
      await loadData();
      setMessage('Bill To updated');
      setTimeout(() => setMessage(''), 2000);
    } catch (err) { setError('Failed to save billing: ' + err.message); }
  };

  // Generate End of Day manifest PDF (4x6 thermal)
  const generateEndOfDay = async () => {
    const today = new Date();
    const todayStr = today.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }).toUpperCase();
    
    // Get all orders with labels purchased today
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const shippedToday = orders.filter(o => {
      const label = o.shippingLabel;
      if (!label || label.labelStatus !== 'purchased') return false;
      return (label.purchasedAt || 0) >= startOfDay || (o.shippedAt || 0) >= startOfDay;
    });

    if (shippedToday.length === 0) {
      setError('No labels purchased today for End of Day report.');
      setTimeout(() => setError(''), 3000);
      return;
    }

    // Count total packages
    let totalPackages = 0;
    let groundCount = 0, nextDayCount = 0, twoDayCount = 0, threeDayCount = 0, intlPkgs = 0, intlShpts = 0;
    shippedToday.forEach(o => {
      const label = o.shippingLabel;
      const parcels = label.allLabels ? label.allLabels.length : (label.parcels || 1);
      totalPackages += parcels;
      const svc = (label.selectedRate?.servicelevel?.token || label.selectedRate?.servicelevel?.name || '').toLowerCase();
      if (svc.includes('next_day') || svc.includes('1da')) nextDayCount += parcels;
      else if (svc.includes('2nd_day') || svc.includes('2da')) twoDayCount += parcels;
      else if (svc.includes('3_day') || svc.includes('3ds')) threeDayCount += parcels;
      else groundCount += parcels;
      if (label.international) { intlPkgs += parcels; intlShpts++; }
    });

    const fromAddr = organization?.settings?.shippingFromAddress;
    const acctNum = organization?.settings?.upsAccountNumber || '—';
    const companyName = fromAddr?.company || fromAddr?.name || organization?.name || 'AA SURPLUS SALES INC';
    const street = fromAddr?.street1 || '';
    const cityStateZip = `${fromAddr?.city || ''} ${fromAddr?.state || ''} ${fromAddr?.zip || ''}`;

    try {
      const mergeFn = httpsCallable(functions, 'generateEndOfDayPdf');
      const result = await mergeFn({
        shipDate: todayStr,
        accountNumber: acctNum,
        companyName,
        street,
        cityStateZip,
        totalPackages,
        groundCount,
        nextDayCount,
        twoDayCount,
        threeDayCount,
        intlPkgs,
        intlShpts,
        orderDetails: shippedToday.map(o => ({
          poNumber: o.poNumber,
          customer: o.customerName,
          packages: o.shippingLabel.allLabels ? o.shippingLabel.allLabels.length : (o.shippingLabel.parcels || 1),
          tracking: o.shippingLabel.trackingNumber || '',
          service: o.shippingLabel.selectedRate?.servicelevel?.name || 'Ground',
        }))
      });
      const byteChars = atob(result.data.pdf);
      const byteArray = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
      const blob = new Blob([byteArray], { type: 'application/pdf' });
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (err) {
      console.error('End of Day failed:', err);
      setError('Failed to generate End of Day report: ' + err.message);
    }
  };

  if (loading) return <div style={{ padding: 20, textAlign: 'center' }}>Loading shipping data...</div>;

  return (
    <div style={{ padding: '0 20px 20px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>🚚 Shipping Center</h2>
          <p style={{ margin: '5px 0 0', color: 'var(--text-muted)', fontSize: 14 }}>
            {shippingEnabled
              ? `Auto-check daily at ${formatTime(checkHour, checkMinute)} EST`
              : 'Automated shipping is disabled'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={generateEndOfDay}
            style={{
              padding: '10px 20px', background: '#e65100', color: 'var(--text-on-dark)', border: 'none',
              borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14
            }}
          >
            📋 End of Day
          </button>
          <button
            onClick={triggerManualCheck}
            disabled={processing.manual}
            style={{
              padding: '10px 20px', background: '#1976d2', color: 'var(--text-on-dark)', border: 'none',
              borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14
            }}
          >
            {processing.manual ? '⏳ Checking...' : '🔄 Run Check Now'}
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={{
              padding: '10px 20px', background: showSettings ? '#666' : '#424242', color: 'var(--text-on-dark)',
              border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14
            }}
          >
            ⚙️ Settings
          </button>
        </div>
      </div>

      {/* Messages */}
      {message && <div style={{ padding: '12px 16px', background: 'var(--bg-badge-green)', color: 'var(--text-badge-green)', borderRadius: 8, marginBottom: 15, fontWeight: 500 }}>{message}</div>}
      {error && <div style={{ padding: '12px 16px', background: 'var(--bg-badge-red)', color: 'var(--text-error)', borderRadius: 8, marginBottom: 15, fontWeight: 500 }}>{error}</div>}

      {/* Settings Panel */}
      {showSettings && (
        <div style={{ background: 'var(--bg-surface-2)', border: '1px solid #dee2e6', borderRadius: 12, padding: 24, marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>⚙️ Shipping Settings</h3>

          {/* Shippo API Key */}
          <div style={{ marginBottom: 20, padding: 16, background: 'var(--bg-surface)', borderRadius: 8, border: '2px solid #1976d2' }}>
            <h4 style={{ margin: '0 0 10px', color: 'var(--text-link)' }}>🔑 Shippo API Key</h4>
            <p style={{ margin: '0 0 10px', color: 'var(--text-muted)', fontSize: 13 }}>
              Each organization needs their own Shippo account. 
              <a href="https://goshippo.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-link)', marginLeft: 4 }}>
                Sign up free at goshippo.com →
              </a>
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type={showApiKey ? 'text' : 'password'}
                value={shippoApiKey}
                onChange={e => setShippoApiKey(e.target.value)}
                placeholder="shippo_live_xxxxxxxxxxxxxxxx"
                style={{
                  flex: 1, padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)',
                  fontSize: 14, fontFamily: 'monospace'
                }}
              />
              <button
                onClick={() => setShowApiKey(!showApiKey)}
                style={{
                  padding: '10px 14px', background: 'var(--bg-surface-2)', border: '1px solid var(--border)',
                  borderRadius: 6, cursor: 'pointer', fontSize: 13
                }}
              >
                {showApiKey ? '🙈 Hide' : '👁️ Show'}
              </button>
            </div>
            {shippoApiKey && (
              <div style={{ marginTop: 8, fontSize: 12, color: shippoApiKey.startsWith('shippo_test_') ? '#ff9800' : '#4CAF50' }}>
                {shippoApiKey.startsWith('shippo_test_') ? '⚠️ Using TEST key — labels won\'t be real' : '✅ Using LIVE key'}
              </div>
            )}
          </div>

          {/* Enable/Disable */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={shippingEnabled} onChange={e => setShippingEnabled(e.target.checked)}
                style={{ width: 20, height: 20 }} />
              <span style={{ fontWeight: 600, fontSize: 16 }}>Enable Automated Shipping Labels</span>
            </label>
            <p style={{ margin: '5px 0 0 30px', color: 'var(--text-muted)', fontSize: 13 }}>
              When enabled, the system will automatically check for packed orders and generate shipping labels at the scheduled time.
            </p>
          </div>

          {/* Schedule Time */}
          <div style={{ marginBottom: 20, padding: 16, background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <h4 style={{ margin: '0 0 10px' }}>⏰ Daily Check Time (EST)</h4>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <select value={checkHour} onChange={e => setCheckHour(parseInt(e.target.value))}
                style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 15 }}>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{i === 0 ? '12' : i > 12 ? i - 12 : i}:00 {i >= 12 ? 'PM' : 'AM'}</option>
                ))}
              </select>
              <span style={{ color: 'var(--text-muted)' }}>EST / Eastern Time</span>
            </div>
            <p style={{ margin: '8px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>
              The system checks for packed orders at this time every day. Orders with status "packed" that don't have labels yet will be processed.
            </p>
          </div>

          {/* Preferred Carrier */}
          <div style={{ marginBottom: 20, padding: 16, background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <h4 style={{ margin: '0 0 10px' }}>📦 Preferred Carrier</h4>
            <select value={preferredCarrier} onChange={e => setPreferredCarrier(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 15, minWidth: 200 }}>
              <option value="ups">UPS</option>
              <option value="usps">USPS</option>
              <option value="fedex">FedEx</option>
              <option value="dhl">DHL</option>
            </select>
            <p style={{ margin: '8px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>
              When multiple rates are available, the system will prefer this carrier. Falls back to cheapest rate if unavailable.
            </p>
          </div>

          {/* Auto-Purchase */}
          <div style={{ marginBottom: 20, padding: 16, background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={autoPurchase} onChange={e => setAutoPurchase(e.target.checked)}
                style={{ width: 18, height: 18 }} />
              <span style={{ fontWeight: 600 }}>Auto-Purchase Labels</span>
            </label>
            <p style={{ margin: '8px 0 0 28px', color: 'var(--text-muted)', fontSize: 12 }}>
              ⚠️ When enabled, labels will be automatically purchased using your preferred carrier during the scheduled check. 
              When disabled, the system will fetch rates and you'll need to manually select and purchase each label.
            </p>
          </div>

          {/* From Address */}
          <div style={{ marginBottom: 20, padding: 16, background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <h4 style={{ margin: '0 0 15px' }}>📍 Ship From Address</h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {[
                { key: 'name', label: 'Name', placeholder: 'AA Surplus Sales' },
                { key: 'company', label: 'Company', placeholder: 'AA Surplus Sales LLC' },
                { key: 'street1', label: 'Street Address', placeholder: '123 Warehouse Dr' },
                { key: 'street2', label: 'Suite / Unit', placeholder: 'Suite 100' },
                { key: 'city', label: 'City', placeholder: 'Your City' },
                { key: 'state', label: 'State', placeholder: 'FL' },
                { key: 'zip', label: 'ZIP Code', placeholder: '33009' },
                { key: 'country', label: 'Country', placeholder: 'US' },
                { key: 'phone', label: 'Phone', placeholder: '555-123-4567' },
                { key: 'email', label: 'Email', placeholder: 'shipping@aasurplus.com' },
              ].map(field => (
                <div key={field.key}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{field.label}</label>
                  <input
                    value={fromAddress[field.key]}
                    onChange={e => setFromAddress(prev => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 14, boxSizing: 'border-box' }}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Save Button */}
          <button
            onClick={saveSettings}
            disabled={savingSettings}
            style={{
              padding: '12px 30px', background: '#4CAF50', color: 'var(--text-on-dark)', border: 'none',
              borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 15
            }}
          >
            {savingSettings ? 'Saving...' : '💾 Save Settings'}
          </button>
        </div>
      )}

      {/* Stats Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Packed / Awaiting', count: orders.filter(o => o.status === 'packed' && !o.shippingLabel).length, color: '#ff9800', icon: '📦' },
          { label: 'Labels Ready', count: orders.filter(o => o.shippingLabel?.labelStatus === 'purchased').length, color: 'var(--text-success)', icon: '✅' },
          { label: 'Rates Pending', count: orders.filter(o => o.shippingLabel?.labelStatus === 'rates_ready').length, color: '#2196F3', icon: '💰' },
          { label: 'Errors', count: orders.filter(o => o.shippingLabel?.labelStatus === 'error' || o.shippingLabel?.labelStatus === 'failed').length, color: 'var(--text-error)', icon: '❌' },
          { label: 'Shipped', count: orders.filter(o => o.status === 'shipped').length, color: 'var(--text-badge-purple)', icon: '🚚' },
        ].map(card => (
          <div key={card.label} style={{
            background: 'var(--bg-surface)', borderRadius: 10, padding: 16, border: `2px solid ${card.color}20`,
            textAlign: 'center'
          }}>
            <div style={{ fontSize: 28 }}>{card.icon}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: card.color }}>{card.count}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{card.label}</div>
          </div>
        ))}
      </div>

      {/* Filter Bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 15, flexWrap: 'wrap' }}>
        {[
          { value: 'packed', label: '📦 Packed' },
          { value: 'needs_label', label: '🏷️ Needs Label' },
          { value: 'has_label', label: '✅ Label Ready' },
          { value: 'error', label: '❌ Errors' },
          { value: 'shipped', label: '🚚 Shipped' },
          { value: 'all', label: '📋 All' },
        ].map(f => (
          <button
            key={f.value}
            onClick={() => setFilterStatus(f.value)}
            style={{
              padding: '8px 16px', borderRadius: 20, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', cursor: 'pointer',
              background: filterStatus === f.value ? '#1976d2' : 'white',
              color: filterStatus === f.value ? 'white' : '#333',
              fontWeight: filterStatus === f.value ? 600 : 400, fontSize: 13
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Triwall Toggle */}
      {triwallCount > 0 && (
        <div style={{ marginBottom: 12 }}>
          <button
            onClick={() => setHideTriwalls(prev => !prev)}
            style={{
              padding: '6px 14px', borderRadius: 16, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12,
              background: hideTriwalls ? '#fff8e1' : '#fff3e0',
              color: hideTriwalls ? '#f57f17' : '#e65100',
              fontWeight: 600,
            }}
          >
            {hideTriwalls
              ? `🪵 ${triwallCount} Triwall order${triwallCount !== 1 ? 's' : ''} hidden — click to show`
              : `🪵 Hide Triwall orders (${triwallCount})`
            }
          </button>
        </div>
      )}

      {/* Batch Controls */}
      {selectedCount > 0 && (
        <div style={{
          display: 'flex', gap: 10, alignItems: 'center', padding: '12px 16px',
          background: 'var(--bg-badge-blue)', borderRadius: 8, marginBottom: 15, flexWrap: 'wrap'
        }}>
          <span style={{ fontWeight: 600 }}>✅ {selectedCount} selected</span>
          <button onClick={batchGetRates} disabled={batchProcessing}
            style={{ padding: '6px 16px', background: '#1976d2', color: 'var(--text-on-dark)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            {batchProcessing ? '⏳ Processing...' : '💰 Batch Get Rates'}
          </button>
          <button onClick={batchAutoPurchase} disabled={batchProcessing}
            style={{ padding: '6px 16px', background: '#4CAF50', color: 'var(--text-on-dark)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            {batchProcessing ? '⏳ Processing...' : '⚡ Batch Auto-Purchase'}
          </button>
          <button onClick={clearSelection}
            style={{ padding: '6px 16px', background: '#757575', color: 'var(--text-on-dark)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
            Clear
          </button>
        </div>
      )}

      {/* Batch Results */}
      {batchResults && (
        <div style={{
          padding: '12px 16px', background: 'var(--bg-badge-green)', borderRadius: 8, marginBottom: 15, fontSize: 13
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>
              <strong>Batch Results:</strong> {batchResults.success.length} ✅ succeeded, {batchResults.failed.length} ❌ failed out of {batchResults.total} orders
            </span>
            <button onClick={() => setBatchResults(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16 }}>✕</button>
          </div>
          {batchResults.failed.length > 0 && (
            <div style={{ marginTop: 8, color: 'var(--text-error)' }}>
              {batchResults.failed.map((f, i) => <div key={i}>❌ {f.orderId}: {f.error}</div>)}
            </div>
          )}
        </div>
      )}

      {/* Customs Modal */}
      {showCustoms && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div style={{ background: 'var(--bg-surface)', borderRadius: 12, padding: 24, maxWidth: 500, width: '90%', maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>🌍 Customs Declaration</h3>
              <button onClick={() => setShowCustoms(null)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Destination Country</label>
                <select value={customsForm.destinationCountry} onChange={e => setCustomsForm(prev => ({ ...prev, destinationCountry: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
                  <option value="">Auto-detect from address</option>
                  <option value="CA">🇨🇦 Canada</option>
                  <option value="MX">🇲🇽 Mexico</option>
                  <option value="GB">🇬🇧 United Kingdom</option>
                  <option value="AU">🇦🇺 Australia</option>
                  <option value="DE">🇩🇪 Germany</option>
                  <option value="FR">🇫🇷 France</option>
                  <option value="JP">🇯🇵 Japan</option>
                  <option value="IL">🇮🇱 Israel</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Contents Description</label>
                <input value={customsForm.description} onChange={e => setCustomsForm(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Military surplus tactical gear and equipment"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', boxSizing: 'border-box' }} />
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Contents Type</label>
                <select value={customsForm.contentsType} onChange={e => setCustomsForm(prev => ({ ...prev, contentsType: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
                  <option value="MERCHANDISE">Merchandise</option>
                  <option value="GIFT">Gift</option>
                  <option value="SAMPLE">Sample</option>
                  <option value="RETURN_MERCHANDISE">Return Merchandise</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>If Undeliverable</label>
                <select value={customsForm.nonDeliveryOption} onChange={e => setCustomsForm(prev => ({ ...prev, nonDeliveryOption: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
                  <option value="RETURN">Return to Sender</option>
                  <option value="ABANDON">Abandon</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Incoterm (who pays duties)</label>
                <select value={customsForm.incoterm} onChange={e => setCustomsForm(prev => ({ ...prev, incoterm: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
                  <option value="DDU">DDU - Buyer pays duties/taxes</option>
                  <option value="DDP">DDP - You pay duties/taxes</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>EEL/PFC (export compliance)</label>
                <select value={customsForm.eelPfc} onChange={e => setCustomsForm(prev => ({ ...prev, eelPfc: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
                  <option value="NOEEI_30_37_a">NOEEI 30.37(a) - Under $2,500</option>
                  <option value="NOEEI_30_37_h">NOEEI 30.37(h) - Canada</option>
                  <option value="NOEEI_30_36">NOEEI 30.36 - Exempt</option>
                  <option value="">Not applicable</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Default HS Tariff Number (optional)</label>
                <input value={customsForm.defaultTariffNumber} onChange={e => setCustomsForm(prev => ({ ...prev, defaultTariffNumber: e.target.value }))}
                  placeholder="e.g. 6211.33"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', boxSizing: 'border-box' }} />
                <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>Harmonized System code for your goods. Military surplus clothing is typically 6211.33</p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button onClick={saveCustomsInfo} disabled={savingCustoms}
                style={{ flex: 1, padding: '10px 20px', background: '#4CAF50', color: 'var(--text-on-dark)', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
                {savingCustoms ? 'Saving...' : '💾 Save Customs Info'}
              </button>
              <button onClick={() => setShowCustoms(null)}
                style={{ padding: '10px 20px', background: '#757575', color: 'var(--text-on-dark)', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Orders Table */}
      {filteredOrders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
          <p style={{ fontSize: 48 }}>📭</p>
          <p>No orders match this filter</p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface-2)', textAlign: 'left' }}>
                <th style={{ padding: '12px 6px', borderBottom: '2px solid var(--border)', width: 36 }}>
                  <input type="checkbox" onChange={e => e.target.checked ? selectAllVisible() : clearSelection()}
                    checked={selectedCount > 0 && selectedCount === filteredOrders.filter(o => o.status === 'packed' && !o.shippingLabel?.trackingNumber).length}
                    style={{ width: 16, height: 16 }} />
                </th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid var(--border)' }}>PO #</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid var(--border)' }}>Customer</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid var(--border)' }}>Ship To</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid var(--border)' }}>Packages</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid var(--border)' }}>Insurance</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid var(--border)' }}>Bill To</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid var(--border)' }}>Label Status</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid var(--border)' }}>Tracking</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid var(--border)' }}>Cost</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid var(--border)' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map(order => {
                const badge = getStatusBadge(order);
                const label = order.shippingLabel;
                const intl = isLikelyInternational(order);

                return (
                  <tr key={order.id} style={{ borderBottom: '1px solid var(--border)', background: intl ? '#fffde7' : 'white' }}>
                    <td style={{ padding: '12px 6px' }}>
                      {order.status === 'packed' && !label?.trackingNumber && (
                        <input type="checkbox" checked={!!selectedOrders[order.id]}
                          onChange={() => toggleOrderSelection(order.id)}
                          style={{ width: 16, height: 16 }} />
                      )}
                    </td>
                    <td style={{ padding: '12px 10px', fontWeight: 600 }}>
                      {order.poNumber}
                      {intl && <span style={{ marginLeft: 6, fontSize: 11, background: '#ff9800', color: 'var(--text-on-dark)', padding: '1px 6px', borderRadius: 8 }}>🌍 INTL</span>}
                    </td>
                    <td style={{ padding: '12px 10px' }}>
                      <div>{order.customerName}</div>
                      {order.customerEmail && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{order.customerEmail}</div>}
                    </td>
                    <td style={{ padding: '12px 10px', fontSize: 12, maxWidth: 200 }}>
                      {order.shipToAddress || order.customerAddress || <span style={{ color: 'var(--text-muted)' }}>No address</span>}
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                      {order.packingMode === 'triwalls'
                        ? `${order.triwalls?.length || 0} triwall${(order.triwalls?.length || 0) !== 1 ? 's' : ''}`
                        : `${Object.keys(order.boxDetails || {}).length || 1} box${Object.keys(order.boxDetails || {}).length !== 1 ? 'es' : ''}`
                      }
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                      {insuranceEditing === order.id ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
                          {Object.keys(boxInsuranceValues).length > 0 ? (
                            <>
                              {Object.entries(boxInsuranceValues).sort((a,b) => parseInt(a[0]) - parseInt(b[0])).map(([boxNum, val]) => (
                                <div key={boxNum} style={{ display: 'flex', gap: 3, alignItems: 'center', fontSize: 11 }}>
                                  <span style={{ color: 'var(--text-muted)', minWidth: 30 }}>Box {boxNum}</span>
                                  <span style={{ fontWeight: 600 }}>$</span>
                                  <input
                                    type="number" value={val}
                                    onChange={e => updateBoxInsurance(boxNum, e.target.value)}
                                    style={{ width: 65, padding: '3px 5px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 11 }}
                                  />
                                </div>
                              ))}
                              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, borderTop: '1px solid var(--border)', paddingTop: 3, marginTop: 2 }}>
                                Total: ${Object.values(boxInsuranceValues).reduce((s, v) => s + (parseFloat(v) || 0), 0).toFixed(0)}
                              </div>
                            </>
                          ) : (
                            <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                              <span style={{ fontSize: 13, fontWeight: 600 }}>$</span>
                              <input
                                type="number" value={insuranceValue}
                                onChange={e => setInsuranceValue(e.target.value)}
                                style={{ width: 70, padding: '4px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 12 }}
                                autoFocus
                              />
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 3 }}>
                            <button onClick={() => saveInsurance(order.id)} disabled={savingInsurance}
                              style={{ padding: '3px 8px', background: '#4CAF50', color: 'var(--text-on-dark)', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>
                              ✓
                            </button>
                            <button onClick={() => setInsuranceEditing(null)}
                              style={{ padding: '3px 6px', background: '#999', color: 'var(--text-on-dark)', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>
                              ✕
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          onClick={() => order.status === 'packed' && !label?.trackingNumber && startInsuranceEdit(order)}
                          style={{ cursor: order.status === 'packed' && !label?.trackingNumber ? 'pointer' : 'default' }}
                          title={order.status === 'packed' && !label?.trackingNumber ? 'Click to set insurance value' : ''}
                        >
                          {(order.insuranceAmount > 0 || label?.insuranceAmount > 0) ? (
                            <span style={{ padding: '3px 8px', borderRadius: 8, background: 'var(--bg-badge-green)', color: 'var(--text-badge-green)', fontSize: 12, fontWeight: 600 }}>
                              🛡️ ${parseFloat(order.insuranceAmount || label?.insuranceAmount).toFixed(0)}
                            </span>
                          ) : (
                            order.status === 'packed' && !label?.trackingNumber ? (
                              <span style={{ fontSize: 11, color: 'var(--text-muted)', textDecoration: 'underline' }}>+ Add</span>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                            )
                          )}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                      {(() => {
                        const cust = customers.find(c => c.id === order.customerId);
                        const custAcct = cust?.upsAccount;
                        const billing = order.thirdPartyBilling;
                        if (custAcct) {
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center' }}>
                              <span style={{ padding: '2px 8px', borderRadius: 8, background: 'var(--bg-badge-blue)', color: 'var(--text-badge-blue)', fontSize: 11, fontWeight: 700 }}>
                                🏢 {custAcct}
                              </span>
                              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Customer UPS</span>
                            </div>
                          );
                        }
                        return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>AA Acct</span>;
                      })()}
                    </td>
                    <td style={{ padding: '12px 10px' }}>
                      <span style={{
                        padding: '4px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
                        background: badge.bg, color: badge.color
                      }}>
                        {badge.text}
                      </span>
                      {label?.international && <div style={{ fontSize: 10, color: '#ff9800', marginTop: 2 }}>International • {label.destinationCountry}</div>}
                      {label?.labelError && (
                        <div style={{ fontSize: 11, color: 'var(--text-error)', marginTop: 4 }}>{label.labelError}</div>
                      )}
                    </td>
                    <td style={{ padding: '12px 10px', fontSize: 12 }}>
                      {label?.trackingNumber ? (
                        <div>
                          <div style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 11 }}>{label.trackingNumber}</div>
                          {label.trackingUrl && (
                            <a href={label.trackingUrl} target="_blank" rel="noopener noreferrer"
                              style={{ color: 'var(--text-link)', fontSize: 11 }}>Track (Master) →</a>
                          )}
                          {label.allLabels && label.allLabels.length > 1 && (
                            <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                              {label.allLabels.map((lbl, idx) => (
                                <div key={idx}>Box {idx + 1}: {lbl.trackingNumber}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 10px' }}>
                      {label?.selectedRate ? (
                        <div>
                          <div style={{ fontWeight: 600 }}>${label.selectedRate.amount}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {label.selectedRate.provider} {label.selectedRate.servicelevel}
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 10px' }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {/* No label yet - Get Rates */}
                        {order.status === 'packed' && !label && (
                          <button
                            onClick={() => getRates(order.id)}
                            disabled={processing[order.id]}
                            style={{
                              padding: '6px 12px', background: '#1976d2', color: 'var(--text-on-dark)', border: 'none',
                              borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap'
                            }}
                          >
                            {processing[order.id] ? '...' : '💰 Get Rates'}
                          </button>
                        )}

                        {/* Rates ready - View & Purchase */}
                        {label?.labelStatus === 'rates_ready' && (
                          <>
                            <button
                              onClick={() => setShowRates(showRates === order.id ? null : order.id)}
                              style={{
                                padding: '6px 12px', background: '#ff9800', color: 'var(--text-on-dark)', border: 'none',
                                borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap'
                              }}
                            >
                              🏷️ Select Rate
                            </button>
                            <button
                              onClick={() => getRates(order.id)}
                              disabled={processing[order.id]}
                              style={{
                                padding: '6px 12px', background: '#1976d2', color: 'var(--text-on-dark)', border: 'none',
                                borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap'
                              }}
                            >
                              {processing[order.id] ? '...' : '🔄 Refresh'}
                            </button>
                          </>
                        )}

                        {/* Label purchased - Print & Ship */}
                        {label?.labelStatus === 'purchased' && (
                          <>
                            {label.allLabels && label.allLabels.length > 1 ? (
                              // Multi-parcel: Print All + individual buttons
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <button
                                  onClick={async () => {
                                    try {
                                      const urls = label.allLabels.map(lbl => lbl.labelUrl);
                                      const mergeFn = httpsCallable(functions, 'mergeLabelPdfs');
                                      const result = await mergeFn({ urls });
                                      const byteChars = atob(result.data.pdf);
                                      const byteArray = new Uint8Array(byteChars.length);
                                      for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
                                      const blob = new Blob([byteArray], { type: 'application/pdf' });
                                      const url = URL.createObjectURL(blob);
                                      window.open(url, '_blank');
                                    } catch (err) {
                                      console.error('PDF merge failed:', err);
                                      alert('Failed to merge labels. Use individual Box buttons instead.');
                                    }
                                  }}
                                  style={{
                                    padding: '6px 12px', background: '#2e7d32', color: 'var(--text-on-dark)', border: 'none',
                                    borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap'
                                  }}
                                >
                                  🖨️ Print All {label.allLabels.length} Labels
                                </button>
                                <div style={{ display: 'flex', gap: 4 }}>
                                  {label.allLabels.map((lbl, idx) => (
                                    <a key={idx}
                                      href={lbl.labelUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{
                                        padding: '4px 8px', background: '#66bb6a', color: 'var(--text-on-dark)', border: 'none',
                                        borderRadius: 4, cursor: 'pointer', fontSize: 10, fontWeight: 600, textDecoration: 'none',
                                        display: 'inline-block', whiteSpace: 'nowrap'
                                      }}
                                    >
                                      Box {idx + 1}
                                    </a>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <a
                                href={label.labelUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                  padding: '6px 12px', background: '#4CAF50', color: 'var(--text-on-dark)', border: 'none',
                                  borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, textDecoration: 'none',
                                  display: 'inline-block', whiteSpace: 'nowrap'
                                }}
                              >
                                🖨️ Print Label
                              </a>
                            )}
                            {order.status === 'packed' && (
                              <button
                                onClick={() => markShipped(order.id)}
                                style={{
                                  padding: '6px 12px', background: '#9c27b0', color: 'var(--text-on-dark)', border: 'none',
                                  borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap'
                                }}
                              >
                                🚚 Mark Shipped
                              </button>
                            )}
                          </>
                        )}

                        {/* Error - Retry */}
                        {(label?.labelStatus === 'error' || label?.labelStatus === 'failed') && (
                          <button
                            onClick={() => getRates(order.id)}
                            disabled={processing[order.id]}
                            style={{
                              padding: '6px 12px', background: '#f44336', color: 'var(--text-on-dark)', border: 'none',
                              borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap'
                            }}
                          >
                            {processing[order.id] ? '...' : '🔄 Retry'}
                          </button>
                        )}

                        {/* Auto-generate (bypasses rate selection) */}
                        {order.status === 'packed' && !label?.trackingNumber && (
                          <button
                            onClick={() => generateLabel(order.id)}
                            disabled={processing[order.id]}
                            title="Auto-select best rate and purchase label"
                            style={{
                              padding: '6px 12px', background: '#607d8b', color: 'var(--text-on-dark)', border: 'none',
                              borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap'
                            }}
                          >
                            {processing[order.id] ? '...' : '⚡ Auto Label'}
                          </button>
                        )}

                        {/* Customs - for international orders */}
                        {order.status === 'packed' && intl && (
                          <button
                            onClick={() => openCustomsModal(order)}
                            title="Edit customs declaration for international shipment"
                            style={{
                              padding: '6px 12px', background: order.customsInfo ? '#43a047' : '#ff9800', color: 'var(--text-on-dark)', border: 'none',
                              borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap'
                            }}
                          >
                            {order.customsInfo ? '✅ Customs' : '🌍 Customs'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Rates Selection Panel */}
          {showRates && (() => {
            const order = filteredOrders.find(o => o.id === showRates);
            if (!order?.shippingLabel?.rates?.length) return null;

            const allRates = order.shippingLabel.rates;
            
            // Get unique carriers for filter
            const carriers = [...new Set(allRates.map(r => r.provider))];

            // Check if any customer-billed rates exist
            const hasCustomerRates = allRates.some(r => r.billedTo === 'Customer');

            // Filter rates
            const filteredRates = allRates.filter(r => {
              const carrierMatch = rateFilterCarrier === 'all' || r.provider.toLowerCase().includes(rateFilterCarrier.toLowerCase());
              const billingMatch = rateFilterBilling === 'all' || r.billedTo === rateFilterBilling;
              return carrierMatch && billingMatch;
            });

            // Sort rates
            const sortedRates = [...filteredRates].sort((a, b) => {
              switch (rateSortBy) {
                case 'cheapest': return parseFloat(a.amount) - parseFloat(b.amount);
                case 'expensive': return parseFloat(b.amount) - parseFloat(a.amount);
                case 'fastest': return (a.estimatedDays || 99) - (b.estimatedDays || 99);
                case 'carrier': return (a.provider || '').localeCompare(b.provider || '');
                default: return parseFloat(a.amount) - parseFloat(b.amount);
              }
            });

            // Find cheapest and fastest for badges
            const cheapest = [...allRates].sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0];
            const fastest = [...allRates].filter(r => r.estimatedDays).sort((a, b) => a.estimatedDays - b.estimatedDays)[0];

            return (
              <div style={{
                background: 'var(--bg-surface-2)', border: '2px solid #1976d2', borderRadius: 12,
                padding: 20, marginTop: 10, marginBottom: 10
              }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15, flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <h4 style={{ margin: 0 }}>💰 Shipping Rates for {order.poNumber}</h4>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {allRates.length} rate{allRates.length !== 1 ? 's' : ''} from {carriers.length} carrier{carriers.length !== 1 ? 's' : ''}
                      {' • '}{order.customerName} → {order.shipToAddress || order.customerAddress || 'N/A'}
                    </span>
                    {hasCustomerRates && order.thirdPartyBilling?.account && (
                      <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
                        <span style={{ padding: '2px 8px', borderRadius: 8, background: 'var(--bg-badge-green)', color: 'var(--text-badge-green)', fontSize: 11, fontWeight: 600 }}>🏢 AA Account rates included</span>
                        <span style={{ padding: '2px 8px', borderRadius: 8, background: 'var(--bg-badge-blue)', color: 'var(--text-badge-blue)', fontSize: 11, fontWeight: 600 }}>📦 Customer UPS ({order.thirdPartyBilling.account}) rates included</span>
                      </div>
                    )}
                  </div>
                  <button onClick={() => { setShowRates(null); setRateFilterCarrier('all'); setRateFilterBilling('all'); }} style={{
                    background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)', padding: '0 4px'
                  }}>✕</button>
                </div>

                {/* Quick Stats */}
                <div style={{ display: 'flex', gap: 12, marginBottom: 15, flexWrap: 'wrap' }}>
                  {cheapest && (
                    <div style={{ padding: '8px 14px', background: 'var(--bg-badge-green)', borderRadius: 8, fontSize: 13 }}>
                      💚 Cheapest: <strong>${cheapest.amount}</strong> ({cheapest.provider} {cheapest.servicelevel})
                    </div>
                  )}
                  {fastest && fastest.rateId !== cheapest?.rateId && (
                    <div style={{ padding: '8px 14px', background: 'var(--bg-badge-blue)', borderRadius: 8, fontSize: 13 }}>
                      ⚡ Fastest: <strong>{fastest.estimatedDays} day{fastest.estimatedDays !== 1 ? 's' : ''}</strong> — ${fastest.amount} ({fastest.provider} {fastest.servicelevel})
                    </div>
                  )}
                </div>

                {/* Filter & Sort Controls */}
                <div style={{ display: 'flex', gap: 10, marginBottom: 15, flexWrap: 'wrap', alignItems: 'center' }}>
                  {/* Sort */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>Sort:</span>
                    {[
                      { value: 'cheapest', label: '💲 Cheapest' },
                      { value: 'expensive', label: '💎 Most Expensive' },
                      { value: 'fastest', label: '⚡ Fastest' },
                      { value: 'carrier', label: '🏢 Carrier' },
                    ].map(s => (
                      <button
                        key={s.value}
                        onClick={() => setRateSortBy(s.value)}
                        style={{
                          padding: '5px 12px', borderRadius: 16, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', cursor: 'pointer',
                          background: rateSortBy === s.value ? '#1976d2' : 'white',
                          color: rateSortBy === s.value ? 'white' : '#333',
                          fontWeight: rateSortBy === s.value ? 600 : 400, fontSize: 12
                        }}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>

                  {/* Carrier Filter */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>Carrier:</span>
                    <button
                      onClick={() => setRateFilterCarrier('all')}
                      style={{
                        padding: '5px 12px', borderRadius: 16, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', cursor: 'pointer',
                        background: rateFilterCarrier === 'all' ? '#424242' : 'white',
                        color: rateFilterCarrier === 'all' ? 'white' : '#333',
                        fontWeight: rateFilterCarrier === 'all' ? 600 : 400, fontSize: 12
                      }}
                    >
                      All ({allRates.length})
                    </button>
                    {carriers.map(c => {
                      const count = allRates.filter(r => r.provider === c).length;
                      return (
                        <button
                          key={c}
                          onClick={() => setRateFilterCarrier(rateFilterCarrier === c.toLowerCase() ? 'all' : c.toLowerCase())}
                          style={{
                            padding: '5px 12px', borderRadius: 16, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', cursor: 'pointer',
                            background: rateFilterCarrier === c.toLowerCase() ? '#424242' : 'white',
                            color: rateFilterCarrier === c.toLowerCase() ? 'white' : '#333',
                            fontWeight: rateFilterCarrier === c.toLowerCase() ? 600 : 400, fontSize: 12
                          }}
                        >
                          {c} ({count})
                        </button>
                      );
                    })}
                  </div>

                  {/* Bill To Filter - only show if customer rates exist */}
                  {hasCustomerRates && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>Bill To:</span>
                      {[
                        { value: 'all', label: 'All' },
                        { value: 'AA', label: '🏢 AA Account' },
                        { value: 'Customer', label: `📦 Customer (${order.thirdPartyBilling?.account || ''})` },
                      ].map(b => (
                        <button key={b.value} onClick={() => setRateFilterBilling(b.value)} style={{
                          padding: '5px 12px', borderRadius: 16, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', cursor: 'pointer',
                          background: rateFilterBilling === b.value ? '#1565c0' : 'white',
                          color: rateFilterBilling === b.value ? 'white' : '#333',
                          fontWeight: rateFilterBilling === b.value ? 600 : 400, fontSize: 12
                        }}>{b.label}</button>
                      ))}
                    </div>
                  )}

                  {/* View Toggle */}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    <button onClick={() => setRateViewMode('table')} style={{
                      padding: '5px 10px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', borderRadius: '6px 0 0 6px', cursor: 'pointer',
                      background: rateViewMode === 'table' ? '#424242' : 'white', color: rateViewMode === 'table' ? 'white' : '#333', fontSize: 12
                    }}>☰ Table</button>
                    <button onClick={() => setRateViewMode('cards')} style={{
                      padding: '5px 10px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', borderRadius: '0 6px 6px 0', cursor: 'pointer',
                      background: rateViewMode === 'cards' ? '#424242' : 'white', color: rateViewMode === 'cards' ? 'white' : '#333', fontSize: 12
                    }}>▦ Cards</button>
                  </div>
                </div>

                {/* Table View */}
                {rateViewMode === 'table' ? (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: 'var(--bg-table-head)', textAlign: 'left' }}>
                          <th style={{ padding: '10px 12px', borderBottom: '2px solid #c5cae9' }}>Carrier</th>
                          <th style={{ padding: '10px 12px', borderBottom: '2px solid #c5cae9' }}>Service</th>
                          <th style={{ padding: '10px 12px', borderBottom: '2px solid #c5cae9', textAlign: 'right' }}>Price</th>
                          <th style={{ padding: '10px 12px', borderBottom: '2px solid #c5cae9', textAlign: 'center' }}>Est. Delivery</th>
                          <th style={{ padding: '10px 12px', borderBottom: '2px solid #c5cae9' }}></th>
                          <th style={{ padding: '10px 12px', borderBottom: '2px solid #c5cae9', textAlign: 'center' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedRates.map((rate, idx) => {
                          const isCheapest = rate.rateId === cheapest?.rateId;
                          const isFastest = rate.rateId === fastest?.rateId && !isCheapest;
                          return (
                            <tr key={rate.rateId} style={{
                              borderBottom: '1px solid var(--border)',
                              background: isCheapest ? '#f1f8e9' : isFastest ? '#e8f4fd' : idx % 2 === 0 ? 'white' : '#fafafa',
                            }}>
                              <td style={{ padding: '10px 12px', fontWeight: 600 }}>{rate.provider}</td>
                              <td style={{ padding: '10px 12px' }}>{rate.servicelevel}</td>
                              <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontSize: 15, color: 'var(--text-link)' }}>
                                ${rate.amount}
                              </td>
                              <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                                {rate.estimatedDays
                                  ? `${rate.estimatedDays} day${rate.estimatedDays !== 1 ? 's' : ''}`
                                  : <span style={{ color: 'var(--text-muted)' }}>—</span>
                                }
                              </td>
                              <td style={{ padding: '10px 12px' }}>
                                {isCheapest && <span style={{ background: '#4CAF50', color: 'var(--text-on-dark)', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>CHEAPEST</span>}
                                {isFastest && <span style={{ background: '#2196F3', color: 'var(--text-on-dark)', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>FASTEST</span>}
                              </td>
                              <td style={{ padding: '10px 12px' }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                  {rate.billedTo === 'Customer'
                                    ? <span style={{ padding: '2px 7px', borderRadius: 8, background: 'var(--bg-badge-blue)', color: 'var(--text-badge-blue)', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>📦 Customer UPS</span>
                                    : <span style={{ padding: '2px 7px', borderRadius: 8, background: 'var(--bg-badge-purple)', color: '#6a1b9a', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>🏢 AA Account</span>
                                  }
                                  {rate.insuranceProvider && rate.insuranceProvider !== 'none' && (
                                    <span style={{ padding: '2px 7px', borderRadius: 8, fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
                                      background: rate.insuranceProvider === 'UPS' ? '#fff3e0' : '#e8f5e9',
                                      color: rate.insuranceProvider === 'UPS' ? '#e65100' : '#2e7d32'
                                    }}>🛡️ {rate.insuranceProvider}</span>
                                  )}
                                </div>
                              </td>
                              <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                                <button
                                  onClick={() => purchaseRate(order.id, rate.rateId)}
                                  disabled={processing[order.id]}
                                  style={{
                                    padding: '6px 16px', background: '#4CAF50', color: 'var(--text-on-dark)',
                                    border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600
                                  }}
                                >
                                  {processing[order.id] ? '...' : '🏷️ Buy'}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {sortedRates.length === 0 && (
                      <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>No rates match this filter</div>
                    )}
                  </div>
                ) : (
                  /* Cards View */
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
                    {sortedRates.map(rate => {
                      const isCheapest = rate.rateId === cheapest?.rateId;
                      const isFastest = rate.rateId === fastest?.rateId && !isCheapest;
                      return (
                        <div
                          key={rate.rateId}
                          style={{
                            background: 'var(--bg-surface)', borderRadius: 8, padding: 14,
                            border: isCheapest ? '2px solid #4CAF50' : isFastest ? '2px solid #2196F3' : '1px solid #ddd',
                            position: 'relative'
                          }}
                        >
                          {isCheapest && <div style={{ position: 'absolute', top: -8, right: 10, background: '#4CAF50', color: 'var(--text-on-dark)', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600 }}>CHEAPEST</div>}
                          {isFastest && <div style={{ position: 'absolute', top: -8, right: 10, background: '#2196F3', color: 'var(--text-on-dark)', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600 }}>FASTEST</div>}
                          <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-link)' }}>${rate.amount}</div>
                          <div style={{ fontWeight: 600, marginTop: 4 }}>{rate.provider}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{rate.servicelevel}</div>
                          <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                            {rate.billedTo === 'Customer'
                              ? <span style={{ padding: '2px 7px', borderRadius: 8, background: 'var(--bg-badge-blue)', color: 'var(--text-badge-blue)', fontSize: 10, fontWeight: 600 }}>📦 Customer UPS</span>
                              : <span style={{ padding: '2px 7px', borderRadius: 8, background: 'var(--bg-badge-purple)', color: '#6a1b9a', fontSize: 10, fontWeight: 600 }}>🏢 AA Account</span>
                            }
                            {rate.insuranceProvider && rate.insuranceProvider !== 'none' && (
                              <span style={{ padding: '2px 7px', borderRadius: 8, fontSize: 10, fontWeight: 600,
                                background: rate.insuranceProvider === 'UPS' ? '#fff3e0' : '#e8f5e9',
                                color: rate.insuranceProvider === 'UPS' ? '#e65100' : '#2e7d32'
                              }}>🛡️ {rate.insuranceProvider}</span>
                            )}
                          </div>
                          {rate.estimatedDays && (
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                              Est. {rate.estimatedDays} day{rate.estimatedDays !== 1 ? 's' : ''}
                            </div>
                          )}
                          <button
                            onClick={() => purchaseRate(order.id, rate.rateId)}
                            disabled={processing[order.id]}
                            style={{
                              marginTop: 10, padding: '6px 14px', background: '#4CAF50', color: 'var(--text-on-dark)',
                              border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                              width: '100%'
                            }}
                          >
                            {processing[order.id] ? 'Purchasing...' : '🏷️ Purchase'}
                          </button>
                        </div>
                      );
                    })}
                    {sortedRates.length === 0 && (
                      <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', gridColumn: '1 / -1' }}>No rates match this filter</div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
