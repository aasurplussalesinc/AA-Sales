import { useState, useRef, useMemo } from 'react';
import { OrgDB as DB } from '../orgDb';

/**
 * VoiceReceiving — hands-free "add stock to a location" using the browser's
 * Web Speech API (free, no backend). Voice fills in what it can; the confirmation
 * card is the safety net: nothing is applied until the user confirms, and the
 * item / location / quantity can all be corrected first.
 *
 * Say something like:  "W1 R1 A1, add 24, duffle bag two strap"
 *                      "add 6 of grenade pouch to W2 R2 B2"
 *
 * Props:
 *   items      – array of inventory items (id, name, partNumber, stock, ...)
 *   locations  – array of location docs
 *   canUse     – whether the org's plan includes voice (else shows upgrade card)
 *   onApplied  – called after a successful receive so the parent can refresh
 */

const NUM_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100
};

const FILLER = new Set([
  'location', 'add', 'adding', 'quantity', 'qty', 'receive', 'received', 'of', 'to',
  'in', 'into', 'at', 'the', 'a', 'an', 'put', 'bin', 'shelf', 'units', 'unit', 'pieces', 'pcs'
]);

function wordsToNum(tokens) {
  const nums = tokens.filter(t => NUM_WORDS[t] !== undefined);
  if (!nums.length) return null;
  let current = 0;
  for (const t of nums) {
    const v = NUM_WORDS[t];
    if (v === 100) current = (current || 1) * 100;
    else current += v;
  }
  return current || null;
}

function normCode(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function locationCodeOf(loc) {
  return loc.locationCode || `${loc.warehouse || ''}-R${loc.rack || ''}-${loc.letter || ''}${loc.shelf || ''}`;
}

// Parse a spoken command into { qty, locationCode, itemQuery }
function parseCommand(raw, locations) {
  const text = String(raw || '').toLowerCase().trim();

  // 1) Quantity — prefer a number right after add/qty/receive, or "<n> of"
  let qty = null;
  let m = text.match(/(?:add|quantity|qty|receive|received)\s+(\d{1,5})/);
  if (m) qty = parseInt(m[1]);
  if (qty === null) { m = text.match(/(\d{1,5})\s+of\b/); if (m) qty = parseInt(m[1]); }
  if (qty === null) { m = text.match(/\b(\d{1,5})\b/); if (m) qty = parseInt(m[1]); }
  if (qty === null) {
    // number-word fallback, only right after "add"/"qty"
    const after = text.match(/(?:add|quantity|qty)\s+([a-z\s]+?)(?:\s+of\b|$)/);
    if (after) qty = wordsToNum(after[1].split(/\s+/));
  }

  // 2) Location — longest matching known code wins
  let locationCode = '';
  let matchedLocNorm = '';
  const tnorm = normCode(text);
  for (const loc of locations) {
    const code = locationCodeOf(loc);
    const cn = normCode(code);
    if (cn && tnorm.includes(cn) && cn.length > matchedLocNorm.length) {
      matchedLocNorm = cn;
      locationCode = code;
    }
  }

  // 3) Item query — strip qty + location + filler words
  let itemWords = text
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !/^\d+$/.test(w))
    .filter(w => !FILLER.has(w));
  // remove tokens that belong to the matched location code
  if (matchedLocNorm) {
    itemWords = itemWords.filter(w => !matchedLocNorm.includes(normCode(w)) || normCode(w).length < 2);
  }
  const itemQuery = itemWords.join(' ').trim();

  return { qty, locationCode, itemQuery };
}

// Rank items against a free-text query
function matchItems(query, items) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const scored = items.map(it => {
    const name = String(it.name || '').toLowerCase();
    const sku = String(it.partNumber || '').toLowerCase();
    let score = 0;
    for (const w of words) {
      if (name.includes(w)) score += 2;
      if (sku === w) score += 5;
      else if (sku.includes(w)) score += 1;
    }
    // small boost if the whole query is a contiguous substring of the name
    if (name.includes(q)) score += 2;
    return { item: it, score };
  }).filter(s => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 6).map(s => s.item);
}

