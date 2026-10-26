import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../OrgAuthContext';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { PLANS, FOUNDERS_LINE, ENTERPRISE_MAILTO, EVERY_PLAN_LINE } from '../pricingPlans';

// Plan data lives in src/pricingPlans.js (plan matrix 2026-10-26); this page only adds its colours.
// Enterprise is "Contact us": its card links to email and never starts a checkout (the server refuses it too).
const TIER_ACCENTS = { starter: '#546e7a', pro: '#1976d2', business: '#7b1fa2', enterprise: '#0d7a52' };
const TIERS = PLANS.map(p => ({
  ...p,
  color: TIER_ACCENTS[p.key], accent: TIER_ACCENTS[p.key],
  // the in-app cards are compact: drop the emoji the landing page uses
  features: p.features.map(f => f.replace(/^\S+\s/, '')),
  service: p.service && p.service.map(f => f.replace(/^\S+\s/, '')),
  comingSoon: p.comingSoon && p.comingSoon.map(f => f.replace(/^\S+\s/, '')),
}));

export default function SubscriptionRequired() {
  const { organization, logout, subscriptionStatus, loading } = useAuth();
  const [loadingPlan, setLoadingPlan] = useState(null);
  const [error, setError] = useState('');
  const [billingCycle, setBillingCycle] = useState('monthly');

  const isExpired = subscriptionStatus && !subscriptionStatus.isActive;
  const isTrial = subscriptionStatus?.plan === 'trial';
  const isPastDue = subscriptionStatus?.status === 'past_due';

  // If the auth context finished loading but we still don't have an organization,
  // the user is signed in but unaffiliated — show a clear message instead of
  // letting them click plan buttons that would crash on null.id.
  if (!loading && !organization) {
    return (
      <div style={{
        minHeight: '100vh', background: '#0a0a0a',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '40px 20px', fontFamily: "'DM Sans', system-ui, sans-serif"
      }}>
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <Link to="/" aria-label="SkidSling home">
            <img src="/logo.png" alt="SkidSling" style={{ width: 56, height: 56, mixBlendMode: 'screen', marginBottom: 20, cursor: 'pointer' }} />
          </Link>
          <h1 style={{ color: '#f0f0f0', fontSize: 26, fontWeight: 800, marginBottom: 12 }}>
            No Organization Found
          </h1>
          <p style={{ color: '#a0a0a0', fontSize: 15, lineHeight: 1.6, marginBottom: 24 }}>
            You're signed in, but we couldn't find an organization linked to your account. Sign out and back in, or contact support if this keeps happening.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={logout}
              style={{
                background: '#34d399', color: '#0a0a0a', border: 'none',
                padding: '12px 28px', borderRadius: 8, cursor: 'pointer',
                fontWeight: 700, fontSize: 14
              }}
            >
              Sign Out
            </button>
            <a
              href="mailto:support@skidsling.com"
              style={{
                background: 'transparent', color: '#a0a0a0',
                border: '1px solid rgba(255,255,255,0.15)',
                padding: '12px 28px', borderRadius: 8,
                textDecoration: 'none', fontWeight: 600, fontSize: 14
              }}
            >
              Contact Support
            </a>
          </div>
        </div>
      </div>
    );
  }

  const handleSelectPlan = async (planName) => {
    if (String(planName).toLowerCase() === 'enterprise') { window.location.href = ENTERPRISE_MAILTO; return; }
    if (!organization?.id) {
      setError('Organization is still loading. Please wait a moment and try again.');
      return;
    }
    setLoadingPlan(planName);
    setError('');
    try {
      const functions = getFunctions();
      const createCheckout = httpsCallable(functions, 'createCheckoutSession');
      const result = await createCheckout({
        plan: planName.toLowerCase(),
        billingCycle,
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
    if (!organization?.id) {
      setError('Organization is still loading. Please wait a moment and try again.');
      return;
    }
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
          <Link to="/" aria-label="SkidSling home">
            <img src="/logo.png" alt="SkidSling" style={{ width: 56, height: 56, mixBlendMode: 'screen', marginBottom: 16, cursor: 'pointer' }} />
          </Link>
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

        {/* Monthly / Annual toggle */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
            padding: 4, borderRadius: 10
          }}>
            {['monthly', 'annual'].map(cycle => (
              <button
                key={cycle}
                onClick={() => setBillingCycle(cycle)}
                disabled={loadingPlan !== null}
                style={{
                  background: billingCycle === cycle ? '#34d399' : 'transparent',
                  color: billingCycle === cycle ? '#0a0a0a' : 'rgba(255,255,255,0.7)',
                  border: 'none', cursor: loadingPlan ? 'not-allowed' : 'pointer',
                  padding: '8px 22px', borderRadius: 7,
                  fontSize: 13, fontWeight: 700, letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  transition: 'all 0.2s'
                }}
              >
                {cycle === 'monthly' ? 'Monthly' : 'Annual'}
                {cycle === 'annual' && (
                  <span style={{
                    marginLeft: 8, fontSize: 10, fontWeight: 800,
                    background: billingCycle === 'annual' ? 'rgba(10,10,10,0.15)' : 'rgba(52,211,153,0.2)',
                    color: billingCycle === 'annual' ? '#0a0a0a' : '#34d399',
                    padding: '2px 7px', borderRadius: 10, letterSpacing: 0.5
                  }}>
                    SAVE 2 MO
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Founding customers (plan matrix 2026-10-26) */}
        <div style={{ textAlign: 'center', color: '#a0a0a0', fontSize: 13.5, marginBottom: 24 }}>
          ⭐ {FOUNDERS_LINE}
        </div>

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
                    {tier.contact ? tier.priceLabel : `$${billingCycle === 'annual' ? tier.annual.toLocaleString() : tier.monthly}`}
                  </span>
                  {!tier.contact && (
                    <span style={{ color: '#606060', fontSize: 13 }}>
                      {billingCycle === 'annual' ? '/year' : '/month'}
                    </span>
                  )}
                </div>
                {billingCycle === 'annual' && !tier.contact && (
                  <div style={{
                    display: 'inline-block', marginTop: 6,
                    background: 'rgba(52,211,153,0.12)', color: '#34d399',
                    padding: '2px 8px', borderRadius: 4,
                    fontSize: 11, fontWeight: 700, letterSpacing: 0.3
                  }}>
                    Save ${(tier.monthly * 12 - tier.annual).toLocaleString()}/yr
                  </div>
                )}
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
                {tier.service && tier.service.map(f => (
                  <li key={f} style={{
                    fontSize: 13, color: '#a0a0a0', padding: '5px 0',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    display: 'flex', alignItems: 'center', gap: 8
                  }}>
                    <span style={{ color: tier.accent, fontSize: 12, flexShrink: 0 }}>★</span>
                    {f}
                  </li>
                ))}
                {tier.comingSoon && tier.comingSoon.map(f => (
                  <li key={f} style={{
                    fontSize: 13, color: '#606060', padding: '5px 0',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    display: 'flex', alignItems: 'center', gap: 8
                  }}>
                    <span style={{ fontSize: 12, flexShrink: 0 }}>○</span>
                    {f} (coming soon)
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
                {tier.contact ? 'Contact us' : loadingPlan === tier.name ? '⏳ Loading...' : `Get ${tier.name}`}
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
          <p style={{ marginBottom: 10, color: '#8a8a8a', fontSize: 12.5, lineHeight: 1.6 }}>{EVERY_PLAN_LINE}</p>
          <p style={{ marginBottom: 6, color: '#8a8a8a', fontSize: 12.5, lineHeight: 1.6 }}>
            Subscriptions renew automatically each month (or year) at the price shown until you cancel.
            Cancel anytime online in Settings → Manage Billing; it takes effect at the end of the paid period.
            30-day money-back guarantee on your first payment. By subscribing you agree to the{' '}
            <Link to="/terms" style={{ color: '#34d399' }}>Terms of Service</Link>.
          </p>
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
