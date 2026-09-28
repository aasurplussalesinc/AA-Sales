import { useState, useEffect } from 'react';
import { OrgDB as DB } from '../orgDb';

export default function PickInventory({ item, location, onClose, onSuccess }) {
  const [quantity, setQuantity] = useState(1);
  const [selectedLocation, setSelectedLocation] = useState(location?.id || '');
  const [locations, setLocations] = useState([]);
  const [currentQty, setCurrentQty] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  // What the item holds on a shelf, from the item's own `locations` (the
  // truth). This used to read the location document's retired inventory map,
  // which no longer tracks anything.
  const codeOf = (locs, locId) => {
    const l = (locs || []).find(x => x.id === locId);
    return l ? DB.canonicalLocationCode(DB.locationCodeOf(l)) : '';
  };
  const qtyAt = async (locs, locId) => {
    const code = codeOf(locs, locId);
    if (!code) return 0;
    const fresh = (await DB.getItem(item.id)) || item;
    const hit = DB.itemLocations(fresh).find(e => e.code === code);
    return hit ? hit.qty : 0;
  };

  const loadData = async () => {
    const locs = await DB.getLocations();
    setLocations(locs);

    if (selectedLocation) {
      setCurrentQty(await qtyAt(locs, selectedLocation));
    }
  };

  const handleLocationChange = async (locId) => {
    setSelectedLocation(locId);
    setCurrentQty(locId ? await qtyAt(locations, locId) : 0);
  };

  const handlePick = async () => {
    if (!selectedLocation) {
      alert('Select a location');
      return;
    }

    if (quantity <= 0) {
      alert('Enter a quantity greater than zero');
      return;
    }

    if (quantity > currentQty) {
      alert(`Cannot pick ${quantity}. Only ${currentQty} available at this location.`);
      return;
    }

    setLoading(true);
    
    try {
      // One shelf-aware write: the units come off this shelf, the total is
      // re-derived from the shelves, and one PICK movement is logged with
      // before/after. It used to write the retired location map and `stock`
      // separately, so the shelves never changed.
      const code = codeOf(locations, selectedLocation);
      const res = await DB.removeStockAtLocation(item.id, code, quantity, { note: 'Scanner pick' });
      if (!res) throw new Error('This item has no stock on any shelf');

      onSuccess?.();
      onClose();
    } catch (error) {
      alert('Failed to pick inventory: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2000,
      padding: 20
    }}>
      <div style={{
        background: 'white',
        borderRadius: 12,
        padding: 30,
        maxWidth: 500,
        width: '100%'
      }}>
        <h2 style={{marginBottom: 20}}>Pick Inventory</h2>
        
        <div style={{marginBottom: 20}}>
          <p style={{fontWeight: 'bold', fontSize: 18}}>{item.name}</p>
          <p style={{color: '#666'}}>Part #: {item.partNumber}</p>
          <p style={{color: '#666'}}>Total Stock: {item.stock || 0}</p>
        </div>

        <label style={{display: 'block', marginBottom: 10, fontWeight: 600}}>
          Pick From Location
        </label>
        <select
          className="form-input"
          value={selectedLocation}
          onChange={e => handleLocationChange(e.target.value)}
          style={{marginBottom: 10}}
        >
          <option value="">Select location...</option>
          {locations.map(loc => (
            <option key={loc.id} value={loc.id}>
              {loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}${loc.shelf}`}
            </option>
          ))}
        </select>

        {selectedLocation && (
          <p style={{color: '#0d7a52', fontWeight: 'bold', marginBottom: 20}}>
            Available at this location: {currentQty}
          </p>
        )}

        <label style={{display: 'block', marginBottom: 10, fontWeight: 600}}>
          Quantity to Pick
        </label>
        <input
          type="number"
          className="form-input"
          value={quantity}
          onChange={e => setQuantity(Number(e.target.value) || 0)}
          min="1"
          max={currentQty}
          style={{marginBottom: 20}}
        />

        <div style={{display: 'flex', gap: 10}}>
          <button
            className="btn btn-primary"
            onClick={handlePick}
            disabled={loading || !selectedLocation}
            style={{flex: 1}}
          >
            {loading ? 'Picking...' : 'Pick Inventory'}
          </button>
          <button
            className="btn"
            onClick={onClose}
            style={{flex: 1, background: '#6c757d', color: 'white'}}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
