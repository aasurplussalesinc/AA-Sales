import { useState, useEffect, useRef } from 'react';
import { OrgDB as DB } from '../orgDb';
import { useAuth } from '../OrgAuthContext';

export default function Contracts() {
  const { userRole } = useAuth();
  const isAdmin = userRole === 'admin';
  const isManager = userRole === 'manager';
  const canEdit = isAdmin || isManager;

  const [contracts, setContracts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedContract, setSelectedContract] = useState(null);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all'); // all, active, expired
  const fileInputRef = useRef(null);
  const [importing, setImporting] = useState(false);

  // Form state
  const [form, setForm] = useState({
    contractNumber: '',
    vendor: '',
    vendorContact: '',
    vendorEmail: '',
    vendorPhone: '',
    costPerLb: '',
    startDate: '',
    endDate: '',
    description: '',
    notes: '',
    truckCount: 0,
    totalWeight: 0,
    totalCost: 0
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const data = await DB.getContracts();
    setContracts(data);
    setLoading(false);
  };

  const resetForm = () => {
    setForm({
      contractNumber: '',
      vendor: '',
      vendorContact: '',
      vendorEmail: '',
      vendorPhone: '',
      costPerLb: '',
      startDate: '',
      endDate: '',
      description: '',
      notes: '',
      truckCount: 0,
      totalWeight: 0,
      totalCost: 0
    });
  };

  const selectContract = (contract) => {
    setSelectedContract(contract);
    setForm({
      contractNumber: contract.contractNumber || '',
      vendor: contract.vendor || '',
      vendorContact: contract.vendorContact || '',
      vendorEmail: contract.vendorEmail || '',
      vendorPhone: contract.vendorPhone || '',
      costPerLb: contract.costPerLb?.toString() || '',
      startDate: contract.startDate || '',
      endDate: contract.endDate || '',
      description: contract.description || '',
      notes: contract.notes || '',
      truckCount: contract.truckCount || 0,
      totalWeight: contract.totalWeight || 0,
      totalCost: contract.totalCost || 0
    });
  };

  const saveContract = async () => {
    if (!form.contractNumber || !form.vendor) {
      alert('Contract number and vendor are required');
      return;
    }

    const contractData = {
      ...form,
      costPerLb: parseFloat(form.costPerLb) || 0,
      truckCount: parseInt(form.truckCount) || 0,
      totalWeight: parseFloat(form.totalWeight) || 0,
      totalCost: parseFloat(form.totalCost) || 0
    };

    if (selectedContract) {
      await DB.updateContract(selectedContract.id, contractData);
    } else {
      await DB.createContract(contractData);
    }

    setShowCreate(false);
    setSelectedContract(null);
    resetForm();
    loadData();
  };

  const deleteContract = async (contract) => {
    if (!window.confirm(`Delete contract ${contract.contractNumber}? This cannot be undone.`)) {
      return;
    }
    await DB.deleteContract(contract.id);
    setSelectedContract(null);
    loadData();
  };

  const getContractStatus = (contract) => {
    if (!contract.startDate || !contract.endDate) return 'unknown';
    const now = new Date();
    const start = new Date(contract.startDate);
    const end = new Date(contract.endDate);
    
    if (now < start) return 'upcoming';
    if (now > end) return 'expired';
    return 'active';
  };

  const getStatusBadge = (status) => {
    const styles = {
      active: { background: '#4CAF50', color: 'white' },
      expired: { background: '#f44336', color: 'white' },
      upcoming: { background: '#2196F3', color: 'white' },
      unknown: { background: '#9e9e9e', color: 'white' }
    };
    return (
      <span style={{
        ...styles[status],
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase'
      }}>
        {status}
      </span>
    );
  };

  // Filter and search
  const filteredContracts = contracts.filter(c => {
    const matchesSearch = !search || 
      c.contractNumber?.toLowerCase().includes(search.toLowerCase()) ||
      c.vendor?.toLowerCase().includes(search.toLowerCase());
    
    const status = getContractStatus(c);
    const matchesStatus = filterStatus === 'all' || status === filterStatus;
    
    return matchesSearch && matchesStatus;
  });

  // CSV Import
  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setImporting(true);
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target.result;
        const lines = text.split('\n').filter(line => line.trim());
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, ''));

        let imported = 0;
        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',').map(v => v.trim());
          if (values.length < 2) continue;

          const contractData = {
            contractNumber: values[headers.indexOf('contractnumber')] || values[0] || '',
            vendor: values[headers.indexOf('vendor')] || values[1] || '',
            vendorContact: values[headers.indexOf('vendorcontact')] || values[2] || '',
            vendorEmail: values[headers.indexOf('vendoremail')] || values[3] || '',
            vendorPhone: values[headers.indexOf('vendorphone')] || values[4] || '',
            costPerLb: parseFloat(values[headers.indexOf('costperlb')] || values[5]) || 0,
            startDate: values[headers.indexOf('startdate')] || values[6] || '',
            endDate: values[headers.indexOf('enddate')] || values[7] || '',
            description: values[headers.indexOf('description')] || values[8] || '',
            notes: values[headers.indexOf('notes')] || values[9] || ''
          };

          if (contractData.contractNumber && contractData.vendor) {
            await DB.createContract(contractData);
            imported++;
          }
        }

        alert(`Imported ${imported} contracts`);
        loadData();
      } catch (err) {
        console.error('Import error:', err);
        alert('Error importing file: ' + err.message);
      }
      setImporting(false);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // CSV Export
  const exportToCSV = () => {
    const headers = ['Contract Number', 'Vendor', 'Vendor Contact', 'Vendor Email', 'Vendor Phone', 'Cost Per Lb', 'Start Date', 'End Date', 'Status', 'Description', 'Notes'];
    const rows = contracts.map(c => [
      c.contractNumber,
      c.vendor,
      c.vendorContact || '',
      c.vendorEmail || '',
      c.vendorPhone || '',
      c.costPerLb || '',
      c.startDate || '',
      c.endDate || '',
      getContractStatus(c),
      c.description || '',
      c.notes || ''
    ]);

    const csv = [headers, ...rows].map(row => row.map(cell => `"${(cell || '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contracts-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  // Download template
  const downloadTemplate = () => {
    const headers = ['Contract Number', 'Vendor', 'Vendor Contact', 'Vendor Email', 'Vendor Phone', 'Cost Per Lb', 'Start Date', 'End Date', 'Description', 'Notes'];
    const example = ['SP4500-24-C-0042', 'DLA Disposition Services East', 'John Smith', 'john.smith@dla.mil', '555-123-4567', '0.05', '2024-01-01', '2024-12-31', 'FY24 Surplus Contract', 'Triwalls from Fort Bragg'];
    
    const csv = [headers, example].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contracts-template.csv';
    a.click();
  };

  if (loading) {
    return <div className="container" style={{ padding: 20 }}>Loading contracts...</div>;
  }

  return (
    <div className="container" style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0 }}>📄 Contracts</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            type="file"
            accept=".csv"
            onChange={handleImport}
            ref={fileInputRef}
            style={{ display: 'none' }}
          />
          <button
            className="btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            style={{ background: '#17a2b8', color: 'white' }}
          >
            {importing ? '⏳ Importing...' : '📤 Import CSV'}
          </button>
          <button
            className="btn"
            onClick={downloadTemplate}
            style={{ background: '#6c757d', color: 'white' }}
          >
            📋 Template
          </button>
          <button
            className="btn"
            onClick={exportToCSV}
            style={{ background: '#28a745', color: 'white' }}
          >
            📥 Export CSV
          </button>
          {canEdit && (
            <button className="btn btn-primary" onClick={() => { resetForm(); setShowCreate(true); setSelectedContract(null); }}>
              + New Contract
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Search contracts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 4, border: '1px solid #ddd', minWidth: 200 }}
        />
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 4, border: '1px solid #ddd' }}
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="upcoming">Upcoming</option>
        </select>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 15, marginBottom: 20 }}>
        <div style={{ background: '#e3f2fd', padding: 15, borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 24, fontWeight: 'bold', color: '#1976d2' }}>{contracts.length}</div>
          <div style={{ fontSize: 12, color: '#666' }}>Total Contracts</div>
        </div>
        <div style={{ background: '#e8f5e9', padding: 15, borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 24, fontWeight: 'bold', color: '#388e3c' }}>
            {contracts.filter(c => getContractStatus(c) === 'active').length}
          </div>
          <div style={{ fontSize: 12, color: '#666' }}>Active</div>
        </div>
        <div style={{ background: '#fff3e0', padding: 15, borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 24, fontWeight: 'bold', color: '#f57c00' }}>
            ${contracts.filter(c => getContractStatus(c) === 'active').reduce((sum, c) => sum + (c.costPerLb || 0), 0).toFixed(2)}
          </div>
          <div style={{ fontSize: 12, color: '#666' }}>Avg $/lb (Active)</div>
        </div>
      </div>

      {/* Contracts Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white', borderRadius: 8, overflow: 'hidden' }}>
          <thead>
            <tr style={{ background: '#f5f5f5' }}>
              <th style={{ padding: 12, textAlign: 'left', borderBottom: '2px solid #ddd' }}>Contract #</th>
              <th style={{ padding: 12, textAlign: 'left', borderBottom: '2px solid #ddd' }}>Vendor</th>
              <th style={{ padding: 12, textAlign: 'right', borderBottom: '2px solid #ddd' }}>$/lb</th>
              <th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid #ddd' }}>Dates</th>
              <th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid #ddd' }}>Status</th>
              <th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid #ddd' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredContracts.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: 40, textAlign: 'center', color: '#999' }}>
                  No contracts found. Click "+ New Contract" to add one.
                </td>
              </tr>
            ) : (
              filteredContracts.map(contract => {
                const status = getContractStatus(contract);
                return (
                  <tr 
                    key={contract.id} 
                    style={{ borderBottom: '1px solid #eee', cursor: 'pointer' }}
                    onClick={() => selectContract(contract)}
                  >
                    <td style={{ padding: 12, fontWeight: 500 }}>{contract.contractNumber}</td>
                    <td style={{ padding: 12 }}>
                      <div>{contract.vendor}</div>
                      {contract.vendorContact && (
                        <div style={{ fontSize: 12, color: '#666' }}>{contract.vendorContact}</div>
                      )}
                    </td>
                    <td style={{ padding: 12, textAlign: 'right', fontWeight: 600, color: '#2196F3' }}>
                      ${(contract.costPerLb || 0).toFixed(2)}
                    </td>
                    <td style={{ padding: 12, textAlign: 'center', fontSize: 13 }}>
                      {contract.startDate && contract.endDate ? (
                        <>{contract.startDate} → {contract.endDate}</>
                      ) : (
                        <span style={{ color: '#999' }}>No dates set</span>
                      )}
                    </td>
                    <td style={{ padding: 12, textAlign: 'center' }}>
                      {getStatusBadge(status)}
                    </td>
                    <td style={{ padding: 12, textAlign: 'center' }}>
                      <button
                        className="btn"
                        onClick={(e) => { e.stopPropagation(); selectContract(contract); }}
                        style={{ padding: '4px 8px', fontSize: 12 }}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Create/Edit Modal */}
      {(showCreate || selectedContract) && (
        <div className="modal-overlay" onClick={() => { setShowCreate(false); setSelectedContract(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <div className="modal-header">
              <h3 style={{ margin: 0 }}>{selectedContract ? 'Contract Details' : 'New Contract'}</h3>
              <button className="modal-close" onClick={() => { setShowCreate(false); setSelectedContract(null); }}>×</button>
            </div>
            <div className="modal-body" style={{ padding: 20 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>
                <div>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 500 }}>Contract Number *</label>
                  <input
                    type="text"
                    value={form.contractNumber}
                    onChange={(e) => setForm({ ...form, contractNumber: e.target.value })}
                    placeholder="SP4500-24-C-0042"
                    style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #ddd' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 500 }}>Cost per Lb *</label>
                  <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#666' }}>$</span>
                    <input
                      type="number"
                      step="0.01"
                      value={form.costPerLb}
                      onChange={(e) => setForm({ ...form, costPerLb: e.target.value })}
                      placeholder="0.05"
                      style={{ width: '100%', padding: 8, paddingLeft: 25, borderRadius: 4, border: '1px solid #ddd' }}
                    />
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 15 }}>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 500 }}>Vendor *</label>
                <input
                  type="text"
                  value={form.vendor}
                  onChange={(e) => setForm({ ...form, vendor: e.target.value })}
                  placeholder="DLA Disposition Services East"
                  style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #ddd' }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 15, marginTop: 15 }}>
                <div>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 500 }}>Contact Name</label>
                  <input
                    type="text"
                    value={form.vendorContact}
                    onChange={(e) => setForm({ ...form, vendorContact: e.target.value })}
                    placeholder="John Smith"
                    style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #ddd' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 500 }}>Email</label>
                  <input
                    type="email"
                    value={form.vendorEmail}
                    onChange={(e) => setForm({ ...form, vendorEmail: e.target.value })}
                    placeholder="john@dla.mil"
                    style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #ddd' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 500 }}>Phone</label>
                  <input
                    type="tel"
                    value={form.vendorPhone}
                    onChange={(e) => setForm({ ...form, vendorPhone: e.target.value })}
                    placeholder="555-123-4567"
                    style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #ddd' }}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15, marginTop: 15 }}>
                <div>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 500 }}>Start Date</label>
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                    style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #ddd' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 500 }}>End Date</label>
                  <input
                    type="date"
                    value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                    style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #ddd' }}
                  />
                </div>
              </div>

              <div style={{ marginTop: 15 }}>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 500 }}>Description</label>
                <input
                  type="text"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="FY24 Surplus Contract - Triwalls from Fort Bragg"
                  style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #ddd' }}
                />
              </div>

              <div style={{ marginTop: 15 }}>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 500 }}>Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Any additional notes about this contract..."
                  rows={3}
                  style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #ddd', resize: 'vertical' }}
                />
              </div>

              {selectedContract && (
                <div style={{ marginTop: 20, padding: 15, background: '#f5f5f5', borderRadius: 8 }}>
                  <h4 style={{ margin: '0 0 10px 0' }}>Contract Stats</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, fontSize: 14 }}>
                    <div>
                      <div style={{ color: '#666' }}>Status</div>
                      <div>{getStatusBadge(getContractStatus(selectedContract))}</div>
                    </div>
                    <div>
                      <div style={{ color: '#666' }}>Quick Sales</div>
                      <div style={{ fontWeight: 600 }}>{selectedContract.quickSaleCount || 0}</div>
                    </div>
                    <div>
                      <div style={{ color: '#666' }}>Total Revenue</div>
                      <div style={{ fontWeight: 600, color: '#4CAF50' }}>${(selectedContract.totalRevenue || 0).toFixed(2)}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', padding: 15, borderTop: '1px solid #eee' }}>
              <div>
                {selectedContract && canEdit && (
                  <button
                    className="btn"
                    onClick={() => deleteContract(selectedContract)}
                    style={{ background: '#f44336', color: 'white' }}
                  >
                    🗑️ Delete
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn" onClick={() => { setShowCreate(false); setSelectedContract(null); }}>
                  Cancel
                </button>
                {canEdit && (
                  <button className="btn btn-primary" onClick={saveContract}>
                    {selectedContract ? 'Save Changes' : 'Create Contract'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
