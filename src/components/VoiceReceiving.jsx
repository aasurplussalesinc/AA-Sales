import { useState, useRef, useMemo } from 'react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { OrgDB as DB } from '../orgDb';

const fbFunctions = getFunctions();

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
// Resolve a value the user spoke ("1" after "warehouse") to the real stored
// value ("W1"), using both the schema's options and values actually in use.
function resolveLevelValue(lvl, spoken, locations) {
  const s = String(spoken || '').toLowerCase();
  if (!s) return null;
  const pool = [];
  (lvl.options || []).forEach(o => pool.push(String(o)));
  (locations || []).forEach(l => {
    const v = l[lvl.key];
    if (v != null && v !== '') pool.push(String(v));
  });
  const uniq = [...new Set(pool)];
  let hit = uniq.find(x => x.toLowerCase() === s);
  if (hit) return hit;
  hit = uniq.find(x => x.toLowerCase().replace(/^[a-z]+/, '') === s); // "W1" spoken as "1"
  if (hit) return hit;
  hit = uniq.find(x => x.toLowerCase().endsWith(s));
  if (hit) return hit;
  hit = uniq.find(x => x.toLowerCase().startsWith(s));
  return hit || null;
}

// Understand a spoken location using the org's OWN level names, so
// "warehouse 1, rack 1 B2" resolves to W1-R1-B2 — and a company using
// "building north, aisle 12" resolves against their own codes just as well.
function matchLocationFromSpeech(tokens, schema, locations) {
  const levels = (schema && schema.levels) || [];
  if (!levels.length) return null;
  const values = {};
  const usedIdx = new Set();
  let lastNamedIdx = -1;

  // Pass 1: "<level name> <value>"
  levels.forEach(lvl => {
    const lname = String(lvl.name || '').toLowerCase();
    if (!lname) return;
    for (let i = 0; i < tokens.length - 1; i++) {
      if (tokens[i] === lname) {
        const val = resolveLevelValue(lvl, tokens[i + 1], locations);
        if (val) {
          values[lvl.key] = val;
          usedIdx.add(i); usedIdx.add(i + 1);
          if (i + 1 > lastNamedIdx) lastNamedIdx = i + 1;
        }
        break;
      }
    }
  });
  if (Object.keys(values).length === 0) return null;

  // Pass 2: fill any levels not named aloud from compound tokens that follow,
  // so a trailing "B2" becomes Bay B / Shelf 2.
  const remaining = levels.filter(l => !values[l.key]);
  if (remaining.length > 0 && lastNamedIdx >= 0) {
    const pieces = [];
    for (let i = lastNamedIdx + 1; i < tokens.length; i++) {
      if (usedIdx.has(i)) continue;
      (tokens[i].match(/[a-z]+|\d+/g) || []).forEach(p => pieces.push({ p, i }));
    }
    let pi = 0;
    for (const lvl of remaining) {
      while (pi < pieces.length) {
        const val = resolveLevelValue(lvl, pieces[pi].p, locations);
        if (val) { values[lvl.key] = val; usedIdx.add(pieces[pi].i); pi++; break; }
        pi++;
      }
    }
  }

  // Only accept it if the assembled code is a location that actually exists
  const built = DB.buildLocationCode(values, schema);
  const bn = normCode(built);
  if (!bn) return null;
  const real = (locations || []).find(l => normCode(locationCodeOf(l)) === bn);
  if (!real) return null;
  return { code: locationCodeOf(real), usedIdx };
}

