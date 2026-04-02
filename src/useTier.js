/**
 * useTier — central feature gate hook
 * Reads the org's plan from OrgAuthContext and exposes
 * per-feature booleans + hard-block helper.
 *
 * Plans stored on org.plan:
 *   'trial' | 'starter' | 'pro' | 'business' | 'enterprise' | 'owner'
 */

import { useAuth } from './OrgAuthContext';

// Tier order for "at least X" checks
const TIER_RANK = { trial: 1, starter: 1, pro: 2, business: 3, enterprise: 4, owner: 99 };

const LIMITS = {
  trial:      { users: 2,   orders: 50,   items: 500,  locations: 1    },
  starter:    { users: 2,   orders: 50,   items: 500,  locations: 1    },
  pro:        { users: 5,   orders: 200,  items: 1000, locations: null },
  business:   { users: 15,  orders: 1000, items: 2000, locations: null },
  enterprise: { users: null,orders: null, items: null, locations: null },
  owner:      { users: null,orders: null, items: null, locations: null },
};

export function useTier() {
  const { organization, subscriptionStatus } = useAuth();
  const plan = organization?.plan || 'trial';
  const rank = TIER_RANK[plan] ?? 1;
  const isOwner = plan === 'owner';
  const limits = LIMITS[plan] || LIMITS.trial;

  const atLeast = (tier) => isOwner || rank >= (TIER_RANK[tier] ?? 99);

  return {
    plan,
    isOwner,
    limits,

    // ── Feature flags ──────────────────────────────────────
    // Starter+: inventory, QR, CRM, CSV, audit log, receiving
    canUseInventory:    true,
    canUseQR:           true,
    canUseCustomers:    true,
    canUseCSV:          true,
    canUseActivityLog:  true,
    canUseReceiving:    true,

    // Pro+: orders, pick lists, packing, invoices, reports
    canUseOrders:       atLeast('pro'),
    canUsePickLists:    atLeast('pro'),
    canUsePacking:      atLeast('pro'),
    canUseInvoices:     atLeast('pro'),
    canUseReports:      atLeast('pro'),

    // Business+: shipping, UPS OAuth, triwall, contracts,
    //            international, batch labels, auto-shipping
    canUseShipping:     atLeast('business'),
    canUseUPSAccount:   atLeast('business'),
    canUseTriwall:      atLeast('business'),
    canUseContracts:    atLeast('business'),
    canUseInternational:atLeast('business'),
    canUseBatchLabels:  atLeast('business'),
    canUseAutoShipping: atLeast('business'),

    // Enterprise+: 3rd party billing, dual insurance
    canUseThirdPartyBilling:   atLeast('enterprise'),
    canUseDualInsurance:       atLeast('enterprise'),

    // ── Upgrade prompt helpers ─────────────────────────────
    upgradeRequired: (feature) => ({
      blocked: true,
      feature,
      requiredPlan: featurePlan(feature),
    }),

    // Check a numeric limit — returns { ok, used, limit }
    checkLimit: (type, currentCount) => {
      const lim = limits[type];
      if (lim === null) return { ok: true, used: currentCount, limit: null };
      return { ok: currentCount < lim, used: currentCount, limit: lim };
    },
  };
}

// Maps feature name → minimum plan name for upgrade prompts
function featurePlan(feature) {
  const map = {
    orders: 'Pro', pickLists: 'Pro', packing: 'Pro',
    invoices: 'Pro', reports: 'Pro',
    shipping: 'Business', upsAccount: 'Business',
    triwall: 'Business', contracts: 'Business',
    international: 'Business', batchLabels: 'Business',
    autoShipping: 'Business',
    thirdPartyBilling: 'Enterprise', dualInsurance: 'Enterprise',
  };
  return map[feature] || 'Pro';
}
