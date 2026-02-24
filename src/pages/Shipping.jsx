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
  const [rateViewMode, setRateViewMode] = useState('table'); // table, cards

  useEffect(() => {
    loadData();
    loadSettings();
  }, [organization]);

  const loadData = async () => {
    setLoading(true);
    try {
      const ordersData = await DB.getPurchaseOrders();
      // Sort by packedAt date, most recent first
      const sorted = ordersData.sort((a, b) => (b.packedAt || b.updatedAt || 0) - (a.packedAt || a.updatedAt || 0));
      setOrders(sorted);
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

  // Filter orders
  const filteredOrders = orders.filter(order => {
    if (filterStatus === 'all') return ['packed', 'shipped'].includes(order.status);
    if (filterStatus === 'packed') return order.status === 'packed';
    if (filterStatus === 'shipped') return order.status === 'shipped';
    if (filterStatus === 'needs_label') return order.status === 'packed' && !order.shippingLabel;
    if (filterStatus === 'has_label') return order.shippingLabel?.labelStatus === 'purchased';
    if (filterStatus === 'error') return order.shippingLabel?.labelStatus === 'error';
    return true;
  });

  const getStatusBadge = (order) => {
    if (!order.shippingLabel) return { text: 'No Label', color: '#999', bg: '#f5f5f5' };
    switch (order.shippingLabel.labelStatus) {
      case 'purchased': return { text: '✅ Label Ready', color: '#2e7d32', bg: '#e8f5e9' };
      case 'rates_ready': return { text: '💰 Rates Available', color: '#f57c00', bg: '#fff3e0' };
      case 'error': return { text: '❌ Error', color: '#c62828', bg: '#ffebee' };
      case 'failed': return { text: '⚠️ Failed', color: '#c62828', bg: '#ffebee' };
      default: return { text: order.shippingLabel.labelStatus, color: '#666', bg: '#f5f5f5' };
    }
  };

  const formatTime = (hour, minute) => {
    const h = hour % 12 || 12;
    const ampm = hour >= 12 ? 'PM' : 'AM';
    return `${h}:${minute.toString().padStart(2, '0')} ${ampm}`;
  };

  if (loading) return <div style={{ padding: 20, textAlign: 'center' }}>Loading shipping data...</div>;

  return (
    <div style={{ padding: '0 20px 20px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>🚚 Shipping Center</h2>
          <p style={{ margin: '5px 0 0', color: '#666', fontSize: 14 }}>
            {shippingEnabled
              ? `Auto-check daily at ${formatTime(checkHour, checkMinute)} EST`
              : 'Automated shipping is disabled'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={triggerManualCheck}
            disabled={processing.manual}
            style={{
              padding: '10px 20px', background: '#1976d2', color: 'white', border: 'none',
              borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14
            }}
          >
            {processing.manual ? '⏳ Checking...' : '🔄 Run Check Now'}
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={{
              padding: '10px 20px', background: showSettings ? '#666' : '#424242', color: 'white',
              border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14
            }}
          >
            ⚙️ Settings
          </button>
        </div>
      </div>

      {/* Messages */}
      {message && <div style={{ padding: '12px 16px', background: '#e8f5e9', color: '#2e7d32', borderRadius: 8, marginBottom: 15, fontWeight: 500 }}>{message}</div>}
      {error && <div style={{ padding: '12px 16px', background: '#ffebee', color: '#c62828', borderRadius: 8, marginBottom: 15, fontWeight: 500 }}>{error}</div>}

      {/* Settings Panel */}
      {showSettings && (
        <div style={{ background: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: 12, padding: 24, marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>⚙️ Shipping Settings</h3>

          {/* Shippo API Key */}
          <div style={{ marginBottom: 20, padding: 16, background: 'white', borderRadius: 8, border: '2px solid #1976d2' }}>
            <h4 style={{ margin: '0 0 10px', color: '#1976d2' }}>🔑 Shippo API Key</h4>
            <p style={{ margin: '0 0 10px', color: '#666', fontSize: 13 }}>
              Each organization needs their own Shippo account. 
              <a href="https://goshippo.com" target="_blank" rel="noopener noreferrer" style={{ color: '#1976d2', marginLeft: 4 }}>
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
                  flex: 1, padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc',
                  fontSize: 14, fontFamily: 'monospace'
                }}
              />
              <button
                onClick={() => setShowApiKey(!showApiKey)}
                style={{
                  padding: '10px 14px', background: '#f5f5f5', border: '1px solid #ccc',
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
            <p style={{ margin: '5px 0 0 30px', color: '#666', fontSize: 13 }}>
              When enabled, the system will automatically check for packed orders and generate shipping labels at the scheduled time.
            </p>
          </div>

          {/* Schedule Time */}
          <div style={{ marginBottom: 20, padding: 16, background: 'white', borderRadius: 8, border: '1px solid #e0e0e0' }}>
            <h4 style={{ margin: '0 0 10px' }}>⏰ Daily Check Time (EST)</h4>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <select value={checkHour} onChange={e => setCheckHour(parseInt(e.target.value))}
                style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15 }}>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{i === 0 ? '12' : i > 12 ? i - 12 : i}:00 {i >= 12 ? 'PM' : 'AM'}</option>
                ))}
              </select>
              <span style={{ color: '#666' }}>EST / Eastern Time</span>
            </div>
            <p style={{ margin: '8px 0 0', color: '#888', fontSize: 12 }}>
              The system checks for packed orders at this time every day. Orders with status "packed" that don't have labels yet will be processed.
            </p>
          </div>

          {/* Preferred Carrier */}
          <div style={{ marginBottom: 20, padding: 16, background: 'white', borderRadius: 8, border: '1px solid #e0e0e0' }}>
            <h4 style={{ margin: '0 0 10px' }}>📦 Preferred Carrier</h4>
            <select value={preferredCarrier} onChange={e => setPreferredCarrier(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, minWidth: 200 }}>
              <option value="ups">UPS</option>
              <option value="usps">USPS</option>
              <option value="fedex">FedEx</option>
              <option value="dhl">DHL</option>
            </select>
            <p style={{ margin: '8px 0 0', color: '#888', fontSize: 12 }}>
              When multiple rates are available, the system will prefer this carrier. Falls back to cheapest rate if unavailable.
            </p>
          </div>

          {/* Auto-Purchase */}
          <div style={{ marginBottom: 20, padding: 16, background: 'white', borderRadius: 8, border: '1px solid #e0e0e0' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={autoPurchase} onChange={e => setAutoPurchase(e.target.checked)}
                style={{ width: 18, height: 18 }} />
              <span style={{ fontWeight: 600 }}>Auto-Purchase Labels</span>
            </label>
            <p style={{ margin: '8px 0 0 28px', color: '#888', fontSize: 12 }}>
              ⚠️ When enabled, labels will be automatically purchased using your preferred carrier during the scheduled check. 
              When disabled, the system will fetch rates and you'll need to manually select and purchase each label.
            </p>
          </div>

          {/* From Address */}
          <div style={{ marginBottom: 20, padding: 16, background: 'white', borderRadius: 8, border: '1px solid #e0e0e0' }}>
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
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>{field.label}</label>
                  <input
                    value={fromAddress[field.key]}
                    onChange={e => setFromAddress(prev => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box' }}
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
              padding: '12px 30px', background: '#4CAF50', color: 'white', border: 'none',
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
          { label: 'Labels Ready', count: orders.filter(o => o.shippingLabel?.labelStatus === 'purchased').length, color: '#4CAF50', icon: '✅' },
          { label: 'Rates Pending', count: orders.filter(o => o.shippingLabel?.labelStatus === 'rates_ready').length, color: '#2196F3', icon: '💰' },
          { label: 'Errors', count: orders.filter(o => o.shippingLabel?.labelStatus === 'error' || o.shippingLabel?.labelStatus === 'failed').length, color: '#f44336', icon: '❌' },
          { label: 'Shipped', count: orders.filter(o => o.status === 'shipped').length, color: '#9c27b0', icon: '🚚' },
        ].map(card => (
          <div key={card.label} style={{
            background: 'white', borderRadius: 10, padding: 16, border: `2px solid ${card.color}20`,
            textAlign: 'center'
          }}>
            <div style={{ fontSize: 28 }}>{card.icon}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: card.color }}>{card.count}</div>
            <div style={{ fontSize: 12, color: '#666' }}>{card.label}</div>
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
              padding: '8px 16px', borderRadius: 20, border: '1px solid #ddd', cursor: 'pointer',
              background: filterStatus === f.value ? '#1976d2' : 'white',
              color: filterStatus === f.value ? 'white' : '#333',
              fontWeight: filterStatus === f.value ? 600 : 400, fontSize: 13
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Orders Table */}
      {filteredOrders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
          <p style={{ fontSize: 48 }}>📭</p>
          <p>No orders match this filter</p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ background: '#f5f5f5', textAlign: 'left' }}>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid #ddd' }}>PO #</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid #ddd' }}>Customer</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid #ddd' }}>Ship To</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid #ddd' }}>Packages</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid #ddd' }}>Label Status</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid #ddd' }}>Tracking</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid #ddd' }}>Cost</th>
                <th style={{ padding: '12px 10px', borderBottom: '2px solid #ddd' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map(order => {
                const badge = getStatusBadge(order);
                const label = order.shippingLabel;

                return (
                  <tr key={order.id} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: '12px 10px', fontWeight: 600 }}>{order.poNumber}</td>
                    <td style={{ padding: '12px 10px' }}>
                      <div>{order.customerName}</div>
                      {order.customerEmail && <div style={{ fontSize: 11, color: '#888' }}>{order.customerEmail}</div>}
                    </td>
                    <td style={{ padding: '12px 10px', fontSize: 12, maxWidth: 200 }}>
                      {order.shipToAddress || order.customerAddress || <span style={{ color: '#ccc' }}>No address</span>}
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                      {order.packingMode === 'triwalls'
                        ? `${order.triwalls?.length || 0} triwall${(order.triwalls?.length || 0) !== 1 ? 's' : ''}`
                        : `${Object.keys(order.boxDetails || {}).length || 1} box${Object.keys(order.boxDetails || {}).length !== 1 ? 'es' : ''}`
                      }
                    </td>
                    <td style={{ padding: '12px 10px' }}>
                      <span style={{
                        padding: '4px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
                        background: badge.bg, color: badge.color
                      }}>
                        {badge.text}
                      </span>
                      {label?.labelError && (
                        <div style={{ fontSize: 11, color: '#c62828', marginTop: 4 }}>{label.labelError}</div>
                      )}
                    </td>
                    <td style={{ padding: '12px 10px', fontSize: 12 }}>
                      {label?.trackingNumber ? (
                        <div>
                          <div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{label.trackingNumber}</div>
                          {label.trackingUrl && (
                            <a href={label.trackingUrl} target="_blank" rel="noopener noreferrer"
                              style={{ color: '#1976d2', fontSize: 11 }}>Track →</a>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: '#ccc' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 10px' }}>
                      {label?.selectedRate ? (
                        <div>
                          <div style={{ fontWeight: 600 }}>${label.selectedRate.amount}</div>
                          <div style={{ fontSize: 11, color: '#666' }}>
                            {label.selectedRate.provider} {label.selectedRate.servicelevel}
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: '#ccc' }}>—</span>
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
                              padding: '6px 12px', background: '#1976d2', color: 'white', border: 'none',
                              borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap'
                            }}
                          >
                            {processing[order.id] ? '...' : '💰 Get Rates'}
                          </button>
                        )}

                        {/* Rates ready - View & Purchase */}
                        {label?.labelStatus === 'rates_ready' && (
                          <button
                            onClick={() => setShowRates(showRates === order.id ? null : order.id)}
                            style={{
                              padding: '6px 12px', background: '#ff9800', color: 'white', border: 'none',
                              borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap'
                            }}
                          >
                            🏷️ Select Rate
                          </button>
                        )}

                        {/* Label purchased - Print & Ship */}
                        {label?.labelStatus === 'purchased' && (
                          <>
                            <a
                              href={label.labelUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                padding: '6px 12px', background: '#4CAF50', color: 'white', border: 'none',
                                borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, textDecoration: 'none',
                                display: 'inline-block', whiteSpace: 'nowrap'
                              }}
                            >
                              🖨️ Print Label
                            </a>
                            {order.status === 'packed' && (
                              <button
                                onClick={() => markShipped(order.id)}
                                style={{
                                  padding: '6px 12px', background: '#9c27b0', color: 'white', border: 'none',
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
                              padding: '6px 12px', background: '#f44336', color: 'white', border: 'none',
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
                              padding: '6px 12px', background: '#607d8b', color: 'white', border: 'none',
                              borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap'
                            }}
                          >
                            {processing[order.id] ? '...' : '⚡ Auto Label'}
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

            // Filter rates
            const filteredRates = rateFilterCarrier === 'all' 
              ? allRates 
              : allRates.filter(r => r.provider.toLowerCase().includes(rateFilterCarrier.toLowerCase()));

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
                background: '#fafafa', border: '2px solid #1976d2', borderRadius: 12,
                padding: 20, marginTop: 10, marginBottom: 10
              }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15, flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <h4 style={{ margin: 0 }}>💰 Shipping Rates for {order.poNumber}</h4>
                    <span style={{ fontSize: 12, color: '#666' }}>
                      {allRates.length} rate{allRates.length !== 1 ? 's' : ''} from {carriers.length} carrier{carriers.length !== 1 ? 's' : ''}
                      {' • '}{order.customerName} → {order.shipToAddress || order.customerAddress || 'N/A'}
                    </span>
                  </div>
                  <button onClick={() => { setShowRates(null); setRateFilterCarrier('all'); }} style={{
                    background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#999', padding: '0 4px'
                  }}>✕</button>
                </div>

                {/* Quick Stats */}
                <div style={{ display: 'flex', gap: 12, marginBottom: 15, flexWrap: 'wrap' }}>
                  {cheapest && (
                    <div style={{ padding: '8px 14px', background: '#e8f5e9', borderRadius: 8, fontSize: 13 }}>
                      💚 Cheapest: <strong>${cheapest.amount}</strong> ({cheapest.provider} {cheapest.servicelevel})
                    </div>
                  )}
                  {fastest && fastest.rateId !== cheapest?.rateId && (
                    <div style={{ padding: '8px 14px', background: '#e3f2fd', borderRadius: 8, fontSize: 13 }}>
                      ⚡ Fastest: <strong>{fastest.estimatedDays} day{fastest.estimatedDays !== 1 ? 's' : ''}</strong> — ${fastest.amount} ({fastest.provider} {fastest.servicelevel})
                    </div>
                  )}
                </div>

                {/* Filter & Sort Controls */}
                <div style={{ display: 'flex', gap: 10, marginBottom: 15, flexWrap: 'wrap', alignItems: 'center' }}>
                  {/* Sort */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#555' }}>Sort:</span>
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
                          padding: '5px 12px', borderRadius: 16, border: '1px solid #ddd', cursor: 'pointer',
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
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#555' }}>Carrier:</span>
                    <button
                      onClick={() => setRateFilterCarrier('all')}
                      style={{
                        padding: '5px 12px', borderRadius: 16, border: '1px solid #ddd', cursor: 'pointer',
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
                            padding: '5px 12px', borderRadius: 16, border: '1px solid #ddd', cursor: 'pointer',
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

                  {/* View Toggle */}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    <button onClick={() => setRateViewMode('table')} style={{
                      padding: '5px 10px', border: '1px solid #ddd', borderRadius: '6px 0 0 6px', cursor: 'pointer',
                      background: rateViewMode === 'table' ? '#424242' : 'white', color: rateViewMode === 'table' ? 'white' : '#333', fontSize: 12
                    }}>☰ Table</button>
                    <button onClick={() => setRateViewMode('cards')} style={{
                      padding: '5px 10px', border: '1px solid #ddd', borderRadius: '0 6px 6px 0', cursor: 'pointer',
                      background: rateViewMode === 'cards' ? '#424242' : 'white', color: rateViewMode === 'cards' ? 'white' : '#333', fontSize: 12
                    }}>▦ Cards</button>
                  </div>
                </div>

                {/* Table View */}
                {rateViewMode === 'table' ? (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: '#e8eaf6', textAlign: 'left' }}>
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
                              borderBottom: '1px solid #eee',
                              background: isCheapest ? '#f1f8e9' : isFastest ? '#e8f4fd' : idx % 2 === 0 ? 'white' : '#fafafa',
                            }}>
                              <td style={{ padding: '10px 12px', fontWeight: 600 }}>{rate.provider}</td>
                              <td style={{ padding: '10px 12px' }}>{rate.servicelevel}</td>
                              <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontSize: 15, color: '#1976d2' }}>
                                ${rate.amount}
                              </td>
                              <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                                {rate.estimatedDays
                                  ? `${rate.estimatedDays} day${rate.estimatedDays !== 1 ? 's' : ''}`
                                  : <span style={{ color: '#ccc' }}>—</span>
                                }
                              </td>
                              <td style={{ padding: '10px 12px' }}>
                                {isCheapest && <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>CHEAPEST</span>}
                                {isFastest && <span style={{ background: '#2196F3', color: 'white', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>FASTEST</span>}
                              </td>
                              <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                                <button
                                  onClick={() => purchaseRate(order.id, rate.rateId)}
                                  disabled={processing[order.id]}
                                  style={{
                                    padding: '6px 16px', background: '#4CAF50', color: 'white',
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
                      <div style={{ textAlign: 'center', padding: 20, color: '#999' }}>No rates match this filter</div>
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
                            background: 'white', borderRadius: 8, padding: 14,
                            border: isCheapest ? '2px solid #4CAF50' : isFastest ? '2px solid #2196F3' : '1px solid #ddd',
                            position: 'relative'
                          }}
                        >
                          {isCheapest && <div style={{ position: 'absolute', top: -8, right: 10, background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600 }}>CHEAPEST</div>}
                          {isFastest && <div style={{ position: 'absolute', top: -8, right: 10, background: '#2196F3', color: 'white', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600 }}>FASTEST</div>}
                          <div style={{ fontWeight: 700, fontSize: 20, color: '#1976d2' }}>${rate.amount}</div>
                          <div style={{ fontWeight: 600, marginTop: 4 }}>{rate.provider}</div>
                          <div style={{ fontSize: 12, color: '#666' }}>{rate.servicelevel}</div>
                          {rate.estimatedDays && (
                            <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                              Est. {rate.estimatedDays} day{rate.estimatedDays !== 1 ? 's' : ''}
                            </div>
                          )}
                          <button
                            onClick={() => purchaseRate(order.id, rate.rateId)}
                            disabled={processing[order.id]}
                            style={{
                              marginTop: 10, padding: '6px 14px', background: '#4CAF50', color: 'white',
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
                      <div style={{ textAlign: 'center', padding: 20, color: '#999', gridColumn: '1 / -1' }}>No rates match this filter</div>
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
