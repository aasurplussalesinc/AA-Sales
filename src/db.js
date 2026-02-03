import { collection, addDoc, getDocs, getDoc, query, where, updateDoc, doc, writeBatch, orderBy, limit, deleteDoc } from 'firebase/firestore';
import { db, auth } from './firebase';

// Offline queue for when internet is down
const QUEUE_KEY = 'warehouse_offline_queue';

const OfflineQueue = {
  add(operation) {
    const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    queue.push({ ...operation, id: Date.now(), timestamp: Date.now() });
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  },
  
  get() {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  },
  
  clear() {
    localStorage.setItem(QUEUE_KEY, '[]');
  },
  
  count() {
    return this.get().length;
  }
};

export const DB = {
  
  // ==================== ACTIVITY LOG ====================
  
  async logActivity(action, details = {}) {
    try {
      const user = auth.currentUser;
      await addDoc(collection(db, 'activityLog'), {
        action,
        details,
        userId: user?.uid || null,
        userEmail: user?.email || 'System',
        timestamp: Date.now(),
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error logging activity:', error);
    }
  },

  async getActivityLog(limitCount = 100) {
    try {
      const q = query(
        collection(db, 'activityLog'), 
        orderBy('timestamp', 'desc'),
        limit(limitCount)
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error getting activity log:', error);
      return [];
    }
  },

  async getActivityLogByDateRange(startDate, endDate) {
    try {
      const q = query(
        collection(db, 'activityLog'),
        where('timestamp', '>=', startDate),
        where('timestamp', '<=', endDate),
        orderBy('timestamp', 'desc')
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error getting activity log by date:', error);
      return [];
    }
  },

  async getActivityLogByUser(userEmail) {
    try {
      const q = query(
        collection(db, 'activityLog'),
        where('userEmail', '==', userEmail),
        orderBy('timestamp', 'desc')
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error getting activity log by user:', error);
      return [];
    }
  },

  // ==================== LOCATION HELPERS ====================
  
  // Location format helper
  formatLocation(loc) {
    if (loc.locationCode) return loc.locationCode;
    return `${loc.warehouse}-R${loc.rack}-${loc.letter}${loc.shelf}`;
  },

  // SYNC OFFLINE QUEUE
  async syncQueue() {
    const queue = OfflineQueue.get();
    let synced = 0;
    let failed = 0;
    
    for (const op of queue) {
      try {
        switch (op.type) {
          case 'UPDATE_COUNT':
            await this.updateCount(op.locationId, op.itemId, op.count);
            synced++;
            break;
          case 'CREATE_LOCATION':
            await this.createLocation(op.data);
            synced++;
            break;
        }
      } catch (error) {
        failed++;
        console.error('Sync error:', error);
      }
    }
    
    if (failed === 0) {
      OfflineQueue.clear();
    }
    
    return { synced, failed, remaining: OfflineQueue.count() };
  },
  
  getQueueCount() {
    return OfflineQueue.count();
  },
  
  // BULK IMPORT - Replaces all existing items
  async importItems(items) {
    // First, delete all existing items
    const existingItems = await this.getItems();
    let deleteCount = 0;
    
    // Delete in batches
    let deleteBatch = writeBatch(db);
    for (let i = 0; i < existingItems.length; i++) {
      deleteBatch.delete(doc(db, 'items', existingItems[i].id));
      deleteCount++;
      
      if ((i + 1) % 500 === 0) {
        await deleteBatch.commit();
        deleteBatch = writeBatch(db);
      }
    }
    if (deleteCount % 500 !== 0 && deleteCount > 0) {
      await deleteBatch.commit();
    }
    
    // Now add all new items
    let addCount = 0;
    let batch = writeBatch(db);
    const itemsRef = collection(db, 'items');
    
    for (let i = 0; i < items.length; i++) {
      const docRef = doc(itemsRef);
      batch.set(docRef, {
        ...items[i],
        createdAt: Date.now()
      });
      addCount++;
      
      // Commit every 500 items (Firestore batch limit)
      if ((i + 1) % 500 === 0) {
        await batch.commit();
        batch = writeBatch(db);
      }
    }
    
    // Commit remaining items
    if (addCount % 500 !== 0) {
      await batch.commit();
    }
    
    // Log activity
    await this.logActivity('ITEMS_IMPORTED', {
      deleted: deleteCount,
      added: addCount,
      source: 'CSV Import (Replace All)'
    });
    
    return { deleted: deleteCount, added: addCount };
  },
  
  // LOCATIONS
  async createLocation(data) {
    const ref = await addDoc(collection(db, 'locations'), {
      ...data,
      createdAt: Date.now()
    });
    
    // Log activity
    await this.logActivity('LOCATION_CREATED', {
      locationId: ref.id,
      locationCode: data.locationCode || `${data.warehouse}-R${data.rack}-${data.letter}${data.shelf}`
    });
    
    return ref.id;
  },
  
  async getLocations() {
    const snapshot = await getDocs(collection(db, 'locations'));
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  },
  
  async getLocationByQR(qrCode) {
    const q = query(collection(db, 'locations'), where('qrCode', '==', qrCode));
    const snapshot = await getDocs(q);
    if (snapshot.empty) return null;
    const d = snapshot.docs[0];
    return { id: d.id, ...d.data() };
  },

  async updateLocation(locationId, updates) {
    const ref = doc(db, 'locations', locationId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
    await this.logActivity('LOCATION_UPDATED', { 
      locationId, 
      locationCode: updates.locationCode 
    });
  },

  async deleteLocation(locationId) {
    const ref = doc(db, 'locations', locationId);
    await deleteDoc(ref);
    await this.logActivity('LOCATION_DELETED', { locationId });
  },
  
  async addInventoryToLocation(locationId, itemId, quantity) {
    try {
      const ref = doc(db, 'locations', locationId);
      const snapshot = await getDoc(ref);
      
      if (!snapshot.exists()) {
        throw new Error('Location not found');
      }
      
      const locationData = snapshot.data();
      const currentInventory = locationData.inventory || {};
      const currentQty = currentInventory[itemId] || 0;
      
      await updateDoc(ref, {
        inventory: {
          ...currentInventory,
          [itemId]: currentQty + quantity
        },
        updatedAt: Date.now()
      });
      
      await this.logActivity('INVENTORY_ADDED_TO_LOCATION', {
        locationId,
        itemId,
        quantity,
        newTotal: currentQty + quantity
      });
    } catch (error) {
      console.error('Error adding inventory to location:', error);
      throw error;
    }
  },
  
  async setInventoryAtLocation(locationId, itemId, quantity) {
    try {
      const ref = doc(db, 'locations', locationId);
      const snapshot = await getDoc(ref);
      
      if (!snapshot.exists()) {
        throw new Error('Location not found');
      }
      
      const locationData = snapshot.data();
      const currentInventory = locationData.inventory || {};
      
      await updateDoc(ref, {
        inventory: {
          ...currentInventory,
          [itemId]: quantity
        },
        updatedAt: Date.now()
      });
      
      await this.logActivity('INVENTORY_SET_AT_LOCATION', {
        locationId,
        itemId,
        quantity
      });
    } catch (error) {
      console.error('Error setting inventory at location:', error);
      throw error;
    }
  },

  // ITEMS
  async getItems() {
    const snapshot = await getDocs(collection(db, 'items'));
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  },

  async createItem(itemData) {
    const user = auth.currentUser;
    const ref = await addDoc(collection(db, 'items'), {
      ...itemData,
      createdBy: user?.email || 'Unknown',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    await this.logActivity('ITEM_CREATED', {
      itemId: ref.id,
      itemName: itemData.name,
      partNumber: itemData.partNumber
    });
    
    return ref.id;
  },
  
  async searchItems(term) {
    const items = await this.getItems();
    const search = term.toLowerCase();
    return items.filter(item => 
      item.name?.toLowerCase().includes(search) ||
      item.partNumber?.toLowerCase().includes(search)
    );
  },

  async getItemByPartNumber(partNumber) {
    const items = await this.getItems();
    return items.find(item => item.partNumber === partNumber);
  },

  async updateItem(itemId, updates) {
    try {
      const ref = doc(db, 'items', itemId);
      await updateDoc(ref, {
        ...updates,
        updatedAt: Date.now()
      });
      await this.logActivity('ITEM_UPDATED', { itemId, updates });
    } catch (error) {
      console.error('Error updating item:', error);
      throw error;
    }
  },

  async updateItemStock(itemId, newStock) {
    try {
      const ref = doc(db, 'items', itemId);
      await updateDoc(ref, {
        stock: parseInt(newStock),
        updatedAt: Date.now()
      });
    } catch (error) {
      console.error('Error updating stock:', error);
    }
  },

  async logMovement(movementData) {
    try {
      const user = auth.currentUser;
      await addDoc(collection(db, 'movements'), {
        ...movementData,
        userId: user?.uid || null,
        userEmail: user?.email || 'Unknown',
        createdAt: Date.now()
      });
      
      // Also log to activity log
      await this.logActivity(`INVENTORY_${movementData.type}`, {
        itemId: movementData.itemId,
        itemName: movementData.itemName,
        quantity: movementData.quantity,
        fromLocation: movementData.fromLocation,
        toLocation: movementData.toLocation
      });
    } catch (error) {
      console.error('Error logging movement:', error);
    }
  },

  async getMovements() {
    try {
      const snapshot = await getDocs(collection(db, 'movements'));
      const movements = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      movements.sort((a, b) => b.timestamp - a.timestamp);
      return movements;
    } catch (error) {
      console.error('Error getting movements:', error);
      return [];
    }
  },
  
  // INVENTORY
  async updateCount(locationId, itemId, count) {
    try {
      const ref = doc(db, 'locations', locationId);
      await updateDoc(ref, {
        [`inventory.${itemId}`]: parseInt(count),
        updatedAt: Date.now()
      });
    } catch (error) {
      // Queue for later if offline
      OfflineQueue.add({
        type: 'UPDATE_COUNT',
        locationId,
        itemId,
        count
      });
      throw error; // Re-throw so UI knows it's queued
    }
  },
  
  async getInventory(locationId) {
    const locations = await this.getLocations();
    const location = locations.find(loc => loc.id === locationId);
    return location?.inventory || {};
  },

  // ==================== PICK LISTS ====================
  
  async createPickList(pickListData) {
    const user = auth.currentUser;
    const ref = await addDoc(collection(db, 'pickLists'), {
      ...pickListData,
      status: 'pending',
      createdBy: user?.email || 'Unknown',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    await this.logActivity('PICKLIST_CREATED', {
      pickListId: ref.id,
      itemCount: pickListData.items?.length || 0
    });
    
    return ref.id;
  },

  async getPickLists() {
    const snapshot = await getDocs(collection(db, 'pickLists'));
    const lists = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    lists.sort((a, b) => b.createdAt - a.createdAt);
    return lists;
  },

  async updatePickList(pickListId, updates) {
    const ref = doc(db, 'pickLists', pickListId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
    
    if (updates.status) {
      await this.logActivity(`PICKLIST_${updates.status.toUpperCase()}`, {
        pickListId
      });
    }
  },

  async deletePickList(pickListId) {
    const ref = doc(db, 'pickLists', pickListId);
    await deleteDoc(ref);
    await this.logActivity('PICKLIST_DELETED', { pickListId });
  },

  // ==================== RECEIVING ====================
  
  async createReceiving(receivingData) {
    const user = auth.currentUser;
    const ref = await addDoc(collection(db, 'receiving'), {
      ...receivingData,
      status: 'pending',
      receivedBy: user?.email || 'Unknown',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    await this.logActivity('RECEIVING_CREATED', {
      receivingId: ref.id,
      poNumber: receivingData.poNumber,
      itemCount: receivingData.items?.length || 0
    });
    
    return ref.id;
  },

  async getReceivings() {
    const snapshot = await getDocs(collection(db, 'receiving'));
    const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    list.sort((a, b) => b.createdAt - a.createdAt);
    return list;
  },

  async updateReceiving(receivingId, updates) {
    const ref = doc(db, 'receiving', receivingId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
    
    if (updates.status === 'completed') {
      await this.logActivity('RECEIVING_COMPLETED', { receivingId });
    }
  },

  async completeReceiving(receivingId, items) {
    // Update each item's stock and location
    for (const item of items) {
      if (item.receivedQty > 0) {
        // Update item stock
        await this.updateItemStock(item.itemId, (item.currentStock || 0) + item.receivedQty);
        
        // Update location inventory if specified
        if (item.locationId) {
          const inventory = await this.getInventory(item.locationId);
          const currentQty = inventory[item.itemId] || 0;
          await this.updateCount(item.locationId, item.itemId, currentQty + item.receivedQty);
        }
        
        // Log movement
        await this.logMovement({
          itemId: item.itemId,
          itemName: item.itemName,
          quantity: item.receivedQty,
          type: 'RECEIVE',
          toLocation: item.locationCode || 'Receiving',
          timestamp: Date.now()
        });
      }
    }
    
    await this.updateReceiving(receivingId, { status: 'completed' });
  },

  // ==================== REPORTS ====================
  
  async getDeadStock(daysSinceLastMovement = 90) {
    const items = await this.getItems();
    const movements = await this.getMovements();
    const cutoffDate = Date.now() - (daysSinceLastMovement * 24 * 60 * 60 * 1000);
    
    // Get last movement date for each item
    const lastMovement = {};
    movements.forEach(m => {
      if (!lastMovement[m.itemId] || m.timestamp > lastMovement[m.itemId]) {
        lastMovement[m.itemId] = m.timestamp;
      }
    });
    
    // Find items with no recent movement
    return items.filter(item => {
      const lastMove = lastMovement[item.id];
      // No movement ever, or last movement before cutoff
      return !lastMove || lastMove < cutoffDate;
    }).map(item => ({
      ...item,
      lastMovement: lastMovement[item.id] || null,
      daysSinceMovement: lastMovement[item.id] 
        ? Math.floor((Date.now() - lastMovement[item.id]) / (24 * 60 * 60 * 1000))
        : 'Never'
    }));
  },

  async getInventoryTurnover(days = 30) {
    const items = await this.getItems();
    const movements = await this.getMovements();
    const cutoffDate = Date.now() - (days * 24 * 60 * 60 * 1000);
    
    // Calculate movement stats per item
    const itemStats = {};
    items.forEach(item => {
      itemStats[item.id] = {
        ...item,
        totalPicked: 0,
        totalAdded: 0,
        totalMoved: 0,
        movementCount: 0
      };
    });
    
    movements.filter(m => m.timestamp >= cutoffDate).forEach(m => {
      if (itemStats[m.itemId]) {
        itemStats[m.itemId].movementCount++;
        if (m.type === 'PICK') itemStats[m.itemId].totalPicked += m.quantity || 0;
        if (m.type === 'ADD' || m.type === 'RECEIVE') itemStats[m.itemId].totalAdded += m.quantity || 0;
        if (m.type === 'MOVE') itemStats[m.itemId].totalMoved += m.quantity || 0;
      }
    });
    
    return Object.values(itemStats).sort((a, b) => b.totalPicked - a.totalPicked);
  },

  async getDashboardStats() {
    const [items, locations, movements] = await Promise.all([
      this.getItems(),
      this.getLocations(),
      this.getMovements()
    ]);
    
    const now = Date.now();
    const last30Days = now - (30 * 24 * 60 * 60 * 1000);
    const last7Days = now - (7 * 24 * 60 * 60 * 1000);
    
    const recentMovements = movements.filter(m => m.timestamp >= last30Days);
    const weekMovements = movements.filter(m => m.timestamp >= last7Days);
    
    // Top picked items (last 30 days)
    const pickedItems = {};
    recentMovements.filter(m => m.type === 'PICK').forEach(m => {
      if (!pickedItems[m.itemId]) {
        pickedItems[m.itemId] = { 
          itemId: m.itemId, 
          itemName: m.itemName, 
          totalPicked: 0 
        };
      }
      pickedItems[m.itemId].totalPicked += m.quantity || 0;
    });
    
    const topPicked = Object.values(pickedItems)
      .sort((a, b) => b.totalPicked - a.totalPicked)
      .slice(0, 10);
    
    // Movement trends by day (last 7 days)
    const dailyMovements = {};
    for (let i = 6; i >= 0; i--) {
      const date = new Date(now - (i * 24 * 60 * 60 * 1000));
      const dateKey = date.toISOString().slice(0, 10);
      dailyMovements[dateKey] = { date: dateKey, picks: 0, adds: 0, moves: 0 };
    }
    
    weekMovements.forEach(m => {
      const dateKey = new Date(m.timestamp).toISOString().slice(0, 10);
      if (dailyMovements[dateKey]) {
        if (m.type === 'PICK') dailyMovements[dateKey].picks++;
        else if (m.type === 'ADD' || m.type === 'RECEIVE') dailyMovements[dateKey].adds++;
        else if (m.type === 'MOVE') dailyMovements[dateKey].moves++;
      }
    });
    
    return {
      totalItems: items.length,
      totalLocations: locations.length,
      totalStock: items.reduce((sum, i) => sum + (i.stock || 0), 0),
      lowStockItems: items.filter(i => (i.stock || 0) <= 10 && (i.stock || 0) > 0).length,
      outOfStockItems: items.filter(i => (i.stock || 0) === 0).length,
      movementsLast30Days: recentMovements.length,
      movementsLast7Days: weekMovements.length,
      topPickedItems: topPicked,
      dailyMovements: Object.values(dailyMovements)
    };
  },

  // ==================== PURCHASE ORDERS ====================
  
  async createPurchaseOrder(poData) {
    const user = auth.currentUser;
    
    // Generate PO number if not provided (AA prefix for AA Surplus Sales)
    const poNumber = poData.poNumber || `AA-${Date.now().toString().slice(-8)}`;
    
    const ref = await addDoc(collection(db, 'purchaseOrders'), {
      ...poData,
      poNumber,
      status: 'draft',
      pickListId: null,
      createdBy: user?.email || 'Unknown',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    await this.logActivity('PO_CREATED', {
      poId: ref.id,
      poNumber,
      customerName: poData.customerName,
      itemCount: poData.items?.length || 0,
      total: poData.total
    });
    
    return { id: ref.id, poNumber };
  },

  async getPurchaseOrders() {
    const snapshot = await getDocs(collection(db, 'purchaseOrders'));
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    orders.sort((a, b) => b.createdAt - a.createdAt);
    return orders;
  },

  async getPurchaseOrder(poId) {
    const orders = await this.getPurchaseOrders();
    return orders.find(o => o.id === poId);
  },

  async updatePurchaseOrder(poId, updates) {
    const ref = doc(db, 'purchaseOrders', poId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
    
    if (updates.status) {
      await this.logActivity(`PO_${updates.status.toUpperCase()}`, { poId });
    }
  },

  async confirmPurchaseOrder(poId) {
    const po = await this.getPurchaseOrder(poId);
    if (!po) throw new Error('PO not found');
    
    // Create pick list from PO
    const pickListData = {
      name: `PO: ${po.poNumber} - ${po.customerName}`,
      notes: `Auto-generated from Purchase Order ${po.poNumber}`,
      purchaseOrderId: poId,
      items: po.items.map(item => ({
        itemId: item.itemId,
        itemName: item.itemName,
        partNumber: item.partNumber,
        requestedQty: item.quantity,
        pickedQty: 0,
        location: item.location || ''
      }))
    };
    
    const pickListId = await this.createPickList(pickListData);
    
    // Update PO with pick list reference and status
    await this.updatePurchaseOrder(poId, {
      status: 'confirmed',
      pickListId,
      confirmedAt: Date.now()
    });
    
    await this.logActivity('PO_CONFIRMED_WITH_PICKLIST', {
      poId,
      poNumber: po.poNumber,
      pickListId
    });
    
    return pickListId;
  },

  async markPOShipped(poId) {
    await this.updatePurchaseOrder(poId, {
      status: 'shipped',
      shippedAt: Date.now()
    });
  },

  async markPOPaid(poId) {
    await this.updatePurchaseOrder(poId, {
      status: 'paid',
      paidAt: Date.now()
    });
  },

  async deletePurchaseOrder(poId) {
    const ref = doc(db, 'purchaseOrders', poId);
    await deleteDoc(ref);
    await this.logActivity('PO_DELETED', { poId });
  },

  // ==================== CUSTOMERS ====================
  
  async createCustomer(customerData) {
    const user = auth.currentUser;
    const ref = await addDoc(collection(db, 'customers'), {
      ...customerData,
      createdBy: user?.email || 'Unknown',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    await this.logActivity('CUSTOMER_CREATED', {
      customerId: ref.id,
      companyName: customerData.company
    });
    
    return ref.id;
  },

  async getCustomers() {
    const snapshot = await getDocs(collection(db, 'customers'));
    const customers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    customers.sort((a, b) => (a.company || '').localeCompare(b.company || ''));
    return customers;
  },

  async getCustomer(customerId) {
    const customers = await this.getCustomers();
    return customers.find(c => c.id === customerId);
  },

  async updateCustomer(customerId, updates) {
    const ref = doc(db, 'customers', customerId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
    
    await this.logActivity('CUSTOMER_UPDATED', { customerId });
  },

  async deleteCustomer(customerId) {
    // In production, use deleteDoc
    await this.logActivity('CUSTOMER_DELETED', { customerId });
  },

  async importCustomers(customers) {
    // Get existing customers to check for duplicates by company name
    const existingCustomers = await this.getCustomers();
    const existingByCompany = {};
    existingCustomers.forEach(c => {
      if (c.company) {
        existingByCompany[c.company.toLowerCase().trim()] = c;
      }
    });
    
    let added = 0;
    let updated = 0;
    let skipped = 0;
    
    for (const customer of customers) {
      const companyKey = (customer.company || '').toLowerCase().trim();
      
      if (!companyKey) {
        // No company name, skip this row
        skipped++;
        continue;
      }
      
      const existing = existingByCompany[companyKey];
      
      if (existing) {
        // Update existing customer
        await this.updateCustomer(existing.id, {
          ...customer,
          updatedAt: Date.now()
        });
        updated++;
      } else {
        // Add new customer
        await addDoc(collection(db, 'customers'), {
          ...customer,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
        added++;
        // Add to lookup so we don't add duplicates within same import
        existingByCompany[companyKey] = customer;
      }
    }
    
    await this.logActivity('CUSTOMERS_IMPORTED', { added, updated, skipped });
    
    return { added, updated, skipped };
  },

  async getCustomerPOs(customerId) {
    const orders = await this.getPurchaseOrders();
    return orders.filter(o => o.customerId === customerId);
  },

  async getCustomerStats(customerId) {
    const orders = await this.getCustomerPOs(customerId);
    
    const paidAmount = orders
      .filter(o => o.status === 'paid')
      .reduce((sum, o) => sum + (o.total || 0), 0);
    
    const unpaidAmount = orders
      .filter(o => o.status !== 'paid')
      .reduce((sum, o) => sum + (o.total || 0), 0);
    
    return { paidAmount, unpaidAmount, orderCount: orders.length };
  },

  // ==================== CONTRACTS ====================

  async getContracts() {
    try {
      const snapshot = await getDocs(collection(db, 'contracts'));
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error getting contracts:', error);
      return [];
    }
  },

  async getContract(id) {
    try {
      const docRef = doc(db, 'contracts', id);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        return { id: docSnap.id, ...docSnap.data() };
      }
      return null;
    } catch (error) {
      console.error('Error getting contract:', error);
      return null;
    }
  },

  async createContract(data) {
    try {
      const user = auth.currentUser;
      const docRef = await addDoc(collection(db, 'contracts'), {
        ...data,
        createdAt: Date.now(),
        createdBy: user?.email || 'unknown',
        updatedAt: Date.now()
      });
      await this.logActivity('CONTRACT_CREATED', { contractNumber: data.contractNumber, vendor: data.vendor });
      return docRef.id;
    } catch (error) {
      console.error('Error creating contract:', error);
      throw error;
    }
  },

  async updateContract(id, data) {
    try {
      const docRef = doc(db, 'contracts', id);
      await updateDoc(docRef, {
        ...data,
        updatedAt: Date.now()
      });
      await this.logActivity('CONTRACT_UPDATED', { contractId: id, contractNumber: data.contractNumber });
    } catch (error) {
      console.error('Error updating contract:', error);
      throw error;
    }
  },

  async deleteContract(id) {
    try {
      const contract = await this.getContract(id);
      await deleteDoc(doc(db, 'contracts', id));
      await this.logActivity('CONTRACT_DELETED', { contractNumber: contract?.contractNumber });
    } catch (error) {
      console.error('Error deleting contract:', error);
      throw error;
    }
  }
};
