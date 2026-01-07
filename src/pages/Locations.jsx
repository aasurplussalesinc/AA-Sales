import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { DB } from '../db';

export default function Locations() {
  const [locations, setLocations] = useState([]);
  const [newLocation, setNewLocation] = useState({ warehouse: 'W1', rack: '1', letter: 'A', shelf: '1' });
  const [items, setItems] = useState([]);
  const [viewingLocation, setViewingLocation] = useState(null);
  const [saving, setSaving] = useState(false);

  // Dropdown options
  const warehouses = ['W1', 'W2', 'W3', 'W4'];
  const racks = ['1', '2', '3'];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const shelves = ['1', '2', '3'];

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const [locs, itms] = await Promise.all([
      DB.getLocations(),
      DB.getItems()
    ]);
    
    locs.sort((a, b) => {
      if (a.warehouse !== b.warehouse) return a.warehouse.localeCompare(b.warehouse);
      if (a.rack !== b.rack) return a.rack.localeCompare(b.rack);
      if (a.letter !== b.letter) return a.letter.localeCompare(b.letter);
      return a.shelf.localeCompare(b.shelf);
    });
    
    setLocations(locs);
    setItems(itms);
  };

  // Format location code for display
  const formatLocation = (loc) => {
    return `${loc.warehouse}-R${loc.rack}-${loc.letter}-${loc.shelf}`;
  };

  const addLocation = async () => {
    if (!newLocation.warehouse || !newLocation.rack || !newLocation.letter || !newLocation.shelf) {
      alert('Fill all fields');
      return;
    }

    const locationCode = `${newLocation.warehouse}-R${newLocation.rack}-${newLocation.letter}-${newLocation.shelf}`;
    
    // Check for duplicate
    const exists = locations.find(loc => loc.locationCode === locationCode);
    if (exists) {
      alert(`Location ${locationCode} already exists!`);
      return;
    }
    
    const qrCode = `LOC-${locationCode}-${Date.now()}`;
    
    setSaving(true);
    try {
      await DB.createLocation({
        ...newLocation,
        locationCode,
        qrCode,
        inventory: {}
      });

      // Reset form and reload
      setNewLocation({ warehouse: 'W1', rack: '1', letter: 'A', shelf: '1' });
      await loadData();
      alert(`Location ${locationCode} created successfully!`);
    } catch (error) {
      console.error('Error creating location:', error);
      alert('Error creating location: ' + error.message);
    } finally {
      setSaving(false);
    }
  };

  const getCurrentQty = (loc) => {
    if (!loc.inventory) return 0;
    return Object.values(loc.inventory).reduce((sum, qty) => sum + qty, 0);
  };

  const getLocationItems = (loc) => {
    if (!loc.inventory) return [];
    const locationItems = [];
    for (const [itemId, quantity] of Object.entries(loc.inventory)) {
      if (quantity > 0) {
        const item = items.find(i => i.id === itemId);
        if (item) {
          locationItems.push({ ...item, quantity });
        }
      }
    }
    return locationItems;
  };

  const viewLocation = (loc) => {
    setViewingLocation(loc);
  };

  const deleteLocation = async (loc) => {
    const qty = getCurrentQty(loc);
    if (qty > 0) {
      alert(`Cannot delete location ${formatLocation(loc)} - it still has ${qty} items. Move or remove items first.`);
      return;
    }
    
    if (!confirm(`Delete location ${formatLocation(loc)}?`)) return;
    
    await DB.deleteLocation(loc.id);
    loadData();
  };

  const printLocationQRCodes = async (location) => {
    try {
      // Get all items in this location
      const itemsInLocation = [];
      if (location.inventory) {
        for (const [itemId, quantity] of Object.entries(location.inventory)) {
          if (quantity > 0) {
            const item = items.find(i => i.id === itemId);
            if (item) {
              itemsInLocation.push({ item, quantity });
            }
          }
        }
      }

      if (itemsInLocation.length === 0) {
        alert('No items in this location to print');
        return;
      }

      // Generate QR codes for all items
      const qrPromises = itemsInLocation.map(async ({ item, quantity }) => {
        const qrData = item.partNumber || item.id;
        const qrImage = await QRCode.toDataURL(qrData, { width: 300 });
        return { item, quantity, qrImage };
      });

      const qrCodes = await Promise.all(qrPromises);
      const locCode = formatLocation(location);

      // Create print window with all QR codes
      const printWindow = window.open('', '_blank');
      printWindow.document.write(`
        <html>
          <head>
            <title>QR Codes - ${locCode}</title>
            <style>
              body {
                font-family: Arial, sans-serif;
                padding: 20px;
              }
              .header {
                text-align: center;
                margin-bottom: 30px;
                page-break-after: avoid;
              }
              .qr-grid {
                display: grid;
                grid-template-columns: repeat(2, 1fr);
                gap: 30px;
                page-break-inside: avoid;
              }
              .qr-item {
                border: 2px solid #000;
                padding: 15px;
                text-align: center;
                page-break-inside: avoid;
              }
              .qr-item h3 {
                margin: 0 0 10px 0;
                font-size: 16px;
              }
              .qr-item img {
                width: 200px;
                height: 200px;
                border: 1px solid #ddd;
              }
              .qr-item .info {
                margin-top: 10px;
                font-size: 12px;
                color: #666;
              }
              .qr-item .quantity {
                font-weight: bold;
                color: #2d5f3f;
                margin-top: 5px;
              }
              @media print {
                .qr-grid {
                  grid-template-columns: repeat(2, 1fr);
                }
              }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>Location: ${locCode}</h1>
              <p>Total Items: ${itemsInLocation.length} | Total Quantity: ${getCurrentQty(location)}</p>
            </div>
            <div class="qr-grid">
              ${qrCodes.map(({ item, quantity, qrImage }) => `
                <div class="qr-item">
                  <h3>${item.name}</h3>
                  <img src="${qrImage}" />
                  <div class="info">Part #: ${item.partNumber}</div>
                  <div class="quantity">Qty: ${quantity}</div>
                </div>
              `).join('')}
            </div>
          </body>
        </html>
      `);
      printWindow.document.close();
      
      // Auto-print after a short delay
      setTimeout(() => {
        printWindow.print();
      }, 500);
    } catch (error) {
      alert('Print failed: ' + error.message);
    }
  };

  return (
    <div className="page-content">
      <div style={{background: 'white', padding: 20, borderRadius: 8, marginBottom: 20}}>
        <h3 style={{marginBottom: 15}}>Add New Location</h3>
        <div className="form-row">
          <select
            className="form-input"
            value={newLocation.warehouse}
            onChange={e => setNewLocation({...newLocation, warehouse: e.target.value})}
          >
            {warehouses.map(w => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
          <select
            className="form-input"
            value={newLocation.rack}
            onChange={e => setNewLocation({...newLocation, rack: e.target.value})}
          >
            {racks.map(r => (
              <option key={r} value={r}>Rack {r}</option>
            ))}
          </select>
          <select
            className="form-input"
            value={newLocation.letter}
            onChange={e => setNewLocation({...newLocation, letter: e.target.value})}
          >
            {letters.map(l => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          <select
            className="form-input"
            value={newLocation.shelf}
            onChange={e => setNewLocation({...newLocation, shelf: e.target.value})}
          >
            {shelves.map(s => (
              <option key={s} value={s}>Shelf {s}</option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={addLocation} disabled={saving}>
            {saving ? 'Adding...' : '+ Add Location'}
          </button>
        </div>
        <div style={{marginTop: 10, padding: 10, background: '#f0f0f0', borderRadius: 4, textAlign: 'center'}}>
          <strong>Preview: </strong>
          <span style={{fontSize: 18, color: '#2d5f3f'}}>
            {newLocation.warehouse}-R{newLocation.rack}-{newLocation.letter}-{newLocation.shelf}
          </span>
        </div>
      </div>

      <div style={{background: 'white', padding: 20, borderRadius: 8}}>
        <h3 style={{marginBottom: 15}}>Total Locations: {locations.length}</h3>
        <div className="data-table">
          <table>
            <thead>
              <tr>
                <th>Location</th>
                <th>Warehouse</th>
                <th>Rack</th>
                <th>Letter</th>
                <th>Shelf</th>
                <th>Current Qty</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {locations.map(loc => (
                <tr key={loc.id}>
                  <td><strong>{formatLocation(loc)}</strong></td>
                  <td>{loc.warehouse}</td>
                  <td>{loc.rack}</td>
                  <td>{loc.letter}</td>
                  <td>{loc.shelf}</td>
                  <td>{getCurrentQty(loc)}</td>
                  <td>
                    <div className="action-buttons">
                      <button 
                        className="btn btn-primary btn-sm"
                        onClick={() => printLocationQRCodes(loc)}
                        title="Print all QR codes for this location"
                      >
                        🖨️ Print All
                      </button>
                      <button 
                        className="btn btn-primary btn-sm"
                        onClick={() => viewLocation(loc)}
                      >
                        View
                      </button>
                      <button 
                        className="btn btn-danger btn-sm"
                        onClick={() => deleteLocation(loc)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {locations.length === 0 && (
            <div className="empty-state">
              <p>No locations added yet. Create your first location above.</p>
            </div>
          )}
        </div>
      </div>

      {/* View Location Modal */}
      {viewingLocation && (
        <div className="modal-overlay" onClick={() => setViewingLocation(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <div className="modal-header">
              <h2>Location: {formatLocation(viewingLocation)}</h2>
              <button className="modal-close" onClick={() => setViewingLocation(null)}>×</button>
            </div>
            <div className="modal-body">
              <div style={{ marginBottom: 15 }}>
                <strong>Warehouse:</strong> {viewingLocation.warehouse} | 
                <strong> Rack:</strong> {viewingLocation.rack} | 
                <strong> Letter:</strong> {viewingLocation.letter} | 
                <strong> Shelf:</strong> {viewingLocation.shelf}
              </div>
              
              <h3 style={{ marginBottom: 10 }}>Items in this Location ({getCurrentQty(viewingLocation)} total)</h3>
              
              {getLocationItems(viewingLocation).length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f5f5f5' }}>
                      <th style={{ padding: 10, textAlign: 'left', borderBottom: '2px solid #ddd' }}>SKU</th>
                      <th style={{ padding: 10, textAlign: 'left', borderBottom: '2px solid #ddd' }}>Item Name</th>
                      <th style={{ padding: 10, textAlign: 'right', borderBottom: '2px solid #ddd' }}>Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {getLocationItems(viewingLocation).map(item => (
                      <tr key={item.id}>
                        <td style={{ padding: 10, borderBottom: '1px solid #eee' }}>{item.partNumber || '-'}</td>
                        <td style={{ padding: 10, borderBottom: '1px solid #eee' }}>{item.name}</td>
                        <td style={{ padding: 10, borderBottom: '1px solid #eee', textAlign: 'right' }}>{item.quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p style={{ color: '#666', fontStyle: 'italic' }}>No items in this location</p>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setViewingLocation(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
