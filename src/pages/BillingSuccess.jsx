import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

export default function BillingSuccess() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    // Auto-redirect to dashboard after 5 seconds
    const timer = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          clearInterval(timer);
          navigate('/dashboard');
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [navigate]);

  return (
    <div style={{
      minHeight: '100vh', background: '#0a0a0a',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'DM Sans', system-ui, sans-serif", padding: 20
    }}>
      <div style={{
        background: '#111', border: '1px solid rgba(52,211,153,0.3)',
        borderRadius: 16, padding: 48, textAlign: 'center', maxWidth: 480
      }}>
        <div style={{ fontSize: 64, marginBottom: 20 }}>🎉</div>
        <h1 style={{ color: '#34d399', fontSize: 28, fontWeight: 800, marginBottom: 12, letterSpacing: '-0.5px' }}>
          You're all set!
        </h1>
        <p style={{ color: '#a0a0a0', fontSize: 16, marginBottom: 8 }}>
          Your subscription is now active.
        </p>
        <p style={{ color: '#606060', fontSize: 14, marginBottom: 32 }}>
          Welcome to SkidSling — let's get your warehouse running.
        </p>
        <button
          onClick={() => navigate('/dashboard')}
          style={{
            background: '#34d399', color: '#0a0a0a',
            border: 'none', borderRadius: 8,
            padding: '13px 32px', cursor: 'pointer',
            fontWeight: 700, fontSize: 15
          }}
        >
          Go to Dashboard
        </button>
        <p style={{ color: '#404040', fontSize: 12, marginTop: 16 }}>
          Redirecting automatically in {countdown}s...
        </p>
      </div>
    </div>
  );
}
