import { useState } from 'react';
import { useAuth } from '../OrgAuthContext';
import { getFunctions, httpsCallable } from 'firebase/functions';

const TIERS = [
  {
    name: 'Starter', price: 50, color: '#546e7a', accent: '#546e7a',
    tagline: 'Get off spreadsheets',
    limits: '2 users · 500 SKUs · 1 location · 50 orders/mo',
    features: ['Real-time inventory', 'QR scanning', 'Customer CRM', 'CSV import/export', 'Receiving & stock-in', 'Audit trail'],
  },
  {
    name: 'Pro', price: 150, color: '#1976d2', accent: '#1976d2',
    tagline: 'Run your orders',
    limits: '5 users · 1,000 SKUs · unlimited locations · 200 orders/mo',
    features: ['Everything in Starter', 'Purchase orders', 'Pick lists', 'Box packing & invoices', 'Reports & analytics'],
    popular: true,
  },
  {
    name: 'Business', price: 250, color: '#7b1fa2', accent: '#7b1fa2',
    tagline: 'Ship professionally',
    limits: '15 users · 2,000 SKUs · unlimited locations · 1,000 orders/mo',
    features: ['Everything in Pro', 'Live shipping rates', 'Own UPS account', 'Batch label printing', 'International & customs', 'Triwall packing', 'Vendor contracts'],
  },
  {
    name: 'Enterprise', price: 350, color: '#0d7a52', accent: '#0d7a52',
    tagline: 'The full operation',
    limits: 'Unlimited users · Unlimited SKUs · Unlimited orders',
    features: ['Everything in Business', 'Bill to customer UPS account', 'Dual insurance comparison', 'Unlimited everything', 'Priority support & SLA'],
  },
];

