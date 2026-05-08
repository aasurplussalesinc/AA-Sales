import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../OrgAuthContext';
import { OrgDB as DB } from '../orgDb';

export default function Onboarding() {
  const { organization, refreshOrganization } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Step 1: Company info / shipping from-address
  const [phone, setPhone] = useState('');
  const [preferredCarrier, setPreferredCarrier] = useState('ups');
  const [fromAddr, setFromAddr] = useState({
    name: '', company: '', street1: '', street2: '',
    city: '', state: '', zip: '', phone: '',
  });

  // Step 2: First location
  const [createdLocation, setCreatedLocation] = useState(null);
  const [location, setLocation] = useState({
    warehouse: 'Main', rack: '1', letter: 'A', shelf: '1', description: ''
  });

  // Step 3: First item
  const [createdItem, setCreatedItem] = useState(null);
  const [item, setItem] = useState({
    name: '', category: '', stock: 0, price: 0, cost: 0,
  });

  // Pre-populate from existing org data on mount
  useEffect(() => {
    if (organization) {
      setPhone(organization.phone || '');
      const settings = organization.settings || {};
      if (settings.shippingFromAddress) {
        setFromAddr({
          name: settings.shippingFromAddress.name || organization.name || '',
          company: settings.shippingFromAddress.company || organization.name || '',
          street1: settings.shippingFromAddress.street1 || '',
          street2: settings.shippingFromAddress.street2 || '',
          city: settings.shippingFromAddress.city || '',
          state: settings.shippingFromAddress.state || '',
          zip: settings.shippingFromAddress.zip || '',
          phone: settings.shippingFromAddress.phone || organization.phone || '',
        });
      } else {
        setFromAddr(prev => ({
          ...prev,
          name: organization.name || '',
          company: organization.name || '',
        }));
      }
      if (settings.preferredCarrier) setPreferredCarrier(settings.preferredCarrier);
    }
  }, [organization]);

  // ─── Step 1: Save company info + from address ───
  const saveStep1 = async () => {
    if (!fromAddr.street1 || !fromAddr.city || !fromAddr.state || !fromAddr.zip) {
      setError('Please fill in your shipping from-address completely');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await DB.updateOrganization(organization.id, {
        phone: phone || '',
        'settings.shippingFromAddress': fromAddr,
        'settings.preferredCarrier': preferredCarrier,
        'onboardingStep': 2,
      });
      await refreshOrganization();
      setStep(2);
    } catch (e) {
      setError(e.message || 'Failed to save');
    }
    setSaving(false);
  };

  // ─── Step 2: Create first location ───
  const saveStep2 = async () => {
    if (!location.warehouse || !location.rack) {
      setError('Warehouse and rack are required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const locationCode = `${location.warehouse}-R${location.rack}-${location.letter}${location.shelf}`;
      const locId = await DB.createLocation({
        ...location,
        locationCode,
      });
      setCreatedLocation({ ...location, id: locId, locationCode });
      await DB.updateOrganization(organization.id, { onboardingStep: 3 });
      await refreshOrganization();
      setStep(3);
    } catch (e) {
      setError(e.message || 'Failed to create location');
    }
    setSaving(false);
  };

  // ─── Step 3: Create first item, mark complete ───
  const saveStep3 = async () => {
    if (!item.name) {
      setError('Item name is required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const itemId = await DB.createItem({
        partNumber: '',
        name: item.name,
        category: item.category || '',
        stock: parseInt(item.stock) || 0,
        price: parseFloat(item.price) || 0,
        cost: parseFloat(item.cost) || 0,
        weight: 0,
        location: createdLocation?.locationCode || '',
        lowStockThreshold: 0,
        reorderPoint: 0,
      });
      setCreatedItem({ ...item, id: itemId });

      // Mark onboarding complete
      await DB.updateOrganization(organization.id, {
        onboardingComplete: true,
        onboardingCompletedAt: Date.now(),
        onboardingStep: 'done',
      });
      await refreshOrganization();
      setStep(4);
    } catch (e) {
      setError(e.message || 'Failed to create item');
    }
    setSaving(false);
  };

  // ─── Skip onboarding entirely ───
  const skipOnboarding = async () => {
    setSaving(true);
    try {
      await DB.updateOrganization(organization.id, {
        onboardingComplete: true,
        onboardingSkipped: true,
        onboardingCompletedAt: Date.now(),
      });
      await refreshOrganization();
      navigate('/dashboard');
    } catch (e) {
      console.error(e);
      navigate('/dashboard');
    }
  };

  // ─── Skip just this step ───
  const skipCurrentStep = async () => {
    if (step === 1) {
      // Mark step 1 done without saving (they'll have to fill it later for shipping)
      await DB.updateOrganization(organization.id, { onboardingStep: 2 });
      await refreshOrganization();
      setStep(2);
    } else if (step === 2) {
      await DB.updateOrganization(organization.id, { onboardingStep: 3 });
      await refreshOrganization();
      setStep(3);
    } else if (step === 3) {
      await DB.updateOrganization(organization.id, {
        onboardingComplete: true,
        onboardingCompletedAt: Date.now(),
      });
      await refreshOrganization();
      setStep(4);
    }
  };

  const finish = () => navigate('/dashboard');

  // ─── Common styles ───
  const inputStyle = {
    width: '100%', padding: '10px 12px', borderRadius: 6,
    border: '1px solid var(--border)', background: 'var(--bg-input)',
    color: 'var(--text-primary)', fontSize: 14, boxSizing: 'border-box'
  };
  const labelStyle = { display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 14 };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-page)', padding: '40px 20px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1 style={{ fontSize: 28, marginBottom: 8, color: 'var(--text-primary)' }}>
            Welcome to <span style={{ color: '#34d399' }}>SkidSling</span>
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 15 }}>
            Let's get your warehouse set up in 3 quick steps.
          </p>
        </div>

        {/* Progress bar */}
        {step <= 3 && (
          <div style={{ marginBottom: 28, display: 'flex', alignItems: 'center', gap: 8 }}>
            {[1, 2, 3].map(n => (
              <React.Fragment key={n}>
                <div style={{
                  width: 32, height: 32, borderRadius: 16,
                  background: step >= n ? '#0d7a52' : 'var(--bg-surface-2)',
                  color: step >= n ? 'white' : 'var(--text-muted)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700, fontSize: 13,
                  border: step === n ? '2px solid #34d399' : '2px solid transparent',
                }}>
                  {step > n ? '✓' : n}
                </div>
                {n < 3 && (
                  <div style={{
                    flex: 1, height: 3, borderRadius: 2,
                    background: step > n ? '#0d7a52' : 'var(--bg-surface-2)'
                  }} />
                )}
              </React.Fragment>
            ))}
          </div>
        )}

        {/* Card container */}
        <div style={{
          background: 'var(--bg-surface)', borderRadius: 12,
          border: '1px solid var(--border)', padding: 32,
          boxShadow: '0 2px 8px rgba(0,0,0,0.04)'
        }}>

          {/* ──────── STEP 1: COMPANY & SHIPPING ──────── */}
          {step === 1 && (
            <>
              <h2 style={{ fontSize: 20, marginBottom: 4 }}>📍 Company & Shipping Info</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>
                We'll use this address as the "ship from" location for every shipping label you generate.
              </p>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Business Phone</label>
                <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 555-5555" style={inputStyle} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Contact Name <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(name printed on label)</span></label>
                <input type="text" value={fromAddr.name} onChange={e => setFromAddr({...fromAddr, name: e.target.value})} placeholder="John Smith" style={inputStyle} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Company Name</label>
                <input type="text" value={fromAddr.company} onChange={e => setFromAddr({...fromAddr, company: e.target.value})} placeholder="Acme Corp" style={inputStyle} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Street Address *</label>
                <input type="text" value={fromAddr.street1} onChange={e => setFromAddr({...fromAddr, street1: e.target.value})} placeholder="123 Main St" style={inputStyle} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Street Address 2 <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(suite, unit)</span></label>
                <input type="text" value={fromAddr.street2} onChange={e => setFromAddr({...fromAddr, street2: e.target.value})} placeholder="Suite 200" style={inputStyle} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
                <div>
                  <label style={labelStyle}>City *</label>
                  <input type="text" value={fromAddr.city} onChange={e => setFromAddr({...fromAddr, city: e.target.value})} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>State *</label>
                  <input type="text" value={fromAddr.state} onChange={e => setFromAddr({...fromAddr, state: e.target.value.toUpperCase()})} placeholder="NY" maxLength={2} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>ZIP *</label>
                  <input type="text" value={fromAddr.zip} onChange={e => setFromAddr({...fromAddr, zip: e.target.value})} placeholder="11779" style={inputStyle} />
                </div>
              </div>

              <div style={{ marginBottom: 20 }}>
                <label style={labelStyle}>Preferred Shipping Carrier</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[
                    { value: 'ups', label: 'UPS', emoji: '🟫' },
                    { value: 'fedex', label: 'FedEx', emoji: '🟧' },
                    { value: 'usps', label: 'USPS', emoji: '🟦' },
                    { value: 'auto', label: 'Cheapest', emoji: '💸' },
                  ].map(c => (
                    <div key={c.value}
                      onClick={() => setPreferredCarrier(c.value)}
                      style={{
                        flex: 1, padding: '12px 8px', borderRadius: 6, cursor: 'pointer',
                        textAlign: 'center', fontSize: 13, fontWeight: 600,
                        border: preferredCarrier === c.value ? '2px solid #0d7a52' : '2px solid var(--border)',
                        background: preferredCarrier === c.value ? 'rgba(13,122,82,0.1)' : 'var(--bg-surface-2)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <div style={{ fontSize: 18, marginBottom: 2 }}>{c.emoji}</div>
                      {c.label}
                    </div>
                  ))}
                </div>
              </div>

              {error && <div style={{ padding: '10px 12px', background: 'rgba(244,67,54,0.1)', color: '#c62828', borderRadius: 6, fontSize: 13, marginBottom: 14 }}>{error}</div>}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                <button onClick={skipCurrentStep} disabled={saving} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', textDecoration: 'underline', cursor: 'pointer', fontSize: 13 }}>
                  Skip for now
                </button>
                <button onClick={saveStep1} disabled={saving} style={{ padding: '12px 28px', background: '#0d7a52', color: 'white', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 14, cursor: saving ? 'wait' : 'pointer' }}>
                  {saving ? 'Saving…' : 'Continue →'}
                </button>
              </div>
            </>
          )}

          {/* ──────── STEP 2: FIRST LOCATION ──────── */}
          {step === 2 && (
            <>
              <h2 style={{ fontSize: 20, marginBottom: 4 }}>📦 Create Your First Location</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>
                Locations are where your inventory lives. Format is Warehouse → Rack → Bay → Shelf. You can add more later.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 10, marginBottom: 16 }}>
                <div>
                  <label style={labelStyle}>Warehouse</label>
                  <input type="text" value={location.warehouse} onChange={e => setLocation({...location, warehouse: e.target.value})} placeholder="Main" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Rack</label>
                  <input type="text" value={location.rack} onChange={e => setLocation({...location, rack: e.target.value})} placeholder="1" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Bay</label>
                  <input type="text" value={location.letter} onChange={e => setLocation({...location, letter: e.target.value.toUpperCase()})} placeholder="A" maxLength={2} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Shelf</label>
                  <input type="text" value={location.shelf} onChange={e => setLocation({...location, shelf: e.target.value})} placeholder="1" style={inputStyle} />
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Description <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                <input type="text" value={location.description} onChange={e => setLocation({...location, description: e.target.value})} placeholder="e.g. Front of warehouse, near loading dock" style={inputStyle} />
              </div>

              <div style={{ padding: 14, background: 'rgba(52,211,153,0.08)', borderRadius: 8, marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>This location's code will be:</div>
                <div style={{ fontFamily: 'monospace', fontSize: 16, fontWeight: 700, color: '#0d7a52' }}>
                  {location.warehouse || 'Main'}-R{location.rack || '1'}-{location.letter || 'A'}{location.shelf || '1'}
                </div>
              </div>

              {error && <div style={{ padding: '10px 12px', background: 'rgba(244,67,54,0.1)', color: '#c62828', borderRadius: 6, fontSize: 13, marginBottom: 14 }}>{error}</div>}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                <button onClick={skipCurrentStep} disabled={saving} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', textDecoration: 'underline', cursor: 'pointer', fontSize: 13 }}>
                  Skip for now
                </button>
                <button onClick={saveStep2} disabled={saving} style={{ padding: '12px 28px', background: '#0d7a52', color: 'white', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 14, cursor: saving ? 'wait' : 'pointer' }}>
                  {saving ? 'Creating…' : 'Create Location →'}
                </button>
              </div>
            </>
          )}

          {/* ──────── STEP 3: FIRST ITEM ──────── */}
          {step === 3 && (
            <>
              <h2 style={{ fontSize: 20, marginBottom: 4 }}>🏷️ Add Your First Item</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>
                Add one item just to see the system in action. You can bulk import via CSV later.
              </p>

              {createdLocation && (
                <div style={{ padding: 12, background: 'rgba(52,211,153,0.08)', borderRadius: 8, marginBottom: 16, fontSize: 13, color: 'var(--text-muted)' }}>
                  Will be assigned to location: <strong style={{ color: '#0d7a52', fontFamily: 'monospace' }}>{createdLocation.locationCode}</strong>
                </div>
              )}

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Item Name *</label>
                <input type="text" value={item.name} onChange={e => setItem({...item, name: e.target.value})} placeholder="e.g. Widget XL" style={inputStyle} autoFocus />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Category <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                <input type="text" value={item.category} onChange={e => setItem({...item, category: e.target.value})} placeholder="e.g. Hardware" style={inputStyle} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 16 }}>
                <div>
                  <label style={labelStyle}>Quantity</label>
                  <input type="number" value={item.stock} onChange={e => setItem({...item, stock: e.target.value})} min="0" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Price <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(sell)</span></label>
                  <input type="number" value={item.price} onChange={e => setItem({...item, price: e.target.value})} min="0" step="0.01" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Cost <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(internal)</span></label>
                  <input type="number" value={item.cost} onChange={e => setItem({...item, cost: e.target.value})} min="0" step="0.01" style={inputStyle} />
                </div>
              </div>

              {error && <div style={{ padding: '10px 12px', background: 'rgba(244,67,54,0.1)', color: '#c62828', borderRadius: 6, fontSize: 13, marginBottom: 14 }}>{error}</div>}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                <button onClick={skipCurrentStep} disabled={saving} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', textDecoration: 'underline', cursor: 'pointer', fontSize: 13 }}>
                  Skip for now
                </button>
                <button onClick={saveStep3} disabled={saving} style={{ padding: '12px 28px', background: '#0d7a52', color: 'white', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 14, cursor: saving ? 'wait' : 'pointer' }}>
                  {saving ? 'Adding…' : 'Add Item →'}
                </button>
              </div>
            </>
          )}

          {/* ──────── STEP 4: COMPLETE ──────── */}
          {step === 4 && (
            <div style={{ textAlign: 'center', padding: '20px 10px' }}>
              <div style={{ fontSize: 56, marginBottom: 12 }}>🎉</div>
              <h2 style={{ fontSize: 24, marginBottom: 8, color: 'var(--text-primary)' }}>You're all set!</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: 15, marginBottom: 24 }}>
                {createdItem
                  ? `Your warehouse is configured and "${createdItem.name}" is your first item.`
                  : 'Your warehouse is configured and ready to go.'}
              </p>

              <div style={{ background: 'var(--bg-surface-2)', padding: 20, borderRadius: 8, marginBottom: 24, textAlign: 'left' }}>
                <h4 style={{ margin: '0 0 12px', fontSize: 14 }}>What's next?</h4>
                <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--text-primary)', lineHeight: 1.8, fontSize: 14 }}>
                  <li>Bulk import items via CSV from the <strong>Items</strong> page</li>
                  <li>Add customers and create your first order</li>
                  <li>Configure shipping integration in <strong>Settings</strong></li>
                  <li>Invite team members from <strong>Settings → Members</strong></li>
                </ul>
              </div>

              <button onClick={finish} style={{
                padding: '14px 40px', background: '#0d7a52', color: 'white',
                border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 15, cursor: 'pointer'
              }}>
                Go to Dashboard →
              </button>
            </div>
          )}
        </div>

        {/* Skip everything link */}
        {step <= 3 && (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button onClick={skipOnboarding} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>
              Skip onboarding entirely
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
