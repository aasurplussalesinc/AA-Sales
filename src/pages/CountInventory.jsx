import { useState, useEffect } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { OrgDB as DB } from '../orgDb';

// Physical count of one shelf. NOTE: this page has no route in App.jsx today,
// so it is not reachable from the app; it is kept correct so it can be wired
// up. A saved count is AUTHORITATIVE: it sets the item's quantity on this
// shelf, the item total is re-derived from its shelves, and a COUNT movement
// is logged (see OrgDB.countItemAtShelf).
//
// Counts are drafts until "Save count" is pressed. The old page wrote on every
// keystroke and +/- click, starting from a retired per-location map, so typing
// "25" would have written 2 and then 25.
export default function CountInventory() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const loc = location.state?.location;
  const shelf = loc ? DB.canonicalLocationCode(DB.locationCodeOf(loc)) : '';

  const [search, setSearch] = useState('');
  const [allItems, setAllItems] = useState([]);
  const [items, setItems] = useState([]);
  const [saved, setSaved] = useState({});   // itemId -> qty on this shelf now
  const [drafts, setDrafts] = useState({}); // itemId -> counted qty (unsaved)
  const [busy, setBusy] = useState({});
  const [status, setStatus] = useState({});
  const [loading, setLoading] = useState(false);

  const qtyHere = (item) => {
    const hit = DB.itemLocations(item).find(e => e.code === shelf);
    return hit ? hit.qty : 0;
  };

  useEffect(() => {
    if (!shelf) return;
    (async () => {
      setLoading(true);
      const all = await DB.getItems();
      setAllItems(all);
      // Start with what the system says is on this shelf.
      const here = all.filter(i => qtyHere(i) > 0);
      setItems(here);
      setSaved(Object.fromEntries(here.map(i => [i.id, qtyHere(i)])));
      setLoading(false);
    })();
  }, [shelf]);

  const searchItems = () => {
    const s = search.trim().toLowerCase();
    if (!s) return;
    const found = allItems.filter(i =>
      String(i.partNumber || '').toLowerCase().includes(s) ||
      String(i.name || '').toLowerCase().includes(s));
    setItems(prev => {
      const ids = new Set(prev.map(i => i.id));
      return [...prev, ...found.filter(i => !ids.has(i.id))];
    });
    setSaved(prev => ({ ...Object.fromEntries(found.map(i => [i.id, qtyHere(i)])), ...prev }));
  };

  const current = (itemId) => (drafts[itemId] !== undefined ? drafts[itemId] : (saved[itemId] || 0));
  const setDraft = (itemId, v) => {
    const n = Math.max(0, Number(v) || 0);
    setDrafts(prev => ({ ...prev, [itemId]: Math.trunc(n) }));
  };

  const saveCount = async (item) => {
    const counted = current(item.id);
    setBusy(prev => ({ ...prev, [item.id]: true }));
    try {
      const res = await DB.updateCount(id, item.id, counted);
      setSaved(prev => ({ ...prev, [item.id]: res.shelfQty }));
      setDrafts(prev => { const n = { ...prev }; delete n[item.id]; return n; });
      setStatus(prev => ({
        ...prev,
        [item.id]: res.changed ? `Saved: ${res.shelfQty} here, item total ${res.stock}` : 'No change'
      }));
    } catch (error) {
      setStatus(prev => ({ ...prev, [item.id]: 'Not saved: ' + error.message }));
    } finally {
      setBusy(prev => ({ ...prev, [item.id]: false }));
    }
  };

  if (!loc) {
    return <div className="page"><div className="loading">Loading...</div></div>;
  }

  return (
    <div className="page">
      <div className="header">
        <h1>{shelf || `${loc.aisle} - ${loc.shelf} - ${loc.bin}`}</h1>
        <p>Count this shelf. Saving a count sets the item's quantity here.</p>
      </div>

      <div style={{display: 'flex', gap: 10, marginBottom: 15}}>
        <input
          type="text"
          className="input"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyPress={e => e.key === 'Enter' && searchItems()}
          placeholder="Add an item not listed here..."
          style={{marginTop: 0}}
        />
        <button className="btn" onClick={searchItems} style={{width: 'auto', minWidth: 80}}>
          🔍
        </button>
      </div>

      {loading && <div className="loading">Loading...</div>}

      {items.map(item => {
        const dirty = drafts[item.id] !== undefined && drafts[item.id] !== (saved[item.id] || 0);
        return (
          <div key={item.id} className="card">
            <div>
              <p style={{fontSize: 14, color: 'var(--text-muted)', fontWeight: 600}}>
                {item.partNumber}{item.grade ? ` · ${item.grade}` : ''}
              </p>
              <h3 style={{fontSize: 18, marginTop: 5}}>{item.name}</h3>
              <p style={{fontSize: 13, color: 'var(--text-muted)', marginTop: 5}}>
                System says {saved[item.id] || 0} here
              </p>
            </div>

            <div className="counter">
              <button className="counter-btn" onClick={() => setDraft(item.id, current(item.id) - 1)}>−</button>
              <input
                type="number"
                className="counter-input"
                value={current(item.id)}
                onChange={e => setDraft(item.id, e.target.value)}
              />
              <button className="counter-btn" onClick={() => setDraft(item.id, current(item.id) + 1)}>+</button>
            </div>

            <button
              className="btn btn-success"
              disabled={!!busy[item.id] || !dirty}
              onClick={() => saveCount(item)}
              style={{marginTop: 10}}
            >
              {busy[item.id] ? 'Saving...' : 'Save count'}
            </button>
            {status[item.id] && (
              <p style={{fontSize: 13, marginTop: 6, color: 'var(--text-muted)'}}>{status[item.id]}</p>
            )}
          </div>
        );
      })}

      {items.length === 0 && !loading && (
        <div className="card">
          <p style={{color: 'var(--text-muted)', textAlign: 'center'}}>
            Nothing recorded on this shelf. Search for items to count.
          </p>
        </div>
      )}

      <button
        className="btn btn-success"
        onClick={() => navigate('/locations')}
      >
        Done
      </button>
    </div>
  );
}