function parseCommand(raw, locations, items, schema) {
  const text = String(raw || '').toLowerCase().trim();
  const tokens = text.replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);

  // Intent: placement verbs mean "record where this lives" (quantity untouched),
  // receiving verbs mean "more arrived" (quantity added).
  const PLACE_RE = /\b(put|place|move|set|locate|assign|store|belongs|goes|lives)\b/;
  const RECEIVE_RE = /\b(add|adding|receive|received|receiving)\b/;
  let intent = null;
  if (PLACE_RE.test(text)) intent = 'assign';
  else if (RECEIVE_RE.test(text)) intent = 'receive';

  // SKU lookup from the live catalog
  const skuMap = {};
  (items || []).forEach(it => { if (it.partNumber) skuMap[String(it.partNumber).toLowerCase()] = it; });
  const numberTokens = tokens.filter(t => /^\d{1,6}$/.test(t));

  // 1) Quantity FIRST, anchored to add/quantity/qty — this claims that number so it
  //    can't be mistaken for a SKU (handles "add 24 of 2454": 24 is qty, 2454 is SKU).
  let qty = null, qtyToken = null, m;
  m = text.match(/(?:add|quantity|qty|receive|received)\s+(\d{1,6})/);
  if (m) { qty = parseInt(m[1]); qtyToken = m[1]; }

  // 2) SKU — prefer a number after sku/item/number/part/of; else any leftover number
  //    (not the qty) that matches a known part number. Also try number+letter joins.
  let skuItem = null, skuToken = null;
  const sm = text.match(/(?:sku|item|number|part|of)\s+([a-z0-9]{1,8})/);
  if (sm && sm[1] !== qtyToken && skuMap[sm[1]]) { skuItem = skuMap[sm[1]]; skuToken = sm[1]; }
  if (!skuItem) {
    for (const tk of tokens) { if (tk !== qtyToken && skuMap[tk]) { skuItem = skuMap[tk]; skuToken = tk; break; } }
  }
  if (!skuItem) {
    for (let i = 0; i < tokens.length - 1; i++) {
      const joined = tokens[i] + tokens[i + 1];
      if (joined !== qtyToken && skuMap[joined]) { skuItem = skuMap[joined]; skuToken = joined; break; }
    }
  }

  // 3) Quantity fallbacks (never reuse the SKU number)
  if (qty === null) { m = text.match(/(\d{1,6})\s+of\b/); if (m && m[1] !== skuToken) qty = parseInt(m[1]); }
  if (qty === null) {
    const after = text.match(/(?:add|quantity|qty)\s+([a-z\s]+?)(?:\s+of\b|$)/);
    if (after) qty = wordsToNum(after[1].split(/\s+/));
  }

  // 4) Location — (a) terse code spoken directly ("W1 R1 B2"), then
  //    (b) spoken level names ("warehouse 1, rack 1 B2") via the org schema.
  let locationCode = '';
  let matchedLocNorm = '';
  const locUsedIdx = new Set();
  const tnorm = normCode(text);
  for (const loc of locations) {
    const code = locationCodeOf(loc);
    const cn = normCode(code);
    if (cn && tnorm.includes(cn) && cn.length > matchedLocNorm.length) {
      matchedLocNorm = cn;
      locationCode = code;
    }
  }
  if (!locationCode) {
    const spoken = matchLocationFromSpeech(tokens, schema, locations);
    if (spoken) {
      locationCode = spoken.code;
      matchedLocNorm = normCode(spoken.code);
      spoken.usedIdx.forEach(i => locUsedIdx.add(i));
    }
  }

  // Late quantity fallback: any leftover number that the location did NOT consume.
  // (Runs after location so "warehouse 1 rack 1" can't be read as a quantity.)
  if (qty === null) {
    const leftover = tokens.find((t, i) =>
      /^\d{1,6}$/.test(t) &&
      t !== skuToken &&
      !locUsedIdx.has(i) &&
      !(matchedLocNorm && matchedLocNorm.includes(normCode(t)))
    );
    if (leftover) qty = parseInt(leftover);
  }

  // 5) Item query — drop numbers, the SKU token, filler, level names, and any
  //    token consumed by the location, so leftovers don't pollute the match.
  const levelNames = new Set(
    ((schema && schema.levels) || []).map(l => String(l.name || '').toLowerCase()).filter(Boolean)
  );
  let itemWords = tokens
    .map((w, i) => ({ w, i }))
    .filter(({ w, i }) => !locUsedIdx.has(i))
    .map(({ w }) => w)
    .filter(w => !/^\d+$/.test(w))
    .filter(w => w !== skuToken)
    .filter(w => !FILLER.has(w))
    .filter(w => !levelNames.has(w));
  if (matchedLocNorm) {
    itemWords = itemWords.filter(w => !matchedLocNorm.includes(normCode(w)) || normCode(w).length < 2);
  }
  const itemQuery = itemWords.join(' ').trim();

  // No verb spoken: a bare "item + shelf" with no quantity is a placement;
  // anything with a quantity stays a receive (preserves existing behaviour).
  if (!intent) intent = (qty === null) ? 'assign' : 'receive';

  return { qty, locationCode, itemQuery, skuItem, intent };
}

