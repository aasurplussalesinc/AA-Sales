import { Link } from 'react-router-dom';

export default function LandingPage() {
  const features = [
    {
      icon: '📦',
      title: 'Real-Time Inventory',
      description: 'Track stock levels across multiple warehouses with instant updates'
    },
    {
      icon: '📍',
      title: 'Location Management',
      description: 'Organize inventory by warehouse, rack, aisle, and shelf'
    },
    {
      icon: '📷',
      title: 'QR Code Scanning',
      description: 'Scan items with your phone camera for quick lookups and updates'
    },
    {
      icon: '📋',
      title: 'Pick Lists',
      description: 'Create and manage pick lists for efficient order fulfillment'
    },
    {
      icon: '📊',
      title: 'Reports & Analytics',
      description: 'Dead stock reports, inventory turnover, and custom reports'
    },
    {
      icon: '👥',
      title: 'Team Management',
      description: 'Invite your team with role-based access control'
    },
    {
      icon: '📥',
      title: 'Receiving & POs',
      description: 'Track purchase orders and receiving with automatic stock updates'
    },
    {
      icon: '⚠️',
      title: 'Low Stock Alerts',
      description: 'Set custom thresholds and get alerts when stock runs low'
    }
  ];

  const pricingPlans = [
    {
      name: 'Starter',
      price: 39,
      description: 'For small warehouses',
      features: [
        'Up to 1,000 items',
        '3 team members',
        'QR code scanning',
        'Basic reports',
        'Email support'
      ]
    },
    {
      name: 'Business',
      price: 79,
      description: 'For growing operations',
      features: [
        'Up to 10,000 items',
        '10 team members',
        'Advanced reports',
        'Purchase orders',
        'Priority support',
        'CSV import/export'
      ],
      popular: true
    },
    {
      name: 'Pro',
      price: 149,
      description: 'For large operations',
      features: [
        'Unlimited items',
        'Unlimited team members',
        'Custom reports',
        'API access',
        'Dedicated support',
        'Multiple warehouses'
      ]
    }
  ];

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb' }}>
      {/* Navigation */}
      <nav style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '15px 40px',
        background: 'white',
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
        position: 'sticky',
        top: 0,
        zIndex: 100
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 28 }}>📦</span>
          <span style={{ fontSize: 20, fontWeight: 700, color: '#2d5f3f' }}>Warehouse Manager</span>
        </div>
        <div style={{ display: 'flex', gap: 15 }}>
          <a href="#features" style={{ color: '#333', textDecoration: 'none', fontWeight: 500 }}>Features</a>
          <a href="#pricing" style={{ color: '#333', textDecoration: 'none', fontWeight: 500 }}>Pricing</a>
          <Link to="/login" style={{ color: '#2d5f3f', textDecoration: 'none', fontWeight: 600 }}>Sign In</Link>
          <Link 
            to="/login" 
            style={{ 
              background: '#2d5f3f', 
              color: 'white', 
              padding: '8px 20px', 
              borderRadius: 6,
              textDecoration: 'none',
              fontWeight: 600
            }}
          >
            Start Free Trial
          </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <section style={{
        padding: '80px 40px',
        textAlign: 'center',
        background: 'linear-gradient(135deg, #2d5f3f 0%, #1a3a26 100%)',
        color: 'white'
      }}>
        <h1 style={{ 
          fontSize: 48, 
          fontWeight: 700, 
          marginBottom: 20,
          maxWidth: 800,
          margin: '0 auto 20px'
        }}>
          Manage Your Warehouse Inventory with Ease
        </h1>
        <p style={{ 
          fontSize: 20, 
          opacity: 0.9, 
          maxWidth: 600, 
          margin: '0 auto 40px',
          lineHeight: 1.6
        }}>
          Track inventory, manage locations, scan QR codes, and generate reports — 
          all from one simple platform. Built for small to medium businesses.
        </p>
        <div style={{ display: 'flex', gap: 15, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link 
            to="/login" 
            style={{ 
              background: 'white', 
              color: '#2d5f3f', 
              padding: '15px 40px', 
              borderRadius: 8,
              textDecoration: 'none',
              fontWeight: 700,
              fontSize: 18
            }}
          >
            Start 14-Day Free Trial
          </Link>
          <a 
            href="#features" 
            style={{ 
              background: 'transparent', 
              color: 'white', 
              padding: '15px 40px', 
              borderRadius: 8,
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: 18,
              border: '2px solid white'
            }}
          >
            See Features
          </a>
        </div>
        <p style={{ marginTop: 20, fontSize: 14, opacity: 0.8 }}>
          No credit card required • Cancel anytime
        </p>
      </section>

      {/* Stats Bar */}
      <section style={{
        display: 'flex',
        justifyContent: 'center',
        gap: 60,
        padding: '40px 20px',
        background: 'white',
        flexWrap: 'wrap'
      }}>
        {[
          { number: '10,000+', label: 'Items Tracked Daily' },
          { number: '500+', label: 'Happy Businesses' },
          { number: '99.9%', label: 'Uptime' },
          { number: '24/7', label: 'Support Available' }
        ].map(stat => (
          <div key={stat.label} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 36, fontWeight: 700, color: '#2d5f3f' }}>{stat.number}</div>
            <div style={{ color: '#666', fontSize: 14 }}>{stat.label}</div>
          </div>
        ))}
      </section>

      {/* Features Section */}
      <section id="features" style={{ padding: '80px 40px' }}>
        <h2 style={{ textAlign: 'center', fontSize: 36, marginBottom: 10 }}>
          Everything You Need
        </h2>
        <p style={{ textAlign: 'center', color: '#666', marginBottom: 50, maxWidth: 600, margin: '0 auto 50px' }}>
          Powerful features to help you manage inventory efficiently
        </p>
        
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 30,
          maxWidth: 1200,
          margin: '0 auto'
        }}>
          {features.map(feature => (
            <div 
              key={feature.title}
              style={{
                background: 'white',
                padding: 30,
                borderRadius: 12,
                boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                transition: 'transform 0.2s, box-shadow 0.2s'
              }}
            >
              <div style={{ fontSize: 40, marginBottom: 15 }}>{feature.icon}</div>
              <h3 style={{ fontSize: 18, marginBottom: 10, color: '#333' }}>{feature.title}</h3>
              <p style={{ color: '#666', lineHeight: 1.6, fontSize: 14 }}>{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How It Works */}
      <section style={{ padding: '80px 40px', background: 'white' }}>
        <h2 style={{ textAlign: 'center', fontSize: 36, marginBottom: 50 }}>
          Get Started in Minutes
        </h2>
        
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 40,
          flexWrap: 'wrap',
          maxWidth: 1000,
          margin: '0 auto'
        }}>
          {[
            { step: '1', title: 'Sign Up', description: 'Create your free account in seconds' },
            { step: '2', title: 'Add Inventory', description: 'Import your items or add them manually' },
            { step: '3', title: 'Start Tracking', description: 'Scan, pick, receive, and manage with ease' }
          ].map(item => (
            <div key={item.step} style={{ textAlign: 'center', flex: '1', minWidth: 200 }}>
              <div style={{
                width: 60,
                height: 60,
                borderRadius: '50%',
                background: '#2d5f3f',
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 24,
                fontWeight: 700,
                margin: '0 auto 20px'
              }}>
                {item.step}
              </div>
              <h3 style={{ marginBottom: 10 }}>{item.title}</h3>
              <p style={{ color: '#666' }}>{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" style={{ padding: '80px 40px' }}>
        <h2 style={{ textAlign: 'center', fontSize: 36, marginBottom: 10 }}>
          Simple, Transparent Pricing
        </h2>
        <p style={{ textAlign: 'center', color: '#666', marginBottom: 50 }}>
          Start free, upgrade when you're ready
        </p>
        
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 30,
          flexWrap: 'wrap',
          maxWidth: 1100,
          margin: '0 auto'
        }}>
          {pricingPlans.map(plan => (
            <div 
              key={plan.name}
              style={{
                background: 'white',
                padding: 40,
                borderRadius: 12,
                boxShadow: plan.popular ? '0 8px 30px rgba(45,95,63,0.2)' : '0 2px 8px rgba(0,0,0,0.08)',
                border: plan.popular ? '2px solid #2d5f3f' : '1px solid #eee',
                flex: '1',
                minWidth: 280,
                maxWidth: 350,
                position: 'relative'
              }}
            >
              {plan.popular && (
                <div style={{
                  position: 'absolute',
                  top: -12,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: '#2d5f3f',
                  color: 'white',
                  padding: '5px 15px',
                  borderRadius: 20,
                  fontSize: 12,
                  fontWeight: 600
                }}>
                  MOST POPULAR
                </div>
              )}
              <h3 style={{ fontSize: 24, marginBottom: 5 }}>{plan.name}</h3>
              <p style={{ color: '#666', marginBottom: 20, fontSize: 14 }}>{plan.description}</p>
              <div style={{ marginBottom: 20 }}>
                <span style={{ fontSize: 48, fontWeight: 700 }}>${plan.price}</span>
                <span style={{ color: '#666' }}>/month</span>
              </div>
              <ul style={{ listStyle: 'none', padding: 0, marginBottom: 30 }}>
                {plan.features.map(feature => (
                  <li key={feature} style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: '#4CAF50' }}>✓</span>
                    {feature}
                  </li>
                ))}
              </ul>
              <Link 
                to="/login"
                style={{
                  display: 'block',
                  textAlign: 'center',
                  padding: '12px 20px',
                  borderRadius: 8,
                  textDecoration: 'none',
                  fontWeight: 600,
                  background: plan.popular ? '#2d5f3f' : 'white',
                  color: plan.popular ? 'white' : '#2d5f3f',
                  border: plan.popular ? 'none' : '2px solid #2d5f3f'
                }}
              >
                Start Free Trial
              </Link>
            </div>
          ))}
        </div>
        
        <p style={{ textAlign: 'center', marginTop: 30, color: '#666' }}>
          All plans include a 14-day free trial. No credit card required.
        </p>
      </section>

      {/* CTA Section */}
      <section style={{
        padding: '80px 40px',
        textAlign: 'center',
        background: 'linear-gradient(135deg, #2d5f3f 0%, #1a3a26 100%)',
        color: 'white'
      }}>
        <h2 style={{ fontSize: 36, marginBottom: 15 }}>
          Ready to Streamline Your Warehouse?
        </h2>
        <p style={{ fontSize: 18, opacity: 0.9, marginBottom: 30, maxWidth: 500, margin: '0 auto 30px' }}>
          Join hundreds of businesses already using Warehouse Manager to save time and reduce errors.
        </p>
        <Link 
          to="/login" 
          style={{ 
            display: 'inline-block',
            background: 'white', 
            color: '#2d5f3f', 
            padding: '15px 50px', 
            borderRadius: 8,
            textDecoration: 'none',
            fontWeight: 700,
            fontSize: 18
          }}
        >
          Start Your Free Trial
        </Link>
      </section>

      {/* Footer */}
      <footer style={{
        padding: '40px',
        background: '#1a1a1a',
        color: '#999',
        textAlign: 'center'
      }}>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 30, marginBottom: 20, flexWrap: 'wrap' }}>
          <a href="#features" style={{ color: '#999', textDecoration: 'none' }}>Features</a>
          <a href="#pricing" style={{ color: '#999', textDecoration: 'none' }}>Pricing</a>
          <a href="mailto:support@example.com" style={{ color: '#999', textDecoration: 'none' }}>Support</a>
          <a href="#" style={{ color: '#999', textDecoration: 'none' }}>Privacy Policy</a>
          <a href="#" style={{ color: '#999', textDecoration: 'none' }}>Terms of Service</a>
        </div>
        <p style={{ fontSize: 14 }}>
          © {new Date().getFullYear()} Warehouse Manager. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
