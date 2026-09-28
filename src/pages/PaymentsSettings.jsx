import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../OrgAuthContext';
import { Payments, CONNECTION_LABELS, connectionState } from '../invoicingApi';

// Settings -> Payments. A company connects its OWN Stripe account here
// (Stripe Connect). SkidSling stores only the account id and its status flags;
// bank and identity details are entered on Stripe's own pages. Everything that
// emails a customer is off until an admin turns it on.
const box = { background: 'var(--bg-surface)', padding: 20, borderRadius: 8, marginBottom: 20 };
const label = { display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 };

export default function PaymentsSettings() {
  const { organization, userRole, refreshOrganization } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = userRole === 'admin';
  const p = organization?.payments || {};
  const state = connectionState(p);

  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const handledReturn = useRef(false);

  useEffect(() => {
    setForm({
      enabled: !!p.enabled,
      methods: Array.isArray(p.methods) && p.methods.length ? p.methods : ['card', 'us_bank_account'],
      billingEmail: p.billingEmail || '',
      notifyOnPayment: !!p.notifyOnPayment,
      cardSurcharge: {
        enabled: !!(p.cardSurcharge && p.cardSurcharge.enabled),
        percent: p.cardSurcharge && p.cardSurcharge.percent != null ? String(p.cardSurcharge.percent) : '',
        maxInvoiceForCards: p.cardSurcharge && p.cardSurcharge.maxInvoiceForCardsCents != null
          ? String(p.cardSurcharge.maxInvoiceForCardsCents / 100) : ''
      }
    });
  }, [organization?.id, organization?.payments]);

  // Coming back from Stripe: refresh the account flags (Account Links) or
  // finish the OAuth exchange for an existing account.
  useEffect(() => {
    if (!organization || !isAdmin || handledReturn.current) return;
    const connect = searchParams.get('connect');
    const code = searchParams.get('code');
    const oauthState = searchParams.get('state');
    const oauthError = searchParams.get('error_description') || searchParams.get('error');
    if (!connect && !code && !oauthError) return;
    handledReturn.current = true;
    (async () => {
      try {
        if (oauthError) {
          setError('Stripe did not connect: ' + oauthError);
        } else if (code) {
          setBusy('Finishing the Stripe connection...');
          await Payments.oauthComplete({ orgId: organization.id, code, state: oauthState });
          setMessage('Stripe account connected.');
        } else {
          setBusy('Checking your Stripe account...');
          await Payments.refreshAccount({ orgId: organization.id });
          setMessage(connect === 'refresh' ? 'The Stripe setup link expired. Click "Finish setup in Stripe" to continue.' : 'Stripe account status updated.');
        }
        await refreshOrganization();
      } catch (e) {
        setError(e.message || String(e));
      } finally {
        setBusy('');
        setSearchParams({}, { replace: true });
      }
    })();
  }, [organization?.id, isAdmin]);

  const run = async (text, fn) => {
    setBusy(text); setError(''); setMessage('');
    try { await fn(); } catch (e) { setError(e.message || String(e)); }
    setBusy('');
  };

  const startConnect = (method) => run('Opening Stripe...', async () => {
    const r = await Payments.connectStart({ orgId: organization.id, method });
    window.location.href = r.url;
  });
  const refresh = () => run('Checking your Stripe account...', async () => {
    await Payments.refreshAccount({ orgId: organization.id });
    await refreshOrganization();
    setMessage('Status refreshed.');
  });
  const disconnect = () => {
    if (!window.confirm('Disconnect Stripe? New "Pay online" links stop working. Past payments are not affected.')) return;
    run('Disconnecting...', async () => {
      await Payments.disconnect({ orgId: organization.id });
      await refreshOrganization();
      setMessage('Disconnected. Customers can no longer pay online until you connect again.');
    });
  };
  const save = () => run('Saving...', async () => {
    await Payments.saveSettings({ orgId: organization.id, settings: form });
    await refreshOrganization();
    setMessage('Payment settings saved.');
  });

  if (!organization) return <div className="page-content"><p>No organization selected</p></div>;
  const badge = CONNECTION_LABELS[state];
  const toggleMethod = (m) => setForm(f => ({ ...f, methods: f.methods.includes(m) ? f.methods.filter(x => x !== m) : [...f.methods, m] }));

  return (
    <div className="page-content">
      <div style={{ marginBottom: 15 }}><Link to="/settings">&larr; Settings</Link></div>
      <h2 style={{ marginTop: 0 }}>Payments &amp; invoicing</h2>

      {busy && <div style={{ ...box, background: 'var(--bg-badge-blue)' }}>{busy}</div>}
      {message && <div style={{ ...box, background: 'var(--bg-success)' }}>{message}</div>}
      {error && <div style={{ ...box, background: 'var(--bg-error)' }}>{error}</div>}

      {/* ── Stripe connection ── */}
      <div style={box}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <h3 style={{ margin: 0 }}>Stripe account</h3>
          <span style={{ background: badge.bg, color: badge.color, padding: '4px 12px', borderRadius: 12, fontWeight: 700, fontSize: 12 }}>{badge.label}</span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Your customers pay into <strong>your own</strong> Stripe account. SkidSling never sees card or bank details and keeps only your Stripe account id.
        </p>
        {p.stripeAccountId && (
          <div style={{ fontSize: 13, marginBottom: 10 }}>
            <div>Account: <code>{p.stripeAccountId}</code>{p.mode === 'test' && <span style={{ marginLeft: 8, color: '#b26a00', fontWeight: 700 }}>TEST MODE</span>}</div>
            <div>Charges: {p.chargesEnabled ? 'enabled' : 'not yet'} &middot; Payouts: {p.payoutsEnabled ? 'enabled' : 'not yet'} &middot; Details submitted: {p.detailsSubmitted ? 'yes' : 'no'}</div>
            {state === 'needs_info' && Array.isArray(p.currentlyDue) && p.currentlyDue.length > 0 && (
              <div style={{ color: '#b26a00' }}>Stripe still needs: {p.currentlyDue.join(', ')}</div>
            )}
          </div>
        )}
        {isAdmin ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {state === 'disconnected' && (
              <>
                <button className="btn btn-primary" disabled={!!busy} onClick={() => startConnect('account_link')}>Connect with Stripe</button>
                <button className="btn" disabled={!!busy} onClick={() => startConnect('oauth')} title="Needs the platform's Connect client id to be configured">Connect an existing Stripe account</button>
              </>
            )}
            {state === 'needs_info' && (
              <button className="btn btn-primary" disabled={!!busy} onClick={() => startConnect('account_link')}>Finish setup in Stripe</button>
            )}
            {p.stripeAccountId && <button className="btn" disabled={!!busy} onClick={refresh}>Refresh status</button>}
            {state !== 'disconnected' && (
              <button className="btn" disabled={!!busy} onClick={disconnect} style={{ background: '#d84315', color: 'white' }}>Disconnect</button>
            )}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Only an admin can change the Stripe connection.</p>
        )}
      </div>

      {/* ── Online payments ── */}
      {form && (
        <div style={box}>
          <h3 style={{ marginTop: 0 }}>Online payments</h3>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input type="checkbox" disabled={!isAdmin} checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
            <span><strong>Turn on invoicing &amp; online payments</strong> for this company (off by default)</span>
          </label>
          <div style={{ marginBottom: 12 }}>
            <span style={label}>Customers can pay by</span>
            <label style={{ marginRight: 16 }}><input type="checkbox" disabled={!isAdmin} checked={form.methods.includes('us_bank_account')} onChange={() => toggleMethod('us_bank_account')} /> Bank transfer (ACH)</label>
            <label><input type="checkbox" disabled={!isAdmin} checked={form.methods.includes('card')} onChange={() => toggleMethod('card')} /> Card</label>
          </div>
          <div style={{ marginBottom: 12, maxWidth: 420 }}>
            <label style={label}>Billing email (replies to invoices go here)</label>
            <input className="form-input" type="email" disabled={!isAdmin} value={form.billingEmail} placeholder={organization.email || 'billing@yourcompany.com'}
              onChange={e => setForm({ ...form, billingEmail: e.target.value })} style={{ width: '100%' }} />
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input type="checkbox" disabled={!isAdmin} checked={form.notifyOnPayment} onChange={e => setForm({ ...form, notifyOnPayment: e.target.checked })} />
            <span>Email the billing address when a payment arrives, fails or is refunded</span>
          </label>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4, marginBottom: 12 }}>
            <span style={label}>Card fees</span>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
              Bank transfer (ACH) costs about 0.8% (capped); cards about 2.9% + 30&cent;. A card surcharge has card-network rules,
              a 3% cap in the US and is restricted in some states - check with your accountant before turning it on.
            </p>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input type="checkbox" disabled={!isAdmin} checked={form.cardSurcharge.enabled}
                onChange={e => setForm({ ...form, cardSurcharge: { ...form.cardSurcharge, enabled: e.target.checked } })} />
              <span>Add a surcharge to card payments</span>
            </label>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 13 }}>Surcharge %
                <input className="form-input" type="number" step="0.1" min="0" max="3" disabled={!isAdmin || !form.cardSurcharge.enabled}
                  value={form.cardSurcharge.percent} onChange={e => setForm({ ...form, cardSurcharge: { ...form.cardSurcharge, percent: e.target.value } })} style={{ width: 90, marginLeft: 6 }} />
              </label>
              <label style={{ fontSize: 13 }}>Cards only for invoices up to $
                <input className="form-input" type="number" step="1" min="0" disabled={!isAdmin} placeholder="no limit"
                  value={form.cardSurcharge.maxInvoiceForCards} onChange={e => setForm({ ...form, cardSurcharge: { ...form.cardSurcharge, maxInvoiceForCards: e.target.value } })} style={{ width: 110, marginLeft: 6 }} />
              </label>
            </div>
          </div>
          {isAdmin && <button className="btn btn-primary" disabled={!!busy} onClick={save}>Save payment settings</button>}
        </div>
      )}
    </div>
  );
}
