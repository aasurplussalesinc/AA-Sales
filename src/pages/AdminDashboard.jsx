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

      // Load recent activity logs — simple query, no composite index needed
      try {
        const logSnap = await getDocs(
          query(collection(db, 'activityLog'),
            orderBy('timestamp', 'desc'),
            limit(300)
          )
        );
        // Filter client-side to avoid needing composite index
        const allLogs = logSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        setLogs(allLogs);
      } catch (logErr) {
        console.warn('Activity log load failed (index may be missing):', logErr.message);
        setLogs([]);
      }
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

  // Compute trial conversion stats
  const totalSignedUp = orgs.length;
  const stillOnTrial = orgs.filter(o => o.plan === 'trial' && o.status !== 'trial_expired').length;
  const trialExpired = orgs.filter(o => o.status === 'trial_expired').length;
  const converted = orgs.filter(o => ['test', 'starter', 'pro', 'business', 'enterprise'].includes(o.plan) && o.status === 'active').length;
  const finishedTrial = converted + trialExpired;
  const conversionRate = finishedTrial > 0 ? Math.round((converted / finishedTrial) * 100) : 0;

  const stats = {
    total: totalSignedUp,
    active: orgs.filter(o => o.status === 'active').length,
    trial: stillOnTrial,
    expired: trialExpired,
    converted,
    conversionRate,
    mrr: orgs
      .filter(o => o.status === 'active')
      .reduce((sum, o) => sum + ({ test: 1, starter: 50, pro: 150, business: 250, enterprise: 350 }[o.plan] || 0), 0)
  };

  // Plan breakdown for paid customers
  const paidByPlan = {
    starter: orgs.filter(o => o.plan === 'starter' && o.status === 'active').length,
    pro: orgs.filter(o => o.plan === 'pro' && o.status === 'active').length,
    business: orgs.filter(o => o.plan === 'business' && o.status === 'active').length,
    enterprise: orgs.filter(o => o.plan === 'enterprise' && o.status === 'active').length,
  };

  // Signups by month (last 6 months)
  const signupsByMonth = (() => {
    const months = {};
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      months[key] = 0;
    }
    orgs.forEach(o => {
      if (!o.createdAt) return;
      const d = new Date(o.createdAt);
      const key = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      if (key in months) months[key]++;
    });
    return months;
  })();

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
        {['orgs', 'conversion', 'logs'].map(tab => (
          <button key={tab} onClick={() => { setActiveTab(tab); setSearchOrg(''); setFilterPlan(''); }} style={{
            padding: '10px 20px', background: 'none', border: 'none',
            borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === tab ? 'var(--accent)' : 'var(--text-muted)',
            fontWeight: activeTab === tab ? 700 : 500, cursor: 'pointer',
            fontSize: 14, marginBottom: -2, letterSpacing: 0.3, textTransform: 'capitalize'
          }}>{
            tab === 'orgs' ? `Organizations (${orgs.length})`
            : tab === 'conversion' ? `Conversion (${stats.conversionRate}%)`
            : `Activity Logs (${logs.length})`
          }</button>
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
              {['trial', 'test', 'starter', 'pro', 'business', 'enterprise', 'expired'].map(p => (
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
      {activeTab === 'conversion' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          {/* Funnel summary */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>Trial → Paid Funnel</h3>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600 }}>TOTAL SIGNUPS (all time)</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--accent)' }}>{stats.total}</div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600 }}>STILL ON TRIAL</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#ffc107' }}>{stats.trial}</div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600 }}>CONVERTED TO PAID</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#4CAF50' }}>{stats.converted}</div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600 }}>TRIAL EXPIRED (no upgrade)</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#f44336' }}>{stats.expired}</div>
            </div>
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600 }}>CONVERSION RATE</div>
              <div style={{ fontSize: 36, fontWeight: 800, color: stats.conversionRate >= 30 ? '#4CAF50' : stats.conversionRate >= 15 ? '#ffc107' : '#f44336' }}>
                {stats.conversionRate}%
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>of finished trials converted to paid</div>
            </div>
          </div>

          {/* Plan breakdown */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>Active Paid Plans</h3>
            {[
              { key: 'starter', label: 'Starter', color: '#78909c', price: 50 },
              { key: 'pro', label: 'Pro', color: '#1976d2', price: 150 },
              { key: 'business', label: 'Business', color: '#388e3c', price: 250 },
              { key: 'enterprise', label: 'Enterprise', color: '#6a1b9a', price: 350 },
            ].map(p => (
              <div key={p.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 3, background: p.color }} />
                  <div>
                    <div style={{ fontWeight: 600 }}>{p.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>${p.price}/mo each</div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 22, fontWeight: 800 }}>{paidByPlan[p.key]}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>${(paidByPlan[p.key] * p.price).toLocaleString()}/mo</div>
                </div>
              </div>
            ))}
            <div style={{ marginTop: 16, padding: '12px 14px', background: 'rgba(52,211,153,0.1)', borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>TOTAL MRR</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: '#34d399' }}>${stats.mrr.toLocaleString()}/mo</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>${(stats.mrr * 12).toLocaleString()} ARR</div>
            </div>
          </div>

          {/* Signups by month */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, gridColumn: '1 / -1' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>Signups — Last 6 Months</h3>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: 180, padding: '0 8px' }}>
              {Object.entries(signupsByMonth).map(([month, count]) => {
                const max = Math.max(...Object.values(signupsByMonth), 1);
                const heightPct = (count / max) * 100;
                return (
                  <div key={month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{count}</div>
                    <div style={{
                      width: '100%',
                      height: `${heightPct}%`,
                      background: 'linear-gradient(180deg, #34d399 0%, #0d7a52 100%)',
                      borderRadius: '4px 4px 0 0',
                      minHeight: count > 0 ? 4 : 0,
                      transition: 'height 0.3s'
                    }} />
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>{month}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'logs' && (
        <div>
          {/* Log filters */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="🔍 Search logs..."
              value={searchOrg}
              onChange={e => setSearchOrg(e.target.value)}
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
              <option value="">All Actions</option>
              {[...new Set(logs.map(l => l.action).filter(Boolean))].sort().map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            {logs.length === 0 ? (
              <div className="empty-state"><p>No logs found</p></div>
            ) : (
              <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
                {logs
                  .filter(log => {
                    if (searchOrg && !JSON.stringify(log).toLowerCase().includes(searchOrg.toLowerCase())) return false;
                    if (filterPlan && log.action !== filterPlan) return false;
                    return true;
                  })
                  .map(log => {
                    const isError = ['ERROR', 'CRASH', 'PAYMENT_FAILED'].includes(log.action);
                    return (
                      <div key={log.id} style={{
                        padding: '12px 16px', borderBottom: '1px solid var(--border)',
                        display: 'flex', gap: 14, alignItems: 'flex-start',
                        background: isError ? 'rgba(244,67,54,0.04)' : 'transparent'
                      }}>
                        <div style={{
                          padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                          background: isError ? 'rgba(244,67,54,0.15)' : 'rgba(33,150,243,0.1)',
                          color: isError ? '#f44336' : 'var(--text-link)',
                          flexShrink: 0, marginTop: 2, whiteSpace: 'nowrap'
                        }}>{log.action}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                            {log.details ? (typeof log.details === 'object' ? JSON.stringify(log.details) : log.details) : '—'}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                            {log.orgId} · {log.userEmail || 'unknown'} · {new Date(log.timestamp).toLocaleString()}
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
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
