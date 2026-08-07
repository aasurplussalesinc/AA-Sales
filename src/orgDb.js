import { collection, addDoc, getDocs, getDoc, query, where, updateDoc, doc, writeBatch, orderBy, limit, deleteDoc, setDoc } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, auth, storage } from './firebase';

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
      plan: 'trial', // trial, starter, pro, business, enterprise, owner
      status: 'active', // active, past_due, canceled, suspended
      trialEndsAt: trialEndsAt.toISOString(),
      subscriptionId: null, // Stripe subscription ID
      customerId: null, // Stripe customer ID
      
      // Settings
      skuSeriesStart: 1000,
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

  // Upload a catalog branding asset (logo or cover graphic) to Firebase Storage.
  // kind is a short label like 'logo' or 'cover'. Returns the public download URL.
  async uploadCatalogAsset(file, kind = 'asset') {
    if (!currentOrgId) throw new Error('No organization selected');
    if (!file) throw new Error('No file provided');
    const safeKind = String(kind).replace(/[^a-z0-9_-]/gi, '') || 'asset';
    const ext = (file.name && file.name.includes('.')) ? file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : 'png';
    const path = `catalog/${currentOrgId}/${safeKind}-${Date.now()}.${ext}`;
    const fileRef = storageRef(storage, path);
    await uploadBytes(fileRef, file);
    return await getDownloadURL(fileRef);
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
    if (['starter', 'pro', 'business', 'enterprise'].includes(org.plan)) {
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

  // ── One-time reconciliation for CSV-imported stock ─────────────────────
  // CSV import stores an item's location as a STRING (item.location) but never
  // writes it into any location's inventory map. That makes imported stock
  // invisible to the multi-location view once the item also gains map-based
  // stock (e.g. from a receive). This walks every item and, where its primary
  // location isn't yet represented in a map, writes the UNACCOUNTED remainder
  // (total stock minus what's already sitting in maps) into that location.
  // Idempotent: running it again does nothing once everything reconciles.
  // Canonicalize a location code to W#-R#-<BAY><SHELF>, ALWAYS — even when a
  // custom schema is set. Used by reconciliation, where the whole point is to
  // clean up messy imported strings (dashless, mixed case) so they match.
  canonicalLocationCode(code) {
    if (!code) return '';
    code = String(code).trim();
    // Warehouse token is any letters+digits (W1, W4, R1 ... "R1" is a real
    // warehouse here, not a typo), rack is R+digits, then bay letter + shelf.
    // Canonical output has NO dash before the shelf number: W1-R1-A1.
    let m = code.match(/^([A-Z]+\d+)-R(\d+)-([A-Z])-?(\d+)$/i);
    if (m) return `${m[1].toUpperCase()}-R${m[2]}-${m[3].toUpperCase()}${m[4]}`;
    // dashless run-together: W4R1M2
    m = code.match(/^([A-Z]+\d+)\s*R(\d+)\s*([A-Z])(\d+)$/i);
    if (m) return `${m[1].toUpperCase()}-R${m[2]}-${m[3].toUpperCase()}${m[4]}`;
    // loose dash-separated fallback
    const parts = code.split('-').filter(p => p);
    if (parts.length >= 3) {
      const w = parts[0].toUpperCase();
      const r = parts[1].replace(/^R/i, '');
      const ls = parts.slice(2).join('').match(/([A-Z])(\d+)/i);
      if (ls && /^[A-Z]+\d+$/i.test(w) && /^\d+$/.test(r)) {
        return `${w}-R${r}-${ls[1].toUpperCase()}${ls[2]}`;
      }
    }
    return code; // not a parseable shelf code (e.g. "W4" alone)
  },

  // ── One-time migration: canonicalise location codes + merge duplicates ────
  // Your DB grew two formats for the same shelf ("W1-R1-A-1" and "W1-R1-A1").
  // Canonical is the NO-dash form. This rewrites every location record to
  // canonical, merges any records that collapse to the same shelf (summing
  // their inventory), and repoints item.location strings to match.
  // dryRun: true reports what WOULD happen without writing anything.
  // ── Read-only diagnostic: where does each item's stock ACTUALLY sit? ──────
  // Compares item.location (the string on the item) against the location
  // inventory maps that hold it. Reports disagreements. Changes nothing.
  // Read-only health check for the ITEM-OWNED model.
  // With one source of truth there's no second list to compare against, so the
  // meaningful checks are: does stock equal the sum of its shelves, does every
  // shelf it names actually exist, and is any stock unplaced.
  async auditItemLocations() {
    if (!currentOrgId) throw new Error('No organization selected');
    const items = await this.getItems();
    const locations = await this.getLocations();

    const realCodes = new Set();
    locations.forEach(l => {
      const c = this.canonicalLocationCode(l.locationCode || `${l.warehouse}-R${l.rack}-${l.letter}${l.shelf}`);
      if (c) realCodes.add(c);
    });

    const out = { ok: 0, noStock: 0, sumMismatch: [], unknownShelf: [], unplaced: [], staged: 0, stagedUnits: 0 };

    items.forEach(it => {
      const stock = parseInt(it.stock) || 0;
      const entries = this.itemLocations(it);
      const sum = entries.reduce((s, e) => s + e.qty, 0);

      if (stock === 0 && entries.length === 0) { out.noStock++; return; }

      // stock must equal the sum of its shelves — the core invariant
      if (stock !== sum) {
        out.sumMismatch.push({ sku: it.partNumber, name: it.name, stock, sum,
                               spots: entries.map(e => `${e.code}:${e.qty}`).join(', ') });
        return;
      }
      // every named shelf should exist as a Locations record
      const bad = entries.filter(e => e.code !== this.STAGING_CODE && !realCodes.has(e.code));
      if (bad.length) {
        out.unknownShelf.push({ sku: it.partNumber, name: it.name, stock,
                                spots: bad.map(e => e.code).join(', ') });
        return;
      }
      if (stock > 0 && entries.length === 0) {
        out.unplaced.push({ sku: it.partNumber, name: it.name, stock });
        return;
      }
      const st = entries.find(e => e.code === this.STAGING_CODE);
      if (st) { out.staged++; out.stagedUnits += st.qty; }
      out.ok++;
    });

    return out;
  },

  async uploadReceipt(file) {
    if (!currentOrgId) throw new Error('No organization selected');
    if (!file) throw new Error('No file provided');
    const ext = (file.name && file.name.includes('.'))
      ? file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : 'jpg';
    const path = `receipts/${currentOrgId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const fileRef = storageRef(storage, path);
    await uploadBytes(fileRef, file);
    return await getDownloadURL(fileRef);
  },

  // Remember how a vendor was categorised before, so the next receipt from
  // them pre-selects the same category. Gets smarter as you file more.
  vendorCategory(expenses, vendor) {
    if (!vendor) return '';
    const v = String(vendor).toLowerCase().trim();
    const match = (expenses || [])
      .filter(e => e.vendor && String(e.vendor).toLowerCase().trim() === v && e.category)
      .sort((a, b) => (b.date || 0) - (a.date || 0))[0];
    return match ? match.category : '';
  },

  async createExpense(data) {
    if (!currentOrgId) throw new Error('No organization selected');
    const amount = parseFloat(data.amount) || 0;
    const ref = await addDoc(collection(db, 'expenses'), {
      orgId: currentOrgId,
      date: data.date ? new Date(data.date + 'T12:00:00').getTime() : Date.now(),
      vendor: data.vendor || '',
      category: data.category || 'Other',
      amount,
      taxAmount: parseFloat(data.taxAmount) || 0,
      paymentMethod: data.paymentMethod || '',
      reference: data.reference || '',       // invoice / bill number
      warehouse: data.warehouse || '',       // which site it belongs to
      employee: data.employee || '',         // who it relates to (pay, reimbursement)
      notes: data.notes || '',
      receiptUrl: data.receiptUrl || '',
      billable: !!data.billable,
      createdAt: Date.now(),
      createdBy: auth.currentUser?.email || '',
      updatedAt: Date.now()
    });
    await this.logActivity('EXPENSE_ADDED', { id: ref.id, vendor: data.vendor, amount });
    return ref.id;
  },

  async getExpenses() {
    if (!currentOrgId) return [];
    const q = query(collection(db, 'expenses'), where('orgId', '==', currentOrgId));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.date || 0) - (a.date || 0));
  },

  async updateExpense(id, updates) {
    if (!currentOrgId) throw new Error('No organization selected');
    const clean = { ...updates, updatedAt: Date.now() };
    if (clean.amount !== undefined) clean.amount = parseFloat(clean.amount) || 0;
    if (typeof clean.date === 'string' && clean.date) clean.date = new Date(clean.date + 'T12:00:00').getTime();
    await updateDoc(doc(db, 'expenses', id), clean);
  },

  async deleteExpense(id) {
    if (!currentOrgId) throw new Error('No organization selected');
    await deleteDoc(doc(db, 'expenses', id));
    await this.logActivity('EXPENSE_DELETED', { id });
  },

  // ══════════════════════════════════════════════════════════════════════
  // SINGLE SOURCE OF TRUTH: the ITEM owns its inventory.
  //   item.locations = [{ code, qty }]   ← the only place quantities live
  //   item.stock     = sum of that array (derived, never set by hand)
  //   item.location  = the shelf holding the most (derived)
  // Location documents are metadata only. Locations tab and the Map DERIVE
  // their quantities from items, so there is no second list to drift.
  // ══════════════════════════════════════════════════════════════════════

  // Normalise whatever an item currently has into a clean [{code, qty}] array.
  itemLocations(item) {
    if (!item) return [];
    if (Array.isArray(item.locations)) {
      return item.locations
        .map(e => ({ code: this.canonicalLocationCode(e.code || e.location || ''), qty: parseInt(e.qty ?? e.quantity) || 0 }))
        .filter(e => e.code && e.qty > 0);
    }
    // legacy shape: single location string + total stock
    const stock = parseInt(item.stock) || 0;
    const code = this.canonicalLocationCode(item.location || '');
    return (code && stock > 0) ? [{ code, qty: stock }] : [];
  },

  // Write the array back, recomputing the derived fields in one go.
  async setItemLocations(itemId, entries) {
    if (!currentOrgId) throw new Error('No organization selected');
    const clean = [];
    (entries || []).forEach(e => {
      const code = this.canonicalLocationCode(e.code || '');
      const qty = parseInt(e.qty) || 0;
      if (!code || qty <= 0) return;
      const found = clean.find(c => c.code === code);
      if (found) found.qty += qty; else clean.push({ code, qty });
    });
    const stock = clean.reduce((s, e) => s + e.qty, 0);
    const primary = clean.slice().sort((a, b) => b.qty - a.qty)[0];
    await updateDoc(doc(db, 'items', itemId), {
      locations: clean,
      stock,
      location: primary ? primary.code : '',
      updatedAt: Date.now()
    });
    return { locations: clean, stock, location: primary ? primary.code : '' };
  },

  // Add qty at a shelf (receiving). Blank code routes to staging.
  async addStockAtLocation(itemId, code, qty) {
    const amount = parseInt(qty) || 0;
    if (amount <= 0) throw new Error('Quantity must be greater than zero');
    const snap = await getDoc(doc(db, 'items', itemId));
    if (!snap.exists()) throw new Error('Item not found');
    const item = { id: itemId, ...snap.data() };
    let target = this.canonicalLocationCode(code || '');
    if (!target) { const st = await this.getOrCreateStagingLocation(); target = st.locationCode || this.STAGING_CODE; }
    const entries = this.itemLocations(item);
    const hit = entries.find(e => e.code === target);
    if (hit) hit.qty += amount; else entries.push({ code: target, qty: amount });
    const res = await this.setItemLocations(itemId, entries);
    await this.logMovement({ itemId, itemName: item.name, quantity: amount, type: 'RECEIVE', toLocation: target });
    return res;
  },

  // Remove qty from a shelf (picking / shipping). Falls back to the largest
  // holding if the named shelf doesn't have it, so stock can't go untracked.
  async removeStockAtLocation(itemId, code, qty) {
    const amount = parseInt(qty) || 0;
    if (amount <= 0) return null;
    const snap = await getDoc(doc(db, 'items', itemId));
    if (!snap.exists()) return null;
    const item = { id: itemId, ...snap.data() };
    const entries = this.itemLocations(item);
    let target = this.canonicalLocationCode(code || '');
    let hit = entries.find(e => e.code === target);
    if (!hit) hit = entries.slice().sort((a, b) => b.qty - a.qty)[0];
    if (!hit) return null;
    hit.qty -= amount;
    const res = await this.setItemLocations(itemId, entries.filter(e => e.qty > 0));
    await this.logMovement({ itemId, itemName: item.name, quantity: amount, type: 'PICK', fromLocation: hit.code });
    return res;
  },

  // Move qty between shelves — total stock unchanged.
  async moveStockBetweenLocations(itemId, fromCode, toCode, qty) {
    const amount = parseInt(qty) || 0;
    if (amount <= 0) throw new Error('Quantity must be greater than zero');
    const snap = await getDoc(doc(db, 'items', itemId));
    if (!snap.exists()) throw new Error('Item not found');
    const item = { id: itemId, ...snap.data() };
    const from = this.canonicalLocationCode(fromCode);
    const to = this.canonicalLocationCode(toCode);
    if (from === to) throw new Error('Source and destination must differ');
    const entries = this.itemLocations(item);
    const src = entries.find(e => e.code === from);
    if (!src || src.qty < amount) throw new Error(`Only ${src ? src.qty : 0} available at ${from}`);
    src.qty -= amount;
    const dst = entries.find(e => e.code === to);
    if (dst) dst.qty += amount; else entries.push({ code: to, qty: amount });
    const res = await this.setItemLocations(itemId, entries.filter(e => e.qty > 0));
    await this.logMovement({ itemId, itemName: item.name, quantity: amount, type: 'MOVE', fromLocation: from, toLocation: to });
    return res;
  },

  // DERIVED view for the Locations tab and the Map: code -> { total, items[] }
  buildLocationTotals(items) {
    const totals = {};
    (items || []).forEach(it => {
      this.itemLocations(it).forEach(e => {
        const t = totals[e.code] || (totals[e.code] = { total: 0, items: [] });
        t.total += e.qty;
        t.items.push({ id: it.id, sku: it.partNumber || '', name: it.name || '', grade: it.grade || '', qty: e.qty });
      });
    });
    Object.values(totals).forEach(t => t.items.sort((a, b) => b.qty - a.qty));
    return totals;
  },
  async getOrCreateStagingLocation() {
    if (!currentOrgId) throw new Error('No organization selected');
    const locations = await this.getLocations();
    let staging = locations.find(l => l.isStaging === true) ||
                  locations.find(l => (l.locationCode || '').toUpperCase() === this.STAGING_CODE);
    if (staging) return staging;
    const id = await this.createLocation({
      locationCode: this.STAGING_CODE,
      isStaging: true,
      warehouse: '', rack: '', letter: '', shelf: '',
      description: 'Unshelved / staging — items received without a specific location',
      inventory: {}
    });
    const snap = await getDoc(doc(db, 'locations', id));
    return { id, ...(snap.exists() ? snap.data() : {}) };
  },

  isStagingLocation(loc) {
    if (!loc) return false;
    return loc.isStaging === true || (loc.locationCode || '').toUpperCase() === this.STAGING_CODE;
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
  
  // ── Per-tenant document branding ───────────────────────────────────────
  // Returns only what THIS organization has configured. Anything missing comes
  // back empty so documents stay blank rather than borrowing another company's
  // identity. Never falls back to a built-in logo or address.
  brandingFrom(org) {
    const o = org || currentOrgData || {};
    const addressLines = [];
    if (o.address) String(o.address).split('\n').forEach(l => { if (l.trim()) addressLines.push(l.trim()); });
    const cityLine = [o.city, o.state, o.zip].filter(Boolean).join(', ');
    if (cityLine) addressLines.push(cityLine);
    return {
      name: o.name || '',
      logoUrl: o.logoUrl || '',
      phone: o.phone || '',
      email: o.email || '',
      addressLines
    };
  },

  // Small HTML block for document headers (empty string when nothing is set).
  brandingHtml(org, opts) {
    const b = this.brandingFrom(org);
    const accent = (opts && opts.accent) || '#333';
    const esc = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const logo = b.logoUrl
      ? '<img src="' + esc(b.logoUrl) + '" class="logo" alt="" />'
      : (b.name ? '<div style="font-size:18px;font-weight:bold;color:' + esc(accent) + '">' + esc(b.name) + '</div>' : '');
    const details = [];
    if (b.name) details.push('<strong>' + esc(b.name) + '</strong>');
    if (b.addressLines.length) details.push(b.addressLines.map(esc).join('<br>'));
    if (b.phone) details.push(esc(b.phone));
    return { logo, details: details.join('<br>') };
  },


  // The default schema reproduces the classic W1-R1-A1 format exactly.
  // Each level may define `prefix` (printed before the value) and `sep`
  // (separator printed before this level; ignored on the first level).
  DEFAULT_LOCATION_SCHEMA: {
    levels: [
      { name: 'Warehouse', key: 'warehouse', prefix: '',  sep: '',  options: ['W1', 'W2', 'W3', 'W4'] },
      { name: 'Rack',      key: 'rack',      prefix: 'R', sep: '-', options: ['1', '2', '3', '4', '5'] },
      { name: 'Bay',       key: 'letter',    prefix: '',  sep: '-', options: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') },
      { name: 'Shelf',     key: 'shelf',     prefix: '',  sep: '',  options: ['1', '2', '3', '4', '5'] },
    ]
  },

  getLocationSchema() {
    const s = currentOrgData && currentOrgData.locationSchema;
    if (s && Array.isArray(s.levels) && s.levels.length > 0) return s;
    return this.DEFAULT_LOCATION_SCHEMA;
  },

  // True when the org has defined its own schema (so legacy reformatting
  // must not be applied to their codes).
  hasCustomLocationSchema() {
    const s = currentOrgData && currentOrgData.locationSchema;
    return !!(s && Array.isArray(s.levels) && s.levels.length > 0);
  },

  // Build a location code from level values, e.g. { warehouse:'W1', rack:'1', ... }
  buildLocationCode(values, schema) {
    const sch = schema || this.getLocationSchema();
    return sch.levels.map((lvl, idx) => {
      const raw = values && values[lvl.key] != null ? String(values[lvl.key]) : '';
      if (!raw) return '';
      const sep = idx === 0 ? '' : (lvl.sep != null ? lvl.sep : '-');
      const prefix = lvl.prefix != null ? lvl.prefix : '';
      return sep + prefix + raw;
    }).join('');
  },

  // Resolve a stored location record to its code (uses the stored code when
  // present, so historical records keep the format they were created with).
  locationCodeOf(loc) {
    if (!loc) return '';
    if (loc.locationCode) return loc.locationCode;
    return this.buildLocationCode(loc);
  },

  // Normalize location code format (legacy formats -> W1-R1-A1).
  // When the org defines its own schema, codes are left alone apart from
  // trimming — reformatting would corrupt custom nomenclature.
  normalizeLocationCode(code) {
    if (!code) return '';
    code = code.trim();
    if (this.hasCustomLocationSchema()) return code;
    
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
        return `${warehouse}-R${rack}-${letterShelf[1].toUpperCase()}${letterShelf[2]}`;
      }
    }

    // Dashless / run-together format, e.g. W4R1M2 or W4R1B12 -> W4-R1-M2 / W4-R1-B12
    // Pattern: <warehouse W+digits> <rack R+digits> <bay letter><shelf digits>
    const dashless = code.match(/^(W\d+)\s*R(\d+)\s*([A-Z])(\d+)$/i);
    if (dashless) {
      return `${dashless[1].toUpperCase()}-R${dashless[2]}-${dashless[3].toUpperCase()}${dashless[4]}`;
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
  async syncItemToLocation(itemId, locationCode, quantity) {
    // Item-owned model: put the whole quantity at one shelf (exclusive move).
    const code = this.canonicalLocationCode(locationCode || '');
    const qty = parseInt(quantity) || 0;
    if (!code) return;
    await this.setItemLocations(itemId, qty > 0 ? [{ code, qty }] : []);
  },

  async syncLocationToItem(itemId, locationCode) {
    if (!currentOrgId || !itemId) return;
    
    const normalizedCode = this.normalizeLocationCode(locationCode);
    const ref = doc(db, 'items', itemId);
    await updateDoc(ref, {
      location: normalizedCode,
      updatedAt: Date.now()
    });
  },

  // Subtract a picked quantity from ONE specific location's inventory map, without
  // touching any other location or the item's primary location field. Used at pick
  // completion so multi-location counts stay accurate. Returns the new per-location qty.
  async decrementLocationInventory(locationCode, itemId, qty) {
    return await this.removeStockAtLocation(itemId, locationCode, qty);
  },

  async updateItemWithSync(itemId, updates) {    const ref = doc(db, 'items', itemId);
    
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
      items: po.items.filter(item => item.source !== 'manual').map(item => ({
        itemId: item.itemId || '',
        itemName: item.itemName || '',
        partNumber: item.partNumber || '',
        lineId: item.lineId || '',
        requestedQty: parseFloat(item.quantity) || 0,
        pickedQty: 0,
        location: item.location || '',
        notes: item.notes || '',
        unitPrice: parseFloat(item.unitPrice) || 0,
        source: item.source || 'inventory'
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

  async markPOUnpaid(poId) {
    // Reverse a payment: clear payment fields and revert status back to shipped
    await this.updatePurchaseOrder(poId, {
      status: 'shipped',
      paidAt: null,
      paymentMethod: ''
    });
  },

  async markPOCancelled(poId, reason = '') {
    await this.updatePurchaseOrder(poId, {
      status: 'cancelled',
      cancelledAt: Date.now(),
      cancellationReason: reason
    });
  },

  async restorePOFromCancelled(poId, restoreToStatus = 'draft') {
    await this.updatePurchaseOrder(poId, {
      status: restoreToStatus,
      cancelledAt: null,
      cancellationReason: null,
      restoredAt: Date.now()
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
    // Receiving ADDS stock to a location without disturbing an item's other
    // locations. receiveToLocation is additive + multi-location safe and routes
    // a blank location into the staging bucket, so an item stocked on several
    // shelves keeps all of them and simply gains the newly-received quantity.
    for (const item of items) {
      const qty = parseInt(item.receivedQty) || 0;
      if (qty > 0) {
        // A blank/omitted location resolves to staging inside receiveToLocation.
        // 'STAGING' is passed through and auto-creates the bucket if needed.
        const code = item.locationCode || '';
        await this.receiveToLocation(code, item.itemId, qty);
      }
    }

    await this.updateReceiving(receivingId, { status: 'completed' });
  },

  // Voice/quick receive: ADD a quantity to the item's total stock AND to one specific
  // location's inventory map, without disturbing other locations (multi-location safe).
  // Returns { newStock, newLocQty }.
  async receiveToLocation(locationCode, itemId, qty) {
    // Item-owned model: quantities live on the item, not on location docs.
    const res = await this.addStockAtLocation(itemId, locationCode, qty);
    const entry = res.locations.find(e => e.code === this.canonicalLocationCode(locationCode || '')) || null;
    return { newStock: res.stock, newLocQty: entry ? entry.qty : null };
  },

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

    // SINGLE SOURCE OF TRUTH: write to the location document's inventory map,
    // which is what the Items tab, voice, pick lists and catalog all read.
    const locRef = doc(db, 'locations', locationId);
    const snap = await getDoc(locRef);
    if (!snap.exists()) throw new Error('Location not found');
    const inv = { ...(snap.data().inventory || {}) };
    const qty = Math.max(0, parseInt(count) || 0);
    if (qty === 0) delete inv[itemId]; else inv[itemId] = qty;
    await updateDoc(locRef, { inventory: inv, updatedAt: Date.now() });

    // Keep the item's own primary-location field sensible for the Items tab.
    const code = this.locationCodeOf(snap.data());
    const itemRef = doc(db, 'items', itemId);
    const itemSnap = await getDoc(itemRef);
    if (itemSnap.exists()) {
      const cur = itemSnap.data();
      if (qty > 0) {
        if (!cur.location) await updateDoc(itemRef, { location: code, updatedAt: Date.now() });
      } else if (this.canonicalLocationCode(cur.location) === this.canonicalLocationCode(code)) {
        // Cleared this location and it was the item's primary — repoint to another
        // location that still holds it, if any.
        const locs = await this.getLocations();
        const other = locs.find(l => l.id !== locationId && l.inventory && (parseInt(l.inventory[itemId]) || 0) > 0);
        await updateDoc(itemRef, { location: other ? this.locationCodeOf(other) : '', updatedAt: Date.now() });
      }
    }
  },

  // Read one location's inventory map: { itemId: qty }
  async getInventory(locationId) {
    if (!currentOrgId || !locationId) return {};
    const snap = await getDoc(doc(db, 'locations', locationId));
    return snap.exists() ? (snap.data().inventory || {}) : {};
  },

  // Move quantity of an item from one location to another. Total item stock is
  // unchanged (it's a relocation, not a receive/pick). Logs a MOVE movement.
  async moveItemBetweenLocations(itemId, fromLocationId, toLocationId, qty) {
    // Accepts location ids or codes; resolves both to codes.
    const locs = await this.getLocations();
    const toCode = (v) => {
      const byId = locs.find(l => l.id === v);
      const raw = byId ? (byId.locationCode || `${byId.warehouse}-R${byId.rack}-${byId.letter}${byId.shelf}`) : v;
      return this.canonicalLocationCode(raw);
    };
    return await this.moveStockBetweenLocations(itemId, toCode(fromLocationId), toCode(toLocationId), qty);
  },

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
