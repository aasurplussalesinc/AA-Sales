import { useState, useEffect } from 'react';
import { DB } from '../db';

export default function Receiving() {
  const [receivings, setReceivings] = useState([]);
  const [items, setItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedReceiving, setSelectedReceiving] = useState(null);
  
  // New receiving form
  const [newReceiving, setNewReceiving] = useState({
    poNumber: '',
    supplier: '',
    notes: '',
    items: []
  });
  const [searchItem, setSearchItem] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [recData, itemsData, locsData] = await Promise.all([
      DB.getReceivings(),
      DB.getItems(),
      DB.getLocations()
    ]);
    setReceivings(recData);
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

  const addItemToReceiving = (item) => {
    if (newReceiving.items.find(i => i.itemId === item.id)) return;
    
    setNewReceiving({
      ...newReceiving,
      items: [...newReceiving.items, {
        itemId: item.id,
        itemName: item.name,
        partNumber: item.partNumber,
        expectedQty: 1,
        receivedQty: 0,
        currentStock: item.stock || 0,
        locationId: '',
        locationCode: ''
      }]
    });
    setSearchItem('');
  };

  const updateReceivingItem = (itemId, field, value) => {
    setNewReceiving({
      ...newReceiving,
      items: newReceiving.items.map(i => 
        i.itemId === itemId ? { ...i, [field]: value } : i
      )
    });
  };

  const setItemLocation = (itemId, locationId) => {
    const loc = locations.find(l => l.id === locationId);
    setNewReceiving({
      ...newReceiving,
      items: newReceiving.items.map(i => 
        i.itemId === itemId ? { 
          ...i, 
          locationId, 
          locationCode: loc ? (loc.locationCode || DB.formatLocation(loc)) : '' 
        } : i
      )
    });
  };

  const removeItemFromReceiving = (itemId) => {
    setNewReceiving({
      ...newReceiving,
      items: newReceiving.items.filter(i => i.itemId !== itemId)
    });
  };

  const createReceiving = async () => {
    if (!newReceiving.poNumber || newReceiving.items.length === 0) {
      alert('Enter a PO number and add at least one item');
      return;
    }

    await DB.createReceiving(newReceiving);
    setNewReceiving({ poNumber: '', supplier: '', notes: '', items: [] });
    setShowCreate(false);
    loadData();
  };

  const updateReceivedQty = async (receiving, itemId, qty) => {
    const updatedItems = receiving.items.map(i =>
      i.itemId === itemId ? { ...i, receivedQty: parseInt(qty) || 0 } : i
    );
    
    await DB.updateReceiving(receiving.id, { items: updatedItems });
    loadData();
  };

  const updateItemLocationInReceiving = async (receiving, itemId, locationId) => {
    const loc = locations.find(l => l.id === locationId);
    const updatedItems = receiving.items.map(i =>
      i.itemId === itemId ? { 
        ...i, 
        locationId, 
        locationCode: loc ? (loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}-${loc.shelf}`) : '' 
      } : i
    );
    
    await DB.updateReceiving(receiving.id, { items: updatedItems });
    loadData();
  };

  const completeReceiving = async (receiving) => {
    const itemsWithQty = receiving.items.filter(i => i.receivedQty > 0);
    if (itemsWithQty.length === 0) {
      alert('Enter received quantities first');
      return;
    }

    await DB.completeReceiving(receiving.id, receiving.items);
    setSelectedReceiving(null);
    loadData();
  };

  const getStatusColor = (status) => {
    switch(status) {
      case 'completed': return '#4CAF50';
      case 'in_progress': return '#ff9800';
      default: return '#2196F3';
    }
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
        <h2>Receiving</h2>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          + New Receiving
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
            maxWidth: 700, width: '100%', maxHeight: '90vh', overflow: 'auto'
          }}>
            <h3 style={{ marginBottom: 20 }}>New Receiving</h3>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15, marginBottom: 15 }}>
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>PO Number *</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="PO-12345"
                  value={newReceiving.poNumber}
                  onChange={e => setNewReceiving({ ...newReceiving, poNumber: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Supplier</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Supplier name"
                  value={newReceiving.supplier}
                  onChange={e => setNewReceiving({ ...newReceiving, supplier: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Notes</label>
              <textarea
                className="form-input"
                placeholder="Optional notes..."
                value={newReceiving.notes}
                onChange={e => setNewReceiving({ ...newReceiving, notes: e.target.value })}
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
                      onClick={() => addItemToReceiving(item)}
                      style={{ padding: 10, borderBottom: '1px solid #eee', cursor: 'pointer' }}
                    >
                      <strong>{item.name}</strong>
                      <span style={{ color: '#666', marginLeft: 10 }}>{item.partNumber}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Items in receiving */}
            {newReceiving.items.length > 0 && (
              <div style={{ marginBottom: 15 }}>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>
                  Expected Items ({newReceiving.items.length})
                </label>
                <div style={{ border: '1px solid #ddd', borderRadius: 4 }}>
                  {newReceiving.items.map(item => (
                    <div key={item.itemId} style={{ padding: 10, borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <strong>{item.itemName}</strong>
                        <div style={{ fontSize: 12, color: '#666' }}>{item.partNumber}</div>
                      </div>
                      <div>
                        <label style={{ fontSize: 11, color: '#666' }}>Expected</label>
                        <input
                          type="number"
                          value={item.expectedQty}
                          onChange={e => updateReceivingItem(item.itemId, 'expectedQty', parseInt(e.target.value) || 1)}
                          style={{ width: 60, padding: 5, textAlign: 'center' }}
                          min="1"
                        />
                      </div>
                      <button
                        onClick={() => removeItemFromReceiving(item.itemId)}
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
              <button className="btn btn-primary" onClick={createReceiving} style={{ flex: 1 }}>
                Create Receiving
              </button>
              <button className="btn" onClick={() => setShowCreate(false)} style={{ flex: 1, background: '#6c757d', color: 'white' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Process Modal */}
      {selectedReceiving && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 1000, padding: 20
        }}>
          <div style={{
            background: 'white', borderRadius: 12, padding: 30,
            maxWidth: 800, width: '100%', maxHeight: '90vh', overflow: 'auto'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3>PO: {selectedReceiving.poNumber}</h3>
              <span style={{
                padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                background: getStatusColor(selectedReceiving.status), color: 'white'
              }}>
                {selectedReceiving.status?.toUpperCase()}
              </span>
            </div>
            
            {selectedReceiving.supplier && (
              <p style={{ color: '#666', marginBottom: 5 }}>Supplier: {selectedReceiving.supplier}</p>
            )}
            {selectedReceiving.notes && (
              <p style={{ color: '#666', marginBottom: 15 }}>{selectedReceiving.notes}</p>
            )}

            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f5f5' }}>
                  <th style={{ padding: 10, textAlign: 'left' }}>Item</th>
                  <th style={{ padding: 10, textAlign: 'center', width: 80 }}>Expected</th>
                  <th style={{ padding: 10, textAlign: 'center', width: 100 }}>Received</th>
                  <th style={{ padding: 10, textAlign: 'left', width: 150 }}>Location</th>
                </tr>
              </thead>
              <tbody>
                {selectedReceiving.items?.map(item => (
                  <tr key={item.itemId} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: 10 }}>
                      <strong>{item.itemName}</strong>
                      <div style={{ fontSize: 12, color: '#666' }}>{item.partNumber}</div>
                      <div style={{ fontSize: 11, color: '#999' }}>Current stock: {item.currentStock}</div>
                    </td>
                    <td style={{ padding: 10, textAlign: 'center' }}>{item.expectedQty}</td>
                    <td style={{ padding: 10, textAlign: 'center' }}>
                      {selectedReceiving.status === 'completed' ? (
                        item.receivedQty
                      ) : (
                        <input
                          type="number"
                          value={item.receivedQty || 0}
                          onChange={e => updateReceivedQty(selectedReceiving, item.itemId, e.target.value)}
                          style={{ width: 70, padding: 5, textAlign: 'center' }}
                          min="0"
                        />
                      )}
                    </td>
                    <td style={{ padding: 10 }}>
                      {selectedReceiving.status === 'completed' ? (
                        item.locationCode || '-'
                      ) : (
                        <select
                          className="form-input"
                          value={item.locationId || ''}
                          onChange={e => updateItemLocationInReceiving(selectedReceiving, item.itemId, e.target.value)}
                          style={{ width: '100%', padding: 5 }}
                        >
                          <option value="">Select...</option>
                          {locations.map(loc => (
                            <option key={loc.id} value={loc.id}>
                              {loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}-${loc.shelf}`}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              {selectedReceiving.status !== 'completed' && (
                <button 
                  className="btn btn-primary" 
                  onClick={() => completeReceiving(selectedReceiving)}
                  style={{ flex: 1 }}
                >
                  ✓ Complete Receiving
                </button>
              )}
              <button 
                className="btn" 
                onClick={() => setSelectedReceiving(null)} 
                style={{ flex: 1, background: '#6c757d', color: 'white' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receivings Table */}
      <div className="data-table">
        <table>
          <thead>
            <tr>
              <th>PO Number</th>
              <th>Supplier</th>
              <th>Items</th>
              <th>Status</th>
              <th>Date</th>
              <th>Received By</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {receivings.map(rec => (
              <tr key={rec.id}>
                <td><strong>{rec.poNumber}</strong></td>
                <td>{rec.supplier || '-'}</td>
                <td>{rec.items?.length || 0} items</td>
                <td>
                  <span style={{
                    padding: '4px 8px', borderRadius: 4, fontSize: 12,
                    background: getStatusColor(rec.status), color: 'white'
                  }}>
                    {rec.status}
                  </span>
                </td>
                <td style={{ fontSize: 13 }}>{formatDate(rec.createdAt)}</td>
                <td style={{ fontSize: 13 }}>{rec.receivedBy}</td>
                <td>
                  <button 
                    className="btn btn-primary btn-sm"
                    onClick={() => setSelectedReceiving(rec)}
                  >
                    {rec.status === 'completed' ? 'View' : 'Process'}
                  </button>
                </td>
              </tr>
            ))}
            {receivings.length === 0 && (
              <tr>
                <td colSpan="7">
                  <div className="empty-state">
                    <p>No receivings yet</p>
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
