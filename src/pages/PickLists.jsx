import { useState, useEffect, useRef } from 'react';
import { BrowserMultiFormatReader } from '@zxing/library';
import { OrgDB as DB } from '../orgDb';

export default function PickLists() {
  const [pickLists, setPickLists] = useState([]);
  const [items, setItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedList, setSelectedList] = useState(null);
  const [localPickedQty, setLocalPickedQty] = useState({}); // Local state for picked quantities
  
  // Filter state
  const [filterStatus, setFilterStatus] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [filterAssignee, setFilterAssignee] = useState('');
  const [sortBy, setSortBy] = useState('date-desc');
  
  // Pack Order state
  const [showPackOrder, setShowPackOrder] = useState(false);
  const [packingOrder, setPackingOrder] = useState(null);
  const [boxAssignments, setBoxAssignments] = useState({});
  const [boxDetails, setBoxDetails] = useState({}); // { boxNumber: { weight: '', length: '', width: '', height: '' } }
  const [packingMode, setPackingMode] = useState('boxes'); // 'boxes' or 'triwalls'
  const [triwalls, setTriwalls] = useState([]); // [{ id: 1, length: '', width: '', height: '', weight: '', items: {} }]
  const [triwallAssignments, setTriwallAssignments] = useState({}); // { itemIndex: [{ triwall: 1, qty: 5 }] }
  const [packedItems, setPackedItems] = useState({}); // { itemIndex: true/false } - track which items are checked as packed
  
  // QR Scanner state
  const [scanMode, setScanMode] = useState(false);
  const [scanMessage, setScanMessage] = useState('');
  const videoRef = useRef(null);
  const readerRef = useRef(null);
  
  // New pick list form
  const [newList, setNewList] = useState({
    name: '',
    notes: '',
    assignedTo: '',
    items: []
  });
  const [searchItem, setSearchItem] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [editingListId, setEditingListId] = useState(null);
  
  const assigneeOptions = ['Alan', 'Nancy', 'Gustavo'];
  
  useEffect(() => {
    loadData();
  }, []);

  // Initialize local picked quantities when selectedList changes
  useEffect(() => {
    if (selectedList) {
      const initialQty = {};
      selectedList.items?.forEach(item => {
        initialQty[item.itemId] = item.pickedQty || 0;
      });
      setLocalPickedQty(initialQty);
    }
  }, [selectedList]);

  const loadData = async () => {
    setLoading(true);
    const [lists, itemsData, locsData, ordersData] = await Promise.all([
      DB.getPickLists(),
      DB.getItems(),
      DB.getLocations(),
      DB.getPurchaseOrders()
    ]);
    setPickLists(lists);
    setItems(itemsData);
    setLocations(locsData);
    setOrders(ordersData);
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

    if (editMode && editingListId) {
      // Update existing pick list
      await DB.updatePickList(editingListId, {
        name: newList.name,
        notes: newList.notes,
        assignedTo: newList.assignedTo,
        items: newList.items
      });
    } else {
      // Create new pick list
      await DB.createPickList(newList);
    }
    
    setNewList({ name: '', notes: '', assignedTo: '', items: [] });
    setShowCreate(false);
    setEditMode(false);
    setEditingListId(null);
    loadData();
  };

  const openEditPickList = (list) => {
    setNewList({
      name: list.name || '',
      notes: list.notes || '',
      assignedTo: list.assignedTo || '',
      items: list.items || []
    });
    setEditingListId(list.id);
    setEditMode(true);
    setShowCreate(true);
    setSelectedList(null); // Close the view modal
  };

  const resetPickListForm = () => {
    setNewList({ name: '', notes: '', assignedTo: '', items: [] });
    setShowCreate(false);
    setEditMode(false);
    setEditingListId(null);
  };

  const updatePickedQty = async (list, itemId, qty) => {
    const updatedItems = list.items.map(i =>
      i.itemId === itemId ? { ...i, pickedQty: parseInt(qty) || 0 } : i
    );
    
    await DB.updatePickList(list.id, { items: updatedItems });
    
    // Update selectedList locally without full reload
    setSelectedList(prev => ({
      ...prev,
      items: updatedItems
    }));
  };

  // Handle local input change (no database call)
  const handleLocalQtyChange = (itemId, value) => {
    setLocalPickedQty(prev => ({
      ...prev,
      [itemId]: value === '' ? '' : (parseInt(value) || 0)
    }));
  };

  // Save to database on blur
  const handleQtyBlur = async (itemId) => {
    const qty = localPickedQty[itemId];
    if (selectedList) {
      await updatePickedQty(selectedList, itemId, qty);
    }
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
      const finalQty = Math.min(newPickedQty, pickListItem.requestedQty);
      
      // Update local state immediately
      setLocalPickedQty(prev => ({
        ...prev,
        [scannedItem.id]: finalQty
      }));
      
      await updatePickedQty(selectedList, scannedItem.id, finalQty);
    }
  };

  const getStatusColor = (status) => {
    switch(status) {
      case 'completed': return '#4CAF50';
      case 'in_progress': return '#ff9800';
      case 'packed': return '#9c27b0';
      case 'shipped': return '#2196F3';
      default: return '#2196F3';
    }
  };
  
  const getDisplayStatus = (list) => {
    const linkedOrder = getLinkedOrder(list);
    // If picked list is completed, check the linked order for packing/shipping status
    if (list.status === 'completed' && linkedOrder) {
      if (linkedOrder.status === 'shipped') return 'shipped';
      if (linkedOrder.status === 'packed' || linkedOrder.packingComplete) return 'packed';
    }
    return list.status || 'pending';
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

  // ==================== PACK ORDER FUNCTIONS ====================
  
  const getLinkedOrder = (pickList) => {
    if (!pickList.purchaseOrderId) return null;
    return orders.find(o => o.id === pickList.purchaseOrderId);
  };

  const openPackOrder = (pickList) => {
    const order = getLinkedOrder(pickList);
    if (!order) {
      alert('No linked purchase order found for this pick list.');
      return;
    }
    
    // Build a map of picked quantities from the pick list
    const pickedQtyMap = {};
    if (pickList.items) {
      pickList.items.forEach(plItem => {
        pickedQtyMap[plItem.itemId] = plItem.pickedQty || 0;
      });
    }
    
    // Store pick list reference and picked quantities with the order for packing
    const orderWithPickedQty = {
      ...order,
      pickListId: pickList.id,
      items: (order.items || []).map(item => ({
        ...item,
        pickedQty: pickedQtyMap[item.itemId] ?? (parseInt(item.qtyShipped) || parseInt(item.quantity) || 0)
      }))
    };
    
    setPackingOrder(orderWithPickedQty);
    
    // Check if order was previously packed with triwalls
    if (order.triwalls && order.triwalls.length > 0) {
      setPackingMode('triwalls');
      setTriwalls(order.triwalls);
      setTriwallAssignments(order.triwallAssignments || {});
    } else {
      setPackingMode('boxes');
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
      setTriwalls([]);
      setTriwallAssignments({});
    }
    
    // Initialize box details from saved data or empty
    setBoxDetails(order.boxDetails || {});
    
    // Initialize packed items checkboxes from saved data
    setPackedItems(order.packedItems || {});
    
    setShowPackOrder(true);
  };

  // ==================== TRIWALL FUNCTIONS ====================
  
  const addTriwall = () => {
    const newId = triwalls.length > 0 ? Math.max(...triwalls.map(t => t.id)) + 1 : 1;
    setTriwalls([...triwalls, { id: newId, length: '', width: '', height: '', weight: '' }]);
    
    // Initialize all items to go into the first triwall if this is the first one
    if (triwalls.length === 0) {
      const assignments = {};
      packingOrder.items.forEach((item, idx) => {
        assignments[idx] = [{ triwall: newId, qty: item.pickedQty || 0 }];
      });
      setTriwallAssignments(assignments);
    }
  };

  const removeTriwall = (triwallId) => {
    if (triwalls.length <= 1) {
      alert('Must have at least one triwall');
      return;
    }
    setTriwalls(triwalls.filter(t => t.id !== triwallId));
    // Remove assignments for this triwall
    const newAssignments = {};
    Object.keys(triwallAssignments).forEach(idx => {
      newAssignments[idx] = triwallAssignments[idx].filter(a => a.triwall !== triwallId);
    });
    setTriwallAssignments(newAssignments);
  };

  const updateTriwallDetail = (triwallId, field, value) => {
    setTriwalls(triwalls.map(t => 
      t.id === triwallId ? { ...t, [field]: value } : t
    ));
  };

  const updateTriwallAssignment = (itemIndex, triwallId, qty) => {
    setTriwallAssignments(prev => {
      const itemAssignments = prev[itemIndex] || [];
      const existingIdx = itemAssignments.findIndex(a => a.triwall === triwallId);
      
      if (existingIdx >= 0) {
        const updated = [...itemAssignments];
        updated[existingIdx] = { triwall: triwallId, qty: parseInt(qty) || 0 };
        return { ...prev, [itemIndex]: updated };
      } else {
        return { ...prev, [itemIndex]: [...itemAssignments, { triwall: triwallId, qty: parseInt(qty) || 0 }] };
      }
    });
  };

  const getTriwallAssignmentQty = (itemIndex, triwallId) => {
    const assignments = triwallAssignments[itemIndex] || [];
    const assignment = assignments.find(a => a.triwall === triwallId);
    return assignment ? assignment.qty : 0;
  };

  const getTriwallItemTotal = (itemIndex) => {
    const assignments = triwallAssignments[itemIndex] || [];
    return assignments.reduce((sum, a) => sum + (a.qty || 0), 0);
  };

  const calculateTriwallWeight = (triwallId) => {
    let totalWeight = 0;
    packingOrder?.items?.forEach((item, idx) => {
      const qty = getTriwallAssignmentQty(idx, triwallId);
      const itemWeight = parseFloat(item.weight) || parseFloat(item.weightPerItem) || 0;
      totalWeight += qty * itemWeight;
    });
    return totalWeight;
  };

  const validateTriwallPacking = () => {
    if (triwalls.length === 0) return false;
    for (let idx = 0; idx < packingOrder.items.length; idx++) {
      const item = packingOrder.items[idx];
      const expected = item.pickedQty || 0;
      const actual = getTriwallItemTotal(idx);
      if (actual !== expected) return false;
    }
    return true;
  };

  const printTriwallLabel = (triwallId, triwallIndex) => {
    const triwall = triwalls.find(t => t.id === triwallId);
    const order = packingOrder;
    const totalTriwalls = triwalls.length;
    const labelNumber = triwallIndex + 1;
    
    // Calculate weight
    const estimatedWeight = calculateTriwallWeight(triwallId);
    const displayWeight = triwall.weight || estimatedWeight.toFixed(1);
    
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
        `<div class="dimensions">${triwall.length}" x ${triwall.width}" x ${triwall.height}" | ${displayWeight} lbs</div>` : 
        (displayWeight ? `<div class="dimensions">Est. Weight: ${displayWeight} lbs</div>` : '')}
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

  const updateBoxDetail = (boxNum, field, value) => {
    setBoxDetails(prev => ({
      ...prev,
      [boxNum]: { ...(prev[boxNum] || {}), [field]: value }
    }));
  };

  const getUniqueBoxNumbers = () => {
    const boxes = new Set();
    Object.values(boxAssignments).forEach(dists => {
      dists.forEach(d => boxes.add(d.box));
    });
    return Array.from(boxes).sort((a, b) => a - b);
  };

  const updateBoxDistribution = (itemIndex, distIndex, field, value) => {
    setBoxAssignments(prev => {
      const itemDist = [...(prev[itemIndex] || [])];
      if (field === 'qty') {
        itemDist[distIndex] = { ...itemDist[distIndex], [field]: parseInt(value) || 0 };
      } else if (field === 'box') {
        // Allow typing any number 1-99, keep the raw value while typing
        const numValue = parseInt(value);
        if (value === '' || value === '0') {
          // Allow empty temporarily while typing, but show empty
          itemDist[distIndex] = { ...itemDist[distIndex], [field]: value === '' ? '' : 0 };
        } else if (!isNaN(numValue) && numValue >= 1 && numValue <= 99) {
          itemDist[distIndex] = { ...itemDist[distIndex], [field]: numValue };
        }
      }
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
    
    // Validate based on packing mode
    if (packingMode === 'triwalls') {
      if (!validateTriwallPacking()) {
        alert('Please make sure all quantities are distributed correctly across triwalls.');
        return;
      }
    } else {
      if (!validatePacking()) {
        alert('Please make sure all quantities are distributed correctly across boxes.');
        return;
      }
    }
    
    console.log('savePackOrder called for order:', packingOrder.id, packingOrder.poNumber, 'mode:', packingMode);
    
    // Calculate qtyShipped based on packing mode
    const updatedItems = packingOrder.items.map((item, idx) => {
      let totalPacked;
      if (packingMode === 'triwalls') {
        totalPacked = getTriwallItemTotal(idx);
        return {
          ...item,
          qtyShipped: totalPacked,
          triwallAssignments: triwallAssignments[idx] || []
        };
      } else {
        const distributions = boxAssignments[idx] || [{ box: 1, qty: getItemQty(item) }];
        totalPacked = distributions.reduce((sum, d) => sum + (parseInt(d.qty) || 0), 0);
        return {
          ...item,
          qtyShipped: totalPacked,
          boxDistributions: distributions
        };
      }
    });
    
    // Recalculate order totals based on new qtyShipped values
    const newSubtotal = updatedItems.reduce((sum, item) => {
      return sum + ((item.qtyShipped || 0) * (parseFloat(item.unitPrice) || 0));
    }, 0);
    const tax = parseFloat(packingOrder.tax) || 0;
    const shipping = parseFloat(packingOrder.shipping) || 0;
    
    const updateData = {
      ...packingOrder,
      items: updatedItems,
      packingMode: packingMode,
      packingComplete: true,
      status: 'packed',
      subtotal: newSubtotal,
      total: newSubtotal + tax + shipping
    };
    
    // Add mode-specific data
    if (packingMode === 'triwalls') {
      updateData.triwalls = triwalls;
      updateData.triwallAssignments = triwallAssignments;
    } else {
      updateData.boxDistributions = boxAssignments;
      updateData.boxDetails = boxDetails;
    }
    
    // Save packed items checkboxes
    updateData.packedItems = packedItems;
    
    console.log('Updating PO with data:', { id: packingOrder.id, status: updateData.status, packingMode: updateData.packingMode });
    
    try {
      await DB.updatePurchaseOrder(packingOrder.id, updateData);
      console.log('PO updated successfully');
    } catch (error) {
      console.error('Error updating PO:', error);
      alert('Error saving: ' + error.message);
      return;
    }
    
    setShowPackOrder(false);
    setPackingOrder(null);
    setPackingMode('boxes');
    setTriwalls([]);
    setTriwallAssignments({});
    setPackedItems({});
    loadData();
    alert('Packing saved! Shipped quantities updated.');
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

      {/* Filters */}
      <div style={{ display: 'flex', gap: 15, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search by name or PO#..."
          value={filterSearch}
          onChange={e => setFilterSearch(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 4, minWidth: 200 }}
        />
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 4 }}
        >
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed (Picked)</option>
          <option value="packed">Packed</option>
          <option value="shipped">Shipped</option>
        </select>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 4 }}
        >
          <option value="date-desc">Newest First</option>
          <option value="date-asc">Oldest First</option>
          <option value="name-asc">Name A-Z</option>
          <option value="name-desc">Name Z-A</option>
        </select>
        <select
          value={filterAssignee}
          onChange={e => setFilterAssignee(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 4 }}
        >
          <option value="">All Assignees</option>
          {assigneeOptions.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {(filterSearch || filterStatus || filterAssignee) && (
          <button
            className="btn btn-sm"
            onClick={() => { setFilterSearch(''); setFilterStatus(''); setFilterAssignee(''); }}
            style={{ background: '#6c757d', color: 'white', padding: '8px 12px' }}
          >
            Clear Filters
          </button>
        )}
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0 }}>{editMode ? 'Edit Pick List' : 'Create Pick List'}</h3>
              <button onClick={resetPickListForm} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#666' }}>×</button>
            </div>
            
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
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Assign To</label>
              <select
                className="form-input"
                value={newList.assignedTo}
                onChange={e => setNewList({ ...newList, assignedTo: e.target.value })}
                style={{ width: '100%', padding: 10 }}
              >
                <option value="">-- Select --</option>
                {assigneeOptions.map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
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
                {editMode ? 'Save Changes' : 'Create Pick List'}
              </button>
              <button className="btn" onClick={resetPickListForm} style={{ flex: 1, background: '#6c757d', color: 'white' }}>
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
                <div style={{ display: 'flex', gap: 10, marginBottom: scanMode ? 10 : 0 }}>
                  {!scanMode && (
                    <>
                      <button 
                        className="btn btn-primary"
                        onClick={startScanner}
                        style={{ flex: 1 }}
                      >
                        📷 Scan Item QR Code
                      </button>
                      <button 
                        className="btn"
                        onClick={() => {
                          // Fill all items with their requested qty
                          const updatedQty = {};
                          selectedList.items?.forEach(item => {
                            updatedQty[item.itemId] = item.requestedQty;
                          });
                          setLocalPickedQty(updatedQty);
                          // Save all to database
                          const updatedItems = selectedList.items?.map(item => ({
                            ...item,
                            pickedQty: item.requestedQty
                          }));
                          DB.updatePickList(selectedList.id, { items: updatedItems });
                          setSelectedList(prev => ({ ...prev, items: updatedItems }));
                        }}
                        style={{ background: '#4CAF50', color: 'white' }}
                      >
                        ✓ Fill All
                      </button>
                      <button 
                        className="btn"
                        onClick={() => openEditPickList(selectedList)}
                        style={{ background: '#ff9800', color: 'white' }}
                      >
                        ✏️ Edit
                      </button>
                    </>
                  )}
                </div>
                {scanMode && (
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
            
            {/* Edit button for COMPLETED lists */}
            {selectedList.status === 'completed' && (
              <div style={{ marginBottom: 20, display: 'flex', gap: 10 }}>
                <button 
                  className="btn"
                  onClick={() => {
                    // Fill all items with their requested qty
                    const updatedQty = {};
                    selectedList.items?.forEach(item => {
                      updatedQty[item.itemId] = item.requestedQty;
                    });
                    setLocalPickedQty(updatedQty);
                    // Save all to database
                    const updatedItems = selectedList.items?.map(item => ({
                      ...item,
                      pickedQty: item.requestedQty
                    }));
                    DB.updatePickList(selectedList.id, { items: updatedItems });
                    setSelectedList(prev => ({ ...prev, items: updatedItems }));
                  }}
                  style={{ background: '#4CAF50', color: 'white' }}
                >
                  ✓ Fill All
                </button>
                <button 
                  className="btn"
                  onClick={() => openEditPickList(selectedList)}
                  style={{ background: '#ff9800', color: 'white' }}
                >
                  ✏️ Edit Items
                </button>
                <button 
                  className="btn"
                  onClick={async () => {
                    if (confirm('Reopen this pick list? Status will change back to "in progress".')) {
                      await DB.updatePickList(selectedList.id, { status: 'in_progress' });
                      setSelectedList(prev => ({ ...prev, status: 'in_progress' }));
                      loadData();
                    }
                  }}
                  style={{ background: '#2196F3', color: 'white' }}
                >
                  🔄 Reopen
                </button>
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
                      <input
                        type="number"
                        value={localPickedQty[item.itemId] ?? item.pickedQty ?? 0}
                        onChange={e => handleLocalQtyChange(item.itemId, e.target.value)}
                        onBlur={() => handleQtyBlur(item.itemId)}
                        style={{ width: 60, padding: 5, textAlign: 'center' }}
                        min="0"
                        max={item.requestedQty}
                      />
                    </td>
                    <td style={{ padding: 10, textAlign: 'center' }}>
                      {(localPickedQty[item.itemId] ?? item.pickedQty ?? 0) >= item.requestedQty ? '✅' : (localPickedQty[item.itemId] ?? item.pickedQty ?? 0) > 0 ? '🔶' : '⬜'}
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
              <th>Assigned To</th>
              <th>Items</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              // Filter pick lists
              let filtered = pickLists.filter(list => {
                if (filterSearch) {
                  const search = filterSearch.toLowerCase();
                  const matchName = list.name?.toLowerCase().includes(search);
                  if (!matchName) return false;
                }
                if (filterStatus) {
                  const displayStatus = getDisplayStatus(list);
                  if (displayStatus !== filterStatus) return false;
                }
                if (filterAssignee && list.assignedTo !== filterAssignee) return false;
                return true;
              });
              
              // Sort
              filtered.sort((a, b) => {
                const getTime = (ts) => {
                  if (!ts) return 0;
                  if (ts.toDate) return ts.toDate().getTime();
                  if (ts.seconds) return ts.seconds * 1000;
                  return new Date(ts).getTime() || 0;
                };
                switch (sortBy) {
                  case 'date-asc':
                    return getTime(a.createdAt) - getTime(b.createdAt);
                  case 'date-desc':
                    return getTime(b.createdAt) - getTime(a.createdAt);
                  case 'name-asc':
                    return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
                  case 'name-desc':
                    return (b.name || '').toLowerCase().localeCompare((a.name || '').toLowerCase());
                  default:
                    return getTime(b.createdAt) - getTime(a.createdAt);
                }
              });
              
              if (filtered.length === 0) {
                return (
                  <tr>
                    <td colSpan={7} style={{ padding: 40, textAlign: 'center', color: '#999' }}>
                      {pickLists.length === 0 ? 'No pick lists yet.' : 'No pick lists match your filters.'}
                    </td>
                  </tr>
                );
              }
              
              return filtered.map(list => {
              const displayStatus = getDisplayStatus(list);
              return (
              <tr key={list.id}>
                <td><strong>{list.name}</strong></td>
                <td style={{ fontSize: 13 }}>{list.assignedTo || <span style={{ color: '#999' }}>—</span>}</td>
                <td>{list.items?.length || 0} items</td>
                <td>
                  <span style={{
                    padding: '4px 8px', borderRadius: 4, fontSize: 12,
                    background: getStatusColor(displayStatus), color: 'white'
                  }}>
                    {displayStatus}
                  </span>
                </td>
                <td style={{ fontSize: 13 }}>{formatDate(list.createdAt)}</td>
                <td>
                  <div className="action-buttons">
                    <button 
                      className="btn btn-primary btn-sm"
                      onClick={() => setSelectedList(list)}
                    >
                      {list.status === 'completed' ? 'View' : 'Process'}
                    </button>
                    {list.status === 'completed' && list.purchaseOrderId && (
                      <button 
                        className="btn btn-sm"
                        onClick={() => openPackOrder(list)}
                        style={{ background: '#9c27b0', color: 'white' }}
                      >
                        {getLinkedOrder(list)?.packingComplete ? '📦 Edit Pack' : '📦 Pack'}
                      </button>
                    )}
                    <button 
                      className="btn btn-sm"
                      onClick={() => printPickList(list)}
                      style={{ background: '#607d8b', color: 'white' }}
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
              );
              });
            })()}
          </tbody>
        </table>
      </div>

      {/* Pack Order Modal */}
      {showPackOrder && packingOrder && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 1000, padding: 20
        }} onClick={() => setShowPackOrder(false)}>
          <div style={{
            background: 'white', borderRadius: 12, maxWidth: 800, width: '100%',
            maxHeight: '90vh', overflow: 'auto'
          }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '15px 20px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>📦 Pack Order - {packingOrder.poNumber}</h3>
              <button onClick={() => setShowPackOrder(false)} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#666' }}>×</button>
            </div>
            <div style={{ padding: 20 }}>
              {/* Packing Mode Toggle */}
              <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
                <button
                  onClick={() => setPackingMode('boxes')}
                  style={{
                    flex: 1, padding: '12px 20px', borderRadius: 8, border: 'none', cursor: 'pointer',
                    background: packingMode === 'boxes' ? '#2196F3' : '#e0e0e0',
                    color: packingMode === 'boxes' ? 'white' : '#333',
                    fontWeight: 600, fontSize: 14
                  }}
                >
                  📦 Regular Boxes
                </button>
                <button
                  onClick={() => {
                    setPackingMode('triwalls');
                    if (triwalls.length === 0) addTriwall();
                  }}
                  style={{
                    flex: 1, padding: '12px 20px', borderRadius: 8, border: 'none', cursor: 'pointer',
                    background: packingMode === 'triwalls' ? '#9c27b0' : '#e0e0e0',
                    color: packingMode === 'triwalls' ? 'white' : '#333',
                    fontWeight: 600, fontSize: 14
                  }}
                >
                  🏗️ Triwalls / Gaylords
                </button>
              </div>

              <div style={{ background: '#e3f2fd', padding: 12, borderRadius: 8, marginBottom: 20, fontSize: 13 }}>
                <strong>📋 Quantities from Pick List</strong>
                <span style={{ color: '#666', marginLeft: 10 }}>Packing quantities are based on what was actually picked.</span>
              </div>
              
              {/* TRIWALL PACKING MODE */}
              {packingMode === 'triwalls' && (
                <>
                  {/* Items with triwall assignments - same layout as box mode */}
                  {(packingOrder.items || []).map((item, idx) => {
                    const pickedQty = getItemQty(item);
                    const orderedQty = parseInt(item.qtyShipped) || parseInt(item.quantity) || 0;
                    const distributedQty = getTriwallItemTotal(idx);
                    const isValid = distributedQty === pickedQty;
                    const hasShortage = pickedQty < orderedQty;
                    const isChecked = packedItems[idx] || false;
                    
                    return (
                      <div key={idx} style={{ 
                        marginBottom: 20, padding: 15, 
                        background: isChecked ? '#e8f5e9' : (isValid ? '#f5f5f5' : '#fff3e0'), 
                        borderRadius: 8, 
                        border: isChecked ? '2px solid #4CAF50' : (isValid ? '1px solid #ddd' : '2px solid #ff9800')
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <button
                              onClick={() => setPackedItems(prev => ({ ...prev, [idx]: !prev[idx] }))}
                              style={{
                                width: 32, height: 32, borderRadius: 4, border: '2px solid #4CAF50',
                                background: isChecked ? '#4CAF50' : 'white',
                                color: isChecked ? 'white' : '#4CAF50',
                                cursor: 'pointer', fontSize: 18, fontWeight: 'bold',
                                display: 'flex', alignItems: 'center', justifyContent: 'center'
                              }}
                            >
                              {isChecked ? '✓' : ''}
                            </button>
                            <div>
                              <strong>{item.itemName}</strong>
                              {item.partNumber && <span style={{ color: '#666', marginLeft: 10, fontSize: 12 }}>{item.partNumber}</span>}
                              {hasShortage && (
                                <div style={{ fontSize: 11, color: '#f57c00', marginTop: 2 }}>
                                  ⚠️ Shortage: Ordered {orderedQty}, Picked {pickedQty}
                                </div>
                              )}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <span style={{ fontWeight: 'bold', color: isValid ? '#4CAF50' : '#ff9800' }}>
                              {distributedQty} / {pickedQty}
                            </span>
                            <div style={{ fontSize: 10, color: '#666' }}>packed / picked</div>
                            {!isValid && <div style={{ fontSize: 11, color: '#ff9800' }}>⚠️ {distributedQty < pickedQty ? `${pickedQty - distributedQty} remaining` : `${distributedQty - pickedQty} over`}</div>}
                          </div>
                        </div>
                        
                        {/* Triwall assignments - similar to box assignments */}
                        {triwalls.map((triwall, twIdx) => (
                          <div key={triwall.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                            <span style={{ width: 60 }}>Triwall</span>
                            <span style={{ width: 60, padding: 6, textAlign: 'center', fontWeight: 'bold', background: '#f3e5f5', borderRadius: 4 }}>
                              {twIdx + 1}
                            </span>
                            <span style={{ width: 40 }}>Qty:</span>
                            <input
                              type="number"
                              min="0"
                              max={pickedQty}
                              value={getTriwallAssignmentQty(idx, triwall.id) || ''}
                              onChange={e => updateTriwallAssignment(idx, triwall.id, e.target.value)}
                              style={{ width: 70, padding: 6, textAlign: 'center' }}
                            />
                          </div>
                        ))}
                        
                        {triwalls.length === 0 && (
                          <div style={{ color: '#666', fontSize: 13, fontStyle: 'italic' }}>
                            Add a triwall below to assign items
                          </div>
                        )}
                      </div>
                    );
                  })}
                  
                  {/* Triwall Weight & Dimensions Section - similar to box details */}
                  <div style={{ marginTop: 25, padding: 20, background: '#f3e5f5', borderRadius: 8, border: '1px solid #ce93d8' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
                      <h4 style={{ margin: 0, color: '#7b1fa2' }}>🏗️ Triwall Details</h4>
                      <button
                        onClick={addTriwall}
                        style={{ 
                          padding: '8px 16px', background: '#9c27b0', color: 'white',
                          border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600, fontSize: 13
                        }}
                      >
                        + Add Triwall
                      </button>
                    </div>
                    
                    {triwalls.map((triwall, twIdx) => {
                      const estimatedWeight = calculateTriwallWeight(triwall.id);
                      return (
                        <div key={triwall.id} style={{ display: 'flex', alignItems: 'center', gap: 15, marginBottom: 12, flexWrap: 'wrap', paddingBottom: 12, borderBottom: twIdx < triwalls.length - 1 ? '1px solid #ce93d8' : 'none' }}>
                          <strong style={{ minWidth: 80 }}>Triwall {twIdx + 1}:</strong>
                          
                          {/* Quick fill buttons */}
                          <button
                            type="button"
                            onClick={() => {
                              updateTriwallDetail(triwall.id, 'length', '48');
                              updateTriwallDetail(triwall.id, 'width', '44');
                              updateTriwallDetail(triwall.id, 'height', '48');
                              updateTriwallDetail(triwall.id, 'type', 'brown');
                              const itemWeight = calculateTriwallWeight(triwall.id);
                              updateTriwallDetail(triwall.id, 'weight', (itemWeight + 120).toFixed(1));
                            }}
                            style={{ padding: '4px 8px', background: '#8d6e63', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                          >
                            🟤 Brown
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              updateTriwallDetail(triwall.id, 'length', '46');
                              updateTriwallDetail(triwall.id, 'width', '39');
                              updateTriwallDetail(triwall.id, 'height', '45');
                              updateTriwallDetail(triwall.id, 'type', 'white');
                              const itemWeight = calculateTriwallWeight(triwall.id);
                              updateTriwallDetail(triwall.id, 'weight', (itemWeight + 75).toFixed(1));
                            }}
                            style={{ padding: '4px 8px', background: '#e0e0e0', color: '#333', border: '1px solid #999', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                          >
                            ⬜ White
                          </button>
                          
                          {/* Weight */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 12, color: '#666' }}>Weight:</span>
                            <input
                              type="number"
                              step="0.1"
                              min="0"
                              placeholder={estimatedWeight > 0 ? `Est: ${estimatedWeight.toFixed(0)}` : 'lbs'}
                              value={triwall.weight || ''}
                              onChange={e => updateTriwallDetail(triwall.id, 'weight', e.target.value)}
                              style={{ width: 70, padding: 6, textAlign: 'center', borderRadius: 4, border: '1px solid #ccc' }}
                            />
                            <span style={{ color: '#666', fontSize: 12 }}>lbs</span>
                          </div>
                          
                          {/* Dimensions */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 12, color: '#666' }}>L×W×H:</span>
                            <input
                              type="number"
                              min="0"
                              placeholder="L"
                              value={triwall.length || ''}
                              onChange={e => updateTriwallDetail(triwall.id, 'length', e.target.value)}
                              style={{ width: 50, padding: 6, textAlign: 'center', borderRadius: 4, border: '1px solid #ccc' }}
                            />
                            <span style={{ color: '#666', fontWeight: 'bold' }}>×</span>
                            <input
                              type="number"
                              min="0"
                              placeholder="W"
                              value={triwall.width || ''}
                              onChange={e => updateTriwallDetail(triwall.id, 'width', e.target.value)}
                              style={{ width: 50, padding: 6, textAlign: 'center', borderRadius: 4, border: '1px solid #ccc' }}
                            />
                            <span style={{ color: '#666', fontWeight: 'bold' }}>×</span>
                            <input
                              type="number"
                              min="0"
                              placeholder="H"
                              value={triwall.height || ''}
                              onChange={e => updateTriwallDetail(triwall.id, 'height', e.target.value)}
                              style={{ width: 50, padding: 6, textAlign: 'center', borderRadius: 4, border: '1px solid #ccc' }}
                            />
                            <span style={{ color: '#666', fontSize: 12 }}>in</span>
                          </div>
                          
                          {/* Print Label */}
                          <button
                            onClick={() => printTriwallLabel(triwall.id, twIdx)}
                            style={{ padding: '4px 8px', background: '#607d8b', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}
                          >
                            🏷️ Label
                          </button>
                          
                          {/* Remove */}
                          {triwalls.length > 1 && (
                            <button
                              onClick={() => removeTriwall(triwall.id)}
                              style={{ padding: '4px 8px', background: '#f44336', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })}
                    
                    {triwalls.length === 0 && (
                      <div style={{ color: '#666', textAlign: 'center', padding: 20 }}>
                        No triwalls added yet. Click "+ Add Triwall" to get started.
                      </div>
                    )}
                  </div>
                </>
              )}
              
              {/* REGULAR BOX PACKING MODE */}
              {packingMode === 'boxes' && (packingOrder.items || []).map((item, idx) => {
                const pickedQty = getItemQty(item);
                const orderedQty = parseInt(item.qtyShipped) || parseInt(item.quantity) || 0;
                const distributedQty = getDistributionTotal(idx);
                const isValid = distributedQty === pickedQty;
                const hasShortage = pickedQty < orderedQty;
                const isChecked = packedItems[idx] || false;
                
                return (
                  <div key={idx} style={{ 
                    marginBottom: 20, padding: 15, 
                    background: isChecked ? '#e8f5e9' : (isValid ? '#f5f5f5' : '#fff3e0'), 
                    borderRadius: 8, 
                    border: isChecked ? '2px solid #4CAF50' : (isValid ? '1px solid #ddd' : '2px solid #ff9800')
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <button
                          onClick={() => setPackedItems(prev => ({ ...prev, [idx]: !prev[idx] }))}
                          style={{
                            width: 32, height: 32, borderRadius: 4, border: '2px solid #4CAF50',
                            background: isChecked ? '#4CAF50' : 'white',
                            color: isChecked ? 'white' : '#4CAF50',
                            cursor: 'pointer', fontSize: 18, fontWeight: 'bold',
                            display: 'flex', alignItems: 'center', justifyContent: 'center'
                          }}
                        >
                          {isChecked ? '✓' : ''}
                        </button>
                        <div>
                          <strong>{item.itemName}</strong>
                          {item.partNumber && <span style={{ color: '#666', marginLeft: 10, fontSize: 12 }}>{item.partNumber}</span>}
                          {hasShortage && (
                            <div style={{ fontSize: 11, color: '#f57c00', marginTop: 2 }}>
                              ⚠️ Shortage: Ordered {orderedQty}, Picked {pickedQty}
                            </div>
                          )}
                        </div>
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
                          max="99"
                          value={dist.box}
                          onChange={e => updateBoxDistribution(idx, distIdx, 'box', e.target.value)}
                          style={{ width: 60, padding: 6, textAlign: 'center', fontWeight: 'bold', border: '1px solid #ccc', borderRadius: 4 }}
                        />
                        <span style={{ width: 40 }}>Qty:</span>
                        <input
                          type="number"
                          min="0"
                          max={pickedQty}
                          value={dist.qty}
                          onChange={e => updateBoxDistribution(idx, distIdx, 'qty', e.target.value)}
                          style={{ width: 70, padding: 6, textAlign: 'center', border: '1px solid #ccc', borderRadius: 4 }}
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
              
              {/* Box Weight & Dimensions Section - only show in boxes mode */}
              {packingMode === 'boxes' && getUniqueBoxNumbers().length > 0 && (
                <div style={{ marginTop: 25, padding: 20, background: '#f9f9f9', borderRadius: 8, border: '1px solid #e0e0e0' }}>
                  <h4 style={{ margin: '0 0 15px 0', color: '#333' }}>📐 Box Weight & Dimensions</h4>
                  {getUniqueBoxNumbers().map(boxNum => (
                    <div key={boxNum} style={{ display: 'flex', alignItems: 'center', gap: 15, marginBottom: 12, flexWrap: 'wrap' }}>
                      <strong style={{ minWidth: 60 }}>Box {boxNum}:</strong>
                      
                      {/* Weight */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          placeholder="0"
                          value={boxDetails[boxNum]?.weight || ''}
                          onChange={e => updateBoxDetail(boxNum, 'weight', e.target.value)}
                          style={{ width: 70, padding: 6, textAlign: 'center', borderRadius: 4, border: '1px solid #ccc' }}
                        />
                        <span style={{ color: '#666' }}>lbs</span>
                      </div>
                      
                      {/* Dimensions */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          placeholder="L"
                          value={boxDetails[boxNum]?.length || ''}
                          onChange={e => updateBoxDetail(boxNum, 'length', e.target.value)}
                          style={{ width: 50, padding: 6, textAlign: 'center', borderRadius: 4, border: '1px solid #ccc' }}
                        />
                        <span style={{ color: '#666', fontWeight: 'bold' }}>×</span>
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          placeholder="W"
                          value={boxDetails[boxNum]?.width || ''}
                          onChange={e => updateBoxDetail(boxNum, 'width', e.target.value)}
                          style={{ width: 50, padding: 6, textAlign: 'center', borderRadius: 4, border: '1px solid #ccc' }}
                        />
                        <span style={{ color: '#666', fontWeight: 'bold' }}>×</span>
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          placeholder="H"
                          value={boxDetails[boxNum]?.height || ''}
                          onChange={e => updateBoxDetail(boxNum, 'height', e.target.value)}
                          style={{ width: 50, padding: 6, textAlign: 'center', borderRadius: 4, border: '1px solid #ccc' }}
                        />
                        <span style={{ color: '#666', fontSize: 12 }}>in</span>
                        
                        {/* Quick fill buttons */}
                        <button
                          type="button"
                          onClick={() => {
                            updateBoxDetail(boxNum, 'length', '24');
                            updateBoxDetail(boxNum, 'width', '16');
                            updateBoxDetail(boxNum, 'height', '17');
                          }}
                          style={{ marginLeft: 10, padding: '4px 8px', background: '#e3f2fd', color: '#1976d2', border: '1px solid #1976d2', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                        >
                          17"
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            updateBoxDetail(boxNum, 'length', '24');
                            updateBoxDetail(boxNum, 'width', '16');
                            updateBoxDetail(boxNum, 'height', '24');
                          }}
                          style={{ padding: '4px 8px', background: '#e8f5e9', color: '#2e7d32', border: '1px solid #2e7d32', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                        >
                          24"
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              {/* Summary - conditional based on mode */}
              {packingMode === 'triwalls' ? (
                <div style={{ marginTop: 20, padding: 15, background: validateTriwallPacking() ? '#e8f5e9' : '#ffebee', borderRadius: 8 }}>
                  <strong>Summary:</strong> {triwalls.length} triwall{triwalls.length !== 1 ? 's' : ''}
                  {triwalls.map((tw, i) => {
                    const weight = tw.weight || calculateTriwallWeight(tw.id).toFixed(1);
                    return ` | TW${i+1}: ${weight} lbs`;
                  }).join('')}
                  {!validateTriwallPacking() && <span style={{ color: '#f44336', marginLeft: 10 }}>⚠️ Fix quantity mismatches before saving</span>}
                </div>
              ) : (
                <div style={{ marginTop: 20, padding: 15, background: validatePacking() ? '#e8f5e9' : '#ffebee', borderRadius: 8 }}>
                  <strong>Summary:</strong> {new Set(Object.values(boxAssignments).flatMap(d => d.map(x => x.box))).size} boxes
                  {!validatePacking() && <span style={{ color: '#f44336', marginLeft: 10 }}>⚠️ Fix quantity mismatches before saving</span>}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: 15, borderTop: '1px solid #eee' }}>
              <button onClick={() => setShowPackOrder(false)} style={{ padding: '10px 20px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
              <button 
                onClick={savePackOrder} 
                disabled={packingMode === 'triwalls' ? !validateTriwallPacking() : !validatePacking()} 
                style={{ 
                  padding: '10px 20px', 
                  background: (packingMode === 'triwalls' ? validateTriwallPacking() : validatePacking()) ? '#4CAF50' : '#ccc', 
                  color: 'white', border: 'none', borderRadius: 6, 
                  cursor: (packingMode === 'triwalls' ? validateTriwallPacking() : validatePacking()) ? 'pointer' : 'not-allowed' 
                }}
              >
                Save Packing
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
