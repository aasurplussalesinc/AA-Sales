import { useAuth } from '../OrgAuthContext';

const TIERS = [
  {
    name: 'Starter', price: 50, color: '#546e7a', bg: '#eceff1',
    tagline: 'Get off spreadsheets',
    limits: '2 users · 500 SKUs · 1 location · 50 orders/mo',
    features: ['Real-time inventory', 'QR scanning', 'Customer CRM', 'CSV import/export', 'Receiving & stock-in', 'Audit trail'],
  },
  {
    name: 'Pro', price: 150, color: '#1976d2', bg: '#e3f2fd',
    tagline: 'Run your orders',
    limits: '5 users · 1,000 SKUs · unlimited locations · 200 orders/mo',
    features: ['Everything in Starter', 'Purchase orders', 'Pick lists', 'Box packing & invoices', 'Reports & analytics'],
    popular: true,
  },
  {
    name: 'Business', price: 250, color: '#7b1fa2', bg: '#f3e5f5',
    tagline: 'Ship professionally',
    limits: '15 users · 2,000 SKUs · unlimited locations · 1,000 orders/mo',
    features: ['Everything in Pro', 'Live shipping rates', 'Own UPS account', 'Batch label printing', 'International & customs', 'Triwall packing', 'Vendor contracts'],
  },
  {
    name: 'Enterprise', price: 350, color: '#0d7a52', bg: '#e8f5e9',
    tagline: 'The full operation',
    limits: 'Unlimited users · Unlimited SKUs · Unlimited orders',
    features: ['Everything in Business', 'Bill to customer UPS account', 'Dual insurance comparison', 'Unlimited everything', 'Priority support & SLA'],
  },
];

export default function SubscriptionRequired() {
  const { organization, logout, subscriptionStatus } = useAuth();

  const handleSelectPlan = (planName) => {
    alert(`Redirecting to checkout for ${planName} plan...`);
  };

  const isExpired = subscriptionStatus && !subscriptionStatus.isActive;
  const isTrial = subscriptionStatus?.plan === 'trial';

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0d7a52 0%, #0a6444 100%)',
      padding: '40px 20px',
      fontFamily: 'system-ui,-apple-system,sans-serif'
    }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 48 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📦</div>
          <h1 style={{ color: 'white', fontSize: 34, fontWeight: 800, marginBottom: 12 }}>
            {isTrial ? 'Your Trial Has Ended' : 'Subscription Required'}
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: 17, marginBottom: 8 }}>
            {isTrial
              ? 'Choose a plan to continue using SkidSling.'
              : 'Your subscription is inactive. Reactivate to regain access.'}
          </p>
          {organization && (
            <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>
              Organization: <strong style={{ color: 'white' }}>{organization.name}</strong>
            </p>
          )}
        </div>

        {/* Tier cards */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
          gap: 20, marginBottom: 36
        }}>
          {TIERS.map(tier => (
            <div key={tier.name} style={{
              background: 'white', borderRadius: 14, padding: 28, position: 'relative',
              border: tier.popular ? `2px solid ${tier.color}` : '1px solid #e0e0e0',
              boxShadow: tier.popular ? `0 8px 32px ${tier.color}33` : '0 2px 12px rgba(0,0,0,0.1)',
            }}>
              {tier.popular && (
                <div style={{
                  position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)',
                  background: tier.color, color: 'white', padding: '4px 16px',
                  borderRadius: 20, fontSize: 11, fontWeight: 700, letterSpacing: 1, whiteSpace: 'nowrap'
                }}>MOST POPULAR</div>
              )}
              <div style={{
                display: 'inline-block', padding: '3px 10px', borderRadius: 16,
                background: tier.bg, color: tier.color, fontSize: 11, fontWeight: 700,
                marginBottom: 10, letterSpacing: 0.5
              }}>{tier.name.toUpperCase()}</div>

              <div style={{ marginBottom: 4 }}>
                <span style={{ fontSize: 42, fontWeight: 800, color: tier.color }}>${tier.price}</span>
                <span style={{ color: '#888', fontSize: 14 }}>/month</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#444', marginBottom: 4 }}>{tier.tagline}</div>
              <div style={{ fontSize: 11, color: '#999', marginBottom: 16, lineHeight: 1.5 }}>{tier.limits}</div>

              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 20px 0', borderTop: '1px solid #f0f0f0', paddingTop: 14 }}>
                {tier.features.map(f => (
                  <li key={f} style={{
                    padding: '5px 0', fontSize: 12, color: '#555',
                    borderBottom: '1px solid #f8f8f8', display: 'flex', gap: 7, alignItems: 'flex-start'
                  }}>
                    <span style={{ color: tier.color, fontWeight: 700, flexShrink: 0 }}>✓</span>
                    {f}
                  </li>
                ))}
              </ul>

              <button onClick={() => handleSelectPlan(tier.name)} style={{
                width: '100%', padding: '12px', border: `2px solid ${tier.color}`,
                borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 14,
                background: tier.popular ? tier.color : 'white',
                color: tier.popular ? 'white' : tier.color,
              }}>
                Choose {tier.name}
              </button>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 16 }}>
            All plans include a 14-day free trial. No credit card required.
          </p>
          <button onClick={logout} style={{
            background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)',
            textDecoration: 'underline', cursor: 'pointer', fontSize: 13
          }}>
            Sign out and use a different account
          </button>
        </div>
      </div>
    </div>
  );
}
