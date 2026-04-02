import { useState, useEffect } from 'react';
import { OrgDB as DB } from '../orgDb';

export default function Movements() {
  const [movements, setMovements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterUser, setFilterUser] = useState('');

  useEffect(() => {
    loadMovements();
  }, []);

  const loadMovements = async () => {
    setLoading(true);
    const data = await DB.getMovements();
    setMovements(data);
    setLoading(false);
  };

  const formatDate = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  const users = [...new Set(movements.map(m => m.userEmail).filter(Boolean))].sort();
  const types = [...new Set(movements.map(m => m.type).filter(Boolean))].sort();

  const filtered = movements.filter(m => {
    if (search) {
      const s = search.toLowerCase();
      const matchItem = (m.itemName || '').toLowerCase().includes(s);
      const matchFrom = (m.fromLocation || '').toLowerCase().includes(s);
      const matchTo = (m.toLocation || '').toLowerCase().includes(s);
      if (!matchItem && !matchFrom && !matchTo) return false;
    }
    if (filterType && m.type !== filterType) return false;
    if (filterUser && m.userEmail !== filterUser) return false;
    return true;
  });

  if (loading) {
    return <div className="page-content"><div className="loading">Loading...</div></div>;
  }

  return (
    <div className="page-content">
      <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8, border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ margin: 0 }}>Movement History</h2>
          <button className="btn btn-primary" onClick={loadMovements}>🔄 Refresh</button>
        </div>

        {/* Search & Filters */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="🔍 Search by item name, from location, to location..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              flex: 1, minWidth: 260, padding: '9px 14px',
              border: '1px solid var(--border)', borderRadius: 8,
              background: 'var(--bg-input)', color: 'var(--text-primary)',
              fontSize: 14
            }}
          />
          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
            style={{
              padding: '9px 14px', border: '1px solid var(--border)', borderRadius: 8,
              background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 14
            }}
          >
            <option value="">All Types</option>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <select
            value={filterUser}
            onChange={e => setFilterUser(e.target.value)}
            style={{
              padding: '9px 14px', border: '1px solid var(--border)', borderRadius: 8,
              background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 14, maxWidth: 200
            }}
          >
            <option value="">All Users</option>
            {users.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          {(search || filterType || filterUser) && (
            <button className="btn" onClick={() => { setSearch(''); setFilterType(''); setFilterUser(''); }}
              style={{ background: '#f44336', color: 'white' }}>✕ Clear</button>
          )}
        </div>

        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Showing {filtered.length} of {movements.length} movements
        </p>

        <div className="data-table">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>User</th>
                <th>Item</th>
                <th>From</th>
                <th>To</th>
                <th>Quantity</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(mov => (
                <tr key={mov.id}>
                  <td style={{ fontSize: 12 }}>{formatDate(mov.timestamp)}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{mov.userEmail || 'Unknown'}</td>
                  <td style={{ fontWeight: 500 }}>{mov.itemName}</td>
                  <td style={{ fontSize: 12 }}>{mov.fromLocation || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td style={{ fontSize: 12 }}>{mov.toLocation || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td style={{ fontWeight: 600 }}>{mov.quantity}</td>
                  <td>
                    <span style={{
                      padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                      background: mov.type === 'ADD' ? '#4CAF50' : mov.type === 'PICK' ? '#f44336' : '#2196F3',
                      color: 'white'
                    }}>
                      {mov.type}
                    </span>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan="7">
                    <div className="empty-state">
                      <p>{search || filterType || filterUser ? 'No movements match your search' : 'No movements recorded yet'}</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
