import { useState, useEffect, useRef, useMemo } from 'react';
import QRCode from 'qrcode';
import { OrgDB as DB } from '../orgDb';
import { useAuth } from '../OrgAuthContext';
import { useTier } from '../useTier';

export default function Locations() {
  const { userRole, organization } = useAuth();
  const tier = useTier();
  const isAdmin = userRole === 'admin';
  const isManager = userRole === 'manager';
  const canEdit = isAdmin || isManager;
  
  const [locations, setLocations] = useState([]);
  const [pendingDelete, setPendingDelete] = useState(null); // two-step delete guard
  const [newLocation, setNewLocation] = useState({ warehouse: 'W1', rack: '1', letter: 'A', shelf: '1' });
  const [items, setItems] = useState([]);
  const [viewingLocation, setViewingLocation] = useState(null);
  const [editingLocation, setEditingLocation] = useState(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selectedLocations, setSelectedLocations] = useState([]);
  // O(1) membership test — .includes() per row was scanning the whole array
  // for every one of the 400+ rows on each click, which caused a visible stall.
  const selectedSet = useMemo(() => new Set(selectedLocations), [selectedLocations]);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [sortBy, setSortBy] = useState('warehouse'); // warehouse, rack, letter, shelf
  const [filters, setFilters] = useState({ warehouse: '', rack: '', letter: '', search: '' });
  const fileInputRef = useRef(null);

  // Location schema from org settings (falls back to the shared default)
  const locSchema = organization?.locationSchema || DB.DEFAULT_LOCATION_SCHEMA;

  // Keep backward-compat aliases
  const warehouses = locSchema.levels[0]?.options || ['W1'];
  const racks      = locSchema.levels[1]?.options || ['1'];
  const letters    = locSchema.levels[2]?.options || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const shelves    = locSchema.levels[3]?.options || ['1'];

  useEffect(() => {
    loadData();
  }, []);

  // Seed the add-location form from whatever schema is active, so custom
  // level keys start with a real value instead of being undefined.
  useEffect(() => {
    setNewLocation(prev => {
      const seeded = { ...prev };
      locSchema.levels.forEach(lvl => {
        if (!seeded[lvl.key]) seeded[lvl.key] = (lvl.options && lvl.options[0]) || '';
      });
      return seeded;
    });
  }, [organization?.locationSchema]);

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

  // ---- Pagination: render a page at a time instead of all 400+ rows ----
  const totalPages = Math.max(1, Math.ceil(sortedLocations.length / perPage));
  const safePage = Math.min(page, totalPages);
  const pagedLocations = sortedLocations.slice((safePage - 1) * perPage, safePage * perPage);

  // If filters/sort shrink the list, don't strand the user on an empty page.
  useEffect(() => { setPage(1); }, [filters, sortBy, perPage]);


  // Format location code for display (uses the stored code when present, so
  // existing locations keep the format they were created with)
  // Canonical comparison so "W1-R1-A-1" and "W1-R1-A1" are recognised as the
  // SAME shelf. Exact string matching let both formats exist as separate
  // records for one physical location, which split inventory between them.
  const sameCode = (a, b) => {
    if (!a || !b) return false;
    const c = v => (DB.canonicalLocationCode ? DB.canonicalLocationCode(v) : String(v)).toUpperCase();
    return c(a) === c(b);
  };
  const findDuplicate = (code, excludeId) => locations.find(l => {
    if (excludeId && l.id === excludeId) return false;
    const raw = l.locationCode || `${l.warehouse}-R${l.rack}-${l.letter}${l.shelf}`;
    return sameCode(raw, code);
  });

  // One-time cleanup: canonicalise every location code and merge duplicates.
  const [repairing, setRepairing] = useState(false);
  const runAudit = async () => {
    if (repairing) return;
    setRepairing(true);
    try {
      const r = await DB.auditItemLocations();
      const fmt = (arr, n) => arr.slice(0, n).map(x =>
        `  ${x.sku || '(no sku)'} ${x.name}` +
        (x.sum !== undefined ? `\n     stock ${x.stock} vs shelves ${x.sum} (${x.spots})` : '') +
        (x.spots && x.sum === undefined ? `\n     unknown shelf: ${x.spots}` : '')
      ).join('\n');
      const clean = r.sumMismatch.length === 0 && r.unknownShelf.length === 0 && r.unplaced.length === 0;
      alert(
        'INVENTORY HEALTH CHECK (read-only)\n' +
        'One source of truth: quantities live on the item.\n\n' +
        (clean ? '✅ ALL CONSISTENT — nothing to fix.\n\n' : '') +
        `✅ Healthy items: ${r.ok}\n` +
        `⚪ No stock (untouched): ${r.noStock}\n` +
        `📋 Items with units in STAGING: ${r.staged} (${r.stagedUnits} units)\n\n` +
        `🔴 Stock ≠ sum of its shelves: ${r.sumMismatch.length}\n` +
        `🟠 Names a shelf that doesn't exist: ${r.unknownShelf.length}\n` +
        `🟡 Has stock but no shelf at all: ${r.unplaced.length}` +
        (r.sumMismatch.length ? `\n\n— Sum mismatches —\n${fmt(r.sumMismatch, 5)}` : '') +
        (r.unknownShelf.length ? `\n\n— Unknown shelves —\n${fmt(r.unknownShelf, 5)}` : '')
      );
    } catch (e) {
      alert('Audit failed: ' + (e.message || e));
    }
    setRepairing(false);
  };

  const formatLocation = (loc) => {
    if (loc.locationCode) return loc.locationCode;
    return DB.buildLocationCode(loc, locSchema);
  };

  const addLocation = async () => {
    // Every level defined by the org's schema must be filled
    const missing = locSchema.levels.filter(l => !newLocation[l.key]);
    if (missing.length > 0) {
      alert('Fill all fields: ' + missing.map(l => l.name).join(', '));
      return;
    }

    // ── Plan limits: total locations, and distinct top-level sites ──
    const locLimit = tier.checkLimit('locations', locations.length);
    if (!locLimit.ok) {
      alert(`Your ${tier.plan} plan includes ${locLimit.limit} locations (you have ${locLimit.used}).\n\nUpgrade to add more.`);
      return;
    }
    const topKey = locSchema.levels[0]?.key || 'warehouse';
    const existingTop = new Set(locations.map(l => l[topKey]).filter(Boolean));
    if (!existingTop.has(newLocation[topKey])) {
      const whLimit = tier.checkLimit('warehouses', existingTop.size);
      if (!whLimit.ok) {
        alert(`Your ${tier.plan} plan includes ${whLimit.limit} ${(locSchema.levels[0]?.name || 'Warehouse')}(s).\n\nUpgrade to add another.`);
        return;
      }
    }

    const locationCode = DB.buildLocationCode(newLocation, locSchema);
    
    // Check for duplicate
    const exists = findDuplicate(locationCode);
    if (exists) {
      alert(`Location ${locationCode} already exists (as "${exists.locationCode || formatLocation(exists)}").`);
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

  // DERIVED from items — the item owns its quantities, locations are metadata.
  const locationTotals = useMemo(() => DB.buildLocationTotals(items), [items]);
  const codeOf = (loc) => DB.canonicalLocationCode(
    loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}${loc.shelf}`
  );

  const getCurrentQty = (loc) => (locationTotals[codeOf(loc)]?.total) || 0;

  const getLocationItems = (loc) => {
    const entry = locationTotals[codeOf(loc)];
    if (!entry) return [];
    return entry.items.map(r => {
      const item = items.find(i => i.id === r.id);
      return { ...(item || {}), id: r.id, name: r.name, partNumber: r.sku, quantity: r.qty };
    });
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
    
    // Build from the org's schema (was hardcoded, which ignored custom nomenclature)
    const newLocationCode = DB.buildLocationCode(editingLocation, locSchema);
    
    // Check for duplicate (excluding current location)
    const exists = findDuplicate(newLocationCode, editingLocation.id);
    if (exists) {
      alert(`Location ${newLocationCode} already exists!`);
      return;
    }
    
    
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
    
    // window.confirm can be suppressed by the browser, which silently aborted
    // deletes. Use an explicit two-step click instead.
    if (pendingDelete !== loc.id) {
      setPendingDelete(loc.id);
      setTimeout(() => setPendingDelete(p => (p === loc.id ? null : p)), 4000);
      return;
    }
    setPendingDelete(null);
    
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
    // Scope to the page you're looking at — selecting 400 invisible rows is a trap
    setSelectedLocations(pagedLocations.map(loc => loc.id));
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
    
    if (pendingDelete !== '__bulk__') {
      setPendingDelete('__bulk__');
      setTimeout(() => setPendingDelete(p => (p === '__bulk__' ? null : p)), 4000);
      return;
    }
    setPendingDelete(null);
    
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
          
          // Use the org's schema so bulk-generate matches single-add exactly
          const locationCode = DB.buildLocationCode({ warehouse, rack, letter, shelf }, locSchema);
          
          // Check if exists
          const exists = findDuplicate(locationCode);
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
            const exists = findDuplicate(locationCode);
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

  // ── Print an entire column: one 4x6 sheet per shelf, max 6 items a sheet ──
  const printColumn = async () => {
    const wh = filters.warehouse, rk = filters.rack, col = filters.letter;
    if (!wh || !rk || !col) {
      alert('Choose a Warehouse, Rack and Letter above, then print the column.');
      return;
    }

    // Shelves in this column, in natural order (1, 2, 10 — not 1, 10, 2)
    const shelves = locations
      .filter(l => l.warehouse === wh && l.rack === rk && l.letter === col)
      .sort((a, b) => String(a.shelf).localeCompare(String(b.shelf), undefined, { numeric: true }));

    if (!shelves.length) { alert(`No shelves found in ${wh}-R${rk}-${col}.`); return; }

    const PER_SHEET = 6;
    const sheets = [];

    for (const loc of shelves) {
      const rows = getLocationItems(loc).filter(r => (parseInt(r.quantity) || 0) > 0);
      if (!rows.length) continue;                    // empty shelves are skipped
      const code = formatLocation(loc);
      const totalQty = rows.reduce((sum, r) => sum + (parseInt(r.quantity) || 0), 0);
      const chunks = [];
      for (let i = 0; i < rows.length; i += PER_SHEET) chunks.push(rows.slice(i, i + PER_SHEET));
      chunks.forEach((chunk, idx) => {
        sheets.push({
          code, rows: chunk, itemCount: rows.length, totalQty,
          part: idx + 1, parts: chunks.length
        });
      });
    }

    if (!sheets.length) { alert(`Nothing stored in column ${wh}-R${rk}-${col}.`); return; }

    // QR per item, sized to how it will be printed
    for (const sheet of sheets) {
      for (const r of sheet.rows) {
        const data = r.partNumber || r.id;
        r.qr = await QRCode.toDataURL(data, { width: sheet.rows.length === 1 ? 600 : 220, margin: 1 });
      }
    }

    const printed = new Date().toLocaleDateString();
    const win = window.open('', '_blank');
    win.document.write(`
      <html>
        <head>
          <title>Column ${wh}-R${rk}-${col}</title>
          <style>
              @page { size: 4in 6in; margin: 0; }
              * { box-sizing: border-box; }
              body {
                margin: 0; padding: 0;
                font-family: Arial, Helvetica, sans-serif;
                -webkit-print-color-adjust: exact;
              }
              .label {
                width: 4in; height: 6in;
                padding: 0.18in 0.16in;
                display: flex; flex-direction: column;
                align-items: center; justify-content: flex-start;
                text-align: center;
                page-break-after: always;
                break-after: page;
                overflow: hidden;
              }
              .label:last-child { page-break-after: auto; break-after: auto; }
              .l-loc {
                font-size: 30px; font-weight: 900; letter-spacing: .02em;
                line-height: 1.05; margin-bottom: 2px; word-break: break-word;
              }
              .l-name {
                font-size: 15px; font-weight: 700; line-height: 1.15;
                margin: 2px 0 6px; max-height: 0.62in; overflow: hidden;
              }
              .l-qr { width: 2.5in; height: 2.5in; display: block; margin: 2px auto; }
              .l-sku { font-size: 22px; font-weight: 800; margin-top: 4px; letter-spacing: .04em; }
              .l-qty {
                font-size: 40px; font-weight: 900; line-height: 1;
                margin-top: 6px; padding: 3px 0;
                border-top: 3px solid #000; border-bottom: 3px solid #000;
                width: 100%;
              }
              .l-qty span { font-size: 15px; font-weight: 700; vertical-align: middle; }
              .l-meta { font-size: 13px; font-weight: 600; margin-top: 6px; line-height: 1.25; }
              .l-foot { font-size: 11px; margin-top: auto; padding-top: 4px; }
              .screen-only { text-align: center; padding: 14px; }
              @media print { .screen-only { display: none; } }
            .l-head { font-size:11px; font-weight:800; text-align:center; letter-spacing:.05em; margin-top:2px; }
            .l-div { border-top:3px solid #000; width:100%; margin:7px 0 4px; }
            .rows { flex:1; width:100%; display:flex; flex-direction:column; }
            .row { display:flex; align-items:center; gap:8px; padding:2px 0;
                   border-bottom:1px dashed #777; }
            .row:last-child { border-bottom:none; }
            .row img { width:0.66in; height:0.66in; flex-shrink:0; }
            .row .t { flex:1; min-width:0; text-align:left; }
            .row .n { font-size:10.5px; font-weight:700; line-height:1.1;
                      display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
            .row .s { font-size:14px; font-weight:800; letter-spacing:.03em; }
            .row .q { font-size:22px; font-weight:900; text-align:right; min-width:0.6in; }
            .row .q i { font-size:9px; font-style:normal; font-weight:700; display:block; }
          </style>
        </head>
        <body>
          <div class="screen-only">
            <button onclick="window.print()" style="padding:10px 30px;font-size:16px;cursor:pointer;">
              🖨️ Print ${sheets.length} sheet${sheets.length === 1 ? '' : 's'} — column ${wh}-R${rk}-${col} (4×6)
            </button>
          </div>
          ${sheets.map(sh => {
            const single = sh.rows.length === 1 && sh.parts === 1;
            const sub = sh.parts > 1
              ? `${sh.itemCount} ITEMS · SHEET ${sh.part} OF ${sh.parts}`
              : `${sh.itemCount} ITEM${sh.itemCount === 1 ? '' : 'S'} · ${sh.totalQty} UNITS`;
            if (single) {
              const r = sh.rows[0];
              return `
                <div class="label">
                  <div class="l-loc">${sh.code}</div>
                  <div class="l-head">${sub}</div>
                  <div class="l-div"></div>
                  <div class="l-name">${r.name || ''}</div>
                  <img class="l-qr" src="${r.qr}" />
                  <div class="l-sku">${r.partNumber || '—'}</div>
                  <div class="l-qty">${r.quantity}<span> UNITS</span></div>
                  <div class="l-meta">${r.grade ? 'Condition: ' + r.grade : ''}</div>
                  <div class="l-foot">${printed}</div>
                </div>`;
            }
            return `
              <div class="label">
                <div class="l-loc">${sh.code}</div>
                <div class="l-head">${sub}</div>
                <div class="l-div"></div>
                <div class="rows">
                  ${sh.rows.map(r => `
                    <div class="row">
                      <img src="${r.qr}" />
                      <div class="t">
                        <div class="n">${r.name || ''}</div>
                        <div class="s">${r.partNumber || '—'}</div>
                      </div>
                      <div class="q">${r.quantity}<i>UNITS</i></div>
                    </div>`).join('')}
                </div>
                <div class="l-foot">${printed}${sh.part < sh.parts ? ' · continues →' : ''}</div>
              </div>`;
          }).join('')}
        </body>
      </html>
    `);
    win.document.close();
  };

  const printLocationQRCodes = async (location) => {
    try {
      // Get all items in this location.
      // SINGLE SOURCE OF TRUTH: derive from the items themselves. This used to
      // read location.inventory — the maps retired by the unify migration —
      // so anything stored here AFTER that migration looked empty, and
      // anything stored before printed stale pre-migration quantities.
      const itemsInLocation = getLocationItems(location)
        .filter(r => (parseInt(r.quantity) || 0) > 0)
        .map(r => ({ item: r, quantity: r.quantity }));

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
            <title>Labels - ${locCode}</title>
            <style>
              @page { size: 4in 6in; margin: 0; }
              * { box-sizing: border-box; }
              body {
                margin: 0; padding: 0;
                font-family: Arial, Helvetica, sans-serif;
                -webkit-print-color-adjust: exact;
              }
              .label {
                width: 4in; height: 6in;
                padding: 0.18in 0.16in;
                display: flex; flex-direction: column;
                align-items: center; justify-content: flex-start;
                text-align: center;
                page-break-after: always;
                break-after: page;
                overflow: hidden;
              }
              .label:last-child { page-break-after: auto; break-after: auto; }
              .l-loc {
                font-size: 30px; font-weight: 900; letter-spacing: .02em;
                line-height: 1.05; margin-bottom: 2px; word-break: break-word;
              }
              .l-name {
                font-size: 15px; font-weight: 700; line-height: 1.15;
                margin: 2px 0 6px; max-height: 0.62in; overflow: hidden;
              }
              .l-qr { width: 2.5in; height: 2.5in; display: block; margin: 2px auto; }
              .l-sku { font-size: 22px; font-weight: 800; margin-top: 4px; letter-spacing: .04em; }
              .l-qty {
                font-size: 40px; font-weight: 900; line-height: 1;
                margin-top: 6px; padding: 3px 0;
                border-top: 3px solid #000; border-bottom: 3px solid #000;
                width: 100%;
              }
              .l-qty span { font-size: 15px; font-weight: 700; vertical-align: middle; }
              .l-meta { font-size: 13px; font-weight: 600; margin-top: 6px; line-height: 1.25; }
              .l-foot { font-size: 11px; margin-top: auto; padding-top: 4px; }
              .screen-only { text-align: center; padding: 14px; }
              @media print { .screen-only { display: none; } }
            </style>
          </head>
          <body>
            <div class="screen-only">
              <button onclick="window.print()" style="padding:10px 30px;font-size:16px;cursor:pointer;">
                🖨️ Print ${qrCodes.length} label${qrCodes.length === 1 ? '' : 's'} (4×6)
              </button>
            </div>
            ${qrCodes.map(({ item, quantity, qrImage }) => `
              <div class="label">
                <div class="l-loc">${locCode}</div>
                <div class="l-name">${item.name || ''}</div>
                <img class="l-qr" src="${qrImage}" />
                <div class="l-sku">${item.partNumber || '—'}</div>
                <div class="l-qty">${quantity}<span> UNITS</span></div>
                <div class="l-meta">${item.grade ? 'Condition: ' + item.grade : ''}</div>
                <div class="l-foot">${new Date().toLocaleDateString()}</div>
              </div>
            `).join('')}
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
        {userRole === 'admin' && (
          <>
            <button className="btn" onClick={runAudit} disabled={repairing}
              title="Read-only: shows where each item's stock actually sits vs where its location field claims"
              style={{ background: 'var(--btn-secondary-bg)', color: 'var(--btn-secondary-color)' }}>
              {repairing ? '⏳ Auditing…' : '🩺 Audit item locations'}
            </button>
          </>
        )}
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
          
          {filters.warehouse && filters.rack && filters.letter && (
            <button
              className="btn"
              onClick={printColumn}
              title={`Print every shelf in column ${filters.warehouse}-R${filters.rack}-${filters.letter} — one 4×6 sheet per shelf`}
              style={{ background: '#6b7f3e', color: 'var(--text-on-dark)', whiteSpace: 'nowrap' }}
            >
              🖨️ Print column {filters.warehouse}-R{filters.rack}-{filters.letter}
            </button>
          )}

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
          
          {/* Bulk actions — space is reserved so selecting doesn't jump the page */}
          <div style={{ minHeight: 34, display: 'flex', alignItems: 'center' }}>
          {selectedLocations.length > 0 && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ color: 'var(--text-muted)' }}>{selectedLocations.length} selected</span>
              <button 
                className="btn btn-danger btn-sm"
                onClick={deleteSelectedLocations}
              >
                {pendingDelete === '__bulk__'
                  ? `Click again to delete ${selectedLocations.length}`
                  : '🗑️ Delete Selected'}
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
        </div>
        
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10, flexWrap:'wrap' }}>
          <span style={{ fontSize:13, color:'var(--text-muted)' }}>
            Showing {sortedLocations.length === 0 ? 0 : (safePage - 1) * perPage + 1}
            –{Math.min(safePage * perPage, sortedLocations.length)} of {sortedLocations.length}
          </span>
          <select value={perPage} onChange={e => setPerPage(parseInt(e.target.value))}
            style={{ padding:'5px 8px', borderRadius:6, border:'1px solid var(--border)' }}>
            <option value={25}>25 per page</option>
            <option value={50}>50 per page</option>
            <option value={100}>100 per page</option>
            <option value={250}>250 per page</option>
          </select>
          <div style={{ display:'flex', gap:4, marginLeft:'auto', alignItems:'center' }}>
            <button className="btn btn-sm" disabled={safePage <= 1} onClick={() => setPage(1)}>«</button>
            <button className="btn btn-sm" disabled={safePage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>‹ Prev</button>
            <span style={{ fontSize:13, fontWeight:700, padding:'0 8px' }}>{safePage} / {totalPages}</span>
            <button className="btn btn-sm" disabled={safePage >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next ›</button>
            <button className="btn btn-sm" disabled={safePage >= totalPages} onClick={() => setPage(totalPages)}>»</button>
          </div>
        </div>

        <div className="data-table">
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    checked={pagedLocations.length > 0 && pagedLocations.every(l => selectedSet.has(l.id))}
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
              {pagedLocations.map(loc => (
                <tr 
                  key={loc.id} 
                  style={{ 
                    cursor: 'pointer',
                    background: selectedSet.has(loc.id) ? '#e3f2fd' : 'transparent'
                  }}
                  title="Click to view items"
                >
                  <td onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedSet.has(loc.id)}
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
                            title={pendingDelete === loc.id ? 'Click again to confirm' : 'Delete this location'}
                          >
                            {pendingDelete === loc.id ? 'Click again to confirm' : 'Delete'}
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
