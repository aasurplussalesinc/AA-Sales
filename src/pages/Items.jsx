import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { DB } from '../db';

export default function Items() {
  const [items, setItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

  // Add Item modal state
  const [showAddItem, setShowAddItem] = useState(false);
  const [newItem, setNewItem] = useState({
    partNumber: '',
    name: '',
    category: '',
    stock: 0,
    price: 0,
    location: ''
  });

  // Filter states
  const [filters, setFilters] = useState({
    sku: '',
    name: '',
    category: '',
    quantity: '',
    location: '',
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
    setLocations(locsData);
    setLoading(false);
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

  // Add new item
  const addNewItem = async () => {
    if (!newItem.name && !newItem.partNumber) {
      alert('Please enter at least a name or SKU');
      return;
    }

    await DB.createItem({
      partNumber: newItem.partNumber,
      name: newItem.name,
      category: newItem.category,
      stock: parseInt(newItem.stock) || 0,
      price: parseFloat(newItem.price) || 0,
      location: newItem.location
    });

    setNewItem({
      partNumber: '',
      name: '',
      category: '',
      stock: 0,
      price: 0,
      location: ''
    });
    setShowAddItem(false);
    loadData();
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

        // Parse data rows
        const newItems = [];
        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          if (values.length === 0) continue;

          const item = {
            partNumber: columnIndices.sku !== undefined ? values[columnIndices.sku]?.trim() : '',
            name: columnIndices.name !== undefined ? values[columnIndices.name]?.trim() : '',
            category: columnIndices.category !== undefined ? values[columnIndices.category]?.trim() : '',
            stock: columnIndices.stock !== undefined ? parseInt(values[columnIndices.stock]) || 0 : 0,
            price: columnIndices.price !== undefined ? parseFloat(values[columnIndices.price]?.replace(/[^0-9.-]/g, '')) || 0 : 0,
            location: columnIndices.location !== undefined ? values[columnIndices.location]?.trim() : '',
            createdAt: Date.now()
          };

          // Skip empty rows
          if (item.name || item.partNumber) {
            newItems.push(item);
          }
        }

        if (newItems.length === 0) {
          alert('No valid items found in CSV');
          setImporting(false);
          return;
        }

        // Confirm replace all
        if (!confirm(`This will REPLACE ALL existing inventory with ${newItems.length} items from the CSV.\n\nAre you sure?`)) {
          setImporting(false);
          return;
        }

        // Import to database
        const result = await DB.importItems(newItems);
        alert(`Import complete!\n\n✓ ${result.deleted} old items removed\n✓ ${result.added} new items imported`);
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

      {/* Results count */}
      <p style={{ marginBottom: 10, color: '#666' }}>
        Showing {sortedItems.length} of {items.length} items
        {hasActiveFilters && ' (filtered)'}
      </p>

      {/* Data table */}
      <div className="data-table">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <input
                  type="checkbox"
                  checked={selectedItems.length === sortedItems.length && sortedItems.length > 0}
                  onChange={(e) => e.target.checked ? selectAllFiltered() : clearSelection()}
                />
              </th>
              <th>SKU</th>
              <th>Item Name</th>
              <th>Category</th>
              <th>Quantity</th>
              <th>Price</th>
              <th>Location</th>
              <th>Date Added</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map(item => (
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
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={item.name || ''}
                    onChange={e => updateItem(item.id, 'name', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={item.category || ''}
                    onChange={e => updateItem(item.id, 'category', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    value={item.stock || 0}
                    onChange={e => updateItem(item.id, 'stock', e.target.value)}
                    style={{ width: '80px' }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    value={item.price || 0}
                    onChange={e => updateItem(item.id, 'price', parseFloat(e.target.value) || 0)}
                    style={{ width: '90px' }}
                    step="0.01"
                    min="0"
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={item.location || ''}
                    onChange={e => updateItem(item.id, 'location', e.target.value)}
                  />
                </td>
                <td style={{ whiteSpace: 'nowrap', color: '#666', fontSize: 13 }}>
                  {formatDate(item.createdAt)}
                </td>
                <td>
                  <div className="action-buttons">
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
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowAddItem(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={addNewItem}>Add Item</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
