import { useState, useEffect, useRef, useMemo } from 'react';
import { OrgDB as DB } from '../orgDb';
import { useAuth } from '../OrgAuthContext';

const SNAP = 26;
const DEFAULT_PATTERN = '{wh}-{rack}-{col}{row}';

const colLetters = (n) => {
  let s = ''; n = Math.max(0, n);
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};
const labelFor = (mode, start, index) => {
  if (mode === 'alpha') {
    const base = (start || 'A').toUpperCase().charCodeAt(0) - 65;
    return colLetters(base + index);
  }
  return String((parseInt(start) || 1) + index);
};
const buildCode = (pattern, wh, rack, row, col) =>
  String(pattern || DEFAULT_PATTERN)
    .replace(/{wh}/g, wh).replace(/{rack}/g, rack)
    .replace(/{row}/g, row).replace(/{col}/g, col);

// Canonical comparison so "W1-R1-A-1" and "W1-R1-A1" are treated as the same shelf.
const canon = (code) => {
  if (!code) return '';
  if (DB.canonicalLocationCode) return DB.canonicalLocationCode(code).toUpperCase();
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
};

export default function WarehouseMap() {
  const { organization, userRole, user, refreshOrganization } = useAuth();

  const isAdmin = userRole === 'admin';
  const mapEditors = organization?.mapEditors || [];
  const canBuild = isAdmin || mapEditors.includes(user?.email);

  const [racks, setRacks] = useState([]);
  // One compass per warehouse — buildings can face different directions.
  const [compasses, setCompasses] = useState({});
  const [activeTab, setActiveTab] = useState('ALL');
  const [tabHint, setTabHint] = useState('');
  const [locations, setLocations] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState('');
  const [editingIdx, setEditingIdx] = useState(null);
  const [undo, setUndo] = useState(null);
  const stageRef = useRef(null);

  // ---- builder panel fields ----
  const [wh, setWh] = useState('W1');
  const [rackName, setRackName] = useState('R1');
  const [cols, setCols] = useState(6);
  const [uniform, setUniform] = useState(4);
  const [colShelves, setColShelves] = useState([4, 4, 4, 4, 4, 4]);
  const [rowMode, setRowMode] = useState('num');
  const [colMode, setColMode] = useState('alpha');
  const [rowStart, setRowStart] = useState('1');
  const [colStart, setColStart] = useState('A');
  const [pattern, setPattern] = useState(DEFAULT_PATTERN);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [organization?.id]);

  const load = async () => {
    setLoading(true);
    try {
      const [locs, its] = await Promise.all([DB.getLocations(), DB.getItems()]);
      setLocations(locs || []);
      setItems(its || []);
      const saved = organization?.warehouseMap;
      if (saved && Array.isArray(saved.racks)) {
        setRacks(saved.racks);
        if (saved.compasses) {
          setCompasses(saved.compasses);
        } else if (saved.compass) {
          // migrate the old single compass onto every warehouse it covered
          const whs = [...new Set(saved.racks.map(r => r.wh))];
          const seed = {};
          whs.forEach(w => { seed[w] = { ...saved.compass }; });
          setCompasses(seed);
        }
      }
    } catch (e) {
      console.error('WarehouseMap load failed', e);
    }
    setLoading(false);
  };

  // keep per-column shelves in step with the column count
  useEffect(() => {
    setColShelves(prev => {
      const next = prev.slice(0, cols);
      while (next.length < cols) next.push(uniform);
      return next;
    });
  }, [cols]); // eslint-disable-line

  const applyUniform = (v) => {
    setUniform(v);
    setColShelves(Array(cols).fill(v));
  };

  // ---- real location lookup ----
  const locationCodeSet = useMemo(() => {
    const s = new Set();
    (locations || []).forEach(l => {
      const raw = l.locationCode || `${l.warehouse}-R${l.rack}-${l.letter}${l.shelf}`;
      if (raw) s.add(canon(raw));
    });
    return s;
  }, [locations]);

  // itemId -> [canonical location codes]
  const itemLocationIndex = useMemo(() => {
    const idx = {};
    (locations || []).forEach(l => {
      const raw = l.locationCode || `${l.warehouse}-R${l.rack}-${l.letter}${l.shelf}`;
      const c = canon(raw);
      const inv = l.inventory || {};
      Object.keys(inv).forEach(itemId => {
        if ((parseInt(inv[itemId]) || 0) > 0) (idx[itemId] = idx[itemId] || []).push(c);
      });
    });
    (items || []).forEach(it => {
      if (it.location) {
        const c = canon(it.location);
        if (!idx[it.id]) idx[it.id] = [c];
        else if (!idx[it.id].includes(c)) idx[it.id].push(c);
      }
    });
    return idx;
  }, [locations, items]);

  // Which cells should light up for the current search.
  // Tokenised + order-independent: "b2 w1 r1", "w1 b2", "duffle od" all work.
  const { hitCodes, hitMode, searchNote } = useMemo(() => {
    const raw = search.trim();
    if (!raw) return { hitCodes: new Set(), hitMode: null, searchNote: '' };

    // split on anything that isn't a letter or digit
    const tokens = raw.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    if (!tokens.length) return { hitCodes: new Set(), hitMode: null, searchNote: '' };

    // 1) LOCATIONS — every token must appear somewhere in the flattened code,
    //    so order and separators don't matter.
    const codeHits = new Set();
    locationCodeSet.forEach(code => {
      const flat = code.replace(/[^A-Z0-9]/g, '');
      if (tokens.every(t => flat.includes(t))) codeHits.add(code);
    });
    if (codeHits.size) {
      return {
        hitCodes: codeHits, hitMode: 'location',
        searchNote: codeHits.size === 1
          ? `${[...codeHits][0]}`
          : `${codeHits.size} locations match`
      };
    }

    // 2) ITEMS — every token must appear in the name, or match the SKU exactly.
    const matched = (items || []).filter(it => {
      const name = String(it.name || '').toUpperCase();
      const sku = String(it.partNumber || '').toUpperCase();
      if (tokens.length === 1 && sku === tokens[0]) return true;
      return tokens.every(t => name.includes(t) || sku === t);
    });

    const s2 = new Set();
    matched.forEach(it => (itemLocationIndex[it.id] || []).forEach(c => s2.add(c)));

    if (!matched.length) return { hitCodes: s2, hitMode: 'item', searchNote: 'No match' };
    if (!s2.size) {
      return {
        hitCodes: s2, hitMode: 'item',
        searchNote: `${matched[0].name} — no location assigned`
      };
    }
    const label = matched.length === 1
      ? `${matched[0].name} → ${[...s2].join(', ')}`
      : `${matched.length} items → ${[...s2].length} location(s)`;
    return { hitCodes: s2, hitMode: 'item', searchNote: label };
  }, [search, locationCodeSet, items, itemLocationIndex]);

  // ---- warehouses / tabs ----
  const warehouses = useMemo(
    () => [...new Set(racks.map(r => r.wh).filter(Boolean))].sort(),
    [racks]
  );

  // On the "All" tab each warehouse gets its own quadrant so buildings don't
  // overlap. Offsets are computed from each warehouse's own bounding box.
  const QUAD_GAP = 160;
  const quadrantOffsets = useMemo(() => {
    const offs = {};
    let colW = 0, rowH = 0;
    const sizes = {};
    warehouses.forEach(w => {
      const rs = racks.filter(r => r.wh === w);
      const maxX = Math.max(0, ...rs.map(r => (r.x || 0) + 420));
      const maxY = Math.max(0, ...rs.map(r => (r.y || 0) + 340));
      sizes[w] = { w: maxX, h: maxY };
      colW = Math.max(colW, maxX);
      rowH = Math.max(rowH, maxY);
    });
    warehouses.forEach((w, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      offs[w] = { x: col * (colW + QUAD_GAP), y: row * (rowH + QUAD_GAP) };
    });
    return offs;
  }, [warehouses, racks]);

  const showingAll = activeTab === 'ALL';
  const visibleRacks = useMemo(() => {
    if (showingAll) {
      return racks.map((r, i) => ({
        cfg: r, idx: i,
        offX: quadrantOffsets[r.wh]?.x || 0,
        offY: quadrantOffsets[r.wh]?.y || 0
      }));
    }
    return racks.map((r, i) => ({ cfg: r, idx: i, offX: 0, offY: 0 }))
                .filter(e => e.cfg.wh === activeTab);
  }, [racks, activeTab, showingAll, quadrantOffsets]);

  // Which warehouses contain the current search hits (so we can point the user
  // at the right tab instead of showing an empty canvas).
  const hitWarehouses = useMemo(() => {
    if (!hitCodes.size) return [];
    const set = new Set();
    racks.forEach(cfg => {
      const tallest = Math.max(...cfg.colShelves);
      for (let r = 0; r < tallest; r++) {
        const shelf = tallest - r;
        for (let c = 0; c < cfg.colShelves.length; c++) {
          if (shelf > cfg.colShelves[c]) continue;
          const code = buildCode(cfg.pattern, cfg.wh, cfg.rack,
            labelFor(cfg.rowMode, cfg.rowStart, shelf - 1),
            labelFor(cfg.colMode, cfg.colStart, c));
          if (hitCodes.has(canon(code))) set.add(cfg.wh);
        }
      }
    });
    return [...set];
  }, [hitCodes, racks]);

  // If the hit isn't on the tab you're looking at, say so.
  useEffect(() => {
    if (!hitWarehouses.length) { setTabHint(''); return; }
    if (showingAll || hitWarehouses.includes(activeTab)) { setTabHint(''); return; }
    setTabHint(hitWarehouses.join(', '));
  }, [hitWarehouses, activeTab, showingAll]);

  const compassFor = (w) => compasses[w] || { x: 40, y: 40, rot: 0, show: true };
  const setCompassFor = (w, patch) =>
    setCompasses(prev => ({ ...prev, [w]: { ...compassFor(w), ...patch } }));

  // ---- rack helpers ----
  const currentConfig = () => ({
    wh: wh.trim() || 'W1', rack: rackName.trim() || 'R1',
    colShelves: colShelves.slice(),
    rowMode, colMode, rowStart: rowStart.trim() || '1', colStart: colStart.trim() || 'A',
    pattern: pattern.trim() || DEFAULT_PATTERN,
    scaleX: 1, scaleY: 1, rot: 0, x: 0, y: 0
  });

  const addRack = () => {
    if (editingIdx !== null) {
      setRacks(prev => prev.map((r, i) => i === editingIdx ? {
        ...r,
        wh: wh.trim() || 'W1', rack: rackName.trim() || 'R1',
        colShelves: colShelves.slice(),
        rowMode, colMode, rowStart, colStart, pattern
      } : r));
      setEditingIdx(null);
      setDirty(true);
      return;
    }
    const cfg = currentConfig();
    const n = racks.length;
    cfg.x = 40 + (n % 4) * 340;
    cfg.y = 40 + Math.floor(n / 4) * 300;
    setRacks(prev => [...prev, cfg]);
    setDirty(true);
    const m = rackName.match(/^([A-Za-z]*)(\d+)$/);
    if (m) setRackName(m[1] + (parseInt(m[2]) + 1));
  };

  const startEdit = (idx) => {
    const c = racks[idx];
    setEditingIdx(idx);
    setWh(c.wh); setRackName(c.rack);
    setCols(c.colShelves.length);
    setColShelves(c.colShelves.slice());
    setUniform(Math.max(...c.colShelves));
    setRowMode(c.rowMode); setColMode(c.colMode);
    setRowStart(c.rowStart); setColStart(c.colStart);
    setPattern(c.pattern);
  };

  const removeRack = (idx) => {
    const cfg = racks[idx];
    setUndo({ cfg, idx });
    setRacks(prev => prev.filter((_, i) => i !== idx));
    if (editingIdx === idx) setEditingIdx(null);
    setDirty(true);
    setTimeout(() => setUndo(u => (u && u.cfg === cfg ? null : u)), 6000);
  };

  const doUndo = () => {
    if (!undo) return;
    setRacks(prev => {
      const next = prev.slice();
      next.splice(Math.min(undo.idx, next.length), 0, undo.cfg);
      return next;
    });
    setUndo(null); setDirty(true);
  };

  // ---- persistence ----
  const saveMap = async () => {
    if (!organization?.id) return;
    setSaving(true);
    try {
      await DB.updateOrganization(organization.id, {
        warehouseMap: { racks, compasses, updatedAt: Date.now() }
      });
      if (refreshOrganization) await refreshOrganization();
      setDirty(false);
    } catch (e) {
      alert('Could not save the map: ' + (e.message || e));
    }
    setSaving(false);
  };

  // ---- drag / resize / rotate ----
  const dragRack = (e, idx) => {
    if (!canBuild) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const o = racks[idx];
    const ox = o.x || 0, oy = o.y || 0;
    const move = (ev) => {
      let nx = ox + (ev.clientX - startX), ny = oy + (ev.clientY - startY);
      if (!ev.shiftKey) { nx = Math.round(nx / SNAP) * SNAP; ny = Math.round(ny / SNAP) * SNAP; }
      nx = Math.max(0, nx); ny = Math.max(0, ny);
      setRacks(prev => prev.map((r, i) => i === idx ? { ...r, x: nx, y: ny } : r));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDirty(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const resizeRack = (e, idx, axis, boxEl) => {
    if (!canBuild) return;
    e.preventDefault(); e.stopPropagation();
    const cfg = racks[idx];
    const deg = cfg.rot || 0;
    const swapped = (deg === 90 || deg === 270);
    const baseW = boxEl.offsetWidth, baseH = boxEl.offsetHeight;
    const sX = cfg.scaleX ?? 1, sY = cfg.scaleY ?? 1;
    const startX = e.clientX, startY = e.clientY;
    const clamp = v => Math.max(0.35, Math.min(2, v));
    const move = (ev) => {
      const dSX = ev.clientX - startX, dSY = ev.clientY - startY;
      const dW = swapped ? dSY : dSX, dH = swapped ? dSX : dSY;
      let nx = sX, ny = sY;
      if (axis === 'x' || axis === 'both') nx = clamp(sX + dW / baseW);
      if (axis === 'y' || axis === 'both') ny = clamp(sY + dH / baseH);
      setRacks(prev => prev.map((r, i) => i === idx ? { ...r, scaleX: nx, scaleY: ny } : r));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDirty(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const rotateRack = (idx) => {
    setRacks(prev => prev.map((r, i) => i === idx ? { ...r, rot: ((r.rot || 0) + 90) % 360 } : r));
    setDirty(true);
  };

  const dragCompass = (e, w) => {
    if (!canBuild || showingAll) return;
    e.preventDefault();
    const cp = compassFor(w);
    const sx = e.clientX, sy = e.clientY, ox = cp.x, oy = cp.y;
    const move = ev => setCompassFor(w, { x: Math.max(0, ox + (ev.clientX - sx)), y: Math.max(0, oy + (ev.clientY - sy)) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDirty(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // unknown-code counter for the header warning
  const unknownCount = useMemo(() => {
    let n = 0;
    racks.forEach(cfg => {
      const tallest = Math.max(...cfg.colShelves);
      for (let r = 0; r < tallest; r++) {
        const shelf = tallest - r;
        for (let c = 0; c < cfg.colShelves.length; c++) {
          if (shelf > cfg.colShelves[c]) continue;
          const code = buildCode(cfg.pattern, cfg.wh, cfg.rack,
            labelFor(cfg.rowMode, cfg.rowStart, shelf - 1),
            labelFor(cfg.colMode, cfg.colStart, c));
          if (!locationCodeSet.has(canon(code))) n++;
        }
      }
    });
    return n;
  }, [racks, locationCodeSet]);

  if (loading) return <div style={{ padding: 40 }}>Loading map…</div>;

  return (
    <div className="wmap">
      <style>{CSS}</style>

      <div className="wmap-shell">
        {canBuild && (
          <div className="wmap-panel">
            <h1>Warehouse Map</h1>
            <div className="sub">Build a rack, subdivide it, label the axes.</div>

            <div className="grp">
              <h2>Placement</h2>
              <div className="fld"><label>Warehouse</label>
                <input value={wh} onChange={e => setWh(e.target.value)} /></div>
              <div className="fld"><label>Rack label</label>
                <input value={rackName} onChange={e => setRackName(e.target.value)} /></div>
            </div>

            <div className="grp">
              <h2>Subdivide</h2>
              <div className="row2">
                <div className="fld"><label>Columns</label>
                  <Stepper value={cols} min={1} max={30} onChange={setCols} /></div>
                <div className="fld"><label>Shelves (all)</label>
                  <Stepper value={uniform} min={1} max={30} onChange={applyUniform} /></div>
              </div>
              <div className="fld">
                <label>Per-column shelves <span className="muted">(tweak the odd one)</span></label>
                <div className="percol">
                  {colShelves.map((n, i) => (
                    <div className="colst" key={i}>
                      <div className="cl">{labelFor(colMode, colStart, i)}</div>
                      <div className="cc">
                        <button onClick={() => setColShelves(p => p.map((v, j) => j === i ? Math.max(1, v - 1) : v))}>−</button>
                        <div className={'v' + (n !== uniform ? ' custom' : '')}>{n}</div>
                        <button onClick={() => setColShelves(p => p.map((v, j) => j === i ? Math.min(30, v + 1) : v))}>+</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="note">
                {colShelves.reduce((a, b) => a + b, 0)} shelf positions across {colShelves.length} columns
              </div>
            </div>

            <div className="grp">
              <h2>Labeling</h2>
              <div className="fld"><label>Rows are</label>
                <div className="radios">
                  <button className={rowMode === 'alpha' ? 'on' : ''} onClick={() => setRowMode('alpha')}>Alphabetical</button>
                  <button className={rowMode === 'num' ? 'on' : ''} onClick={() => setRowMode('num')}>Numeric</button>
                </div></div>
              <div className="fld"><label>Columns are</label>
                <div className="radios">
                  <button className={colMode === 'num' ? 'on' : ''} onClick={() => setColMode('num')}>Numeric</button>
                  <button className={colMode === 'alpha' ? 'on' : ''} onClick={() => setColMode('alpha')}>Alphabetical</button>
                </div></div>
              <div className="row2">
                <div className="fld"><label>Row start (floor)</label>
                  <input value={rowStart} onChange={e => setRowStart(e.target.value)} /></div>
                <div className="fld"><label>Col start (left)</label>
                  <input value={colStart} onChange={e => setColStart(e.target.value)} /></div>
              </div>
              <div className="fld"><label>Code pattern</label>
                <input value={pattern} onChange={e => setPattern(e.target.value)} />
                <div className="hint">Tokens: {'{wh} {rack} {row} {col}'}</div></div>
            </div>

            <button className="btn primary" onClick={addRack}>
              {editingIdx !== null ? `✓ Save changes to ${racks[editingIdx]?.wh}-${racks[editingIdx]?.rack}` : '+ Add rack to map'}
            </button>
            {editingIdx !== null && (
              <button className="btn ghost" onClick={() => setEditingIdx(null)}>Cancel edit</button>
            )}

            {racks.length > 0 && (
              <div className="grp" style={{ marginTop: 14 }}>
                <h2>Racks on map</h2>
                {racks.map((r, i) => (
                  <div className="rrow" key={i}>
                    <span className="nm">{r.wh}-{r.rack}</span>
                    <span className="sz">{r.colShelves.length}× · {r.colShelves.reduce((a, b) => a + b, 0)}</span>
                    <button className="go" onClick={() => stageRef.current?.scrollTo({ left: Math.max(0, (r.x || 0) - 80), top: Math.max(0, (r.y || 0) - 80), behavior: 'smooth' })}>Find</button>
                    <button className="ed" onClick={() => startEdit(i)}>Edit</button>
                    <button className="rm" onClick={() => removeRack(i)}>Delete</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="wmap-main">
          <div className="wmap-bar">
            <div className="srch">
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search any order — &quot;w1 b2&quot;, &quot;b2 r1 w1&quot;, &quot;duffle od&quot;, or a SKU…" />
            </div>
            {searchNote && <span className="snote">{searchNote}</span>}
            <div className="spacer" />

            <div className="wtabs">
              <button className={showingAll ? 'on' : ''} onClick={() => setActiveTab('ALL')}
                title="Overview of every warehouse">
                🗂️ All{warehouses.length ? ` ${warehouses.length}` : ''}
              </button>
              {warehouses.map(w => (
                <button key={w} className={activeTab === w ? 'on' : ''} onClick={() => setActiveTab(w)}
                  title={`${racks.filter(r => r.wh === w).length} rack(s) in ${w}`}>
                  {w}<span className="cnt">{racks.filter(r => r.wh === w).length}</span>
                </button>
              ))}
            </div>

            {unknownCount > 0 && canBuild && (
              <span className="warn" title="These cells don't match a Locations record">
                ⚠️ {unknownCount} cell(s) not in Locations
              </span>
            )}
            {!showingAll && activeTab && (
              <button className="btn tiny ghost"
                onClick={() => { setCompassFor(activeTab, { show: !compassFor(activeTab).show }); setDirty(true); }}>
                ✦ Compass
              </button>
            )}
            {canBuild && (
              <button className="btn tiny primary" onClick={saveMap} disabled={saving || !dirty}>
                {saving ? 'Saving…' : dirty ? '💾 Save map' : 'Saved'}
              </button>
            )}
          </div>

          {!canBuild && (
            <div className="viewnote">👁 Viewer — search to locate an item or shelf. Editing the map is limited to admins and anyone they grant access to.</div>
          )}

          {tabHint && (
            <div className="tabhint">
              🔎 Match is in <strong>{tabHint}</strong> —
              <button onClick={() => setActiveTab(tabHint.split(', ')[0])}>switch to {tabHint.split(', ')[0]}</button>
            </div>
          )}

          <div className="wmap-stage" ref={stageRef}>
            <div className="wmap-canvas">
              {racks.length === 0 && (
                <div className="empty">
                  {canBuild ? <>Build a rack on the left, then <strong>Add rack to map</strong>.</>
                            : <>No map has been built yet.</>}
                </div>
              )}

              {visibleRacks.map(({ cfg, idx, offX, offY }) => (
                <Rack key={idx} cfg={cfg} idx={idx}
                  canBuild={canBuild && !showingAll}
                  offX={offX} offY={offY}
                  hitCodes={hitCodes} hitMode={hitMode} locationCodeSet={locationCodeSet}
                  onDrag={dragRack} onResize={resizeRack} onRotate={rotateRack}
                  onDelete={removeRack} />
              ))}

              {/* Quadrant labels on the All tab */}
              {showingAll && warehouses.map(w => (
                <div key={'lbl' + w} className="quadlbl"
                  style={{ left: (quadrantOffsets[w]?.x || 0), top: Math.max(0, (quadrantOffsets[w]?.y || 0) - 30) }}>
                  {w}
                </div>
              ))}

              {(showingAll ? warehouses : [activeTab]).filter(Boolean).map(w => {
                const cp = compassFor(w);
                if (!cp.show) return null;
                const ox = showingAll ? (quadrantOffsets[w]?.x || 0) : 0;
                const oy = showingAll ? (quadrantOffsets[w]?.y || 0) : 0;
                return (
                  <div key={'cmp' + w} className="compass"
                    style={{ left: cp.x + ox, top: cp.y + oy }}
                    onPointerDown={(e) => dragCompass(e, w)}>
                    <svg width="104" height="104" viewBox="0 0 104 104" style={{ transform: `rotate(${cp.rot}deg)` }}>
                      <circle cx="52" cy="52" r="49" fill="#fff" stroke="#d8d6c8" strokeWidth="2" />
                      <polygon points="52,6 60,44 52,52 44,44" fill="#4a5d23" />
                      <polygon points="52,98 60,60 52,52 44,60" fill="#b8b8a8" />
                      <polygon points="98,52 60,60 52,52 60,44" fill="#b8b8a8" />
                      <polygon points="6,52 44,60 52,52 44,44" fill="#b8b8a8" />
                      <text x="52" y="22" textAnchor="middle" fontSize="13" fontWeight="700" fill="#fff">N</text>
                      <text x="52" y="94" textAnchor="middle" fontSize="10" fontWeight="700" fill="#7c8168">S</text>
                      <text x="90" y="56" textAnchor="middle" fontSize="10" fontWeight="700" fill="#7c8168">E</text>
                      <text x="14" y="56" textAnchor="middle" fontSize="10" fontWeight="700" fill="#7c8168">W</text>
                    </svg>
                    <div className="cwh">{w}</div>
                    {canBuild && !showingAll && (
                      <div className="cbtns">
                        <button onPointerDown={e => { e.stopPropagation(); setCompassFor(w, { rot: (cp.rot + 345) % 360 }); setDirty(true); }}>↺</button>
                        <button onPointerDown={e => { e.stopPropagation(); setCompassFor(w, { rot: (cp.rot + 15) % 360 }); setDirty(true); }}>↻</button>
                        <button onPointerDown={e => { e.stopPropagation(); setCompassFor(w, { show: false }); setDirty(true); }}>×</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

        </div>
      </div>

      {undo && (
        <div className="undobar">
          <span>Deleted {undo.cfg.wh}-{undo.cfg.rack}</span>
          <button onClick={doUndo}>Undo</button>
        </div>
      )}
    </div>
  );
}

function Stepper({ value, min, max, onChange }) {
  return (
    <div className="stp">
      <button onClick={() => onChange(Math.max(min, (parseInt(value) || min) - 1))}>−</button>
      <input type="number" value={value} min={min} max={max}
        onChange={e => onChange(Math.max(min, Math.min(max, parseInt(e.target.value) || min)))} />
      <button onClick={() => onChange(Math.min(max, (parseInt(value) || min) + 1))}>+</button>
    </div>
  );
}

function Rack({ cfg, idx, canBuild, offX = 0, offY = 0, hitCodes, hitMode, locationCodeSet, onDrag, onResize, onRotate, onDelete }) {
  const boxRef = useRef(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (boxRef.current) setDims({ w: boxRef.current.offsetWidth, h: boxRef.current.offsetHeight });
  }, [cfg.colShelves, cfg.pattern, cfg.wh, cfg.rack, cfg.rowMode, cfg.colMode, cfg.rowStart, cfg.colStart]);

  const sx = cfg.scaleX ?? 1, sy = cfg.scaleY ?? 1, deg = cfg.rot || 0;
  const swapped = deg === 90 || deg === 270;
  const shelves = cfg.colShelves;
  const tallest = Math.max(...shelves);

  const rows = [];
  for (let r = 0; r < tallest; r++) {
    const shelfFromFloor = tallest - r;
    for (let c = 0; c < shelves.length; c++) {
      const colLabel = labelFor(cfg.colMode, cfg.colStart, c);
      if (shelfFromFloor > shelves[c]) { rows.push({ void: true, key: `${r}-${c}` }); continue; }
      const rowLabel = labelFor(cfg.rowMode, cfg.rowStart, shelfFromFloor - 1);
      const code = buildCode(cfg.pattern, cfg.wh, cfg.rack, rowLabel, colLabel);
      const cc = canon(code);
      rows.push({
        key: `${r}-${c}`, label: `${colLabel}${rowLabel}`, code,
        known: locationCodeSet.has(cc),
        hit: hitCodes.has(cc)
      });
    }
  }
  const anyHit = hitCodes.size > 0;

  return (
    <div className="rack" style={{
      left: (cfg.x || 0) + offX, top: (cfg.y || 0) + offY,
      width: (swapped ? dims.h * sy : dims.w * sx) || undefined,
      height: (swapped ? dims.w * sx : dims.h * sy) || undefined
    }}>
      <div className="rbox" ref={boxRef} style={{
        width: dims.w || undefined, height: dims.h || undefined,
        marginLeft: dims.w ? -dims.w / 2 : 0, marginTop: dims.h ? -dims.h / 2 : 0,
        transform: `rotate(${deg}deg) scale(${sx}, ${sy})`
      }}>
        <div className="rhead" onPointerDown={canBuild ? (e) => onDrag(e, idx) : undefined}
          style={{ cursor: canBuild ? 'grab' : 'default' }}>
          {canBuild && <span className="grip">⁙</span>}
          <span className="wh">{cfg.wh}</span> {cfg.rack}
          {canBuild && (
            <>
              <button className="rrot" title="Rotate 90°"
                onPointerDown={e => { e.stopPropagation(); e.preventDefault(); onRotate(idx); }}>↻</button>
              <button className="rdel" title="Delete rack"
                onPointerDown={e => { e.stopPropagation(); e.preventDefault(); onDelete(idx); }}>×</button>
            </>
          )}
        </div>

        <div className="axcol" style={{ gridTemplateColumns: `repeat(${shelves.length}, minmax(54px,1fr))` }}>
          {shelves.map((_, c) => <div key={c}>{labelFor(cfg.colMode, cfg.colStart, c)}</div>)}
        </div>

        <div className="axwrap">
          <div className="axrow" style={{ gridTemplateRows: `repeat(${tallest},1fr)` }}>
            {Array.from({ length: tallest }, (_, r) =>
              <div key={r}>{labelFor(cfg.rowMode, cfg.rowStart, tallest - 1 - r)}</div>)}
          </div>
          <div className="rgrid" style={{ gridTemplateColumns: `repeat(${shelves.length}, minmax(54px,1fr))` }}>
            {rows.map(cell => cell.void
              ? <div className="cell void" key={cell.key} />
              : <div key={cell.key}
                  className={'cell' + (cell.hit ? (hitMode === 'item' ? ' item-hit' : ' hit') : (anyHit ? ' dim' : '')) + (!cell.known ? ' unknown' : '')}
                  title={cell.known ? cell.code : `${cell.code} — no matching Locations record`}>
                  {cell.label}
                </div>)}
          </div>
        </div>
      </div>

      {canBuild && (
        <>
          <div className="rz e" onPointerDown={e => onResize(e, idx, 'x', boxRef.current)} title="Stretch east–west" />
          <div className="rz s" onPointerDown={e => onResize(e, idx, 'y', boxRef.current)} title="Stretch north–south" />
          <div className="rz c" onPointerDown={e => onResize(e, idx, 'both', boxRef.current)} title="Resize both" />
        </>
      )}
    </div>
  );
}

const CSS = `
.wmap { --army:#4a5d23; --army-dark:#38471b; --army-light:#6b7f3e; --sandm:#f5f3ec;
  --linem:#d8d6c8; --mutedm:#7c8168; --hitm:#d94a3d; --amberm:#d98a1f; }
.wmap-shell { display:flex; height:calc(100vh - 240px); min-height:380px; max-height:calc(100vh - 120px);
  border:1px solid var(--linem); border-radius:10px; overflow:hidden; background:#fff; }
.wmap-panel { width:310px; flex-shrink:0; border-right:1px solid var(--linem); overflow-y:auto; padding:16px; background:#fff; }
.wmap-panel h1 { font-size:15px; margin:0 0 2px; text-transform:uppercase; color:var(--army); letter-spacing:.02em; }
.wmap-panel .sub { font-size:12px; color:var(--mutedm); margin-bottom:16px; }
.wmap .grp { border:1px solid var(--linem); border-radius:8px; padding:12px; margin-bottom:12px; }
.wmap .grp h2 { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--mutedm); margin:0 0 10px; font-weight:700; }
.wmap .fld { margin-bottom:10px; } .wmap .fld:last-child { margin-bottom:0; }
.wmap .fld label { display:block; font-size:12px; margin-bottom:4px; font-weight:600; }
.wmap .fld input, .wmap .stp input { width:100%; padding:7px 9px; border:1px solid var(--linem); border-radius:6px; font-size:13px; }
.wmap .row2 { display:flex; gap:8px; } .wmap .row2>* { flex:1; }
.wmap .muted { font-weight:400; color:var(--mutedm); }
.wmap .hint, .wmap .note { font-size:11px; color:var(--mutedm); margin-top:6px; }
.wmap .stp { display:flex; }
.wmap .stp button { width:32px; border:1px solid var(--linem); background:var(--sandm); font-size:16px; cursor:pointer; color:var(--army); font-weight:700; }
.wmap .stp button:hover { background:var(--army); color:#fff; }
.wmap .stp input { border-radius:0; text-align:center; border-left:none; border-right:none; }
.wmap .stp button:first-child { border-radius:6px 0 0 6px; } .wmap .stp button:last-child { border-radius:0 6px 6px 0; }
.wmap .radios { display:flex; gap:6px; }
.wmap .radios button { flex:1; padding:6px; border:1px solid var(--linem); border-radius:6px; cursor:pointer; font-size:12px; font-weight:600; color:var(--mutedm); background:#fff; }
.wmap .radios button.on { background:var(--army); border-color:var(--army); color:#fff; }
.wmap .percol { display:flex; flex-wrap:wrap; gap:6px; }
.wmap .colst { display:flex; flex-direction:column; align-items:center; gap:2px; }
.wmap .cl { font-size:10px; font-weight:700; color:var(--army); }
.wmap .cc { display:flex; align-items:center; }
.wmap .cc button { width:20px; height:22px; border:1px solid var(--linem); background:var(--sandm); font-size:13px; line-height:1; cursor:pointer; color:var(--army); font-weight:700; padding:0; }
.wmap .cc button:hover { background:var(--army); color:#fff; }
.wmap .cc .v { width:24px; height:22px; display:flex; align-items:center; justify-content:center; border-top:1px solid var(--linem); border-bottom:1px solid var(--linem); font-size:12px; font-weight:700; }
.wmap .cc .v.custom { background:#fbeecd; color:var(--amberm); }
.wmap .btn { width:100%; padding:9px; border:none; border-radius:6px; cursor:pointer; font-weight:700; font-size:13px; margin-bottom:8px; }
.wmap .btn.primary { background:var(--army); color:#fff; } .wmap .btn.primary:hover { background:var(--army-dark); }
.wmap .btn.primary:disabled { background:#b9c0ab; cursor:default; }
.wmap .btn.ghost { background:#fff; color:var(--army); border:1px solid var(--army); }
.wmap .btn.tiny { width:auto; padding:6px 12px; font-size:12px; margin:0; }
.wmap .rrow { display:flex; align-items:center; gap:6px; padding:5px 0; border-bottom:1px solid var(--linem); font-size:12px; }
.wmap .rrow:last-child { border-bottom:none; }
.wmap .rrow .nm { flex:1; font-weight:700; color:var(--army); }
.wmap .rrow .sz { color:var(--mutedm); font-size:11px; }
.wmap .rrow button { border:1px solid var(--linem); background:#fff; border-radius:4px; cursor:pointer; font-size:11px; padding:2px 6px; font-weight:700; }
.wmap .rrow .go:hover { background:var(--army); color:#fff; }
.wmap .rrow .ed { color:#1565c0; } .wmap .rrow .ed:hover { background:#1565c0; color:#fff; }
.wmap .rrow .rm { color:var(--hitm); } .wmap .rrow .rm:hover { background:var(--hitm); color:#fff; }
.wmap-main { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.wmap-bar { min-height:52px; flex-shrink:0; border-bottom:1px solid var(--linem); display:flex;
  align-items:center; gap:10px; padding:8px 14px; flex-wrap:wrap; }
.wmap .srch { flex:0 1 320px; min-width:200px; }
.wmap .srch input { width:100%; padding:7px 10px; border:1px solid var(--linem); border-radius:6px; font-size:13px; }
.wmap .snote { font-size:12px; color:var(--army); font-weight:600; }
.wmap .spacer { flex:1; }
.wmap .warn { font-size:11px; color:#a8791a; background:#fbeecd; padding:3px 8px; border-radius:10px; font-weight:700; }
.wmap .viewnote { padding:8px 14px; background:#fbeecd; border-bottom:1px solid var(--linem); font-size:12px; color:#7a5a12; }
.wmap-stage { flex:1 1 auto; min-height:0; overflow:auto; padding:30px;
  background:linear-gradient(var(--linem) 1px, transparent 1px) 0 0/26px 26px,
             linear-gradient(90deg, var(--linem) 1px, transparent 1px) 0 0/26px 26px, var(--sandm); }
.wmap-canvas { position:relative; min-width:2200px; min-height:1400px; }
.wmap .empty { color:var(--mutedm); text-align:center; margin-top:60px; }
.wmap .rack { position:absolute; }
.wmap .rbox { position:absolute; left:50%; top:50%; transform-origin:center center; }
.wmap .rhead { background:var(--army); color:#fff; font-weight:700; font-size:13px; padding:6px 10px;
  border-radius:6px 6px 0 0; display:flex; align-items:center; justify-content:center; gap:8px;
  user-select:none; position:relative; letter-spacing:.04em; }
.wmap .rhead .wh { font-size:10px; opacity:.75; font-weight:600; text-transform:uppercase; }
.wmap .grip { position:absolute; left:8px; opacity:.55; font-size:12px; }
.wmap .rdel, .wmap .rrot { position:absolute; top:50%; transform:translateY(-50%); width:18px; height:18px;
  background:rgba(255,255,255,.2); color:#fff; border:1px solid rgba(255,255,255,.5); border-radius:50%;
  cursor:pointer; font-size:11px; line-height:1; display:flex; align-items:center; justify-content:center;
  font-weight:700; padding:0; z-index:8; }
.wmap .rdel { right:6px; } .wmap .rrot { right:28px; }
.wmap .rdel:hover { background:var(--hitm); } .wmap .rrot:hover { background:var(--army-light); }
.wmap .axcol { display:grid; text-align:center; font-size:10px; color:var(--mutedm); font-weight:700; margin-bottom:3px; gap:2px; padding:0 4px; }
.wmap .axwrap { display:flex; }
.wmap .axrow { display:grid; gap:2px; margin-right:4px; padding:2px 0; }
.wmap .axrow div { display:flex; align-items:center; justify-content:flex-end; font-size:10px; color:var(--mutedm); font-weight:700; min-height:44px; }
.wmap .rgrid { display:grid; border:2px solid var(--army); border-top:none; border-radius:0 0 6px 6px;
  overflow:hidden; background:var(--army); gap:2px; padding:2px; }
.wmap .cell { background:#fff; min-width:54px; min-height:44px; display:flex; align-items:center;
  justify-content:center; font-size:12px; font-weight:600; position:relative; }
.wmap .cell.void { background:var(--sandm); box-shadow:inset 0 0 0 1px var(--linem); opacity:.5; }
.wmap .cell.unknown { background:#fdecea; color:#a33; }
.wmap .cell.hit { background:var(--hitm); color:#fff; }
.wmap .cell.item-hit { background:var(--amberm); color:#fff; }
.wmap .cell.dim { opacity:.3; }
.wmap .rz { position:absolute; background:var(--army-light); border:2px solid #fff; border-radius:4px;
  opacity:0; transition:opacity .12s; z-index:6; box-shadow:0 1px 3px rgba(0,0,0,.2); }
.wmap .rack:hover .rz { opacity:1; }
.wmap .rz.e { right:-6px; top:50%; transform:translateY(-50%); width:12px; height:34px; cursor:ew-resize; }
.wmap .rz.s { bottom:-6px; left:50%; transform:translateX(-50%); width:34px; height:12px; cursor:ns-resize; }
.wmap .rz.c { right:-7px; bottom:-7px; width:18px; height:18px; background:var(--army); cursor:nwse-resize; }
.wmap .compass { position:absolute; z-index:40; width:104px; text-align:center; cursor:grab; user-select:none; }
.wmap .compass svg { display:block; filter:drop-shadow(0 1px 3px rgba(0,0,0,.2)); }
.wmap .cbtns { display:flex; gap:4px; justify-content:center; margin-top:2px; opacity:0; transition:opacity .12s; }
.wmap .compass:hover .cbtns { opacity:1; }
.wmap .cbtns button { font-size:10px; padding:2px 7px; border:1px solid var(--linem); background:#fff;
  border-radius:4px; cursor:pointer; font-weight:700; color:var(--army); }
.wmap .wtabs { display:flex; align-items:center; gap:3px; padding:2px; background:var(--sandm);
  border:1px solid var(--linem); border-radius:8px; flex-shrink:0; }
.wmap .wtabs button { border:none; background:transparent; color:var(--mutedm);
  border-radius:6px; padding:5px 11px; cursor:pointer; font-size:12px; font-weight:700;
  white-space:nowrap; display:flex; align-items:center; gap:5px; line-height:1.2; }
.wmap .wtabs button:hover { background:#e6e3d6; color:var(--army); }
.wmap .wtabs button.on { background:var(--army); color:#fff; box-shadow:0 1px 2px rgba(0,0,0,.15); }
.wmap .wtabs .cnt { background:rgba(0,0,0,.12); border-radius:8px; padding:0 5px; font-size:10px; font-weight:700; }
.wmap .wtabs button.on .cnt { background:rgba(255,255,255,.28); }
.wmap .tabnote { font-size:11px; color:var(--mutedm); margin-left:8px; }
.wmap .tabhint { padding:7px 14px; background:#e8f0fb; border-bottom:1px solid var(--linem);
  font-size:12px; color:#1d4e89; display:flex; align-items:center; gap:8px; }
.wmap .tabhint button { background:#1565c0; color:#fff; border:none; border-radius:5px;
  padding:3px 10px; cursor:pointer; font-weight:700; font-size:11px; }
.wmap .quadlbl { position:absolute; font-size:15px; font-weight:800; color:var(--army);
  letter-spacing:.08em; background:#fff; border:1px solid var(--linem); border-radius:6px;
  padding:3px 12px; z-index:5; }
.wmap .cwh { font-size:10px; font-weight:800; color:var(--army); letter-spacing:.06em; margin-top:1px; }
.wmap .undobar { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#26281f;
  color:#fff; padding:10px 14px; border-radius:8px; display:flex; align-items:center; gap:14px;
  font-size:13px; z-index:9999; box-shadow:0 4px 14px rgba(0,0,0,.3); }
.wmap .undobar button { background:transparent; border:1px solid rgba(255,255,255,.5); color:#fff;
  border-radius:5px; padding:3px 12px; cursor:pointer; font-weight:700; font-size:12px; }
`;
