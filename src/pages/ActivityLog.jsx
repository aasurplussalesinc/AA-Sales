import { useState, useEffect } from 'react';
import { OrgDB as DB } from '../orgDb';

export default function ActivityLog() {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({
    action: '',
    user: '',
    dateFrom: '',
    dateTo: ''
  });

  useEffect(() => {
    loadActivities();
  }, []);

  const loadActivities = async () => {
    setLoading(true);
    const data = await DB.getActivityLog(500);
    setActivities(data);
    setLoading(false);
  };

  // Get unique users and action types for filters
  const users = [...new Set(activities.map(a => a.userEmail).filter(Boolean))].sort();
  const actionTypes = [...new Set(activities.map(a => a.action).filter(Boolean))].sort();

  // Filter activities
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

  const formatDate = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

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

  const clearFilters = () => {
    setFilter({ action: '', user: '', dateFrom: '', dateTo: '' });
  };

  const hasActiveFilters = Object.values(filter).some(v => v !== '');

  const exportLog = () => {
    const headers = ['Timestamp', 'User', 'Action', 'Details'];
    const rows = filteredActivities.map(a => [
      formatDate(a.timestamp),
      a.userEmail || 'System',
      a.action,
      formatDetails(a.details)
    ]);
    
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `activity-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (loading) {
    return <div className="page-content"><div className="loading">Loading activity log...</div></div>;
  }

  return (
    <div className="page-content">
      {/* Header */}
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        marginBottom: 20,
        flexWrap: 'wrap',
        gap: 10
      }}>
        <h2 style={{ margin: 0 }}>Activity Log</h2>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={loadActivities}>
            🔄 Refresh
          </button>
          <button className="btn" onClick={exportLog} style={{ background: '#17a2b8', color: 'white' }}>
            📥 Export
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ 
        background: 'white', 
        padding: 20, 
        borderRadius: 8, 
        marginBottom: 20,
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
      }}>
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 15,
          marginBottom: 15
        }}>
          <div>
            <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>
              Action Type
            </label>
            <select
              className="form-input"
              value={filter.action}
              onChange={e => setFilter({ ...filter, action: e.target.value })}
              style={{ width: '100%' }}
            >
              <option value="">All Actions</option>
              {actionTypes.map(action => (
                <option key={action} value={action}>{action}</option>
              ))}
            </select>
          </div>
          
          <div>
            <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>
              User
            </label>
            <select
              className="form-input"
              value={filter.user}
              onChange={e => setFilter({ ...filter, user: e.target.value })}
              style={{ width: '100%' }}
            >
              <option value="">All Users</option>
              {users.map(user => (
                <option key={user} value={user}>{user}</option>
              ))}
            </select>
          </div>
          
          <div>
            <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>
              From Date
            </label>
            <input
              type="date"
              className="form-input"
              value={filter.dateFrom}
              onChange={e => setFilter({ ...filter, dateFrom: e.target.value })}
              style={{ width: '100%' }}
            />
          </div>
          
          <div>
            <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>
              To Date
            </label>
            <input
              type="date"
              className="form-input"
              value={filter.dateTo}
              onChange={e => setFilter({ ...filter, dateTo: e.target.value })}
              style={{ width: '100%' }}
            />
          </div>
        </div>
        
        {hasActiveFilters && (
          <button 
            className="btn"
            onClick={clearFilters}
            style={{ background: '#dc3545', color: 'white' }}
          >
            ✕ Clear Filters
          </button>
        )}
      </div>

      {/* Results count */}
      <p style={{ marginBottom: 10, color: '#666' }}>
        Showing {filteredActivities.length} of {activities.length} activities
        {hasActiveFilters && ' (filtered)'}
      </p>

      {/* Activity list */}
      <div style={{ background: 'white', borderRadius: 8, overflow: 'hidden' }}>
        {filteredActivities.length === 0 ? (
          <div className="empty-state">
            <p>No activities found</p>
          </div>
        ) : (
          <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            {filteredActivities.map(activity => (
              <div 
                key={activity.id}
                style={{
                  padding: 15,
                  borderBottom: '1px solid #eee',
                  display: 'flex',
                  gap: 15,
                  alignItems: 'flex-start'
                }}
              >
                {/* Icon */}
                <div style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: getActionColor(activity.action),
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 18,
                  flexShrink: 0
                }}>
                  {getActionIcon(activity.action)}
                </div>
                
                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 5 }}>
                    <span style={{ 
                      fontWeight: 600,
                      color: getActionColor(activity.action)
                    }}>
                      {activity.action.replace(/_/g, ' ')}
                    </span>
                    <span style={{ color: '#999', fontSize: 13 }}>
                      {formatDate(activity.timestamp)}
                    </span>
                  </div>
                  
                  <div style={{ color: '#666', fontSize: 14, marginTop: 4 }}>
                    {formatDetails(activity.details)}
                  </div>
                  
                  <div style={{ color: '#999', fontSize: 12, marginTop: 4 }}>
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
