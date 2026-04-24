import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { OrgDB as DB } from '../orgDb';
import { useAuth } from '../OrgAuthContext';

export default function Locations() {
  const { userRole, organization } = useAuth();
  const isAdmin = userRole === 'admin';
  const isManager = userRole === 'manager';
  const canEdit = isAdmin || isManager;
  
  const [locations, setLocations] = useState([]);
  const [newLocation, setNewLocation] = useState({ warehouse: 'W1', rack: '1', letter: 'A', shelf: '1' });
  const [items, setItems] = useState([]);
  const [viewingLocation, setViewingLocation] = useState(null);
  const [editingLocation, setEditingLocation] = useState(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selectedLocations, setSelectedLocations] = useState([]);
  const [sortBy, setSortBy] = useState('warehouse'); // warehouse, rack, letter, shelf
  const [filters, setFilters] = useState({ warehouse: '', rack: '', letter: '', search: '' });
  const fileInputRef = useRef(null);

  // Location schema from org settings (falls back to default)
  const locSchema = organization?.locationSchema || {
    levels: [
      { name: 'Warehouse', key: 'warehouse', options: ['W1', 'W2', 'W3', 'W4'] },
      { name: 'Rack',      key: 'rack',      options: ['1', '2', '3', '4', '5'] },
      { name: 'Bay',       key: 'letter',    options: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') },
      { name: 'Shelf',     key: 'shelf',     options: ['1', '2', '3', '4', '5'] },
    ]
  };

  // Keep backward-compat aliases
  const warehouses = locSchema.levels[0]?.options || ['W1'];
  const racks      = locSchema.levels[1]?.options || ['1'];
  const letters    = locSchema.levels[2]?.options || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const shelves    = locSchema.levels[3]?.options || ['1'];

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const [locs, itms] = await Promise.all([
      DB.getLocations(),
      DB.getItems()
    ]);
    
    setLocations(locs);
    setItems(itms);
  };

  // Get unique values from existing locations for filter dropdowns
  const uniqueWarehouses = [...new Set(locations.map(l => l.warehouse).filter(Boolean))].sort();
  const uniqueRacks = [...new Set(locations.map(l => l.rack).filter(Boolean))].sort();
  const uniqueLetters = [...new Set(locations.map(l => l.letter).filter(Boolean))].sort();

  // Filter locations
  const filteredLocations = locations.filter(loc => {
    if (filters.warehouse && loc.warehouse !== filters.warehouse) return false;
    if (filters.rack && loc.rack !== filters.rack) return false;
    if (filters.letter && loc.letter !== filters.letter) return false;
    if (filters.search) {
      const locCode = formatLocation(loc).toLowerCase();
      if (!locCode.includes(filters.search.toLowerCase())) return false;
    }
    return true;
  });

  // Sort filtered locations based on sortBy
  const sortedLocations = [...filteredLocations].sort((a, b) => {
    const aWarehouse = a.warehouse || '';
    const bWarehouse = b.warehouse || '';
    const aRack = a.rack || '';
    const bRack = b.rack || '';
    const aLetter = a.letter || '';
    const bLetter = b.letter || '';
    const aShelf = a.shelf || '';
    const bShelf = b.shelf || '';
    
    switch (sortBy) {
      case 'rack':
        if (aRack !== bRack) return aRack.localeCompare(bRack);
        if (aWarehouse !== bWarehouse) return aWarehouse.localeCompare(bWarehouse);
        if (aLetter !== bLetter) return aLetter.localeCompare(bLetter);
        return aShelf.localeCompare(bShelf);
      case 'letter':
        if (aLetter !== bLetter) return aLetter.localeCompare(bLetter);
        if (aWarehouse !== bWarehouse) return aWarehouse.localeCompare(bWarehouse);
        if (aRack !== bRack) return aRack.localeCompare(bRack);
        return aShelf.localeCompare(bShelf);
      case 'shelf':
        if (aShelf !== bShelf) return aShelf.localeCompare(bShelf);
        if (aWarehouse !== bWarehouse) return aWarehouse.localeCompare(bWarehouse);
        if (aRack !== bRack) return aRack.localeCompare(bRack);
        return aLetter.localeCompare(bLetter);
      case 'warehouse':
      default:
        if (aWarehouse !== bWarehouse) return aWarehouse.localeCompare(bWarehouse);
        if (aRack !== bRack) return aRack.localeCompare(bRack);
        if (aLetter !== bLetter) return aLetter.localeCompare(bLetter);
        return aShelf.localeCompare(bShelf);
    }
  });

  // Format location code for display
  const formatLocation = (loc) => {
    return `${loc.warehouse}-R${loc.rack}-${loc.letter}${loc.shelf}`;
  };

  const addLocation = async () => {
    if (!newLocation.warehouse || !newLocation.rack || !newLocation.letter || !newLocation.shelf) {
      alert('Fill all fields');
      return;
    }

    const locationCode = `${newLocation.warehouse}-R${newLocation.rack}-${newLocation.letter}${newLocation.shelf}`;
    
    // Check for duplicate
    const exists = locations.find(loc => loc.locationCode === locationCode);
    if (exists) {
      alert(`Location ${locationCode} already exists!`);
      return;
    }
    
    if (!confirm(`Add new location: ${locationCode}?`)) return;
    
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

  const openEditLocation = (loc) => {
    setEditingLocation({
      ...loc,
      warehouse: loc.warehouse || 'W1',
      rack: loc.rack || '1',
      letter: loc.letter || 'A',
      shelf: loc.shelf || '1'
    });
  };

  const saveEditLocation = async () => {
    if (!editingLocation) return;
    
    const newLocationCode = `${editingLocation.warehouse}-R${editingLocation.rack}-${editingLocation.letter}${editingLocation.shelf}`;
    
    // Check for duplicate (excluding current location)
    const exists = locations.find(loc => 
      loc.id !== editingLocation.id && loc.locationCode === newLocationCode
    );
    if (exists) {
      alert(`Location ${newLocationCode} already exists!`);
      return;
    }
    
    if (!confirm(`Update location from ${editingLocation.locationCode || 'Unknown'} to ${newLocationCode}?`)) return;
    
    setSaving(true);
    try {
      await DB.updateLocation(editingLocation.id, {
        warehouse: editingLocation.warehouse,
        rack: editingLocation.rack,
        letter: editingLocation.letter,
        shelf: editingLocation.shelf,
        locationCode: newLocationCode
      });
      setEditingLocation(null);
      await loadData();
      alert('Location updated successfully!');
    } catch (error) {
      console.error('Error updating location:', error);
      alert('Error updating location: ' + error.message);
    } finally {
      setSaving(false);
    }
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

  // Selection functions
  const toggleSelectLocation = (id) => {
    setSelectedLocations(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const selectAllLocations = () => {
    setSelectedLocations(sortedLocations.map(loc => loc.id));
  };

  const clearSelection = () => {
    setSelectedLocations([]);
  };

  const deleteSelectedLocations = async () => {
    if (selectedLocations.length === 0) return;
    
    // Check if any selected locations have inventory
    const locationsWithInventory = locations.filter(loc => 
      selectedLocations.includes(loc.id) && getCurrentQty(loc) > 0
    );
    
    if (locationsWithInventory.length > 0) {
      alert(`Cannot delete ${locationsWithInventory.length} location(s) that still have inventory. Remove items first.`);
      return;
    }
    
    if (!confirm(`Delete ${selectedLocations.length} selected location(s)?`)) return;
    
    try {
      let deleted = 0;
      for (const id of selectedLocations) {
        try {
          await DB.deleteLocation(id);
          deleted++;
        } catch (err) {
          console.error('Error deleting location:', id, err);
        }
      }
      
      alert(`Successfully deleted ${deleted} location(s)`);
      setSelectedLocations([]);
      await loadData();
    } catch (error) {
      console.error('Bulk delete error:', error);
      alert('Error deleting locations: ' + error.message);
    }
  };

  const handleImportCSV = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    setImporting(true);
    try {
      const text = await file.text();
      const lines = text.split('\n').filter(line => line.trim());
      
      // Skip header row
      const dataLines = lines.slice(1);
      
      let added = 0;
      let skipped = 0;
      
      for (const line of dataLines) {
        // Parse CSV (handle quoted values)
        const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
        const cleanValues = values.map(v => v.replace(/^"|"$/g, '').trim());
        
        // Expected format: Warehouse, Rack, Letter, Shelf (or LocationCode)
        // Try to detect format
        if (cleanValues.length >= 4) {
          // Format: Warehouse, Rack, Letter, Shelf
          let [warehouse, rack, letter, shelf] = cleanValues;
          
          // Strip "R" prefix from rack if present (e.g., "R1" -> "1")
          rack = rack.replace(/^R/i, '');
          
          const locationCode = `${warehouse}-R${rack}-${letter}${shelf}`;
          
          // Check if exists
          const exists = locations.find(loc => loc.locationCode === locationCode);
          if (exists) {
            skipped++;
            continue;
          }
          
          const qrCode = `LOC-${locationCode}-${Date.now()}`;
          await DB.createLocation({
            warehouse,
            rack,
            letter,
            shelf,
            locationCode,
            qrCode,
            inventory: {}
          });
          added++;
        } else if (cleanValues.length >= 1) {
          // Format: LocationCode (e.g., W1-R1-A1)
          const locationCode = cleanValues[0];
          const match = locationCode.match(/^(\w+)-R(\d+)-([A-Z])(\d+)$/);
          
          if (match) {
            const [, warehouse, rack, letter, shelf] = match;
            
            // Check if exists
            const exists = locations.find(loc => loc.locationCode === locationCode);
            if (exists) {
              skipped++;
              continue;
            }
            
            const qrCode = `LOC-${locationCode}-${Date.now()}`;
            await DB.createLocation({
              warehouse,
              rack,
              letter,
              shelf,
              locationCode,
              qrCode,
              inventory: {}
            });
            added++;
          } else {
            skipped++;
          }
        }
      }
      
      await loadData();
      alert(`Import complete!\n\nAdded: ${added} locations\nSkipped (duplicates or invalid): ${skipped}`);
    } catch (error) {
      console.error('Import error:', error);
      alert('Import failed: ' + error.message);
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  };

  const exportLocationsCSV = () => {
    const headers = ['LocationCode', 'Warehouse', 'Rack', 'Letter', 'Shelf', 'ItemCount'];
    const rows = locations.map(loc => [
      loc.locationCode || '',
      loc.warehouse || '',
      loc.rack || '',
      loc.letter || '',
      loc.shelf || '',
      getCurrentQty(loc)
    ]);
    
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `locations-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadTemplate = () => {
    const template = `Warehouse,Rack,Letter,Shelf
W1,1,A,1
W1,1,A,2
W1,1,B,1
W2,2,C,3`;
    const blob = new Blob([template], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'locations-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Print single location QR code (for scanning to see what's at this location)
  const printSingleLocationQR = async (location) => {
    try {
      const locCode = formatLocation(location);
      const qrData = `LOC:${locCode}`; // Prefix with LOC: to identify as location
      const qrImage = await QRCode.toDataURL(qrData, { width: 400 });

      const printWindow = window.open('', '_blank');
      if (!printWindow) {
        alert('Please allow popups to print QR codes');
        return;
      }
      printWindow.document.write(`
        <html>
          <head>
            <title>Location QR - ${locCode}</title>
            <style>
              body {
                font-family: Arial, sans-serif;
                padding: 40px;
                text-align: center;
              }
              .label {
                border: 3px solid #000;
                padding: 30px;
                display: inline-block;
                max-width: 400px;
              }
              .location-code {
                font-size: 36px;
                font-weight: bold;
                margin-bottom: 20px;
                letter-spacing: 2px;
              }
              .qr-code img {
                width: 300px;
                height: 300px;
              }
              .scan-text {
                margin-top: 15px;
                font-size: 14px;
                color: #666;
              }
              .print-btn {
                margin-top: 20px;
                padding: 10px 30px;
                font-size: 16px;
                cursor: pointer;
              }
              @media print {
                body { padding: 20px; }
                .print-btn { display: none; }
              }
            </style>
          </head>
          <body>
            <div class="label">
              <div class="location-code">${locCode}</div>
              <div class="qr-code">
                <img src="${qrImage}" alt="Location QR" />
              </div>
              <div class="scan-text">Scan to view inventory at this location</div>
            </div>
            <br>
            <button class="print-btn" onclick="window.print()">🖨️ Print</button>
          </body>
        </html>
      `);
      printWindow.document.close();
    } catch (error) {
      console.error('Error printing location QR:', error);
      alert('Error generating QR code');
    }
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
                color: #0d7a52;
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
            <div style="text-align: center; margin-top: 30px;">
              <button onclick="window.print()" style="padding: 10px 30px; font-size: 16px; cursor: pointer;">🖨️ Print All</button>
            </div>
            <style>
              @media print {
                button { display: none; }
              }
            </style>
          </body>
        </html>
      `);
      printWindow.document.close();
    } catch (error) {
      alert('Print failed: ' + error.message);
    }
  };

  return (
    <div className="page-content">
      {/* Import/Export buttons */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 15, flexWrap: 'wrap' }}>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleImportCSV}
          accept=".csv"
          style={{ display: 'none' }}
        />
        {canEdit && (
          <button 
            className="btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            style={{ background: '#17a2b8', color: 'var(--text-on-dark)' }}
          >
            {importing ? '⏳ Importing...' : '📤 Import CSV'}
          </button>
        )}
        <button 
          className="btn btn-primary"
          onClick={exportLocationsCSV}
        >
          📥 Export CSV
        </button>
        <button 
          className="btn"
          onClick={downloadTemplate}
          style={{ background: 'var(--btn-secondary-bg)', color: 'var(--btn-secondary-color)' }}
        >
          📋 Download Template
        </button>
      </div>

      {canEdit && (
        <div style={{background: 'var(--bg-surface)', padding: 20, borderRadius: 8, marginBottom: 20}}>
          <h3 style={{marginBottom: 15}}>Add New Location</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {locSchema.levels.map((level, idx) => {
              const keys = ['warehouse', 'rack', 'letter', 'shelf'];
              const key = level.key || keys[idx];
              return (
                <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{
                    fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
                    textTransform: 'uppercase', letterSpacing: 0.5
                  }}>{level.name}</label>
                  <select
                    className="form-input"
                    value={newLocation[key] || level.options[0]}
                    onChange={e => setNewLocation({ ...newLocation, [key]: e.target.value })}
                    style={{ minWidth: 80 }}
                  >
                    {level.options.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </div>
              );
            })}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11, opacity: 0 }}>add</label>
              <button className="btn btn-primary" onClick={addLocation} disabled={saving}>
                {saving ? 'Adding...' : '+ Add Location'}
              </button>
            </div>
          </div>
          <div style={{marginTop: 10, padding: 10, background: 'var(--bg-surface-3)', borderRadius: 4, textAlign: 'center'}}>
            <strong>Preview: </strong>
            <span style={{fontSize: 18, color: 'var(--accent)'}}>
              {newLocation.warehouse}-R{newLocation.rack}-{newLocation.letter}{newLocation.shelf}
            </span>
          </div>
        </div>
      )}

      <div style={{background: 'var(--bg-surface)', padding: 20, borderRadius: 8}}>
        {/* Filters Row */}
        <div style={{ 
          display: 'flex', 
          gap: 15, 
          marginBottom: 20, 
          padding: 15, 
          background: 'var(--bg-surface-2)', 
          borderRadius: 8,
          flexWrap: 'wrap',
          alignItems: 'center'
        }}>
          <div style={{ fontWeight: 600, color: 'var(--accent)' }}>🔍 Filter:</div>
          
          <input
            type="text"
            placeholder="Search location..."
            value={filters.search}
            onChange={e => setFilters({ ...filters, search: e.target.value })}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              fontSize: 14,
              minWidth: 150
            }}
          />
          
          <select
            value={filters.warehouse}
            onChange={e => setFilters({ ...filters, warehouse: e.target.value })}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              fontSize: 14
            }}
          >
            <option value="">All Warehouses</option>
            {uniqueWarehouses.map(w => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
          
          <select
            value={filters.rack}
            onChange={e => setFilters({ ...filters, rack: e.target.value })}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              fontSize: 14
            }}
          >
            <option value="">All Racks</option>
            {uniqueRacks.map(r => (
              <option key={r} value={r}>R{r}</option>
            ))}
          </select>
          
          <select
            value={filters.letter}
            onChange={e => setFilters({ ...filters, letter: e.target.value })}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              fontSize: 14
            }}
          >
            <option value="">All Letters</option>
            {uniqueLetters.map(l => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          
          {(filters.warehouse || filters.rack || filters.letter || filters.search) && (
            <button
              onClick={() => setFilters({ warehouse: '', rack: '', letter: '', search: '' })}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: 'none',
                background: '#dc3545',
                color: 'var(--text-on-dark)',
                cursor: 'pointer',
                fontSize: 14
              }}
            >
              Clear Filters
            </button>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15, flexWrap: 'wrap', gap: 10 }}>
          <h3 style={{ margin: 0 }}>
            {filteredLocations.length === locations.length 
              ? `Total Locations: ${locations.length}`
              : `Showing ${filteredLocations.length} of ${locations.length} locations`
            }
          </h3>
          
          {/* Sort dropdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ fontWeight: 500, fontSize: 14 }}>Sort by:</label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                fontSize: 14
              }}
            >
              <option value="warehouse">Warehouse (W)</option>
              <option value="rack">Rack (R)</option>
              <option value="letter">Letter (A-Z)</option>
              <option value="shelf">Shelf (#)</option>
            </select>
          </div>
          
          {/* Bulk actions */}
          {selectedLocations.length > 0 && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ color: 'var(--text-muted)' }}>{selectedLocations.length} selected</span>
              <button 
                className="btn btn-danger btn-sm"
                onClick={deleteSelectedLocations}
              >
                🗑️ Delete Selected
              </button>
              <button 
                className="btn btn-sm"
                onClick={clearSelection}
                style={{ background: 'var(--btn-secondary-bg)', color: 'var(--btn-secondary-color)' }}
              >
                Clear
              </button>
            </div>
          )}
        </div>
        
        <div className="data-table">
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    checked={selectedLocations.length === sortedLocations.length && sortedLocations.length > 0}
                    onChange={(e) => e.target.checked ? selectAllLocations() : clearSelection()}
                  />
                </th>
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
              {sortedLocations.map(loc => (
                <tr 
                  key={loc.id} 
                  style={{ 
                    cursor: 'pointer',
                    background: selectedLocations.includes(loc.id) ? '#e3f2fd' : 'transparent'
                  }}
                  title="Click to view items"
                >
                  <td onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedLocations.includes(loc.id)}
                      onChange={() => toggleSelectLocation(loc.id)}
                    />
                  </td>
                  <td onClick={() => viewLocation(loc)}><strong>{formatLocation(loc)}</strong></td>
                  <td onClick={() => viewLocation(loc)}>{loc.warehouse || '-'}</td>
                  <td onClick={() => viewLocation(loc)}>{loc.rack || '-'}</td>
                  <td onClick={() => viewLocation(loc)}>{loc.letter || '-'}</td>
                  <td onClick={() => viewLocation(loc)}>{loc.shelf || '-'}</td>
                  <td onClick={() => viewLocation(loc)}>{getCurrentQty(loc)}</td>
                  <td onClick={e => e.stopPropagation()}>
                    <div className="action-buttons">
                      <button 
                        className="btn btn-sm"
                        onClick={() => printSingleLocationQR(loc)}
                        title="Print location QR code"
                        style={{ background: '#9c27b0', color: 'var(--text-on-dark)' }}
                      >
                        📍 QR
                      </button>
                      <button 
                        className="btn btn-primary btn-sm"
                        onClick={() => printLocationQRCodes(loc)}
                        title="Print all item QR codes at this location"
                      >
                        🖨️ Items
                      </button>
                      <button 
                        className="btn btn-primary btn-sm"
                        onClick={() => viewLocation(loc)}
                      >
                        View
                      </button>
                      {canEdit && (
                        <>
                          <button 
                            className="btn btn-sm"
                            onClick={() => openEditLocation(loc)}
                            style={{ background: '#ff9800', color: 'var(--text-on-dark)' }}
                          >
                            Edit
                          </button>
                          <button 
                            className="btn btn-danger btn-sm"
                            onClick={() => deleteLocation(loc)}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {sortedLocations.length === 0 && (
            <div className="empty-state">
              <p>No locations added yet. Create your first location above.</p>
            </div>
          )}
        </div>
      </div>

      {/* View Location Modal */}
      {/* View Location Popup */}
      {viewingLocation && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999
          }}
          onClick={() => setViewingLocation(null)}
        >
          <div 
            onClick={e => e.stopPropagation()} 
            style={{ 
              background: 'var(--bg-surface)',
              borderRadius: 12,
              boxShadow: 'var(--shadow-modal)',
              width: '90%',
              maxWidth: 500,
              maxHeight: '80vh',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            {/* Header */}
            <div style={{ 
              background: 'var(--accent)',
              color: 'var(--text-on-accent)',
              padding: '14px 18px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              borderRadius: '12px 12px 0 0'
            }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                📍 {formatLocation(viewingLocation)}
              </h3>
              <button 
                onClick={() => setViewingLocation(null)}
                style={{ 
                  background: 'rgba(0,0,0,0.2)', 
                  border: 'none', 
                  color: 'var(--text-on-accent)', 
                  fontSize: 18,
                  width: 32, height: 32,
                  borderRadius: 8,
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700,
                  lineHeight: 1
                }}
              >
                ✕
              </button>
            </div>
            
            {/* Body */}
            <div style={{ padding: 15, overflowY: 'auto', flex: 1 }}>
              <div style={{ 
                marginBottom: 15, 
                padding: 10, 
                background: 'var(--bg-surface-2)', 
                borderRadius: 6,
                fontSize: 13
              }}>
                <strong>Warehouse:</strong> {viewingLocation.warehouse || '-'} | 
                <strong> Rack:</strong> {viewingLocation.rack || '-'} | 
                <strong> Letter:</strong> {viewingLocation.letter || '-'} | 
                <strong> Shelf:</strong> {viewingLocation.shelf || '-'}
              </div>
              
              <h4 style={{ margin: '0 0 10px 0', fontSize: 14 }}>
                Items in Location ({getCurrentQty(viewingLocation)} total)
              </h4>
              
              {getLocationItems(viewingLocation).length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-surface-2)' }}>
                      <th style={{ padding: 8, textAlign: 'left', borderBottom: '2px solid var(--border)' }}>SKU</th>
                      <th style={{ padding: 8, textAlign: 'left', borderBottom: '2px solid var(--border)' }}>Item Name</th>
                      <th style={{ padding: 8, textAlign: 'right', borderBottom: '2px solid var(--border)' }}>Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {getLocationItems(viewingLocation).map(item => (
                      <tr key={item.id}>
                        <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{item.partNumber || '-'}</td>
                        <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{item.name}</td>
                        <td style={{ padding: 8, borderBottom: '1px solid var(--border)', textAlign: 'right', fontWeight: 'bold' }}>{item.quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p style={{ color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center', padding: 20 }}>
                  No items in this location
                </p>
              )}
            </div>
            
            {/* Footer */}
            <div style={{ padding: 15, borderTop: '1px solid var(--border)' }}>
              <button 
                onClick={() => setViewingLocation(null)}
                style={{ 
                  width: '100%',
                  padding: '10px',
                  border: 'none',
                  borderRadius: 6,
                  background: 'var(--btn-primary-bg)',
                  color: 'var(--btn-primary-color)',
                  cursor: 'pointer',
                  fontWeight: 700,
                  fontSize: 14
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Location Modal */}
      {editingLocation && (
        <div className="modal-overlay" onClick={() => setEditingLocation(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div className="modal-header">
              <h3>Edit Location</h3>
              <button className="modal-close" onClick={() => setEditingLocation(null)}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: 15, color: 'var(--text-muted)' }}>
                Current: <strong>{editingLocation.locationCode || 'Unknown'}</strong>
              </p>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>
                <div>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Warehouse</label>
                  <select
                    className="form-input"
                    value={editingLocation.warehouse}
                    onChange={e => setEditingLocation({...editingLocation, warehouse: e.target.value})}
                    style={{ width: '100%' }}
                  >
                    {warehouses.map(w => (
                      <option key={w} value={w}>{w}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Rack</label>
                  <select
                    className="form-input"
                    value={editingLocation.rack}
                    onChange={e => setEditingLocation({...editingLocation, rack: e.target.value})}
                    style={{ width: '100%' }}
                  >
                    {racks.map(r => (
                      <option key={r} value={r}>Rack {r}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Letter</label>
                  <select
                    className="form-input"
                    value={editingLocation.letter}
                    onChange={e => setEditingLocation({...editingLocation, letter: e.target.value})}
                    style={{ width: '100%' }}
                  >
                    {letters.map(l => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Shelf</label>
                  <select
                    className="form-input"
                    value={editingLocation.shelf}
                    onChange={e => setEditingLocation({...editingLocation, shelf: e.target.value})}
                    style={{ width: '100%' }}
                  >
                    {shelves.map(s => (
                      <option key={s} value={s}>Shelf {s}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ marginTop: 15, padding: 10, background: 'var(--bg-badge-green)', borderRadius: 4, textAlign: 'center' }}>
                <strong>New Location Code: </strong>
                <span style={{ fontSize: 18, color: 'var(--accent)' }}>
                  {editingLocation.warehouse}-R{editingLocation.rack}-{editingLocation.letter}{editingLocation.shelf}
                </span>
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: 10 }}>
              <button 
                className="btn btn-primary" 
                onClick={saveEditLocation}
                disabled={saving}
                style={{ flex: 1 }}
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
              <button 
                className="btn btn-secondary" 
                onClick={() => setEditingLocation(null)}
                style={{ flex: 1 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
