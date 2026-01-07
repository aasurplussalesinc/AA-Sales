import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [showReset, setShowReset] = useState(false);
  
  const { login, resetPassword } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      console.error(err);
      if (err.code === 'auth/user-not-found') {
        setError('No account found with this email');
      } else if (err.code === 'auth/wrong-password') {
        setError('Incorrect password');
      } else if (err.code === 'auth/invalid-email') {
        setError('Invalid email address');
      } else if (err.code === 'auth/too-many-requests') {
        setError('Too many failed attempts. Try again later.');
      } else {
        setError('Failed to sign in. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (!email) {
      setError('Enter your email address first');
      return;
    }
    
    setLoading(true);
    setError('');
    
    try {
      await resetPassword(email);
      setResetSent(true);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        setError('No account found with this email');
      } else {
        setError('Failed to send reset email');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f5f5f5',
      padding: 20
    }}>
      <div style={{
        background: 'white',
        borderRadius: 12,
        padding: 40,
        width: '100%',
        maxWidth: 400,
        boxShadow: '0 4px 20px rgba(0,0,0,0.1)'
      }}>
        {/* Logo/Header */}
        <div style={{ textAlign: 'center', marginBottom: 30 }}>
          <span style={{ fontSize: 48 }}>📦</span>
          <h1 style={{ 
            color: '#2d5f3f', 
            fontSize: 24, 
            marginTop: 10,
            marginBottom: 5
          }}>
            Warehouse Inventory
          </h1>
          <p style={{ color: '#666', fontSize: 14 }}>
            Sign in to continue
          </p>
        </div>

        {error && (
          <div style={{
            background: '#fee',
            border: '1px solid #fcc',
            color: '#c00',
            padding: 12,
            borderRadius: 6,
            marginBottom: 20,
            fontSize: 14
          }}>
            {error}
          </div>
        )}

        {resetSent && (
          <div style={{
            background: '#efe',
            border: '1px solid #cfc',
            color: '#060',
            padding: 12,
            borderRadius: 6,
            marginBottom: 20,
            fontSize: 14
          }}>
            Password reset email sent! Check your inbox.
          </div>
        )}

        {!showReset ? (
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 20 }}>
              <label style={{ 
                display: 'block', 
                marginBottom: 8, 
                fontWeight: 600,
                color: '#333'
              }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                style={{
                  width: '100%',
                  padding: 12,
                  border: '1px solid #ddd',
                  borderRadius: 6,
                  fontSize: 16,
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ 
                display: 'block', 
                marginBottom: 8, 
                fontWeight: 600,
                color: '#333'
              }}>
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                style={{
                  width: '100%',
                  padding: 12,
                  border: '1px solid #ddd',
                  borderRadius: 6,
                  fontSize: 16,
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                padding: 14,
                background: loading ? '#999' : '#2d5f3f',
                color: 'white',
                border: 'none',
                borderRadius: 6,
                fontSize: 16,
                fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer'
              }}
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>

            <button
              type="button"
              onClick={() => setShowReset(true)}
              style={{
                width: '100%',
                padding: 12,
                background: 'transparent',
                color: '#666',
                border: 'none',
                fontSize: 14,
                cursor: 'pointer',
                marginTop: 15
              }}
            >
              Forgot password?
            </button>
          </form>
        ) : (
          <form onSubmit={handleResetPassword}>
            <p style={{ marginBottom: 20, color: '#666', fontSize: 14 }}>
              Enter your email and we'll send you a link to reset your password.
            </p>
            
            <div style={{ marginBottom: 20 }}>
              <label style={{ 
                display: 'block', 
                marginBottom: 8, 
                fontWeight: 600,
                color: '#333'
              }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                style={{
                  width: '100%',
                  padding: 12,
                  border: '1px solid #ddd',
                  borderRadius: 6,
                  fontSize: 16,
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                padding: 14,
                background: loading ? '#999' : '#2d5f3f',
                color: 'white',
                border: 'none',
                borderRadius: 6,
                fontSize: 16,
                fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer'
              }}
            >
              {loading ? 'Sending...' : 'Send Reset Link'}
            </button>

            <button
              type="button"
              onClick={() => {
                setShowReset(false);
                setResetSent(false);
                setError('');
              }}
              style={{
                width: '100%',
                padding: 12,
                background: 'transparent',
                color: '#666',
                border: 'none',
                fontSize: 14,
                cursor: 'pointer',
                marginTop: 15
              }}
            >
              Back to sign in
            </button>
          </form>
        )}

        <div style={{ 
          marginTop: 30, 
          paddingTop: 20, 
          borderTop: '1px solid #eee',
          textAlign: 'center',
          color: '#999',
          fontSize: 12
        }}>
          Contact admin for account access
        </div>
      </div>
    </div>
  );
}
