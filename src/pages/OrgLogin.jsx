import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../OrgAuthContext';
import { OrgDB } from '../orgDb';

const GoogleG = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  </svg>
);

const googleErrorMessage = (err) => {
  const code = err?.code || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return '';
  if (code === 'auth/popup-blocked') return 'Your browser blocked the Google window. Allow pop-ups for this site and try again.';
  if (code === 'auth/account-exists-with-different-credential') return 'This email already has an account. Sign in with your email and password.';
  if (code === 'auth/unauthorized-domain') return 'Google sign-in is not enabled for this web address yet.';
  if (code === 'auth/network-request-failed') return 'Network error. Check your connection and try again.';
  return 'Google sign-in failed. Please try again.';
};

export default function Login() {
  const location = useLocation();
  // Allow callers to deep-link into a specific mode via ?mode=signup or ?mode=signup-join.
  // Only whitelist user-facing modes — 'select-org' is set internally after login.
  const initialMode = (() => {
    const params = new URLSearchParams(location.search);
    const requested = params.get('mode');
    return ['login', 'signup', 'signup-join', 'reset'].includes(requested) ? requested : 'login';
  })();
  const [mode, setMode] = useState(initialMode); // login, signup, signup-join, reset, select-org
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  
  const {
    user, login, loginWithGoogle, signup, signupWithInviteCode, resetPassword, organizations, selectOrganization,
    createOrganizationForCurrentUser, joinWithInviteCodeForCurrentUser, logout, orgsLoading,
  } = useAuth();
  const [setupMode, setSetupMode] = useState('create'); // finish-setup screen: create | join

  const handleGoogle = async () => {
    setError('');
    setLoading(true);
    try {
      await loginWithGoogle();
      // Auth context handles org selection; a new user without an org sees the finish-setup screen
    } catch (err) {
      console.error('Google sign-in error:', err);
      setError(googleErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleFinishCreate = async (e) => {
    e.preventDefault();
    setError('');
    if (!companyName.trim()) {
      setError('Company name is required');
      return;
    }
    setLoading(true);
    try {
      await createOrganizationForCurrentUser(companyName.trim());
    } catch (err) {
      console.error('Create organization error:', err);
      setError(err.message || 'Failed to create your company');
    } finally {
      setLoading(false);
    }
  };

  const handleFinishJoin = async (e) => {
    e.preventDefault();
    setError('');
    if (!inviteCode.trim()) {
      setError('Invite code is required');
      return;
    }
    const validation = await OrgDB.validateInviteCode(inviteCode.trim());
    if (!validation.valid) {
      setError(validation.error);
      return;
    }
    setLoading(true);
    try {
      await joinWithInviteCodeForCurrentUser(inviteCode.trim());
    } catch (err) {
      console.error('Join organization error:', err);
      setError(err.message || 'Failed to join organization');
    } finally {
      setLoading(false);
    }
  };

  const googleButton = (label) => (
    <>
      <div style={styles.divider}>
        <span style={styles.dividerLine} /><span style={styles.dividerText}>or</span><span style={styles.dividerLine} />
      </div>
      <button type="button" onClick={handleGoogle} style={styles.googleButton} disabled={loading}>
        <GoogleG /><span>{label}</span>
      </button>
    </>
  );

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

  // Finish setup: signed in (e.g. a new Google user) but not in any organization yet
  if (user && !orgsLoading && !loading && organizations.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <Link to="/" style={{ ...styles.logo, textDecoration: 'none' }}>
            <img src="/logo.png" alt="SkidSling" style={{ width: 56, height: 47, mixBlendMode: 'screen' }} />
            <span style={{ fontFamily: "'DM Sans', system-ui, sans-serif", fontWeight: 800, fontSize: 26, letterSpacing: '-0.5px' }}>
              <span style={{ color: '#f0f0f0' }}>Skid</span><span style={{ color: '#34d399' }}>Sling</span>
            </span>
          </Link>
          <h2 style={styles.title}>{setupMode === 'create' ? 'Set Up Your Company' : 'Join Your Team'}</h2>
          <p style={styles.subtitle}>
            Signed in as {user.email}.{' '}
            {setupMode === 'create' ? 'Start your 14-day free trial.' : 'Enter the invite code from your admin.'}
          </p>

          {error && <div style={styles.error}>{error}</div>}

          {setupMode === 'create' ? (
            <form onSubmit={handleFinishCreate}>
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
              <button type="submit" style={styles.button} disabled={loading}>
                {loading ? 'Creating...' : 'Start Free Trial'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleFinishJoin}>
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
              <button type="submit" style={styles.button} disabled={loading}>
                {loading ? 'Joining...' : 'Join Organization'}
              </button>
            </form>
          )}

          <div style={styles.links}>
            <button onClick={() => { setError(''); setSetupMode(setupMode === 'create' ? 'join' : 'create'); }} style={styles.link}>
              {setupMode === 'create' ? 'Have an invite code? Join existing company' : 'Create a new company instead'}
            </button>
            <button onClick={() => { setError(''); logout(); }} style={styles.link}>
              Use a different account
            </button>
          </div>

          {setupMode === 'create' && (
            <p style={styles.terms}>
              By continuing, you agree to our <Link to="/terms" target="_blank" style={{ color: 'inherit' }}>Terms of Service</Link> and{' '}
              <Link to="/privacy" target="_blank" style={{ color: 'inherit' }}>Privacy Policy</Link>.
              No credit card required for trial.
            </p>
          )}
        </div>
      </div>
    );
  }

  // Organization selection screen (shown when user has multiple orgs)
  if (mode === 'select-org' || (organizations.length > 1 && mode === 'login')) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <Link to="/" style={{ ...styles.logo, textDecoration: 'none' }}>
            <img src="/logo.png" alt="SkidSling" style={{ width: 56, height: 47, mixBlendMode: 'screen' }} />
            <span style={{ fontFamily: "'DM Sans', system-ui, sans-serif", fontWeight: 800, fontSize: 26, letterSpacing: '-0.5px' }}>
              <span style={{ color: '#f0f0f0' }}>Skid</span><span style={{ color: '#34d399' }}>Sling</span>
            </span>
          </Link>
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
        <Link to="/" style={{ ...styles.logo, textDecoration: 'none' }}>
          <img src="/logo.png" alt="SkidSling" style={{ width: 56, height: 47, mixBlendMode: 'screen' }} />
          <span style={{ fontFamily: "'DM Sans', system-ui, sans-serif", fontWeight: 800, fontSize: 26, letterSpacing: '-0.5px' }}>
            <span style={{ color: '#f0f0f0' }}>Skid</span><span style={{ color: '#34d399' }}>Sling</span>
          </span>
        </Link>
        
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

            {googleButton('Continue with Google')}
            
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

            {googleButton('Sign up with Google')}
            
            <div style={styles.links}>
              <button onClick={() => setMode('login')} style={styles.link}>
                Already have an account? Sign in
              </button>
              <button onClick={() => setMode('signup-join')} style={styles.link}>
                Have an invite code? Join existing company
              </button>
            </div>
            
            <p style={styles.terms}>
              By signing up, you agree to our <Link to="/terms" target="_blank" style={{ color: 'inherit' }}>Terms of Service</Link> and{' '}
              <Link to="/privacy" target="_blank" style={{ color: 'inherit' }}>Privacy Policy</Link>.
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
            
            {googleButton('Continue with Google')}

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
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    margin: '20px 0 14px'
  },
  dividerLine: {
    flex: 1,
    height: 1,
    background: 'rgba(255,255,255,0.08)'
  },
  dividerText: {
    color: '#606060',
    fontSize: 12
  },
  googleButton: {
    width: '100%',
    padding: '12px',
    background: '#131314',
    color: '#e3e3e3',
    border: '1px solid #8e918f',
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10
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
