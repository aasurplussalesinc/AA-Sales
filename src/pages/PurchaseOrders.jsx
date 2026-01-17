import { useState, useEffect } from 'react';
import { OrgDB as DB } from '../orgDb';
import { COMPANY_LOGO } from '../companyLogo';
import { useAuth } from '../OrgAuthContext';

export default function PurchaseOrders() {
  const { userRole } = useAuth();
  const isAdmin = userRole === 'admin';
  const isManager = userRole === 'manager';
  const canEdit = isAdmin || isManager;
  
  const [orders, setOrders] = useState([]);
  const [items, setItems] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [editingOrderId, setEditingOrderId] = useState(null);
  const [searchItem, setSearchItem] = useState('');
  const [searchCustomer, setSearchCustomer] = useState('');

  // New PO form
  const [newPO, setNewPO] = useState({
    customerId: '',
    customerName: '',
    customerEmail: '',
    customerPhone: '',
    customerAddress: '',
    dueDate: '',
    notes: '',
    items: [],
    subtotal: 0,
    tax: 0,
    shipping: 0,
    total: 0
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [ordersData, itemsData, customersData] = await Promise.all([
      DB.getPurchaseOrders(),
      DB.getItems(),
      DB.getCustomers()
    ]);
    setOrders(ordersData);
    setItems(itemsData);
    setCustomers(customersData);
    setLoading(false);
  };

  const filteredItems = items.filter(item =>
    searchItem && (
      item.name?.toLowerCase().includes(searchItem.toLowerCase()) ||
      item.partNumber?.toLowerCase().includes(searchItem.toLowerCase())
    )
  );

  const filteredCustomers = customers.filter(c =>
    searchCustomer && (
      c.company?.toLowerCase().includes(searchCustomer.toLowerCase()) ||
      c.customerName?.toLowerCase().includes(searchCustomer.toLowerCase())
    )
  );

  const selectCustomerForPO = (customer) => {
    setNewPO({
      ...newPO,
      customerId: customer.id,
      customerName: customer.company || customer.customerName,
      customerEmail: customer.email || '',
      customerPhone: customer.phone || '',
      customerAddress: [customer.address, customer.city, customer.state, customer.zipCode].filter(Boolean).join(', ')
    });
    setSearchCustomer('');
  };

  const addItemToPO = (item) => {
    if (newPO.items.find(i => i.itemId === item.id)) return;

    const unitPrice = parseFloat(item.price) || 0;
    const newItem = {
      itemId: item.id,
      itemName: item.name,
      partNumber: item.partNumber,
      location: item.location || '',
      quantity: '',  // Qty Ordered - starts blank
      qtyShipped: '', // Qty Shipped - starts blank, this determines line total
      unitPrice: unitPrice,
      lineTotal: 0  // Start at 0 until qtyShipped is entered
    };

    const updatedItems = [...newPO.items, newItem];
    updatePOTotals(updatedItems);
    setSearchItem('');
  };

  const updatePOItem = (itemId, field, value) => {
    setNewPO(prevPO => {
      const updatedItems = prevPO.items.map(item => {
        if (item.itemId === itemId) {
          const updated = { ...item, [field]: value };
          // Line total is based on Qty SHIPPED, not Qty Ordered
          if (field === 'qtyShipped' || field === 'unitPrice') {
            updated.lineTotal = (parseFloat(updated.qtyShipped) || 0) * (parseFloat(updated.unitPrice) || 0);
          }
          return updated;
        }
        return item;
      });
      
      const subtotal = updatedItems.reduce((sum, i) => sum + (i.lineTotal || 0), 0);
      const tax = parseFloat(prevPO.tax) || 0;
      const shipping = parseFloat(prevPO.shipping) || 0;
      const total = subtotal + tax + shipping;
      
      return {
        ...prevPO,
        items: updatedItems,
        subtotal,
        total
      };
    });
  };

  const removeItemFromPO = (itemId) => {
    setNewPO(prevPO => {
      const updatedItems = prevPO.items.filter(i => i.itemId !== itemId);
      const subtotal = updatedItems.reduce((sum, i) => sum + (i.lineTotal || 0), 0);
      const tax = parseFloat(prevPO.tax) || 0;
      const shipping = parseFloat(prevPO.shipping) || 0;
      const total = subtotal + tax + shipping;
      
      return {
        ...prevPO,
        items: updatedItems,
        subtotal,
        total
      };
    });
  };

  const updatePOTotals = (updatedItems) => {
    setNewPO(prevPO => {
      const subtotal = updatedItems.reduce((sum, i) => sum + (i.lineTotal || 0), 0);
      const tax = parseFloat(prevPO.tax) || 0;
      const shipping = parseFloat(prevPO.shipping) || 0;
      const total = subtotal + tax + shipping;

      return {
        ...prevPO,
        items: updatedItems,
        subtotal,
        total
      };
    });
  };

  const updateTaxShipping = (field, value) => {
    setNewPO(prevPO => {
      const val = parseFloat(value) || 0;
      const subtotal = prevPO.subtotal || 0;
      const tax = field === 'tax' ? val : (parseFloat(prevPO.tax) || 0);
      const shipping = field === 'shipping' ? val : (parseFloat(prevPO.shipping) || 0);

      return {
        ...prevPO,
        [field]: val,
        total: subtotal + tax + shipping
      };
    });
  };

  const createPurchaseOrder = async () => {
    if (!newPO.customerName) {
      alert('Enter customer name');
      return;
    }
    if (newPO.items.length === 0) {
      alert('Add at least one item');
      return;
    }

    if (editMode && editingOrderId) {
      // Update existing order
      await DB.updatePurchaseOrder(editingOrderId, newPO);
    } else {
      // Create new order
      await DB.createPurchaseOrder(newPO);
    }
    
    resetForm();
    setShowCreate(false);
    setEditMode(false);
    setEditingOrderId(null);
    loadData();
  };

  const openEditOrder = (order) => {
    setNewPO({
      customerId: order.customerId || '',
      customerName: order.customerName || '',
      customerEmail: order.customerEmail || '',
      customerPhone: order.customerPhone || '',
      customerAddress: order.customerAddress || '',
      dueDate: order.dueDate || '',
      notes: order.notes || '',
      items: order.items || [],
      subtotal: order.subtotal || 0,
      tax: order.tax || 0,
      shipping: order.shipping || 0,
      total: order.total || 0
    });
    setEditingOrderId(order.id);
    setEditMode(true);
    setShowCreate(true);
    setSelectedOrder(null);
  };

  const resetForm = () => {
    setNewPO({
      customerId: '',
      customerName: '',
      customerEmail: '',
      customerPhone: '',
      customerAddress: '',
      dueDate: '',
      notes: '',
      items: [],
      subtotal: 0,
      tax: 0,
      shipping: 0,
      total: 0
    });
  };

  const confirmAndCreatePickList = async (order) => {
    if (!confirm(`Confirm PO ${order.poNumber} and create pick list?`)) return;
    
    try {
      await DB.confirmPurchaseOrder(order.id);
      alert('Purchase Order confirmed! Pick list created.');
      loadData();
      setSelectedOrder(null);
    } catch (error) {
      alert('Error: ' + error.message);
    }
  };

  const markShipped = async (order) => {
    await DB.markPOShipped(order.id);
    loadData();
    setSelectedOrder(null);
  };

  const markPaid = async (order) => {
    await DB.markPOPaid(order.id);
    loadData();
    setSelectedOrder(null);
  };

  const deleteOrder = async (order) => {
    if (!confirm(`Delete order ${order.poNumber}?\n\nThis cannot be undone.`)) return;
    
    await DB.deletePurchaseOrder(order.id);
    loadData();
    setSelectedOrder(null);
  };

  const printPO = (order) => {
    // Format date as full month name
    const formatFullDate = (timestamp) => {
      const date = new Date(timestamp);
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                      'July', 'August', 'September', 'October', 'November', 'December'];
      return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    };
    
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <html>
        <head>
          <title>Purchase Order - ${order.poNumber}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px 30px; max-width: 800px; margin: 0 auto; font-size: 12px; }
            .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px; border-bottom: 2px solid #4a5d23; padding-bottom: 10px; }
            .company-info { display: flex; flex-direction: column; align-items: flex-start; }
            .company-logo { max-width: 180px; height: auto; margin-bottom: 3px; }
            .company-location { font-size: 11px; color: #333; }
            .po-info { text-align: right; }
            .po-number { font-size: 20px; font-weight: bold; color: #4a5d23; }
            .po-meta { font-size: 12px; color: #666; margin-top: 3px; }
            .addresses { display: flex; gap: 30px; margin-bottom: 15px; }
            .address-box { flex: 1; padding: 10px; background: #f5f5f5; border-radius: 6px; border-left: 3px solid #4a5d23; }
            .address-box h3 { margin: 0 0 8px 0; font-size: 11px; color: #666; text-transform: uppercase; }
            .address-box p { margin: 2px 0; font-size: 11px; }
            .address-box .name { font-weight: bold; font-size: 12px; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 15px; }
            th { background: #4a5d23; color: white; padding: 8px 6px; text-align: left; font-size: 11px; }
            td { padding: 6px; border-bottom: 1px solid #ddd; font-size: 11px; }
            .text-right { text-align: right; }
            .text-center { text-align: center; }
            .totals { width: 250px; margin-left: auto; }
            .totals td { padding: 5px; font-size: 11px; }
            .totals .total-row { font-weight: bold; font-size: 14px; background: #f0f0f0; }
            .notes { margin-top: 15px; padding: 10px; background: #fffde7; border-radius: 6px; font-size: 11px; }
            .footer { margin-top: 20px; text-align: center; color: #666; font-size: 10px; border-top: 1px solid #ddd; padding-top: 10px; }
            @media print { body { padding: 10px; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="company-info">
              <img src="${COMPANY_LOGO}" alt="AA Surplus Sales Inc." class="company-logo" />
              <div class="company-location">Ronkonkoma, NY • 716-496-2451</div>
            </div>
            <div class="po-info">
              <div class="po-number">${order.poNumber}</div>
              <div class="po-meta">${formatFullDate(order.createdAt)}</div>
              ${order.dueDate ? `<div class="po-meta">Terms: ${order.dueDate}</div>` : ''}
            </div>
          </div>

          <div class="addresses">
            <div class="address-box">
              <h3>Bill To:</h3>
              <p class="name">${order.customerName}</p>
              ${order.customerAddress ? `<p>${order.customerAddress}</p>` : ''}
              ${order.customerPhone ? `<p>Phone: ${order.customerPhone}</p>` : ''}
              ${order.customerEmail ? `<p>Email: ${order.customerEmail}</p>` : ''}
            </div>
            <div class="address-box">
              <h3>Ship To:</h3>
              <p class="name">${order.shipToName || order.customerName}</p>
              ${order.shipToAddress || order.customerAddress ? `<p>${order.shipToAddress || order.customerAddress}</p>` : ''}
              ${order.shipToPhone || order.customerPhone ? `<p>Phone: ${order.shipToPhone || order.customerPhone}</p>` : ''}
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Description</th>
                <th class="text-center">Qty Ordered</th>
                <th class="text-center">Qty Shipped</th>
                <th class="text-right">Unit Price</th>
                <th class="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              ${order.items.map(item => `
                <tr>
                  <td>${item.partNumber || '-'}</td>
                  <td>${item.itemName}</td>
                  <td class="text-center">${item.quantity}</td>
                  <td class="text-center">${item.qtyShipped || ''}</td>
                  <td class="text-right">$${(item.unitPrice || 0).toFixed(2)}</td>
                  <td class="text-right">$${(item.lineTotal || 0).toFixed(2)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>

          <table class="totals">
            <tr>
              <td>Subtotal:</td>
              <td class="text-right">$${(order.subtotal || 0).toFixed(2)}</td>
            </tr>
            ${order.tax ? `<tr><td>Tax:</td><td class="text-right">$${order.tax.toFixed(2)}</td></tr>` : ''}
            ${order.shipping ? `<tr><td>Shipping:</td><td class="text-right">$${order.shipping.toFixed(2)}</td></tr>` : ''}
            <tr class="total-row">
              <td>TOTAL:</td>
              <td class="text-right">$${(order.total || 0).toFixed(2)}</td>
            </tr>
          </table>

          ${order.notes ? `<div class="notes"><strong>Notes:</strong> ${order.notes}</div>` : ''}

          <div class="footer">
            <p>Thank you for your business!</p>
            <p>AA Surplus Sales Inc. • Genuine U.S. Military Goods • Est. 1973</p>
          </div>
        </body>
      </html>
    `);
    printWindow.document.close();
    setTimeout(() => printWindow.print(), 300);
  };

  const getStatusColor = (status) => {
    const colors = {
      draft: '#9e9e9e',
      confirmed: '#2196F3',
      picking: '#ff9800',
      shipped: '#9c27b0',
      paid: '#4CAF50'
    };
    return colors[status] || '#9e9e9e';
  };

  const formatDate = (timestamp) => new Date(timestamp).toLocaleDateString();
  const formatCurrency = (val) => `$${(val || 0).toFixed(2)}`;

  if (loading) {
    return <div className="page-content"><div className="loading">Loading...</div></div>;
  }

  return (
    <div className="page-content">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2>Purchase Orders</h2>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            + New Purchase Order
          </button>
        )}
      </div>

      {/* Create/Edit PO Modal */}
      {showCreate && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 1000, padding: 20
        }}>
          <div style={{
            background: 'white', borderRadius: 12, padding: 30,
            maxWidth: 800, width: '100%', maxHeight: '90vh', overflow: 'auto'
          }}>
            <h3 style={{ marginBottom: 20 }}>{editMode ? 'Edit Purchase Order' : 'Create Purchase Order'}</h3>

            {/* Customer Search */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Select Customer</label>
              <input
                type="text"
                className="form-input"
                placeholder="Search customers by name or company..."
                value={searchCustomer}
                onChange={e => setSearchCustomer(e.target.value)}
                style={{ width: '100%' }}
              />
              {filteredCustomers.length > 0 && (
                <div style={{ border: '1px solid #ddd', borderRadius: 4, maxHeight: 150, overflow: 'auto', marginTop: 5 }}>
                  {filteredCustomers.slice(0, 10).map(cust => (
                    <div
                      key={cust.id}
                      onClick={() => selectCustomerForPO(cust)}
                      style={{ padding: 10, borderBottom: '1px solid #eee', cursor: 'pointer' }}
                    >
                      <strong>{cust.company || cust.customerName}</strong>
                      {cust.company && cust.customerName && (
                        <span style={{ color: '#666', marginLeft: 10 }}>{cust.customerName}</span>
                      )}
                      {cust.city && <span style={{ color: '#999', marginLeft: 10 }}>{cust.city}, {cust.state}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Customer Info (auto-filled or manual) */}
            <div style={{ 
              padding: 15,
              background: newPO.customerId ? '#e8f5e9' : '#f9f9f9',
              borderRadius: 8,
              marginBottom: 20
            }}>
              {newPO.customerId && (
                <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#2d5f3f', fontWeight: 600 }}>✓ Customer Selected</span>
                  <button 
                    onClick={() => setNewPO({ ...newPO, customerId: '', customerName: '', customerEmail: '', customerPhone: '', customerAddress: '', shipToName: '', shipToAddress: '', shipToPhone: '' })}
                    style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12 }}
                  >
                    Clear
                  </button>
                </div>
              )}
              
              {/* Bill To Section */}
              <div style={{ marginBottom: 15 }}>
                <h4 style={{ margin: '0 0 10px 0', fontSize: 14, color: '#4a5d23' }}>Bill To</h4>
                <div style={{ 
                  display: 'grid', 
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: 10
                }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: 3, fontWeight: 600, fontSize: 12 }}>Customer Name *</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Customer or company name"
                      value={newPO.customerName}
                      onChange={e => setNewPO({ ...newPO, customerName: e.target.value })}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 3, fontWeight: 600, fontSize: 12 }}>Phone</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Phone number"
                      value={newPO.customerPhone}
                      onChange={e => setNewPO({ ...newPO, customerPhone: e.target.value })}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 3, fontWeight: 600, fontSize: 12 }}>Email</label>
                    <input
                      type="email"
                      className="form-input"
                      placeholder="Email address"
                      value={newPO.customerEmail}
                      onChange={e => setNewPO({ ...newPO, customerEmail: e.target.value })}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 3, fontWeight: 600, fontSize: 12 }}>Terms</label>
                    <select
                      className="form-input"
                      value={newPO.dueDate}
                      onChange={e => setNewPO({ ...newPO, dueDate: e.target.value })}
                      style={{ width: '100%' }}
                    >
                      <option value="">Select Terms</option>
                      <option value="Net 30">Net 30</option>
                      <option value="Net 60">Net 60</option>
                      <option value="Net 90">Net 90</option>
                    </select>
                  </div>
                  <div style={{ gridColumn: 'span 2' }}>
                    <label style={{ display: 'block', marginBottom: 3, fontWeight: 600, fontSize: 12 }}>Billing Address</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Billing address"
                      value={newPO.customerAddress}
                      onChange={e => setNewPO({ ...newPO, customerAddress: e.target.value })}
                      style={{ width: '100%' }}
                    />
                  </div>
                </div>
              </div>

              {/* Ship To Section */}
              <div>
                <h4 style={{ margin: '0 0 10px 0', fontSize: 14, color: '#4a5d23' }}>Ship To 
                  <button 
                    onClick={() => setNewPO({ 
                      ...newPO, 
                      shipToName: newPO.customerName, 
                      shipToAddress: newPO.customerAddress, 
                      shipToPhone: newPO.customerPhone 
                    })}
                    style={{ 
                      marginLeft: 10, 
                      fontSize: 11, 
                      padding: '2px 8px', 
                      background: '#e0e0e0', 
                      border: 'none', 
                      borderRadius: 4, 
                      cursor: 'pointer' 
                    }}
                  >
                    Same as Bill To
                  </button>
                </h4>
                <div style={{ 
                  display: 'grid', 
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: 10
                }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: 3, fontWeight: 600, fontSize: 12 }}>Name</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Ship to name"
                      value={newPO.shipToName || ''}
                      onChange={e => setNewPO({ ...newPO, shipToName: e.target.value })}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 3, fontWeight: 600, fontSize: 12 }}>Phone</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Ship to phone"
                      value={newPO.shipToPhone || ''}
                      onChange={e => setNewPO({ ...newPO, shipToPhone: e.target.value })}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div style={{ gridColumn: 'span 2' }}>
                    <label style={{ display: 'block', marginBottom: 3, fontWeight: 600, fontSize: 12 }}>Shipping Address</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Shipping address"
                      value={newPO.shipToAddress || ''}
                      onChange={e => setNewPO({ ...newPO, shipToAddress: e.target.value })}
                      style={{ width: '100%' }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Add Items */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Add Items</label>
              <input
                type="text"
                className="form-input"
                placeholder="Search by name or SKU..."
                value={searchItem}
                onChange={e => setSearchItem(e.target.value)}
                style={{ width: '100%' }}
              />
              {filteredItems.length > 0 && (
                <div style={{ border: '1px solid #ddd', borderRadius: 4, maxHeight: 150, overflow: 'auto', marginTop: 5 }}>
                  {filteredItems.slice(0, 10).map(item => (
                    <div
                      key={item.id}
                      onClick={() => addItemToPO(item)}
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

            {/* Line Items */}
            {newPO.items.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f5f5f5' }}>
                      <th style={{ padding: 10, textAlign: 'left' }}>Item</th>
                      <th style={{ padding: 10, width: 80 }}>Qty Ordered</th>
                      <th style={{ padding: 10, width: 80 }}>Qty Shipped</th>
                      <th style={{ padding: 10, width: 100 }}>Unit Price</th>
                      <th style={{ padding: 10, width: 100 }}>Line Total</th>
                      <th style={{ padding: 10, width: 50 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {newPO.items.map(item => (
                      <tr key={item.itemId} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: 10 }}>
                          <strong>{item.itemName}</strong>
                          <div style={{ fontSize: 12, color: '#666' }}>{item.partNumber}</div>
                        </td>
                        <td style={{ padding: 10 }}>
                          <input
                            type="number"
                            value={item.quantity === '' ? '' : item.quantity}
                            onChange={e => updatePOItem(item.itemId, 'quantity', e.target.value === '' ? '' : parseInt(e.target.value) || 0)}
                            style={{ width: '100%', padding: 5, textAlign: 'center' }}
                            min="0"
                            placeholder=""
                          />
                        </td>
                        <td style={{ padding: 10 }}>
                          <input
                            type="number"
                            value={item.qtyShipped === '' ? '' : item.qtyShipped}
                            onChange={e => updatePOItem(item.itemId, 'qtyShipped', e.target.value === '' ? '' : parseInt(e.target.value) || 0)}
                            style={{ width: '100%', padding: 5, textAlign: 'center' }}
                            min="0"
                            placeholder=""
                          />
                        </td>
                        <td style={{ padding: 10 }}>
                          <input
                            type="number"
                            value={item.unitPrice}
                            onChange={e => updatePOItem(item.itemId, 'unitPrice', parseFloat(e.target.value) || 0)}
                            style={{ width: '100%', padding: 5, textAlign: 'right' }}
                            step="0.01"
                            min="0"
                            placeholder="0.00"
                          />
                        </td>
                        <td style={{ padding: 10, textAlign: 'right', fontWeight: 600 }}>
                          ${(item.lineTotal || 0).toFixed(2)}
                        </td>
                        <td style={{ padding: 10 }}>
                          <button
                            onClick={() => removeItemFromPO(item.itemId)}
                            style={{ background: '#f44336', color: 'white', border: 'none', borderRadius: 4, padding: '5px 10px', cursor: 'pointer' }}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Totals */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 15 }}>
                  <div style={{ width: 250 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
                      <span>Subtotal:</span>
                      <span>${newPO.subtotal.toFixed(2)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', alignItems: 'center' }}>
                      <span>Tax:</span>
                      <input
                        type="number"
                        value={newPO.tax}
                        onChange={e => updateTaxShipping('tax', e.target.value)}
                        style={{ width: 80, padding: 5, textAlign: 'right' }}
                        step="0.01"
                        min="0"
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', alignItems: 'center' }}>
                      <span>Shipping:</span>
                      <input
                        type="number"
                        value={newPO.shipping}
                        onChange={e => updateTaxShipping('shipping', e.target.value)}
                        style={{ width: 80, padding: 5, textAlign: 'right' }}
                        step="0.01"
                        min="0"
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: '2px solid #333', fontWeight: 'bold', fontSize: 18 }}>
                      <span>Total:</span>
                      <span>${newPO.total.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Notes */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Notes</label>
              <textarea
                className="form-input"
                placeholder="Order notes, special instructions..."
                value={newPO.notes}
                onChange={e => setNewPO({ ...newPO, notes: e.target.value })}
                style={{ width: '100%', minHeight: 60 }}
              />
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={createPurchaseOrder} style={{ flex: 1 }}>
                {editMode ? 'Save Changes' : 'Create Purchase Order'}
              </button>
              <button className="btn" onClick={() => { setShowCreate(false); setEditMode(false); setEditingOrderId(null); resetForm(); }} style={{ flex: 1, background: '#6c757d', color: 'white' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View PO Modal */}
      {selectedOrder && (
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
              <div>
                <h3 style={{ margin: 0 }}>{selectedOrder.poNumber}</h3>
                <p style={{ color: '#666', margin: '5px 0 0 0' }}>{selectedOrder.customerName}</p>
              </div>
              <span style={{
                padding: '6px 16px', borderRadius: 20, fontSize: 14, fontWeight: 600,
                background: getStatusColor(selectedOrder.status), color: 'white'
              }}>
                {selectedOrder.status?.toUpperCase()}
              </span>
            </div>

            {/* Customer Info */}
            <div style={{ background: '#f9f9f9', padding: 15, borderRadius: 8, marginBottom: 20 }}>
              <p style={{ margin: '3px 0' }}><strong>Customer:</strong> {selectedOrder.customerName}</p>
              {selectedOrder.customerPhone && <p style={{ margin: '3px 0' }}>Phone: {selectedOrder.customerPhone}</p>}
              {selectedOrder.customerEmail && <p style={{ margin: '3px 0' }}>Email: {selectedOrder.customerEmail}</p>}
              {selectedOrder.customerAddress && <p style={{ margin: '3px 0' }}>Address: {selectedOrder.customerAddress}</p>}
            </div>

            {/* Items */}
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
              <thead>
                <tr style={{ background: '#f5f5f5' }}>
                  <th style={{ padding: 10, textAlign: 'left' }}>Item</th>
                  <th style={{ padding: 10, textAlign: 'right' }}>Qty</th>
                  <th style={{ padding: 10, textAlign: 'right' }}>Price</th>
                  <th style={{ padding: 10, textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {selectedOrder.items?.map((item, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: 10 }}>
                      {item.itemName}
                      <div style={{ fontSize: 12, color: '#666' }}>{item.partNumber}</div>
                    </td>
                    <td style={{ padding: 10, textAlign: 'right' }}>{item.quantity}</td>
                    <td style={{ padding: 10, textAlign: 'right' }}>{formatCurrency(item.unitPrice)}</td>
                    <td style={{ padding: 10, textAlign: 'right', fontWeight: 600 }}>{formatCurrency(item.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totals */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
              <div style={{ width: 200 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
                  <span>Subtotal:</span>
                  <span>{formatCurrency(selectedOrder.subtotal)}</span>
                </div>
                {selectedOrder.tax > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
                    <span>Tax:</span>
                    <span>{formatCurrency(selectedOrder.tax)}</span>
                  </div>
                )}
                {selectedOrder.shipping > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
                    <span>Shipping:</span>
                    <span>{formatCurrency(selectedOrder.shipping)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: '2px solid #333', fontWeight: 'bold', fontSize: 18 }}>
                  <span>Total:</span>
                  <span>{formatCurrency(selectedOrder.total)}</span>
                </div>
              </div>
            </div>

            {selectedOrder.notes && (
              <div style={{ background: '#fffde7', padding: 15, borderRadius: 8, marginBottom: 20 }}>
                <strong>Notes:</strong> {selectedOrder.notes}
              </div>
            )}

            {selectedOrder.pickListId && (
              <div style={{ background: '#e3f2fd', padding: 15, borderRadius: 8, marginBottom: 20 }}>
                <strong>Pick List Created:</strong> View in Pick Lists tab
              </div>
            )}

            {/* Actions based on status */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => openEditOrder(selectedOrder)} style={{ background: '#ff9800', color: 'white' }}>
                ✏️ Edit
              </button>
              
              <button className="btn" onClick={() => printPO(selectedOrder)} style={{ background: '#17a2b8', color: 'white' }}>
                🖨️ Print PO
              </button>
              
              <button 
                className="btn" 
                onClick={() => {
                  const subject = encodeURIComponent(`Purchase Order ${selectedOrder.poNumber}`);
                  const body = encodeURIComponent(
                    `Dear ${selectedOrder.customerName},\n\n` +
                    `Please find attached Purchase Order ${selectedOrder.poNumber}.\n\n` +
                    `Order Total: $${(selectedOrder.total || 0).toFixed(2)}\n` +
                    `Terms: ${selectedOrder.dueDate || 'N/A'}\n\n` +
                    `Please print this PO and attach it to the email.\n\n` +
                    `Thank you for your business!\n\n` +
                    `AA Surplus Sales Inc.\n` +
                    `Ronkonkoma, NY\n` +
                    `716-496-2451`
                  );
                  window.location.href = `mailto:${selectedOrder.customerEmail || ''}?subject=${subject}&body=${body}`;
                }} 
                style={{ background: '#2196F3', color: 'white' }}
              >
                📧 Email PO
              </button>
              
              {(!selectedOrder.status || selectedOrder.status === 'draft') && (
                <button className="btn btn-primary" onClick={() => confirmAndCreatePickList(selectedOrder)}>
                  ✓ Confirm & Create Pick List
                </button>
              )}
              
              {(selectedOrder.status === 'confirmed' || selectedOrder.status === 'picking') && (
                <button className="btn" onClick={() => markShipped(selectedOrder)} style={{ background: '#9c27b0', color: 'white' }}>
                  📦 Mark Shipped
                </button>
              )}
              
              {selectedOrder.status === 'shipped' && (
                <button className="btn" onClick={() => markPaid(selectedOrder)} style={{ background: '#4CAF50', color: 'white' }}>
                  💰 Mark Paid
                </button>
              )}
              
              <button className="btn" onClick={() => setSelectedOrder(null)} style={{ background: '#6c757d', color: 'white', marginLeft: 'auto' }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Orders Table */}
      <div className="data-table">
        <table>
          <thead>
            <tr>
              <th>PO Number</th>
              <th>Customer</th>
              <th>Items</th>
              <th>Total</th>
              <th>Status</th>
              <th>Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {orders.map(order => (
              <tr key={order.id}>
                <td><strong>{order.poNumber}</strong></td>
                <td>{order.customerName}</td>
                <td>{order.items?.length || 0} items</td>
                <td style={{ fontWeight: 600 }}>{formatCurrency(order.total)}</td>
                <td>
                  <span style={{
                    padding: '4px 10px', borderRadius: 4, fontSize: 12, fontWeight: 600,
                    background: getStatusColor(order.status), color: 'white'
                  }}>
                    {order.status}
                  </span>
                </td>
                <td style={{ fontSize: 13 }}>{formatDate(order.createdAt)}</td>
                <td>
                  <div className="action-buttons">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => setSelectedOrder(order)}
                    >
                      View
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => deleteOrder(order)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan="7">
                  <div className="empty-state">
                    <p>No purchase orders yet</p>
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
