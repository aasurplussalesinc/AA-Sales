import { Link } from 'react-router-dom';

export default function PrivacyPolicy() {
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
          }}>Privacy Policy</h1>
          <p style={{ color: '#606060', fontSize: 14 }}>
            Last updated: {lastUpdated} · AA Innovation Group LLC
          </p>
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 40 }}>

          <Section title="1. Introduction">
            <P>AA Innovation Group LLC ("we," "us," or "our") operates SkidSling, a warehouse management platform. This Privacy Policy explains how we collect, use, disclose, and protect information when you use our Service.</P>
            <P>By using SkidSling, you agree to the collection and use of information as described in this policy. If you do not agree, please do not use the Service.</P>
          </Section>

          <Section title="2. Information We Collect">
            <SubHead>Account Information</SubHead>
            <P>When you create an account, we collect your name, email address, company name, and billing information. This is used to create and manage your account and process payments.</P>

            <SubHead>Business Data You Enter</SubHead>
            <P>SkidSling stores the data you input into the platform: inventory records, item descriptions, quantities, locations, customer information, purchase orders, pick lists, and shipping details. This data belongs to you and is only used to provide the Service.</P>

            <SubHead>Usage and Technical Data</SubHead>
            <P>We automatically collect information about how you use the Service, including log data (IP addresses, browser type, pages visited, timestamps), device information, and feature usage patterns. This helps us improve the Service and diagnose issues.</P>

            <SubHead>Activity Logs</SubHead>
            <P>SkidSling maintains an activity log of actions taken within your organization (inventory changes, order creation, user logins). This data is visible to Admin-level users within your organization and is used for accountability and auditing purposes.</P>
          </Section>

          <Section title="3. How We Use Your Information">
            <P>We use the information we collect to:</P>
            <ul style={{ paddingLeft: 24, lineHeight: 2.2, color: '#a0a0a0', fontSize: 15 }}>
              <li>Provide, maintain, and improve the Service</li>
              <li>Process payments and manage your subscription</li>
              <li>Send transactional emails (account confirmation, invoices, password resets)</li>
              <li>Provide customer support</li>
              <li>Monitor Service health and diagnose technical issues</li>
              <li>Comply with legal obligations</li>
              <li>Enforce our Terms of Service</li>
            </ul>
            <P>We do not sell your data to third parties. We do not use your business data for advertising purposes.</P>
          </Section>

          <Section title="4. Data Sharing and Third Parties">
            <P>We share your information only with the following categories of service providers, and only as necessary to provide the Service:</P>

            <SubHead>Firebase (Google Cloud)</SubHead>
            <P>We use Firebase for authentication, database storage, and cloud functions. Your data is stored on Google's infrastructure under Google's security standards. See Google's Privacy Policy at policies.google.com/privacy.</P>

            <SubHead>Stripe</SubHead>
            <P>We use Stripe to process payments. Your payment card information is handled directly by Stripe and is never stored on our servers. See Stripe's Privacy Policy at stripe.com/privacy.</P>

            <SubHead>Shippo</SubHead>
            <P>If you use the shipping features, shipment data (sender/recipient addresses, package details) is shared with Shippo to generate shipping labels and rates. See Shippo's Privacy Policy at goshippo.com/privacy.</P>

            <SubHead>Legal Requirements</SubHead>
            <P>We may disclose your information if required by law, court order, or governmental authority, or if we believe disclosure is necessary to protect the rights, property, or safety of SkidSling, our users, or the public.</P>
          </Section>

          <Section title="5. Data Security">
            <P>We implement industry-standard security measures to protect your data, including:</P>
            <ul style={{ paddingLeft: 24, lineHeight: 2.2, color: '#a0a0a0', fontSize: 15 }}>
              <li>Encryption in transit (HTTPS/TLS) for all data</li>
              <li>Firebase Security Rules enforcing tenant data isolation</li>
              <li>Role-based access controls within organizations</li>
              <li>Rate limiting on API endpoints</li>
              <li>Authentication handled by Firebase (industry-standard)</li>
            </ul>
            <P>No method of transmission or storage is 100% secure. While we strive to protect your data, we cannot guarantee absolute security. In the event of a data breach that affects your rights, we will notify you as required by applicable law.</P>
          </Section>

          <Section title="6. Data Retention">
            <P>We retain your account data for as long as your account is active. If you cancel your subscription, we will retain your data for 30 days to allow you to export it. After 30 days, your data will be permanently deleted from our systems.</P>
            <P>Billing records and transaction logs may be retained longer as required by tax and financial regulations.</P>
          </Section>

          <Section title="7. Your Rights and Choices">
            <SubHead>Access and Export</SubHead>
            <P>You can export your inventory, customer, and order data from within the SkidSling platform at any time using the export features in each section.</P>

            <SubHead>Correction</SubHead>
            <P>You can update your account information at any time through your organization settings.</P>

            <SubHead>Deletion</SubHead>
            <P>You may request deletion of your account and data by contacting support@skidsling.com. We will process deletion requests within 30 days.</P>

            <SubHead>Opt-Out of Communications</SubHead>
            <P>You can unsubscribe from non-transactional emails at any time. Transactional emails (billing, security alerts) cannot be opted out of while your account is active.</P>
          </Section>

          <Section title="8. Cookies and Tracking">
            <P>SkidSling uses minimal cookies, primarily for authentication session management (Firebase Auth tokens stored in localStorage). We do not use third-party advertising cookies or cross-site tracking.</P>
            <P>The landing page at skidsling.com may use basic analytics (page views, referral sources) to understand traffic. No personally identifiable information is collected through analytics.</P>
          </Section>

          <Section title="9. Children's Privacy">
            <P>SkidSling is a business-to-business platform and is not intended for use by anyone under the age of 18. We do not knowingly collect personal information from minors. If you believe a minor has provided us with information, please contact us immediately.</P>
          </Section>

          <Section title="10. International Users">
            <P>SkidSling is operated from the United States. If you access the Service from outside the United States, your information will be transferred to, stored, and processed in the United States. By using the Service, you consent to this transfer.</P>
            <P>If you are located in the European Economic Area (EEA) or the UK, you may have additional rights under the GDPR. Contact us at support@skidsling.com to exercise these rights.</P>
          </Section>

          <Section title="11. California Privacy Rights (CCPA)">
            <P>If you are a California resident, you have the right to know what personal information we collect about you, to request deletion of your personal information, and to opt out of the sale of your personal information. We do not sell personal information. To exercise your rights, contact support@skidsling.com.</P>
          </Section>

          <Section title="12. Changes to This Policy">
            <P>We may update this Privacy Policy from time to time. We will notify you of material changes by email or through a notice in the Service at least 14 days before the changes take effect. The "last updated" date at the top of this page will always reflect the most recent version.</P>
          </Section>

          <Section title="13. Contact Us">
            <P>If you have questions, concerns, or requests regarding this Privacy Policy or your personal data, contact us at:</P>
            <div style={{
              background: '#111', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8, padding: '16px 20px', marginTop: 12,
              fontSize: 14, lineHeight: 2, color: '#a0a0a0'
            }}>
              <strong style={{ color: '#f0f0f0' }}>AA Innovation Group LLC</strong><br />
              Privacy Officer — SkidSling<br />
              Ronkonkoma, NY 11779<br />
              <a href="mailto:support@skidsling.com" style={{ color: '#34d399' }}>support@skidsling.com</a>
            </div>
          </Section>
        </div>

        {/* Footer links */}
        <div style={{
          marginTop: 60, paddingTop: 32,
          borderTop: '1px solid rgba(255,255,255,0.08)',
          display: 'flex', gap: 24, fontSize: 13
        }}>
          <Link to="/terms" style={{ color: '#34d399', textDecoration: 'none' }}>Terms of Service</Link>
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

function SubHead({ children }) {
  return (
    <h3 style={{
      fontSize: 14, fontWeight: 700, color: '#34d399',
      marginBottom: 8, marginTop: 20, textTransform: 'uppercase',
      letterSpacing: 0.5
    }}>{children}</h3>
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
