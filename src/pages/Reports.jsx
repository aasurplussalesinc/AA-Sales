import { useState, useEffect } from 'react';
import { OrgDB as DB } from '../orgDb';
import { useAuth } from '../OrgAuthContext';

export default function Reports() {
  const { userRole } = useAuth();
  const isAdmin = userRole === 'admin';
  const isManager = userRole === 'manager';
  const canViewReports = isAdmin || isManager;
  
  const [activeTab, setActiveTab] = useState('summary');
  const [loading, setLoading] = useState(false);
  
  // Summary data
  const [items, setItems] = useState([]);
  const [locations, setLocations] = useState([]);
  
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
    loadAllData();
  }, []);

  const loadAllData = async () => {
    setLoading(true);
    const [itemsData, locsData, movementsData] = await Promise.all([
      DB.getItems(),
      DB.getLocations(),
      DB.getMovements()
    ]);
    setItems(itemsData);
    setLocations(locsData);
    setMovements(movementsData);
    setLoading(false);
  };

  // Calculate summary stats
  const summaryStats = {
    totalItems: items.length,
    totalStock: items.reduce((sum, i) => sum + (i.stock || 0), 0),
    totalValue: items.reduce((sum, i) => sum + ((i.stock || 0) * (i.price || 0)), 0),
    avgItemValue: items.length > 0 ? items.reduce((sum, i) => sum + (i.price || 0), 0) / items.length : 0,
    outOfStock: items.filter(i => (i.stock || 0) === 0).length,
    lowStock: items.filter(i => {
      const stock = i.stock || 0;
      const threshold = i.lowStockThreshold || 10;
      return stock > 0 && stock <= threshold;
    }).length,
    needsReorder: items.filter(i => {
      const stock = i.stock || 0;
      const reorderPoint = i.reorderPoint || 0;
      return stock <= reorderPoint && reorderPoint > 0;
    }).length,
    categories: [...new Set(items.map(i => i.category).filter(Boolean))].length,
    totalLocations: locations.length
  };

  // Value by category
  const valueByCategory = items.reduce((acc, item) => {
    const cat = item.category || 'Uncategorized';
    if (!acc[cat]) acc[cat] = { category: cat, items: 0, stock: 0, value: 0 };
    acc[cat].items++;
    acc[cat].stock += item.stock || 0;
    acc[cat].value += (item.stock || 0) * (item.price || 0);
    return acc;
  }, {});
  const categoryData = Object.values(valueByCategory).sort((a, b) => b.value - a.value);

  // Top items by value
  const topValueItems = [...items]
    .map(i => ({ ...i, totalValue: (i.stock || 0) * (i.price || 0) }))
    .sort((a, b) => b.totalValue - a.totalValue)
    .slice(0, 15);

  // Low stock items
  const lowStockItems = items
    .filter(i => {
      const stock = i.stock || 0;
      const threshold = i.lowStockThreshold || 10;
      return stock <= threshold;
    })
    .sort((a, b) => (a.stock || 0) - (b.stock || 0));

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
    { id: 'summary', label: '📊 Summary' },
    { id: 'value', label: '💰 Inventory Value' },
    { id: 'lowstock', label: '⚠️ Low Stock' },
    { id: 'deadstock', label: '💀 Dead Stock' },
    { id: 'turnover', label: '📈 Turnover' },
    { id: 'custom', label: '📋 Custom' }
  ];

  // Staff cannot access reports
  if (!canViewReports) {
    return (
      <div className="page-content">
        <h2 style={{ marginBottom: 20 }}>Reports</h2>
        <div style={{ 
          background: '#fff3cd', 
          padding: 30, 
          borderRadius: 8, 
          textAlign: 'center',
          border: '1px solid #ffc107'
        }}>
          <h3 style={{ color: '#856404', marginBottom: 10 }}>🔒 Access Restricted</h3>
          <p style={{ color: '#856404' }}>Reports are only available to Managers and Admins.</p>
          <p style={{ color: '#856404', fontSize: 14 }}>Contact your administrator if you need access.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-content">
      <h2 style={{ marginBottom: 20 }}>Reports</h2>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 5, marginBottom: 20, borderBottom: '2px solid #eee', paddingBottom: 10, flexWrap: 'wrap' }}>
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

      {/* Summary Tab */}
      {activeTab === 'summary' && (
        <div>
          {/* KPI Cards */}
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', 
            gap: 15, 
            marginBottom: 20 
          }}>
            <div style={{ background: 'white', padding: 20, borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#2d5f3f' }}>
                {summaryStats.totalItems.toLocaleString()}
              </div>
              <div style={{ color: '#666', fontSize: 13 }}>Total Items</div>
            </div>
            <div style={{ background: 'white', padding: 20, borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#2d5f3f' }}>
                {summaryStats.totalStock.toLocaleString()}
              </div>
              <div style={{ color: '#666', fontSize: 13 }}>Total Units</div>
            </div>
            <div style={{ background: 'white', padding: 20, borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#4CAF50' }}>
                ${summaryStats.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div style={{ color: '#666', fontSize: 13 }}>Total Value</div>
            </div>
            <div style={{ background: 'white', padding: 20, borderRadius: 8, textAlign: 'center', borderLeft: '4px solid #f44336' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#f44336' }}>
                {summaryStats.outOfStock}
              </div>
              <div style={{ color: '#666', fontSize: 13 }}>Out of Stock</div>
            </div>
            <div style={{ background: 'white', padding: 20, borderRadius: 8, textAlign: 'center', borderLeft: '4px solid #ff9800' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#ff9800' }}>
                {summaryStats.lowStock}
              </div>
              <div style={{ color: '#666', fontSize: 13 }}>Low Stock</div>
            </div>
            <div style={{ background: 'white', padding: 20, borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#2196F3' }}>
                {summaryStats.categories}
              </div>
              <div style={{ color: '#666', fontSize: 13 }}>Categories</div>
            </div>
          </div>

          {/* Category Breakdown */}
          <div style={{ background: 'white', padding: 20, borderRadius: 8 }}>
            <h3 style={{ marginBottom: 15 }}>📊 Value by Category</h3>
            {categoryData.length === 0 ? (
              <p style={{ color: '#666' }}>No category data available</p>
            ) : (
              <div>
                {categoryData.slice(0, 10).map((cat, idx) => {
                  const maxValue = categoryData[0]?.value || 1;
                  return (
                    <div key={cat.category} style={{ marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontWeight: 500 }}>{cat.category}</span>
                        <span style={{ color: '#666', fontSize: 13 }}>
                          {cat.items} items | {cat.stock} units | ${cat.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                      <div style={{ background: '#eee', borderRadius: 4, height: 20, overflow: 'hidden' }}>
                        <div style={{
                          width: `${(cat.value / maxValue) * 100}%`,
                          height: '100%',
                          background: `hsl(${120 - (idx * 12)}, 60%, 45%)`,
                          borderRadius: 4
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Value Report Tab */}
      {activeTab === 'value' && (
        <div>
          <div style={{ background: 'white', padding: 20, borderRadius: 8, marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
              <h3>💰 Inventory Value Report</h3>
              <button
                className="btn btn-primary"
                onClick={() => exportToCSV(
                  topValueItems,
                  'inventory-value-report',
                  ['SKU', 'Name', 'Category', 'Stock', 'Unit Price', 'Total Value'],
                  (i) => [i.partNumber || '', i.name || '', i.category || '', i.stock || 0, i.price || 0, i.totalValue.toFixed(2)]
                )}
              >
                📥 Export CSV
              </button>
            </div>
            
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', 
              gap: 15,
              marginBottom: 20,
              padding: 15,
              background: '#f9f9f9',
              borderRadius: 8
            }}>
              <div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#4CAF50' }}>
                  ${summaryStats.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
                <div style={{ color: '#666', fontSize: 12 }}>Total Inventory Value</div>
              </div>
              <div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#2196F3' }}>
                  ${summaryStats.avgItemValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
                <div style={{ color: '#666', fontSize: 12 }}>Average Item Price</div>
              </div>
            </div>

            <h4 style={{ marginBottom: 10 }}>Top 15 Items by Value</h4>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f5f5' }}>
                  <th style={{ padding: 10, textAlign: 'left' }}>SKU</th>
                  <th style={{ padding: 10, textAlign: 'left' }}>Item Name</th>
                  <th style={{ padding: 10, textAlign: 'left' }}>Category</th>
                  <th style={{ padding: 10, textAlign: 'right' }}>Stock</th>
                  <th style={{ padding: 10, textAlign: 'right' }}>Unit Price</th>
                  <th style={{ padding: 10, textAlign: 'right' }}>Total Value</th>
                </tr>
              </thead>
              <tbody>
                {topValueItems.map((item, idx) => (
                  <tr key={item.id} style={{ borderBottom: '1px solid #eee', background: idx < 3 ? '#fffde7' : 'white' }}>
                    <td style={{ padding: 10, fontFamily: 'monospace' }}>{item.partNumber || '-'}</td>
                    <td style={{ padding: 10 }}>{item.name}</td>
                    <td style={{ padding: 10, color: '#666' }}>{item.category || '-'}</td>
                    <td style={{ padding: 10, textAlign: 'right' }}>{item.stock || 0}</td>
                    <td style={{ padding: 10, textAlign: 'right' }}>${(item.price || 0).toFixed(2)}</td>
                    <td style={{ padding: 10, textAlign: 'right', fontWeight: 600, color: '#4CAF50' }}>
                      ${item.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Low Stock Tab */}
      {activeTab === 'lowstock' && (
        <div>
          <div style={{ background: 'white', padding: 20, borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
              <h3>⚠️ Low Stock Report</h3>
              <button
                className="btn btn-primary"
                onClick={() => exportToCSV(
                  lowStockItems,
                  'low-stock-report',
                  ['SKU', 'Name', 'Category', 'Current Stock', 'Low Threshold', 'Reorder Point', 'Status'],
                  (i) => [
                    i.partNumber || '', 
                    i.name || '', 
                    i.category || '', 
                    i.stock || 0, 
                    i.lowStockThreshold || 10,
                    i.reorderPoint || 0,
                    (i.stock || 0) === 0 ? 'OUT OF STOCK' : (i.stock || 0) <= (i.lowStockThreshold || 10) ? 'LOW' : 'REORDER'
                  ]
                )}
              >
                📥 Export CSV
              </button>
            </div>

            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', 
              gap: 15,
              marginBottom: 20
            }}>
              <div style={{ background: '#ffebee', padding: 15, borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: '#c62828' }}>
                  {items.filter(i => (i.stock || 0) === 0).length}
                </div>
                <div style={{ color: '#c62828', fontSize: 12 }}>Out of Stock</div>
              </div>
              <div style={{ background: '#fff3e0', padding: 15, borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: '#e65100' }}>
                  {summaryStats.lowStock}
                </div>
                <div style={{ color: '#e65100', fontSize: 12 }}>Low Stock</div>
              </div>
              <div style={{ background: '#e3f2fd', padding: 15, borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: '#1565c0' }}>
                  {summaryStats.needsReorder}
                </div>
                <div style={{ color: '#1565c0', fontSize: 12 }}>Needs Reorder</div>
              </div>
            </div>

            {lowStockItems.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>
                🎉 All items are well stocked!
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f5f5f5' }}>
                    <th style={{ padding: 10, textAlign: 'left' }}>Status</th>
                    <th style={{ padding: 10, textAlign: 'left' }}>SKU</th>
                    <th style={{ padding: 10, textAlign: 'left' }}>Item Name</th>
                    <th style={{ padding: 10, textAlign: 'right' }}>Stock</th>
                    <th style={{ padding: 10, textAlign: 'right' }}>Threshold</th>
                    <th style={{ padding: 10, textAlign: 'right' }}>Reorder At</th>
                  </tr>
                </thead>
                <tbody>
                  {lowStockItems.map(item => {
                    const stock = item.stock || 0;
                    const isOutOfStock = stock === 0;
                    const isLow = stock > 0 && stock <= (item.lowStockThreshold || 10);
                    return (
                      <tr key={item.id} style={{ 
                        borderBottom: '1px solid #eee',
                        background: isOutOfStock ? '#ffebee' : isLow ? '#fff3e0' : 'white'
                      }}>
                        <td style={{ padding: 10 }}>
                          <span style={{
                            padding: '3px 8px',
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 600,
                            background: isOutOfStock ? '#f44336' : isLow ? '#ff9800' : '#2196F3',
                            color: 'white'
                          }}>
                            {isOutOfStock ? 'OUT' : isLow ? 'LOW' : 'REORDER'}
                          </span>
                        </td>
                        <td style={{ padding: 10, fontFamily: 'monospace' }}>{item.partNumber || '-'}</td>
                        <td style={{ padding: 10 }}>{item.name}</td>
                        <td style={{ padding: 10, textAlign: 'right', fontWeight: 600, color: isOutOfStock ? '#c62828' : '#e65100' }}>
                          {stock}
                        </td>
                        <td style={{ padding: 10, textAlign: 'right', color: '#666' }}>{item.lowStockThreshold || 10}</td>
                        <td style={{ padding: 10, textAlign: 'right', color: '#666' }}>{item.reorderPoint || '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

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
