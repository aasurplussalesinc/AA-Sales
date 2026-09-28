// Thin wrappers over the invoicing Cloud Functions (functions/invoicing.js).
// Every call is checked server-side for org membership and role; nothing here
// is a security boundary.
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

const call = (name) => async (data) => {
  const res = await httpsCallable(functions, name)(data || {});
  return res.data;
};

export const Payments = {
  connectStart: call('paymentsConnectStart'),
  oauthComplete: call('paymentsOAuthComplete'),
  refreshAccount: call('paymentsRefreshAccount'),
  disconnect: call('paymentsDisconnect'),
  saveSettings: call('paymentsSaveSettings')
};

export function formatCents(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? '-' : '';
  return sign + '$' + (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const CONNECTION_LABELS = {
  connected: { label: 'Connected', color: '#2e7d32', bg: 'var(--bg-success)' },
  needs_info: { label: 'Needs info', color: '#b26a00', bg: 'var(--bg-badge-orange)' },
  disconnected: { label: 'Disconnected', color: '#666', bg: 'var(--bg-surface)' }
};

// Mirrors CORE.connectionState in functions/invoicingCore.js.
export function connectionState(p) {
  p = p || {};
  if (!p.stripeAccountId || p.connected === false) return 'disconnected';
  if (p.chargesEnabled && p.detailsSubmitted) return 'connected';
  return 'needs_info';
}
