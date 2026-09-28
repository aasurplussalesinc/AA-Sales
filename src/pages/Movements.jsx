import { useState, useEffect, useMemo } from 'react';
import { OrgDB as DB } from '../orgDb';
import { enrichMovements, itemsWithExactSku, movementMatchesSearch, movementTypeOptions } from '../movementHistory';

export default function Movements() {
  const [movements, setMovements] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterUser, setFilterUser] = useState('');
  // Full, all-time history for an exact SKU typed into the search box. The
  // default view is capped at the latest 500 movements.
  const [skuHistory, setSkuHistory] = useState(null); // { key, movements }
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    loadMovements();
  }, []);

  const loadMovements = async () => {
    setLoading(true);
    const [data, itemList] = await Promise.all([DB.getMovements(), DB.getItems()]);
    setMovements(data);
    setItems(itemList || []);
    setSkuHistory(null);
    setLoading(false);
  };

  const itemsById = useMemo(() => {
    const m = {};
    items.forEach(i => { m[i.id] = i; });
    return m;
  }, [items]);

  const exactSkuItems = useMemo(() => itemsWithExactSku(items, search), [items, search]);
  const exactSkuIds = useMemo(() => new Set(exactSkuItems.map(i => i.id)), [exactSkuItems]);
  const skuKey = exactSkuItems.map(i => i.id).sort().join(',');

  useEffect(() => {
    if (!skuKey) { setSkuHistory(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      setHistoryLoading(true);
      try {
        const all = await DB.getMovementsForItems(skuKey.split(','));
        if (!cancelled) setSkuHistory({ key: skuKey, movements: all });
      } catch (e) {
        console.error('Item history failed:', e);
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [skuKey]);

  const formatDate = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  const usingHistory = !!(skuHistory && skuHistory.key === skuKey && skuKey);
  const source = enrichMovements(usingHistory ? skuHistory.movements : movements, itemsById);

  const users = [...new Set(source.map(m => m.userEmail).filter(Boolean))].sort();
  const types = movementTypeOptions(source);

  const filtered = source.filter(m => {
    if (!movementMatchesSearch(m, search, exactSkuIds)) return false;
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
            placeholder="🔍 Search by SKU (exact SKU = full history), item name, grade, location, order..."
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
          {usingHistory
            ? <>Full history for SKU <strong>{search.trim()}</strong>
                {exactSkuItems.length > 1 && <> ({exactSkuItems.length} items share this SKU — see the Grade column)</>}
                : showing {filtered.length} of {source.length} movements, all time</>
            : <>Showing {filtered.length} of {movements.length} movements (latest {movements.length}). Type an exact SKU to load that item's full history.</>}
          {historyLoading && <> · loading full history…</>}
        </p>

        <div className="data-table">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>User</th>
                <th>SKU</th>
                <th>Item</th>
                <th>Grade</th>
                <th>From</th>
                <th>To</th>
                <th>Quantity</th>
                <th>Before → After</th>
                <th>Type</th>
                <th>Order / Note</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(mov => (
                <tr key={mov.id}>
                  <td style={{ fontSize: 12 }}>{formatDate(mov.timestamp)}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{mov.userEmail || 'Unknown'}</td>
                  <td style={{ fontSize: 12, fontWeight: 600 }}>
                    {mov.sku
                      ? <span style={{ cursor: 'pointer', textDecoration: 'underline dotted' }} title="Show this SKU's full history"
                          onClick={() => setSearch(mov.sku)}>{mov.sku}</span>
                      : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td style={{ fontWeight: 500 }}>{mov.itemName}</td>
                  <td style={{ fontSize: 12 }}>{mov.grade || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td style={{ fontSize: 12 }}>{mov.fromLocation || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td style={{ fontSize: 12 }}>{mov.toLocation || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td style={{ fontWeight: 600 }}>{mov.quantity}</td>
                  <td style={{ fontSize: 12 }}>
                    {mov.beforeQty !== undefined && mov.afterQty !== undefined
                      ? `${mov.beforeQty} → ${mov.afterQty}`
                      : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td>
                    <span style={{
                      padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                      background: (mov.type === 'ADD' || mov.type === 'RECEIVE' || mov.type === 'CREATE' || mov.type === 'RESTORE') ? '#4CAF50'
                        : mov.type === 'PICK' ? '#f44336'
                        : (mov.type === 'ADJUST' || mov.type === 'IMPORT') ? '#FF9800' : '#2196F3',
                      color: 'white'
                    }}>
                      {mov.type}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {[...new Set([mov.orderNumber, mov.reason, mov.notes || mov.note].filter(Boolean))].join(' · ') || '—'}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan="11">
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