// Rank items against a free-text query
function matchItems(query, items) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  // "packs" should still match "PACK"
  const stem = w => (w.length > 3 && w.endsWith('s')) ? w.slice(0, -1) : w;
  const words = q.split(/\s+/).filter(Boolean);
  const scored = items.map(it => {
    const name = String(it.name || '').toLowerCase();
    const sku = String(it.partNumber || '').toLowerCase();
    let score = 0;
    for (const w of words) {
      const s = stem(w);
      if (name.includes(w)) score += 2;
      else if (s !== w && name.includes(s)) score += 2;
      if (sku === w) score += 5;
      else if (sku.includes(w)) score += 1;
    }
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
  const [catFilter, setCatFilter] = useState(''); // confirm-card category narrow
  const [transcribing, setTranscribing] = useState(false);
  const recognitionRef = useRef(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);

  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

  // An empty confirm card, so a failed transcription still lets the user pick manually
  const emptyPending = () => ({ candidates: [], selectedItemId: '', locationCode: '', qty: 1, itemQuery: '' });

  // Phrase hints sent to Google: every SKU plus item names and location codes.
  // This is what makes warehouse jargon (MOLLE, MARPAT, FROG, ALICE) recognizable.
  const phraseHints = useMemo(() => {
    const out = [];
    (items || []).forEach(i => {
      if (i.partNumber) out.push(String(i.partNumber));
      if (i.name) out.push(String(i.name).slice(0, 100));
    });
    (locations || []).forEach(l => { const c = locationCodeOf(l); if (c) out.push(c); });
    return [...new Set(out)].slice(0, 2000);
  }, [items, locations]);

  // Locations, sorted in natural order (W1, W2, W10 — not W1, W10, W2)
  const locOptions = useMemo(
    () => locations
      .map(l => ({ code: locationCodeOf(l), id: l.id }))
      .filter(o => o.code)
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: 'base' })),
    [locations]
  );

  // Distinct categories, alphabetical
  const categories = useMemo(
    () => [...new Set((items || []).map(i => i.category).filter(Boolean))]
      .sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' })),
    [items]
  );

  // Items shown in the confirm dropdown: narrowed by the chosen category (alphabetical),
  // otherwise the voice candidates first, then everything else alphabetical.
  const itemDropdownList = useMemo(() => {
    const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    if (catFilter) {
      return (items || []).filter(i => i.category === catFilter).sort(byName);
    }
    const cands = (pending && pending.candidates) || [];
    const rest = (items || []).filter(i => !cands.some(c => c.id === i.id)).sort(byName);
    return [...cands, ...rest];
  }, [items, catFilter, pending]);

  const handleTranscript = (text) => {
    setTranscript(text);
    setResult(null);
    setCatFilter('');
    const { qty, locationCode, itemQuery, skuItem, intent } = parseCommand(text, locations, items, DB.getLocationSchema());
    // A recognized SKU is a confident, exact match — put it first and preselect it.
    const nameMatches = matchItems(itemQuery, items);
    const candidates = skuItem
      ? [skuItem, ...nameMatches.filter(i => i.id !== skuItem.id)]
      : nameMatches;
    setPending({
      candidates,
      selectedItemId: skuItem?.id || candidates[0]?.id || '',
      locationCode: locationCode || '',
      qty: qty && qty > 0 ? qty : 1,
      itemQuery,
      mode: intent === 'assign' ? 'assign' : 'receive'
    });
    if (!skuItem && !candidates.length) setError('No item matched "' + itemQuery + '". Pick it manually below, or say the SKU number.');
    else setError('');
  };

  // ── Fallback: browser (Chrome) speech recognition, used if Google is unavailable ──
  const startBrowserListening = () => {
    if (!SR) { setError('Voice input needs Chrome or Edge on this device.'); return; }
    setError(''); setResult(null); setTranscript('');
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    rec.onresult = (e) => handleTranscript(e.results[0][0].transcript);
    rec.onerror = (e) => { setError('Voice error: ' + (e.error || 'unknown')); setListening(false); };
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    try { rec.start(); } catch (err) { setError('Could not start microphone.'); setListening(false); }
  };

  // ── Primary: record audio and transcribe with Google (knows your SKUs/jargon) ──
  const startRecording = async () => {
    setError(''); setResult(null); setTranscript('');
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      startBrowserListening();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (!blob.size) { setError('No audio captured — try again.'); return; }
        await transcribeWithGoogle(blob);
      };
      recorderRef.current = mr;
      mr.start();
      setListening(true);
    } catch (e) {
      // Mic blocked or unavailable — fall back to the browser engine
      startBrowserListening();
    }
  };

  const transcribeWithGoogle = async (blob) => {
    setTranscribing(true);
    try {
      const base64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onloadend = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
      const fn = httpsCallable(fbFunctions, 'transcribeVoice');
      const res = await fn({ audioBase64: base64, encoding: 'WEBM_OPUS', phrases: phraseHints });
      const text = (res && res.data && res.data.transcript) || '';
      if (!text) { setError('Didn\u2019t catch that \u2014 try again, or pick the item below.'); setPending(emptyPending()); }
      else handleTranscript(text);
    } catch (e) {
      // Google unavailable (not enabled / offline) — quietly use the browser engine
      console.warn('Google transcription failed, falling back:', e && e.message);
      setError('');
      startBrowserListening();
    } finally {
      setTranscribing(false);
    }
  };

  const stopListening = () => {
    setListening(false);
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      try { recorderRef.current.stop(); } catch (e) {}
      return;
    }
    try { recognitionRef.current && recognitionRef.current.stop(); } catch (e) {}
  };

  const currentAtLocation = () => {
    if (!pending) return 0;
    const loc = locations.find(l => locationCodeOf(l) === pending.locationCode);
    if (!loc || !loc.inventory) return 0;
    return parseInt(loc.inventory[pending.selectedItemId]) || 0;
  };

  // Locations that currently hold this item — used to guard voice assignment
  const locationsHolding = (itemId) => {
    if (!itemId) return [];
    return locations
      .filter(l => l.inventory && l.inventory[itemId] != null && (parseInt(l.inventory[itemId]) || 0) > 0)
      .map(l => locationCodeOf(l));
  };

  const apply = async () => {
    if (!pending) return;
    if (!pending.selectedItemId) { setError('Choose an item first.'); return; }
    if (!pending.locationCode) { setError('Choose a location first.'); return; }
    const isAssign = pending.mode === 'assign';
    const qty = parseInt(pending.qty) || 0;
    if (!isAssign && qty <= 0) { setError('Enter a quantity greater than zero.'); return; }

    const item = items.find(i => i.id === pending.selectedItemId);

    // Guard: assigning is exclusive (it clears other locations), so never let
    // voice silently collapse an item that is deliberately split across shelves.
    if (isAssign) {
      const holding = locationsHolding(pending.selectedItemId)
        .filter(c => normCode(c) !== normCode(pending.locationCode));
      if (holding.length > 1) {
        setError(`"${item?.name || 'This item'}" is stocked in ${holding.length} locations (${holding.join(', ')}). Set its locations from the item screen so nothing is lost.`);
        return;
      }
    }

    setBusy(true); setError('');
    try {
      if (isAssign) {
        const keepStock = parseInt(item?.stock) || 0;
        await DB.syncItemToLocation(pending.selectedItemId, pending.locationCode, keepStock);
        setResult('📍 ' + (item?.name || 'Item') + ' set to ' + pending.locationCode + ' — stock unchanged at ' + keepStock);
      } else {
        const res = await DB.receiveToLocation(pending.locationCode, pending.selectedItemId, qty);
        setResult('✅ Added ' + qty + ' × ' + (item?.name || 'item') + ' to ' + pending.locationCode +
          (res && res.newLocQty != null ? ' (now ' + res.newLocQty + ' there)' : ''));
      }
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
          onClick={listening ? stopListening : startRecording}
          disabled={busy || transcribing}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '14px 26px',
            borderRadius: 30, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 16,
            background: listening ? '#d32f2f' : (transcribing ? '#777' : '#4a5d23'), color: '#fff',
            boxShadow: listening ? '0 0 0 4px rgba(211,47,47,0.25)' : 'none'
          }}
        >
          <span style={{ fontSize: 20 }}>{listening ? '⏹️' : transcribing ? '⏳' : '🎤'}</span>
          {listening ? 'Listening… tap when done' : transcribing ? 'Reading it back…' : 'Tap & read the label'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          <strong>Add stock:</strong> “add 24 to warehouse 1 rack 1 B2, SKU 2454”<br />
          <strong>Set location:</strong> “put SKU 2454 in warehouse 1, rack 1, B2”
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontWeight: 700 }}>
              {pending.mode === 'assign' ? '📍 Set location' : '➕ Add to inventory'}
            </span>
            <button
              type="button"
              onClick={() => setPending({ ...pending, mode: pending.mode === 'assign' ? 'receive' : 'assign' })}
              style={{
                fontSize: 11, padding: '3px 10px', borderRadius: 12, cursor: 'pointer',
                border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)'
              }}
            >
              switch to {pending.mode === 'assign' ? 'adding stock' : 'setting location'}
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
            {/* Category filter (alphabetical) to narrow the item list */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 180px' }}>
                <label style={fieldLabel}>Filter by category</label>
                <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={input}>
                  <option value="">All categories</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div style={{ flex: '2 1 260px' }}>
                <label style={fieldLabel}>Item</label>
                <select
                  value={pending.selectedItemId}
                  onChange={e => setPending({ ...pending, selectedItemId: e.target.value })}
                  style={input}
                >
                  <option value="">— choose item —</option>
                  {itemDropdownList.map(it => (
                    <option key={it.id} value={it.id}>
                      {it.name}{it.partNumber ? ' · ' + it.partNumber : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

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
              {pending.mode !== 'assign' && (
                <div style={{ width: 110 }}>
                  <label style={fieldLabel}>Quantity</label>
                  <input
                    type="number" min="1"
                    value={pending.qty}
                    onChange={e => setPending({ ...pending, qty: e.target.value === '' ? '' : parseInt(e.target.value) || 0 })}
                    style={input}
                  />
                </div>
              )}
            </div>

            {/* On-hand preview */}
            {pending.selectedItemId && pending.locationCode && (
              pending.mode === 'assign' ? (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  {(() => {
                    const held = locationsHolding(pending.selectedItemId)
                      .filter(c => normCode(c) !== normCode(pending.locationCode));
                    return held.length === 1
                      ? <>Currently at <strong>{held[0]}</strong> → will move to <strong>{pending.locationCode}</strong>. </>
                      : <>Will be recorded at <strong>{pending.locationCode}</strong>. </>;
                  })()}
                  Stock stays <strong>{selectedItem ? (selectedItem.stock || 0) : 0}</strong> — nothing added.
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  {pending.locationCode}: {currentAtLocation()} on hand → <strong>{currentAtLocation() + (parseInt(pending.qty) || 0)}</strong> after.
                  {selectedItem && <> Item total: {selectedItem.stock || 0} → <strong>{(selectedItem.stock || 0) + (parseInt(pending.qty) || 0)}</strong>.</>}
                </div>
              )
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
            <button onClick={() => { setPending(null); setTranscript(''); }} disabled={busy}
              style={{ ...btn, background: 'var(--btn-secondary-bg, #eee)', color: 'var(--btn-secondary-color, #333)' }}>
              Cancel
            </button>
            <button onClick={apply} disabled={busy}
              style={{ ...btn, background: pending.mode === 'assign' ? '#1565c0' : '#4a5d23', color: '#fff' }}>
              {busy ? 'Saving…' : (pending.mode === 'assign' ? '📍 Assign location' : '✅ Add to inventory')}
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
