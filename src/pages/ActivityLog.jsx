import { useState, useEffect, useRef } from 'react';
import { OrgDB as DB } from '../orgDb';
import { useTier } from '../useTier';

export default function ActivityLog() {
  const { canUseOrders } = useTier(); // Pro+ gate — reuse canUseOrders (Pro tier)
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState({ action: '', user: '', dateFrom: '', dateTo: '' });
  const intervalRef = useRef(null);

  useEffect(() => {
    loadActivities();
  }, []);

  useEffect(() => {
    if (live) {
      intervalRef.current = setInterval(loadActivities, 30000); // poll every 30s
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [live]);

  const loadActivities = async () => {
    try {
      const data = await DB.getActivityLog(500);
      setActivities(data);
    } catch (e) {
      console.error('Activity log load error:', e);
    } finally {
      setLoading(false);
    }
  };

  // Pro+ gate
  if (!canUseOrders) {
    return (
      <div className="page-content">
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', minHeight: '50vh', textAlign: 'center', padding: 40
        }}>
          <div style={{ fontSize: 64, marginBottom: 20 }}>🔒</div>
          <h2 style={{ marginBottom: 10, color: 'var(--text-primary)' }}>Pro Plan Required</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 16, maxWidth: 400, marginBottom: 30 }}>
            The Activity Log is available on the <strong>Pro</strong> plan and above.
            Upgrade to get full visibility into everything happening in your warehouse.
          </p>
          <a href="/subscription-required" style={{
            padding: '12px 32px', background: 'var(--btn-primary-bg)',
            color: 'var(--btn-primary-color)', borderRadius: 8,
            textDecoration: 'none', fontWeight: 700, fontSize: 16
          }}>View Plans & Upgrade</a>
        </div>
      </div>
    );
  }

  const users = [...new Set(activities.map(a => a.userEmail).filter(Boolean))].sort();
  const actionTypes = [...new Set(activities.map(a => a.action).filter(Boolean))].sort();

  const filteredActivities = activities.filter(activity => {
    if (filter.action && activity.action !== filter.action) return false;
    if (filter.user && activity.userEmail !== filter.user) return false;
    if (filter.dateFrom) {
      const fromDate = new Date(filter.dateFrom).getTime();
      if (activity.timestamp < fromDate) return false;
    }
    if (filter.dateTo) {
      const toDate = new Date(filter.dateTo).setHours(23, 59, 59, 999);
      if (activity.timestamp > toDate) return false;
    }
    return true;
  });

  const formatDate = (timestamp) => new Date(timestamp).toLocaleString();

  const getActionColor = (action) => {
    if (action.includes('ADD') || action.includes('CREATED') || action.includes('IMPORT')) return '#4CAF50';
    if (action.includes('PICK') || action.includes('DELETE')) return '#f44336';
    if (action.includes('MOVE') || action.includes('UPDATE')) return '#2196F3';
    if (action.includes('LOGIN')) return '#9c27b0';
    return '#757575';
  };

  const getActionIcon = (action) => {
    if (action.includes('ADD')) return '➕';
    if (action.includes('PICK')) return '📤';
    if (action.includes('MOVE')) return '🔄';
    if (action.includes('CREATED')) return '🆕';
    if (action.includes('DELETE')) return '🗑️';
    if (action.includes('IMPORT')) return '📥';
    if (action.includes('EXPORT')) return '📊';
    if (action.includes('LOGIN')) return '🔐';
    if (action.includes('LOGOUT')) return '🚪';
    return '📝';
  };

  const formatDetails = (details) => {
    if (!details || Object.keys(details).length === 0) return '-';
    const parts = [];
    if (details.itemName) parts.push(`Item: ${details.itemName}`);
    if (details.quantity) parts.push(`Qty: ${details.quantity}`);
    if (details.locationCode) parts.push(`Location: ${details.locationCode}`);
    if (details.fromLocation) parts.push(`From: ${details.fromLocation}`);
    if (details.toLocation) parts.push(`To: ${details.toLocation}`);
    if (details.count) parts.push(`Count: ${details.count}`);
    if (details.source) parts.push(`Source: ${details.source}`);
    return parts.length > 0 ? parts.join(' | ') : JSON.stringify(details);
  };

  const exportLog = () => {
    const headers = ['Timestamp', 'User', 'Action', 'Details'];
    const rows = filteredActivities.map(a => [
      formatDate(a.timestamp), a.userEmail || 'System', a.action, formatDetails(a.details)
    ]);
    const csvContent = [headers.join(','), ...rows.map(row =>
      row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    )].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `activity-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const hasActiveFilters = Object.values(filter).some(v => v !== '');

  if (loading) {
    return <div className="page-content"><div className="loading">Loading activity log...</div></div>;
  }

  return (
    <div className="page-content">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>Activity Log</h2>
          {/* Live indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: live ? '#4CAF50' : 'var(--text-muted)',
              boxShadow: live ? '0 0 0 3px rgba(76,175,80,0.25)' : 'none',
              animation: live ? 'pulse 2s infinite' : 'none'
            }} />
            <button
              onClick={() => setLive(l => !l)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 12, color: live ? '#4CAF50' : 'var(--text-muted)',
                fontWeight: 600, padding: 0
              }}
            >
              {live ? 'LIVE' : 'PAUSED'}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={loadActivities}>🔄 Refresh</button>
          <button className="btn" onClick={exportLog} style={{ background: '#17a2b8', color: 'white' }}>📥 Export</button>
        </div>
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      {/* Filters */}
      <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8, marginBottom: 20, boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 15, marginBottom: 15 }}>
          <div>
            <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13, color: 'var(--text-secondary)' }}>Action Type</label>
            <select className="form-input" value={filter.action} onChange={e => setFilter({ ...filter, action: e.target.value })} style={{ width: '100%', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px' }}>
              <option value="">All Actions</option>
              {actionTypes.map(action => <option key={action} value={action}>{action}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13, color: 'var(--text-secondary)' }}>User</label>
            <select className="form-input" value={filter.user} onChange={e => setFilter({ ...filter, user: e.target.value })} style={{ width: '100%', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px' }}>
              <option value="">All Users</option>
              {users.map(user => <option key={user} value={user}>{user}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13, color: 'var(--text-secondary)' }}>From Date</label>
            <input type="date" className="form-input" value={filter.dateFrom} onChange={e => setFilter({ ...filter, dateFrom: e.target.value })} style={{ width: '100%', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px' }} />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13, color: 'var(--text-secondary)' }}>To Date</label>
            <input type="date" className="form-input" value={filter.dateTo} onChange={e => setFilter({ ...filter, dateTo: e.target.value })} style={{ width: '100%', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px' }} />
          </div>
        </div>
        {hasActiveFilters && (
          <button className="btn" onClick={() => setFilter({ action: '', user: '', dateFrom: '', dateTo: '' })} style={{ background: '#dc3545', color: 'white' }}>
            ✕ Clear Filters
          </button>
        )}
      </div>

      <p style={{ marginBottom: 10, color: 'var(--text-muted)', fontSize: 13 }}>
        Showing {filteredActivities.length} of {activities.length} activities
        {hasActiveFilters && ' (filtered)'}
        {live && <span style={{ marginLeft: 8, color: '#4CAF50', fontSize: 12 }}>• Auto-refreshes every 30s</span>}
      </p>

      {/* Activity list */}
      <div style={{ background: 'var(--bg-surface)', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
        {filteredActivities.length === 0 ? (
          <div className="empty-state"><p>No activities found</p></div>
        ) : (
          <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            {filteredActivities.map(activity => (
              <div key={activity.id} style={{
                padding: '12px 16px', borderBottom: '1px solid var(--border)',
                display: 'flex', gap: 14, alignItems: 'flex-start',
                transition: 'background var(--transition)'
              }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <div style={{
                  width: 38, height: 38, borderRadius: '50%',
                  background: getActionColor(activity.action), color: 'white',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 16, flexShrink: 0
                }}>
                  {getActionIcon(activity.action)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 5 }}>
                    <span style={{ fontWeight: 600, color: getActionColor(activity.action), fontSize: 13 }}>
                      {activity.action.replace(/_/g, ' ')}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {formatDate(activity.timestamp)}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 3 }}>
                    {formatDetails(activity.details)}
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                    by {activity.userEmail || 'System'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
