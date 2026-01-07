import { useState, useEffect, useRef } from 'react';
import { BrowserMultiFormatReader } from '@zxing/library';
import { DB } from '../db';

export default function PickLists() {
  const [pickLists, setPickLists] = useState([]);
  const [items, setItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedList, setSelectedList] = useState(null);
  
  // QR Scanner state
  const [scanMode, setScanMode] = useState(false);
  const [scanMessage, setScanMessage] = useState('');
  const videoRef = useRef(null);
  const readerRef = useRef(null);
  
  // New pick list form
  const [newList, setNewList] = useState({
    name: '',
    notes: '',
    items: []
  });
  const [searchItem, setSearchItem] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [lists, itemsData, locsData] = await Promise.all([
      DB.getPickLists(),
      DB.getItems(),
      DB.getLocations()
    ]);
    setPickLists(lists);
    setItems(itemsData);
    setLocations(locsData);
    setLoading(false);
  };

  const filteredItems = items.filter(item => 
    searchItem && (
      item.name?.toLowerCase().includes(searchItem.toLowerCase()) ||
      item.partNumber?.toLowerCase().includes(searchItem.toLowerCase())
    )
  );

  const addItemToList = (item) => {
    if (newList.items.find(i => i.itemId === item.id)) return;
    
    setNewList({
      ...newList,
      items: [...newList.items, {
        itemId: item.id,
        itemName: item.name,
        partNumber: item.partNumber,
        requestedQty: 1,
        pickedQty: 0,
        location: item.location || ''
      }]
    });
    setSearchItem('');
  };

  const updateListItem = (itemId, field, value) => {
    setNewList({
      ...newList,
      items: newList.items.map(i => 
        i.itemId === itemId ? { ...i, [field]: value } : i
      )
    });
  };

  const removeItemFromList = (itemId) => {
    setNewList({
      ...newList,
      items: newList.items.filter(i => i.itemId !== itemId)
    });
  };

  const createPickList = async () => {
    if (!newList.name || newList.items.length === 0) {
      alert('Enter a name and add at least one item');
      return;
    }

    await DB.createPickList(newList);
    setNewList({ name: '', notes: '', items: [] });
    setShowCreate(false);
    loadData();
  };

  const updatePickedQty = async (list, itemId, qty) => {
    const updatedItems = list.items.map(i =>
      i.itemId === itemId ? { ...i, pickedQty: parseInt(qty) || 0 } : i
    );
    
    await DB.updatePickList(list.id, { items: updatedItems });
    loadData();
  };

  const completePickList = async (list) => {
    // Process each picked item
    for (const item of list.items) {
      if (item.pickedQty > 0) {
        const dbItem = items.find(i => i.id === item.itemId);
        if (dbItem) {
          // Log the pick movement
          await DB.logMovement({
            itemId: item.itemId,
            itemName: item.itemName,
            quantity: item.pickedQty,
            type: 'PICK',
            fromLocation: item.location || 'Unknown',
            timestamp: Date.now()
          });
          
          // Update stock
          await DB.updateItemStock(item.itemId, Math.max(0, (dbItem.stock || 0) - item.pickedQty));
        }
      }
    }
    
    await DB.updatePickList(list.id, { status: 'completed' });
    setSelectedList(null);
    loadData();
  };

  // QR Scanner functions
  const startScanner = async () => {
    setScanMode(true);
    setScanMessage('Starting camera...');
    
    try {
      readerRef.current = new BrowserMultiFormatReader();
      const videoInputDevices = await readerRef.current.listVideoInputDevices();
      
      if (videoInputDevices.length === 0) {
        setScanMessage('No camera found');
        return;
      }

      // Prefer back camera on mobile
      const backCamera = videoInputDevices.find(d => d.label.toLowerCase().includes('back'));
      const deviceId = backCamera?.deviceId || videoInputDevices[0].deviceId;

      setScanMessage('Point camera at item QR code...');

      readerRef.current.decodeFromVideoDevice(deviceId, videoRef.current, (result, error) => {
        if (result) {
          handleQRScan(result.getText());
        }
      });
    } catch (err) {
      setScanMessage('Camera error: ' + err.message);
    }
  };

  const stopScanner = () => {
    if (readerRef.current) {
      readerRef.current.reset();
    }
    setScanMode(false);
    setScanMessage('');
  };

  const handleQRScan = async (qrData) => {
    if (!selectedList) return;
    
    // Find item by SKU/partNumber (QR code contains the SKU)
    const scannedItem = items.find(i => 
      i.partNumber === qrData || 
      i.id === qrData ||
      i.partNumber?.toLowerCase() === qrData.toLowerCase()
    );
    
    if (!scannedItem) {
      setScanMessage(`❌ Item not found: ${qrData}`);
      setTimeout(() => setScanMessage('Point camera at item QR code...'), 2000);
      return;
    }

    // Check if this item is in the pick list
    const pickListItem = selectedList.items?.find(i => i.itemId === scannedItem.id);
    
    if (!pickListItem) {
      setScanMessage(`⚠️ "${scannedItem.name}" is not on this pick list`);
      setTimeout(() => setScanMessage('Point camera at item QR code...'), 2000);
      return;
    }

    if (pickListItem.pickedQty >= pickListItem.requestedQty) {
      setScanMessage(`✅ "${scannedItem.name}" already fully picked`);
      setTimeout(() => setScanMessage('Point camera at item QR code...'), 2000);
      return;
    }

    // Stop scanner and prompt for quantity
    stopScanner();
    
    const remaining = pickListItem.requestedQty - (pickListItem.pickedQty || 0);
    const qty = prompt(
      `📦 ${scannedItem.name}\n\nRequested: ${pickListItem.requestedQty}\nAlready picked: ${pickListItem.pickedQty || 0}\nRemaining: ${remaining}\n\nEnter quantity picked:`,
      remaining.toString()
    );

    if (qty !== null && !isNaN(parseInt(qty))) {
      const newPickedQty = (pickListItem.pickedQty || 0) + parseInt(qty);
      await updatePickedQty(selectedList, scannedItem.id, Math.min(newPickedQty, pickListItem.requestedQty));
      
      // Refresh selected list
      const updatedLists = await DB.getPickLists();
      const updatedList = updatedLists.find(l => l.id === selectedList.id);
      setSelectedList(updatedList);
    }
  };

  const getStatusColor = (status) => {
    switch(status) {
      case 'completed': return '#4CAF50';
      case 'in_progress': return '#ff9800';
      default: return '#2196F3';
    }
  };

  const deletePickList = async (list) => {
    if (!confirm(`Delete pick list "${list.name}"?\n\nThis cannot be undone.`)) return;
    
    await DB.deletePickList(list.id);
    loadData();
  };

  const printPickList = (list) => {
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <html>
        <head>
          <title>Pick List - ${list.name}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; border-bottom: 2px solid #2d5f3f; padding-bottom: 15px; }
            .title { font-size: 24px; font-weight: bold; color: #2d5f3f; }
            .meta { text-align: right; color: #666; font-size: 14px; }
            .status { display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: bold; background: ${getStatusColor(list.status)}; color: white; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
            th { background: #2d5f3f; color: white; padding: 12px; text-align: left; }
            td { padding: 12px; border-bottom: 1px solid #ddd; }
            .text-center { text-align: center; }
            .location { font-size: 12px; color: #2d5f3f; margin-top: 4px; }
            .sku { font-size: 12px; color: #666; }
            .pick-box { width: 50px; height: 30px; border: 2px solid #333; display: inline-block; }
            .notes { margin-top: 20px; padding: 15px; background: #f5f5f5; border-radius: 8px; }
            .footer { margin-top: 40px; text-align: center; color: #666; font-size: 12px; }
            .signature { margin-top: 40px; display: flex; justify-content: space-between; }
            .signature-line { width: 200px; border-top: 1px solid #333; padding-top: 5px; text-align: center; }
            @media print { body { padding: 20px; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="title">📋 PICK LIST: ${list.name}</div>
            <div class="meta">
              <div class="status">${list.status?.toUpperCase()}</div>
              <div style="margin-top: 8px;">Created: ${formatDate(list.createdAt)}</div>
              <div>By: ${list.createdBy}</div>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th style="width: 40px">#</th>
                <th>Item</th>
                <th class="text-center" style="width: 100px">Location</th>
                <th class="text-center" style="width: 80px">Requested</th>
                <th class="text-center" style="width: 80px">Picked</th>
                <th class="text-center" style="width: 60px">✓</th>
              </tr>
            </thead>
            <tbody>
              ${list.items?.map((item, idx) => `
                <tr>
                  <td class="text-center">${idx + 1}</td>
                  <td>
                    <strong>${item.itemName}</strong>
                    <div class="sku">${item.partNumber || ''}</div>
                  </td>
                  <td class="text-center"><strong>${item.location || '-'}</strong></td>
                  <td class="text-center"><strong>${item.requestedQty}</strong></td>
                  <td class="text-center">${list.status === 'completed' ? item.pickedQty : '<div class="pick-box"></div>'}</td>
                  <td class="text-center">${list.status === 'completed' ? (item.pickedQty >= item.requestedQty ? '✅' : '⚠️') : '☐'}</td>
                </tr>
              `).join('') || ''}
            </tbody>
          </table>

          ${list.notes ? `<div class="notes"><strong>Notes:</strong> ${list.notes}</div>` : ''}

          <div class="signature">
            <div class="signature-line">Picker Signature</div>
            <div class="signature-line">Date</div>
            <div class="signature-line">Verified By</div>
          </div>

          <div class="footer">
            <p>Printed: ${new Date().toLocaleString()}</p>
          </div>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
  };

  const formatDate = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  if (loading) {
    return <div className="page-content"><div className="loading">Loading...</div></div>;
  }

  return (
    <div className="page-content">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2>Pick Lists</h2>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          + New Pick List
        </button>
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 1000, padding: 20
        }}>
          <div style={{
            background: 'white', borderRadius: 12, padding: 30,
            maxWidth: 600, width: '100%', maxHeight: '90vh', overflow: 'auto'
          }}>
            <h3 style={{ marginBottom: 20 }}>Create Pick List</h3>
            
            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Name</label>
              <input
                type="text"
                className="form-input"
                placeholder="Order #123, Customer Name, etc."
                value={newList.name}
                onChange={e => setNewList({ ...newList, name: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Notes</label>
              <textarea
                className="form-input"
                placeholder="Optional notes..."
                value={newList.notes}
                onChange={e => setNewList({ ...newList, notes: e.target.value })}
                style={{ width: '100%', minHeight: 60 }}
              />
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Add Items</label>
              <input
                type="text"
                className="form-input"
                placeholder="Search items..."
                value={searchItem}
                onChange={e => setSearchItem(e.target.value)}
                style={{ width: '100%' }}
              />
              {filteredItems.length > 0 && (
                <div style={{ border: '1px solid #ddd', borderRadius: 4, maxHeight: 150, overflow: 'auto', marginTop: 5 }}>
                  {filteredItems.slice(0, 10).map(item => (
                    <div
                      key={item.id}
                      onClick={() => addItemToList(item)}
                      style={{ padding: 10, borderBottom: '1px solid #eee', cursor: 'pointer' }}
                    >
                      <strong>{item.name}</strong>
                      <span style={{ color: '#666', marginLeft: 10 }}>{item.partNumber}</span>
                      <span style={{ color: '#2d5f3f', marginLeft: 10 }}>Stock: {item.stock || 0}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Items in list */}
            {newList.items.length > 0 && (
              <div style={{ marginBottom: 15 }}>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>
                  Items to Pick ({newList.items.length})
                </label>
                <div style={{ border: '1px solid #ddd', borderRadius: 4 }}>
                  {newList.items.map(item => (
                    <div key={item.itemId} style={{ padding: 10, borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <strong>{item.itemName}</strong>
                        <div style={{ fontSize: 12, color: '#666' }}>{item.partNumber}</div>
                      </div>
                      <input
                        type="number"
                        value={item.requestedQty}
                        onChange={e => updateListItem(item.itemId, 'requestedQty', parseInt(e.target.value) || 1)}
                        style={{ width: 60, padding: 5, textAlign: 'center' }}
                        min="1"
                      />
                      <button
                        onClick={() => removeItemFromList(item.itemId)}
                        style={{ background: '#f44336', color: 'white', border: 'none', borderRadius: 4, padding: '5px 10px', cursor: 'pointer' }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={createPickList} style={{ flex: 1 }}>
                Create Pick List
              </button>
              <button className="btn" onClick={() => setShowCreate(false)} style={{ flex: 1, background: '#6c757d', color: 'white' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View/Process Modal */}
      {selectedList && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 1000, padding: 20
        }}>
          <div style={{
            background: 'white', borderRadius: 12, padding: 30,
            maxWidth: 700, width: '100%', maxHeight: '90vh', overflow: 'auto'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3>{selectedList.name}</h3>
              <span style={{
                padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                background: getStatusColor(selectedList.status), color: 'white'
              }}>
                {selectedList.status?.toUpperCase()}
              </span>
            </div>

            {selectedList.notes && (
              <p style={{ color: '#666', marginBottom: 15 }}>{selectedList.notes}</p>
            )}

            {/* QR Scanner Section */}
            {selectedList.status !== 'completed' && (
              <div style={{ marginBottom: 20, padding: 15, background: '#e3f2fd', borderRadius: 8 }}>
                {!scanMode ? (
                  <button 
                    className="btn btn-primary"
                    onClick={startScanner}
                    style={{ width: '100%' }}
                  >
                    📷 Scan Item QR Code
                  </button>
                ) : (
                  <div>
                    <div style={{ position: 'relative', marginBottom: 10 }}>
                      <video 
                        ref={videoRef} 
                        style={{ width: '100%', maxHeight: 250, borderRadius: 8, background: '#000' }}
                      />
                      <button
                        onClick={stopScanner}
                        style={{
                          position: 'absolute', top: 10, right: 10,
                          background: 'rgba(0,0,0,0.7)', color: 'white',
                          border: 'none', borderRadius: 4, padding: '5px 10px', cursor: 'pointer'
                        }}
                      >
                        ✕ Close
                      </button>
                    </div>
                    <p style={{ textAlign: 'center', margin: 0, fontWeight: 500 }}>{scanMessage}</p>
                  </div>
                )}
              </div>
            )}

            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f5f5' }}>
                  <th style={{ padding: 10, textAlign: 'left' }}>Item</th>
                  <th style={{ padding: 10, textAlign: 'center', width: 80 }}>Requested</th>
                  <th style={{ padding: 10, textAlign: 'center', width: 100 }}>Picked</th>
                  <th style={{ padding: 10, textAlign: 'center', width: 80 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {selectedList.items?.map(item => (
                  <tr key={item.itemId} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: 10 }}>
                      <strong>{item.itemName}</strong>
                      <div style={{ fontSize: 12, color: '#666' }}>{item.partNumber}</div>
                      {item.location && <div style={{ fontSize: 11, color: '#2d5f3f' }}>📍 {item.location}</div>}
                    </td>
                    <td style={{ padding: 10, textAlign: 'center' }}>{item.requestedQty}</td>
                    <td style={{ padding: 10, textAlign: 'center' }}>
                      {selectedList.status === 'completed' ? (
                        item.pickedQty
                      ) : (
                        <input
                          type="number"
                          value={item.pickedQty || 0}
                          onChange={e => updatePickedQty(selectedList, item.itemId, e.target.value)}
                          style={{ width: 60, padding: 5, textAlign: 'center' }}
                          min="0"
                          max={item.requestedQty}
                        />
                      )}
                    </td>
                    <td style={{ padding: 10, textAlign: 'center' }}>
                      {item.pickedQty >= item.requestedQty ? '✅' : item.pickedQty > 0 ? '🔶' : '⬜'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              {selectedList.status !== 'completed' && (
                <button 
                  className="btn btn-primary" 
                  onClick={() => completePickList(selectedList)}
                  style={{ flex: 1 }}
                >
                  ✓ Complete Pick List
                </button>
              )}
              <button 
                className="btn" 
                onClick={() => setSelectedList(null)} 
                style={{ flex: 1, background: '#6c757d', color: 'white' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pick Lists Table */}
      <div className="data-table">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Items</th>
              <th>Status</th>
              <th>Created</th>
              <th>Created By</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pickLists.map(list => (
              <tr key={list.id}>
                <td><strong>{list.name}</strong></td>
                <td>{list.items?.length || 0} items</td>
                <td>
                  <span style={{
                    padding: '4px 8px', borderRadius: 4, fontSize: 12,
                    background: getStatusColor(list.status), color: 'white'
                  }}>
                    {list.status}
                  </span>
                </td>
                <td style={{ fontSize: 13 }}>{formatDate(list.createdAt)}</td>
                <td style={{ fontSize: 13 }}>{list.createdBy}</td>
                <td>
                  <div className="action-buttons">
                    <button 
                      className="btn btn-primary btn-sm"
                      onClick={() => setSelectedList(list)}
                    >
                      {list.status === 'completed' ? 'View' : 'Process'}
                    </button>
                    <button 
                      className="btn btn-sm"
                      onClick={() => printPickList(list)}
                      style={{ background: '#9c27b0', color: 'white' }}
                    >
                      🖨️ Print
                    </button>
                    <button 
                      className="btn btn-danger btn-sm"
                      onClick={() => deletePickList(list)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {pickLists.length === 0 && (
              <tr>
                <td colSpan="6">
                  <div className="empty-state">
                    <p>No pick lists yet</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
