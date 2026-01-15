import { useState, useEffect } from 'react';
import { OrgDB as DB } from '../orgDb';

export default function AddInventory({ item, location, onClose, onSuccess }) {
  const [quantity, setQuantity] = useState(1);
  const [selectedLocation, setSelectedLocation] = useState(location?.id || '');
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const locs = await DB.getLocations();
      setLocations(locs);
    })();
  }, []);

  const handleAdd = async () => {
    if (!selectedLocation) {
      alert('Select a location');
      return;
    }

    setLoading(true);
    
    try {
      // Update location inventory
      await DB.updateCount(selectedLocation, item.id, quantity);
      
      // Update item stock
      const currentStock = item.stock || 0;
      await DB.updateItemStock(item.id, currentStock + quantity);
      
      // Log movement
      await DB.logMovement({
        itemId: item.id,
        itemName: item.name,
        fromLocation: null,
        toLocation: selectedLocation,
        quantity: quantity,
        type: 'ADD',
        timestamp: Date.now()
      });

      onSuccess?.();
      onClose();
    } catch (error) {
      alert('Failed to add inventory: ' + error.message);
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
        <h2 style={{marginBottom: 20}}>Add Inventory</h2>
        
        <div style={{marginBottom: 20}}>
          <p style={{fontWeight: 'bold', fontSize: 18}}>{item.name}</p>
          <p style={{color: '#666'}}>Part #: {item.partNumber}</p>
          <p style={{color: '#666'}}>Current Stock: {item.stock || 0}</p>
        </div>

        <label style={{display: 'block', marginBottom: 10, fontWeight: 600}}>
          Quantity to Add
        </label>
        <input
          type="number"
          className="form-input"
          value={quantity}
          onChange={e => setQuantity(parseInt(e.target.value) || 0)}
          min="1"
          style={{marginBottom: 20}}
        />

        <label style={{display: 'block', marginBottom: 10, fontWeight: 600}}>
          Location
        </label>
        <select
          className="form-input"
          value={selectedLocation}
          onChange={e => setSelectedLocation(e.target.value)}
          style={{marginBottom: 20}}
        >
          <option value="">Select location...</option>
          {locations.map(loc => (
            <option key={loc.id} value={loc.id}>
              {loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}${loc.shelf}`}
            </option>
          ))}
        </select>

        <div style={{display: 'flex', gap: 10}}>
          <button
            className="btn btn-primary"
            onClick={handleAdd}
            disabled={loading}
            style={{flex: 1}}
          >
            {loading ? 'Adding...' : 'Add Inventory'}
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
