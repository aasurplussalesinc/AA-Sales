// Lightweight toast notifications — a non-blocking replacement for alert().
// DOM-based so it works from anywhere without wrapping the app in a provider.
//
//   import { toast } from '../utils/toast';
//   toast('Saved');                       // info (default)
//   toast('Could not save', 'error');     // error
//   toast.success('Done');                // convenience aliases
//
// Note: this intentionally does NOT replace window.confirm() — confirmations need a
// blocking yes/no answer and are handled with native dialogs / modals elsewhere.

let containerEl = null;

function getContainer() {
  if (containerEl && document.body.contains(containerEl)) return containerEl;
  containerEl = document.createElement('div');
  containerEl.setAttribute('data-toast-container', '');
  Object.assign(containerEl.style, {
    position: 'fixed',
    top: '16px',
    right: '16px',
    zIndex: '2147483647',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    maxWidth: '360px',
    pointerEvents: 'none',
  });
  document.body.appendChild(containerEl);
  return containerEl;
}

const COLORS = {
  info: { bg: '#1976d2', fg: '#ffffff' },
  success: { bg: '#2e7d32', fg: '#ffffff' },
  warning: { bg: '#e65100', fg: '#ffffff' },
  error: { bg: '#c62828', fg: '#ffffff' },
};

export function toast(message, type = 'info', durationMs) {
  if (typeof document === 'undefined') return;
  const { bg, fg } = COLORS[type] || COLORS.info;
  const el = document.createElement('div');
  el.textContent = String(message == null ? '' : message);
  Object.assign(el.style, {
    background: bg,
    color: fg,
    padding: '12px 16px',
    borderRadius: '8px',
    boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
    fontSize: '14px',
    lineHeight: '1.35',
    fontFamily: "'Segoe UI', Arial, sans-serif",
    pointerEvents: 'auto',
    cursor: 'pointer',
    opacity: '0',
    transform: 'translateY(-6px)',
    transition: 'opacity .15s ease, transform .15s ease',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  });

  const container = getContainer();
  container.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });

  const ttl = durationMs != null ? durationMs : (type === 'error' ? 6000 : 3500);
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    el.style.opacity = '0';
    el.style.transform = 'translateY(-6px)';
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
  };
  el.addEventListener('click', remove);
  setTimeout(remove, ttl);
}

toast.error = (m, d) => toast(m, 'error', d);
toast.success = (m, d) => toast(m, 'success', d);
toast.warning = (m, d) => toast(m, 'warning', d);
toast.info = (m, d) => toast(m, 'info', d);

export default toast;
