import { useState, useEffect } from 'react';
import { useAuth } from '../OrgAuthContext';
import { OrgDB as DB, OWNER_ORG_ID } from '../orgDb';
import { collection, getDocs, query, orderBy, limit, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useNavigate } from 'react-router-dom';

export default function AdminDashboard() {
  const { organization, isOwnerOrg } = useAuth();
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('orgs');
  const [searchOrg, setSearchOrg] = useState('');
  const [filterPlan, setFilterPlan] = useState('');
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [orgMembers, setOrgMembers] = useState([]);

  useEffect(() => {
    if (!isOwnerOrg()) { navigate('/dashboard'); return; }
    loadAll();
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      // Load all organizations
      const orgSnap = await getDocs(collection(db, 'organizations'));
      const orgList = orgSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(o => o.id !== OWNER_ORG_ID)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      setOrgs(orgList);

      // Load error logs from activityLog
      const logSnap = await getDocs(
        query(collection(db, 'activityLog'),
          where('action', 'in', ['ERROR', 'CRASH', 'PAYMENT_FAILED', 'USER_LOGIN']),
          orderBy('timestamp', 'desc'),
          limit(200)
        )
      );
      setLogs(logSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error('Admin load error:', e);
    }
    setLoading(false);
  };

  const loadOrgMembers = async (orgId) => {
    try {
      const snap = await getDocs(
        query(collection(db, 'orgMembers'), where('orgId', '==', orgId))
      );
      setOrgMembers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      setOrgMembers([]);
    }
  };

  const planColor = {
    trial: '#ffc107', starter: '#78909c', pro: '#1976d2',
    business: '#7b1fa2', enterprise: '#0d7a52', expired: '#f44336', owner: '#c62828'
  };

  const statusColor = { active: '#4CAF50', past_due: '#ff9800', cancelled: '#f44336', trial: '#ffc107' };

  const filtered = orgs.filter(o => {
    if (searchOrg && !o.name?.toLowerCase().includes(searchOrg.toLowerCase()) &&
        !o.email?.toLowerCase().includes(searchOrg.toLowerCase())) return false;
    if (filterPlan && o.plan !== filterPlan) return false;
    return true;
  });

  const stats = {
    total: orgs.length,
    active: orgs.filter(o => o.status === 'active').length,
    trial: orgs.filter(o => o.plan === 'trial').length,
    expired: orgs.filter(o => o.plan === 'expired' || o.status === 'cancelled').length,
    mrr: orgs
      .filter(o => o.status === 'active')
      .reduce((sum, o) => sum + ({ starter: 50, pro: 150, business: 250, enterprise: 350 }[o.plan] || 0), 0)
  };

  if (loading) return (
    <div className="page-content" style={{ textAlign: 'center', paddingTop: 80 }}>
      <p style={{ color: 'var(--text-muted)' }}>Loading admin data...</p>
    </div>
  );

  return (
    <div className="page-content">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>⭐ SkidSling Admin</h1>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
            Owner dashboard — visible only to AA Surplus Sales
          </p>
        </div>
        <button className="btn btn-primary" onClick={loadAll}>🔄 Refresh</button>
      </div>

      {/* Stats cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16, marginBottom: 28 }}>
        {[
          { label: 'Total Orgs', value: stats.total, color: 'var(--accent)' },
          { label: 'Active Paid', value: stats.active, color: '#4CAF50' },
          { label: 'On Trial', value: stats.trial, color: '#ffc107' },
          { label: 'Expired', value: stats.expired, color: '#f44336' },
          { label: 'Est. MRR', value: `$${stats.mrr}`, color: '#34d399' },
        ].map(s => (
          <div key={s.label} style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 12, padding: '18px 20px', boxShadow: 'var(--shadow-sm)'
          }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid var(--border)', paddingBottom: 0 }}>
        {['orgs', 'logs'].map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            padding: '10px 20px', background: 'none', border: 'none',
            borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === tab ? 'var(--accent)' : 'var(--text-muted)',
            fontWeight: activeTab === tab ? 700 : 500, cursor: 'pointer',
            fontSize: 14, marginBottom: -2, letterSpacing: 0.3, textTransform: 'capitalize'
          }}>{tab === 'orgs' ? `Organizations (${orgs.length})` : `Error Logs (${logs.length})`}</button>
        ))}
      </div>

      {/* ORGS TAB */}
      {activeTab === 'orgs' && (
        <div>
          {/* Filters */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <input
              type="text" placeholder="🔍 Search org name or email..."
              value={searchOrg} onChange={e => setSearchOrg(e.target.value)}
              style={{
                flex: 1, minWidth: 220, padding: '9px 14px',
                border: '1px solid var(--border)', borderRadius: 8,
                background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 14
              }}
            />
            <select value={filterPlan} onChange={e => setFilterPlan(e.target.value)} style={{
              padding: '9px 14px', border: '1px solid var(--border)', borderRadius: 8,
              background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 14
            }}>
              <option value="">All Plans</option>
              {['trial', 'starter', 'pro', 'business', 'enterprise', 'expired'].map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {/* Org table */}
          <div className="data-table">
            <table>
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Email</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Trial Ends</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(org => (
                  <tr key={org.id}>
                    <td style={{ fontWeight: 600 }}>{org.name || org.id}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{org.email || '—'}</td>
                    <td>
                      <span style={{
                        padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                        background: (planColor[org.plan] || '#666') + '22',
                        color: planColor[org.plan] || '#666',
                        textTransform: 'uppercase'
                      }}>{org.plan || 'unknown'}</span>
                    </td>
                    <td>
                      <span style={{
                        padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                        background: (statusColor[org.status] || '#666') + '22',
                        color: statusColor[org.status] || '#666'
                      }}>{org.status || 'unknown'}</span>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {org.trialEndsAt ? new Date(org.trialEndsAt).toLocaleDateString() : '—'}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {org.createdAt ? new Date(org.createdAt).toLocaleDateString() : '—'}
                    </td>
                    <td>
                      <button className="btn btn-sm" onClick={async () => {
                        setSelectedOrg(org);
                        await loadOrgMembers(org.id);
                      }} style={{ background: 'var(--accent)', color: 'var(--btn-primary-color)', fontSize: 11 }}>
                        View
                      </button>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan="7" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>No organizations found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* LOGS TAB */}
      {activeTab === 'logs' && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          {logs.length === 0 ? (
            <div className="empty-state"><p>No error logs found</p></div>
          ) : (
            <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              {logs.map(log => (
                <div key={log.id} style={{
                  padding: '12px 16px', borderBottom: '1px solid var(--border)',
                  display: 'flex', gap: 14, alignItems: 'flex-start'
                }}>
                  <div style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                    background: log.action === 'ERROR' || log.action === 'CRASH' ? 'rgba(244,67,54,0.15)' : 'rgba(33,150,243,0.15)',
                    color: log.action === 'ERROR' || log.action === 'CRASH' ? '#f44336' : '#2196F3',
                    flexShrink: 0, marginTop: 2
                  }}>{log.action}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                      {log.details ? JSON.stringify(log.details) : '—'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                      {log.orgId} · {log.userEmail} · {new Date(log.timestamp).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Org detail modal */}
      {selectedOrg && (
        <div className="modal-overlay" onClick={() => setSelectedOrg(null)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header" style={{ background: 'var(--accent)' }}>
              <h2 style={{ color: 'var(--btn-primary-color)', margin: 0 }}>{selectedOrg.name || selectedOrg.id}</h2>
              <button className="modal-close" onClick={() => setSelectedOrg(null)} style={{ color: 'white' }}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                {[
                  ['Org ID', selectedOrg.id],
                  ['Email', selectedOrg.email || '—'],
                  ['Plan', selectedOrg.plan],
                  ['Status', selectedOrg.status],
                  ['Stripe Customer', selectedOrg.stripeCustomerId || 'None'],
                  ['Stripe Sub', selectedOrg.stripeSubscriptionId || 'None'],
                  ['Trial Ends', selectedOrg.trialEndsAt ? new Date(selectedOrg.trialEndsAt).toLocaleDateString() : '—'],
                  ['Created', selectedOrg.createdAt ? new Date(selectedOrg.createdAt).toLocaleDateString() : '—'],
                  ['SKU Start', selectedOrg.skuSeriesStart || 1000],
                  ['Employees', (selectedOrg.employees || []).join(', ') || '—'],
                ].map(([k, v]) => (
                  <div key={k} style={{ background: 'var(--bg-surface-2)', padding: '10px 12px', borderRadius: 8 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>{k}</div>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-all' }}>{String(v)}</div>
                  </div>
                ))}
              </div>

              <h4 style={{ marginBottom: 10 }}>Members ({orgMembers.length})</h4>
              {orgMembers.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No members found</p>
              ) : (
                <div style={{ background: 'var(--bg-surface-2)', borderRadius: 8, overflow: 'hidden' }}>
                  {orgMembers.map(m => (
                    <div key={m.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span>{m.email || m.userId}</span>
                      <span style={{ background: planColor[m.role] || 'var(--bg-surface-3)', color: 'white', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>{m.role}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
