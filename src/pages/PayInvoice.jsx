import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Invoices, formatCents } from '../invoicingApi';

// Public page behind the "Pay online" link on an invoice or statement:
//   /pay/:orgId/:orderId?t=<signed token>
//   /pay/:orgId/statement/:customerId?t=<signed token>
// No sign-in. The server checks the token, works out the balance at this
// moment and, when the customer clicks Pay, opens a Stripe-hosted Checkout
// page on the company's own Stripe account. Card and bank details are only
// ever typed into Stripe's page.
const wrap = { minHeight: '100vh', background: '#f4f6f5', padding: '32px 16px', fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", color: '#1b1b1b' };
const card = { maxWidth: 520, margin: '0 auto', background: '#fff', borderRadius: 10, boxShadow: '0 2px 10px rgba(0,0,0,0.08)', padding: 24 };
const row = { display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 15 };
const btn = { display: 'block', width: '100%', padding: '14px 16px', marginTop: 10, border: 'none', borderRadius: 8, background: '#0d7a52', color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer' };

export default function PayInvoice() {
  const { orgId, orderId, customerId } = useParams();
  const [search] = useSearchParams();
  const t = search.get('t') || '';
  const justPaid = search.get('paid') === '1';
  const cancelled = search.get('cancelled') === '1';
  const [view, setView] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [partial, setPartial] = useState(false);
  const [partialAmount, setPartialAmount] = useState('');

  const args = { orgId, t, ...(customerId ? { customerId } : { orderId }) };

  const load = async () => {
    try { setView(await Invoices.payLinkStatus(args)); setError(''); }
    catch (e) { setError(e.message || 'This payment link could not be opened.'); }
  };
  useEffect(() => { load(); }, [orgId, orderId, customerId, t]);
  // After Stripe sends the customer back, the webhook usually lands within
  // seconds; look again so the page can say "Paid" rather than a stale balance.
  useEffect(() => {
    if (!justPaid) return undefined;
    const timers = [4000, 12000].map(ms => setTimeout(load, ms));
    return () => timers.forEach(clearTimeout);
  }, [justPaid]);

  const payWith = async (method) => {
    setBusy('Opening secure checkout...'); setError('');
    try {
      const extra = {};
      if (partial && !customerId) {
        const cents = Math.round(parseFloat(partialAmount) * 100);
        if (!(cents >= 100) || cents > view.amountDueNowCents) {
          setError('Enter an amount between $1.00 and ' + formatCents(view.amountDueNowCents) + '.');
          setBusy('');
          return;
        }
        extra.amountCents = cents;
      }
      const r = await Invoices.payLinkCheckout({ ...args, method, ...extra });
      window.location.href = r.url;
    } catch (e) {
      setError(e.message || 'Could not start the payment.');
      setBusy('');
    }
  };

  const isStatement = !!customerId;
  const title = view ? (isStatement ? 'Statement' : 'Invoice ' + (view.orderNumber || '')) : 'Invoice';

  return (
    <div style={wrap}>
      <div style={card}>
        {view?.logoUrl && <img src={view.logoUrl} alt="" style={{ maxHeight: 56, maxWidth: 180, marginBottom: 10 }} />}
        <div style={{ fontSize: 13, color: '#666' }}>{view?.orgName || ''}</div>
        <h1 style={{ fontSize: 24, margin: '4px 0 16px' }}>{title}</h1>
        {view?.testMode && (
          <div style={{ background: '#fff3cd', padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 14 }}>
            <strong>TEST MODE</strong> - no real money moves. Use Stripe test card 4242 4242 4242 4242 (any future date, any CVC)
            or Stripe's test bank account.
          </div>
        )}

        {!view && !error && <p>Loading...</p>}
        {error && !view && <p style={{ color: '#c62828' }}>{error}</p>}

        {view && (
          <>
            {!isStatement && view.customerPO && <div style={{ fontSize: 14, color: '#555', marginBottom: 8 }}>Your PO: {view.customerPO}</div>}
            {isStatement && view.customerName && <div style={{ fontSize: 14, color: '#555', marginBottom: 8 }}>For {view.customerName}</div>}

            {isStatement && Array.isArray(view.invoices) && view.invoices.length > 0 && (
              <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse', marginBottom: 10 }}>
                <thead><tr style={{ textAlign: 'left', color: '#777', fontSize: 12 }}><th>Invoice</th><th>Due</th><th style={{ textAlign: 'right' }}>Balance</th></tr></thead>
                <tbody>{view.invoices.map(inv => (
                  <tr key={inv.orderNumber} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: '6px 0' }}>{inv.orderNumber}{inv.customerPO ? <span style={{ color: '#777' }}> (PO {inv.customerPO})</span> : null}</td>
                    <td>{inv.dueDate}{inv.daysOverdue > 0 ? <span style={{ color: '#c62828' }}> · {inv.daysOverdue}d late</span> : null}</td>
                    <td style={{ textAlign: 'right' }}>{formatCents(inv.balanceCents)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}

            {!isStatement && (
              <>
                <div style={row}><span>Invoice total</span><span>{formatCents(view.totalCents)}</span></div>
                {view.paidCents > 0 && <div style={{ ...row, color: '#2e7d32' }}><span>Paid</span><span>-{formatCents(view.paidCents)}</span></div>}
              </>
            )}
            <div style={{ ...row, fontWeight: 800, fontSize: 18, borderTop: '2px solid #0d7a52', marginTop: 6, paddingTop: 10 }}>
              <span>Balance due</span><span>{formatCents(view.balanceCents)}</span>
            </div>
            {!isStatement && view.dueDate && view.balanceCents > 0 && <div style={{ fontSize: 13, color: '#666' }}>Due {view.dueDate}</div>}

            {justPaid && (
              <div style={{ background: '#e8f5e9', padding: 12, borderRadius: 6, marginTop: 14, fontSize: 14 }}>
                <strong>Thank you!</strong> Your payment was submitted. Card payments show here within a minute; a bank
                transfer can take a few business days to clear.
              </div>
            )}
            {cancelled && !justPaid && <div style={{ fontSize: 13, color: '#666', marginTop: 12 }}>Payment was not completed. You can try again below.</div>}

            {view.balanceCents === 0 && (!isStatement || view.pendingCents === 0) && (
              <div style={{ background: '#e8f5e9', padding: 14, borderRadius: 6, marginTop: 16, fontSize: 16, fontWeight: 700, color: '#2e7d32' }}>
                {view.status === 'void' ? 'This invoice has been cancelled.' : 'Paid, thank you!'}
              </div>
            )}
            {view.pendingCents > 0 && view.amountDueNowCents === 0 && view.balanceCents > 0 && (
              <div style={{ background: '#fff3e0', padding: 14, borderRadius: 6, marginTop: 16, fontSize: 15 }}>
                Payment pending (bank transfer): {formatCents(view.pendingCents)} is on its way. Nothing more to pay right now.
              </div>
            )}

            {view.canPay && (
              <div style={{ marginTop: 16 }}>
                {view.pendingCents > 0 && <div style={{ fontSize: 13, color: '#b26a00' }}>{formatCents(view.pendingCents)} is already clearing by bank transfer.</div>}
                {!isStatement && (
                  <div style={{ fontSize: 13, margin: '6px 0' }}>
                    <label><input type="checkbox" checked={partial} onChange={e => setPartial(e.target.checked)} /> Pay a different amount</label>
                    {partial && (
                      <span> $<input type="number" min="1" step="0.01" value={partialAmount} placeholder={(view.amountDueNowCents / 100).toFixed(2)}
                        onChange={e => setPartialAmount(e.target.value)} style={{ width: 110, padding: 4, marginLeft: 2 }} /></span>
                    )}
                  </div>
                )}
                {view.options.map(o => (
                  <button key={o.method} style={{ ...btn, opacity: busy ? 0.6 : 1 }} disabled={!!busy} onClick={() => payWith(o.method)}>
                    {o.label}: {partial && parseFloat(partialAmount) > 0 ? formatCents(Math.round(parseFloat(partialAmount) * 100)) + (o.surchargeCents ? ' + fee' : '') : formatCents(view.amountDueNowCents + (o.surchargeCents || 0))}
                    {o.surchargeCents > 0 && <div style={{ fontSize: 12, fontWeight: 400 }}>includes {formatCents(o.surchargeCents)} card processing fee</div>}
                  </button>
                ))}
                <div style={{ fontSize: 12, color: '#777', marginTop: 10, textAlign: 'center' }}>Payments are processed securely by Stripe.</div>
              </div>
            )}
            {!view.canPay && view.reason && <p style={{ color: '#b26a00', marginTop: 16 }}>{view.reason}</p>}

            {busy && <p style={{ marginTop: 12 }}>{busy}</p>}
            {error && <p style={{ color: '#c62828', marginTop: 12 }}>{error}</p>}

            <div style={{ fontSize: 13, color: '#666', marginTop: 24, borderTop: '1px solid #eee', paddingTop: 12 }}>
              Questions? {view.orgEmail ? <a href={'mailto:' + view.orgEmail}>{view.orgEmail}</a> : null}{view.orgPhone ? ' · ' + view.orgPhone : ''}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