export default function SubscriptionRequired() {
  const { organization, logout, subscriptionStatus } = useAuth();
  const [loadingPlan, setLoadingPlan] = useState(null);
  const [error, setError] = useState('');

  const isExpired = subscriptionStatus && !subscriptionStatus.isActive;
  const isTrial = subscriptionStatus?.plan === 'trial';
  const isPastDue = subscriptionStatus?.status === 'past_due';

  const handleSelectPlan = async (planName) => {
    setLoadingPlan(planName);
    setError('');
    try {
      const functions = getFunctions();
      const createCheckout = httpsCallable(functions, 'createCheckoutSession');
      const result = await createCheckout({
        plan: planName.toLowerCase(),
        orgId: organization.id,
        orgName: organization.name,
      });
      // Redirect to Stripe Checkout
      window.location.href = result.data.url;
    } catch (err) {
      console.error('Checkout error:', err);
      setError(err.message || 'Failed to start checkout. Please try again.');
      setLoadingPlan(null);
    }
  };

  const handleManageBilling = async () => {
    setLoadingPlan('portal');
    setError('');
    try {
      const functions = getFunctions();
      const createPortal = httpsCallable(functions, 'createBillingPortalSession');
      const result = await createPortal({ orgId: organization.id });
      window.location.href = result.data.url;
    } catch (err) {
      setError(err.message || 'Failed to open billing portal.');
      setLoadingPlan(null);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      padding: '40px 20px',
      fontFamily: "'DM Sans', system-ui, sans-serif"
    }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 48 }}>
          <img src="/logo.png" alt="SkidSling" style={{ width: 56, height: 56, mixBlendMode: 'screen', marginBottom: 16 }} />
          <h1 style={{ color: '#f0f0f0', fontSize: 34, fontWeight: 800, marginBottom: 12, letterSpacing: '-0.5px' }}>
            {isPastDue ? 'Payment Past Due' : isTrial ? 'Your Trial Has Ended' : 'Choose Your Plan'}
          </h1>
          <p style={{ color: '#606060', fontSize: 16, marginBottom: 8 }}>
            {isPastDue
              ? 'Your last payment failed. Update your billing to restore access.'
              : isTrial
              ? 'Choose a plan to continue using SkidSling.'
              : 'Your subscription is inactive. Reactivate to regain access.'}
          </p>
          {organization?.name && (
            <div style={{ color: '#34d399', fontSize: 14, fontWeight: 600 }}>
              {organization.name}
            </div>
          )}
        </div>

        {/* Past due — show manage billing prominently */}
        {isPastDue && (
          <div style={{
            background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
            borderRadius: 12, padding: 24, marginBottom: 32, textAlign: 'center'
          }}>
            <p style={{ color: '#f87171', marginBottom: 16, fontSize: 15 }}>
              Your last payment failed. Click below to update your payment method and restore access.
            </p>
            <button
              onClick={handleManageBilling}
              disabled={loadingPlan === 'portal'}
              style={{
                background: '#f87171', color: 'white', border: 'none',
                padding: '12px 32px', borderRadius: 8, cursor: 'pointer',
                fontWeight: 700, fontSize: 15
              }}
            >
              {loadingPlan === 'portal' ? 'Loading...' : '💳 Update Payment Method'}
            </button>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div style={{
            background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
            color: '#f87171', borderRadius: 8, padding: '12px 16px',
            marginBottom: 24, textAlign: 'center', fontSize: 14
          }}>
            {error}
          </div>
        )}

        {/* Pricing cards */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
          gap: 20, marginBottom: 40
        }}>
          {TIERS.map(tier => (
            <div key={tier.name} style={{
              background: '#111',
              border: tier.popular ? `2px solid ${tier.accent}` : '1px solid rgba(255,255,255,0.08)',
              borderRadius: 16, padding: 28,
              position: 'relative',
              display: 'flex', flexDirection: 'column'
            }}>
              {tier.popular && (
                <div style={{
                  position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)',
                  background: tier.accent, color: 'white',
                  padding: '3px 14px', borderRadius: 20,
                  fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                  whiteSpace: 'nowrap'
                }}>MOST POPULAR</div>
              )}

              {/* Plan name + price */}
              <div style={{ marginBottom: 20 }}>
                <div style={{
                  display: 'inline-block',
                  background: tier.accent + '22',
                  color: tier.accent,
                  padding: '3px 10px', borderRadius: 20,
                  fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                  textTransform: 'uppercase', marginBottom: 12
                }}>{tier.name}</div>
                <div style={{ fontSize: 13, color: '#606060', marginBottom: 8 }}>{tier.tagline}</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                  <span style={{ fontSize: 38, fontWeight: 800, color: '#f0f0f0', letterSpacing: '-1px' }}>
                    ${tier.price}
                  </span>
                  <span style={{ color: '#606060', fontSize: 13 }}>/month</span>
                </div>
                <div style={{ fontSize: 12, color: '#404040', marginTop: 6 }}>{tier.limits}</div>
              </div>

              {/* Features */}
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 24px', flex: 1 }}>
                {tier.features.map(f => (
                  <li key={f} style={{
                    fontSize: 13, color: '#a0a0a0', padding: '5px 0',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    display: 'flex', alignItems: 'center', gap: 8
                  }}>
                    <span style={{ color: tier.accent, fontSize: 12, flexShrink: 0 }}>✓</span>
                    {f}
                  </li>
                ))}
              </ul>

              {/* CTA Button */}
              <button
                onClick={() => handleSelectPlan(tier.name)}
                disabled={loadingPlan !== null}
                style={{
                  width: '100%', padding: '13px',
                  background: tier.popular ? tier.accent : 'transparent',
                  color: tier.popular ? 'white' : tier.accent,
                  border: `2px solid ${tier.accent}`,
                  borderRadius: 8, cursor: loadingPlan ? 'not-allowed' : 'pointer',
                  fontWeight: 700, fontSize: 14, letterSpacing: 0.2,
                  opacity: loadingPlan && loadingPlan !== tier.name ? 0.5 : 1,
                  transition: 'all 0.2s'
                }}
              >
                {loadingPlan === tier.name ? '⏳ Loading...' : `Get ${tier.name}`}
              </button>
            </div>
          ))}
        </div>

        {/* Existing subscriber — manage billing */}
        {organization?.stripeCustomerId && !isPastDue && (
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <button
              onClick={handleManageBilling}
              disabled={loadingPlan === 'portal'}
              style={{
                background: 'none', border: '1px solid rgba(255,255,255,0.15)',
                color: '#a0a0a0', padding: '10px 24px', borderRadius: 8,
                cursor: 'pointer', fontSize: 13, fontWeight: 500
              }}
            >
              {loadingPlan === 'portal' ? 'Loading...' : '⚙️ Manage Existing Subscription'}
            </button>
          </div>
        )}

        {/* Footer */}
        <div style={{ textAlign: 'center', color: '#404040', fontSize: 12 }}>
          <p style={{ marginBottom: 6 }}>
            🔒 Secure payment powered by Stripe · No credit card stored by SkidSling
          </p>
          <p>
            Questions?{' '}
            <a href="mailto:support@skidsling.com" style={{ color: '#34d399', textDecoration: 'none' }}>
              support@skidsling.com
            </a>
          </p>
          <button
            onClick={logout}
            style={{
              marginTop: 16, background: 'none', border: 'none',
              color: '#404040', cursor: 'pointer', fontSize: 12,
              textDecoration: 'underline'
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
