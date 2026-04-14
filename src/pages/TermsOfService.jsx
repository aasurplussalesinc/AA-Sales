import { Link } from 'react-router-dom';

export default function TermsOfService() {
  const lastUpdated = 'April 14, 2026';

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      color: '#f0f0f0',
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      {/* Nav */}
      <nav style={{
        position: 'sticky', top: 0, zIndex: 100,
        background: 'rgba(10,10,10,0.95)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        backdropFilter: 'blur(12px)',
        padding: '0 48px', height: 64,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between'
      }}>
        <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
          <img src="/logo.png" alt="SkidSling" style={{ width: 32, height: 32, mixBlendMode: 'screen' }} />
          <span style={{ fontWeight: 800, fontSize: 18, letterSpacing: '-0.5px' }}>
            <span style={{ color: '#f0f0f0' }}>Skid</span><span style={{ color: '#34d399' }}>Sling</span>
          </span>
        </Link>
        <Link to="/login" style={{
          background: '#34d399', color: '#0a0a0a',
          padding: '8px 20px', borderRadius: 6,
          textDecoration: 'none', fontWeight: 700, fontSize: 13
        }}>Sign In</Link>
      </nav>

      {/* Content */}
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '60px 24px 100px' }}>
        {/* Header */}
        <div style={{ marginBottom: 48 }}>
          <div style={{
            display: 'inline-block',
            background: 'rgba(52,211,153,0.1)',
            border: '1px solid rgba(52,211,153,0.2)',
            color: '#34d399', fontSize: 11, fontWeight: 700,
            letterSpacing: 2, padding: '4px 12px', borderRadius: 20,
            textTransform: 'uppercase', marginBottom: 20
          }}>Legal</div>
          <h1 style={{
            fontSize: 'clamp(32px, 5vw, 52px)',
            fontWeight: 800, letterSpacing: '-1px',
            lineHeight: 1.1, marginBottom: 16
          }}>Terms of Service</h1>
          <p style={{ color: '#606060', fontSize: 14 }}>
            Last updated: {lastUpdated} · Effective immediately upon account creation
          </p>
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 40 }}>
          <Section title="1. Agreement to Terms">
            <P>By creating an account or using SkidSling (the "Service"), operated by AA Innovation Group LLC ("Company," "we," "us," or "our"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree, do not use the Service.</P>
            <P>These Terms apply to all visitors, users, and others who access the Service. By using SkidSling on behalf of a business, you represent that you have authority to bind that business to these Terms.</P>
          </Section>

          <Section title="2. Description of Service">
            <P>SkidSling is a cloud-based warehouse management platform that provides inventory tracking, order management, pick lists, packing, and shipping tools for B2B wholesale and distribution businesses.</P>
            <P>We reserve the right to modify, suspend, or discontinue any part of the Service at any time with reasonable notice.</P>
          </Section>

          <Section title="3. Account Registration">
            <P>You must provide accurate, complete information when creating an account. You are responsible for maintaining the security of your account credentials and for all activity that occurs under your account.</P>
            <P>You must be at least 18 years old and have the legal capacity to enter into contracts. Each organization may have multiple users under defined roles (Admin, Manager, Staff), each with different permission levels.</P>
            <P>You agree to notify us immediately at support@skidsling.com of any unauthorized use of your account.</P>
          </Section>

          <Section title="4. Subscription Plans and Payment">
            <P>SkidSling offers the following subscription tiers: Starter ($50/month), Pro ($150/month), Business ($250/month), and Enterprise ($350/month). Pricing is subject to change with 30 days' notice.</P>
            <P>New accounts receive a 14-day free trial with no credit card required. After the trial period, continued use requires a paid subscription.</P>
            <P>Subscriptions are billed monthly in advance. Payment is processed through Stripe. You authorize us to charge your payment method on a recurring basis until you cancel.</P>
            <P>All fees are non-refundable except as required by law or as explicitly stated in a refund request reviewed at our discretion. We may issue credits or refunds on a case-by-case basis.</P>
            <P>Failure to pay may result in suspension or termination of your account after reasonable notice.</P>
          </Section>

          <Section title="5. Free Trial">
            <P>The 14-day free trial gives you full access to all features of the plan you select. We will not charge you during the trial period. If you do not add a payment method before the trial ends, your account will be downgraded to read-only access until a subscription is activated.</P>
          </Section>

          <Section title="6. Acceptable Use">
            <P>You agree not to use SkidSling to:</P>
            <ul style={{ paddingLeft: 24, lineHeight: 2, color: '#a0a0a0' }}>
              <li>Violate any applicable laws or regulations</li>
              <li>Store or transmit illegal, harmful, or fraudulent data</li>
              <li>Attempt to gain unauthorized access to any part of the Service</li>
              <li>Interfere with or disrupt the integrity or performance of the Service</li>
              <li>Reverse engineer, decompile, or attempt to extract source code</li>
              <li>Resell or sublicense the Service without our written consent</li>
              <li>Use the Service to store ITAR-controlled data without proper compliance measures</li>
            </ul>
          </Section>

          <Section title="7. Your Data">
            <P>You retain full ownership of all data you enter into SkidSling, including inventory records, customer information, orders, and documents ("Your Data"). We do not claim any ownership rights over Your Data.</P>
            <P>You grant us a limited license to store, process, and display Your Data solely to provide the Service to you.</P>
            <P>You are responsible for the accuracy and legality of Your Data. We are not responsible for any errors, omissions, or inaccuracies in Your Data.</P>
            <P>Upon account termination, we will retain Your Data for 30 days during which you may request an export. After 30 days, Your Data will be permanently deleted.</P>
          </Section>

          <Section title="8. Multi-Tenant Architecture and Data Isolation">
            <P>SkidSling is a multi-tenant platform. Each organization's data is logically isolated from other organizations. We implement technical and organizational measures to prevent one tenant from accessing another tenant's data. However, no system is completely immune to security incidents, and we cannot guarantee absolute data isolation.</P>
          </Section>

          <Section title="9. Third-Party Services">
            <P>SkidSling integrates with third-party services including Firebase (Google), Stripe (payments), and Shippo (shipping). Your use of these integrations is also subject to those providers' terms of service. We are not responsible for the availability, accuracy, or conduct of third-party services.</P>
          </Section>

          <Section title="10. Intellectual Property">
            <P>The SkidSling platform, including its software, design, trademarks, and content, is owned by AA Innovation Group LLC and protected by intellectual property laws. Nothing in these Terms grants you any rights to our intellectual property except the limited right to use the Service as described herein.</P>
          </Section>

          <Section title="11. Uptime and Service Availability">
            <P>We strive to maintain high availability but do not guarantee any specific uptime percentage. The Service is provided "as is" without warranties of uninterrupted availability. Scheduled maintenance will be communicated in advance where practicable.</P>
          </Section>

          <Section title="12. Limitation of Liability">
            <P>To the maximum extent permitted by law, AA Innovation Group LLC shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of profits, data, inventory discrepancies, or business interruption, arising from your use of or inability to use the Service.</P>
            <P>Our total liability to you for any claims arising under these Terms shall not exceed the amount you paid us in the three months preceding the claim.</P>
          </Section>

          <Section title="13. Disclaimer of Warranties">
            <P>The Service is provided "as is" and "as available" without warranties of any kind, either express or implied, including but not limited to implied warranties of merchantability, fitness for a particular purpose, or non-infringement. We do not warrant that the Service will be error-free or that defects will be corrected.</P>
          </Section>

          <Section title="14. Termination">
            <P>You may cancel your account at any time through the account settings or by contacting support@skidsling.com. Cancellation takes effect at the end of the current billing period.</P>
            <P>We may suspend or terminate your account immediately if you violate these Terms, fail to pay, or engage in conduct we determine is harmful to the Service or other users. We will provide reasonable notice where possible.</P>
          </Section>

          <Section title="15. Governing Law and Disputes">
            <P>These Terms are governed by the laws of the State of New York, without regard to its conflict of law provisions. Any disputes arising from these Terms or your use of the Service shall be resolved in the state or federal courts located in Nassau County, New York.</P>
            <P>Before initiating any formal proceeding, you agree to contact us at support@skidsling.com to attempt to resolve the dispute informally for at least 30 days.</P>
          </Section>

          <Section title="16. Changes to Terms">
            <P>We may update these Terms from time to time. We will notify you of material changes by email or by a notice within the Service at least 14 days before the changes take effect. Continued use of the Service after changes take effect constitutes your acceptance of the updated Terms.</P>
          </Section>

          <Section title="17. Contact">
            <P>Questions about these Terms? Contact us at:</P>
            <div style={{
              background: '#111', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8, padding: '16px 20px', marginTop: 12,
              fontSize: 14, lineHeight: 2, color: '#a0a0a0'
            }}>
              <strong style={{ color: '#f0f0f0' }}>AA Innovation Group LLC</strong><br />
              SkidSling Warehouse Management<br />
              Ronkonkoma, NY 11779<br />
              <a href="mailto:support@skidsling.com" style={{ color: '#34d399' }}>support@skidsling.com</a>
            </div>
          </Section>
        </div>

        {/* Footer links */}
        <div style={{
          marginTop: 60, paddingTop: 32,
          borderTop: '1px solid rgba(255,255,255,0.08)',
          display: 'flex', gap: 24, fontSize: 13, color: '#606060'
        }}>
          <Link to="/privacy" style={{ color: '#34d399', textDecoration: 'none' }}>Privacy Policy</Link>
          <Link to="/" style={{ color: '#606060', textDecoration: 'none' }}>← Back to SkidSling</Link>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 40 }}>
      <h2 style={{
        fontSize: 18, fontWeight: 700, color: '#f0f0f0',
        marginBottom: 16, letterSpacing: '-0.3px'
      }}>{title}</h2>
      {children}
    </div>
  );
}

function P({ children }) {
  return (
    <p style={{
      color: '#a0a0a0', lineHeight: 1.8, fontSize: 15,
      marginBottom: 12
    }}>{children}</p>
  );
}
