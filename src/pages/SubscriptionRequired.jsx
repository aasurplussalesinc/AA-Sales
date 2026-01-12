import { useAuth } from '../OrgAuthContext';

export default function SubscriptionRequired() {
  const { organization, logout, subscriptionStatus } = useAuth();

  const plans = [
    {
      name: 'Starter',
      price: 39,
      features: [
        '1 user',
        '500 items',
        '50 locations',
        'Basic reports',
        'Email support'
      ]
    },
    {
      name: 'Business',
      price: 79,
      popular: true,
      features: [
        '5 users',
        '5,000 items',
        'Unlimited locations',
        'Advanced reports',
        'Priority support',
        'CSV import/export'
      ]
    },
    {
      name: 'Pro',
      price: 149,
      features: [
        'Unlimited users',
        'Unlimited items',
        'Unlimited locations',
        'All features',
        'Phone support',
        'API access',
        'Integrations'
      ]
    }
  ];

  const handleSelectPlan = (planName) => {
    // This would redirect to Stripe checkout
    alert(`This would redirect to Stripe checkout for the ${planName} plan`);
  };

  return (
    <div style={styles.container}>
      <div style={styles.content}>
        <h1 style={styles.title}>Your Trial Has Ended</h1>
        <p style={styles.subtitle}>
          Thanks for trying Warehouse Manager! Choose a plan to continue using all features.
        </p>

        {organization && (
          <p style={styles.orgName}>
            Organization: <strong>{organization.name}</strong>
          </p>
        )}

        <div style={styles.plans}>
          {plans.map(plan => (
            <div 
              key={plan.name} 
              style={{
                ...styles.plan,
                ...(plan.popular ? styles.popularPlan : {})
              }}
            >
              {plan.popular && <div style={styles.popularBadge}>Most Popular</div>}
              <h3 style={styles.planName}>{plan.name}</h3>
              <div style={styles.price}>
                <span style={styles.currency}>$</span>
                <span style={styles.amount}>{plan.price}</span>
                <span style={styles.period}>/mo</span>
              </div>
              <ul style={styles.features}>
                {plan.features.map((feature, i) => (
                  <li key={i} style={styles.feature}>✓ {feature}</li>
                ))}
              </ul>
              <button
                onClick={() => handleSelectPlan(plan.name)}
                style={{
                  ...styles.button,
                  ...(plan.popular ? styles.popularButton : {})
                }}
              >
                Choose {plan.name}
              </button>
            </div>
          ))}
        </div>

        <div style={styles.footer}>
          <p>All plans include a 30-day money-back guarantee.</p>
          <button onClick={logout} style={styles.logoutLink}>
            Sign out and use a different account
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #2d5f3f 0%, #1a3a25 100%)',
    padding: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  content: {
    maxWidth: 1000,
    width: '100%'
  },
  title: {
    color: 'white',
    textAlign: 'center',
    fontSize: 32,
    marginBottom: 10
  },
  subtitle: {
    color: 'rgba(255,255,255,0.8)',
    textAlign: 'center',
    fontSize: 18,
    marginBottom: 10
  },
  orgName: {
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    marginBottom: 30
  },
  plans: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: 20,
    marginBottom: 30
  },
  plan: {
    background: 'white',
    borderRadius: 12,
    padding: 30,
    position: 'relative'
  },
  popularPlan: {
    border: '3px solid #2d5f3f',
    transform: 'scale(1.05)'
  },
  popularBadge: {
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
  },
  planName: {
    textAlign: 'center',
    fontSize: 24,
    marginBottom: 15,
    color: '#333'
  },
  price: {
    textAlign: 'center',
    marginBottom: 20
  },
  currency: {
    fontSize: 20,
    color: '#666',
    verticalAlign: 'top'
  },
  amount: {
    fontSize: 48,
    fontWeight: 700,
    color: '#2d5f3f'
  },
  period: {
    fontSize: 16,
    color: '#666'
  },
  features: {
    listStyle: 'none',
    padding: 0,
    margin: '0 0 20px 0'
  },
  feature: {
    padding: '8px 0',
    borderBottom: '1px solid #eee',
    color: '#555'
  },
  button: {
    width: '100%',
    padding: 15,
    border: '2px solid #2d5f3f',
    borderRadius: 8,
    background: 'white',
    color: '#2d5f3f',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer'
  },
  popularButton: {
    background: '#2d5f3f',
    color: 'white'
  },
  footer: {
    textAlign: 'center',
    color: 'rgba(255,255,255,0.7)'
  },
  logoutLink: {
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.7)',
    textDecoration: 'underline',
    cursor: 'pointer',
    marginTop: 10
  }
};
