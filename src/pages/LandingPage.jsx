import { Link } from 'react-router-dom';

const TIERS = [
  {
    name: 'Starter', price: 50, color: '#546e7a', bg: '#eceff1',
    tagline: 'Get off spreadsheets',
    limits: '2 users · 500 SKUs · 1 location · 50 orders/mo',
    features: [
      '📦 Real-time inventory tracking',
      '📍 Multi-location management (rack/shelf/bin)',
      '📷 QR code scanning',
      '👥 Customer CRM',
      '📥 Receiving & stock-in',
      '📋 CSV import / export',
      '🔐 Role-based access control',
      '📜 Full audit trail',
    ],
  },
  {
    name: 'Pro', price: 150, color: '#1976d2', bg: '#e3f2fd',
    tagline: 'Run your orders',
    limits: '5 users · 1,000 SKUs · unlimited locations · 200 orders/mo',
    features: [
      '✅ Everything in Starter',
      '🧾 Full purchase order lifecycle',
      '📋 Pick lists with priority & assignee',
      '📦 Box packing with per-box contents',
      '🖨️ Printable invoices & packing slips',
      '📊 Reports & analytics',
      '📈 Dead stock & inventory turnover',
    ],
    popular: true,
  },
  {
    name: 'Business', price: 250, color: '#7b1fa2', bg: '#f3e5f5',
    tagline: 'Ship professionally',
    limits: '15 users · 2,000 SKUs · unlimited locations · 1,000 orders/mo',
    features: [
      '✅ Everything in Pro',
      '🚚 Live rates — UPS, USPS, FedEx, DHL',
      '🔗 Own UPS account (negotiated rates)',
      '🏷️ Label generation & batch printing',
      '🌍 International & customs declarations',
      '🪵 Triwall packing mode',
      '⏰ Scheduled auto-shipping',
      '📄 Vendor contracts module',
    ],
  },
  {
    name: 'Enterprise', price: 350, color: '#2d5f3f', bg: '#e8f5e9',
    tagline: 'The full operation',
    limits: 'Unlimited users · Unlimited SKUs · Unlimited orders',
    features: [
      '✅ Everything in Business',
      '📦 Bill shipping to customer UPS account',
      '🛡️ Dual insurance comparison',
      '♾️ Unlimited users, SKUs & orders',
      '⭐ Priority support & SLA',
    ],
  },
];

const FEATURES = [
  { icon: '📦', title: 'Real-Time Inventory', description: 'Track stock across warehouses, racks, and shelves with instant updates and low-stock alerts.' },
  { icon: '🚚', title: 'Smart Shipping', description: 'Live rate shopping across UPS, USPS, FedEx & DHL. Connect your own UPS account for negotiated rates.' },
  { icon: '🧾', title: 'Order Management', description: 'Full PO lifecycle from Draft to Paid. Pick lists, box packing, invoices, and packing slips built in.' },
  { icon: '📷', title: 'QR Code Scanning', description: 'Scan warehouse locations and items from your phone. Add, pick, or move stock in seconds.' },
  { icon: '📊', title: 'Reports & Analytics', description: 'Dead stock reports, inventory turnover, value by category, and custom CSV exports.' },
  { icon: '🌍', title: 'International Shipping', description: 'Full customs declaration support. Ship anywhere with automated duties and document generation.' },
  { icon: '👥', title: 'Team Management', description: 'Role-based access for Admin, Manager, and Staff. Invite codes for frictionless onboarding.' },
  { icon: '📜', title: 'Full Audit Trail', description: 'Every pick, move, login, and update logged. Filter by user or action type for accountability.' },
];

