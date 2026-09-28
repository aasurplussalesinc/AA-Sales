import { useState, useEffect } from 'react';
import { Invoices, formatCents, INVOICE_STATUS_LABELS, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from '../invoicingApi';

// Invoice & payments on the order screen: balance due, every payment (online
// and manual), the customer's pay link, and recording a check/cash/Zelle
// payment. All figures come from the server (functions/invoicing.js), which
// computes them from the `payments` ledger.
const MANUAL_METHODS = [
  ['check', 'Check'], ['cash', 'Cash'], ['zelle', 'Zelle'], ['ach', 'ACH / bank transfer'],
  ['wire', 'Wire'], ['card', 'Card (taken outside SkidSling)'], ['other', 'Other']
];

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString() : '');

export default function InvoicePanel({ order, orgId, canEdit, onChanged, extraActions }) {
  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [showRecord, setShowRecord] = useState(false);
  const [pay, setPay] = useState({ amount: '', method: 'check', receivedDate: new Date().toISOString().slice(0, 10), note: '' });

  const load = async () => {
    setLoading(true); setError('');
    try { setDetails(await Invoices.getDetails({ orgId, orderId: order.id })); }
    catch (e) { setError(e.message || String(e)); }
    setLoading(false);
  };
  useEffect(() => { if (order?.id && orgId) load(); }, [order?.id, orgId]);

  const run = async (label, fn) => {
    setBusy(label); setError(''); setNote('');
    try { await fn(); } catch (e) { setError(e.message || String(e)); }
    setBusy('');
  };

  const copyLink = () => run('Getting pay link...', async () => {
    const r = await Invoices.getPayLink({ orgId, orderId: order.id });
    try { await navigator.clipboard.writeText(r.url); setNote('Pay link copied to the clipboard.'); }
    catch { window.prompt('Copy the pay link:', r.url); }
    await load();
  });

  const openRecord = () => {
    const due = details?.state?.collectibleCents || 0;
    setPay(p => ({ ...p, amount: due > 0 ? (due / 100).toFixed(2) : '' }));
    setShowRecord(true);
  };
  const saveManual = () => run('Recording payment...', async () => {
    await Invoices.recordManualPayment({ orgId, orderId: order.id, ...pay });
    setShowRecord(false);
    setNote('Payment recorded.');
    await load();
    onChanged && onChanged();
  });
  const reverse = (p) => {
    const reason = window.prompt('Reverse this ' + formatCents(p.amountCents) + ' ' + (PAYMENT_METHOD_LABELS[p.method] || p.method) + ' payment? Reason:', 'Entered by mistake');
    if (reason === null) return;
    run('Reversing...', async () => {
      await Invoices.reverseManualPayment({ orgId, paymentId: p.id, reason });
      await load();
      onChanged && onChanged();
    });
  };

  if (loading && !details) return <div style={{ padding: 12, fontSize: 13, color: 'var(--text-muted)' }}>Loading invoice...</div>;
  if (!details) return error ? <div style={{ padding: 12, fontSize: 13, color: '#c62828' }}>{error}</div> : null;

  const st = details.state;
  const badge = INVOICE_STATUS_LABELS[st.status] || INVOICE_STATUS_LABELS.draft;
  const inv = details.invoice;
  const online = details.online;

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <strong>🧾 Invoice &amp; payments</strong>
        <span style={{ background: badge.bg, color: badge.color, padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700 }}>
          {badge.label}{st.daysOverdue > 0 ? ` · ${st.daysOverdue}d` : ''}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, fontSize: 13, marginBottom: 10 }}>
        <div><div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Invoice total</div><strong>{formatCents(st.totalCents)}</strong></div>
        <div><div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Paid</div><strong style={{ color: '#2e7d32' }}>{formatCents(st.paidCents)}</strong></div>
        <div><div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Balance due</div><strong style={{ color: st.balanceCents > 0 ? '#c62828' : undefined }}>{formatCents(st.balanceCents)}</strong></div>
        {st.dueDate && <div><div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Due</div><strong>{st.dueDate}</strong></div>}
      </div>
      {st.paymentPending && <div style={{ fontSize: 13, color: '#b26a00', marginBottom: 6 }}>⏳ Payment pending (bank transfer): {formatCents(st.pendingCents)} is clearing.</div>}
      {st.creditCents > 0 && <div style={{ fontSize: 13, color: '#2e7d32', marginBottom: 6 }}>Overpaid: {formatCents(st.creditCents)} credit on this invoice.</div>}
      {st.zeroTotal && st.issued && <div style={{ fontSize: 13, color: '#b26a00', marginBottom: 6 }}>The invoice shows $0.00 - no line has a shipped quantity yet.</div>}
      {st.manualPaid && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Marked paid by hand.</div>}
      {inv.sentAt && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sent {fmtDate(inv.sentAt)}{inv.sentTo?.length ? ' to ' + inv.sentTo.join(', ') : ''}{inv.reminderCount ? ` · ${inv.reminderCount} reminder${inv.reminderCount === 1 ? '' : 's'}, last ${fmtDate(inv.lastReminderAt)}` : ''}{inv.remindersPaused ? ' · reminders paused' : ''}</div>}

      {details.payments.length > 0 && (
        <table style={{ width: '100%', fontSize: 12, marginTop: 10, borderCollapse: 'collapse' }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}><th>Date</th><th>Method</th><th>Status</th><th style={{ textAlign: 'right' }}>Amount</th><th></th></tr></thead>
          <tbody>
            {details.payments.map(p => (
              <tr key={p.id} style={{ borderTop: '1px solid var(--border)', opacity: p.status === 'voided' || p.status === 'failed' ? 0.6 : 1 }}>
                <td>{fmtDate(p.succeededAt || p.createdAt)}</td>
                <td>{PAYMENT_METHOD_LABELS[p.method] || p.method || '-'}{p.source === 'stripe' ? ' (online)' : ''}{p.kind === 'statement' ? ' · statement' : ''}</td>
                <td>{PAYMENT_STATUS_LABELS[p.status] || p.status}{p.disputed ? ' · DISPUTED' : ''}{p.failureMessage ? ' - ' + p.failureMessage : ''}</td>
                <td style={{ textAlign: 'right' }}>
                  {formatCents(p.allocations.find(a => a.orderId === order.id)?.cents ?? p.amountCents)}
                  {p.refundedCents > 0 && <div style={{ color: '#c62828' }}>-{formatCents(p.refundedCents)} refunded</div>}
                  {p.feeCents != null && <div style={{ color: 'var(--text-muted)' }}>fee {formatCents(p.feeCents)}</div>}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {canEdit && p.source === 'manual' && p.status !== 'voided' && (
                    <button className="btn btn-sm" disabled={!!busy} onClick={() => reverse(p)} style={{ fontSize: 11, padding: '2px 6px' }}>Reverse</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canEdit && st.status !== 'void' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {online.ready && st.collectibleCents > 0 && (
            <button className="btn" disabled={!!busy} onClick={copyLink} style={{ background: '#1565c0', color: 'white', fontSize: 12 }}>🔗 Copy pay link</button>
          )}
          <button className="btn" disabled={!!busy} onClick={openRecord} style={{ background: '#2e7d32', color: 'white', fontSize: 12 }}>💵 Record payment</button>
          {extraActions && extraActions({ details, reload: load, run })}
        </div>
      )}
      {canEdit && !online.ready && online.enabled && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>Pay online unavailable: {online.reason}</div>}

      {showRecord && (
        <div style={{ marginTop: 12, padding: 12, border: '1px dashed var(--border)', borderRadius: 6 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            <label style={{ fontSize: 12 }}>Amount ($)<input className="form-input" type="number" step="0.01" min="0" value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} style={{ width: '100%' }} /></label>
            <label style={{ fontSize: 12 }}>Method<select className="form-input" value={pay.method} onChange={e => setPay({ ...pay, method: e.target.value })} style={{ width: '100%' }}>{MANUAL_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label style={{ fontSize: 12 }}>Received<input className="form-input" type="date" value={pay.receivedDate} onChange={e => setPay({ ...pay, receivedDate: e.target.value })} style={{ width: '100%' }} /></label>
          </div>
          <label style={{ fontSize: 12, display: 'block', marginTop: 8 }}>Note (check number, reference)<input className="form-input" value={pay.note} onChange={e => setPay({ ...pay, note: e.target.value })} style={{ width: '100%' }} /></label>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-primary" disabled={!!busy || !(parseFloat(pay.amount) > 0)} onClick={saveManual}>Save payment</button>
            <button className="btn" onClick={() => setShowRecord(false)}>Cancel</button>
          </div>
        </div>
      )}

      {busy && <div style={{ fontSize: 12, marginTop: 8 }}>{busy}</div>}
      {note && <div style={{ fontSize: 12, marginTop: 8, color: '#2e7d32' }}>{note}</div>}
      {error && <div style={{ fontSize: 12, marginTop: 8, color: '#c62828' }}>{error}</div>}
    </div>
  );
}
