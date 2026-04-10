import { useState } from 'react';
import { useAuth } from '../OrgAuthContext';
import { OrgDB } from '../orgDb';

export default function Login() {
  const [mode, setMode] = useState('login'); // login, signup, signup-join, reset, select-org
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  
  const { login, signup, signupWithInviteCode, resetPassword, organizations, selectOrganization } = useAuth();

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

  const handleSignupWithCode = async (e) => {
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
    
    if (!inviteCode.trim()) {
      setError('Invite code is required');
      return;
    }
    
    // Validate invite code first
    const validation = await OrgDB.validateInviteCode(inviteCode.trim());
    if (!validation.valid) {
      setError(validation.error);
      return;
    }
    
    setLoading(true);
    
    try {
      await signupWithInviteCode(email, password, inviteCode.trim());
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
          <div style={styles.logo}>
          <img src="/logo.png" alt="SkidSling" style={{ width: 56, height: 47 }} />
          <span style={{ fontFamily: "'DM Sans', system-ui, sans-serif", fontWeight: 800, fontSize: 26, letterSpacing: '-0.5px' }}>
            <span style={{ color: '#f0f0f0' }}>Skid</span><span style={{ color: '#34d399' }}>sling</span>
          </span>
        </div>
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
        <div style={styles.logo}>
          <img src="/logo.png" alt="SkidSling" style={{ width: 56, height: 47 }} />
          <span style={{ fontFamily: "'DM Sans', system-ui, sans-serif", fontWeight: 800, fontSize: 26, letterSpacing: '-0.5px' }}>
            <span style={{ color: '#f0f0f0' }}>Skid</span><span style={{ color: '#34d399' }}>sling</span>
          </span>
        </div>
        
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
              <button onClick={() => setMode('signup-join')} style={styles.link}>
                Have an invite code?
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
              <button onClick={() => setMode('signup-join')} style={styles.link}>
                Have an invite code? Join existing company
              </button>
            </div>
            
            <p style={styles.terms}>
              By signing up, you agree to our Terms of Service and Privacy Policy.
              No credit card required for trial.
            </p>
          </>
        )}
        
        {mode === 'signup-join' && (
          <>
            <h2 style={styles.title}>Join Your Team</h2>
            <p style={styles.subtitle}>Enter your invite code to join an existing organization</p>
            
            {error && <div style={styles.error}>{error}</div>}
            
            <form onSubmit={handleSignupWithCode}>
              <div style={styles.inputGroup}>
                <label style={styles.label}>Invite Code</label>
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                  style={{...styles.input, fontFamily: 'monospace', fontSize: 18, letterSpacing: 2, textAlign: 'center'}}
                  placeholder="XXXX-XXXX"
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
                {loading ? 'Joining...' : 'Join Organization'}
              </button>
            </form>
            
            <div style={styles.links}>
              <button onClick={() => setMode('login')} style={styles.link}>
                Already have an account? Sign in
              </button>
              <button onClick={() => setMode('signup')} style={styles.link}>
                Create new company instead
              </button>
            </div>
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
    background: '#0a0a0a',
    backgroundImage: 'radial-gradient(ellipse at 50% 0%, rgba(52,211,153,0.08) 0%, transparent 60%)',
    padding: 20,
    fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif"
  },
  card: {
    background: '#111111',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 16,
    padding: 44,
    width: '100%',
    maxWidth: 420,
    boxShadow: '0 24px 80px rgba(0,0,0,0.6)'
  },
  logo: {
    textAlign: 'center',
    marginBottom: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12
  },
  title: {
    textAlign: 'center',
    marginBottom: 8,
    color: '#f0f0f0',
    fontSize: 20,
    fontWeight: 600
  },
  subtitle: {
    textAlign: 'center',
    color: '#606060',
    marginBottom: 24,
    fontSize: 13
  },
  inputGroup: {
    marginBottom: 18
  },
  label: {
    display: 'block',
    marginBottom: 6,
    fontWeight: 600,
    fontSize: 12,
    color: '#a0a0a0',
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  },
  input: {
    width: '100%',
    padding: '12px 14px',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8,
    fontSize: 15,
    boxSizing: 'border-box',
    background: '#1a1a1a',
    color: '#f0f0f0',
    outline: 'none',
    transition: 'border-color 0.2s'
  },
  button: {
    width: '100%',
    padding: '13px',
    background: '#34d399',
    color: '#0a0a0a',
    border: 'none',
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    marginTop: 8,
    letterSpacing: '0.2px',
    transition: 'background 0.2s'
  },
  links: {
    marginTop: 22,
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    gap: 10
  },
  link: {
    background: 'none',
    border: 'none',
    color: '#606060',
    cursor: 'pointer',
    fontSize: 13,
    textDecoration: 'underline',
    textUnderlineOffset: '3px'
  },
  error: {
    background: 'rgba(248,113,113,0.1)',
    color: '#f87171',
    border: '1px solid rgba(248,113,113,0.2)',
    padding: '10px 14px',
    borderRadius: 8,
    marginBottom: 18,
    fontSize: 13
  },
  success: {
    background: 'rgba(52,211,153,0.1)',
    color: '#34d399',
    border: '1px solid rgba(52,211,153,0.2)',
    padding: '10px 14px',
    borderRadius: 8,
    marginBottom: 18,
    fontSize: 13
  },
  terms: {
    marginTop: 20,
    fontSize: 11,
    color: '#404040',
    textAlign: 'center',
    lineHeight: 1.5
  },
  orgList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    marginTop: 20
  },
  orgButton: {
    padding: 16,
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 10,
    background: '#1a1a1a',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'all 0.2s'
  },
  orgName: {
    fontWeight: 600,
    fontSize: 15,
    color: '#f0f0f0'
  },
  orgPlan: {
    fontSize: 12,
    color: '#606060',
    marginTop: 4
  }
};
