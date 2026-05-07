import React, { useState } from 'react';
import { useAuth } from '../OrgAuthContext';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

export default function ExportData() {
  const { organization } = useAuth();
  const [exporting, setExporting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const downloadCSV = (filename, content) => {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleExport = async () => {
    if (!organization) return;
    setExporting(true);
    setError('');
    setSuccess(false);

    try {
      const exportFn = httpsCallable(functions, 'exportOrgData');
      const result = await exportFn({ orgId: organization.id });
      const csvData = result.data.csvData;

      const dateStr = new Date().toISOString().split('T')[0];
      const safeName = (organization.name || 'skidsling').replace(/[^a-z0-9]/gi, '_').toLowerCase();

      // Download each CSV separately
      if (csvData.items) downloadCSV(`${safeName}_items_${dateStr}.csv`, csvData.items);
      if (csvData.customers) downloadCSV(`${safeName}_customers_${dateStr}.csv`, csvData.customers);
      if (csvData.locations) downloadCSV(`${safeName}_locations_${dateStr}.csv`, csvData.locations);
      if (csvData.orders) downloadCSV(`${safeName}_orders_${dateStr}.csv`, csvData.orders);

      setSuccess(true);
    } catch (e) {
      console.error(e);
      setError(e.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{ maxWidth: 700, margin: '40px auto', padding: 20 }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>📥 Export Your Data</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: 24 }}>
        Download all your SkidSling data as CSV files. You can open these in Excel, Google Sheets, or import them into any other system.
      </p>

      <div style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 24,
        marginBottom: 20
      }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>What gets exported:</h3>
        <ul style={{ color: 'var(--text-primary)', lineHeight: 1.8, marginLeft: 20, marginBottom: 0 }}>
          <li><strong>Items</strong> — all inventory with SKUs, quantities, prices, costs, locations</li>
          <li><strong>Customers</strong> — contact info, addresses, phone numbers</li>
          <li><strong>Locations</strong> — warehouse, rack, bay, shelf details</li>
          <li><strong>Purchase Orders</strong> — order summaries, totals, customer PO numbers</li>
        </ul>
      </div>

      <button
        onClick={handleExport}
        disabled={exporting}
        style={{
          width: '100%',
          padding: '14px 28px',
          background: exporting ? 'var(--btn-secondary-bg)' : '#0d7a52',
          color: 'white',
          border: 'none',
          borderRadius: 8,
          fontWeight: 700,
          fontSize: 15,
          cursor: exporting ? 'wait' : 'pointer',
          transition: 'opacity 0.2s'
        }}
      >
        {exporting ? '⏳ Exporting…' : '📥 Download All My Data'}
      </button>

      {success && (
        <div style={{
          marginTop: 16,
          padding: '12px 16px',
          background: 'rgba(76,175,80,0.1)',
          border: '1px solid #4CAF50',
          color: '#2e7d32',
          borderRadius: 8,
          fontSize: 14
        }}>
          ✅ Export complete! Check your downloads folder for the CSV files.
        </div>
      )}

      {error && (
        <div style={{
          marginTop: 16,
          padding: '12px 16px',
          background: 'rgba(244,67,54,0.1)',
          border: '1px solid #f44336',
          color: '#c62828',
          borderRadius: 8,
          fontSize: 14
        }}>
          ❌ {error}
        </div>
      )}

      <div style={{
        marginTop: 24,
        padding: 16,
        background: 'var(--bg-surface-2)',
        borderRadius: 8,
        fontSize: 13,
        color: 'var(--text-muted)'
      }}>
        <strong>Note:</strong> Your data is stored in your account for 30 days after your trial expires. After that, it will be permanently deleted. Export anytime within those 30 days to keep a copy.
      </div>
    </div>
  );
}
