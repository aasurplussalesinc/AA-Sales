import { useState, useEffect } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { DB } from '../db';

export default function CountInventory() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const loc = location.state?.location;

  const [search, setSearch] = useState('');
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadInventory();
  }, []);

  const loadInventory = async () => {
    const inventory = await DB.getInventory(id);
    setCounts(inventory);
  };

  const searchItems = async () => {
    if (!search.trim()) return;
    setLoading(true);
    const results = await DB.searchItems(search);
    setItems(results);
    setLoading(false);
  };

  const updateCount = async (itemId, count) => {
    const newCount = parseInt(count) || 0;
    setCounts(prev => ({ ...prev, [itemId]: newCount }));
    
    try {
      await DB.updateCount(id, itemId, newCount);
    } catch (error) {
      // Queued for offline sync - show indicator
      console.log('Queued for sync:', error);
    }
  };

  const increment = (itemId) => {
    const current = counts[itemId] || 0;
    updateCount(itemId, current + 1);
  };

  const decrement = (itemId) => {
    const current = counts[itemId] || 0;
    if (current > 0) updateCount(itemId, current - 1);
  };

  if (!loc) {
    return <div className="page"><div className="loading">Loading...</div></div>;
  }

  return (
    <div className="page">
      <div className="header">
        <h1>{loc.aisle} - {loc.shelf} - {loc.bin}</h1>
        <p>Update inventory counts</p>
      </div>

      <div style={{display: 'flex', gap: 10, marginBottom: 15}}>
        <input
          type="text"
          className="input"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyPress={e => e.key === 'Enter' && searchItems()}
          placeholder="Search items..."
          style={{marginTop: 0}}
        />
        <button className="btn" onClick={searchItems} style={{width: 'auto', minWidth: 80}}>
          🔍
        </button>
      </div>

      {loading && <div className="loading">Searching...</div>}

      {items.map(item => (
        <div key={item.id} className="card">
          <div>
            <p style={{fontSize: 14, color: '#666', fontWeight: 600}}>
              {item.partNumber}
            </p>
            <h3 style={{fontSize: 18, marginTop: 5}}>{item.name}</h3>
            {item.price > 0 && (
              <p style={{fontSize: 14, color: '#4CAF50', marginTop: 5}}>
                ${item.price.toFixed(2)}
              </p>
            )}
          </div>

          <div className="counter">
            <button
              className="counter-btn"
              onClick={() => decrement(item.id)}
            >
              −
            </button>

            <input
              type="number"
              className="counter-input"
              value={counts[item.id] || 0}
              onChange={e => updateCount(item.id, e.target.value)}
            />

            <button
              className="counter-btn"
              onClick={() => increment(item.id)}
            >
              +
            </button>
          </div>
        </div>
      ))}

      {items.length === 0 && !loading && (
        <div className="card">
          <p style={{color: '#666', textAlign: 'center'}}>
            Search for items to count
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