export default function VoiceReceiving({ items = [], locations = [], canUse = false, onApplied }) {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { message } after apply
  // confirmation state
  const [pending, setPending] = useState(null); // { candidates, selectedItemId, locationCode, qty }
  const recognitionRef = useRef(null);

  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

  const locOptions = useMemo(
    () => locations.map(l => ({ code: locationCodeOf(l), id: l.id })).filter(o => o.code),
    [locations]
  );

  const handleTranscript = (text) => {
    setTranscript(text);
    setResult(null);
    const { qty, locationCode, itemQuery } = parseCommand(text, locations);
    const candidates = matchItems(itemQuery, items);
    setPending({
      candidates,
      selectedItemId: candidates[0]?.id || '',
      locationCode: locationCode || '',
      qty: qty && qty > 0 ? qty : 1,
      itemQuery
    });
    if (!candidates.length) setError('No item matched "' + itemQuery + '". Pick it manually below.');
    else setError('');
  };

  const startListening = () => {
    if (!SR) { setError('Your browser does not support voice input. Chrome or Edge works best.'); return; }
    setError(''); setResult(''); setTranscript('');
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript;
      handleTranscript(text);
    };
    rec.onerror = (e) => { setError('Voice error: ' + (e.error || 'unknown')); setListening(false); };
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    setResult(null);
    try { rec.start(); } catch (err) { setError('Could not start microphone.'); setListening(false); }
  };

  const stopListening = () => {
    try { recognitionRef.current && recognitionRef.current.stop(); } catch (e) {}
    setListening(false);
  };

  const currentAtLocation = () => {
    if (!pending) return 0;
    const loc = locations.find(l => locationCodeOf(l) === pending.locationCode);
    if (!loc || !loc.inventory) return 0;
    return parseInt(loc.inventory[pending.selectedItemId]) || 0;
  };

  const apply = async () => {
    if (!pending) return;
    if (!pending.selectedItemId) { setError('Choose an item first.'); return; }
    if (!pending.locationCode) { setError('Choose a location first.'); return; }
    const qty = parseInt(pending.qty) || 0;
    if (qty <= 0) { setError('Enter a quantity greater than zero.'); return; }
    setBusy(true); setError('');
    try {
      const item = items.find(i => i.id === pending.selectedItemId);
      const res = await DB.receiveToLocation(pending.locationCode, pending.selectedItemId, qty);
      setResult('✅ Added ' + qty + ' × ' + (item?.name || 'item') + ' to ' + pending.locationCode +
        (res && res.newLocQty != null ? ' (now ' + res.newLocQty + ' there)' : ''));
      setPending(null);
      setTranscript('');
      if (onApplied) onApplied();
    } catch (e) {
      setError('Could not apply: ' + (e.message || e));
    } finally {
      setBusy(false);
    }
  };

  // ── Upgrade card for plans below Business ──────────────────────────────
  if (!canUse) {
    return (
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 22 }}>🎤</span>
          <div>
            <div style={{ fontWeight: 700 }}>Voice Receiving <span style={badge}>Business</span></div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Speak stock straight into a location, hands-free. Available on the Business plan.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const selectedItem = pending && items.find(i => i.id === pending.selectedItemId);

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button
          onClick={listening ? stopListening : startListening}
          disabled={busy}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px',
            borderRadius: 24, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 14,
            background: listening ? '#d32f2f' : '#4a5d23', color: '#fff'
          }}
        >
          <span style={{ fontSize: 18 }}>{listening ? '⏹️' : '🎤'}</span>
          {listening ? 'Listening… tap to stop' : 'Voice Receiving'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          e.g. “W1 R1 A1, add 24, duffle bag two strap”
        </span>
      </div>

      {transcript && (
        <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-secondary)' }}>
          Heard: <em>“{transcript}”</em>
        </div>
      )}
      {error && <div style={{ marginTop: 8, fontSize: 13, color: '#d32f2f' }}>{error}</div>}
      {result && <div style={{ marginTop: 8, fontSize: 14, color: '#2e7d32', fontWeight: 600 }}>{result}</div>}

      {/* Confirmation card — nothing is applied until the user confirms */}
      {pending && (
        <div style={{
          marginTop: 14, padding: 16, borderRadius: 10,
          border: '1px solid var(--border)', background: 'var(--bg-surface-2, #fafafa)'
        }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Confirm before adding</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
            {/* Item */}
            <label style={fieldLabel}>Item</label>
            <select
              value={pending.selectedItemId}
              onChange={e => setPending({ ...pending, selectedItemId: e.target.value })}
              style={input}
            >
              <option value="">— choose item —</option>
              {(pending.candidates.length ? pending.candidates : items.slice(0, 50)).map(it => (
                <option key={it.id} value={it.id}>
                  {it.name}{it.partNumber ? ' · ' + it.partNumber : ''}
                </option>
              ))}
              {/* allow full list fallback */}
              {pending.candidates.length > 0 && <option disabled>──────────</option>}
              {pending.candidates.length > 0 && items
                .filter(it => !pending.candidates.some(c => c.id === it.id))
                .slice(0, 100)
                .map(it => (
                  <option key={'all-' + it.id} value={it.id}>
                    {it.name}{it.partNumber ? ' · ' + it.partNumber : ''}
                  </option>
                ))}
            </select>

            {/* Location + Qty */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 200px' }}>
                <label style={fieldLabel}>Location {!pending.locationCode && <span style={{ color: '#d32f2f' }}>(required)</span>}</label>
                <select
                  value={pending.locationCode}
                  onChange={e => setPending({ ...pending, locationCode: e.target.value })}
                  style={{ ...input, borderColor: pending.locationCode ? 'var(--border)' : '#d32f2f' }}
                >
                  <option value="">— choose location —</option>
                  {locOptions.map(o => <option key={o.id} value={o.code}>{o.code}</option>)}
                </select>
              </div>
              <div style={{ width: 110 }}>
                <label style={fieldLabel}>Quantity</label>
                <input
                  type="number" min="1"
                  value={pending.qty}
                  onChange={e => setPending({ ...pending, qty: e.target.value === '' ? '' : parseInt(e.target.value) || 0 })}
                  style={input}
                />
              </div>
            </div>

            {/* On-hand preview */}
            {pending.selectedItemId && pending.locationCode && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {pending.locationCode}: {currentAtLocation()} on hand → <strong>{currentAtLocation() + (parseInt(pending.qty) || 0)}</strong> after.
                {selectedItem && <> Item total: {selectedItem.stock || 0} → <strong>{(selectedItem.stock || 0) + (parseInt(pending.qty) || 0)}</strong>.</>}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
            <button onClick={() => { setPending(null); setTranscript(''); }} disabled={busy}
              style={{ ...btn, background: 'var(--btn-secondary-bg, #eee)', color: 'var(--btn-secondary-color, #333)' }}>
              Cancel
            </button>
            <button onClick={apply} disabled={busy}
              style={{ ...btn, background: '#4a5d23', color: '#fff' }}>
              {busy ? 'Adding…' : '✅ Add to inventory'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const cardStyle = {
  border: '1px solid var(--border)', borderRadius: 12, padding: 16,
  marginBottom: 20, background: 'var(--bg-surface, #fff)'
};
const badge = {
  fontSize: 11, fontWeight: 700, color: '#a78bfa', border: '1px solid #a78bfa',
  borderRadius: 10, padding: '1px 7px', marginLeft: 6
};
const fieldLabel = { fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 };
const input = {
  width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-input, #fff)', color: 'var(--text-primary, #111)', boxSizing: 'border-box'
};
const btn = { padding: '9px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14 };
