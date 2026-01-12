import { useState, useEffect } from 'react';
import { OrgDB as DB } from '../orgDb';

export default function MoveLocation({ item, location, onClose, onSuccess }) {
  const [quantity, setQuantity] = useState(1);
  const [fromLocation, setFromLocation] = useState(location?.id || '');
  const [toLocation, setToLocation] = useState('');
  const [locations, setLocations] = useState([]);
  const [currentQty, setCurrentQty] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const locs = await DB.getLocations();
    setLocations(locs);
    
    if (fromLocation) {
      const inventory = await DB.getInventory(fromLocation);
      setCurrentQty(inventory[item.id] || 0);
    }
  };

  const handleFromChange = async (locId) => {
    setFromLocation(locId);
    if (locId) {
      const inventory = await DB.getInventory(locId);
      setCurrentQty(inventory[item.id] || 0);
    }
  };

  const handleMove = async () => {
    if (!fromLocation || !toLocation) {
      alert('Select both locations');
      return;
    }

    if (fromLocation === toLocation) {
      alert('Source and destination must be different');
      return;
    }

    if (quantity > currentQty) {
      alert(`Cannot move ${quantity}. Only ${currentQty} available.`);
      return;
    }

    setLoading(true);
    
    try {
      // Reduce from source location
      const newFromQty = currentQty - quantity;
      await DB.updateCount(fromLocation, item.id, newFromQty);
      
      // Add to destination location
      const toInventory = await DB.getInventory(toLocation);
      const currentToQty = toInventory[item.id] || 0;
      await DB.updateCount(toLocation, item.id, currentToQty + quantity);
      
      // Log movement
      const fromLoc = locations.find(l => l.id === fromLocation);
      const toLoc = locations.find(l => l.id === toLocation);
      
      await DB.logMovement({
        itemId: item.id,
        itemName: item.name,
        fromLocation: fromLoc.locationCode || `${fromLoc.warehouse}-R${fromLoc.rack}-${fromLoc.letter}-${fromLoc.shelf}`,
        toLocation: toLoc.locationCode || `${toLoc.warehouse}-R${toLoc.rack}-${toLoc.letter}-${toLoc.shelf}`,
        quantity: quantity,
        type: 'MOVE',
        timestamp: Date.now()
      });

      onSuccess?.();
      onClose();
    } catch (error) {
      alert('Failed to move inventory: ' + error.message);
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
        <h2 style={{marginBottom: 20}}>Move to New Location</h2>
        
        <div style={{marginBottom: 20}}>
          <p style={{fontWeight: 'bold', fontSize: 18}}>{item.name}</p>
          <p style={{color: '#666'}}>Part #: {item.partNumber}</p>
        </div>

        <label style={{display: 'block', marginBottom: 10, fontWeight: 600}}>
          From Location
        </label>
        <select
          className="form-input"
          value={fromLocation}
          onChange={e => handleFromChange(e.target.value)}
          style={{marginBottom: 10}}
        >
          <option value="">Select source...</option>
          {locations.map(loc => (
            <option key={loc.id} value={loc.id}>
              {loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}-${loc.shelf}`}
            </option>
          ))}
        </select>

        {fromLocation && (
          <p style={{color: '#2d5f3f', fontWeight: 'bold', marginBottom: 20}}>
            Available: {currentQty}
          </p>
        )}

        <label style={{display: 'block', marginBottom: 10, fontWeight: 600}}>
          Quantity to Move
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

        <label style={{display: 'block', marginBottom: 10, fontWeight: 600}}>
          To Location
        </label>
        <select
          className="form-input"
          value={toLocation}
          onChange={e => setToLocation(e.target.value)}
          style={{marginBottom: 20}}
        >
          <option value="">Select destination...</option>
          {locations.filter(l => l.id !== fromLocation).map(loc => (
            <option key={loc.id} value={loc.id}>
              {loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}-${loc.shelf}`}
            </option>
          ))}
        </select>

        <div style={{display: 'flex', gap: 10}}>
          <button
            className="btn btn-primary"
            onClick={handleMove}
            disabled={loading || !fromLocation || !toLocation}
            style={{flex: 1}}
          >
            {loading ? 'Moving...' : 'Move Inventory'}
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
