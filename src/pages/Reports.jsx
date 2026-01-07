import { useState, useEffect } from 'react';
import { DB } from '../db';

export default function Reports() {
  const [activeTab, setActiveTab] = useState('deadstock');
  const [loading, setLoading] = useState(false);
  
  // Dead Stock
  const [deadStockDays, setDeadStockDays] = useState(90);
  const [deadStock, setDeadStock] = useState([]);
  
  // Inventory Turnover
  const [turnoverDays, setTurnoverDays] = useState(30);
  const [turnover, setTurnover] = useState([]);
  
  // Custom Report
  const [customFilters, setCustomFilters] = useState({
    dateFrom: '',
    dateTo: '',
    type: '',
    user: ''
  });
  const [customData, setCustomData] = useState([]);
  const [movements, setMovements] = useState([]);

  useEffect(() => {
    loadMovements();
  }, []);

  const loadMovements = async () => {
    const data = await DB.getMovements();
    setMovements(data);
  };

  const loadDeadStock = async () => {
    setLoading(true);
    const data = await DB.getDeadStock(deadStockDays);
    setDeadStock(data);
    setLoading(false);
  };

  const loadTurnover = async () => {
    setLoading(true);
    const data = await DB.getInventoryTurnover(turnoverDays);
    setTurnover(data);
    setLoading(false);
  };

  const generateCustomReport = () => {
    let filtered = [...movements];
    
    if (customFilters.dateFrom) {
      const from = new Date(customFilters.dateFrom).getTime();
      filtered = filtered.filter(m => m.timestamp >= from);
    }
    
    if (customFilters.dateTo) {
      const to = new Date(customFilters.dateTo).setHours(23, 59, 59, 999);
      filtered = filtered.filter(m => m.timestamp <= to);
    }
    
    if (customFilters.type) {
      filtered = filtered.filter(m => m.type === customFilters.type);
    }
    
    if (customFilters.user) {
      filtered = filtered.filter(m => m.userEmail === customFilters.user);
    }
    
    setCustomData(filtered);
  };

  const exportToCSV = (data, filename, headers, rowMapper) => {
    const csvContent = [
      headers.join(','),
      ...data.map(item => rowMapper(item).map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportDeadStock = () => {
    exportToCSV(
      deadStock,
      'dead-stock-report',
      ['SKU', 'Item Name', 'Category', 'Current Stock', 'Days Since Movement', 'Last Movement Date'],
      (item) => [
        item.partNumber || '',
        item.name || '',
        item.category || '',
        item.stock || 0,
        item.daysSinceMovement,
        item.lastMovement ? new Date(item.lastMovement).toLocaleDateString() : 'Never'
      ]
    );
  };

  const exportTurnover = () => {
    exportToCSV(
      turnover,
      'inventory-turnover-report',
      ['SKU', 'Item Name', 'Current Stock', 'Total Picked', 'Total Added', 'Total Moved', 'Movement Count'],
      (item) => [
        item.partNumber || '',
        item.name || '',
        item.stock || 0,
        item.totalPicked,
        item.totalAdded,
        item.totalMoved,
        item.movementCount
      ]
    );
  };

  const exportCustom = () => {
    exportToCSV(
      customData,
      'custom-report',
      ['Date', 'Type', 'Item', 'Quantity', 'From', 'To', 'User'],
      (m) => [
        new Date(m.timestamp).toLocaleString(),
        m.type,
        m.itemName || '',
        m.quantity || 0,
        m.fromLocation || '-',
        m.toLocation || '-',
        m.userEmail || ''
      ]
    );
  };

  // Get unique values for filters
  const users = [...new Set(movements.map(m => m.userEmail).filter(Boolean))].sort();
  const types = [...new Set(movements.map(m => m.type).filter(Boolean))].sort();

  const formatDate = (timestamp) => {
    if (!timestamp) return 'Never';
    return new Date(timestamp).toLocaleDateString();
  };

  const tabs = [
    { id: 'deadstock', label: '💀 Dead Stock' },
    { id: 'turnover', label: '📈 Inventory Turnover' },
    { id: 'custom', label: '📋 Custom Report' }
  ];

  return (
    <div className="page-content">
      <h2 style={{ marginBottom: 20 }}>Reports</h2>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 5, marginBottom: 20, borderBottom: '2px solid #eee', paddingBottom: 10 }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '10px 20px',
              border: 'none',
              background: activeTab === tab.id ? '#2d5f3f' : '#e0e0e0',
              color: activeTab === tab.id ? 'white' : '#333',
              borderRadius: '6px 6px 0 0',
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Dead Stock Tab */}
      {activeTab === 'deadstock' && (
        <div>
          <div style={{ background: 'white', padding: 20, borderRadius: 8, marginBottom: 20 }}>
            <h3 style={{ marginBottom: 15 }}>Dead Stock Report</h3>
            <p style={{ color: '#666', marginBottom: 15 }}>
              Items with no movement in the specified number of days.
            </p>
            
            <div style={{ display: 'flex', gap: 15, alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <label style={{ marginRight: 10 }}>Days without movement:</label>
                <select
                  className="form-input"
                  value={deadStockDays}
                  onChange={e => setDeadStockDays(parseInt(e.target.value))}
                  style={{ width: 100 }}
                >
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                  <option value={180}>180 days</option>
                  <option value={365}>1 year</option>
                </select>
              </div>
              
              <button className="btn btn-primary" onClick={loadDeadStock} disabled={loading}>
                {loading ? 'Loading...' : 'Generate Report'}
              </button>
              
              {deadStock.length > 0 && (
                <button className="btn" onClick={exportDeadStock} style={{ background: '#17a2b8', color: 'white' }}>
                  📥 Export CSV
                </button>
              )}
            </div>
          </div>

          {deadStock.length > 0 && (
            <div className="data-table">
              <p style={{ marginBottom: 10, color: '#666' }}>
                Found <strong>{deadStock.length}</strong> items with no movement in {deadStockDays}+ days
              </p>
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Item Name</th>
                    <th>Category</th>
                    <th>Stock</th>
                    <th>Days Since Movement</th>
                    <th>Last Movement</th>
                  </tr>
                </thead>
                <tbody>
                  {deadStock.map(item => (
                    <tr key={item.id}>
                      <td>{item.partNumber}</td>
                      <td>{item.name}</td>
                      <td>{item.category || '-'}</td>
                      <td>{item.stock || 0}</td>
                      <td style={{ 
                        color: item.daysSinceMovement === 'Never' || item.daysSinceMovement > 180 ? '#f44336' : '#ff9800',
                        fontWeight: 600
                      }}>
                        {item.daysSinceMovement}
                      </td>
                      <td>{formatDate(item.lastMovement)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Inventory Turnover Tab */}
      {activeTab === 'turnover' && (
        <div>
          <div style={{ background: 'white', padding: 20, borderRadius: 8, marginBottom: 20 }}>
            <h3 style={{ marginBottom: 15 }}>Inventory Turnover Report</h3>
            <p style={{ color: '#666', marginBottom: 15 }}>
              See which items are moving fastest (most picked) and slowest.
            </p>
            
            <div style={{ display: 'flex', gap: 15, alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <label style={{ marginRight: 10 }}>Time period:</label>
                <select
                  className="form-input"
                  value={turnoverDays}
                  onChange={e => setTurnoverDays(parseInt(e.target.value))}
                  style={{ width: 100 }}
                >
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                </select>
              </div>
              
              <button className="btn btn-primary" onClick={loadTurnover} disabled={loading}>
                {loading ? 'Loading...' : 'Generate Report'}
              </button>
              
              {turnover.length > 0 && (
                <button className="btn" onClick={exportTurnover} style={{ background: '#17a2b8', color: 'white' }}>
                  📥 Export CSV
                </button>
              )}
            </div>
          </div>

          {turnover.length > 0 && (
            <div className="data-table">
              <p style={{ marginBottom: 10, color: '#666' }}>
                Showing movement stats for the last {turnoverDays} days
              </p>
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Item Name</th>
                    <th>Stock</th>
                    <th>Picked</th>
                    <th>Added</th>
                    <th>Moved</th>
                    <th>Total Movements</th>
                  </tr>
                </thead>
                <tbody>
                  {turnover.slice(0, 100).map((item, idx) => (
                    <tr key={item.id}>
                      <td>{item.partNumber}</td>
                      <td>
                        {idx < 3 && item.totalPicked > 0 && <span style={{ marginRight: 5 }}>🏆</span>}
                        {item.name}
                      </td>
                      <td>{item.stock || 0}</td>
                      <td style={{ color: '#f44336', fontWeight: item.totalPicked > 0 ? 600 : 400 }}>
                        {item.totalPicked}
                      </td>
                      <td style={{ color: '#4CAF50' }}>{item.totalAdded}</td>
                      <td style={{ color: '#2196F3' }}>{item.totalMoved}</td>
                      <td>{item.movementCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Custom Report Tab */}
      {activeTab === 'custom' && (
        <div>
          <div style={{ background: 'white', padding: 20, borderRadius: 8, marginBottom: 20 }}>
            <h3 style={{ marginBottom: 15 }}>Custom Report Builder</h3>
            <p style={{ color: '#666', marginBottom: 15 }}>
              Filter movements by date range, type, and user.
            </p>
            
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 15,
              marginBottom: 15
            }}>
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>From Date</label>
                <input
                  type="date"
                  className="form-input"
                  value={customFilters.dateFrom}
                  onChange={e => setCustomFilters({ ...customFilters, dateFrom: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>To Date</label>
                <input
                  type="date"
                  className="form-input"
                  value={customFilters.dateTo}
                  onChange={e => setCustomFilters({ ...customFilters, dateTo: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Type</label>
                <select
                  className="form-input"
                  value={customFilters.type}
                  onChange={e => setCustomFilters({ ...customFilters, type: e.target.value })}
                  style={{ width: '100%' }}
                >
                  <option value="">All Types</option>
                  {types.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>User</label>
                <select
                  className="form-input"
                  value={customFilters.user}
                  onChange={e => setCustomFilters({ ...customFilters, user: e.target.value })}
                  style={{ width: '100%' }}
                >
                  <option value="">All Users</option>
                  {users.map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>
            
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={generateCustomReport}>
                Generate Report
              </button>
              
              {customData.length > 0 && (
                <button className="btn" onClick={exportCustom} style={{ background: '#17a2b8', color: 'white' }}>
                  📥 Export CSV
                </button>
              )}
              
              <button 
                className="btn" 
                onClick={() => {
                  setCustomFilters({ dateFrom: '', dateTo: '', type: '', user: '' });
                  setCustomData([]);
                }}
                style={{ background: '#6c757d', color: 'white' }}
              >
                Clear
              </button>
            </div>
          </div>

          {customData.length > 0 && (
            <div className="data-table">
              <p style={{ marginBottom: 10, color: '#666' }}>
                Found <strong>{customData.length}</strong> movements
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Item</th>
                    <th>Quantity</th>
                    <th>From</th>
                    <th>To</th>
                    <th>User</th>
                  </tr>
                </thead>
                <tbody>
                  {customData.slice(0, 200).map(m => (
                    <tr key={m.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{new Date(m.timestamp).toLocaleString()}</td>
                      <td>
                        <span style={{
                          padding: '3px 8px',
                          borderRadius: 4,
                          fontSize: 11,
                          fontWeight: 600,
                          background: m.type === 'PICK' ? '#f44336' : m.type === 'ADD' ? '#4CAF50' : '#2196F3',
                          color: 'white'
                        }}>
                          {m.type}
                        </span>
                      </td>
                      <td>{m.itemName}</td>
                      <td>{m.quantity}</td>
                      <td>{m.fromLocation || '-'}</td>
                      <td>{m.toLocation || '-'}</td>
                      <td style={{ fontSize: 12 }}>{m.userEmail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {customData.length > 200 && (
                <p style={{ padding: 10, color: '#666', textAlign: 'center' }}>
                  Showing first 200 results. Export to CSV for full data.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
