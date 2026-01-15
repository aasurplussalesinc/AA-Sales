import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { OrgDB as DB } from '../orgDb';

export default function Items() {
  const [items, setItems] = useState([]);
  const [originalItems, setOriginalItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [adjustingItem, setAdjustingItem] = useState(null);
  const fileInputRef = useRef(null);
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(50);
  
  // Item locations popup state
  const [viewingItemLocations, setViewingItemLocations] = useState(null);
  
  // Item history modal state
  const [viewingItemHistory, setViewingItemHistory] = useState(null);
  const [itemHistory, setItemHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Add Item modal state
  const [showAddItem, setShowAddItem] = useState(false);
  const [useMultiLocation, setUseMultiLocation] = useState(false);
  const [newItem, setNewItem] = useState({
    partNumber: '',
    name: '',
    category: '',
    stock: 0,
    price: 0,
    location: '',
    lowStockThreshold: 10,
    reorderPoint: 20,
    locationBreakdown: [{ location: '', quantity: 0 }] // For multi-location
  });

  // Filter states
  const [filters, setFilters] = useState({
    sku: '',
    name: '',
    category: '',
    quantity: '',
    location: '',
    stockStatus: '', // '', 'low', 'reorder', 'ok'
    sortBy: 'sku' // default sort by SKU
  });
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const [itemsData, locsData] = await Promise.all([
      DB.getItems(),
      DB.getLocations()
    ]);
    itemsData.sort((a, b) => (a.partNumber || '').localeCompare(b.partNumber || ''));
    setItems(itemsData);
    setOriginalItems(JSON.parse(JSON.stringify(itemsData))); // Deep copy
    setLocations(locsData);
    setHasChanges(false);
    setLoading(false);
  };

  const loadItemHistory = async (item) => {
    setViewingItemHistory(item);
    setLoadingHistory(true);
    try {
      const history = await DB.getItemHistory(item.id);
      setItemHistory(history);
    } catch (error) {
      console.error('Error loading item history:', error);
      setItemHistory([]);
    }
    setLoadingHistory(false);
  };

  const formatHistoryEntry = (entry) => {
    if (entry.historyType === 'movement') {
      const typeColors = {
        'PICK': '#f44336',
        'ADD': '#4CAF50',
        'MOVE': '#2196F3',
        'RECEIVE': '#9c27b0',
        'ADJUST': '#ff9800'
      };
      return {
        icon: entry.type === 'PICK' ? '📤' : entry.type === 'ADD' ? '📥' : entry.type === 'MOVE' ? '🔄' : entry.type === 'RECEIVE' ? '📦' : '✏️',
        color: typeColors[entry.type] || '#666',
        title: entry.type,
        description: entry.type === 'MOVE' 
          ? `Moved ${entry.quantity} from ${entry.fromLocation} to ${entry.toLocation}`
          : `${entry.type === 'PICK' ? 'Picked' : 'Added'} ${entry.quantity} ${entry.location ? (entry.type === 'PICK' ? 'from' : 'to') + ' ' + entry.location : ''}`,
        user: entry.performedBy || 'System',
        timestamp: entry.timestamp
      };
    } else {
      // Activity log entry
      const actionIcons = {
        'ITEM_CREATED': '🆕',
        'ITEM_UPDATED': '✏️',
        'ITEM_DELETED': '🗑️',
        'PRICE_CHANGED': '💰',
        'STOCK_ADJUSTED': '📊'
      };
      return {
        icon: actionIcons[entry.action] || '📝',
        color: '#666',
        title: entry.action?.replace(/_/g, ' ') || 'Activity',
        description: entry.details?.note || JSON.stringify(entry.details || {}),
        user: entry.userEmail || 'System',
        timestamp: entry.timestamp
      };
    }
  };

  // Get unique categories for dropdown
  const categories = [...new Set(items.map(i => i.category).filter(Boolean))].sort();

  // Get location options
  const locationOptions = locations.map(loc => 
    loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}-${loc.shelf}`
  ).sort();

  // Quantity filter options
  const quantityOptions = [
    { value: '', label: 'All' },
    { value: '0', label: 'Out of Stock (0)' },
    { value: '1-10', label: 'Low (1-10)' },
    { value: '11-50', label: 'Medium (11-50)' },
    { value: '51+', label: 'High (51+)' }
  ];

  // Filter logic
  const filteredItems = items.filter(item => {
    // SKU filter
    if (filters.sku && !item.partNumber?.toLowerCase().includes(filters.sku.toLowerCase())) {
      return false;
    }
    
    // Name filter
    if (filters.name && !item.name?.toLowerCase().includes(filters.name.toLowerCase())) {
      return false;
    }
    
    // Category filter
    if (filters.category && item.category !== filters.category) {
      return false;
    }
    
    // Quantity filter
    if (filters.quantity) {
      const stock = item.stock || 0;
      if (filters.quantity === '0' && stock !== 0) return false;
      if (filters.quantity === '1-10' && (stock < 1 || stock > 10)) return false;
      if (filters.quantity === '11-50' && (stock < 11 || stock > 50)) return false;
      if (filters.quantity === '51+' && stock < 51) return false;
    }
    
    // Location filter
    if (filters.location && item.location !== filters.location) {
      return false;
    }
    
    // Stock status filter (low stock, reorder, ok)
    if (filters.stockStatus) {
      const stock = item.stock || 0;
      const lowThreshold = item.lowStockThreshold || 0;
      const reorderPoint = item.reorderPoint || 0;
      
      if (filters.stockStatus === 'low') {
        if (!(stock <= lowThreshold && lowThreshold > 0)) return false;
      } else if (filters.stockStatus === 'reorder') {
        if (!(stock > lowThreshold && stock <= reorderPoint && reorderPoint > 0)) return false;
      } else if (filters.stockStatus === 'ok') {
        if (lowThreshold > 0 && stock <= lowThreshold) return false;
        if (reorderPoint > 0 && stock <= reorderPoint) return false;
      }
    }
    
    return true;
  });

  // Sort the filtered items
  const sortedItems = [...filteredItems].sort((a, b) => {
    switch (filters.sortBy) {
      case 'name-asc':
        return (a.name || '').localeCompare(b.name || '');
      case 'name-desc':
        return (b.name || '').localeCompare(a.name || '');
      case 'sku':
      default:
        return (a.partNumber || '').localeCompare(b.partNumber || '');
    }
  });

  // Pagination calculations
  const totalPages = Math.ceil(sortedItems.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedItems = sortedItems.slice(startIndex, endIndex);
  
  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [filters, items.length]);

  // Format date
  const formatDate = (timestamp) => {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
  };

  // Clear all filters
  const clearFilters = () => {
    setFilters({
      sku: '',
      name: '',
      category: '',
      quantity: '',
      location: '',
      sortBy: 'sku'
    });
  };

  // Check if any filters are active
  const hasActiveFilters = Object.entries(filters).some(([k, v]) => k !== 'sortBy' && v !== '');

  // Get all locations where an item is stored
  const getItemLocations = (itemId) => {
    const itemLocations = [];
    const item = items.find(i => i.id === itemId);
    
    // Check location inventory (from movements/assignments)
    for (const loc of locations) {
      if (loc.inventory && loc.inventory[itemId] && loc.inventory[itemId] > 0) {
        itemLocations.push({
          location: loc,
          locationCode: loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}-${loc.shelf}`,
          quantity: loc.inventory[itemId]
        });
      }
    }
    
    // Also check item's direct location field (from import/manual entry)
    if (item && item.location && itemLocations.length === 0) {
      // Find matching location by code
      const matchingLoc = locations.find(loc => {
        const locCode = loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}-${loc.shelf}`;
        return locCode === item.location;
      });
      
      if (matchingLoc) {
        itemLocations.push({
          location: matchingLoc,
          locationCode: item.location,
          quantity: item.stock || 0
        });
      } else {
        // Location string exists but no matching location record
        itemLocations.push({
          location: null,
          locationCode: item.location,
          quantity: item.stock || 0,
          isUnmapped: true
        });
      }
    }
    
    return itemLocations;
  };

  // Get total quantity across all locations for an item
  const getTotalInLocations = (itemId) => {
    return getItemLocations(itemId).reduce((sum, loc) => sum + loc.quantity, 0);
  };

  // Add new item
  const addNewItem = async () => {
    if (!newItem.name && !newItem.partNumber) {
      alert('Please enter at least a name or SKU');
      return;
    }

    let totalStock = 0;
    let locationInfo = '';
    
    if (useMultiLocation) {
      // Calculate total from breakdown
      const validLocations = newItem.locationBreakdown.filter(lb => lb.location && lb.quantity > 0);
      totalStock = validLocations.reduce((sum, lb) => sum + parseInt(lb.quantity) || 0, 0);
      locationInfo = validLocations.map(lb => `${lb.location}: ${lb.quantity}`).join(', ') || '(none)';
    } else {
      totalStock = parseInt(newItem.stock) || 0;
      locationInfo = newItem.location || '(none)';
    }

    const confirmMsg = `Add new item?\n\nSKU: ${newItem.partNumber || '(none)'}\nName: ${newItem.name || '(none)'}\nCategory: ${newItem.category || '(none)'}\nTotal Stock: ${totalStock}\nPrice: $${newItem.price}\nLocation(s): ${locationInfo}`;
    
    if (!confirm(confirmMsg)) return;

    // Create the item
    const itemId = await DB.createItem({
      partNumber: newItem.partNumber,
      name: newItem.name,
      category: newItem.category,
      stock: totalStock,
      price: parseFloat(newItem.price) || 0,
      location: useMultiLocation ? '' : newItem.location,
      lowStockThreshold: newItem.lowStockThreshold,
      reorderPoint: newItem.reorderPoint
    });

    // If multi-location, update location inventories
    if (useMultiLocation && itemId) {
      const validLocations = newItem.locationBreakdown.filter(lb => lb.location && lb.quantity > 0);
      for (const lb of validLocations) {
        // Find the location by code
        const loc = locations.find(l => {
          const locCode = l.locationCode || `${l.warehouse}-R${l.rack}-${l.letter}-${l.shelf}`;
          return locCode === lb.location;
        });
        if (loc) {
          await DB.setInventoryAtLocation(loc.id, itemId, parseInt(lb.quantity) || 0);
        }
      }
    }

    setNewItem({
      partNumber: '',
      name: '',
      category: '',
      stock: 0,
      price: 0,
      location: '',
      lowStockThreshold: 10,
      reorderPoint: 20,
      locationBreakdown: [{ location: '', quantity: 0 }]
    });
    setUseMultiLocation(false);
    setShowAddItem(false);
    loadData();
  };

  // Download CSV template
  const downloadTemplate = () => {
    const template = `SKU,Item Name,Category,Quantity,Price,Location,Low Stock Threshold,Reorder Point
PART-001,Example Widget,Electronics,100,29.99,W1-R1-A-1,10,20
PART-002,Sample Gadget,Hardware,50,49.99,W1-R1-A-2,5,15
PART-003,Test Component,Parts,200,9.99,,10,25`;
    
    const blob = new Blob([template], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'items-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Export to CSV
  const exportToCSV = () => {
    // CSV headers
    const headers = ['SKU', 'Item Name', 'Category', 'Quantity', 'Price', 'Location', 'Date Added'];
    
    // Convert items to CSV rows
    const rows = sortedItems.map(item => [
      item.partNumber || '',
      item.name || '',
      item.category || '',
      item.stock || 0,
      item.price || 0,
      item.location || '',
      formatDate(item.createdAt)
    ]);
    
    // Combine headers and rows
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => {
        // Escape quotes and wrap in quotes if contains comma
        const cellStr = String(cell).replace(/"/g, '""');
        return cellStr.includes(',') ? `"${cellStr}"` : cellStr;
      }).join(','))
    ].join('\n');
    
    // Create and download file
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `inventory-items-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Import from CSV
  const handleImportCSV = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setImporting(true);
    const reader = new FileReader();
    
    reader.onload = async (e) => {
      try {
        const text = e.target.result;
        const lines = text.split('\n').filter(line => line.trim());
        
        if (lines.length < 2) {
          alert('CSV file is empty or has no data rows');
          setImporting(false);
          return;
        }

        // Parse header row
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
        
        // Map common header variations
        const headerMap = {
          'sku': ['sku', 'partnumber', 'part number', 'part_number', 'item number', 'item_number', 'itemnumber'],
          'name': ['name', 'item name', 'item_name', 'itemname', 'description', 'product name', 'product_name'],
          'category': ['category', 'cat', 'type', 'group'],
          'stock': ['stock', 'quantity', 'qty', 'count', 'amount', 'on hand', 'on_hand'],
          'price': ['price', 'unit price', 'unitprice', 'unit_price', 'cost', 'sell price', 'sellprice'],
          'location': ['location', 'loc', 'bin', 'warehouse', 'position']
        };

        // Find column indices
        const columnIndices = {};
        for (const [field, variations] of Object.entries(headerMap)) {
          const index = headers.findIndex(h => variations.includes(h));
          if (index !== -1) columnIndices[field] = index;
        }

        if (!columnIndices.name && !columnIndices.sku) {
          alert('CSV must have at least a "Name" or "SKU" column');
          setImporting(false);
          return;
        }

        // Parse data rows and group by SKU for multi-location support
        const itemsBySku = new Map();
        const locationInventory = []; // Track location assignments
        
        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          if (values.length === 0) continue;

          const sku = columnIndices.sku !== undefined ? values[columnIndices.sku]?.trim() : '';
          const name = columnIndices.name !== undefined ? values[columnIndices.name]?.trim() : '';
          const category = columnIndices.category !== undefined ? values[columnIndices.category]?.trim() : '';
          const qty = columnIndices.stock !== undefined ? parseInt(values[columnIndices.stock]) || 0 : 0;
          const price = columnIndices.price !== undefined ? parseFloat(values[columnIndices.price]?.replace(/[^0-9.-]/g, '')) || 0 : 0;
          const location = columnIndices.location !== undefined ? values[columnIndices.location]?.trim() : '';

          // Skip empty rows
          if (!name && !sku) continue;

          const key = sku || name; // Use SKU as key, fallback to name
          
          if (!itemsBySku.has(key)) {
            // First time seeing this item
            itemsBySku.set(key, {
              partNumber: sku,
              name: name,
              category: category,
              stock: qty, // Will be summed if multiple locations
              price: price,
              location: location, // Primary location (first one seen)
              createdAt: Date.now()
            });
          } else {
            // Duplicate SKU - add to stock total
            const existing = itemsBySku.get(key);
            existing.stock += qty;
            // Keep first non-empty values for other fields
            if (!existing.name && name) existing.name = name;
            if (!existing.category && category) existing.category = category;
            if (!existing.price && price) existing.price = price;
          }
          
          // Track location assignment if location is specified
          if (location && qty > 0) {
            locationInventory.push({
              sku: key,
              location: location,
              quantity: qty
            });
          }
        }

        const newItems = Array.from(itemsBySku.values());

        if (newItems.length === 0) {
          alert('No valid items found in CSV');
          setImporting(false);
          return;
        }

        // Show summary with multi-location info
        const hasMultiLocation = locationInventory.length > newItems.length;
        let confirmMsg = `This will REPLACE ALL existing inventory with ${newItems.length} unique items from the CSV.`;
        if (hasMultiLocation) {
          confirmMsg += `\n\n📍 Multi-location detected: ${locationInventory.length} location assignments will be created.`;
        }
        confirmMsg += '\n\nAre you sure?';
        
        if (!confirm(confirmMsg)) {
          setImporting(false);
          return;
        }

        // Import items to database
        const result = await DB.importItems(newItems);
        
        // Now assign inventory to locations
        let locationAssignments = 0;
        if (locationInventory.length > 0) {
          // Get fresh items list to get IDs
          const freshItems = await DB.getItems();
          
          for (const inv of locationInventory) {
            // Find the item by SKU or name
            const item = freshItems.find(i => 
              (i.partNumber && i.partNumber === inv.sku) || 
              (i.name && i.name === inv.sku)
            );
            
            if (item) {
              // Find the location
              const loc = locations.find(l => 
                l.locationCode === inv.location ||
                `${l.warehouse}-R${l.rack}-${l.letter}-${l.shelf}` === inv.location
              );
              
              if (loc) {
                // Add inventory to location
                await DB.addInventoryToLocation(loc.id, item.id, inv.quantity);
                locationAssignments++;
              }
            }
          }
        }
        
        let successMsg = `Import complete!\n\n✓ ${result.deleted} old items removed\n✓ ${result.added} new items imported`;
        if (locationAssignments > 0) {
          successMsg += `\n✓ ${locationAssignments} location assignments created`;
        }
        alert(successMsg);
        
        loadData(); // Refresh the list
      } catch (error) {
        console.error('Import error:', error);
        alert('Failed to import CSV: ' + error.message);
      } finally {
        setImporting(false);
        // Reset file input
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    };

    reader.onerror = () => {
      alert('Failed to read file');
      setImporting(false);
    };

    reader.readAsText(file);
  };

  // Parse CSV line handling quoted values
  const parseCSVLine = (line) => {
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    
    return values;
  };

  const updateItem = async (id, field, value) => {
    setItems(items.map(item => 
      item.id === id ? { ...item, [field]: value } : item
    ));
    setHasChanges(true);
  };

  const saveAllChanges = async () => {
    if (!confirm('Save all changes to items?')) return;
    
    setSaving(true);
    try {
      // Find items that changed
      for (const item of items) {
        const original = originalItems.find(o => o.id === item.id);
        if (original) {
          const changed = 
            item.partNumber !== original.partNumber ||
            item.name !== original.name ||
            item.category !== original.category ||
            item.stock !== original.stock ||
            item.price !== original.price ||
            item.location !== original.location;
          
          if (changed) {
            await DB.updateItem(item.id, {
              partNumber: item.partNumber,
              name: item.name,
              category: item.category,
              stock: parseInt(item.stock) || 0,
              price: parseFloat(item.price) || 0,
              location: item.location
            });
          }
        }
      }
      
      setOriginalItems(JSON.parse(JSON.stringify(items)));
      setHasChanges(false);
      alert('Changes saved successfully!');
    } catch (error) {
      console.error('Error saving:', error);
      alert('Error saving changes: ' + error.message);
    } finally {
      setSaving(false);
    }
  };

  const discardChanges = () => {
    if (!confirm('Discard all unsaved changes?')) return;
    setItems(JSON.parse(JSON.stringify(originalItems)));
    setHasChanges(false);
  };

  const applyAdjustment = async () => {
    if (!adjustingItem) return;
    
    const qty = parseInt(adjustingItem.adjustQty) || 0;
    if (qty <= 0) {
      alert('Enter a quantity greater than 0');
      return;
    }
    
    const currentStock = parseInt(adjustingItem.stock) || 0;
    const newStock = adjustingItem.adjustType === 'add' 
      ? currentStock + qty 
      : Math.max(0, currentStock - qty);
    
    const action = adjustingItem.adjustType === 'add' ? 'Add' : 'Remove';
    if (!confirm(`${action} ${qty} to ${adjustingItem.name || adjustingItem.partNumber}?\n\nCurrent: ${currentStock}\nNew: ${newStock}`)) {
      return;
    }
    
    // Update directly in Firebase (not just local state)
    try {
      await DB.updateItem(adjustingItem.id, { stock: newStock });
      await DB.logMovement({
        itemId: adjustingItem.id,
        itemName: adjustingItem.name,
        quantity: qty,
        type: adjustingItem.adjustType === 'add' ? 'ADD' : 'ADJUST',
        notes: `Quick ${adjustingItem.adjustType}: ${qty}`,
        timestamp: Date.now()
      });
      setAdjustingItem(null);
      await loadData();
    } catch (error) {
      alert('Error: ' + error.message);
    }
  };

  const deleteItem = async (id) => {
    if (!confirm('Delete this item?')) return;
    setItems(items.filter(item => item.id !== id));
  };

  const printQR = async (item) => {
    try {
      const qrData = item.partNumber || item.id;
      const qrImage = await QRCode.toDataURL(qrData, { width: 300 });
      
      const printWindow = window.open('', '_blank');
      printWindow.document.write(`
        <html>
          <head>
            <title>QR Code - ${item.name}</title>
            <style>
              body {
                display: flex;
                flex-direction: column;
                align-items: center;
                padding: 40px;
                font-family: Arial;
              }
              h2 { margin-bottom: 20px; }
              img { border: 2px solid #000; padding: 15px; }
              p { margin-top: 10px; font-size: 12px; color: #666; }
            </style>
          </head>
          <body>
            <h2>${item.name}</h2>
            <img src="${qrImage}" />
            <p>${item.partNumber}</p>
          </body>
        </html>
      `);
      printWindow.document.close();
      printWindow.print();
    } catch (error) {
      alert('Print failed: ' + error.message);
    }
  };

  // Bulk QR Label Printing
  const [selectedItems, setSelectedItems] = useState([]);
  const [showLabelModal, setShowLabelModal] = useState(false);
  const [labelSize, setLabelSize] = useState('medium');

  const toggleSelectItem = (itemId) => {
    setSelectedItems(prev => 
      prev.includes(itemId) ? prev.filter(id => id !== itemId) : [...prev, itemId]
    );
  };

  const selectAllFiltered = () => setSelectedItems(sortedItems.map(i => i.id));
  const clearSelection = () => setSelectedItems([]);

  const printBulkLabels = async (format) => {
    const itemsToPrint = items.filter(i => selectedItems.includes(i.id));
    if (itemsToPrint.length === 0) return alert('Select items first');

    const qrCodes = await Promise.all(
      itemsToPrint.map(async (item) => ({
        item,
        qrImage: await QRCode.toDataURL(item.partNumber || item.id, { width: 200 })
      }))
    );

    const sizes = {
      small: { w: '2in', h: '1in', qr: 50, font: 8 },
      medium: { w: '2.5in', h: '1.5in', qr: 70, font: 9 },
      large: { w: '4in', h: '2in', qr: 100, font: 11 }
    };
    const s = sizes[labelSize];

    const printWindow = window.open('', '_blank');
    
    if (format === 'individual') {
      // One label per page
      printWindow.document.write(`
        <html><head><title>Labels</title>
        <style>
          @page { size: ${s.w} ${s.h}; margin: 0; }
          body { font-family: Arial; margin: 0; }
          .label { width: ${s.w}; height: ${s.h}; padding: 5px; box-sizing: border-box;
            page-break-after: always; display: flex; align-items: center; gap: 8px; }
          .label:last-child { page-break-after: avoid; }
          .label img { width: ${s.qr}px; height: ${s.qr}px; }
          .info { flex: 1; overflow: hidden; }
          .info h4 { font-size: ${s.font + 1}px; margin: 0 0 2px 0; }
          .info p { font-size: ${s.font}px; margin: 1px 0; }
          .sku { font-family: monospace; font-weight: bold; }
        </style></head><body>
        ${qrCodes.map(({ item, qrImage }) => `
          <div class="label">
            <img src="${qrImage}" />
            <div class="info">
              <h4>${(item.name || 'Unnamed').substring(0, 30)}</h4>
              <p class="sku">${item.partNumber || '-'}</p>
              <p>Loc: ${item.location || '-'}</p>
            </div>
          </div>
        `).join('')}
        </body></html>
      `);
    } else {
      // Sheet format - multiple labels per page
      printWindow.document.write(`
        <html><head><title>Label Sheet</title>
        <style>
          @page { size: letter; margin: 0.3in; }
          body { font-family: Arial; margin: 0; }
          .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
          .label { border: 1px dashed #ccc; padding: 8px; text-align: center; 
            page-break-inside: avoid; height: 1.8in; box-sizing: border-box; }
          .label img { width: 60px; height: 60px; }
          .label h4 { font-size: 9px; margin: 3px 0; line-height: 1.1; height: 20px; overflow: hidden; }
          .label p { font-size: 8px; margin: 1px 0; }
          @media print { .label { border: 1px solid #eee; } }
        </style></head><body>
        <div class="grid">
        ${qrCodes.map(({ item, qrImage }) => `
          <div class="label">
            <img src="${qrImage}" />
            <h4>${(item.name || 'Unnamed').substring(0, 40)}</h4>
            <p><strong>${item.partNumber || '-'}</strong></p>
            <p>${item.location || ''}</p>
          </div>
        `).join('')}
        </div>
        </body></html>
      `);
    }
    
    printWindow.document.close();
    setTimeout(() => printWindow.print(), 300);
    setShowLabelModal(false);
  };

  if (loading) {
    return <div className="page-content"><div className="loading">Loading...</div></div>;
  }

  return (
    <div className="page-content">
      {/* Top action bar */}
      <div style={{ 
        display: 'flex', 
        gap: 10, 
        marginBottom: 15,
        flexWrap: 'wrap',
        alignItems: 'center'
      }}>
        <button 
          className={`btn ${showFilters ? 'btn-primary' : ''}`}
          onClick={() => setShowFilters(!showFilters)}
          style={{ background: showFilters ? '#2d5f3f' : '#6c757d', color: 'white' }}
        >
          🔍 Filters {hasActiveFilters && `(${Object.values(filters).filter(v => v).length})`}
        </button>
        
        {hasActiveFilters && (
          <button 
            className="btn"
            onClick={clearFilters}
            style={{ background: '#dc3545', color: 'white' }}
          >
            ✕ Clear Filters
          </button>
        )}
        
        <div style={{ flex: 1 }} />
        
        {/* Hidden file input for CSV import */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleImportCSV}
          accept=".csv"
          style={{ display: 'none' }}
        />

        {hasChanges && (
          <>
            <button 
              className="btn"
              onClick={saveAllChanges}
              disabled={saving}
              style={{ background: '#4CAF50', color: 'white' }}
            >
              {saving ? '⏳ Saving...' : '💾 Save Changes'}
            </button>
            <button 
              className="btn"
              onClick={discardChanges}
              disabled={saving}
              style={{ background: '#f44336', color: 'white' }}
            >
              ↩️ Discard
            </button>
          </>
        )}

        <button 
          className="btn btn-primary"
          onClick={() => setShowAddItem(true)}
        >
          + Add Item
        </button>
        
        <button 
          className="btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          style={{ background: '#17a2b8', color: 'white' }}
        >
          {importing ? '⏳ Importing...' : '📤 Import CSV'}
        </button>
        
        <button 
          className="btn"
          onClick={downloadTemplate}
          style={{ background: '#6c757d', color: 'white' }}
        >
          📋 Download Template
        </button>
        
        <button 
          className="btn btn-primary"
          onClick={exportToCSV}
        >
          📥 Export CSV
        </button>
        
        <button 
          className="btn"
          onClick={() => setShowLabelModal(true)}
          style={{ background: '#9c27b0', color: 'white' }}
        >
          🏷️ Print Labels
        </button>
      </div>

      {/* Bulk Label Print Modal */}
      {showLabelModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 1000, padding: 20
        }}>
          <div style={{
            background: 'white', borderRadius: 12, padding: 30,
            maxWidth: 500, width: '100%'
          }}>
            <h3 style={{ marginBottom: 20 }}>🏷️ Print QR Labels</h3>
            
            {/* Selection controls */}
            <div style={{ marginBottom: 20 }}>
              <p style={{ marginBottom: 10 }}>
                <strong>{selectedItems.length}</strong> items selected
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-primary btn-sm" onClick={selectAllFiltered}>
                  Select All Filtered ({sortedItems.length})
                </button>
                {selectedItems.length > 0 && (
                  <button className="btn btn-sm" onClick={clearSelection} style={{ background: '#6c757d', color: 'white' }}>
                    Clear Selection
                  </button>
                )}
              </div>
            </div>

            {/* Label size */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>Label Size</label>
              <div style={{ display: 'flex', gap: 10 }}>
                {['small', 'medium', 'large'].map(size => (
                  <button
                    key={size}
                    onClick={() => setLabelSize(size)}
                    style={{
                      padding: '8px 16px',
                      border: labelSize === size ? '2px solid #2d5f3f' : '1px solid #ddd',
                      borderRadius: 6,
                      background: labelSize === size ? '#e8f5e9' : 'white',
                      cursor: 'pointer',
                      textTransform: 'capitalize'
                    }}
                  >
                    {size}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: 12, color: '#666', marginTop: 5 }}>
                {labelSize === 'small' && '2" × 1" - For small bins'}
                {labelSize === 'medium' && '2.5" × 1.5" - Standard labels'}
                {labelSize === 'large' && '4" × 2" - Large shelf labels'}
              </p>
            </div>

            {/* Print format buttons */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 15 }}>
              <button
                className="btn btn-primary"
                onClick={() => printBulkLabels('individual')}
                disabled={selectedItems.length === 0}
                style={{ flex: 1 }}
              >
                🖨️ Individual Labels
              </button>
              <button
                className="btn btn-primary"
                onClick={() => printBulkLabels('sheet')}
                disabled={selectedItems.length === 0}
                style={{ flex: 1 }}
              >
                📄 Label Sheet (3×per row)
              </button>
            </div>
            
            <button
              className="btn"
              onClick={() => setShowLabelModal(false)}
              style={{ width: '100%', background: '#6c757d', color: 'white' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Filter panel */}
      {showFilters && (
        <div style={{ 
          background: 'white', 
          padding: 20, 
          borderRadius: 8, 
          marginBottom: 15,
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
        }}>
          <h3 style={{ marginBottom: 15, fontSize: 16 }}>Filter Items</h3>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 15
          }}>
            {/* SKU filter */}
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>
                SKU
              </label>
              <input
                type="text"
                className="form-input"
                placeholder="Search SKU..."
                value={filters.sku}
                onChange={e => setFilters({ ...filters, sku: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>
            
            {/* Name filter */}
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>
                Item Name
              </label>
              <input
                type="text"
                className="form-input"
                placeholder="Search name..."
                value={filters.name}
                onChange={e => setFilters({ ...filters, name: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>
            
            {/* Category filter */}
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>
                Category
              </label>
              <select
                className="form-input"
                value={filters.category}
                onChange={e => setFilters({ ...filters, category: e.target.value })}
                style={{ width: '100%' }}
              >
                <option value="">All Categories</option>
                {categories.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
            
            {/* Quantity filter */}
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>
                Quantity
              </label>
              <select
                className="form-input"
                value={filters.quantity}
                onChange={e => setFilters({ ...filters, quantity: e.target.value })}
                style={{ width: '100%' }}
              >
                {quantityOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            
            {/* Location filter */}
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>
                Location
              </label>
              <select
                className="form-input"
                value={filters.location}
                onChange={e => setFilters({ ...filters, location: e.target.value })}
                style={{ width: '100%' }}
              >
                <option value="">All Locations</option>
                {locationOptions.map(loc => (
                  <option key={loc} value={loc}>{loc}</option>
                ))}
              </select>
            </div>
            
            {/* Stock Status filter */}
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>
                Stock Status
              </label>
              <select
                className="form-input"
                value={filters.stockStatus}
                onChange={e => setFilters({ ...filters, stockStatus: e.target.value })}
                style={{ width: '100%' }}
              >
                <option value="">All Items</option>
                <option value="low">🔴 Low Stock</option>
                <option value="reorder">🟠 Needs Reorder</option>
                <option value="ok">🟢 Stock OK</option>
              </select>
            </div>
            
            {/* Sort By */}
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>
                Sort By
              </label>
              <select
                className="form-input"
                value={filters.sortBy}
                onChange={e => setFilters({ ...filters, sortBy: e.target.value })}
                style={{ width: '100%' }}
              >
                <option value="sku">SKU</option>
                <option value="name-asc">Item Name (A-Z)</option>
                <option value="name-desc">Item Name (Z-A)</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Pagination controls */}
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        marginBottom: 15,
        flexWrap: 'wrap',
        gap: 10
      }}>
        <p style={{ color: '#666', margin: 0 }}>
          Showing {startIndex + 1}-{Math.min(endIndex, sortedItems.length)} of {sortedItems.length} items
          {hasActiveFilters && ' (filtered)'}
        </p>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Items per page selector */}
          <select 
            value={itemsPerPage} 
            onChange={e => { setItemsPerPage(Number(e.target.value)); setCurrentPage(1); }}
            style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd' }}
          >
            <option value={25}>25 per page</option>
            <option value={50}>50 per page</option>
            <option value={100}>100 per page</option>
          </select>
          
          {/* Page navigation */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <button
              onClick={() => setCurrentPage(1)}
              disabled={currentPage === 1}
              style={{
                padding: '6px 10px',
                border: '1px solid #ddd',
                borderRadius: 4,
                background: currentPage === 1 ? '#f5f5f5' : 'white',
                cursor: currentPage === 1 ? 'not-allowed' : 'pointer'
              }}
            >
              ««
            </button>
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              style={{
                padding: '6px 10px',
                border: '1px solid #ddd',
                borderRadius: 4,
                background: currentPage === 1 ? '#f5f5f5' : 'white',
                cursor: currentPage === 1 ? 'not-allowed' : 'pointer'
              }}
            >
              ‹ Prev
            </button>
            
            <span style={{ padding: '0 10px', fontWeight: 'bold' }}>
              {currentPage} / {totalPages || 1}
            </span>
            
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
              style={{
                padding: '6px 10px',
                border: '1px solid #ddd',
                borderRadius: 4,
                background: currentPage >= totalPages ? '#f5f5f5' : 'white',
                cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer'
              }}
            >
              Next ›
            </button>
            <button
              onClick={() => setCurrentPage(totalPages)}
              disabled={currentPage >= totalPages}
              style={{
                padding: '6px 10px',
                border: '1px solid #ddd',
                borderRadius: 4,
                background: currentPage >= totalPages ? '#f5f5f5' : 'white',
                cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer'
              }}
            >
              »»
            </button>
          </div>
        </div>
      </div>

      {/* Data table */}
      <div className="data-table">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <input
                  type="checkbox"
                  checked={selectedItems.length === paginatedItems.length && paginatedItems.length > 0}
                  onChange={(e) => e.target.checked ? setSelectedItems(paginatedItems.map(i => i.id)) : clearSelection()}
                />
              </th>
              <th style={{ width: 80 }}>SKU</th>
              <th style={{ minWidth: 250 }}>Item Name</th>
              <th style={{ width: 100 }}>Category</th>
              <th style={{ width: 130 }}>Quantity</th>
              <th style={{ width: 80 }}>Price</th>
              <th style={{ width: 100 }}>Location</th>
              <th style={{ width: 100 }}>Date Added</th>
              <th style={{ width: 120 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginatedItems.map(item => (
              <tr key={item.id} style={{ background: selectedItems.includes(item.id) ? '#e3f2fd' : 'transparent' }}>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedItems.includes(item.id)}
                    onChange={() => toggleSelectItem(item.id)}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={item.partNumber || ''}
                    onChange={e => updateItem(item.id, 'partNumber', e.target.value)}
                    style={{ width: '70px' }}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={item.name || ''}
                    onChange={e => updateItem(item.id, 'name', e.target.value)}
                    className="item-name-input"
                    style={{ width: '100%', minWidth: '200px' }}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={item.category || ''}
                    onChange={e => updateItem(item.id, 'category', e.target.value)}
                    style={{ width: '90px' }}
                  />
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    {/* Low stock indicator */}
                    {(item.stock || 0) <= (item.lowStockThreshold || 0) && (item.lowStockThreshold || 0) > 0 && (
                      <span 
                        title={`Low stock! Below threshold of ${item.lowStockThreshold}`}
                        style={{
                          background: '#f44336',
                          color: 'white',
                          borderRadius: '50%',
                          width: 18,
                          height: 18,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10,
                          fontWeight: 'bold'
                        }}
                      >!</span>
                    )}
                    {(item.stock || 0) > (item.lowStockThreshold || 0) && (item.stock || 0) <= (item.reorderPoint || 0) && (item.reorderPoint || 0) > 0 && (
                      <span 
                        title={`Consider reordering - at or below reorder point of ${item.reorderPoint}`}
                        style={{
                          background: '#ff9800',
                          color: 'white',
                          borderRadius: '50%',
                          width: 18,
                          height: 18,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10,
                          fontWeight: 'bold'
                        }}
                      >⚠</span>
                    )}
                    <input
                      type="number"
                      value={item.stock || 0}
                      onChange={e => updateItem(item.id, 'stock', e.target.value)}
                      style={{ 
                        width: '60px',
                        background: (item.stock || 0) <= (item.lowStockThreshold || 0) && (item.lowStockThreshold || 0) > 0 
                          ? '#ffebee' 
                          : (item.stock || 0) <= (item.reorderPoint || 0) && (item.reorderPoint || 0) > 0
                            ? '#fff3e0'
                            : 'white'
                      }}
                    />
                    <button
                      onClick={() => setAdjustingItem({ ...item, adjustQty: 1, adjustType: 'add' })}
                      style={{
                        background: '#4CAF50',
                        color: 'white',
                        border: 'none',
                        borderRadius: 4,
                        width: 24,
                        height: 24,
                        cursor: 'pointer',
                        fontSize: 14,
                        fontWeight: 'bold'
                      }}
                      title="Add quantity"
                    >
                      +
                    </button>
                    <button
                      onClick={() => setAdjustingItem({ ...item, adjustQty: 1, adjustType: 'subtract' })}
                      style={{
                        background: '#f44336',
                        color: 'white',
                        border: 'none',
                        borderRadius: 4,
                        width: 24,
                        height: 24,
                        cursor: 'pointer',
                        fontSize: 14,
                        fontWeight: 'bold'
                      }}
                      title="Subtract quantity"
                    >
                      −
                    </button>
                  </div>
                </td>
                <td>
                  <input
                    type="number"
                    value={item.price || 0}
                    onChange={e => updateItem(item.id, 'price', parseFloat(e.target.value) || 0)}
                    style={{ width: '75px' }}
                    step="0.01"
                    min="0"
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={item.location || ''}
                    onChange={e => updateItem(item.id, 'location', e.target.value)}
                    style={{ width: '90px' }}
                  />
                </td>
                <td style={{ whiteSpace: 'nowrap', color: '#666', fontSize: 12 }}>
                  {formatDate(item.createdAt)}
                </td>
                <td>
                  <div className="action-buttons">
                    <button
                      className="btn btn-sm"
                      onClick={() => setViewingItemLocations(item)}
                      title="View Locations"
                      style={{ background: '#17a2b8', color: 'white' }}
                    >
                      📍
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => loadItemHistory(item)}
                      title="View History"
                      style={{ background: '#9c27b0', color: 'white' }}
                    >
                      📜
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => printQR(item)}
                      title="Print QR"
                    >
                      🖨️
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => deleteItem(item.id)}
                      title="Delete"
                    >
                      🗑️
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {sortedItems.length === 0 && (
          <div className="empty-state">
            <p>{hasActiveFilters ? 'No items match your filters' : 'No items found'}</p>
            {hasActiveFilters && (
              <button 
                className="btn btn-primary" 
                onClick={clearFilters}
                style={{ marginTop: 10 }}
              >
                Clear Filters
              </button>
            )}
          </div>
        )}
      </div>

      {/* Add Item Modal */}
      {showAddItem && (
        <div className="modal-overlay" onClick={() => setShowAddItem(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div className="modal-header">
              <h2>Add New Item</h2>
              <button className="modal-close" onClick={() => setShowAddItem(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>SKU / Part Number</label>
                <input
                  type="text"
                  className="form-input"
                  value={newItem.partNumber}
                  onChange={e => setNewItem({ ...newItem, partNumber: e.target.value })}
                  placeholder="Enter SKU..."
                />
              </div>
              <div className="form-group">
                <label>Item Name *</label>
                <input
                  type="text"
                  className="form-input"
                  value={newItem.name}
                  onChange={e => setNewItem({ ...newItem, name: e.target.value })}
                  placeholder="Enter item name..."
                />
              </div>
              <div className="form-group">
                <label>Category</label>
                <input
                  type="text"
                  className="form-input"
                  value={newItem.category}
                  onChange={e => setNewItem({ ...newItem, category: e.target.value })}
                  placeholder="Enter category..."
                  list="category-list"
                />
                <datalist id="category-list">
                  {categories.map(cat => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>
              </div>
              
              <div className="form-group">
                <label>Price</label>
                <input
                  type="number"
                  className="form-input"
                  value={newItem.price}
                  onChange={e => setNewItem({ ...newItem, price: e.target.value })}
                  min="0"
                  step="0.01"
                />
              </div>

              {/* Location Mode Toggle */}
              <div style={{ 
                background: '#f5f5f5', 
                padding: 15, 
                borderRadius: 8, 
                marginBottom: 15 
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={useMultiLocation}
                    onChange={e => setUseMultiLocation(e.target.checked)}
                  />
                  <span style={{ fontWeight: 500 }}>Split quantity across multiple locations</span>
                </label>
              </div>

              {!useMultiLocation ? (
                /* Single Location Mode */
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>
                    <div className="form-group">
                      <label>Quantity</label>
                      <input
                        type="number"
                        className="form-input"
                        value={newItem.stock}
                        onChange={e => setNewItem({ ...newItem, stock: e.target.value })}
                        min="0"
                      />
                    </div>
                    <div className="form-group">
                      <label>Location</label>
                      <select
                        className="form-input"
                        value={newItem.location}
                        onChange={e => setNewItem({ ...newItem, location: e.target.value })}
                      >
                        <option value="">-- Select Location --</option>
                        {locationOptions.map(loc => (
                          <option key={loc} value={loc}>{loc}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </>
              ) : (
                /* Multi-Location Mode */
                <div className="form-group">
                  <label style={{ marginBottom: 10, display: 'block' }}>Location Breakdown</label>
                  {newItem.locationBreakdown.map((lb, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: 10, marginBottom: 8, alignItems: 'center' }}>
                      <select
                        className="form-input"
                        value={lb.location}
                        onChange={e => {
                          const updated = [...newItem.locationBreakdown];
                          updated[idx].location = e.target.value;
                          setNewItem({ ...newItem, locationBreakdown: updated });
                        }}
                        style={{ flex: 2 }}
                      >
                        <option value="">-- Select Location --</option>
                        {locationOptions.map(loc => (
                          <option key={loc} value={loc}>{loc}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        className="form-input"
                        placeholder="Qty"
                        value={lb.quantity}
                        onChange={e => {
                          const updated = [...newItem.locationBreakdown];
                          updated[idx].quantity = parseInt(e.target.value) || 0;
                          setNewItem({ ...newItem, locationBreakdown: updated });
                        }}
                        min="0"
                        style={{ flex: 1 }}
                      />
                      {newItem.locationBreakdown.length > 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            const updated = newItem.locationBreakdown.filter((_, i) => i !== idx);
                            setNewItem({ ...newItem, locationBreakdown: updated });
                          }}
                          style={{ 
                            background: '#f44336', 
                            color: 'white', 
                            border: 'none', 
                            borderRadius: 4, 
                            padding: '8px 12px',
                            cursor: 'pointer'
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setNewItem({
                        ...newItem,
                        locationBreakdown: [...newItem.locationBreakdown, { location: '', quantity: 0 }]
                      });
                    }}
                    style={{ 
                      background: '#2196F3', 
                      color: 'white', 
                      border: 'none', 
                      borderRadius: 4, 
                      padding: '8px 15px',
                      cursor: 'pointer',
                      marginTop: 5
                    }}
                  >
                    + Add Location
                  </button>
                  <div style={{ 
                    marginTop: 10, 
                    padding: 10, 
                    background: '#e8f5e9', 
                    borderRadius: 4,
                    fontWeight: 500 
                  }}>
                    Total: {newItem.locationBreakdown.reduce((sum, lb) => sum + (parseInt(lb.quantity) || 0), 0)} units
                  </div>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>
                <div className="form-group">
                  <label>Low Stock Alert</label>
                  <input
                    type="number"
                    className="form-input"
                    value={newItem.lowStockThreshold}
                    onChange={e => setNewItem({ ...newItem, lowStockThreshold: parseInt(e.target.value) || 0 })}
                    min="0"
                    title="Alert when stock falls below this number"
                  />
                  <small style={{ color: '#666', fontSize: 11 }}>Alert when below this</small>
                </div>
                <div className="form-group">
                  <label>Reorder Point</label>
                  <input
                    type="number"
                    className="form-input"
                    value={newItem.reorderPoint}
                    onChange={e => setNewItem({ ...newItem, reorderPoint: parseInt(e.target.value) || 0 })}
                    min="0"
                    title="Recommended reorder when stock falls to this level"
                  />
                  <small style={{ color: '#666', fontSize: 11 }}>Reorder at this level</small>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => { setShowAddItem(false); setUseMultiLocation(false); }}>Cancel</button>
              <button className="btn btn-primary" onClick={addNewItem}>Add Item</button>
            </div>
          </div>
        </div>
      )}

      {/* Quantity Adjustment Popup */}
      {adjustingItem && (
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
          onClick={() => setAdjustingItem(null)}
        >
          <div 
            onClick={e => e.stopPropagation()} 
            style={{ 
              background: 'white',
              borderRadius: 12,
              boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
              width: 340,
              overflow: 'hidden'
            }}
          >
            {/* Header */}
            <div style={{ 
              background: adjustingItem.adjustType === 'add' ? '#4CAF50' : '#f44336',
              color: 'white',
              padding: '12px 15px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>
                {adjustingItem.adjustType === 'add' ? '➕ Add' : '➖ Remove'} Quantity
              </h3>
              <button 
                onClick={() => setAdjustingItem(null)}
                style={{ 
                  background: 'none', 
                  border: 'none', 
                  color: 'white', 
                  fontSize: 20, 
                  cursor: 'pointer' 
                }}
              >
                ×
              </button>
            </div>
            
            {/* Body */}
            <div style={{ padding: 15 }}>
              <div style={{ textAlign: 'center', marginBottom: 15 }}>
                <div style={{ fontWeight: 'bold', fontSize: 14 }}>{adjustingItem.name || 'Unnamed Item'}</div>
                <div style={{ color: '#666', fontSize: 12 }}>{adjustingItem.partNumber || 'No SKU'}</div>
              </div>
              
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center',
                gap: 10,
                marginBottom: 15
              }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: '#666' }}>Current</div>
                  <div style={{ fontSize: 22, fontWeight: 'bold' }}>{adjustingItem.stock || 0}</div>
                </div>
                
                <div style={{ fontSize: 20, color: adjustingItem.adjustType === 'add' ? '#4CAF50' : '#f44336' }}>
                  {adjustingItem.adjustType === 'add' ? '+' : '−'}
                </div>
                
                <input
                  type="number"
                  value={adjustingItem.adjustQty}
                  onChange={e => setAdjustingItem({ ...adjustingItem, adjustQty: e.target.value })}
                  min="1"
                  style={{ 
                    width: 60, 
                    fontSize: 20, 
                    textAlign: 'center',
                    padding: 8,
                    border: '2px solid #ddd',
                    borderRadius: 6
                  }}
                  autoFocus
                />
                
                <div style={{ fontSize: 20, color: '#666' }}>=</div>
                
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: '#666' }}>New</div>
                  <div style={{ 
                    fontSize: 22, 
                    fontWeight: 'bold',
                    color: adjustingItem.adjustType === 'add' ? '#4CAF50' : '#f44336'
                  }}>
                    {adjustingItem.adjustType === 'add' 
                      ? (parseInt(adjustingItem.stock) || 0) + (parseInt(adjustingItem.adjustQty) || 0)
                      : Math.max(0, (parseInt(adjustingItem.stock) || 0) - (parseInt(adjustingItem.adjustQty) || 0))
                    }
                  </div>
                </div>
              </div>

              {/* Quick buttons */}
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 15 }}>
                {[1, 5, 10, 25, 50].map(num => (
                  <button
                    key={num}
                    onClick={() => setAdjustingItem({ ...adjustingItem, adjustQty: num })}
                    style={{
                      padding: '6px 10px',
                      border: adjustingItem.adjustQty == num ? '2px solid #4a5d23' : '1px solid #ddd',
                      borderRadius: 4,
                      background: adjustingItem.adjustQty == num ? '#e8f5e9' : 'white',
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: adjustingItem.adjustQty == num ? 'bold' : 'normal'
                    }}
                  >
                    {num}
                  </button>
                ))}
              </div>
              
              {/* Buttons */}
              <div style={{ display: 'flex', gap: 10 }}>
                <button 
                  onClick={() => setAdjustingItem(null)}
                  style={{ 
                    flex: 1,
                    padding: '10px',
                    border: '1px solid #ddd',
                    borderRadius: 6,
                    background: 'white',
                    cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
                <button 
                  onClick={applyAdjustment}
                  style={{ 
                    flex: 1,
                    padding: '10px',
                    border: 'none',
                    borderRadius: 6,
                    background: adjustingItem.adjustType === 'add' ? '#4CAF50' : '#f44336',
                    color: 'white',
                    cursor: 'pointer',
                    fontWeight: 'bold'
                  }}
                >
                  {adjustingItem.adjustType === 'add' ? 'Add' : 'Remove'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Item Locations Popup */}
      {viewingItemLocations && (
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
          onClick={() => setViewingItemLocations(null)}
        >
          <div 
            onClick={e => e.stopPropagation()} 
            style={{ 
              background: 'white',
              borderRadius: 12,
              boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
              width: '90%',
              maxWidth: 450,
              maxHeight: '80vh',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            {/* Header */}
            <div style={{ 
              background: '#17a2b8',
              color: 'white',
              padding: '12px 15px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>
                📍 Item Locations
              </h3>
              <button 
                onClick={() => setViewingItemLocations(null)}
                style={{ 
                  background: 'none', 
                  border: 'none', 
                  color: 'white', 
                  fontSize: 20, 
                  cursor: 'pointer' 
                }}
              >
                ×
              </button>
            </div>
            
            {/* Body */}
            <div style={{ padding: 15, overflowY: 'auto', flex: 1 }}>
              <div style={{ textAlign: 'center', marginBottom: 15 }}>
                <div style={{ fontWeight: 'bold', fontSize: 16 }}>
                  {viewingItemLocations.name || 'Unnamed Item'}
                </div>
                <div style={{ color: '#666', fontSize: 13 }}>
                  SKU: {viewingItemLocations.partNumber || 'N/A'}
                </div>
              </div>
              
              {getItemLocations(viewingItemLocations.id).length > 0 ? (
                <>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                    <thead>
                      <tr style={{ background: '#f5f5f5' }}>
                        <th style={{ padding: 10, textAlign: 'left', borderBottom: '2px solid #ddd' }}>Location</th>
                        <th style={{ padding: 10, textAlign: 'right', borderBottom: '2px solid #ddd' }}>Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {getItemLocations(viewingItemLocations.id).map((loc, idx) => (
                        <tr key={idx}>
                          <td style={{ padding: 10, borderBottom: '1px solid #eee' }}>
                            {loc.locationCode}
                            {loc.isUnmapped && (
                              <span style={{ 
                                marginLeft: 8, 
                                fontSize: 11, 
                                color: '#ff9800',
                                background: '#fff3e0',
                                padding: '2px 6px',
                                borderRadius: 4
                              }}>
                                (from import)
                              </span>
                            )}
                          </td>
                          <td style={{ padding: 10, borderBottom: '1px solid #eee', textAlign: 'right', fontWeight: 'bold' }}>
                            {loc.quantity}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: '#e8f5e9' }}>
                        <td style={{ padding: 10, fontWeight: 'bold' }}>Total in Locations</td>
                        <td style={{ padding: 10, textAlign: 'right', fontWeight: 'bold', fontSize: 16, color: '#2d5f3f' }}>
                          {getTotalInLocations(viewingItemLocations.id)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                  
                  {/* Show discrepancy if item stock doesn't match location totals */}
                  {viewingItemLocations.stock !== getTotalInLocations(viewingItemLocations.id) && (
                    <div style={{ 
                      marginTop: 15, 
                      padding: 10, 
                      background: '#fff3cd', 
                      borderRadius: 6,
                      fontSize: 13
                    }}>
                      ⚠️ <strong>Note:</strong> Item stock ({viewingItemLocations.stock || 0}) differs from location total ({getTotalInLocations(viewingItemLocations.id)})
                    </div>
                  )}
                </>
              ) : (
                <div style={{ 
                  textAlign: 'center', 
                  padding: 30, 
                  color: '#666',
                  background: '#f5f5f5',
                  borderRadius: 8
                }}>
                  <div style={{ fontSize: 40, marginBottom: 10 }}>📦</div>
                  <p style={{ margin: 0 }}>This item is not assigned to any locations yet.</p>
                  <p style={{ margin: '10px 0 0 0', fontSize: 13 }}>
                    Use the Scanner or Movements tab to add inventory to a location.
                  </p>
                </div>
              )}
            </div>
            
            {/* Footer */}
            <div style={{ padding: 15, borderTop: '1px solid #eee' }}>
              <button 
                onClick={() => setViewingItemLocations(null)}
                style={{ 
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #ddd',
                  borderRadius: 6,
                  background: 'white',
                  cursor: 'pointer'
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Item History Modal */}
      {viewingItemHistory && (
        <div 
          className="modal-overlay"
          onClick={() => setViewingItemHistory(null)}
        >
          <div 
            className="modal"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: 600, maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
          >
            <div className="modal-header">
              <h2>📜 Item History</h2>
              <button className="modal-close" onClick={() => setViewingItemHistory(null)}>×</button>
            </div>
            
            <div style={{ padding: '15px 20px', borderBottom: '1px solid #eee', background: '#f9f9f9' }}>
              <div style={{ fontWeight: 600, fontSize: 16 }}>{viewingItemHistory.name}</div>
              <div style={{ color: '#666', fontSize: 13 }}>
                SKU: {viewingItemHistory.partNumber || 'N/A'} | 
                Current Stock: {viewingItemHistory.stock || 0}
              </div>
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
              {loadingHistory ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>
                  Loading history...
                </div>
              ) : itemHistory.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>
                  No history found for this item
                </div>
              ) : (
                <div style={{ position: 'relative' }}>
                  {/* Timeline line */}
                  <div style={{
                    position: 'absolute',
                    left: 15,
                    top: 0,
                    bottom: 0,
                    width: 2,
                    background: '#e0e0e0'
                  }} />
                  
                  {itemHistory.map((entry, idx) => {
                    const formatted = formatHistoryEntry(entry);
                    return (
                      <div key={entry.id || idx} style={{ 
                        display: 'flex', 
                        gap: 15, 
                        marginBottom: 20,
                        position: 'relative'
                      }}>
                        {/* Timeline dot */}
                        <div style={{
                          width: 32,
                          height: 32,
                          borderRadius: '50%',
                          background: formatted.color,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 14,
                          flexShrink: 0,
                          zIndex: 1
                        }}>
                          {formatted.icon}
                        </div>
                        
                        {/* Content */}
                        <div style={{ flex: 1 }}>
                          <div style={{ 
                            display: 'flex', 
                            justifyContent: 'space-between',
                            alignItems: 'flex-start',
                            marginBottom: 4
                          }}>
                            <span style={{ 
                              fontWeight: 600, 
                              color: formatted.color,
                              fontSize: 13
                            }}>
                              {formatted.title}
                            </span>
                            <span style={{ fontSize: 11, color: '#999' }}>
                              {new Date(formatted.timestamp).toLocaleString()}
                            </span>
                          </div>
                          <div style={{ fontSize: 13, color: '#333', marginBottom: 4 }}>
                            {formatted.description}
                          </div>
                          <div style={{ fontSize: 11, color: '#666' }}>
                            by {formatted.user}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            
            <div className="modal-footer">
              <button className="btn" onClick={() => setViewingItemHistory(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
