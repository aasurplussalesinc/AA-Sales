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

export const Invoices = {
  getDetails: call('invoiceGetDetails'),
  getPayLink: call('invoiceGetPayLink'),
  recordManualPayment: call('invoiceRecordManualPayment'),
  reverseManualPayment: call('invoiceReverseManualPayment'),
  send: call('invoiceSend'),
  setReminderPause: call('invoiceSetReminderPause'),
  runRemindersNow: call('invoiceRunRemindersNow'),
  // Public: the pay page (no sign-in; the signed token in the link is checked server-side)
  payLinkStatus: call('invoicePayLinkStatus'),
  payLinkCheckout: call('invoicePayLinkCheckout')
};

export const INVOICE_STATUS_LABELS = {
  draft: { label: 'Not sent', color: '#666', bg: '#eceff1' },
  sent: { label: 'Sent', color: '#1565c0', bg: '#e3f2fd' },
  partially_paid: { label: 'Partially paid', color: '#b26a00', bg: '#fff3e0' },
  paid: { label: 'Paid', color: '#2e7d32', bg: '#e8f5e9' },
  overdue: { label: 'Overdue', color: '#c62828', bg: '#ffebee' },
  void: { label: 'Void', color: '#666', bg: '#eeeeee' }
};

export const PAYMENT_METHOD_LABELS = {
  card: 'Card', ach: 'Bank transfer (ACH)', check: 'Check', cash: 'Cash', zelle: 'Zelle', wire: 'Wire', other: 'Other'
};

export const PAYMENT_STATUS_LABELS = {
  pending: 'Pending', succeeded: 'Received', failed: 'Failed', refunded: 'Refunded',
  partially_refunded: 'Partly refunded', voided: 'Reversed'
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
