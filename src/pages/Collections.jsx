import { useState, useEffect, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../OrgAuthContext';
import { Invoices, Collections as CollectionsApi, formatCents, INVOICE_STATUS_LABELS, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from '../invoicingApi';

// Collections: every open balance by customer, aged current / 1-30 / 31-60 /
// 61-90 / 90+, with the last and next reminder, and the actions that replace
// the manual overdue CSV: send now, pause reminders, record a payment, send a
// statement. All numbers come from the payments ledger (server-side).
const BUCKETS = [['current', 'Current'], ['1-30', '1-30'], ['31-60', '31-60'], ['61-90', '61-90'], ['90+', '90+']];
const box = { background: 'var(--bg-surface)', padding: 16, borderRadius: 8, marginBottom: 16 };
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString() : '');

export default function Collections() {
  const { organization, userRole } = useAuth();
  const canAct = userRole === 'admin' || userRole === 'manager';
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState({});
  const [filter, setFilter] = useState('');
  const [bucket, setBucket] = useState('');

  const load = async () => {
    setError('');
    try { setReport(await CollectionsApi.getReport({ orgId: organization.id })); }
    catch (e) { setError(e.message || String(e)); }
  };
  useEffect(() => { if (organization?.id && canAct) load(); }, [organization?.id, canAct]);

  const run = async (label, fn) => {
    setBusy(label); setError(''); setNote('');
    try { await fn(); } catch (e) { setError(e.message || String(e)); }
    setBusy('');
  };
  const sendNow = (inv) => {
    if (!window.confirm('Email ' + inv.orderNumber + ' (balance ' + formatCents(inv.balanceCents) + ') to the customer now?')) return;
    run('Sending ' + inv.orderNumber + '...', async () => {
      const r = await Invoices.send({ orgId: organization.id, orderId: inv.orderId });
      if (r.sent) setNote(inv.orderNumber + ' emailed to ' + r.to.join(', ') + '.'); else setError(inv.orderNumber + ' not sent: ' + r.reason);
      await load();
    });
  };
  const togglePause = (inv) => run('Saving...', async () => {
    await Invoices.setReminderPause({ orgId: organization.id, orderId: inv.orderId, paused: !inv.remindersPaused });
    await load();
  });
  const sendStatement = (g) => {
    if (!window.confirm('Email ' + g.customerName + ' a statement of ' + g.invoices.length + ' open invoice' + (g.invoices.length === 1 ? '' : 's') + ' (' + formatCents(g.collectibleCents) + ') with one pay link?')) return;
    run('Sending statement...', async () => {
      const r = await CollectionsApi.sendStatement({ orgId: organization.id, customerId: g.customerId });
      if (r.sent) setNote('Statement emailed to ' + r.to.join(', ') + '.'); else setError('Statement not sent: ' + r.reason);
      await load();
    });
  };

  if (!organization) return null;
  if (!canAct) return <div className="page-content"><p>Collections is available to managers and admins.</p></div>;

  const customers = (report?.customers || []).filter(g =>
    (!filter || g.customerName.toLowerCase().includes(filter.toLowerCase())) &&
    (!bucket || g[bucket] > 0));

  return (
    <div className="page-content">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0 }}>💰 Collections</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" disabled={!!busy} onClick={load}>Refresh</button>
          <Link to="/settings/payments" className="btn" style={{ textDecoration: 'none' }}>Payment settings</Link>
        </div>
      </div>
      {!organization.payments?.enabled && (
        <div style={{ ...box, background: 'var(--bg-badge-orange)', marginTop: 12 }}>
          Invoicing is off for this company, so nothing is emailed from here. Balances below are still what the orders and recorded payments say.
          <Link to="/settings/payments" style={{ marginLeft: 6 }}>Turn it on</Link>
        </div>
      )}
      {busy && <div style={{ ...box, background: 'var(--bg-badge-blue)', marginTop: 12 }}>{busy}</div>}
      {note && <div style={{ ...box, background: 'var(--bg-success)', marginTop: 12 }}>{note}</div>}
      {error && <div style={{ ...box, background: 'var(--bg-error)', marginTop: 12 }}>{error}</div>}
      {!report && !error && <p>Loading...</p>}

      {report && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, margin: '16px 0' }}>
            <div style={{ ...box, marginBottom: 0 }}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Total owed</div><strong style={{ fontSize: 20 }}>{formatCents(report.totals.totalCents)}</strong><div style={{ fontSize: 12 }}>{report.totals.invoices} invoices</div></div>
            {BUCKETS.map(([k, label]) => (
              <button key={k} onClick={() => setBucket(bucket === k ? '' : k)}
                style={{ ...box, marginBottom: 0, textAlign: 'left', border: bucket === k ? '2px solid #0d7a52' : '2px solid transparent', cursor: 'pointer' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}{k !== 'current' ? ' days' : ''}</div>
                <strong style={{ fontSize: 18, color: k === 'current' ? undefined : k === '1-30' ? '#b26a00' : '#c62828' }}>{formatCents(report.totals[k])}</strong>
              </button>
            ))}
          </div>

          {report.zeroTotalShipped?.length > 0 && (
            <div style={{ ...box, background: 'var(--bg-badge-orange)', fontSize: 13 }}>
              {report.zeroTotalShipped.length} shipped order{report.zeroTotalShipped.length === 1 ? '' : 's'} invoice at $0.00 because no line has a shipped quantity
              ({report.zeroTotalShipped.slice(0, 12).join(', ')}{report.zeroTotalShipped.length > 12 ? '...' : ''}). They are not chased until shipped quantities are set.
            </div>
          )}

          <input className="form-input" placeholder="Filter customers..." value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 260, marginBottom: 10 }} />

          <div className="data-table">
            <table>
              <thead>
                <tr><th>Customer</th>{BUCKETS.map(([k, l]) => <th key={k} style={{ textAlign: 'right' }}>{l}</th>)}<th style={{ textAlign: 'right' }}>Total</th><th></th></tr>
              </thead>
              <tbody>
                {customers.map(g => (
                  <Fragment key={g.key}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => setOpen(o => ({ ...o, [g.key]: !o[g.key] }))}>
                      <td>
                        <strong>{open[g.key] ? '▾' : '▸'} {g.customerName}</strong>
                        {g.remindByPhone && <span style={{ marginLeft: 6, fontSize: 11, background: '#fff3e0', color: '#b26a00', padding: '1px 6px', borderRadius: 8 }}>📞 call</span>}
                        {g.doNotRemind && <span style={{ marginLeft: 6, fontSize: 11, background: '#eceff1', padding: '1px 6px', borderRadius: 8 }}>do not remind</span>}
                        {g.pendingCents > 0 && <span style={{ marginLeft: 6, fontSize: 11, color: '#b26a00' }}>{formatCents(g.pendingCents)} clearing</span>}
                        {!g.billingEmails.length && <span style={{ marginLeft: 6, fontSize: 11, color: '#c62828' }}>no email</span>}
                      </td>
                      {BUCKETS.map(([k]) => <td key={k} style={{ textAlign: 'right', color: g[k] ? undefined : 'var(--text-muted)' }}>{g[k] ? formatCents(g[k]) : '-'}</td>)}
                      <td style={{ textAlign: 'right' }}><strong>{formatCents(g.totalCents)}</strong></td>
                      <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                        {g.customerId && g.collectibleCents > 0 && organization.payments?.enabled && (
                          <button className="btn btn-sm" disabled={!!busy} onClick={() => sendStatement(g)} style={{ fontSize: 11 }}>Send statement</button>
                        )}
                      </td>
                    </tr>
                    {open[g.key] && g.invoices.map(inv => {
                      const badge = INVOICE_STATUS_LABELS[inv.status] || INVOICE_STATUS_LABELS.draft;
                      return (
                        <tr key={g.key + inv.orderId} style={{ background: 'var(--bg-hover)', fontSize: 12 }}>
                          <td colSpan={2} style={{ paddingLeft: 24 }}>
                            <Link to={'/purchase-orders?po=' + inv.orderId}>{inv.orderNumber}</Link>
                            {inv.customerPO && <span style={{ color: 'var(--text-muted)' }}> · PO {inv.customerPO}</span>}
                            <span style={{ marginLeft: 6, background: badge.bg, color: badge.color, padding: '1px 6px', borderRadius: 8 }}>{badge.label}</span>
                            {inv.disputed && <span style={{ marginLeft: 6, color: '#c62828', fontWeight: 700 }}>DISPUTED</span>}
                          </td>
                          <td colSpan={2}>Due {inv.dueDate}{inv.daysOverdue > 0 ? ` · ${inv.daysOverdue}d late` : ''}</td>
                          <td colSpan={2}>
                            {inv.lastReminderAt ? 'Last reminder ' + fmtDate(inv.lastReminderAt) : inv.sentAt ? 'Sent ' + fmtDate(inv.sentAt) : 'Not sent'}
                            <br />{inv.nextReminder ? 'Next ' + inv.nextReminder.date : (inv.reminderNote || '')}
                          </td>
                          <td style={{ textAlign: 'right' }}>{formatCents(inv.balanceCents)}{inv.paidCents > 0 && <div style={{ color: 'var(--text-muted)' }}>paid {formatCents(inv.paidCents)}</div>}</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {organization.payments?.enabled && <button className="btn btn-sm" disabled={!!busy} onClick={() => sendNow(inv)} style={{ fontSize: 11 }}>Send now</button>}
                            {inv.sentAt && <button className="btn btn-sm" disabled={!!busy} onClick={() => togglePause(inv)} style={{ fontSize: 11, marginLeft: 4 }}>{inv.remindersPaused ? 'Resume' : 'Pause'}</button>}
                            <Link to={'/purchase-orders?po=' + inv.orderId} className="btn btn-sm" style={{ fontSize: 11, marginLeft: 4, textDecoration: 'none' }}>Record payment</Link>
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
                {customers.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Nothing owed{filter || bucket ? ' in this view' : ''}.</td></tr>}
              </tbody>
            </table>
          </div>

          <div style={{ ...box, marginTop: 20 }}>
            <h3 style={{ marginTop: 0 }}>Recent payments</h3>
            {(report.recentPayments || []).length === 0 ? <p style={{ color: 'var(--text-muted)' }}>No payments recorded yet.</p> : (
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <tbody>{report.recentPayments.map(p => (
                  <tr key={p.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td>{fmtDate(p.succeededAt || p.createdAt)}</td>
                    <td>{(p.orderNumbers || []).join(', ')}{p.customerName ? ' · ' + p.customerName : ''}</td>
                    <td>{PAYMENT_METHOD_LABELS[p.method] || p.method || '-'}{p.source === 'stripe' ? ' (online)' : ''}</td>
                    <td>{PAYMENT_STATUS_LABELS[p.status] || p.status}</td>
                    <td style={{ textAlign: 'right' }}>{formatCents(p.amountCents)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
