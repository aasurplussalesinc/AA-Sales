import { useState, useEffect } from 'react';
import { DB } from '../db';

export default function PickInventory({ item, location, onClose, onSuccess }) {
  const [quantity, setQuantity] = useState(1);
  const [selectedLocation, setSelectedLocation] = useState(location?.id || '');
  const [locations, setLocations] = useState([]);
  const [currentQty, setCurrentQty] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const locs = await DB.getLocations();
    setLocations(locs);
    
    if (selectedLocation) {
      const inventory = await DB.getInventory(selectedLocation);
      setCurrentQty(inventory[item.id] || 0);
    }
  };

  const handleLocationChange = async (locId) => {
    setSelectedLocation(locId);
    if (locId) {
      const inventory = await DB.getInventory(locId);
      setCurrentQty(inventory[item.id] || 0);
    }
  };

  const handlePick = async () => {
    if (!selectedLocation) {
      alert('Select a location');
      return;
    }

    if (quantity > currentQty) {
      alert(`Cannot pick ${quantity}. Only ${currentQty} available at this location.`);
      return;
    }

    setLoading(true);
    
    try {
      const newQty = currentQty - quantity;
      
      // Update location inventory
      await DB.updateCount(selectedLocation, item.id, newQty);
      
      // Update item stock
      const currentStock = item.stock || 0;
      await DB.updateItemStock(item.id, Math.max(0, currentStock - quantity));
      
      // Log movement
      await DB.logMovement({
        itemId: item.id,
        itemName: item.name,
        fromLocation: selectedLocation,
        toLocation: null,
        quantity: quantity,
        type: 'PICK',
        timestamp: Date.now()
      });

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
              {loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}-${loc.shelf}`}
            </option>
          ))}
        </select>

        {selectedLocation && (
          <p style={{color: '#2d5f3f', fontWeight: 'bold', marginBottom: 20}}>
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
          onChange={e => setQuantity(parseInt(e.target.value) || 0)}
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