export default function LandingPage() {
  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', fontFamily: 'system-ui,-apple-system,sans-serif' }}>

      {/* Nav */}
      <nav style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '15px 40px', background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
        position: 'sticky', top: 0, zIndex: 100
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 28 }}>📦</span>
          <span style={{ fontSize: 20, fontWeight: 700, color: '#2d5f3f' }}>AA Inventory</span>
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <a href="#features" style={{ color: '#555', textDecoration: 'none', fontWeight: 500, fontSize: 14 }}>Features</a>
          <a href="#pricing" style={{ color: '#555', textDecoration: 'none', fontWeight: 500, fontSize: 14 }}>Pricing</a>
          <Link to="/login" style={{ color: '#2d5f3f', textDecoration: 'none', fontWeight: 600, fontSize: 14 }}>Sign In</Link>
          <Link to="/login" style={{
            background: '#2d5f3f', color: 'white', padding: '9px 22px',
            borderRadius: 8, textDecoration: 'none', fontWeight: 600, fontSize: 14
          }}>Start Free Trial</Link>
        </div>
      </nav>

      {/* Hero */}
      <section style={{
        padding: '90px 40px 80px', textAlign: 'center',
        background: 'linear-gradient(135deg, #2d5f3f 0%, #1a3a26 100%)', color: 'white'
      }}>
        <div style={{
          display: 'inline-block', background: 'rgba(255,255,255,0.15)', padding: '6px 16px',
          borderRadius: 20, fontSize: 13, fontWeight: 600, marginBottom: 24, letterSpacing: 0.5
        }}>BUILT FOR MILITARY SURPLUS & B2B WHOLESALE</div>
        <h1 style={{ fontSize: 52, fontWeight: 800, marginBottom: 20, lineHeight: 1.15, maxWidth: 800, margin: '0 auto 20px' }}>
          Warehouse Management That Actually Ships
        </h1>
        <p style={{ fontSize: 20, opacity: 0.9, maxWidth: 600, margin: '0 auto 40px', lineHeight: 1.7 }}>
          Inventory tracking, pick lists, purchase orders, and live shipping rates —
          all in one system built for businesses that move real freight.
        </p>
        <div style={{ display: 'flex', gap: 15, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link to="/login" style={{
            background: 'white', color: '#2d5f3f', padding: '16px 44px',
            borderRadius: 8, textDecoration: 'none', fontWeight: 700, fontSize: 18
          }}>Start 14-Day Free Trial</Link>
          <a href="#pricing" style={{
            background: 'transparent', color: 'white', padding: '16px 44px',
            borderRadius: 8, textDecoration: 'none', fontWeight: 600, fontSize: 18,
            border: '2px solid rgba(255,255,255,0.6)'
          }}>See Pricing</a>
        </div>
        <p style={{ marginTop: 20, fontSize: 13, opacity: 0.7 }}>No credit card required · Cancel anytime</p>
      </section>

      {/* Stats */}
      <section style={{
        display: 'flex', justifyContent: 'center', gap: 60, padding: '36px 20px',
        background: 'white', flexWrap: 'wrap', boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
      }}>
        {[
          { number: '$50/mo', label: 'Starting price' },
          { number: '4', label: 'Carriers supported' },
          { number: '14-day', label: 'Free trial' },
          { number: '99.9%', label: 'Uptime' },
        ].map(s => (
          <div key={s.label} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 32, fontWeight: 800, color: '#2d5f3f' }}>{s.number}</div>
            <div style={{ color: '#888', fontSize: 13, marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </section>

      {/* Features */}
      <section id="features" style={{ padding: '80px 40px', background: '#f9fafb' }}>
        <h2 style={{ textAlign: 'center', fontSize: 36, fontWeight: 800, marginBottom: 12, color: '#1a1a1a' }}>
          Everything You Need to Run Your Operation
        </h2>
        <p style={{ textAlign: 'center', color: '#666', marginBottom: 56, fontSize: 17, maxWidth: 560, margin: '0 auto 56px' }}>
          From receiving to shipping — one platform handles it all.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 28, maxWidth: 1200, margin: '0 auto' }}>
          {FEATURES.map(f => (
            <div key={f.title} style={{
              background: 'white', padding: 28, borderRadius: 12,
              boxShadow: '0 2px 8px rgba(0,0,0,0.07)', borderTop: '3px solid #2d5f3f'
            }}>
              <div style={{ fontSize: 36, marginBottom: 14 }}>{f.icon}</div>
              <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8, color: '#222' }}>{f.title}</h3>
              <p style={{ color: '#666', lineHeight: 1.65, fontSize: 14, margin: 0 }}>{f.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section style={{ padding: '80px 40px', background: 'white' }}>
        <h2 style={{ textAlign: 'center', fontSize: 36, fontWeight: 800, marginBottom: 56, color: '#1a1a1a' }}>
          Up and Running in Minutes
        </h2>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 40, flexWrap: 'wrap', maxWidth: 900, margin: '0 auto' }}>
          {[
            { step: '1', title: 'Create your account', desc: 'Sign up free — no credit card. 14-day trial starts immediately.' },
            { step: '2', title: 'Import your inventory', desc: 'Drop in a CSV or add manually. Auto-detects columns, bulk location assign.' },
            { step: '3', title: 'Connect & ship', desc: 'Add your Shippo key and UPS account. Live rates in under 60 seconds.' },
          ].map(s => (
            <div key={s.step} style={{ textAlign: 'center', flex: '1', minWidth: 220 }}>
              <div style={{
                width: 64, height: 64, borderRadius: '50%', background: '#2d5f3f',
                color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 26, fontWeight: 800, margin: '0 auto 20px'
              }}>{s.step}</div>
              <h3 style={{ fontWeight: 700, marginBottom: 8, color: '#222' }}>{s.title}</h3>
              <p style={{ color: '#666', lineHeight: 1.6, fontSize: 14 }}>{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" style={{ padding: '80px 40px', background: '#f9fafb' }}>
        <h2 style={{ textAlign: 'center', fontSize: 36, fontWeight: 800, marginBottom: 12, color: '#1a1a1a' }}>
          Simple, Transparent Pricing
        </h2>
        <p style={{ textAlign: 'center', color: '#666', marginBottom: 56, fontSize: 16 }}>
          Start free. Upgrade when you're ready. Downgrade anytime.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(255px, 1fr))', gap: 24, maxWidth: 1180, margin: '0 auto' }}>
          {TIERS.map(tier => (
            <div key={tier.name} style={{
              background: 'white', borderRadius: 14, padding: 32, position: 'relative',
              border: tier.popular ? `2px solid ${tier.color}` : '1px solid #e0e0e0',
              boxShadow: tier.popular ? `0 8px 32px ${tier.color}22` : '0 2px 8px rgba(0,0,0,0.07)',
            }}>
              {tier.popular && (
                <div style={{
                  position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)',
                  background: tier.color, color: 'white', padding: '4px 16px',
                  borderRadius: 20, fontSize: 11, fontWeight: 700, letterSpacing: 1, whiteSpace: 'nowrap'
                }}>MOST POPULAR</div>
              )}
              <div style={{
                display: 'inline-block', padding: '4px 12px', borderRadius: 20,
                background: tier.bg, color: tier.color, fontSize: 12, fontWeight: 700,
                marginBottom: 12, letterSpacing: 0.5
              }}>{tier.name.toUpperCase()}</div>
              <div style={{ marginBottom: 4 }}>
                <span style={{ fontSize: 48, fontWeight: 800, color: tier.color }}>${tier.price}</span>
                <span style={{ color: '#888', fontSize: 15 }}>/month</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#333', marginBottom: 4 }}>{tier.tagline}</div>
              <div style={{ fontSize: 12, color: '#999', marginBottom: 20, lineHeight: 1.5 }}>{tier.limits}</div>
              <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 18, marginBottom: 24 }}>
                {tier.features.map(f => (
                  <div key={f} style={{
                    padding: '7px 0', fontSize: 13, color: '#444',
                    borderBottom: '1px solid #f8f8f8', lineHeight: 1.4
                  }}>{f}</div>
                ))}
              </div>
              <Link to="/login" style={{
                display: 'block', textAlign: 'center', padding: '13px 20px',
                borderRadius: 8, textDecoration: 'none', fontWeight: 700, fontSize: 15,
                background: tier.popular ? tier.color : 'white',
                color: tier.popular ? 'white' : tier.color,
                border: `2px solid ${tier.color}`,
              }}>Start Free Trial</Link>
            </div>
          ))}
        </div>
        <p style={{ textAlign: 'center', marginTop: 32, color: '#888', fontSize: 14 }}>
          All plans include a 14-day free trial. No credit card required.
        </p>
      </section>

      {/* CTA */}
      <section style={{
        padding: '80px 40px', textAlign: 'center',
        background: 'linear-gradient(135deg, #2d5f3f 0%, #1a3a26 100%)', color: 'white'
      }}>
        <h2 style={{ fontSize: 36, fontWeight: 800, marginBottom: 16 }}>Ready to Stop Losing Track?</h2>
        <p style={{ fontSize: 18, opacity: 0.9, marginBottom: 36, maxWidth: 500, margin: '0 auto 36px', lineHeight: 1.6 }}>
          Built by a military surplus operator, for military surplus operators.
          Get set up in under an hour.
        </p>
        <Link to="/login" style={{
          display: 'inline-block', background: 'white', color: '#2d5f3f',
          padding: '16px 52px', borderRadius: 8, textDecoration: 'none', fontWeight: 800, fontSize: 18
        }}>Start Your Free Trial</Link>
      </section>

      {/* Footer */}
      <footer style={{ padding: '36px 40px', background: '#111', color: '#666', textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 32, marginBottom: 16, flexWrap: 'wrap' }}>
          <a href="#features" style={{ color: '#666', textDecoration: 'none', fontSize: 14 }}>Features</a>
          <a href="#pricing" style={{ color: '#666', textDecoration: 'none', fontSize: 14 }}>Pricing</a>
          <a href="mailto:support@aamilitarysurplus.com" style={{ color: '#666', textDecoration: 'none', fontSize: 14 }}>Support</a>
          <a href="#" style={{ color: '#666', textDecoration: 'none', fontSize: 14 }}>Privacy Policy</a>
          <a href="#" style={{ color: '#666', textDecoration: 'none', fontSize: 14 }}>Terms of Service</a>
        </div>
        <p style={{ fontSize: 13, margin: 0 }}>© {new Date().getFullYear()} AA Inventory · Built by AA Surplus Sales Inc.</p>
      </footer>
    </div>
  );
}
