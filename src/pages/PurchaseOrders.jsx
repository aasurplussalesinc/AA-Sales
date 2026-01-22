import { useState, useEffect } from 'react';
import { OrgDB as DB } from '../orgDb';
import { COMPANY_LOGO } from '../companyLogo';
import { useAuth } from '../OrgAuthContext';

export default function PurchaseOrders() {
  const { userRole, organization } = useAuth();
  const isAdmin = userRole === 'admin';
  const isManager = userRole === 'manager';
  const canEdit = isAdmin || isManager;
  
  const [orders, setOrders] = useState([]);
  const [items, setItems] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [pickLists, setPickLists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [editingOrderId, setEditingOrderId] = useState(null);
  const [searchItem, setSearchItem] = useState('');
  const [searchCustomer, setSearchCustomer] = useState('');
  const [showPackOrder, setShowPackOrder] = useState(false);
  const [packingOrder, setPackingOrder] = useState(null);
  const [boxAssignments, setBoxAssignments] = useState({});

  const [newPO, setNewPO] = useState({
    customerId: '', customerName: '', customerEmail: '', customerPhone: '', customerAddress: '',
    dueDate: '', notes: '', items: [], estSubtotal: 0, subtotal: 0, tax: 0, shipping: 0, estTotal: 0, total: 0
  });

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    const [ordersData, itemsData, customersData, contractsData, pickListsData] = await Promise.all([
      DB.getPurchaseOrders(), DB.getItems(), DB.getCustomers(), DB.getContracts(), DB.getPickLists()
    ]);
    setOrders(ordersData); setItems(itemsData); setCustomers(customersData); setContracts(contractsData); setPickLists(pickListsData);
    setLoading(false);
  };

  const filteredItems = items.filter(item => searchItem && (
    item.name?.toLowerCase().includes(searchItem.toLowerCase()) ||
    item.partNumber?.toLowerCase().includes(searchItem.toLowerCase())
  ));

  const filteredCustomers = customers.filter(c => searchCustomer && (
    c.company?.toLowerCase().includes(searchCustomer.toLowerCase()) ||
    c.customerName?.toLowerCase().includes(searchCustomer.toLowerCase())
  ));

  const selectCustomerForPO = (customer) => {
    setNewPO({
      ...newPO, customerId: customer.id, customerName: customer.company || customer.customerName,
      customerEmail: customer.email || '', customerPhone: customer.phone || '',
      customerAddress: [customer.address, customer.city, customer.state, customer.zipCode].filter(Boolean).join(', ')
    });
    setSearchCustomer('');
  };

  const addItemToPO = (item) => {
    if (newPO.items.find(i => i.itemId === item.id)) return;
    const unitPrice = parseFloat(item.price) || 0;
    const newItem = {
      itemId: item.id, itemName: item.name, partNumber: item.partNumber, location: item.location || '',
      quantity: '', qtyShipped: '', unitPrice: unitPrice, estTotal: 0, lineTotal: 0,
      source: 'inventory', contractId: '', contractNumber: '', costPerLb: 0,
      weightPerItem: item.weight || '', itemCost: item.cost || 0
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
          if (field === 'source' && value === 'inventory') {
            updated.contractId = ''; updated.contractNumber = ''; updated.costPerLb = 0;
          }
          if (field === 'contractId') {
            const contract = contracts.find(c => c.id === value);
            if (contract) { updated.contractNumber = contract.contractNumber; updated.costPerLb = contract.costPerLb || 0; }
            else { updated.contractNumber = ''; updated.costPerLb = 0; }
          }
          if (field === 'quantity' || field === 'qtyShipped' || field === 'unitPrice') {
            const qtyOrdered = parseFloat(updated.quantity) || 0;
            const qtyShipped = parseFloat(updated.qtyShipped) || 0;
            const price = parseFloat(updated.unitPrice) || 0;
            updated.estTotal = qtyOrdered * price; updated.lineTotal = qtyShipped * price;
          }
          return updated;
        }
        return item;
      });
      const estSubtotal = updatedItems.reduce((sum, i) => sum + (parseFloat(i.estTotal) || 0), 0);
      const shipSubtotal = updatedItems.reduce((sum, i) => sum + (parseFloat(i.lineTotal) || 0), 0);
      const tax = parseFloat(prevPO.tax) || 0; const shipping = parseFloat(prevPO.shipping) || 0;
      return { ...prevPO, items: updatedItems, estSubtotal, subtotal: shipSubtotal, estTotal: estSubtotal + tax + shipping, total: shipSubtotal + tax + shipping };
    });
  };

  const removeItemFromPO = (itemId) => {
    setNewPO(prevPO => {
      const updatedItems = prevPO.items.filter(i => i.itemId !== itemId);
      const estSubtotal = updatedItems.reduce((sum, i) => sum + (parseFloat(i.estTotal) || 0), 0);
      const shipSubtotal = updatedItems.reduce((sum, i) => sum + (parseFloat(i.lineTotal) || 0), 0);
      const tax = parseFloat(prevPO.tax) || 0; const shipping = parseFloat(prevPO.shipping) || 0;
      return { ...prevPO, items: updatedItems, estSubtotal, subtotal: shipSubtotal, estTotal: estSubtotal + tax + shipping, total: shipSubtotal + tax + shipping };
    });
  };

  const updatePOTotals = (updatedItems) => {
    setNewPO(prevPO => {
      const estSubtotal = updatedItems.reduce((sum, i) => sum + (parseFloat(i.estTotal) || 0), 0);
      const shipSubtotal = updatedItems.reduce((sum, i) => sum + (parseFloat(i.lineTotal) || 0), 0);
      const tax = parseFloat(prevPO.tax) || 0; const shipping = parseFloat(prevPO.shipping) || 0;
      return { ...prevPO, items: updatedItems, estSubtotal, subtotal: shipSubtotal, estTotal: estSubtotal + tax + shipping, total: shipSubtotal + tax + shipping };
    });
  };

  const updateTaxShipping = (field, value) => {
    setNewPO(prevPO => {
      const val = parseFloat(value) || 0;
      const estSubtotal = prevPO.estSubtotal || 0; const shipSubtotal = prevPO.subtotal || 0;
      const tax = field === 'tax' ? val : (parseFloat(prevPO.tax) || 0);
      const shipping = field === 'shipping' ? val : (parseFloat(prevPO.shipping) || 0);
      return { ...prevPO, [field]: val, estTotal: estSubtotal + tax + shipping, total: shipSubtotal + tax + shipping };
    });
  };

  const createPurchaseOrder = async () => {
    if (!newPO.customerName) { alert('Enter customer name'); return; }
    if (newPO.items.length === 0) { alert('Add at least one item'); return; }
    for (const item of newPO.items) {
      if ((item.source === 'inventory_contract' || item.source === 'direct_contract') && !item.contractId) {
        alert('Item "' + item.itemName + '" needs a contract selected.'); return;
      }
      if ((item.source === 'inventory_contract' || item.source === 'direct_contract') && !item.weightPerItem) {
        alert('Item "' + item.itemName + '" needs weight per item.'); return;
      }
    }
    if (editMode && editingOrderId) { await DB.updatePurchaseOrder(editingOrderId, newPO); }
    else { await DB.createPurchaseOrder(newPO); }
    resetForm(); setShowCreate(false); setEditMode(false); setEditingOrderId(null); loadData();
  };

  const openEditOrder = (order) => {
    const normalizedItems = (order.items || []).map(item => {
      const qty = item.quantity === '' ? 0 : (parseInt(item.quantity) || 0);
      const qtyShipped = item.qtyShipped === '' ? 0 : (parseInt(item.qtyShipped) || 0);
      const price = parseFloat(item.unitPrice) || 0;
      return { ...item, quantity: item.quantity === '' ? '' : qty, qtyShipped: item.qtyShipped === '' ? '' : qtyShipped,
        unitPrice: price, estTotal: qty * price, lineTotal: qtyShipped * price,
        source: item.source || 'inventory', contractId: item.contractId || '', contractNumber: item.contractNumber || '',
        costPerLb: item.costPerLb || 0, weightPerItem: item.weightPerItem || '', itemCost: item.itemCost || 0 };
    });
    const estSubtotal = normalizedItems.reduce((sum, i) => sum + (i.estTotal || 0), 0);
    const shipSubtotal = normalizedItems.reduce((sum, i) => sum + (i.lineTotal || 0), 0);
    const tax = parseFloat(order.tax) || 0; const shipping = parseFloat(order.shipping) || 0;
    setNewPO({ customerId: order.customerId || '', customerName: order.customerName || '', customerEmail: order.customerEmail || '',
      customerPhone: order.customerPhone || '', customerAddress: order.customerAddress || '', dueDate: order.dueDate || '',
      notes: order.notes || '', items: normalizedItems, estSubtotal, subtotal: shipSubtotal, tax, shipping,
      estTotal: estSubtotal + tax + shipping, total: shipSubtotal + tax + shipping });
    setEditingOrderId(order.id); setEditMode(true); setShowCreate(true); setSelectedOrder(null);
  };

  const resetForm = () => {
    setNewPO({ customerId: '', customerName: '', customerEmail: '', customerPhone: '', customerAddress: '',
      dueDate: '', notes: '', items: [], estSubtotal: 0, subtotal: 0, tax: 0, shipping: 0, estTotal: 0, total: 0 });
  };

  const confirmAndCreatePickList = async (order) => {
    if (!confirm('Confirm PO ' + order.poNumber + ' and create pick list?')) return;
    try { await DB.confirmPurchaseOrder(order.id); alert('Pick list created!'); loadData(); setSelectedOrder(null); }
    catch (error) { alert('Error: ' + error.message); }
  };

  const openPackOrder = (order) => {
    // Find the associated pick list for this order
    const pickList = pickLists.find(pl => pl.purchaseOrderId === order.id);
    
    // Build a map of picked quantities from the pick list
    const pickedQtyMap = {};
    if (pickList && pickList.items) {
      pickList.items.forEach(plItem => {
        pickedQtyMap[plItem.itemId] = plItem.pickedQty || 0;
      });
    }
    
    // Store pick list reference and picked quantities with the order for packing
    const orderWithPickedQty = {
      ...order,
      pickListId: pickList?.id,
      items: (order.items || []).map(item => ({
        ...item,
        pickedQty: pickedQtyMap[item.itemId] ?? (parseInt(item.qtyShipped) || parseInt(item.quantity) || 0)
      }))
    };
    
    setPackingOrder(orderWithPickedQty);
    
    // Initialize box distributions based on PICKED quantities
    const distributions = {};
    orderWithPickedQty.items.forEach((item, idx) => {
      const totalQty = item.pickedQty;
      // Check if we have saved distributions
      if (order.boxDistributions && order.boxDistributions[idx]) {
        distributions[idx] = order.boxDistributions[idx];
      } else if (item.boxNumber) {
        // Legacy: single box assignment
        distributions[idx] = [{ box: item.boxNumber, qty: totalQty }];
      } else {
        // Default: all in box 1
        distributions[idx] = [{ box: 1, qty: totalQty }];
      }
    });
    setBoxAssignments(distributions);
    setShowPackOrder(true);
  };

  const updateBoxDistribution = (itemIndex, distIndex, field, value) => {
    setBoxAssignments(prev => {
      const itemDist = [...(prev[itemIndex] || [])];
      itemDist[distIndex] = { ...itemDist[distIndex], [field]: field === 'qty' ? (parseInt(value) || 0) : (parseInt(value) || 1) };
      return { ...prev, [itemIndex]: itemDist };
    });
  };

  const addBoxDistribution = (itemIndex) => {
    setBoxAssignments(prev => {
      const itemDist = [...(prev[itemIndex] || [])];
      const maxBox = Math.max(...itemDist.map(d => d.box), 0);
      itemDist.push({ box: maxBox + 1, qty: 0 });
      return { ...prev, [itemIndex]: itemDist };
    });
  };

  const removeBoxDistribution = (itemIndex, distIndex) => {
    setBoxAssignments(prev => {
      const itemDist = [...(prev[itemIndex] || [])];
      itemDist.splice(distIndex, 1);
      if (itemDist.length === 0) itemDist.push({ box: 1, qty: 0 });
      return { ...prev, [itemIndex]: itemDist };
    });
  };

  const getDistributionTotal = (itemIndex) => {
    const dist = boxAssignments[itemIndex] || [];
    return dist.reduce((sum, d) => sum + (parseInt(d.qty) || 0), 0);
  };

  const getItemQty = (item) => item.pickedQty ?? (parseInt(item.qtyShipped) || parseInt(item.quantity) || 0);

  const validatePacking = () => {
    for (let idx = 0; idx < (packingOrder?.items || []).length; idx++) {
      const item = packingOrder.items[idx];
      const expected = getItemQty(item);
      const actual = getDistributionTotal(idx);
      if (actual !== expected) return false;
    }
    return true;
  };

  const savePackOrder = async () => {
    if (!packingOrder) return;
    if (!validatePacking()) {
      alert('Please make sure all quantities are distributed correctly across boxes.');
      return;
    }
    
    // Calculate qtyShipped from box distributions (what was actually packed)
    const updatedItems = packingOrder.items.map((item, idx) => {
      const distributions = boxAssignments[idx] || [{ box: 1, qty: getItemQty(item) }];
      const totalPacked = distributions.reduce((sum, d) => sum + (parseInt(d.qty) || 0), 0);
      return {
        ...item,
        qtyShipped: totalPacked, // Update shipped qty based on what was packed
        boxDistributions: distributions
      };
    });
    
    // Recalculate order totals based on new qtyShipped values
    const newSubtotal = updatedItems.reduce((sum, item) => {
      return sum + ((item.qtyShipped || 0) * (parseFloat(item.unitPrice) || 0));
    }, 0);
    const tax = parseFloat(packingOrder.tax) || 0;
    const shipping = parseFloat(packingOrder.shipping) || 0;
    
    await DB.updatePurchaseOrder(packingOrder.id, {
      ...packingOrder,
      items: updatedItems,
      boxDistributions: boxAssignments,
      packingComplete: true,
      subtotal: newSubtotal,
      total: newSubtotal + tax + shipping
    });
    
    setShowPackOrder(false); setPackingOrder(null); loadData(); alert('Packing saved! Shipped quantities updated.');
  };

  const markShipped = async (order) => {
    for (const item of order.items || []) {
      const qtyShipped = parseInt(item.qtyShipped) || 0;
      if (qtyShipped <= 0) continue;
      if (item.source === 'inventory' || item.source === 'inventory_contract') {
        const currentItem = items.find(i => i.id === item.itemId);
        if (currentItem) {
          const newStock = Math.max(0, (currentItem.stock || 0) - qtyShipped);
          await DB.updateItem(item.itemId, { stock: newStock });
        }
      }
    }
    await DB.markPOShipped(order.id); loadData(); setSelectedOrder(null);
  };

  const markPaid = async (order) => { await DB.markPOPaid(order.id); loadData(); setSelectedOrder(null); };

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteRestoreInventory, setDeleteRestoreInventory] = useState(false);
  const [orderToDelete, setOrderToDelete] = useState(null);

  const deleteOrder = async (order) => {
    setOrderToDelete(order);
    setDeleteRestoreInventory(false);
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    if (!orderToDelete) return;
    
    // If restoring inventory, add back the shipped quantities
    if (deleteRestoreInventory && orderToDelete.items) {
      for (const item of orderToDelete.items) {
        const qtyShipped = parseInt(item.qtyShipped) || 0;
        if (qtyShipped > 0 && item.itemId) {
          const dbItem = items.find(i => i.id === item.itemId);
          if (dbItem) {
            const newStock = (dbItem.stock || 0) + qtyShipped;
            await DB.updateItemStock(item.itemId, newStock);
            
            // Log the restoration
            await DB.logMovement({
              itemId: item.itemId,
              itemName: item.itemName,
              quantity: qtyShipped,
              type: 'RESTORE',
              notes: `Restored from deleted order ${orderToDelete.poNumber}`,
              timestamp: Date.now()
            });
          }
        }
      }
    }
    
    await DB.deletePurchaseOrder(orderToDelete.id);
    setShowDeleteConfirm(false);
    setOrderToDelete(null);
    setSelectedOrder(null);
    loadData();
  };

  const calculateItemCost = (item) => {
    const qtyShipped = parseInt(item.qtyShipped) || 0;
    const weight = parseFloat(item.weightPerItem) || 0;
    const costPerLb = parseFloat(item.costPerLb) || 0;
    if (item.source === 'inventory_contract' || item.source === 'direct_contract') { return qtyShipped * weight * costPerLb; }
    else if (item.source === 'inventory' && item.itemCost) { return qtyShipped * parseFloat(item.itemCost); }
    return null;
  };

  const formatCurrency = (value) => '$' + (parseFloat(value) || 0).toFixed(2);
  const formatDate = (timestamp) => { if (!timestamp) return ''; return new Date(timestamp).toLocaleDateString(); };
  const getStatusColor = (status) => {
    switch (status) {
      case 'draft': return '#9e9e9e'; case 'confirmed': return '#2196F3'; case 'picking': return '#ff9800';
      case 'packed': return '#9c27b0'; case 'shipped': return '#4CAF50'; case 'paid': return '#388e3c'; default: return '#9e9e9e';
    }
  };
  const getSourceLabel = (source) => {
    switch(source) { case 'inventory': return 'Inventory'; case 'inventory_contract': return 'Inv (Contract)'; case 'direct_contract': return 'Direct'; default: return 'Inventory'; }
  };

  const printClientPackingList = (order) => {
    // Build boxes from distributions - items can appear in multiple boxes with different quantities
    const boxes = {};
    (order.items || []).forEach((item, idx) => {
      const distributions = item.boxDistributions || order.boxDistributions?.[idx] || [{ box: item.boxNumber || 1, qty: parseInt(item.qtyShipped) || parseInt(item.quantity) || 0 }];
      distributions.forEach(dist => {
        if (dist.qty > 0) {
          if (!boxes[dist.box]) boxes[dist.box] = [];
          boxes[dist.box].push({ ...item, qtyInBox: dist.qty });
        }
      });
    });
    const printContent = `<!DOCTYPE html><html><head><title>Packing List - ${order.poNumber}</title>
      <style>body{font-family:Arial,sans-serif;padding:20px;max-width:800px;margin:0 auto}.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:30px;border-bottom:2px solid #333;padding-bottom:20px}.logo{max-width:150px;max-height:80px}h1{margin:0 0 10px 0;font-size:24px}.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:30px}.info-box{background:#f5f5f5;padding:15px;border-radius:8px}.info-box h3{margin:0 0 10px 0;font-size:14px;color:#666;text-transform:uppercase}.box-section{margin-bottom:25px;border:2px solid #333;border-radius:8px;overflow:hidden}.box-header{background:#333;color:white;padding:10px 15px;font-weight:bold;font-size:16px}table{width:100%;border-collapse:collapse}th{background:#f5f5f5;padding:10px;text-align:left;border-bottom:1px solid #ddd}td{padding:10px;border-bottom:1px solid #eee}.footer{margin-top:40px;padding-top:20px;border-top:1px solid #ddd;font-size:12px;color:#666;text-align:center}@media print{body{padding:0}}</style></head><body>
      <div class="header"><div>${COMPANY_LOGO ? '<img src="' + COMPANY_LOGO + '" class="logo" />' : ''}<h1>PACKING LIST</h1><div style="color:#666">${order.poNumber}</div></div><div style="text-align:right;font-size:12px;color:#666"><strong>${organization?.name || 'Warehouse'}</strong><br>${organization?.address || ''}<br>${organization?.phone || ''}</div></div>
      <div class="info-grid"><div class="info-box"><h3>Ship To</h3><strong>${order.customerName}</strong><br>${order.customerAddress || ''}</div><div class="info-box"><h3>Order Details</h3><div>Date: ${formatDate(order.createdAt)}</div><div>Total Items: ${(order.items || []).reduce((sum, i) => sum + (parseInt(i.qtyShipped) || 0), 0)}</div><div>Total Boxes: ${Object.keys(boxes).length}</div></div></div>
      ${Object.entries(boxes).sort((a, b) => a[0] - b[0]).map(([boxNum, boxItems]) => '<div class="box-section"><div class="box-header">📦 Box ' + boxNum + '</div><table><thead><tr><th>Item</th><th style="text-align:center;width:80px">Qty</th></tr></thead><tbody>' + boxItems.map(item => '<tr><td><strong>' + item.itemName + '</strong>' + (item.partNumber ? '<div style="font-size:12px;color:#666">' + item.partNumber + '</div>' : '') + '</td><td style="text-align:center;font-weight:bold">' + item.qtyInBox + '</td></tr>').join('') + '</tbody></table></div>').join('')}
      ${order.notes ? '<div style="margin-top:20px;padding:15px;background:#fff9e6;border-radius:8px"><strong>Notes:</strong> ' + order.notes + '</div>' : ''}
      <div class="footer">Thank you for your business!</div></body></html>`;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(printContent); printWindow.document.close(); printWindow.print();
  };

  const printInternalPackingList = (order) => {
    // Build boxes from distributions - items can appear in multiple boxes with different quantities
    const boxes = {};
    (order.items || []).forEach((item, idx) => {
      const distributions = item.boxDistributions || order.boxDistributions?.[idx] || [{ box: item.boxNumber || 1, qty: parseInt(item.qtyShipped) || parseInt(item.quantity) || 0 }];
      distributions.forEach(dist => {
        if (dist.qty > 0) {
          if (!boxes[dist.box]) boxes[dist.box] = [];
          boxes[dist.box].push({ ...item, qtyInBox: dist.qty });
        }
      });
    });
    
    // Calculate totals based on full item quantities (not per-box)
    let totalRevenue = 0, totalKnownCost = 0, unknownCostCount = 0;
    (order.items || []).forEach(item => {
      const qtyShipped = parseInt(item.qtyShipped) || 0;
      const price = parseFloat(item.unitPrice) || 0;
      totalRevenue += qtyShipped * price;
      const cost = calculateItemCost(item);
      if (cost !== null) { totalKnownCost += cost; } else { unknownCostCount++; }
    });
    const knownMargin = totalRevenue - totalKnownCost;
    
    // Helper to calculate cost for partial quantity
    const calculatePartialCost = (item, qty) => {
      const weight = parseFloat(item.weightPerItem) || 0;
      const costPerLb = parseFloat(item.costPerLb) || 0;
      if (item.source === 'inventory_contract' || item.source === 'direct_contract') {
        return qty * weight * costPerLb;
      } else if (item.source === 'inventory' && item.itemCost) {
        return qty * parseFloat(item.itemCost);
      }
      return null;
    };
    
    const printContent = `<!DOCTYPE html><html><head><title>INTERNAL - ${order.poNumber}</title>
      <style>body{font-family:Arial,sans-serif;padding:20px;max-width:900px;margin:0 auto;font-size:12px}.header{background:#ff9800;color:white;padding:15px;margin-bottom:20px;border-radius:8px}.header h1{margin:0;font-size:20px}.warning{background:#fff3e0;border:2px solid #ff9800;padding:10px;margin-bottom:20px;border-radius:4px;font-weight:bold;text-align:center}.info-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:15px;margin-bottom:20px}.info-box{background:#f5f5f5;padding:12px;border-radius:8px}.info-box h3{margin:0 0 8px 0;font-size:11px;color:#666;text-transform:uppercase}.info-box .value{font-size:16px;font-weight:bold}.box-section{margin-bottom:20px;border:1px solid #ddd;border-radius:8px;overflow:hidden}.box-header{background:#333;color:white;padding:8px 12px;font-weight:bold}table{width:100%;border-collapse:collapse}th{background:#f5f5f5;padding:8px;text-align:left;font-size:11px;border-bottom:1px solid #ddd}td{padding:8px;border-bottom:1px solid #eee}.profit{color:#4CAF50}.cost{color:#f44336}.unknown{color:#999;font-style:italic}.summary{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px}.summary-box{padding:15px;border-radius:8px}.summary-box.costs{background:#ffebee}.summary-box.revenue{background:#e8f5e9}.summary-row{display:flex;justify-content:space-between;margin-bottom:6px}.summary-row.total{font-size:14px;font-weight:bold;border-top:2px solid currentColor;padding-top:8px;margin-top:8px}.source-badge{padding:2px 6px;border-radius:3px;font-size:10px;font-weight:600}.source-inventory{background:#e3f2fd;color:#1976d2}.source-inventory_contract{background:#fff3e0;color:#f57c00}.source-direct_contract{background:#fce4ec;color:#c2185b}@media print{body{padding:0}.warning{background:white!important}}</style></head><body>
      <div class="header"><h1>⚠️ INTERNAL USE ONLY - COST ANALYSIS</h1><div>${order.poNumber} | ${order.customerName}</div></div>
      <div class="warning">DO NOT SHARE WITH CUSTOMER - CONTAINS COST & MARGIN DATA</div>
      <div class="info-grid"><div class="info-box"><h3>Order Info</h3><div class="value">${order.poNumber}</div><div>${formatDate(order.createdAt)}</div></div><div class="info-box"><h3>Customer</h3><div class="value">${order.customerName}</div></div><div class="info-box"><h3>Items / Boxes</h3><div class="value">${(order.items || []).reduce((sum, i) => sum + (parseInt(i.qtyShipped) || 0), 0)} items / ${Object.keys(boxes).length} boxes</div></div></div>
      ${Object.entries(boxes).sort((a, b) => a[0] - b[0]).map(([boxNum, boxItems]) => {
        return '<div class="box-section"><div class="box-header">📦 Box ' + boxNum + '</div><table><thead><tr><th>Item</th><th style="text-align:center">Source</th><th style="text-align:center">Qty</th><th style="text-align:right">Wt/ea</th><th style="text-align:right">Cost</th><th style="text-align:right">Price</th><th style="text-align:right">Revenue</th><th style="text-align:right">Margin</th></tr></thead><tbody>' + boxItems.map(item => {
          const qtyInBox = item.qtyInBox;
          const price = parseFloat(item.unitPrice) || 0;
          const revenue = qtyInBox * price;
          const cost = calculatePartialCost(item, qtyInBox);
          const margin = cost !== null ? revenue - cost : null;
          const weight = parseFloat(item.weightPerItem) || 0;
          return '<tr><td><strong>' + item.itemName + '</strong>' + (item.partNumber ? '<div style="font-size:10px;color:#666">' + item.partNumber + '</div>' : '') + (item.contractNumber ? '<div style="font-size:10px;color:#f57c00">Contract: ' + item.contractNumber + '</div>' : '') + '</td><td style="text-align:center"><span class="source-badge source-' + (item.source || 'inventory') + '">' + getSourceLabel(item.source) + '</span></td><td style="text-align:center;font-weight:bold">' + qtyInBox + '</td><td style="text-align:right">' + (weight ? weight.toFixed(2) + ' lbs' : '<span class="unknown">—</span>') + '</td><td style="text-align:right" class="cost">' + (cost !== null ? '$' + cost.toFixed(2) : '<span class="unknown">—</span>') + '</td><td style="text-align:right">$' + price.toFixed(2) + '</td><td style="text-align:right">$' + revenue.toFixed(2) + '</td><td style="text-align:right" class="profit">' + (margin !== null ? '$' + margin.toFixed(2) : '<span class="unknown">—</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      }).join('')}
      <div class="summary"><div class="summary-box costs"><h3 style="margin:0 0 12px 0;color:#c62828">Cost Summary</h3><div class="summary-row"><span>Items with known cost:</span><span>${(order.items || []).length - unknownCostCount} of ${(order.items || []).length}</span></div><div class="summary-row total" style="color:#c62828"><span>Total Known Cost:</span><span>$${totalKnownCost.toFixed(2)}</span></div>${unknownCostCount > 0 ? '<div style="font-size:11px;color:#999;margin-top:8px">* ' + unknownCostCount + ' item(s) have unknown cost</div>' : ''}</div><div class="summary-box revenue"><h3 style="margin:0 0 12px 0;color:#2e7d32">Profitability</h3><div class="summary-row"><span>Total Revenue:</span><span>$${totalRevenue.toFixed(2)}</span></div><div class="summary-row"><span>Known Cost:</span><span>-$${totalKnownCost.toFixed(2)}</span></div><div class="summary-row total" style="color:#2e7d32"><span>Known Margin:</span><span>$${knownMargin.toFixed(2)}</span></div>${unknownCostCount > 0 ? '<div style="font-size:11px;color:#999;margin-top:8px">* Actual margin may be lower</div>' : ''}</div></div>
      ${order.notes ? '<div style="margin-top:20px;padding:12px;background:#f5f5f5;border-radius:8px"><strong>Notes:</strong> ' + order.notes + '</div>' : ''}
      </body></html>`;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(printContent); printWindow.document.close(); printWindow.print();
  };

  const printPO = (order, printType = 'invoice') => {
    const isEstimate = printType === 'estimate';
    const accentColor = isEstimate ? '#1976d2' : '#4a5d23';
    const items = (order.items || []).map(item => {
      const qty = isEstimate ? (item.quantity || 0) : (item.qtyShipped || 0);
      const price = parseFloat(item.unitPrice) || 0;
      return { ...item, displayQty: qty, displayTotal: qty * price };
    });
    const subtotal = items.reduce((sum, i) => sum + i.displayTotal, 0);
    const tax = parseFloat(order.tax) || 0;
    const shipping = parseFloat(order.shipping) || 0;
    const total = subtotal + tax + shipping;
    const formatFullDate = (ts) => { const d = new Date(ts); const m = ['January','February','March','April','May','June','July','August','September','October','November','December']; return m[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); };
    const printContent = `<!DOCTYPE html><html><head><title>${isEstimate ? 'Estimate' : 'Invoice'} - ${order.poNumber}</title>
      <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;padding:40px;max-width:800px;margin:0 auto;color:#333;line-height:1.4}.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:40px;padding-bottom:20px;border-bottom:3px solid ${accentColor}}.logo{max-width:180px;max-height:90px}.company-details{text-align:right;font-size:12px;color:#555}.company-details strong{font-size:16px;color:#333;display:block;margin-bottom:5px}.doc-title{font-size:32px;font-weight:300;color:${accentColor};letter-spacing:2px;margin-bottom:5px}.doc-number{font-size:14px;color:#666}.info-section{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-bottom:30px}.info-box{background:#f8f9fa;padding:20px;border-radius:8px;border-left:4px solid ${accentColor}}.info-box h3{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:10px}.info-box p{margin:4px 0;font-size:14px}.info-box .highlight{font-size:18px;font-weight:600;color:#333}table{width:100%;border-collapse:collapse;margin-bottom:30px}th{background:${accentColor};color:white;padding:14px 12px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.5px}td{padding:14px 12px;border-bottom:1px solid #e0e0e0;font-size:14px}tr:hover{background:#fafafa}.item-name{font-weight:500}.item-sku{font-size:12px;color:#888;margin-top:2px}.totals-section{display:flex;justify-content:flex-end}.totals-box{width:280px;background:#f8f9fa;border-radius:8px;padding:20px;border:2px solid ${accentColor}}.totals-row{display:flex;justify-content:space-between;padding:8px 0;font-size:14px}.totals-row.final{border-top:2px solid ${accentColor};margin-top:10px;padding-top:15px;font-size:20px;font-weight:700;color:${accentColor}}.notes{background:#fffde7;padding:20px;border-radius:8px;margin-top:30px;border-left:4px solid #ffc107}.notes h3{font-size:12px;text-transform:uppercase;color:#888;margin-bottom:8px}.footer{margin-top:50px;padding-top:20px;border-top:1px solid #e0e0e0;text-align:center;font-size:12px;color:#888}@media print{body{padding:20px}}</style></head><body>
      <div class="header"><div>${COMPANY_LOGO ? '<img src="' + COMPANY_LOGO + '" class="logo" />' : '<div style="font-size:24px;font-weight:bold;color:' + accentColor + '">' + (organization?.name || 'Company') + '</div>'}</div><div class="company-details"><strong>${organization?.name || 'AA Surplus Sales Inc.'}</strong>${organization?.address || '123 Warehouse Way'}<br>${organization?.phone || '716-496-2451'}</div></div>
      <div class="doc-title">${isEstimate ? 'ESTIMATE' : 'INVOICE'}</div><div class="doc-number">${order.poNumber}</div>
      <div class="info-section" style="margin-top:30px"><div class="info-box"><h3>Bill To</h3><p class="highlight">${order.customerName}</p>${order.customerAddress ? '<p>' + order.customerAddress + '</p>' : ''}${order.customerPhone ? '<p>' + order.customerPhone + '</p>' : ''}${order.customerEmail ? '<p>' + order.customerEmail + '</p>' : ''}</div><div class="info-box"><h3>Details</h3><p><strong>Date:</strong> ${formatFullDate(order.createdAt)}</p><p><strong>Due:</strong> ${order.dueDate || 'Upon Receipt'}</p><p><strong>Terms:</strong> Net 30</p></div></div>
      <table><thead><tr><th style="width:50%">Description</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Amount</th></tr></thead><tbody>${items.map(item => '<tr><td><div class="item-name">' + item.itemName + '</div>' + (item.partNumber ? '<div class="item-sku">' + item.partNumber + '</div>' : '') + '</td><td style="text-align:center">' + item.displayQty + '</td><td style="text-align:right">$' + (item.unitPrice || 0).toFixed(2) + '</td><td style="text-align:right;font-weight:500">$' + item.displayTotal.toFixed(2) + '</td></tr>').join('')}</tbody></table>
      <div class="totals-section"><div class="totals-box"><div class="totals-row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>${tax > 0 ? '<div class="totals-row"><span>Tax</span><span>$' + tax.toFixed(2) + '</span></div>' : ''}${shipping > 0 ? '<div class="totals-row"><span>Shipping</span><span>$' + shipping.toFixed(2) + '</span></div>' : ''}<div class="totals-row final"><span>Total</span><span>$${total.toFixed(2)}</span></div></div></div>
      ${order.notes ? '<div class="notes"><h3>Notes</h3><p>' + order.notes + '</p></div>' : ''}
      <div class="footer">Thank you for your business!<br>Questions? Contact us at ${organization?.email || 'info@example.com'}</div></body></html>`;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(printContent); printWindow.document.close(); printWindow.print();
  };

  if (loading) return <div className="container" style={{ padding: 20 }}>Loading...</div>;

  return (
    <div className="container" style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>🧾 Purchase Orders</h2>
        {canEdit && <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Order</button>}
      </div>

      {/* Create/Edit Modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => { setShowCreate(false); setEditMode(false); resetForm(); }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 900, maxHeight: '90vh', overflow: 'auto' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0 }}>{editMode ? 'Edit Purchase Order' : 'New Purchase Order'}</h3>
              <button className="modal-close" onClick={() => { setShowCreate(false); setEditMode(false); resetForm(); }}>×</button>
            </div>
            <div className="modal-body" style={{ padding: 20 }}>
              {/* Customer */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Customer</label>
                <input type="text" placeholder="Search customers..." value={searchCustomer || newPO.customerName}
                  onChange={e => { setSearchCustomer(e.target.value); setNewPO({ ...newPO, customerName: e.target.value }); }}
                  style={{ width: '100%', padding: 10, borderRadius: 4, border: '1px solid #ddd' }} />
                {filteredCustomers.length > 0 && (
                  <div style={{ border: '1px solid #ddd', borderRadius: 4, maxHeight: 150, overflow: 'auto', marginTop: 5 }}>
                    {filteredCustomers.slice(0, 5).map(c => (
                      <div key={c.id} onClick={() => selectCustomerForPO(c)} style={{ padding: 10, borderBottom: '1px solid #eee', cursor: 'pointer' }}>
                        <strong>{c.company || c.customerName}</strong>
                        <span style={{ color: '#666', marginLeft: 10 }}>{c.email}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add Items */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Add Items</label>
                <input type="text" placeholder="Search items..." value={searchItem} onChange={e => setSearchItem(e.target.value)}
                  style={{ width: '100%', padding: 10, borderRadius: 4, border: '1px solid #ddd' }} />
                {filteredItems.length > 0 && (
                  <div style={{ border: '1px solid #ddd', borderRadius: 4, maxHeight: 150, overflow: 'auto', marginTop: 5 }}>
                    {filteredItems.slice(0, 10).map(item => (
                      <div key={item.id} onClick={() => addItemToPO(item)} style={{ padding: 10, borderBottom: '1px solid #eee', cursor: 'pointer' }}>
                        <strong>{item.name}</strong>
                        <span style={{ color: '#666', marginLeft: 10 }}>{item.partNumber}</span>
                        <span style={{ color: '#2d5f3f', marginLeft: 10 }}>Stock: {item.stock || 0}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Line Items Table */}
              {newPO.items.length > 0 && (
                <div style={{ marginBottom: 20, overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f5f5f5' }}>
                        <th style={{ padding: 8, textAlign: 'left' }}>Item</th>
                        <th style={{ padding: 8, width: 140 }}>Source</th>
                        <th style={{ padding: 8, width: 70 }}>Qty Ord</th>
                        <th style={{ padding: 8, width: 70 }}>Qty Ship</th>
                        <th style={{ padding: 8, width: 80 }}>Price</th>
                        <th style={{ padding: 8, width: 80, background: '#e8f5e9' }}>Total</th>
                        <th style={{ padding: 8, width: 40 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {newPO.items.map(item => (
                        <tr key={item.itemId} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: 8 }}>
                            <strong>{item.itemName}</strong>
                            <div style={{ fontSize: 11, color: '#666' }}>{item.partNumber}</div>
                          </td>
                          <td style={{ padding: 8 }}>
                            <select value={item.source || 'inventory'} onChange={e => updatePOItem(item.itemId, 'source', e.target.value)}
                              style={{ width: '100%', padding: 4, fontSize: 11 }}>
                              <option value="inventory">From Inventory</option>
                              <option value="inventory_contract">Inventory (Contract)</option>
                              <option value="direct_contract">Direct from Contract</option>
                            </select>
                            {(item.source === 'inventory_contract' || item.source === 'direct_contract') && (
                              <>
                                <select value={item.contractId || ''} onChange={e => updatePOItem(item.itemId, 'contractId', e.target.value)}
                                  style={{ width: '100%', padding: 4, fontSize: 11, marginTop: 4 }}>
                                  <option value="">Select Contract...</option>
                                  {contracts.map(c => <option key={c.id} value={c.id}>{c.contractNumber} (${c.costPerLb?.toFixed(2)}/lb)</option>)}
                                </select>
                                <input type="number" step="0.1" placeholder="Wt/ea (lbs)" value={item.weightPerItem || ''}
                                  onChange={e => updatePOItem(item.itemId, 'weightPerItem', e.target.value)}
                                  style={{ width: '100%', padding: 4, fontSize: 11, marginTop: 4 }} />
                              </>
                            )}
                          </td>
                          <td style={{ padding: 8 }}>
                            <input type="number" value={item.quantity === '' ? '' : item.quantity}
                              onChange={e => updatePOItem(item.itemId, 'quantity', e.target.value === '' ? '' : parseInt(e.target.value) || 0)}
                              style={{ width: '100%', padding: 4, textAlign: 'center' }} min="0" />
                          </td>
                          <td style={{ padding: 8 }}>
                            <input type="number" value={item.qtyShipped === '' ? '' : item.qtyShipped}
                              onChange={e => updatePOItem(item.itemId, 'qtyShipped', e.target.value === '' ? '' : parseInt(e.target.value) || 0)}
                              style={{ width: '100%', padding: 4, textAlign: 'center' }} min="0" />
                          </td>
                          <td style={{ padding: 8 }}>
                            <input type="number" value={item.unitPrice} onChange={e => updatePOItem(item.itemId, 'unitPrice', parseFloat(e.target.value) || 0)}
                              style={{ width: '100%', padding: 4, textAlign: 'right' }} step="0.01" min="0" />
                          </td>
                          <td style={{ padding: 8, textAlign: 'right', fontWeight: 600, background: '#e8f5e9' }}>${(item.lineTotal || 0).toFixed(2)}</td>
                          <td style={{ padding: 8 }}>
                            <button onClick={() => removeItemFromPO(item.itemId)}
                              style={{ background: '#f44336', color: 'white', border: 'none', borderRadius: 4, padding: '4px 8px', cursor: 'pointer' }}>✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Totals */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 15 }}>
                    <div style={{ width: 220, background: '#e8f5e9', padding: 15, borderRadius: 8, border: '2px solid #388e3c' }}>
                      <div style={{ fontWeight: 600, color: '#388e3c', marginBottom: 10, fontSize: 14 }}>💵 INVOICE</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}><span>Subtotal:</span><span>${(newPO.subtotal || 0).toFixed(2)}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', alignItems: 'center' }}><span>Tax:</span>
                        <input type="number" value={newPO.tax} onChange={e => updateTaxShipping('tax', e.target.value)} style={{ width: 70, padding: 5, textAlign: 'right' }} step="0.01" min="0" /></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', alignItems: 'center' }}><span>Shipping:</span>
                        <input type="number" value={newPO.shipping} onChange={e => updateTaxShipping('shipping', e.target.value)} style={{ width: 70, padding: 5, textAlign: 'right' }} step="0.01" min="0" /></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: '2px solid #388e3c', fontWeight: 'bold', fontSize: 18, color: '#388e3c' }}><span>Total:</span><span>${(newPO.total || 0).toFixed(2)}</span></div>
                    </div>
                  </div>
                </div>
              )}

              {/* Notes */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Notes</label>
                <textarea placeholder="Order notes..." value={newPO.notes} onChange={e => setNewPO({ ...newPO, notes: e.target.value })}
                  style={{ width: '100%', padding: 10, borderRadius: 4, border: '1px solid #ddd', minHeight: 60 }} />
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-primary" onClick={createPurchaseOrder} style={{ flex: 1 }}>{editMode ? 'Save Changes' : 'Create Order'}</button>
                <button className="btn" onClick={() => { setShowCreate(false); setEditMode(false); resetForm(); }} style={{ flex: 1, background: '#6c757d', color: 'white' }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* View Order Modal */}
      {selectedOrder && (
        <div className="modal-overlay" onClick={() => setSelectedOrder(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 700, maxHeight: '90vh', overflow: 'auto' }}>
            <div className="modal-header">
              <div><h3 style={{ margin: 0 }}>{selectedOrder.poNumber}</h3><p style={{ color: '#666', margin: '5px 0 0 0' }}>{selectedOrder.customerName}</p></div>
              <span style={{ padding: '6px 16px', borderRadius: 20, fontSize: 14, fontWeight: 600, background: getStatusColor(selectedOrder.status), color: 'white' }}>{selectedOrder.status?.toUpperCase() || 'DRAFT'}</span>
            </div>
            <div className="modal-body" style={{ padding: 20 }}>
              <div style={{ background: '#f9f9f9', padding: 15, borderRadius: 8, marginBottom: 20 }}>
                <p style={{ margin: '3px 0' }}><strong>Customer:</strong> {selectedOrder.customerName}</p>
                {selectedOrder.customerPhone && <p style={{ margin: '3px 0' }}>Phone: {selectedOrder.customerPhone}</p>}
                {selectedOrder.customerEmail && <p style={{ margin: '3px 0' }}>Email: {selectedOrder.customerEmail}</p>}
                {selectedOrder.customerAddress && <p style={{ margin: '3px 0' }}>Address: {selectedOrder.customerAddress}</p>}
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20, fontSize: 13 }}>
                <thead><tr style={{ background: '#f5f5f5' }}><th style={{ padding: 10, textAlign: 'left' }}>Item</th><th style={{ padding: 10, textAlign: 'center' }}>Source</th><th style={{ padding: 10, textAlign: 'right' }}>Qty</th><th style={{ padding: 10, textAlign: 'right' }}>Price</th><th style={{ padding: 10, textAlign: 'right' }}>Total</th></tr></thead>
                <tbody>
                  {selectedOrder.items?.map((item, idx) => (
                    <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: 10 }}>{item.itemName}<div style={{ fontSize: 11, color: '#666' }}>{item.partNumber}</div>{item.boxNumber && <div style={{ fontSize: 11, color: '#9c27b0' }}>📦 Box {item.boxNumber}</div>}</td>
                      <td style={{ padding: 10, textAlign: 'center' }}><span style={{ padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600, background: item.source === 'direct_contract' ? '#fce4ec' : item.source === 'inventory_contract' ? '#fff3e0' : '#e3f2fd', color: item.source === 'direct_contract' ? '#c2185b' : item.source === 'inventory_contract' ? '#f57c00' : '#1976d2' }}>{getSourceLabel(item.source)}</span></td>
                      <td style={{ padding: 10, textAlign: 'right' }}>{item.qtyShipped || item.quantity}</td>
                      <td style={{ padding: 10, textAlign: 'right' }}>{formatCurrency(item.unitPrice)}</td>
                      <td style={{ padding: 10, textAlign: 'right', fontWeight: 600 }}>{formatCurrency(item.lineTotal || item.estTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
                <div style={{ width: 200 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}><span>Subtotal:</span><span>{formatCurrency(selectedOrder.subtotal)}</span></div>
                  {selectedOrder.tax > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}><span>Tax:</span><span>{formatCurrency(selectedOrder.tax)}</span></div>}
                  {selectedOrder.shipping > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}><span>Shipping:</span><span>{formatCurrency(selectedOrder.shipping)}</span></div>}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: '2px solid #333', fontWeight: 'bold', fontSize: 18 }}><span>Total:</span><span>{formatCurrency(selectedOrder.total)}</span></div>
                </div>
              </div>

              {selectedOrder.notes && <div style={{ background: '#fffde7', padding: 15, borderRadius: 8, marginBottom: 20 }}><strong>Notes:</strong> {selectedOrder.notes}</div>}

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => openEditOrder(selectedOrder)} style={{ background: '#ff9800', color: 'white' }}>✏️ Edit</button>
                <button className="btn" onClick={() => printPO(selectedOrder, 'estimate')} style={{ background: '#1976d2', color: 'white' }}>📋 Estimate</button>
                <button className="btn" onClick={() => printPO(selectedOrder, 'invoice')} style={{ background: '#388e3c', color: 'white' }}>💵 Invoice</button>
                {(!selectedOrder.status || selectedOrder.status === 'draft') && <button className="btn btn-primary" onClick={() => confirmAndCreatePickList(selectedOrder)}>✓ Confirm & Pick List</button>}
                {(selectedOrder.status === 'confirmed' || selectedOrder.status === 'picking') && <button className="btn" onClick={() => openPackOrder(selectedOrder)} style={{ background: '#9c27b0', color: 'white' }}>📦 Pack Order</button>}
                {selectedOrder.packingComplete && (
                  <>
                    <button className="btn" onClick={() => printClientPackingList(selectedOrder)} style={{ background: '#17a2b8', color: 'white' }}>🖨️ Client Packing List</button>
                    <button className="btn" onClick={() => printInternalPackingList(selectedOrder)} style={{ background: '#ff9800', color: 'white' }}>📊 Internal Analysis</button>
                  </>
                )}
                {(selectedOrder.status === 'confirmed' || selectedOrder.status === 'picking' || selectedOrder.packingComplete) && <button className="btn" onClick={() => markShipped(selectedOrder)} style={{ background: '#4CAF50', color: 'white' }}>🚚 Mark Shipped</button>}
                {selectedOrder.status === 'shipped' && <button className="btn" onClick={() => markPaid(selectedOrder)} style={{ background: '#4CAF50', color: 'white' }}>💰 Mark Paid</button>}
                <button className="btn" onClick={() => deleteOrder(selectedOrder)} style={{ background: '#f44336', color: 'white' }}>🗑️ Delete</button>
                <button className="btn" onClick={() => setSelectedOrder(null)} style={{ background: '#6c757d', color: 'white', marginLeft: 'auto' }}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Pack Order Modal */}
      {showPackOrder && packingOrder && (
        <div className="modal-overlay" onClick={() => setShowPackOrder(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 700, maxHeight: '90vh', overflow: 'auto' }}>
            <div className="modal-header"><h3 style={{ margin: 0 }}>📦 Pack Order - {packingOrder.poNumber}</h3><button className="modal-close" onClick={() => setShowPackOrder(false)}>×</button></div>
            <div className="modal-body" style={{ padding: 20 }}>
              <div style={{ background: '#e3f2fd', padding: 12, borderRadius: 8, marginBottom: 20, fontSize: 13 }}>
                <strong>📋 Quantities from Pick List</strong>
                <span style={{ color: '#666', marginLeft: 10 }}>Packing quantities are based on what was actually picked.</span>
              </div>
              
              {(packingOrder.items || []).map((item, idx) => {
                const pickedQty = getItemQty(item);
                const orderedQty = parseInt(item.qtyShipped) || parseInt(item.quantity) || 0;
                const distributedQty = getDistributionTotal(idx);
                const isValid = distributedQty === pickedQty;
                const hasShortage = pickedQty < orderedQty;
                
                return (
                  <div key={idx} style={{ marginBottom: 20, padding: 15, background: isValid ? '#f5f5f5' : '#fff3e0', borderRadius: 8, border: isValid ? '1px solid #ddd' : '2px solid #ff9800' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <div>
                        <strong>{item.itemName}</strong>
                        {item.partNumber && <span style={{ color: '#666', marginLeft: 10, fontSize: 12 }}>{item.partNumber}</span>}
                        {hasShortage && (
                          <div style={{ fontSize: 11, color: '#f57c00', marginTop: 2 }}>
                            ⚠️ Shortage: Ordered {orderedQty}, Picked {pickedQty}
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <span style={{ fontWeight: 'bold', color: isValid ? '#4CAF50' : '#ff9800' }}>
                          {distributedQty} / {pickedQty}
                        </span>
                        <div style={{ fontSize: 10, color: '#666' }}>packed / picked</div>
                        {!isValid && <div style={{ fontSize: 11, color: '#ff9800' }}>⚠️ {distributedQty < pickedQty ? `${pickedQty - distributedQty} remaining` : `${distributedQty - pickedQty} over`}</div>}
                      </div>
                    </div>
                    
                    {(boxAssignments[idx] || []).map((dist, distIdx) => (
                      <div key={distIdx} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <span style={{ width: 60 }}>Box</span>
                        <input
                          type="number"
                          min="1"
                          value={dist.box}
                          onChange={e => updateBoxDistribution(idx, distIdx, 'box', e.target.value)}
                          style={{ width: 60, padding: 6, textAlign: 'center', fontWeight: 'bold' }}
                        />
                        <span style={{ width: 40 }}>Qty:</span>
                        <input
                          type="number"
                          min="0"
                          max={pickedQty}
                          value={dist.qty}
                          onChange={e => updateBoxDistribution(idx, distIdx, 'qty', e.target.value)}
                          style={{ width: 70, padding: 6, textAlign: 'center' }}
                        />
                        {(boxAssignments[idx] || []).length > 1 && (
                          <button
                            onClick={() => removeBoxDistribution(idx, distIdx)}
                            style={{ background: '#f44336', color: 'white', border: 'none', borderRadius: 4, padding: '4px 8px', cursor: 'pointer' }}
                          >✕</button>
                        )}
                      </div>
                    ))}
                    
                    <button
                      onClick={() => addBoxDistribution(idx)}
                      style={{ background: '#e3f2fd', color: '#1976d2', border: '1px dashed #1976d2', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontSize: 12, marginTop: 5 }}
                    >+ Add to another box</button>
                  </div>
                );
              })}
              
              <div style={{ marginTop: 20, padding: 15, background: validatePacking() ? '#e8f5e9' : '#ffebee', borderRadius: 8 }}>
                <strong>Summary:</strong> {new Set(Object.values(boxAssignments).flatMap(d => d.map(x => x.box))).size} boxes
                {!validatePacking() && <span style={{ color: '#f44336', marginLeft: 10 }}>⚠️ Fix quantity mismatches before saving</span>}
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: 15, borderTop: '1px solid #eee' }}>
              <button className="btn" onClick={() => setShowPackOrder(false)} style={{ background: '#6c757d', color: 'white' }}>Cancel</button>
              <button className="btn btn-primary" onClick={savePackOrder} disabled={!validatePacking()}>Save Packing</button>
            </div>
          </div>
        </div>
      )}

      {/* Orders Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white', borderRadius: 8, overflow: 'hidden' }}>
          <thead><tr style={{ background: '#f5f5f5' }}><th style={{ padding: 12, textAlign: 'left', borderBottom: '2px solid #ddd' }}>PO Number</th><th style={{ padding: 12, textAlign: 'left', borderBottom: '2px solid #ddd' }}>Customer</th><th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid #ddd' }}>Items</th><th style={{ padding: 12, textAlign: 'right', borderBottom: '2px solid #ddd' }}>Total</th><th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid #ddd' }}>Status</th><th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid #ddd' }}>Date</th><th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid #ddd' }}>Actions</th></tr></thead>
          <tbody>
            {orders.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: '#999' }}>No purchase orders yet. Click "+ New Order" to create one.</td></tr>
            ) : (
              orders.map(order => (
                <tr key={order.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 12 }}><strong>{order.poNumber}</strong></td>
                  <td style={{ padding: 12 }}>{order.customerName}</td>
                  <td style={{ padding: 12, textAlign: 'center' }}>{order.items?.length || 0}</td>
                  <td style={{ padding: 12, textAlign: 'right', fontWeight: 600 }}>{formatCurrency(order.total)}</td>
                  <td style={{ padding: 12, textAlign: 'center' }}><span style={{ padding: '4px 10px', borderRadius: 4, fontSize: 12, fontWeight: 600, background: getStatusColor(order.status), color: 'white' }}>{order.status || 'draft'}</span>{order.packingComplete && <span style={{ marginLeft: 5, fontSize: 11, color: '#9c27b0' }}>📦</span>}</td>
                  <td style={{ padding: 12, textAlign: 'center', fontSize: 13 }}>{formatDate(order.createdAt)}</td>
                  <td style={{ padding: 12, textAlign: 'center' }}><button className="btn btn-primary" onClick={() => setSelectedOrder(order)} style={{ padding: '4px 12px', fontSize: 12 }}>View</button></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && orderToDelete && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 2000, padding: 20
        }}>
          <div style={{
            background: 'white', borderRadius: 12, padding: 30,
            maxWidth: 450, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
          }}>
            <h3 style={{ marginTop: 0, color: '#f44336' }}>🗑️ Delete Order</h3>
            <p style={{ fontSize: 16, marginBottom: 20 }}>
              Delete order <strong>{orderToDelete.poNumber}</strong>?
            </p>
            
            {orderToDelete.status === 'shipped' && orderToDelete.items?.some(i => parseInt(i.qtyShipped) > 0) && (
              <div style={{
                padding: 15, background: '#fff3e0', borderRadius: 8, marginBottom: 20,
                border: '1px solid #ffb74d'
              }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={deleteRestoreInventory}
                    onChange={e => setDeleteRestoreInventory(e.target.checked)}
                    style={{ marginTop: 3, width: 18, height: 18 }}
                  />
                  <div>
                    <strong style={{ color: '#e65100' }}>Restore inventory</strong>
                    <p style={{ margin: '5px 0 0', fontSize: 13, color: '#666' }}>
                      Add shipped quantities back to stock. Use this if the order was cancelled or returned.
                    </p>
                    {deleteRestoreInventory && (
                      <div style={{ marginTop: 10, fontSize: 12, color: '#2e7d32' }}>
                        Will restore:
                        <ul style={{ margin: '5px 0', paddingLeft: 20 }}>
                          {orderToDelete.items.filter(i => parseInt(i.qtyShipped) > 0).map(i => (
                            <li key={i.itemId}>+{i.qtyShipped} {i.itemName}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </label>
              </div>
            )}
            
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                style={{
                  flex: 1, padding: '12px 20px', background: '#e0e0e0',
                  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                style={{
                  flex: 1, padding: '12px 20px', background: '#f44336', color: 'white',
                  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 600
                }}
              >
                Delete{deleteRestoreInventory ? ' & Restore' : ''}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
