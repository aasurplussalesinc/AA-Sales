// SkidSling plans as sold (plan matrix approved 2026-10-26). One copy for the landing page and the in-app
// "choose a plan" page, so the two can never disagree. Limits must match src/useTier.js LIMITS and the feature
// lines must match the gates there (tests/unit/pricingPlans.test.mjs checks the numbers).

export const FOUNDERS_LINE =
  'Founding customers (first 10): free done-for-you setup, AI assistant setup and a direct line, on any plan.';

export const ENTERPRISE_MAILTO = 'mailto:info@skidsling.com?subject=SkidSling%20Enterprise';

// Shown under the cards: things every plan has.
export const EVERY_PLAN_LINE =
  'Every plan: 14-day free trial, your company logo on invoices, packing lists, statements, the payment page, ' +
  'reminder emails and catalogs, and an AI assistant that can answer questions about your stock.';

export const PLANS = [
  {
    key: 'starter', name: 'Starter', monthly: 100, annual: 1000,
    tagline: 'Get off spreadsheets',
    limits: '2 users · 5,000 SKUs · 1 warehouse · Unlimited orders',
    features: [
      '📦 Real-time inventory tracking',
      '📍 Multi-location shelves',
      '📷 QR code scanning',
      '🗺️ Warehouse map',
      '📥 Receiving & stock-in',
      '📋 CSV import / export',
      '👥 Customer CRM',
      '🔐 Roles & full audit trail',
      '🏷️ Your company logo on documents',
      '🤖 AI assistant: read-only (ask about stock)',
    ],
  },
  {
    key: 'pro', name: 'Pro', monthly: 250, annual: 2500,
    tagline: 'Run your orders',
    limits: '5 users · 10,000 SKUs · 3 warehouses · Unlimited orders',
    features: [
      '✅ Everything in Starter',
      '🤖 AI assistant: full control (runs orders & invoices)',
      '🧾 Orders, pick lists & box packing',
      '🪵 Triwall packing mode',
      '🖨️ Invoices & packing slips',
      '💳 Online invoices: card / ACH + automatic reminders',
    ],
    popular: true,
  },
  {
    key: 'business', name: 'Business', monthly: 400, annual: 4000,
    tagline: 'Ship professionally',
    limits: '15 users · 50,000 SKUs · 10 warehouses · Unlimited orders',
    features: [
      '✅ Everything in Pro',
      '📈 Reports: dead stock & inventory turnover',
      '🎙️ Voice-assisted receiving',
      '🚚 Live rates: UPS, USPS, FedEx, DHL',
      '🔗 Use your Shippo, ShipStation & EasyPost accounts',
      '🏷️ Labels & batch printing',
      '🌍 International & customs',
      '⏰ Scheduled auto-shipping',
      '🕶️ Blind drop-ship (ship as your customer)',
      '📦 Bill shipping to the customer’s UPS account',
      '🛡️ Dual insurance comparison',
      '📄 Vendor contracts',
    ],
    service: [
      '🛠️ Done-for-you setup',
      '🤖 AI assistant set up for you',
      '📞 Priority direct line',
    ],
  },
  {
    key: 'enterprise', name: 'Enterprise', contact: true, priceLabel: 'Contact us',
    tagline: 'The full operation',
    limits: 'Unlimited users · Unlimited SKUs · Unlimited warehouses · Unlimited orders',
    features: [
      '✅ Everything in Business',
      '♾️ Unlimited users, SKUs & warehouses',
      '💬 Custom pricing for your operation',
    ],
    comingSoon: [
      '🛒 Marketplace sync: Shopify, eBay, Squarespace',
      '🏢 Several companies under one login',
    ],
  },
];
