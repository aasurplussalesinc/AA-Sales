import { collection, addDoc, getDocs, getDoc, query, where, updateDoc, doc, writeBatch, orderBy, limit, deleteDoc, setDoc } from 'firebase/firestore';
import { db, auth } from './firebase';

// Your company's org ID - gets free access forever
export const OWNER_ORG_ID = 'aa-surplus-sales';

// Current organization context (set after login)
let currentOrgId = null;
let currentOrgData = null;
let currentUserRole = null;

export const OrgDB = {
  
  // ==================== ORGANIZATION CONTEXT ====================
  
  setCurrentOrg(orgId, orgData, userRole) {
    currentOrgId = orgId;
    currentOrgData = orgData;
    currentUserRole = userRole;
  },
  
  getCurrentOrgId() {
    return currentOrgId;
  },
  
  getCurrentOrg() {
    return currentOrgData;
  },
  
  getCurrentUserRole() {
    return currentUserRole;
  },
  
  clearCurrentOrg() {
    currentOrgId = null;
    currentOrgData = null;
    currentUserRole = null;
  },
  
  // ==================== ORGANIZATION MANAGEMENT ====================
  
  async createOrganization(orgData) {
    const user = auth.currentUser;
    if (!user) throw new Error('Must be logged in to create organization');
    
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 14); // 14 day trial
    
    const orgId = orgData.slug || this.generateSlug(orgData.name);
    
    // Check if org already exists
    const existingOrg = await this.getOrganizationById(orgId);
    if (existingOrg) {
      throw new Error('Organization with this name already exists');
    }
    
    const organization = {
      id: orgId,
      name: orgData.name,
      slug: orgId,
      email: orgData.email || user.email,
      phone: orgData.phone || '',
      address: orgData.address || '',
      logo: orgData.logo || '',
      
      // Subscription
      plan: 'trial', // trial, starter, business, pro, owner
      status: 'active', // active, past_due, canceled, suspended
      trialEndsAt: trialEndsAt.toISOString(),
      subscriptionId: null, // Stripe subscription ID
      customerId: null, // Stripe customer ID
      
      // Settings
      settings: {
        lowStockThreshold: 10,
        currency: 'USD',
        timezone: 'America/New_York'
      },
      
      // Metadata
      createdBy: user.uid,
      createdByEmail: user.email,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    
    // Special case: Owner org gets free forever
    if (orgId === OWNER_ORG_ID) {
      organization.plan = 'owner';
      organization.trialEndsAt = null;
    }
    
    await setDoc(doc(db, 'organizations', orgId), organization);
    
    // Add user as admin of this org
    await this.addUserToOrganization(user.uid, orgId, 'admin', user.email);
    
    return orgId;
  },
  
  generateSlug(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
  },
  
  async getOrganizationById(orgId) {
    try {
      const docRef = doc(db, 'organizations', orgId);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        return { id: docSnap.id, ...docSnap.data() };
      }
      return null;
    } catch (error) {
      console.error('Error getting organization:', error);
      return null;
    }
  },
  
  async updateOrganization(orgId, updates) {
    const ref = doc(db, 'organizations', orgId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
  },
  
  // ==================== USER-ORGANIZATION LINKING ====================
  
  async addUserToOrganization(userId, orgId, role = 'staff', email = '') {
    const memberDoc = {
      userId: userId,
      orgId: orgId,
      role: role, // admin, manager, staff
      email: email,
      status: 'active',
      joinedAt: Date.now(),
      updatedAt: Date.now()
    };
    
    // Use composite ID for easy lookup
    const memberId = `${orgId}_${userId}`;
    await setDoc(doc(db, 'orgMembers', memberId), memberDoc);
  },
  
  async getUserOrganizations(userId) {
    if (!userId) {
      console.error('getUserOrganizations called with no userId');
      return [];
    }
    
    try {
      // Simple query first - just by userId
      const q = query(
        collection(db, 'orgMembers'),
        where('userId', '==', userId)
      );
      const snapshot = await getDocs(q);
      
      const orgs = [];
      for (const docSnap of snapshot.docs) {
        const member = docSnap.data();
        // Filter for active status in code instead of compound query
        if (member.status !== 'active') continue;
        
        const org = await this.getOrganizationById(member.orgId);
        if (org) {
          orgs.push({ ...org, userRole: member.role });
        }
      }
      return orgs;
    } catch (error) {
      console.error('Error getting user organizations:', error);
      return [];
    }
  },
  
  async getUserOrgMembership(userId, orgId) {
    try {
      const memberId = `${orgId}_${userId}`;
      const docRef = doc(db, 'orgMembers', memberId);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        return docSnap.data();
      }
      return null;
    } catch (error) {
      console.error('Error getting membership:', error);
      return null;
    }
  },
  
  async getOrganizationMembers(orgId) {
    try {
      const q = query(
        collection(db, 'orgMembers'),
        where('orgId', '==', orgId),
        where('status', '==', 'active')
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error getting org members:', error);
      return [];
    }
  },
  
  async removeUserFromOrganization(userId, orgId) {
    const memberId = `${orgId}_${userId}`;
    const ref = doc(db, 'orgMembers', memberId);
    await updateDoc(ref, { status: 'removed', updatedAt: Date.now() });
  },
  
  async updateUserRole(userId, orgId, newRole) {
    const memberId = `${orgId}_${userId}`;
    const ref = doc(db, 'orgMembers', memberId);
    await updateDoc(ref, { role: newRole, updatedAt: Date.now() });
  },
  
  // ==================== INVITE CODES ====================
  
  generateInviteCode() {
    // Generate code like: AA-7X3K-M2PQ
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No confusing chars (0,O,1,I)
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    code += '-';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  },
  
  async createInviteCode(orgId, role = 'staff', maxUses = 1) {
    const user = auth.currentUser;
    const org = await this.getOrganizationById(orgId);
    
    const inviteCode = {
      code: this.generateInviteCode(),
      orgId: orgId,
      orgName: org?.name || 'Unknown',
      role: role,
      maxUses: maxUses, // How many times this code can be used
      uses: 0,
      status: 'active', // active, exhausted, expired, revoked
      createdBy: user?.email || 'System',
      expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000), // 7 days
      createdAt: Date.now()
    };
    
    await setDoc(doc(db, 'inviteCodes', inviteCode.code), inviteCode);
    return inviteCode;
  },
  
  async getInviteCodesByOrg(orgId) {
    try {
      const q = query(
        collection(db, 'inviteCodes'),
        where('orgId', '==', orgId)
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error getting invite codes:', error);
      return [];
    }
  },
  
  async validateInviteCode(code) {
    try {
      const upperCode = code.toUpperCase().trim();
      const docRef = doc(db, 'inviteCodes', upperCode);
      const docSnap = await getDoc(docRef);
      
      if (!docSnap.exists()) return { valid: false, error: 'Invalid invite code' };
      
      const inviteCode = docSnap.data();
      
      // Check if expired
      if (inviteCode.expiresAt < Date.now()) {
        return { valid: false, error: 'Invite code has expired' };
      }
      
      // Check if exhausted
      if (inviteCode.uses >= inviteCode.maxUses) {
        return { valid: false, error: 'Invite code has been used' };
      }
      
      // Check if revoked
      if (inviteCode.status === 'revoked') {
        return { valid: false, error: 'Invite code has been revoked' };
      }
      
      return { valid: true, inviteCode };
    } catch (error) {
      console.error('Error validating invite code:', error);
      return { valid: false, error: 'Error validating code' };
    }
  },
  
  async useInviteCode(code, userId, userEmail) {
    const upperCode = code.toUpperCase().trim();
    const validation = await this.validateInviteCode(upperCode);
    
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    
    const inviteCode = validation.inviteCode;
    
    // Add user to organization
    await this.addUserToOrganization(userId, inviteCode.orgId, inviteCode.role, userEmail);
    
    // Increment uses
    const ref = doc(db, 'inviteCodes', upperCode);
    const newUses = inviteCode.uses + 1;
    await updateDoc(ref, { 
      uses: newUses,
      status: newUses >= inviteCode.maxUses ? 'exhausted' : 'active',
      updatedAt: Date.now()
    });
    
    return inviteCode.orgId;
  },
  
  async revokeInviteCode(code) {
    const upperCode = code.toUpperCase().trim();
    const ref = doc(db, 'inviteCodes', upperCode);
    await updateDoc(ref, { status: 'revoked', updatedAt: Date.now() });
  },
  
  // ==================== LEGACY INVITATIONS (keeping for compatibility) ====================
  
  async createInvitation(orgId, email, role = 'staff') {
    const user = auth.currentUser;
    const org = await this.getOrganizationById(orgId);
    
    const invitation = {
      orgId: orgId,
      orgName: org?.name || 'Unknown',
      email: email.toLowerCase(),
      role: role,
      status: 'pending', // pending, accepted, expired
      invitedBy: user?.email || 'System',
      token: this.generateInviteCode(),
      expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000), // 7 days
      createdAt: Date.now()
    };
    
    const ref = await addDoc(collection(db, 'invitations'), invitation);
    return { id: ref.id, ...invitation };
  },
  
  async getInvitationByToken(token) {
    try {
      const q = query(
        collection(db, 'invitations'),
        where('token', '==', token),
        where('status', '==', 'pending')
      );
      const snapshot = await getDocs(q);
      if (snapshot.empty) return null;
      
      const doc = snapshot.docs[0];
      const invitation = { id: doc.id, ...doc.data() };
      
      // Check if expired
      if (invitation.expiresAt < Date.now()) {
        await updateDoc(doc.ref, { status: 'expired' });
        return null;
      }
      
      return invitation;
    } catch (error) {
      console.error('Error getting invitation:', error);
      return null;
    }
  },
  
  async getInvitationsByEmail(email) {
    try {
      const q = query(
        collection(db, 'invitations'),
        where('email', '==', email.toLowerCase()),
        where('status', '==', 'pending')
      );
      const snapshot = await getDocs(q);
      return snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(inv => inv.expiresAt > Date.now());
    } catch (error) {
      console.error('Error getting invitations:', error);
      return [];
    }
  },
  
  async acceptInvitation(invitationId, userId) {
    const ref = doc(db, 'invitations', invitationId);
    const docSnap = await getDoc(ref);
    
    if (!docSnap.exists()) throw new Error('Invitation not found');
    
    const invitation = docSnap.data();
    
    // Add user to organization
    await this.addUserToOrganization(userId, invitation.orgId, invitation.role, invitation.email);
    
    // Mark invitation as accepted
    await updateDoc(ref, { status: 'accepted', acceptedAt: Date.now() });
    
    return invitation.orgId;
  },
  
  // ==================== SUBSCRIPTION CHECKS ====================
  
  isSubscriptionActive(org) {
    if (!org) return false;
    
    // Owner always has access
    if (org.plan === 'owner' || org.id === OWNER_ORG_ID) {
      return true;
    }
    
    // Check trial
    if (org.plan === 'trial') {
      if (org.trialEndsAt && new Date(org.trialEndsAt) > new Date()) {
        return true;
      }
      return false; // Trial expired
    }
    
    // Check paid subscription status
    if (['starter', 'business', 'pro'].includes(org.plan)) {
      return org.status === 'active';
    }
    
    return false;
  },
  
  getTrialDaysRemaining(org) {
    if (!org || org.plan !== 'trial' || !org.trialEndsAt) return 0;
    
    const now = new Date();
    const trialEnd = new Date(org.trialEndsAt);
    const diff = trialEnd - now;
    
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  },
  
  // ==================== ACTIVITY LOG (ORG-SCOPED) ====================
  
  async logActivity(action, details = {}) {
    try {
      const user = auth.currentUser;
      await addDoc(collection(db, 'activityLog'), {
        orgId: currentOrgId,
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
    if (!currentOrgId) return [];
    
    try {
      const q = query(
        collection(db, 'activityLog'),
        where('orgId', '==', currentOrgId),
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
  
  async getItemHistory(itemId) {
    if (!currentOrgId) return [];
    
    try {
      // Get movements for this item
      const movementsQuery = query(
        collection(db, 'movements'),
        where('orgId', '==', currentOrgId),
        where('itemId', '==', itemId),
        orderBy('timestamp', 'desc'),
        limit(100)
      );
      const movementsSnapshot = await getDocs(movementsQuery);
      const movements = movementsSnapshot.docs.map(doc => ({ 
        id: doc.id, 
        ...doc.data(),
        historyType: 'movement'
      }));
      
      // Get activity log entries for this item
      const activityQuery = query(
        collection(db, 'activityLog'),
        where('orgId', '==', currentOrgId),
        orderBy('timestamp', 'desc'),
        limit(200)
      );
      const activitySnapshot = await getDocs(activityQuery);
      const activities = activitySnapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data(), historyType: 'activity' }))
        .filter(a => a.details?.itemId === itemId);
      
      // Combine and sort
      const combined = [...movements, ...activities]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 100);
      
      return combined;
    } catch (error) {
      console.error('Error getting item history:', error);
      return [];
    }
  },
  
  // ==================== ITEMS (ORG-SCOPED) ====================
  
  async getItems() {
    if (!currentOrgId) return [];
    
    const q = query(collection(db, 'items'), where('orgId', '==', currentOrgId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  },

  async createItem(itemData) {
    if (!currentOrgId) throw new Error('No organization selected');
    
    const user = auth.currentUser;
    const ref = await addDoc(collection(db, 'items'), {
      ...itemData,
      orgId: currentOrgId,
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

  async updateItem(itemId, updates) {
    const ref = doc(db, 'items', itemId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
    await this.logActivity('ITEM_UPDATED', { itemId, updates });
  },

  async deleteItem(itemId) {
    const ref = doc(db, 'items', itemId);
    await deleteDoc(ref);
    await this.logActivity('ITEM_DELETED', { itemId });
  },

  async updateItemStock(itemId, newStock) {
    const ref = doc(db, 'items', itemId);
    await updateDoc(ref, {
      stock: parseInt(newStock),
      updatedAt: Date.now()
    });
  },

  async getItemByPartNumber(partNumber) {
    if (!currentOrgId) return null;
    
    const q = query(
      collection(db, 'items'),
      where('orgId', '==', currentOrgId),
      where('partNumber', '==', partNumber)
    );
    const snapshot = await getDocs(q);
    if (snapshot.empty) return null;
    return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
  },

  async importItems(items) {
    if (!currentOrgId) throw new Error('No organization selected');
    
    // Get existing locations for syncing
    const locations = await this.getLocations();
    
    // Clear existing location inventories
    for (const loc of locations) {
      if (loc.inventory && Object.keys(loc.inventory).length > 0) {
        const ref = doc(db, 'locations', loc.id);
        await updateDoc(ref, {
          inventory: {},
          updatedAt: Date.now()
        });
      }
    }
    
    // Delete existing items for this org
    const existing = await this.getItems();
    for (const item of existing) {
      await deleteDoc(doc(db, 'items', item.id));
    }
    
    // Add new items with orgId and sync locations
    let added = 0;
    for (const item of items) {
      // Normalize location code
      const normalizedLocation = this.normalizeLocationCode(item.location);
      
      const ref = await addDoc(collection(db, 'items'), {
        ...item,
        location: normalizedLocation,
        orgId: currentOrgId,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      
      // Sync to location inventory if location specified
      if (normalizedLocation && item.stock > 0) {
        const targetLoc = locations.find(loc => {
          const locCode = loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}${loc.shelf}`;
          return locCode === normalizedLocation;
        });
        
        if (targetLoc) {
          const locRef = doc(db, 'locations', targetLoc.id);
          const locSnap = await getDoc(locRef);
          const locData = locSnap.data();
          const currentInventory = locData.inventory || {};
          
          await updateDoc(locRef, {
            inventory: {
              ...currentInventory,
              [ref.id]: item.stock
            },
            updatedAt: Date.now()
          });
        }
      }
      
      added++;
    }
    
    await this.logActivity('ITEMS_IMPORTED', { count: added });
    
    return { deleted: existing.length, added };
  },
  
  // ==================== LOCATIONS (ORG-SCOPED) ====================
  
  async getLocations() {
    if (!currentOrgId) return [];
    
    const q = query(collection(db, 'locations'), where('orgId', '==', currentOrgId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  },

  async createLocation(locationData) {
    if (!currentOrgId) throw new Error('No organization selected');
    
    const ref = await addDoc(collection(db, 'locations'), {
      ...locationData,
      orgId: currentOrgId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    await this.logActivity('LOCATION_CREATED', {
      locationId: ref.id,
      locationCode: locationData.locationCode
    });
    
    return ref.id;
  },

  async updateLocation(locationId, updates) {
    const ref = doc(db, 'locations', locationId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
    await this.logActivity('LOCATION_UPDATED', { locationId, updates });
  },

  async deleteLocation(locationId) {
    const ref = doc(db, 'locations', locationId);
    await deleteDoc(ref);
    await this.logActivity('LOCATION_DELETED', { locationId });
  },

  async getLocationByQR(code) {
    if (!currentOrgId) return null;
    
    console.log('getLocationByQR called with:', code);
    const locations = await this.getLocations();
    console.log('Found', locations.length, 'locations');
    
    // Normalize a location code for comparison (remove extra dashes, uppercase)
    const normalizeCode = (c) => {
      if (!c) return '';
      // Remove LOC: prefix if present, uppercase, and normalize format
      let normalized = c.replace(/^LOC:/i, '').toUpperCase().trim();
      // Handle both W1-R1-A1 and W1-R1-A-1 formats by removing dash before single digit at end
      normalized = normalized.replace(/-(\d)$/, '$1');
      return normalized;
    };
    
    // Get the code to search for
    let searchCode = code;
    if (code.startsWith('LOC:')) {
      searchCode = code.replace('LOC:', '');
    }
    const normalizedSearch = normalizeCode(searchCode);
    console.log('Looking for location code:', normalizedSearch);
    
    const found = locations.find(l => {
      // Build location code from parts if not stored
      const storedCode = l.locationCode || `${l.warehouse}-R${l.rack}-${l.letter}${l.shelf}`;
      const normalizedStored = normalizeCode(storedCode);
      console.log('Comparing with:', storedCode, '-> normalized:', normalizedStored);
      return normalizedStored === normalizedSearch;
    }) || null;
    
    console.log('Found location:', found);
    return found;
  },

  async addInventoryToLocation(locationId, itemId, quantity) {
    const ref = doc(db, 'locations', locationId);
    const snapshot = await getDoc(ref);
    
    if (!snapshot.exists()) throw new Error('Location not found');
    
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
  },

  async setInventoryAtLocation(locationId, itemId, quantity) {
    const ref = doc(db, 'locations', locationId);
    const snapshot = await getDoc(ref);
    
    if (!snapshot.exists()) throw new Error('Location not found');
    
    const locationData = snapshot.data();
    const currentInventory = locationData.inventory || {};
    
    await updateDoc(ref, {
      inventory: {
        ...currentInventory,
        [itemId]: quantity
      },
      updatedAt: Date.now()
    });
    
    await this.logActivity('INVENTORY_SET_AT_LOCATION', { locationId, itemId, quantity });
  },

  // ==================== LOCATION SYNC HELPERS ====================
  
  // Normalize location code format (handles various formats to W1-R1-A1)
  normalizeLocationCode(code) {
    if (!code) return '';
    code = code.trim();
    
    // If it matches old format W1-R1-A-1 (with dash before shelf number), convert to W1-R1-A1
    const oldFormat = code.match(/^(\w+)-R(\d+)-([A-Z])-(\d+)$/i);
    if (oldFormat) {
      return `${oldFormat[1]}-R${oldFormat[2]}-${oldFormat[3]}${oldFormat[4]}`;
    }
    
    // If already in correct format W1-R1-A1, return as-is
    const newFormat = code.match(/^(\w+)-R(\d+)-([A-Z])(\d+)$/i);
    if (newFormat) {
      return code;
    }
    
    // Try to parse any reasonable format
    const parts = code.split('-').filter(p => p);
    if (parts.length >= 3) {
      const warehouse = parts[0];
      const rack = parts[1].replace(/^R/i, '');
      const rest = parts.slice(2).join('');
      const letterShelf = rest.match(/([A-Z])(\d+)/i);
      if (letterShelf) {
        return `${warehouse}-R${rack}-${letterShelf[1]}${letterShelf[2]}`;
      }
    }
    
    return code;
  },

  // Find location by code (handles both formats)
  async findLocationByCode(locationCode) {
    if (!locationCode) return null;
    const normalizedCode = this.normalizeLocationCode(locationCode);
    const locations = await this.getLocations();
    
    return locations.find(loc => {
      const locCode = loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}${loc.shelf}`;
      return locCode === normalizedCode || this.normalizeLocationCode(locCode) === normalizedCode;
    }) || null;
  },

  // Sync item's location field to location inventory
  async syncItemToLocation(itemId, newLocationCode, quantity) {
    if (!currentOrgId) return;
    
    const normalizedCode = this.normalizeLocationCode(newLocationCode);
    const locations = await this.getLocations();
    
    // First, remove item from all other locations
    for (const loc of locations) {
      if (loc.inventory && loc.inventory[itemId] !== undefined) {
        const locCode = this.normalizeLocationCode(loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}${loc.shelf}`);
        if (locCode !== normalizedCode) {
          // Remove from this location
          const currentInventory = { ...loc.inventory };
          delete currentInventory[itemId];
          const ref = doc(db, 'locations', loc.id);
          await updateDoc(ref, {
            inventory: currentInventory,
            updatedAt: Date.now()
          });
        }
      }
    }
    
    // Then add to the new location if specified (regardless of quantity - even 0 or negative)
    if (normalizedCode) {
      const targetLoc = locations.find(loc => {
        const locCode = this.normalizeLocationCode(loc.locationCode || `${loc.warehouse}-R${loc.rack}-${loc.letter}${loc.shelf}`);
        return locCode === normalizedCode;
      });
      
      if (targetLoc) {
        const ref = doc(db, 'locations', targetLoc.id);
        const currentInventory = targetLoc.inventory || {};
        await updateDoc(ref, {
          inventory: {
            ...currentInventory,
            [itemId]: quantity
          },
          updatedAt: Date.now()
        });
        console.log('Synced item', itemId, 'to location', normalizedCode, 'qty:', quantity);
      } else {
        console.log('Target location not found:', normalizedCode);
      }
    }
  },

  // Sync location inventory to item's location field
  async syncLocationToItem(itemId, locationCode) {
    if (!currentOrgId || !itemId) return;
    
    const normalizedCode = this.normalizeLocationCode(locationCode);
    const ref = doc(db, 'items', itemId);
    await updateDoc(ref, {
      location: normalizedCode,
      updatedAt: Date.now()
    });
  },

  // Update item with location sync
  async updateItemWithSync(itemId, updates) {
    const ref = doc(db, 'items', itemId);
    
    // Get current item to know the stock
    const itemSnap = await getDoc(ref);
    const currentItem = itemSnap.exists() ? itemSnap.data() : {};
    const stock = updates.stock !== undefined ? updates.stock : (currentItem.stock || 0);
    
    // Normalize location if provided
    if (updates.location) {
      updates.location = this.normalizeLocationCode(updates.location);
    }
    
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
    
    // If location changed, sync to locations
    if (updates.location !== undefined) {
      await this.syncItemToLocation(itemId, updates.location, stock);
    }
    
    await this.logActivity('ITEM_UPDATED', { itemId, updates });
  },

  // Set inventory at location with item sync
  async setInventoryAtLocationWithSync(locationId, itemId, quantity) {
    const locRef = doc(db, 'locations', locationId);
    const snapshot = await getDoc(locRef);
    
    if (!snapshot.exists()) throw new Error('Location not found');
    
    const locationData = snapshot.data();
    const locationCode = locationData.locationCode || 
      `${locationData.warehouse}-R${locationData.rack}-${locationData.letter}${locationData.shelf}`;
    const currentInventory = locationData.inventory || {};
    
    await updateDoc(locRef, {
      inventory: {
        ...currentInventory,
        [itemId]: quantity
      },
      updatedAt: Date.now()
    });
    
    // Sync to item's location field if this is the only/primary location
    if (quantity > 0) {
      await this.syncLocationToItem(itemId, locationCode);
    }
    
    await this.logActivity('INVENTORY_SET_AT_LOCATION_SYNCED', { locationId, itemId, quantity, locationCode });
  },
  
  // ==================== CUSTOMERS (ORG-SCOPED) ====================
  
  async getCustomers() {
    if (!currentOrgId) return [];
    
    const q = query(collection(db, 'customers'), where('orgId', '==', currentOrgId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  },

  async createCustomer(customerData) {
    if (!currentOrgId) throw new Error('No organization selected');
    
    const ref = await addDoc(collection(db, 'customers'), {
      ...customerData,
      orgId: currentOrgId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    await this.logActivity('CUSTOMER_CREATED', {
      customerId: ref.id,
      customerName: customerData.name
    });
    
    return ref.id;
  },

  async updateCustomer(customerId, updates) {
    const ref = doc(db, 'customers', customerId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
    await this.logActivity('CUSTOMER_UPDATED', { customerId, updates });
  },

  async deleteCustomer(customerId) {
    const ref = doc(db, 'customers', customerId);
    await deleteDoc(ref);
    await this.logActivity('CUSTOMER_DELETED', { customerId });
  },
  
  async importCustomers(customers) {
    if (!currentOrgId) throw new Error('No organization selected');
    
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
        // Create new customer
        await this.createCustomer(customer);
        added++;
      }
    }
    
    await this.logActivity('CUSTOMERS_IMPORTED', { added, updated, skipped });
    
    return { added, updated, skipped };
  },
  
  // ==================== PURCHASE ORDERS (ORG-SCOPED) ====================
  
  async getPurchaseOrders() {
    if (!currentOrgId) return [];
    
    const q = query(collection(db, 'purchaseOrders'), where('orgId', '==', currentOrgId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  },

  async createPurchaseOrder(poData) {
    if (!currentOrgId) throw new Error('No organization selected');
    
    const user = auth.currentUser;
    
    // Generate PO number starting from AA6400
    let poNumber = poData.poNumber;
    if (!poNumber) {
      // Get existing POs to find the highest number
      const existingPOs = await this.getPurchaseOrders();
      let maxNum = 6399; // Start at 6400
      
      existingPOs.forEach(po => {
        if (po.poNumber) {
          const match = po.poNumber.match(/^AA(\d+)$/);
          if (match) {
            const num = parseInt(match[1]);
            if (num > maxNum) maxNum = num;
          }
        }
      });
      
      poNumber = `AA${maxNum + 1}`;
    }
    
    const ref = await addDoc(collection(db, 'purchaseOrders'), {
      ...poData,
      poNumber,
      status: 'draft',  // Always start as draft
      orgId: currentOrgId,
      createdBy: user?.email || 'Unknown',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    await this.logActivity('PO_CREATED', {
      poId: ref.id,
      poNumber
    });
    
    return ref.id;
  },

  async updatePurchaseOrder(poId, updates) {
    const ref = doc(db, 'purchaseOrders', poId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
    await this.logActivity('PO_UPDATED', { poId, updates });
  },

  async deletePurchaseOrder(poId) {
    const ref = doc(db, 'purchaseOrders', poId);
    await deleteDoc(ref);
    await this.logActivity('PO_DELETED', { poId });
  },
  
  async getPurchaseOrder(poId) {
    const orders = await this.getPurchaseOrders();
    return orders.find(o => o.id === poId);
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

  async markPOPaid(poId, paymentMethod = '') {
    await this.updatePurchaseOrder(poId, {
      status: 'paid',
      paidAt: Date.now(),
      paymentMethod: paymentMethod
    });
  },
  
  // ==================== PICK LISTS (ORG-SCOPED) ====================
  
  async getPickLists() {
    if (!currentOrgId) return [];
    
    const q = query(collection(db, 'pickLists'), where('orgId', '==', currentOrgId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  },

  async createPickList(pickListData) {
    if (!currentOrgId) throw new Error('No organization selected');
    
    const ref = await addDoc(collection(db, 'pickLists'), {
      ...pickListData,
      orgId: currentOrgId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    await this.logActivity('PICKLIST_CREATED', { pickListId: ref.id });
    
    return ref.id;
  },

  async updatePickList(pickListId, updates) {
    const ref = doc(db, 'pickLists', pickListId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
  },

  async deletePickList(pickListId) {
    const ref = doc(db, 'pickLists', pickListId);
    await deleteDoc(ref);
    await this.logActivity('PICKLIST_DELETED', { pickListId });
  },
  
  // ==================== RECEIVING (ORG-SCOPED) ====================
  
  async getReceivings() {
    if (!currentOrgId) return [];
    
    const q = query(collection(db, 'receivings'), where('orgId', '==', currentOrgId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  },

  async createReceiving(receivingData) {
    if (!currentOrgId) throw new Error('No organization selected');
    
    const ref = await addDoc(collection(db, 'receivings'), {
      ...receivingData,
      orgId: currentOrgId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    await this.logActivity('RECEIVING_CREATED', { receivingId: ref.id });
    
    return ref.id;
  },

  async updateReceiving(receivingId, updates) {
    const ref = doc(db, 'receivings', receivingId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
  },

  async completeReceiving(receivingId, items) {
    // Update each item's stock and location with sync
    for (const item of items) {
      if (item.receivedQty > 0) {
        // Get current item data
        const itemRef = doc(db, 'items', item.itemId);
        const itemSnap = await getDoc(itemRef);
        const currentItem = itemSnap.exists() ? itemSnap.data() : {};
        const newStock = (currentItem.stock || 0) + item.receivedQty;
        
        // Update item stock and location
        await this.updateItemWithSync(item.itemId, {
          stock: newStock,
          location: item.locationCode || currentItem.location || ''
        });
        
        // Log movement
        await this.logMovement({
          itemId: item.itemId,
          itemName: item.itemName,
          quantity: item.receivedQty,
          type: 'RECEIVE',
          toLocation: item.locationCode || 'Receiving'
        });
      }
    }
    
    await this.updateReceiving(receivingId, { status: 'completed' });
  },
  
  // ==================== MOVEMENTS (ORG-SCOPED) ====================
  
  async logMovement(movementData) {
    if (!currentOrgId) throw new Error('No organization selected');
    
    const user = auth.currentUser;
    await addDoc(collection(db, 'movements'), {
      ...movementData,
      orgId: currentOrgId,
      userId: user?.uid || null,
      userEmail: user?.email || 'Unknown',
      timestamp: Date.now()
    });
  },

  async getMovements(limitCount = 500) {
    if (!currentOrgId) return [];
    
    try {
      // Try with ordering first
      const q = query(
        collection(db, 'movements'),
        where('orgId', '==', currentOrgId),
        orderBy('timestamp', 'desc'),
        limit(limitCount)
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      // If index doesn't exist, try without ordering
      console.warn('Movements query failed, trying without order:', error.message);
      try {
        const q = query(
          collection(db, 'movements'),
          where('orgId', '==', currentOrgId),
          limit(limitCount)
        );
        const snapshot = await getDocs(q);
        const movements = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        // Sort in memory
        movements.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        return movements;
      } catch (err) {
        console.error('Error getting movements:', err);
        return [];
      }
    }
  },
  
  // ==================== COUNTS (ORG-SCOPED) ====================
  
  async getCounts() {
    if (!currentOrgId) return [];
    
    const q = query(collection(db, 'counts'), where('orgId', '==', currentOrgId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  },

  async updateCount(locationId, itemId, count) {
    if (!currentOrgId) throw new Error('No organization selected');
    
    const countId = `${currentOrgId}_${locationId}_${itemId}`;
    const ref = doc(db, 'counts', countId);
    
    await setDoc(ref, {
      orgId: currentOrgId,
      locationId,
      itemId,
      count,
      updatedAt: Date.now()
    });
  },
  
  // ==================== DASHBOARD STATS ====================
  
  async getDashboardStats() {
    try {
      const [items, locations, movements] = await Promise.all([
        this.getItems(),
        this.getLocations(),
        this.getMovements()
      ]);
      
      const now = Date.now();
      const last30Days = now - (30 * 24 * 60 * 60 * 1000);
      const last7Days = now - (7 * 24 * 60 * 60 * 1000);
      
      const recentMovements = (movements || []).filter(m => m.timestamp >= last30Days);
      const weekMovements = (movements || []).filter(m => m.timestamp >= last7Days);
      
      // Low stock items (using item's own threshold, or default 10)
      const lowStockItems = (items || []).filter(i => {
        const stock = i.stock || 0;
        const threshold = i.lowStockThreshold || 10;
        return stock <= threshold && stock > 0;
      });
      
      // Items needing reorder (above low stock but at/below reorder point)
      const reorderItems = (items || []).filter(i => {
        const stock = i.stock || 0;
        const threshold = i.lowStockThreshold || 10;
        const reorderPoint = i.reorderPoint || 0;
        return stock > threshold && stock <= reorderPoint && reorderPoint > 0;
      });
      
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
        totalItems: (items || []).length,
        totalLocations: (locations || []).length,
        totalStock: (items || []).reduce((sum, i) => sum + (i.stock || 0), 0),
        lowStockItems: lowStockItems.length,
        lowStockItemsList: lowStockItems.slice(0, 10),
        reorderItems: reorderItems.length,
        reorderItemsList: reorderItems.slice(0, 10),
        outOfStockItems: (items || []).filter(i => (i.stock || 0) === 0).length,
        movementsLast30Days: recentMovements.length,
        movementsLast7Days: weekMovements.length,
        topPickedItems: topPicked,
        dailyMovements: Object.values(dailyMovements)
      };
    } catch (error) {
      console.error('Error getting dashboard stats:', error);
      // Return default empty stats
      return {
        totalItems: 0,
        totalLocations: 0,
        totalStock: 0,
        lowStockItems: 0,
        lowStockItemsList: [],
        reorderItems: 0,
        reorderItemsList: [],
        outOfStockItems: 0,
        movementsLast30Days: 0,
        movementsLast7Days: 0,
        topPickedItems: [],
        dailyMovements: []
      };
    }
  },
  // ==================== CONTRACTS (ORG-SCOPED) ====================
  
  async createContract(contractData) {
    if (!currentOrgId) throw new Error('No organization selected');
    
    const ref = await addDoc(collection(db, 'contracts'), {
      ...contractData,
      orgId: currentOrgId,
      quickSaleCount: 0,
      totalRevenue: 0,
      totalCost: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    await this.logActivity('CONTRACT_CREATED', { 
      contractId: ref.id, 
      contractNumber: contractData.contractNumber 
    });
    
    return ref.id;
  },
  
  async getContracts() {
    if (!currentOrgId) return [];
    
    try {
      const q = query(
        collection(db, 'contracts'),
        where('orgId', '==', currentOrgId),
        orderBy('createdAt', 'desc')
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      // Fallback without orderBy if index doesn't exist
      const q = query(
        collection(db, 'contracts'),
        where('orgId', '==', currentOrgId)
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }
  },
  
  async updateContract(contractId, updates) {
    const ref = doc(db, 'contracts', contractId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
    
    await this.logActivity('CONTRACT_UPDATED', { 
      contractId, 
      contractNumber: updates.contractNumber 
    });
  },
  
  async deleteContract(contractId) {
    await deleteDoc(doc(db, 'contracts', contractId));
    await this.logActivity('CONTRACT_DELETED', { contractId });
  },
  
  async updateContractStats(contractId) {
    // Recalculate contract stats from quick sales
    const sales = await this.getQuickSales();
    const contractSales = sales.filter(s => s.contractId === contractId);
    
    const stats = {
      quickSaleCount: contractSales.length,
      totalRevenue: contractSales.reduce((sum, s) => sum + (s.totalRevenue || 0), 0),
      totalCost: contractSales.reduce((sum, s) => sum + (s.totalCost || 0), 0)
    };
    
    const ref = doc(db, 'contracts', contractId);
    await updateDoc(ref, {
      ...stats,
      updatedAt: Date.now()
    });
  },
  
  // ==================== QUICK SALES (ORG-SCOPED) ====================
  
  async createQuickSale(saleData) {
    if (!currentOrgId) throw new Error('No organization selected');
    
    const user = auth.currentUser;
    const ref = await addDoc(collection(db, 'quickSales'), {
      ...saleData,
      orgId: currentOrgId,
      createdBy: user?.email || 'Unknown',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    await this.logActivity('QUICK_SALE_CREATED', { 
      saleId: ref.id, 
      customerName: saleData.customerName,
      totalRevenue: saleData.totalRevenue,
      margin: saleData.margin
    });
    
    return ref.id;
  },
  
  async getQuickSales() {
    if (!currentOrgId) return [];
    
    try {
      const q = query(
        collection(db, 'quickSales'),
        where('orgId', '==', currentOrgId),
        orderBy('createdAt', 'desc')
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      // Fallback without orderBy if index doesn't exist
      const q = query(
        collection(db, 'quickSales'),
        where('orgId', '==', currentOrgId)
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }
  },
  
  async updateQuickSale(saleId, updates) {
    const ref = doc(db, 'quickSales', saleId);
    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
    
    await this.logActivity('QUICK_SALE_UPDATED', { 
      saleId, 
      customerName: updates.customerName 
    });
  },
  
  async deleteQuickSale(saleId) {
    await deleteDoc(doc(db, 'quickSales', saleId));
    await this.logActivity('QUICK_SALE_DELETED', { saleId });
  }
};

export default OrgDB;
