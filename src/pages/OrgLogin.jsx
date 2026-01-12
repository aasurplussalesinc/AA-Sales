import { useState } from 'react';
import { useAuth } from '../OrgAuthContext';

export default function Login() {
  const [mode, setMode] = useState('login'); // login, signup, reset, select-org
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  
  const { login, signup, resetPassword, organizations, selectOrganization } = useAuth();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    
    try {
      await login(email, password);
      // Auth context will handle org selection
    } catch (err) {
      console.error('Login error:', err);
      if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password') {
        setError('Invalid email or password');
      } else if (err.code === 'auth/invalid-email') {
        setError('Invalid email address');
      } else if (err.code === 'auth/invalid-credential') {
        setError('Invalid email or password');
      } else {
        setError('Failed to sign in. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async (e) => {
    e.preventDefault();
    setError('');
    
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    
    if (!companyName.trim()) {
      setError('Company name is required');
      return;
    }
    
    setLoading(true);
    
    try {
      await signup(email, password, companyName.trim());
      // Auth context will handle org selection
    } catch (err) {
      console.error('Signup error:', err);
      if (err.code === 'auth/email-already-in-use') {
        setError('An account with this email already exists');
      } else if (err.code === 'auth/weak-password') {
        setError('Password is too weak');
      } else {
        setError(err.message || 'Failed to create account');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    
    try {
      await resetPassword(email);
      setMessage('Password reset email sent! Check your inbox.');
    } catch (err) {
      console.error('Reset error:', err);
      setError('Failed to send reset email. Check your email address.');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectOrg = async (org) => {
    setLoading(true);
    try {
      await selectOrganization(org);
    } catch (err) {
      setError('Failed to select organization');
    } finally {
      setLoading(false);
    }
  };

  // Organization selection screen (shown when user has multiple orgs)
  if (mode === 'select-org' || (organizations.length > 1 && mode === 'login')) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h1 style={styles.logo}>📦 Warehouse Manager</h1>
          <h2 style={styles.title}>Select Organization</h2>
          
          <div style={styles.orgList}>
            {organizations.map(org => (
              <button
                key={org.id}
                onClick={() => handleSelectOrg(org)}
                style={styles.orgButton}
                disabled={loading}
              >
                <div style={styles.orgName}>{org.name}</div>
                <div style={styles.orgPlan}>
                  {org.plan === 'trial' && `Trial - ${org.trialDaysRemaining || 0} days left`}
                  {org.plan === 'owner' && 'Owner Account'}
                  {['starter', 'business', 'pro'].includes(org.plan) && org.plan.charAt(0).toUpperCase() + org.plan.slice(1)}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.logo}>📦 Warehouse Manager</h1>
        
        {mode === 'login' && (
          <>
            <h2 style={styles.title}>Sign In</h2>
            
            {error && <div style={styles.error}>{error}</div>}
            
            <form onSubmit={handleLogin}>
              <div style={styles.inputGroup}>
                <label style={styles.label}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={styles.input}
                  required
                  disabled={loading}
                />
              </div>
              
              <div style={styles.inputGroup}>
                <label style={styles.label}>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={styles.input}
                  required
                  disabled={loading}
                />
              </div>
              
              <button type="submit" style={styles.button} disabled={loading}>
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>
            
            <div style={styles.links}>
              <button onClick={() => setMode('reset')} style={styles.link}>
                Forgot password?
              </button>
              <button onClick={() => setMode('signup')} style={styles.link}>
                Create new account
              </button>
            </div>
          </>
        )}
        
        {mode === 'signup' && (
          <>
            <h2 style={styles.title}>Create Account</h2>
            <p style={styles.subtitle}>Start your 14-day free trial</p>
            
            {error && <div style={styles.error}>{error}</div>}
            
            <form onSubmit={handleSignup}>
              <div style={styles.inputGroup}>
                <label style={styles.label}>Company Name</label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  style={styles.input}
                  placeholder="Your Company LLC"
                  required
                  disabled={loading}
                />
              </div>
              
              <div style={styles.inputGroup}>
                <label style={styles.label}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={styles.input}
                  required
                  disabled={loading}
                />
              </div>
              
              <div style={styles.inputGroup}>
                <label style={styles.label}>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={styles.input}
                  placeholder="At least 6 characters"
                  required
                  disabled={loading}
                />
              </div>
              
              <div style={styles.inputGroup}>
                <label style={styles.label}>Confirm Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  style={styles.input}
                  required
                  disabled={loading}
                />
              </div>
              
              <button type="submit" style={styles.button} disabled={loading}>
                {loading ? 'Creating account...' : 'Start Free Trial'}
              </button>
            </form>
            
            <div style={styles.links}>
              <button onClick={() => setMode('login')} style={styles.link}>
                Already have an account? Sign in
              </button>
            </div>
            
            <p style={styles.terms}>
              By signing up, you agree to our Terms of Service and Privacy Policy.
              No credit card required for trial.
            </p>
          </>
        )}
        
        {mode === 'reset' && (
          <>
            <h2 style={styles.title}>Reset Password</h2>
            
            {error && <div style={styles.error}>{error}</div>}
            {message && <div style={styles.success}>{message}</div>}
            
            <form onSubmit={handleResetPassword}>
              <div style={styles.inputGroup}>
                <label style={styles.label}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={styles.input}
                  required
                  disabled={loading}
                />
              </div>
              
              <button type="submit" style={styles.button} disabled={loading}>
                {loading ? 'Sending...' : 'Send Reset Link'}
              </button>
            </form>
            
            <div style={styles.links}>
              <button onClick={() => setMode('login')} style={styles.link}>
                Back to sign in
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #2d5f3f 0%, #1a3a25 100%)',
    padding: 20
  },
  card: {
    background: 'white',
    borderRadius: 12,
    padding: 40,
    width: '100%',
    maxWidth: 400,
    boxShadow: '0 10px 40px rgba(0,0,0,0.2)'
  },
  logo: {
    textAlign: 'center',
    fontSize: 28,
    marginBottom: 10,
    color: '#2d5f3f'
  },
  title: {
    textAlign: 'center',
    marginBottom: 10,
    color: '#333',
    fontSize: 22
  },
  subtitle: {
    textAlign: 'center',
    color: '#666',
    marginBottom: 20,
    fontSize: 14
  },
  inputGroup: {
    marginBottom: 20
  },
  label: {
    display: 'block',
    marginBottom: 5,
    fontWeight: 600,
    fontSize: 14,
    color: '#333'
  },
  input: {
    width: '100%',
    padding: '12px 15px',
    border: '1px solid #ddd',
    borderRadius: 6,
    fontSize: 16,
    boxSizing: 'border-box'
  },
  button: {
    width: '100%',
    padding: '14px',
    background: '#2d5f3f',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 10
  },
  links: {
    marginTop: 20,
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    gap: 10
  },
  link: {
    background: 'none',
    border: 'none',
    color: '#2d5f3f',
    cursor: 'pointer',
    fontSize: 14,
    textDecoration: 'underline'
  },
  error: {
    background: '#fee',
    color: '#c00',
    padding: 12,
    borderRadius: 6,
    marginBottom: 20,
    fontSize: 14
  },
  success: {
    background: '#efe',
    color: '#060',
    padding: 12,
    borderRadius: 6,
    marginBottom: 20,
    fontSize: 14
  },
  terms: {
    marginTop: 20,
    fontSize: 11,
    color: '#999',
    textAlign: 'center',
    lineHeight: 1.4
  },
  orgList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    marginTop: 20
  },
  orgButton: {
    padding: 15,
    border: '1px solid #ddd',
    borderRadius: 8,
    background: 'white',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'all 0.2s'
  },
  orgName: {
    fontWeight: 600,
    fontSize: 16,
    color: '#333'
  },
  orgPlan: {
    fontSize: 12,
    color: '#666',
    marginTop: 5
  }
};
