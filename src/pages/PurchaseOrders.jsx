import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { OrgDB as DB } from '../orgDb';
import { COMPANY_LOGO } from '../companyLogo';
import { useAuth } from '../OrgAuthContext';

export default function PurchaseOrders() {
  const { userRole, organization } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
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

  // Filter and sort state
  const [showFilters, setShowFilters] = useState(false);
  const [filterSearch, setFilterSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterPayment, setFilterPayment] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [sortBy, setSortBy] = useState('date-desc');

  // Payment modal state
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentOrder, setPaymentOrder] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('');

  // One-off item modal state
  const [showOneOffModal, setShowOneOffModal] = useState(false);
  const [oneOffItem, setOneOffItem] = useState({ name: '', price: '', category: 'One-Off' });

  const [newPO, setNewPO] = useState({
    customerId: '', customerName: '', customerContact: '', customerEmail: '', customerPhone: '', customerAddress: '',
    shipToAddress: '', useShipTo: false,
    dueDate: '', notes: '', terms: 'Net 30', items: [], estSubtotal: 0, subtotal: 0, tax: 0, shipping: 0, ccFee: 0, estTotal: 0, total: 0
  });

  const termsOptions = ['Due on Receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60', 'Net 90'];

  useEffect(() => { loadData(); }, []);

  // Auto-open order from query param (e.g., /purchase-orders?po=abc123)
  useEffect(() => {
    const poId = searchParams.get('po');
    if (poId && orders.length > 0 && !selectedOrder) {
      const order = orders.find(o => o.id === poId);
      if (order) {
        setSelectedOrder(order);
      }
    }
  }, [searchParams, orders]);

  // Close order modal and clear URL param
  const closeOrderModal = () => {
    setSelectedOrder(null);
    // Clear the ?po= param from URL if present
    if (searchParams.has('po')) {
      searchParams.delete('po');
      setSearchParams(searchParams, { replace: true });
    }
  };

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
      ...newPO, customerId: customer.id, 
      customerName: customer.company || customer.customerName,
      customerContact: customer.company ? customer.customerName : '', // Contact is customerName if company exists
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
      const tax = parseFloat(prevPO.tax) || 0; const shipping = parseFloat(prevPO.shipping) || 0; const ccFee = parseFloat(prevPO.ccFee) || 0;
      return { ...prevPO, items: updatedItems, estSubtotal, subtotal: shipSubtotal, estTotal: estSubtotal + tax + shipping + ccFee, total: shipSubtotal + tax + shipping + ccFee };
    });
  };

  const removeItemFromPO = (itemId) => {
    setNewPO(prevPO => {
      const updatedItems = prevPO.items.filter(i => i.itemId !== itemId);
      const estSubtotal = updatedItems.reduce((sum, i) => sum + (parseFloat(i.estTotal) || 0), 0);
      const shipSubtotal = updatedItems.reduce((sum, i) => sum + (parseFloat(i.lineTotal) || 0), 0);
      const tax = parseFloat(prevPO.tax) || 0; const shipping = parseFloat(prevPO.shipping) || 0; const ccFee = parseFloat(prevPO.ccFee) || 0;
      return { ...prevPO, items: updatedItems, estSubtotal, subtotal: shipSubtotal, estTotal: estSubtotal + tax + shipping + ccFee, total: shipSubtotal + tax + shipping + ccFee };
    });
  };

  // Generate next A-SKU for one-off items
  const generateOneOffSKU = () => {
    const aSkus = items
      .filter(item => item.partNumber && item.partNumber.match(/^A\d{4}$/))
      .map(item => parseInt(item.partNumber.substring(1)));
    const maxSku = aSkus.length > 0 ? Math.max(...aSkus) : 999;
    const nextNum = maxSku + 1;
    return `A${nextNum.toString().padStart(4, '0')}`;
  };

  // Create one-off item and add to PO
  const createOneOffItem = async () => {
    if (!oneOffItem.name.trim()) {
      alert('Please enter an item name');
      return;
    }
    
    const sku = generateOneOffSKU();
    const price = parseFloat(oneOffItem.price) || 0;
    
    try {
      // Create the item in the database
      const newItem = {
        partNumber: sku,
        name: oneOffItem.name.trim(),
        category: oneOffItem.category || 'One-Off',
        price: price,
        stock: 0,
        isOneOff: true // Flag to identify one-off items
      };
      
      const itemId = await DB.createItem(newItem);
      
      // Add to local items list
      const createdItem = { id: itemId, ...newItem };
      setItems(prev => [...prev, createdItem]);
      
      // Add to PO
      addItemToPO(createdItem);
      
      // Reset and close modal
      setOneOffItem({ name: '', price: '', category: 'One-Off' });
      setShowOneOffModal(false);
      
    } catch (error) {
      console.error('Error creating one-off item:', error);
      alert('Error creating item: ' + error.message);
    }
  };

  const updatePOTotals = (updatedItems) => {
    setNewPO(prevPO => {
      const estSubtotal = updatedItems.reduce((sum, i) => sum + (parseFloat(i.estTotal) || 0), 0);
      const shipSubtotal = updatedItems.reduce((sum, i) => sum + (parseFloat(i.lineTotal) || 0), 0);
      const tax = parseFloat(prevPO.tax) || 0; const shipping = parseFloat(prevPO.shipping) || 0; const ccFee = parseFloat(prevPO.ccFee) || 0;
      return { ...prevPO, items: updatedItems, estSubtotal, subtotal: shipSubtotal, estTotal: estSubtotal + tax + shipping + ccFee, total: shipSubtotal + tax + shipping + ccFee };
    });
  };

  const updateTaxShipping = (field, value) => {
    setNewPO(prevPO => {
      const val = parseFloat(value) || 0;
      const estSubtotal = prevPO.estSubtotal || 0; const shipSubtotal = prevPO.subtotal || 0;
      const tax = field === 'tax' ? val : (parseFloat(prevPO.tax) || 0);
      const shipping = field === 'shipping' ? val : (parseFloat(prevPO.shipping) || 0);
      const ccFee = field === 'ccFee' ? val : (parseFloat(prevPO.ccFee) || 0);
      return { ...prevPO, [field]: val, estTotal: estSubtotal + tax + shipping + ccFee, total: shipSubtotal + tax + shipping + ccFee };
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
    try {
      let createdOrderId = null;
      
      if (editMode && editingOrderId) { 
        console.log('Updating PO:', editingOrderId);
        await DB.updatePurchaseOrder(editingOrderId, newPO);
        createdOrderId = editingOrderId;
        
        // If order has been confirmed, sync the pick list with updated items
        console.log('Looking for pick list, pickLists count:', pickLists.length);
        console.log('editingOrderId:', editingOrderId);
        const linkedPickList = pickLists.find(pl => pl.purchaseOrderId === editingOrderId);
        console.log('Found linkedPickList:', linkedPickList);
        
        if (linkedPickList) {
          // Build updated pick list items, preserving picked quantities for existing items
          const updatedPickListItems = newPO.items.map(poItem => {
            // Find existing pick list item to preserve pickedQty
            const existingPlItem = linkedPickList.items?.find(pli => pli.itemId === poItem.itemId);
            return {
              itemId: poItem.itemId,
              itemName: poItem.itemName,
              partNumber: poItem.partNumber,
              requestedQty: poItem.quantity,
              pickedQty: existingPlItem?.pickedQty || 0,
              location: poItem.location || existingPlItem?.location || ''
            };
          });
          
          console.log('Updating pick list with items:', updatedPickListItems);
          await DB.updatePickList(linkedPickList.id, {
            items: updatedPickListItems,
            name: `PO: ${newPO.poNumber || linkedPickList.name?.split(' - ')[0]?.replace('PO: ', '')} - ${newPO.customerName}`
          });
          console.log('Pick list updated successfully');
        } else {
          console.log('No linked pick list found');
        }
      }
      else { 
        createdOrderId = await DB.createPurchaseOrder(newPO); 
      }
      
      resetForm(); 
      setShowCreate(false); 
      setEditMode(false); 
      setEditingOrderId(null); 
      
      // Reload data and then open the view modal for the created/edited order
      const [ordersData, itemsData, customersData, contractsData, pickListsData] = await Promise.all([
        DB.getPurchaseOrders(), DB.getItems(), DB.getCustomers(), DB.getContracts(), DB.getPickLists()
      ]);
      setOrders(ordersData); 
      setItems(itemsData); 
      setCustomers(customersData); 
      setContracts(contractsData); 
      setPickLists(pickListsData);
      
      // Find and open the created/edited order
      const createdOrder = ordersData.find(o => o.id === createdOrderId);
      if (createdOrder) {
        setSelectedOrder(createdOrder);
      }
      
    } catch (error) {
      console.error('Error saving order:', error);
      alert('Error saving order: ' + error.message);
    }
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
    const tax = parseFloat(order.tax) || 0; const shipping = parseFloat(order.shipping) || 0; const ccFee = parseFloat(order.ccFee) || 0;
    setNewPO({ customerId: order.customerId || '', customerName: order.customerName || '', 
      customerContact: order.customerContact || '', customerEmail: order.customerEmail || '',
      customerPhone: order.customerPhone || '', customerAddress: order.customerAddress || '', 
      shipToAddress: order.shipToAddress || '', useShipTo: !!order.shipToAddress,
      dueDate: order.dueDate || '', poNumber: order.poNumber || '',
      notes: order.notes || '', terms: order.terms || 'Net 30', items: normalizedItems, estSubtotal, subtotal: shipSubtotal, tax, shipping, ccFee,
      estTotal: estSubtotal + tax + shipping + ccFee, total: shipSubtotal + tax + shipping + ccFee });
    setEditingOrderId(order.id); setEditMode(true); setShowCreate(true); closeOrderModal();
  };

  const resetForm = () => {
    setNewPO({ customerId: '', customerName: '', customerContact: '', customerEmail: '', customerPhone: '', customerAddress: '',
      shipToAddress: '', useShipTo: false,
      dueDate: '', notes: '', terms: 'Net 30', items: [], estSubtotal: 0, subtotal: 0, tax: 0, shipping: 0, ccFee: 0, estTotal: 0, total: 0 });
  };

  const confirmAndCreatePickList = async (order) => {
    if (!confirm('Confirm PO ' + order.poNumber + ' and create pick list?')) return;
    try { await DB.confirmPurchaseOrder(order.id); alert('Pick list created!'); loadData(); closeOrderModal(); }
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
      status: 'packed',
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
    await DB.markPOShipped(order.id); loadData(); closeOrderModal();
  };

  const markPaid = async (order) => { 
    setPaymentOrder(order);
    setPaymentMethod('');
    setShowPaymentModal(true);
  };

  const confirmPayment = async () => {
    if (!paymentMethod) {
      alert('Please select a payment method');
      return;
    }
    await DB.markPOPaid(paymentOrder.id, paymentMethod);
    loadData();
    closeOrderModal();
    setShowPaymentModal(false);
    setPaymentOrder(null);
    setPaymentMethod('');
  };

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteRestoreInventory, setDeleteRestoreInventory] = useState(false);
  const [orderToDelete, setOrderToDelete] = useState(null);

  const deleteOrder = async (order) => {
    setOrderToDelete(order);
    setDeleteRestoreInventory(false);
    setShowDeleteConfirm(true);
  };

  // Check if order has any picked/packed/shipped quantities
  const getRestorableItems = (order) => {
    if (!order?.items) return [];
    
    // Get linked pick list to check picked quantities
    const linkedPickList = pickLists.find(pl => pl.purchaseOrderId === order.id);
    const pickedQtyMap = {};
    if (linkedPickList?.items) {
      linkedPickList.items.forEach(plItem => {
        pickedQtyMap[plItem.itemId] = plItem.pickedQty || 0;
      });
    }
    
    return order.items
      .map(item => {
        const qtyShipped = parseInt(item.qtyShipped) || 0;
        const qtyPicked = pickedQtyMap[item.itemId] || 0;
        const restoreQty = Math.max(qtyShipped, qtyPicked);
        return { ...item, restoreQty };
      })
      .filter(item => item.restoreQty > 0 && item.itemId);
  };

  const confirmDelete = async () => {
    if (!orderToDelete) return;
    
    const restorableItems = getRestorableItems(orderToDelete);
    
    // If restoring inventory, add back the picked/shipped quantities
    if (deleteRestoreInventory && restorableItems.length > 0) {
      for (const item of restorableItems) {
        const dbItem = items.find(i => i.id === item.itemId);
        if (dbItem) {
          const newStock = (dbItem.stock || 0) + item.restoreQty;
          await DB.updateItemStock(item.itemId, newStock);
          
          // Log the restoration
          await DB.logMovement({
            itemId: item.itemId,
            itemName: item.itemName,
            quantity: item.restoreQty,
            type: 'RESTORE',
            notes: `Restored from deleted order ${orderToDelete.poNumber}`,
            timestamp: Date.now()
          });
        }
      }
    }
    
    // Delete linked pick list if exists
    const linkedPickList = pickLists.find(pl => pl.purchaseOrderId === orderToDelete.id);
    if (linkedPickList) {
      await DB.deletePickList(linkedPickList.id);
    }
    
    await DB.deletePurchaseOrder(orderToDelete.id);
    setShowDeleteConfirm(false);
    setOrderToDelete(null);
    closeOrderModal();
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
    
    const boxDets = order.boxDetails || {};
    const formatBoxDims = (boxNum) => {
      const d = boxDets[boxNum];
      if (!d) return '';
      const dims = (d.length && d.width && d.height) ? `${d.length}"×${d.width}"×${d.height}"` : '';
      const wt = d.weight ? `${d.weight} lbs` : '';
      if (dims && wt) return `${wt} | ${dims}`;
      return dims || wt;
    };
    
    const printContent = `<!DOCTYPE html><html><head><title>Packing List - ${order.poNumber}</title>
      <style>
        body{font-family:Arial,sans-serif;padding:15px;max-width:800px;margin:0 auto;font-size:11px}
        .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:15px;border-bottom:2px solid #333;padding-bottom:10px}
        .logo{max-width:120px;max-height:60px}
        h1{margin:0;font-size:18px}
        .info-row{display:flex;justify-content:space-between;margin-bottom:12px;gap:15px}
        .info-box{background:#f5f5f5;padding:8px 10px;border-radius:4px;flex:1}
        .info-box h3{margin:0 0 4px 0;font-size:9px;color:#666;text-transform:uppercase}
        .box-section{margin-bottom:10px;border:1px solid #333;border-radius:4px;overflow:hidden;page-break-inside:avoid}
        .box-header{background:#333;color:white;padding:5px 10px;font-weight:bold;font-size:11px;display:flex;justify-content:space-between}
        .box-dims{font-weight:normal;font-size:10px;color:#ccc}
        table{width:100%;border-collapse:collapse}
        th{background:#f0f0f0;padding:4px 8px;text-align:left;font-size:10px;border-bottom:1px solid #ddd}
        td{padding:4px 8px;border-bottom:1px solid #eee;font-size:10px}
        .item-name{font-weight:600}
        .item-sku{color:#666;font-size:9px}
        .qty{text-align:center;font-weight:bold;font-size:12px}
        .footer{margin-top:15px;padding-top:10px;border-top:1px solid #ddd;font-size:10px;color:#666;text-align:center}
        @media print{body{padding:10px}@page{margin:0.5in}}
      </style></head><body>
      <div class="header">
        <div>${COMPANY_LOGO ? '<img src="' + COMPANY_LOGO + '" class="logo" />' : ''}<h1>PACKING LIST</h1><div style="color:#666;font-size:12px">${order.poNumber}</div></div>
        <div style="text-align:right;font-size:10px;color:#666"><strong>${organization?.name || ''}</strong><br>${organization?.address || ''}<br>${organization?.phone || ''}</div>
      </div>
      <div class="info-row">
        <div class="info-box"><h3>Ship To</h3><strong>${order.customerName}</strong><br>${order.customerAddress || ''}</div>
        <div class="info-box"><h3>Order Details</h3>Date: ${formatDate(order.createdAt)}<br>Items: ${(order.items || []).reduce((sum, i) => sum + (parseInt(i.qtyShipped) || 0), 0)} | Boxes: ${Object.keys(boxes).length}</div>
      </div>
      ${Object.entries(boxes).sort((a, b) => a[0] - b[0]).map(([boxNum, boxItems]) => `
        <div class="box-section">
          <div class="box-header"><span>📦 Box ${boxNum}</span><span class="box-dims">${formatBoxDims(boxNum)}</span></div>
          <table><thead><tr><th>Item</th><th style="width:50px" class="qty">Qty</th></tr></thead>
          <tbody>${boxItems.map(item => `<tr><td><span class="item-name">${item.itemName}</span>${item.partNumber ? ` <span class="item-sku">(${item.partNumber})</span>` : ''}</td><td class="qty">${item.qtyInBox}</td></tr>`).join('')}</tbody></table>
        </div>`).join('')}
      ${order.notes ? '<div style="margin-top:10px;padding:8px;background:#fff9e6;border-radius:4px;font-size:10px"><strong>Notes:</strong> ' + order.notes + '</div>' : ''}
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
    
    const boxDets = order.boxDetails || {};
    const formatBoxDims = (boxNum) => {
      const d = boxDets[boxNum];
      if (!d) return '';
      const dims = (d.length && d.width && d.height) ? `${d.length}"×${d.width}"×${d.height}"` : '';
      const wt = d.weight ? `${d.weight} lbs` : '';
      if (dims && wt) return `${wt} | ${dims}`;
      return dims || wt;
    };
    
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
      <style>
        body{font-family:Arial,sans-serif;padding:12px;max-width:900px;margin:0 auto;font-size:9px}
        .header{background:#ff9800;color:white;padding:8px 12px;margin-bottom:10px;border-radius:4px}
        .header h1{margin:0;font-size:14px}
        .warning{background:#fff3e0;border:1px solid #ff9800;padding:6px;margin-bottom:10px;border-radius:3px;font-weight:bold;text-align:center;font-size:10px}
        .info-row{display:flex;gap:10px;margin-bottom:10px}
        .info-box{background:#f5f5f5;padding:6px 8px;border-radius:4px;flex:1}
        .info-box h3{margin:0 0 3px 0;font-size:8px;color:#666;text-transform:uppercase}
        .info-box .value{font-size:11px;font-weight:bold}
        .box-section{margin-bottom:8px;border:1px solid #ddd;border-radius:4px;overflow:hidden;page-break-inside:avoid}
        .box-header{background:#333;color:white;padding:4px 8px;font-weight:bold;font-size:10px;display:flex;justify-content:space-between}
        .box-dims{font-weight:normal;font-size:9px;color:#ccc}
        table{width:100%;border-collapse:collapse}
        th{background:#f0f0f0;padding:3px 5px;text-align:left;font-size:8px;border-bottom:1px solid #ddd}
        td{padding:3px 5px;border-bottom:1px solid #eee;font-size:9px}
        .profit{color:#4CAF50}
        .cost{color:#f44336}
        .unknown{color:#999;font-style:italic}
        .summary{display:flex;gap:15px;margin-top:12px}
        .summary-box{padding:10px;border-radius:4px;flex:1}
        .summary-box.costs{background:#ffebee}
        .summary-box.revenue{background:#e8f5e9}
        .summary-row{display:flex;justify-content:space-between;margin-bottom:3px;font-size:9px}
        .summary-row.total{font-size:11px;font-weight:bold;border-top:1px solid currentColor;padding-top:5px;margin-top:5px}
        .src{padding:1px 4px;border-radius:2px;font-size:7px;font-weight:600}
        .src-inv{background:#e3f2fd;color:#1976d2}
        .src-ic{background:#fff3e0;color:#f57c00}
        .src-dc{background:#fce4ec;color:#c2185b}
        @media print{body{padding:8px}@page{margin:0.4in}}
      </style></head><body>
      <div class="header"><h1>⚠️ INTERNAL - COST ANALYSIS</h1><span>${order.poNumber} | ${order.customerName}</span></div>
      <div class="warning">DO NOT SHARE WITH CUSTOMER</div>
      <div class="info-row">
        <div class="info-box"><h3>Order</h3><div class="value">${order.poNumber}</div>${formatDate(order.createdAt)}</div>
        <div class="info-box"><h3>Customer</h3><div class="value">${order.customerName}</div></div>
        <div class="info-box"><h3>Totals</h3><div class="value">${(order.items || []).reduce((sum, i) => sum + (parseInt(i.qtyShipped) || 0), 0)} items / ${Object.keys(boxes).length} boxes</div></div>
      </div>
      ${Object.entries(boxes).sort((a, b) => a[0] - b[0]).map(([boxNum, boxItems]) => {
        return `<div class="box-section">
          <div class="box-header"><span>📦 Box ${boxNum}</span><span class="box-dims">${formatBoxDims(boxNum)}</span></div>
          <table><thead><tr><th>Item</th><th>Src</th><th style="text-align:center">Qty</th><th style="text-align:right">Wt</th><th style="text-align:right">Cost</th><th style="text-align:right">Price</th><th style="text-align:right">Rev</th><th style="text-align:right">Margin</th></tr></thead>
          <tbody>${boxItems.map(item => {
            const qtyInBox = item.qtyInBox;
            const price = parseFloat(item.unitPrice) || 0;
            const revenue = qtyInBox * price;
            const cost = calculatePartialCost(item, qtyInBox);
            const margin = cost !== null ? revenue - cost : null;
            const weight = parseFloat(item.weightPerItem) || 0;
            const srcClass = item.source === 'inventory_contract' ? 'ic' : item.source === 'direct_contract' ? 'dc' : 'inv';
            const srcLabel = item.source === 'inventory_contract' ? 'I+C' : item.source === 'direct_contract' ? 'DC' : 'INV';
            return `<tr>
              <td><strong>${item.itemName}</strong>${item.partNumber ? ` <span style="color:#666;font-size:8px">${item.partNumber}</span>` : ''}${item.contractNumber ? `<br><span style="color:#f57c00;font-size:8px">C: ${item.contractNumber}</span>` : ''}</td>
              <td><span class="src src-${srcClass}">${srcLabel}</span></td>
              <td style="text-align:center;font-weight:bold">${qtyInBox}</td>
              <td style="text-align:right">${weight ? weight.toFixed(1) : '—'}</td>
              <td style="text-align:right" class="cost">${cost !== null ? '$' + cost.toFixed(2) : '—'}</td>
              <td style="text-align:right">$${price.toFixed(2)}</td>
              <td style="text-align:right">$${revenue.toFixed(2)}</td>
              <td style="text-align:right" class="profit">${margin !== null ? '$' + margin.toFixed(2) : '—'}</td>
            </tr>`;
          }).join('')}
          <tr style="background:#f5f5f5;font-weight:bold;border-top:2px solid #333">
            <td colspan="2">Box ${boxNum} Total</td>
            <td style="text-align:center">${boxItems.reduce((sum, i) => sum + i.qtyInBox, 0)}</td>
            <td style="text-align:right">${boxItems.reduce((sum, i) => sum + (i.qtyInBox * (parseFloat(i.weightPerItem) || 0)), 0).toFixed(1)} lbs</td>
            <td style="text-align:right" class="cost">$${boxItems.reduce((sum, i) => { const c = calculatePartialCost(i, i.qtyInBox); return sum + (c || 0); }, 0).toFixed(2)}</td>
            <td style="text-align:right">—</td>
            <td style="text-align:right">$${boxItems.reduce((sum, i) => sum + (i.qtyInBox * (parseFloat(i.unitPrice) || 0)), 0).toFixed(2)}</td>
            <td style="text-align:right" class="profit">$${boxItems.reduce((sum, i) => { const rev = i.qtyInBox * (parseFloat(i.unitPrice) || 0); const cost = calculatePartialCost(i, i.qtyInBox); return sum + (cost !== null ? rev - cost : 0); }, 0).toFixed(2)}</td>
          </tr>
          </tbody></table></div>`;
      }).join('')}
      <div class="summary">
        <div class="summary-box costs"><h3 style="margin:0 0 8px 0;color:#c62828;font-size:10px">Cost Summary</h3>
          <div class="summary-row"><span>Known cost items:</span><span>${(order.items || []).length - unknownCostCount}/${(order.items || []).length}</span></div>
          <div class="summary-row total" style="color:#c62828"><span>Total Cost:</span><span>$${totalKnownCost.toFixed(2)}</span></div>
        </div>
        <div class="summary-box revenue"><h3 style="margin:0 0 8px 0;color:#2e7d32;font-size:10px">Profitability</h3>
          <div class="summary-row"><span>Revenue:</span><span>$${totalRevenue.toFixed(2)}</span></div>
          <div class="summary-row"><span>Cost:</span><span>-$${totalKnownCost.toFixed(2)}</span></div>
          <div class="summary-row total" style="color:#2e7d32"><span>Margin:</span><span>$${knownMargin.toFixed(2)}</span></div>
        </div>
      </div>
      ${order.notes ? '<div style="margin-top:10px;padding:6px;background:#f5f5f5;border-radius:4px;font-size:9px"><strong>Notes:</strong> ' + order.notes + '</div>' : ''}
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
      <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Segoe UI',Arial,sans-serif;padding:20px 25px;max-width:800px;margin:0 auto;color:#333;line-height:1.3;font-size:11px}
        .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:15px;padding-bottom:10px;border-bottom:2px solid ${accentColor}}
        .logo{max-width:120px;max-height:60px}
        .company-details{text-align:right;font-size:10px;color:#555}
        .company-details strong{font-size:13px;color:#333;display:block;margin-bottom:2px}
        .doc-title{font-size:22px;font-weight:300;color:${accentColor};letter-spacing:1px;margin-bottom:2px}
        .doc-number{font-size:14px;color:#000;font-weight:700}
        .info-section{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin:15px 0}
        .info-box{background:#f8f9fa;padding:10px 12px;border-radius:4px;border-left:3px solid ${accentColor}}
        .info-box h3{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:5px}
        .info-box p{margin:2px 0;font-size:11px}
        .info-box .highlight{font-size:13px;font-weight:600;color:#333}
        table{width:100%;border-collapse:collapse;margin-bottom:15px}
        th{background:${accentColor};color:white;padding:6px 8px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.3px}
        td{padding:6px 8px;border-bottom:1px solid #e0e0e0;font-size:11px;vertical-align:top}
        .totals-section{display:flex;justify-content:flex-end}
        .totals-box{width:200px;background:#f8f9fa;border-radius:4px;padding:10px 12px;border:1px solid ${accentColor}}
        .totals-row{display:flex;justify-content:space-between;padding:4px 0;font-size:11px}
        .totals-row.final{border-top:2px solid ${accentColor};margin-top:6px;padding-top:8px;font-size:14px;font-weight:700;color:${accentColor}}
        .notes{background:#fffde7;padding:10px;border-radius:4px;margin-top:15px;border-left:3px solid #ffc107;font-size:10px}
        .notes h3{font-size:9px;text-transform:uppercase;color:#888;margin-bottom:4px}
        .footer{margin-top:20px;padding-top:10px;border-top:1px solid #e0e0e0;text-align:center;font-size:10px;color:#888}
        @media print{body{padding:15px}@page{margin:0.3in}}
      </style></head><body>
      <div class="header"><div>${COMPANY_LOGO ? '<img src="' + COMPANY_LOGO + '" class="logo" />' : '<div style="font-size:18px;font-weight:bold;color:' + accentColor + '">' + (organization?.name || 'Company') + '</div>'}</div><div class="company-details"><strong>${organization?.name || 'AA Surplus Sales'}</strong>2153 Pond Road, Ronkonkoma NY 11779<br>${organization?.phone || '716-496-2451'}</div></div>
      <div class="doc-title">${isEstimate ? 'ESTIMATE' : 'INVOICE'}</div><div class="doc-number">${order.poNumber}</div>
      <div class="info-section"><div class="info-box"><h3>Bill To</h3><p class="highlight">${order.customerName}</p>${order.customerContact ? '<p>' + order.customerContact + '</p>' : ''}${order.customerAddress ? '<p>' + order.customerAddress + '</p>' : ''}${order.customerPhone ? '<p>' + order.customerPhone + '</p>' : ''}${order.customerEmail ? '<p>' + order.customerEmail + '</p>' : ''}</div>${order.shipToAddress ? '<div class="info-box"><h3>Ship To</h3><p>' + order.shipToAddress.replace(/\n/g, '<br>') + '</p></div>' : ''}<div class="info-box"><h3>Details</h3><p><strong>Date:</strong> ${formatFullDate(order.createdAt)}</p><p><strong>Terms:</strong> ${order.terms || 'Net 30'}</p></div></div>
      <table><thead><tr><th style="width:60px">SKU</th><th>Description</th><th style="text-align:center;width:50px">Qty</th><th style="text-align:right;width:70px">Unit Price</th><th style="text-align:right;width:70px">Amount</th></tr></thead><tbody>${items.map(item => '<tr><td style="font-size:10px;color:#000;font-weight:700">' + (item.partNumber || '-') + '</td><td style="font-weight:500">' + item.itemName + '</td><td style="text-align:center">' + item.displayQty + '</td><td style="text-align:right">$' + (item.unitPrice || 0).toFixed(2) + '</td><td style="text-align:right;font-weight:500">$' + item.displayTotal.toFixed(2) + '</td></tr>').join('')}</tbody></table>
      <div class="totals-section"><div class="totals-box"><div class="totals-row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>${tax > 0 ? '<div class="totals-row"><span>Tax</span><span>$' + tax.toFixed(2) + '</span></div>' : ''}${shipping > 0 ? '<div class="totals-row"><span>Shipping</span><span>$' + shipping.toFixed(2) + '</span></div>' : ''}${(order.ccFee || 0) > 0 ? '<div class="totals-row"><span>CC Fee</span><span>$' + (order.ccFee || 0).toFixed(2) + '</span></div>' : ''}<div class="totals-row final"><span>Total</span><span>$${total.toFixed(2)}</span></div></div></div>
      ${order.notes ? '<div class="notes"><h3>Notes</h3><p>' + order.notes + '</p></div>' : ''}
      <div class="footer">Thank you for your business!<br>Questions? Contact us at ${organization?.email || 'aasurplussalesinc@gmail.com'}</div></body></html>`;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(printContent); printWindow.document.close(); printWindow.print();
  };

  const emailInvoice = (order) => {
    const total = (order.total || order.subtotal || 0).toFixed(2);
    const greeting = order.customerContact || order.customerName;
    const subject = encodeURIComponent(`Invoice ${order.poNumber} from ${organization?.name || 'AA Surplus Sales'}`);
    const body = encodeURIComponent(
`Hello ${greeting},

Please find your invoice details below:

Invoice #: ${order.poNumber}
Date: ${new Date(order.createdAt?.toDate ? order.createdAt.toDate() : order.createdAt).toLocaleDateString()}
Terms: ${order.terms || 'Net 30'}

Total Amount: $${total}

Items:
${(order.items || []).map(item => `- ${item.itemName}: ${item.qtyShipped || item.quantity} x $${(item.unitPrice || 0).toFixed(2)} = $${(item.lineTotal || item.estTotal || 0).toFixed(2)}`).join('\n')}

${order.notes ? `Notes: ${order.notes}\n` : ''}
Thank you for your business!

${organization?.name || 'AA Surplus Sales'}
${organization?.phone || '716-496-2451'}
${organization?.email || 'aasurplussalesinc@gmail.com'}
`);
    const email = order.customerEmail || '';
    window.open(`mailto:${email}?subject=${subject}&body=${body}`, '_self');
  };

  const printShippingLabel = (order, triwallIndex = 0) => {
    const triwalls = order.triwalls || [];
    const triwall = triwalls[triwallIndex] || {};
    const totalTriwalls = triwalls.length || 1;
    const labelNumber = triwallIndex + 1;
    const displayWeight = triwall.weight || '';
    
    const printContent = `<!DOCTYPE html>
<html><head><title>Shipping Label - ${order.poNumber}</title>
<style>
  @page { size: landscape; margin: 0.5in; }
  body { 
    font-family: Arial, sans-serif; 
    margin: 0; 
    padding: 40px;
    width: 10in;
    height: 7.5in;
    box-sizing: border-box;
  }
  .label-container {
    border: 3px solid #000;
    padding: 30px;
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }
  .from-section {
    margin-bottom: 40px;
  }
  .from-section .label { font-size: 14px; font-weight: bold; margin-bottom: 5px; }
  .from-section .address { font-size: 18px; line-height: 1.4; }
  .to-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .to-section .company { font-size: 32px; font-weight: bold; margin-bottom: 10px; }
  .to-section .attention { font-size: 24px; margin-bottom: 10px; }
  .to-section .address { font-size: 24px; line-height: 1.4; }
  .footer {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-top: 30px;
    padding-top: 20px;
    border-top: 2px solid #000;
  }
  .box-count { font-size: 48px; font-weight: bold; }
  .po-number { font-size: 20px; }
  .dimensions { font-size: 16px; color: #666; }
  @media print {
    body { padding: 20px; }
  }
</style>
</head><body>
<div class="label-container">
  <div class="from-section">
    <div class="label">FROM:</div>
    <div class="address">
      AA SURPLUS SALES INC<br>
      2153 POND RD<br>
      RONKONKOMA, NY 11779<br>
      USA
    </div>
  </div>
  
  <div class="to-section">
    <div class="company">${(order.customerName || '').toUpperCase()}</div>
    ${order.customerContact ? `<div class="attention">ATT: ${order.customerContact.toUpperCase()}</div>` : ''}
    <div class="address">
      ${(order.customerAddress || '').toUpperCase().replace(/, /g, '<br>')}
    </div>
  </div>
  
  <div class="footer">
    <div>
      <div class="po-number">PO: ${order.poNumber}</div>
      ${triwall.length && triwall.width && triwall.height ? 
        `<div class="dimensions">${triwall.length}" x ${triwall.width}" x ${triwall.height}"${displayWeight ? ' | ' + displayWeight + ' lbs' : ''}</div>` : 
        (displayWeight ? `<div class="dimensions">Weight: ${displayWeight} lbs</div>` : '')}
    </div>
    <div class="box-count">${labelNumber} OF ${totalTriwalls}</div>
  </div>
</div>
</body></html>`;

    const printWindow = window.open('', '_blank');
    printWindow.document.write(printContent);
    printWindow.document.close();
    printWindow.print();
  };

  const printAllShippingLabels = (order) => {
    const triwalls = order.triwalls || [];
    if (triwalls.length === 0) {
      // Print single label if no triwall data
      printShippingLabel(order, 0);
      return;
    }
    // Print each triwall label
    triwalls.forEach((_, idx) => {
      setTimeout(() => printShippingLabel(order, idx), idx * 500);
    });
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

              {/* Ship To Address */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input 
                    type="checkbox" 
                    checked={newPO.useShipTo || false}
                    onChange={e => setNewPO({ ...newPO, useShipTo: e.target.checked, shipToAddress: e.target.checked ? newPO.shipToAddress : '' })}
                  />
                  <span style={{ fontWeight: 600 }}>Ship to different address</span>
                </label>
                {newPO.useShipTo && (
                  <textarea 
                    placeholder="Enter ship to address..."
                    value={newPO.shipToAddress || ''}
                    onChange={e => setNewPO({ ...newPO, shipToAddress: e.target.value })}
                    style={{ width: '100%', padding: 10, borderRadius: 4, border: '1px solid #ddd', marginTop: 10, minHeight: 80 }}
                  />
                )}
              </div>

              {/* Add Items */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                  <label style={{ fontWeight: 600 }}>Add Items</label>
                  <button
                    type="button"
                    onClick={() => setShowOneOffModal(true)}
                    className="btn btn-sm"
                    style={{ background: '#ff9800', color: 'white', fontSize: 12 }}
                  >
                    + One-Off Item
                  </button>
                </div>
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
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', alignItems: 'center' }}><span>CC Fee 4%:</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <button 
                            type="button"
                            onClick={() => {
                              const subtotal = newPO.subtotal || 0;
                              const fee = (subtotal * 0.04).toFixed(2);
                              updateTaxShipping('ccFee', fee);
                            }}
                            style={{ padding: '3px 6px', fontSize: 10, background: '#e3f2fd', border: '1px solid #1976d2', borderRadius: 3, cursor: 'pointer', color: '#1976d2' }}
                          >Calc</button>
                          <input type="number" value={newPO.ccFee} onChange={e => updateTaxShipping('ccFee', e.target.value)} style={{ width: 70, padding: 5, textAlign: 'right' }} step="0.01" min="0" />
                        </div>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: '2px solid #388e3c', fontWeight: 'bold', fontSize: 18, color: '#388e3c' }}><span>Total:</span><span>${(newPO.total || 0).toFixed(2)}</span></div>
                    </div>
                  </div>
                </div>
              )}

              {/* Terms and Notes */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 15, marginBottom: 20 }}>
                <div>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Payment Terms</label>
                  <select
                    value={newPO.terms || 'Net 30'}
                    onChange={e => setNewPO({ ...newPO, terms: e.target.value })}
                    style={{ width: '100%', padding: 10, borderRadius: 4, border: '1px solid #ddd' }}
                  >
                    {termsOptions.map(term => (
                      <option key={term} value={term}>{term}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Notes</label>
                  <textarea placeholder="Order notes..." value={newPO.notes} onChange={e => setNewPO({ ...newPO, notes: e.target.value })}
                    style={{ width: '100%', padding: 10, borderRadius: 4, border: '1px solid #ddd', minHeight: 60 }} />
                </div>
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
        <div className="modal-overlay" onClick={closeOrderModal}>
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
                {selectedOrder.shipToAddress && (
                  <p style={{ margin: '8px 0 3px 0', paddingTop: 8, borderTop: '1px dashed #ccc' }}>
                    <strong>📦 Ship To:</strong> {selectedOrder.shipToAddress}
                  </p>
                )}
                <p style={{ margin: '3px 0' }}><strong>Terms:</strong> {selectedOrder.terms || 'Net 30'}</p>
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
                  {selectedOrder.ccFee > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}><span>CC Fee:</span><span>{formatCurrency(selectedOrder.ccFee)}</span></div>}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: '2px solid #333', fontWeight: 'bold', fontSize: 18 }}><span>Total:</span><span>{formatCurrency(selectedOrder.total)}</span></div>
                </div>
              </div>

              {selectedOrder.notes && <div style={{ background: '#fffde7', padding: 15, borderRadius: 8, marginBottom: 20 }}><strong>Notes:</strong> {selectedOrder.notes}</div>}

              {selectedOrder.paymentMethod && (
                <div style={{ background: '#e8f5e9', padding: 15, borderRadius: 8, marginBottom: 20 }}>
                  <strong>💰 Payment:</strong> {
                    { cash: '💵 Cash', credit_card: '💳 Credit Card', zelle: '📱 Zelle', venmo: '📲 Venmo', apple_pay: '🍎 Apple Pay', ach: '🏦 ACH', wire: '🔌 Wire Transfer', check: '📝 Check' }[selectedOrder.paymentMethod] || selectedOrder.paymentMethod
                  }
                  {selectedOrder.paidAt && <span style={{ marginLeft: 15, color: '#666', fontSize: 13 }}>on {formatDate(selectedOrder.paidAt)}</span>}
                </div>
              )}

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {canEdit && <button className="btn" onClick={() => openEditOrder(selectedOrder)} style={{ background: '#ff9800', color: 'white' }}>✏️ Edit</button>}
                <button className="btn" onClick={() => printPO(selectedOrder, 'estimate')} style={{ background: '#1976d2', color: 'white' }}>📋 Estimate</button>
                <button className="btn" onClick={() => printPO(selectedOrder, 'invoice')} style={{ background: '#388e3c', color: 'white' }}>💵 Invoice</button>
                <button className="btn" onClick={() => emailInvoice(selectedOrder)} style={{ background: '#7b1fa2', color: 'white' }}>📧 Email</button>
                {canEdit && (!selectedOrder.status || selectedOrder.status === 'draft') && <button className="btn btn-primary" onClick={() => confirmAndCreatePickList(selectedOrder)}>✓ Confirm & Pick List</button>}
                {canEdit && (selectedOrder.status === 'confirmed' || selectedOrder.status === 'picking') && <button className="btn" onClick={() => openPackOrder(selectedOrder)} style={{ background: '#9c27b0', color: 'white' }}>📦 Pack Order</button>}
                {selectedOrder.packingComplete && (
                  <>
                    <button className="btn" onClick={() => openPackOrder(selectedOrder)} style={{ background: '#9c27b0', color: 'white' }}>📦 Edit Packing</button>
                    <button className="btn" onClick={() => printClientPackingList(selectedOrder)} style={{ background: '#17a2b8', color: 'white' }}>🖨️ Client Packing List</button>
                    <button className="btn" onClick={() => printInternalPackingList(selectedOrder)} style={{ background: '#ff9800', color: 'white' }}>📊 Internal Analysis</button>
                  </>
                )}
                {selectedOrder.packingComplete && selectedOrder.triwalls && selectedOrder.triwalls.length > 0 && (
                  <div style={{ display: 'flex', gap: 5 }}>
                    <button className="btn" onClick={() => printAllShippingLabels(selectedOrder)} style={{ background: '#795548', color: 'white' }}>
                      🏷️ Print All Labels ({selectedOrder.triwalls.length})
                    </button>
                    {selectedOrder.triwalls.length > 1 && (
                      <select
                        onChange={e => { if (e.target.value) { printShippingLabel(selectedOrder, parseInt(e.target.value)); e.target.value = ''; } }}
                        style={{ padding: '8px 12px', border: '1px solid #795548', borderRadius: 4, background: 'white', cursor: 'pointer' }}
                      >
                        <option value="">Print Single...</option>
                        {selectedOrder.triwalls.map((tw, idx) => (
                          <option key={idx} value={idx}>Label {idx + 1} of {selectedOrder.triwalls.length}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
                {canEdit && (selectedOrder.status === 'confirmed' || selectedOrder.status === 'picking' || selectedOrder.packingComplete) && <button className="btn" onClick={() => markShipped(selectedOrder)} style={{ background: '#4CAF50', color: 'white' }}>🚚 Mark Shipped</button>}
                {canEdit && selectedOrder.status === 'shipped' && <button className="btn" onClick={() => markPaid(selectedOrder)} style={{ background: '#4CAF50', color: 'white' }}>💰 Mark Paid</button>}
                {canEdit && <button className="btn" onClick={() => deleteOrder(selectedOrder)} style={{ background: '#f44336', color: 'white' }}>🗑️ Delete</button>}
                <button className="btn" onClick={closeOrderModal} style={{ background: '#6c757d', color: 'white', marginLeft: 'auto' }}>Close</button>
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

      {/* Filter/Sort Section */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button 
            className="btn" 
            onClick={() => setShowFilters(!showFilters)}
            style={{ background: showFilters ? '#2d5f3f' : '#f5f5f5', color: showFilters ? 'white' : '#333' }}
          >
            🔍 Filter {(filterSearch || filterStatus || filterPayment || filterDateFrom || filterDateTo) && '•'}
          </button>
          
          <input
            type="text"
            placeholder="Search PO# or customer..."
            value={filterSearch}
            onChange={e => setFilterSearch(e.target.value)}
            style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 4, width: 220 }}
          />
          
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 4 }}
          >
            <option value="date-desc">Date (Newest)</option>
            <option value="date-asc">Date (Oldest)</option>
            <option value="po-asc">PO# (A-Z)</option>
            <option value="po-desc">PO# (Z-A)</option>
            <option value="customer-asc">Customer (A-Z)</option>
            <option value="customer-desc">Customer (Z-A)</option>
            <option value="total-desc">Total (High-Low)</option>
            <option value="total-asc">Total (Low-High)</option>
          </select>
        </div>
        
        {showFilters && (
          <div style={{ marginTop: 15, padding: 15, background: '#f9f9f9', borderRadius: 8, display: 'flex', gap: 15, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Status</label>
              <select
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value)}
                style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 4, minWidth: 120 }}
              >
                <option value="">All Statuses</option>
                <option value="draft">Draft</option>
                <option value="confirmed">Confirmed</option>
                <option value="picking">Picking</option>
                <option value="packed">Packed</option>
                <option value="shipped">Shipped</option>
                <option value="paid">Paid</option>
              </select>
            </div>
            
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Payment</label>
              <select
                value={filterPayment}
                onChange={e => setFilterPayment(e.target.value)}
                style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 4, minWidth: 120 }}
              >
                <option value="">All</option>
                <option value="paid">Paid</option>
                <option value="unpaid">Unpaid</option>
              </select>
            </div>
            
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Date From</label>
              <input
                type="date"
                value={filterDateFrom}
                onChange={e => setFilterDateFrom(e.target.value)}
                style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 4 }}
              />
            </div>
            
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Date To</label>
              <input
                type="date"
                value={filterDateTo}
                onChange={e => setFilterDateTo(e.target.value)}
                style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 4 }}
              />
            </div>
            
            <button
              className="btn btn-sm"
              onClick={() => { setFilterSearch(''); setFilterStatus(''); setFilterPayment(''); setFilterDateFrom(''); setFilterDateTo(''); }}
              style={{ background: '#6c757d', color: 'white', padding: '8px 12px' }}
            >
              Clear Filters
            </button>
          </div>
        )}
      </div>

      {/* Orders Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white', borderRadius: 8, overflow: 'hidden' }}>
          <thead><tr style={{ background: '#f5f5f5' }}><th style={{ padding: 12, textAlign: 'left', borderBottom: '2px solid #ddd' }}>PO Number</th><th style={{ padding: 12, textAlign: 'left', borderBottom: '2px solid #ddd' }}>Customer</th><th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid #ddd' }}>Items</th><th style={{ padding: 12, textAlign: 'right', borderBottom: '2px solid #ddd' }}>Total</th><th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid #ddd' }}>Status</th><th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid #ddd' }}>Payment</th><th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid #ddd' }}>Date</th><th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid #ddd' }}>Actions</th></tr></thead>
          <tbody>
            {(() => {
              // Filter orders
              let filtered = orders.filter(order => {
                // Search filter
                if (filterSearch) {
                  const search = filterSearch.toLowerCase();
                  const matchPO = order.poNumber?.toLowerCase().includes(search);
                  const matchCustomer = order.customerName?.toLowerCase().includes(search);
                  if (!matchPO && !matchCustomer) return false;
                }
                // Status filter
                if (filterStatus && order.status !== filterStatus) return false;
                // Payment filter
                if (filterPayment) {
                  const isPaid = !!order.paymentMethod;
                  if (filterPayment === 'paid' && !isPaid) return false;
                  if (filterPayment === 'unpaid' && isPaid) return false;
                }
                // Date range filter
                if (filterDateFrom || filterDateTo) {
                  const orderDate = order.createdAt?.toDate ? order.createdAt.toDate() : new Date(order.createdAt);
                  if (filterDateFrom) {
                    const fromDate = new Date(filterDateFrom);
                    fromDate.setHours(0, 0, 0, 0);
                    if (orderDate < fromDate) return false;
                  }
                  if (filterDateTo) {
                    const toDate = new Date(filterDateTo);
                    toDate.setHours(23, 59, 59, 999);
                    if (orderDate > toDate) return false;
                  }
                }
                return true;
              });
              
              // Sort orders
              filtered.sort((a, b) => {
                switch (sortBy) {
                  case 'date-asc':
                    return (a.createdAt?.toDate?.() || new Date(a.createdAt)) - (b.createdAt?.toDate?.() || new Date(b.createdAt));
                  case 'date-desc':
                    return (b.createdAt?.toDate?.() || new Date(b.createdAt)) - (a.createdAt?.toDate?.() || new Date(a.createdAt));
                  case 'po-asc':
                    return (a.poNumber || '').localeCompare(b.poNumber || '');
                  case 'po-desc':
                    return (b.poNumber || '').localeCompare(a.poNumber || '');
                  case 'customer-asc':
                    return (a.customerName || '').localeCompare(b.customerName || '');
                  case 'customer-desc':
                    return (b.customerName || '').localeCompare(a.customerName || '');
                  case 'total-desc':
                    return (b.total || 0) - (a.total || 0);
                  case 'total-asc':
                    return (a.total || 0) - (b.total || 0);
                  default:
                    return 0;
                }
              });
              
              if (filtered.length === 0) {
                return <tr><td colSpan={8} style={{ padding: 40, textAlign: 'center', color: '#999' }}>{orders.length === 0 ? 'No purchase orders yet. Click "+ New Order" to create one.' : 'No orders match your filters.'}</td></tr>;
              }
              
              return filtered.map(order => (
                <tr key={order.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 12 }}><strong>{order.poNumber}</strong></td>
                  <td style={{ padding: 12 }}>{order.customerName}</td>
                  <td style={{ padding: 12, textAlign: 'center' }}>{order.items?.length || 0}</td>
                  <td style={{ padding: 12, textAlign: 'right', fontWeight: 600 }}>{formatCurrency(order.total)}</td>
                  <td style={{ padding: 12, textAlign: 'center' }}>
                    <span style={{ padding: '4px 10px', borderRadius: 4, fontSize: 12, fontWeight: 600, background: getStatusColor(order.status), color: 'white' }}>{order.status || 'draft'}</span>
                    {order.packingComplete && <span style={{ marginLeft: 5, fontSize: 11, color: '#9c27b0' }}>📦</span>}
                  </td>
                  <td style={{ padding: 12, textAlign: 'center' }}>
                    {order.paymentMethod ? (
                      <span style={{ padding: '4px 10px', borderRadius: 4, fontSize: 12, fontWeight: 600, background: '#4CAF50', color: 'white' }}>✓ Paid</span>
                    ) : (
                      <span style={{ padding: '4px 10px', borderRadius: 4, fontSize: 12, fontWeight: 600, background: '#ff9800', color: 'white' }}>Unpaid</span>
                    )}
                  </td>
                  <td style={{ padding: 12, textAlign: 'center', fontSize: 13 }}>{formatDate(order.createdAt)}</td>
                  <td style={{ padding: 12, textAlign: 'center' }}><button className="btn btn-primary" onClick={() => setSelectedOrder(order)} style={{ padding: '4px 12px', fontSize: 12 }}>View</button></td>
                </tr>
              ));
            })()}
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
            <p style={{ fontSize: 16, marginBottom: 15 }}>
              Delete order <strong>{orderToDelete.poNumber}</strong>?
            </p>
            
            {/* Show linked pick list info */}
            {pickLists.find(pl => pl.purchaseOrderId === orderToDelete.id) && (
              <p style={{ fontSize: 13, color: '#666', marginBottom: 15 }}>
                📋 The linked pick list will also be deleted.
              </p>
            )}
            
            {getRestorableItems(orderToDelete).length > 0 && (
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
                      Add picked/shipped quantities back to stock. Use this if the order was cancelled or returned.
                    </p>
                    {deleteRestoreInventory && (
                      <div style={{ marginTop: 10, fontSize: 12, color: '#2e7d32' }}>
                        Will restore:
                        <ul style={{ margin: '5px 0', paddingLeft: 20 }}>
                          {getRestorableItems(orderToDelete).map(i => (
                            <li key={i.itemId}>+{i.restoreQty} {i.itemName}</li>
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

      {/* Payment Method Modal */}
      {showPaymentModal && paymentOrder && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 2000, padding: 20
        }}>
          <div style={{
            background: 'white', borderRadius: 12, padding: 30,
            maxWidth: 450, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
          }}>
            <h3 style={{ marginTop: 0, color: '#388e3c' }}>💰 Confirm Payment</h3>
            <p style={{ fontSize: 16, marginBottom: 15 }}>
              Mark order <strong>{paymentOrder.poNumber}</strong> as paid.
            </p>
            <p style={{ fontSize: 14, color: '#666', marginBottom: 20 }}>
              Total: <strong style={{ color: '#388e3c', fontSize: 18 }}>{formatCurrency(paymentOrder.total)}</strong>
            </p>
            
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>Payment Method</label>
              <select
                value={paymentMethod}
                onChange={e => setPaymentMethod(e.target.value)}
                style={{ width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14 }}
              >
                <option value="">-- Select Payment Method --</option>
                <option value="cash">💵 Cash</option>
                <option value="credit_card">💳 Credit Card</option>
                <option value="zelle">📱 Zelle</option>
                <option value="venmo">📲 Venmo</option>
                <option value="apple_pay">🍎 Apple Pay</option>
                <option value="ach">🏦 ACH</option>
                <option value="wire">🔌 Wire Transfer</option>
                <option value="check">📝 Check</option>
              </select>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => { setShowPaymentModal(false); setPaymentOrder(null); setPaymentMethod(''); }}
                style={{
                  flex: 1, padding: '12px 20px', background: '#6c757d', color: 'white',
                  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 600
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmPayment}
                disabled={!paymentMethod}
                style={{
                  flex: 1, padding: '12px 20px', background: paymentMethod ? '#388e3c' : '#ccc', color: 'white',
                  border: 'none', borderRadius: 6, cursor: paymentMethod ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 600
                }}
              >
                ✓ Confirm Payment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* One-Off Item Modal */}
      {showOneOffModal && (
        <div className="modal-overlay" onClick={() => setShowOneOffModal(false)} style={{ zIndex: 1100 }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 450 }}>
            <div className="modal-header">
              <h3 style={{ margin: 0 }}>➕ Add One-Off Item</h3>
              <button className="modal-close" onClick={() => setShowOneOffModal(false)}>×</button>
            </div>
            <div className="modal-body" style={{ padding: 20 }}>
              <p style={{ background: '#fff3e0', padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 20, border: '1px solid #ffcc80' }}>
                <strong>🔸 One-Off Items</strong> get an auto-generated SKU starting with "A" (e.g., A1001). 
                These items are added to your inventory and can be filtered/cleaned up later.
              </p>
              
              <div style={{ marginBottom: 15 }}>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Item Name *</label>
                <input
                  type="text"
                  placeholder="Enter item name..."
                  value={oneOffItem.name}
                  onChange={e => setOneOffItem({ ...oneOffItem, name: e.target.value })}
                  style={{ width: '100%', padding: 10, borderRadius: 4, border: '1px solid #ddd' }}
                  autoFocus
                />
              </div>
              
              <div style={{ marginBottom: 15 }}>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Price</label>
                <input
                  type="number"
                  placeholder="0.00"
                  value={oneOffItem.price}
                  onChange={e => setOneOffItem({ ...oneOffItem, price: e.target.value })}
                  style={{ width: '100%', padding: 10, borderRadius: 4, border: '1px solid #ddd' }}
                  step="0.01"
                  min="0"
                />
              </div>
              
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Category</label>
                <input
                  type="text"
                  placeholder="One-Off"
                  value={oneOffItem.category}
                  onChange={e => setOneOffItem({ ...oneOffItem, category: e.target.value })}
                  style={{ width: '100%', padding: 10, borderRadius: 4, border: '1px solid #ddd' }}
                />
              </div>
              
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => { setShowOneOffModal(false); setOneOffItem({ name: '', price: '', category: 'One-Off' }); }}
                  className="btn"
                  style={{ flex: 1, background: '#6c757d', color: 'white' }}
                >
                  Cancel
                </button>
                <button
                  onClick={createOneOffItem}
                  className="btn btn-primary"
                  style={{ flex: 1, background: '#ff9800' }}
                >
                  Create & Add to PO
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
