import { Link } from 'react-router-dom';
import { useState, useEffect } from 'react';

const TIERS = [
  {
    name: 'Starter', price: 50, color: '#b8860b', bg: 'rgba(184,134,11,0.12)',
    tagline: 'Get off spreadsheets',
    limits: '2 users · 500 SKUs · 1 location · 50 orders/mo',
    features: [
      '📦 Real-time inventory tracking',
      '📍 Multi-location management',
      '📷 QR code scanning',
      '👥 Customer CRM',
      '📥 Receiving & stock-in',
      '📋 CSV import / export',
      '🔐 Role-based access control',
      '📜 Full audit trail',
    ],
  },
  {
    name: 'Pro', price: 150, color: '#4a9eff', bg: 'rgba(74,158,255,0.12)',
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
    name: 'Business', price: 250, color: '#a78bfa', bg: 'rgba(167,139,250,0.12)',
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
    name: 'Enterprise', price: 350, color: '#34d399', bg: 'rgba(52,211,153,0.12)',
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
  { icon: '📜', title: 'Full Audit Trail', description: 'Every pick, move, login, and update logged. Filter by user or action type for full accountability.' },
];

export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: 'white', fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=Barlow+Condensed:wght@600;700;800&display=swap" rel="stylesheet" />

      {/* ── NAV ── */}
      <nav style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 200,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '0 48px', height: 68,
        background: scrolled ? 'rgba(10,10,10,0.95)' : 'transparent',
        backdropFilter: scrolled ? 'blur(12px)' : 'none',
        borderBottom: scrolled ? '1px solid rgba(255,255,255,0.08)' : 'none',
        transition: 'all 0.3s ease'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/logo.png" alt="SkidSling" style={{ width: 36, height: 36, mixBlendMode: 'screen' }} />
          <span style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontSize: 22, fontWeight: 800, letterSpacing: 1,
            color: 'white', textTransform: 'uppercase'
          }}>SkidSling</span>
        </div>
        <div style={{ display: 'flex', gap: 32, alignItems: 'center' }}>
          <a href="#features" style={{ color: 'rgba(255,255,255,0.7)', textDecoration: 'none', fontSize: 14, fontWeight: 500, letterSpacing: 0.3 }}>Features</a>
          <a href="#pricing" style={{ color: 'rgba(255,255,255,0.7)', textDecoration: 'none', fontSize: 14, fontWeight: 500, letterSpacing: 0.3 }}>Pricing</a>
          <Link to="/login" style={{ color: 'rgba(255,255,255,0.7)', textDecoration: 'none', fontSize: 14, fontWeight: 500 }}>Sign In</Link>
          <Link to="/login" style={{
            background: 'white', color: '#0a0a0a',
            padding: '9px 22px', borderRadius: 6,
            textDecoration: 'none', fontWeight: 700, fontSize: 13, letterSpacing: 0.3
          }}>Start Free Trial</Link>
        </div>
      </nav>

      {/* ── HERO ── */}
      <section style={{
        position: 'relative', minHeight: '100vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden'
      }}>
        {/* Background image */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'url(/warehouse-bg.jpg)',
          backgroundSize: 'cover', backgroundPosition: 'center',
          backgroundAttachment: 'fixed',
          filter: 'brightness(0.35)',
        }} />

        {/* Dark gradient overlay — heavier at top and bottom */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(to bottom, rgba(10,10,10,0.6) 0%, rgba(10,10,10,0.1) 40%, rgba(10,10,10,0.1) 60%, rgba(10,10,10,0.9) 100%)',
        }} />

        {/* Subtle green accent glow bottom-left */}
        <div style={{
          position: 'absolute', bottom: -100, left: -100,
          width: 600, height: 600, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(45,95,63,0.25) 0%, transparent 70%)',
          pointerEvents: 'none'
        }} />

        {/* Content */}
        <div style={{ position: 'relative', textAlign: 'center', padding: '0 24px', maxWidth: 900 }}>
          {/* Logo + wordmark lockup */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginBottom: 24 }}>
            <img src="/logo.png" alt="SkidSling" style={{ width: 64, height: 64, mixBlendMode: 'screen' }} />
            <span style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontSize: 48, fontWeight: 800, letterSpacing: 2,
              color: 'white', textTransform: 'uppercase', lineHeight: 1
            }}>SkidSling</span>
          </div>

          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
            padding: '6px 16px', borderRadius: 20, marginBottom: 32,
            backdropFilter: 'blur(8px)'
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#34d399', display: 'inline-block' }} />
            <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: 1.5, color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase' }}>
              Built for B2B Wholesale & Distribution
            </span>
          </div>

          <h1 style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontSize: 'clamp(52px, 8vw, 96px)',
            fontWeight: 800, lineHeight: 0.95,
            letterSpacing: -1, marginBottom: 28,
            textTransform: 'uppercase',
          }}>
            <span style={{ display: 'block', color: 'white' }}>Warehouse</span>
            <span style={{ display: 'block', color: '#34d399' }}>Management</span>
            <span style={{ display: 'block', color: 'white' }}>That Ships.</span>
          </h1>

          <p style={{
            fontSize: 18, color: 'rgba(255,255,255,0.7)', maxWidth: 560,
            margin: '0 auto 44px', lineHeight: 1.75, fontWeight: 400
          }}>
            Inventory tracking, pick lists, purchase orders, and live shipping rates —
            one platform for businesses that move real freight.
          </p>

          <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link to="/login" style={{
              background: '#34d399', color: '#0a0a0a',
              padding: '15px 40px', borderRadius: 6,
              textDecoration: 'none', fontWeight: 700, fontSize: 15, letterSpacing: 0.3
            }}>Start 14-Day Free Trial</Link>
            <a href="#pricing" style={{
              background: 'transparent', color: 'white',
              padding: '15px 40px', borderRadius: 6,
              textDecoration: 'none', fontWeight: 600, fontSize: 15,
              border: '1px solid rgba(255,255,255,0.3)'
            }}>See Pricing</a>
          </div>
          <p style={{ marginTop: 20, fontSize: 12, color: 'rgba(255,255,255,0.4)', letterSpacing: 0.5 }}>
            NO CREDIT CARD REQUIRED · CANCEL ANYTIME
          </p>
        </div>

        {/* Scroll indicator */}
        <div style={{
          position: 'absolute', bottom: 36, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, opacity: 0.4
        }}>
          <span style={{ fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', color: 'white' }}>Scroll</span>
          <div style={{ width: 1, height: 40, background: 'linear-gradient(to bottom, white, transparent)' }} />
        </div>
      </section>

      {/* ── STATS BAR ── */}
      <section style={{
        display: 'flex', justifyContent: 'center', gap: 0,
        background: '#111', borderTop: '1px solid rgba(255,255,255,0.06)',
        borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap'
      }}>
        {[
          { number: '$50/mo', label: 'Starting Price' },
          { number: '4', label: 'Carriers Supported' },
          { number: '14-Day', label: 'Free Trial' },
          { number: '99.9%', label: 'Uptime' },
        ].map((s, i) => (
          <div key={s.label} style={{
            textAlign: 'center', padding: '32px 60px',
            borderRight: i < 3 ? '1px solid rgba(255,255,255,0.06)' : 'none'
          }}>
            <div style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontSize: 40, fontWeight: 800, color: '#34d399', letterSpacing: -0.5
            }}>{s.number}</div>
            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 4, letterSpacing: 1.5, textTransform: 'uppercase' }}>{s.label}</div>
          </div>
        ))}
      </section>

      {/* ── FEATURES ── */}
      <section id="features" style={{ padding: '100px 48px', background: '#0d0d0d' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={{ marginBottom: 72, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 20 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 3, color: '#34d399', textTransform: 'uppercase', marginBottom: 14 }}>Platform Features</div>
              <h2 style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontSize: 52, fontWeight: 800, lineHeight: 1,
                textTransform: 'uppercase', margin: 0
              }}>Everything You Need<br />To Run Your Operation</h2>
            </div>
            <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 15, maxWidth: 320, lineHeight: 1.7, margin: 0 }}>
              From receiving to shipping — one platform handles it all, without the enterprise price tag.
            </p>
          </div>

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 1,
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.06)'
          }}>
            {FEATURES.map((f, i) => (
              <div key={f.title} style={{
                background: '#0d0d0d', padding: '36px 32px',
                borderRight: '1px solid rgba(255,255,255,0.06)',
                transition: 'background 0.2s',
              }}
                onMouseEnter={e => e.currentTarget.style.background = '#141414'}
                onMouseLeave={e => e.currentTarget.style.background = '#0d0d0d'}
              >
                <div style={{ fontSize: 32, marginBottom: 16 }}>{f.icon}</div>
                <h3 style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontSize: 20, fontWeight: 700, marginBottom: 10,
                  textTransform: 'uppercase', letterSpacing: 0.5
                }}>{f.title}</h3>
                <p style={{ color: 'rgba(255,255,255,0.5)', lineHeight: 1.65, fontSize: 14, margin: 0 }}>{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section style={{ padding: '100px 48px', background: '#111', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ maxWidth: 1000, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 3, color: '#34d399', textTransform: 'uppercase', marginBottom: 14 }}>Getting Started</div>
          <h2 style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontSize: 52, fontWeight: 800, textTransform: 'uppercase', marginBottom: 64
          }}>Up and Running in Minutes</h2>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 48, flexWrap: 'wrap' }}>
            {[
              { step: '01', title: 'Create Your Account', desc: 'Sign up free — no credit card. Your 14-day trial starts immediately with full access.' },
              { step: '02', title: 'Import Your Inventory', desc: 'Drop in a CSV or add manually. Auto-detects columns and bulk-assigns locations.' },
              { step: '03', title: 'Connect & Ship', desc: 'Add your Shippo key and UPS account. Live rates in under 60 seconds.' },
            ].map(s => (
              <div key={s.step} style={{ flex: '1', minWidth: 220, textAlign: 'center' }}>
                <div style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontSize: 72, fontWeight: 800, color: 'rgba(255,255,255,0.06)',
                  lineHeight: 1, marginBottom: 16
                }}>{s.step}</div>
                <h3 style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontSize: 20, fontWeight: 700, textTransform: 'uppercase',
                  letterSpacing: 0.5, marginBottom: 10, color: 'white'
                }}>{s.title}</h3>
                <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14, lineHeight: 1.7 }}>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING ── */}
      <section id="pricing" style={{ padding: '100px 48px', background: '#0a0a0a', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 72 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 3, color: '#34d399', textTransform: 'uppercase', marginBottom: 14 }}>Pricing</div>
            <h2 style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontSize: 52, fontWeight: 800, textTransform: 'uppercase', marginBottom: 14
            }}>Simple, Transparent Pricing</h2>
            <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 16 }}>Start free. Upgrade when you're ready. Downgrade anytime.</p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(255px, 1fr))', gap: 16 }}>
            {TIERS.map(tier => (
              <div key={tier.name} style={{
                background: tier.popular ? 'rgba(255,255,255,0.04)' : '#111',
                border: tier.popular ? `1px solid ${tier.color}` : '1px solid rgba(255,255,255,0.08)',
                borderRadius: 12, padding: 32, position: 'relative',
                boxShadow: tier.popular ? `0 0 40px ${tier.color}22` : 'none',
              }}>
                {tier.popular && (
                  <div style={{
                    position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)',
                    background: tier.color, color: '#0a0a0a',
                    padding: '3px 16px', borderRadius: 20,
                    fontSize: 10, fontWeight: 800, letterSpacing: 1.5,
                    textTransform: 'uppercase', whiteSpace: 'nowrap'
                  }}>Most Popular</div>
                )}

                <div style={{
                  display: 'inline-block', padding: '3px 10px', borderRadius: 4,
                  background: tier.bg, color: tier.color,
                  fontSize: 10, fontWeight: 800, letterSpacing: 2,
                  textTransform: 'uppercase', marginBottom: 20
                }}>{tier.name}</div>

                <div style={{ marginBottom: 6 }}>
                  <span style={{
                    fontFamily: "'Barlow Condensed', sans-serif",
                    fontSize: 56, fontWeight: 800, color: 'white', lineHeight: 1
                  }}>${tier.price}</span>
                  <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 14 }}>/month</span>
                </div>

                <div style={{ fontSize: 13, fontWeight: 600, color: tier.color, marginBottom: 6 }}>{tier.tagline}</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginBottom: 24, lineHeight: 1.6, letterSpacing: 0.3 }}>{tier.limits}</div>

                <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 20, marginBottom: 28 }}>
                  {tier.features.map(f => (
                    <div key={f} style={{
                      padding: '7px 0', fontSize: 13,
                      color: 'rgba(255,255,255,0.65)',
                      borderBottom: '1px solid rgba(255,255,255,0.05)', lineHeight: 1.4
                    }}>{f}</div>
                  ))}
                </div>

                <Link to="/login" style={{
                  display: 'block', textAlign: 'center',
                  padding: '13px 20px', borderRadius: 6,
                  textDecoration: 'none', fontWeight: 700, fontSize: 13,
                  letterSpacing: 0.5, textTransform: 'uppercase',
                  background: tier.popular ? tier.color : 'transparent',
                  color: tier.popular ? '#0a0a0a' : tier.color,
                  border: `1px solid ${tier.color}`,
                  transition: 'all 0.2s'
                }}>Start Free Trial</Link>
              </div>
            ))}
          </div>
          <p style={{ textAlign: 'center', marginTop: 32, color: 'rgba(255,255,255,0.3)', fontSize: 13, letterSpacing: 0.3 }}>
            All plans include a 14-day free trial. No credit card required.
          </p>
        </div>
      </section>

      {/* ── CTA ── */}
      <section style={{
        position: 'relative', padding: '120px 48px', textAlign: 'center', overflow: 'hidden',
        background: '#0d0d0d', borderTop: '1px solid rgba(255,255,255,0.06)'
      }}>
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 600, height: 600, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(52,211,153,0.08) 0%, transparent 70%)',
          pointerEvents: 'none'
        }} />
        <div style={{ position: 'relative' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 3, color: '#34d399', textTransform: 'uppercase', marginBottom: 20 }}>Get Started Today</div>
          <h2 style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontSize: 'clamp(40px, 6vw, 72px)', fontWeight: 800,
            textTransform: 'uppercase', marginBottom: 20, lineHeight: 1
          }}>Ready to Stop<br />Losing Track?</h2>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 17, marginBottom: 44, maxWidth: 480, margin: '0 auto 44px', lineHeight: 1.7 }}>
            Built by operators, for operators. Move more. Track everything.
            Get set up in under an hour.
          </p>
          <Link to="/login" style={{
            display: 'inline-block', background: '#34d399', color: '#0a0a0a',
            padding: '16px 52px', borderRadius: 6,
            textDecoration: 'none', fontWeight: 800, fontSize: 15, letterSpacing: 0.5,
            textTransform: 'uppercase'
          }}>Start Your Free Trial</Link>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{
        padding: '36px 48px', background: '#080808',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src="/logo.png" alt="SkidSling" style={{ width: 28, height: 28, mixBlendMode: 'screen' }} />
          <span style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontSize: 16, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.4)'
          }}>SkidSling</span>
        </div>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          {['Features', 'Pricing', 'Support', 'Privacy', 'Terms'].map(l => (
            <a key={l} href={l === 'Features' ? '#features' : l === 'Pricing' ? '#pricing' : l === 'Support' ? 'mailto:support@skidsling.com' : '#'}
              style={{ color: 'rgba(255,255,255,0.3)', textDecoration: 'none', fontSize: 13 }}>{l}</a>
          ))}
        </div>
        <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.2)', margin: 0 }}>
          © {new Date().getFullYear()} SkidSling · AA Innovation Group LLC
        </p>
      </footer>
    </div>
  );
}
