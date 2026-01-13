import { useState, useEffect } from 'react';
import { OrgDB as DB } from '../orgDb';
import { Link } from 'react-router-dom';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    setLoading(true);
    const data = await DB.getDashboardStats();
    setStats(data);
    setLoading(false);
  };

  if (loading || !stats) {
    return <div className="page-content"><div className="loading">Loading dashboard...</div></div>;
  }

  // Find max for scaling chart bars
  const maxPicked = Math.max(...stats.topPickedItems.map(i => i.totalPicked), 1);
  const maxDaily = Math.max(
    ...stats.dailyMovements.map(d => Math.max(d.picks, d.adds, d.moves)), 
    1
  );

  return (
    <div className="page-content">
      {/* Stats Cards */}
      <div className="stats-grid">
        <div className="stat-card">
          <h3>{stats.totalItems.toLocaleString()}</h3>
          <p>Total Items</p>
        </div>
        <div className="stat-card">
          <h3>{stats.totalLocations.toLocaleString()}</h3>
          <p>Locations</p>
        </div>
        <div className="stat-card">
          <h3>{stats.totalStock.toLocaleString()}</h3>
          <p>Total Stock</p>
        </div>
        <div className="stat-card" style={{ borderLeft: '4px solid #f44336' }}>
          <h3>{stats.outOfStockItems}</h3>
          <p>Out of Stock</p>
        </div>
        <div className="stat-card" style={{ borderLeft: '4px solid #f44336' }}>
          <h3>{stats.lowStockItems}</h3>
          <p>🔴 Low Stock</p>
        </div>
        <div className="stat-card" style={{ borderLeft: '4px solid #ff9800' }}>
          <h3>{stats.reorderItems || 0}</h3>
          <p>🟠 Need Reorder</p>
        </div>
      </div>

      {/* Low Stock Alerts */}
      {(stats.lowStockItems > 0 || stats.reorderItems > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))', gap: 20, marginBottom: 20 }}>
          {/* Low Stock Items */}
          {stats.lowStockItemsList && stats.lowStockItemsList.length > 0 && (
            <div style={{ background: '#ffebee', padding: 20, borderRadius: 8, border: '1px solid #f44336' }}>
              <h3 style={{ marginBottom: 15, color: '#c62828' }}>🔴 Low Stock Alert</h3>
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                {stats.lowStockItemsList.map(item => (
                  <div key={item.id} style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    padding: '8px 0', 
                    borderBottom: '1px solid #ffcdd2' 
                  }}>
                    <span style={{ fontWeight: 500 }}>{item.name || item.partNumber}</span>
                    <span style={{ 
                      background: '#f44336', 
                      color: 'white', 
                      padding: '2px 8px', 
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600
                    }}>
                      {item.stock || 0} left
                    </span>
                  </div>
                ))}
              </div>
              <Link to="/items" style={{ 
                display: 'block', 
                textAlign: 'center', 
                marginTop: 15, 
                color: '#c62828',
                fontWeight: 600 
              }}>
                View All Low Stock Items →
              </Link>
            </div>
          )}
          
          {/* Reorder Items */}
          {stats.reorderItemsList && stats.reorderItemsList.length > 0 && (
            <div style={{ background: '#fff3e0', padding: 20, borderRadius: 8, border: '1px solid #ff9800' }}>
              <h3 style={{ marginBottom: 15, color: '#e65100' }}>🟠 Needs Reorder</h3>
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                {stats.reorderItemsList.map(item => (
                  <div key={item.id} style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    padding: '8px 0', 
                    borderBottom: '1px solid #ffe0b2' 
                  }}>
                    <span style={{ fontWeight: 500 }}>{item.name || item.partNumber}</span>
                    <span style={{ 
                      background: '#ff9800', 
                      color: 'white', 
                      padding: '2px 8px', 
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600
                    }}>
                      {item.stock || 0} (reorder at {item.reorderPoint})
                    </span>
                  </div>
                ))}
              </div>
              <Link to="/items" style={{ 
                display: 'block', 
                textAlign: 'center', 
                marginTop: 15, 
                color: '#e65100',
                fontWeight: 600 
              }}>
                View All Reorder Items →
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Charts Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 20, marginBottom: 20 }}>
        
        {/* Top Picked Items - Bar Chart */}
        <div style={{ background: 'white', padding: 20, borderRadius: 8 }}>
          <h3 style={{ marginBottom: 15 }}>🏆 Top Picked Items (30 days)</h3>
          {stats.topPickedItems.length === 0 ? (
            <div className="empty-state"><p>No picks recorded yet</p></div>
          ) : (
            <div>
              {stats.topPickedItems.map((item, idx) => (
                <div key={item.itemId} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: idx < 3 ? 600 : 400 }}>
                      {idx + 1}. {item.itemName || 'Unknown Item'}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#2d5f3f' }}>
                      {item.totalPicked}
                    </span>
                  </div>
                  <div style={{ 
                    height: 8, 
                    background: '#e0e0e0', 
                    borderRadius: 4,
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      height: '100%',
                      width: `${(item.totalPicked / maxPicked) * 100}%`,
                      background: idx === 0 ? '#FFD700' : idx === 1 ? '#C0C0C0' : idx === 2 ? '#CD7F32' : '#2d5f3f',
                      borderRadius: 4,
                      transition: 'width 0.5s ease'
                    }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Daily Movement Trend - Bar Chart */}
        <div style={{ background: 'white', padding: 20, borderRadius: 8 }}>
          <h3 style={{ marginBottom: 15 }}>📈 Daily Activity (7 days)</h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', height: 180, gap: 8 }}>
            {stats.dailyMovements.map((day, idx) => {
              const total = day.picks + day.adds + day.moves;
              return (
                <div key={day.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  {/* Stacked bars */}
                  <div style={{ 
                    width: '100%', 
                    display: 'flex', 
                    flexDirection: 'column-reverse',
                    height: 140,
                    justifyContent: 'flex-start'
                  }}>
                    {day.picks > 0 && (
                      <div style={{
                        height: `${(day.picks / maxDaily) * 100}%`,
                        background: '#f44336',
                        borderRadius: '4px 4px 0 0',
                        minHeight: day.picks > 0 ? 4 : 0
                      }} title={`Picks: ${day.picks}`} />
                    )}
                    {day.adds > 0 && (
                      <div style={{
                        height: `${(day.adds / maxDaily) * 100}%`,
                        background: '#4CAF50',
                        minHeight: day.adds > 0 ? 4 : 0
                      }} title={`Adds: ${day.adds}`} />
                    )}
                    {day.moves > 0 && (
                      <div style={{
                        height: `${(day.moves / maxDaily) * 100}%`,
                        background: '#2196F3',
                        minHeight: day.moves > 0 ? 4 : 0
                      }} title={`Moves: ${day.moves}`} />
                    )}
                  </div>
                  {/* Label */}
                  <div style={{ 
                    fontSize: 10, 
                    color: '#666', 
                    marginTop: 5,
                    textAlign: 'center'
                  }}>
                    {new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' })}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600 }}>{total}</div>
                </div>
              );
            })}
          </div>
          {/* Legend */}
          <div style={{ display: 'flex', gap: 15, marginTop: 15, justifyContent: 'center', fontSize: 12 }}>
            <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#f44336', borderRadius: 2, marginRight: 4 }} />Picks</span>
            <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#4CAF50', borderRadius: 2, marginRight: 4 }} />Adds</span>
            <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#2196F3', borderRadius: 2, marginRight: 4 }} />Moves</span>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div style={{ background: 'white', padding: 20, borderRadius: 8 }}>
        <h3 style={{ marginBottom: 15 }}>Quick Actions</h3>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <a href="/scanner" className="btn btn-primary">📷 Scan QR</a>
          <a href="/items" className="btn btn-primary">📦 View Items</a>
          <a href="/locations" className="btn btn-primary">📍 Locations</a>
          <a href="/pick-lists" className="btn btn-primary">📋 Pick Lists</a>
          <a href="/receiving" className="btn btn-primary">📥 Receiving</a>
          <a href="/reports" className="btn btn-primary">📊 Reports</a>
        </div>
      </div>
    </div>
  );
}
