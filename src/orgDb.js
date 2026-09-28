import { brandingFrom as sharedBrandingFrom, brandingHtml as sharedBrandingHtml } from '../functions/orderDocument.mjs';
import { shouldClearShippingRates } from './parcelRates';
import { stockChangeMovement } from './movementHistory';
import {
  toQty, cleanEntries, sumEntries, seedUnshelved, addAtShelf, removeFromShelf,
  applyCount, planQuickAdjust, planOrderRestore as planOrderRestoreFromLedger, restoreShelf
} from './stockLedger';
import { collection, addDoc, getDocs, getDoc, query, where, updateDoc, doc, writeBatch, orderBy, limit, deleteDoc, setDoc, runTransaction } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, auth, storage } from './firebase';

// Your company's org ID - gets free access forever
export const OWNER_ORG_ID = 'aa-surplus-sales';

// Fields the payments ledger owns on an order (functions/invoicing.js writes
// them from the `payments` collection; firestore.rules refuses them from the
// client). Stripped from every order write here so that saving a whole order
// object - the packing screen does - can never roll back a payment that
// arrived while the screen was open.
const LEDGER_ORDER_FIELDS = ['invoice', 'amountPaid', 'balanceDue', 'amountPaidCents', 'balanceDueCents',
  'creditCents', 'pendingCents', 'payStatusUpdatedAt', 'paidVia'];
export function withoutLedgerFields(obj) {
  const out = { ...(obj || {}) };
  LEDGER_ORDER_FIELDS.forEach(k => { delete out[k]; });
  return out;
}

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
  
  // `provenance` is how the security rules verify a self-join. A user creating
  // their own membership row has to show why they are entitled to it: either an
  // invite code ({ inviteCode }) or a pending invitation ({ invitationId }).
  // Rows written by an existing admin, or by the person who just created the
  // org, need nothing extra - the rules can already verify both from the
  // document id and the organization record.
  async addUserToOrganization(userId, orgId, role = 'staff', email = '', provenance = {}) {
    const memberDoc = {
      userId: userId,
      orgId: orgId,
      role: role, // admin, manager, staff
      email: email,
      status: 'active',
      joinedAt: Date.now(),
      updatedAt: Date.now()
    };
    if (provenance && provenance.inviteCode) memberDoc.inviteCode = provenance.inviteCode;
    if (provenance && provenance.invitationId) memberDoc.invitationId = provenance.invitationId;
    
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
    await this.addUserToOrganization(userId, inviteCode.orgId, inviteCode.role, userEmail, { inviteCode: upperCode });
    
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
    await this.addUserToOrganization(userId, invitation.orgId, invitation.role, invitation.email, { invitationId: invitationId });
    
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
  
  // ── Price history for one item ───────────────────────────────────────────
  // Reads the activity log, which has recorded every ITEM_UPDATED since day
  // one with the new value, who made it and when. Older entries didn't store
  // the OLD value, so it's inferred from the previous logged price for that
  // item. Newer entries carry `before` and are exact.
  async getItemPriceHistory(itemId) {
    if (!currentOrgId || !itemId) return [];
    const q = query(
      collection(db, 'activityLog'),
      where('orgId', '==', currentOrgId),
      where('action', '==', 'ITEM_UPDATED'),
      limit(2000)
    );
    const snap = await getDocs(q);

    // Sorted here rather than with orderBy: combining two equality filters
    // with an orderBy forces a composite index, and equality-only queries
    // don't need one. Same result, no index to create.
    const docsAsc = snap.docs.slice()
      .sort((x, y) => (x.data().timestamp || 0) - (y.data().timestamp || 0));

    const rows = [];
    let previous = null;
    docsAsc.forEach(d => {
      const e = d.data();
      const det = e.details || {};
      if (det.itemId !== itemId) return;
      const u = det.updates || {};
      if (!Object.prototype.hasOwnProperty.call(u, 'price')) return;

      const to = parseFloat(u.price);
      if (!isFinite(to)) return;
      if (previous !== null && to === previous) return;

      const recorded = det.before && det.before.price != null
        ? parseFloat(det.before.price) : null;

      rows.push({
        at: e.timestamp,
        by: e.userEmail || 'Unknown',
        from: recorded != null ? recorded : previous,
        to,
        inferred: recorded == null && previous !== null
      });
      previous = to;
    });

    return rows.reverse();
  },

  // Every price change across the org, newest first.
  async getPriceChangeLog(sinceTs) {
    if (!currentOrgId) return [];
    const q = query(
      collection(db, 'activityLog'),
      where('orgId', '==', currentOrgId),
      where('action', '==', 'ITEM_UPDATED'),
      limit(5000)
    );
    const snap = await getDocs(q);
    const items = await this.getItems();
    const byId = {};
    items.forEach(i => { byId[i.id] = i; });

    const lastSeen = {};
    const out = [];
    // Chronological order matters — each change is chained to the previous
    // price for that item. Sorted in memory to avoid a composite index.
    const ordered = snap.docs.slice()
      .sort((x, y) => (x.data().timestamp || 0) - (y.data().timestamp || 0));
    ordered.forEach(d => {
      const e = d.data();
      const det = e.details || {};
      const u = det.updates || {};
      const id = det.itemId;
      if (!id || !Object.prototype.hasOwnProperty.call(u, 'price')) return;
      const to = parseFloat(u.price);
      if (!isFinite(to)) return;
      const recorded = det.before && det.before.price != null
        ? parseFloat(det.before.price) : null;
      const from = recorded != null ? recorded
        : (lastSeen[id] !== undefined ? lastSeen[id] : null);
      lastSeen[id] = to;
      if (from !== null && from === to) return;
      if (sinceTs && e.timestamp < sinceTs) return;
      const it = byId[id] || {};
      out.push({
        at: e.timestamp, by: e.userEmail || 'Unknown',
        itemId: id, sku: it.partNumber || '', name: it.name || '(deleted item)',
        from, to
      });
    });
    return out.reverse();
  },

  // ── Reports helpers that were being called but never existed ────────────
  // Dead Stock and Turnover both threw "not a function" when opened.

  formatLocation(loc) {
    if (!loc) return '';
    if (loc.locationCode) return loc.locationCode;
    const w = loc.warehouse || '', r = loc.rack || '', l = loc.letter || '', sh = loc.shelf || '';
    if (!w) return '';
    return `${w}-R${r}-${l}${sh}`;
  },

  async getDeadStock(days = 90) {
    if (!currentOrgId) return [];
    const cutoff = Date.now() - (parseInt(days) || 90) * 864e5;
    const items = await this.getItems();
    const movements = await this.getMovements(20000);

    const lastByItem = {};
    (movements || []).forEach(m => {
      if (!m.itemId || m.type === 'IMPORT') return; // an import rewriting counts isn't activity
      const t = m.timestamp || 0;
      if (!lastByItem[m.itemId] || t > lastByItem[m.itemId]) lastByItem[m.itemId] = t;
    });

    return items
      .filter(i => (parseInt(i.stock) || 0) > 0)
      .map(i => {
        const last = lastByItem[i.id] || null;
        return {
          id: i.id, partNumber: i.partNumber || '', name: i.name || '',
          category: i.category || '', stock: parseInt(i.stock) || 0,
          price: parseFloat(i.price) || 0,
          lastMovement: last,
          daysSinceMovement: last ? Math.floor((Date.now() - last) / 864e5) : null
        };
      })
      .filter(i => i.lastMovement === null || i.lastMovement < cutoff)
      .sort((a, b) => {
        // never-moved first, then oldest
        if (a.lastMovement === null && b.lastMovement !== null) return -1;
        if (b.lastMovement === null && a.lastMovement !== null) return 1;
        return (a.lastMovement || 0) - (b.lastMovement || 0);
      });
  },

  async getInventoryTurnover(days = 90) {
    if (!currentOrgId) return [];
    const cutoff = Date.now() - (parseInt(days) || 90) * 864e5;
    const items = await this.getItems();
    const movements = await this.getMovements(20000);

    const agg = {};
    (movements || []).forEach(m => {
      if (!m.itemId || (m.timestamp || 0) < cutoff) return;
      const a = agg[m.itemId] || (agg[m.itemId] = { count: 0, added: 0, picked: 0, moved: 0 });
      const q = parseInt(m.quantity) || 0;
      a.count++;
      const t = String(m.type || '').toUpperCase();
      if (t === 'RECEIVE') a.added += q;
      else if (t === 'PICK') a.picked += q;
      else if (t === 'MOVE') a.moved += q;
    });

    return items
      .map(i => {
        const a = agg[i.id] || { count: 0, added: 0, picked: 0, moved: 0 };
        return {
          id: i.id, partNumber: i.partNumber || '', name: i.name || '',
          stock: parseInt(i.stock) || 0,
          movementCount: a.count, totalAdded: a.added,
          totalPicked: a.picked, totalMoved: a.moved
        };
      })
      .sort((a, b) => b.movementCount - a.movementCount || b.totalPicked - a.totalPicked);
  },

  // Signed stock change for one item. Shelf-aware: a positive delta goes onto
  // `opts.location` (else STAGING), a negative one comes off `opts.location`
  // (else the primary shelf, spilling onto the others), and the total is
  // re-derived from the shelves. Logs one movement with before/after.
  // (Cancelled orders no longer come through here - see restoreOrderStock.)
  async adjustItemStock(itemId, delta, opts = {}) {
    if (!currentOrgId || !itemId) return null;
    const amount = toQty(delta);
    if (amount === 0) return null;
    const res = await this.quickAdjustStock(itemId, amount > 0 ? 'add' : 'remove', Math.abs(amount), {
      shelf: opts.location || '',
      note: opts.reason || opts.note || 'Stock adjustment',
      type: amount > 0 ? 'RECEIVE' : 'PICK'
    });
    return res ? { previous: res.before, stock: res.after } : null;
  },

  // Items tab quick +/- (and adjustItemStock). `type` is 'add' or 'remove'.
  // With no shelf chosen, additions go to STAGING and removals come off the
  // primary shelf first. Stock always equals the sum of the shelves afterwards.
  async quickAdjustStock(itemId, type, qty, opts = {}) {
    if (!currentOrgId) throw new Error('No organization selected');
    const amount = toQty(qty);
    if (amount <= 0) throw new Error('Quantity must be greater than zero');
    const snap = await getDoc(doc(db, 'items', itemId));
    if (!snap.exists()) throw new Error('Item not found');
    const item = snap.data();
    if (item.orgId && item.orgId !== currentOrgId) throw new Error('Item not found');
    const shelf = this.canonicalLocationCode(opts.shelf || '');
    const plan = planQuickAdjust(this.itemLocations(item), {
      type: type === 'add' ? 'add' : 'remove', qty: amount, shelf,
      stock: item.stock, stagingCode: this.STAGING_CODE, seedCode: this.unshelvedSeedCode(item)
    });
    if (plan.after === plan.before && !plan.seeded) return { before: plan.before, after: plan.after, changed: false };
    if (plan.toLocation === this.STAGING_CODE || (plan.seeded && this.unshelvedSeedCode(item) === this.STAGING_CODE)) {
      try { await this.getOrCreateStagingLocation(); } catch (e) { /* the shelf code is enough */ }
    }
    const res = await this.setItemLocations(itemId, plan.entries);
    const units = Math.abs(plan.after - plan.before);
    await this.logMovement({
      itemId, itemName: item.name || '', sku: item.partNumber || '', grade: item.grade || '',
      type: opts.type || (type === 'add' ? 'ADD' : 'ADJUST'),
      quantity: units,
      ...(units !== amount ? { requestedQty: amount } : {}),
      beforeQty: plan.before, afterQty: res.stock,
      fromLocation: plan.fromLocation, toLocation: plan.toLocation,
      ...(plan.seeded ? { seededToStaging: plan.seeded } : {}),
      note: (opts.note || `Quick ${type === 'add' ? 'add' : 'remove'}: ${amount}`) +
        (plan.seeded ? ` (${plan.seeded} unshelved units first placed in ${this.unshelvedSeedCode(item)})` : '')
    });
    return { before: plan.before, after: res.stock, removed: plan.removed, added: plan.added, changed: true, locations: res.locations };
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

  // opts.logCreate === false: the caller logs the opening stock itself (the CSV
  // import logs one CREATE per new item with its final quantity and shelves).
  async createItem(itemData, opts = {}) {
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

    // Opening stock is a quantity change like any other; without it an
    // item's history can never add up to its quantity.
    const opening = toQty(itemData.stock);
    if (opening > 0 && opts.logCreate !== false) {
      try {
        await this.logMovement({
          itemId: ref.id, itemName: itemData.name || '',
          sku: itemData.partNumber || '', grade: itemData.grade || '',
          type: 'CREATE', quantity: opening, beforeQty: 0, afterQty: opening,
          toLocation: this.canonicalLocationCode(itemData.location || ''),
          note: 'Item created'
        });
      } catch (e) { console.warn('CREATE movement not logged:', e.message); }
    }

    return ref.id;
  },

  async updateItem(itemId, updates) {
    const ref = doc(db, 'items', itemId);

    // Capture the fields we're about to overwrite so the activity log holds a
    // real before/after rather than only the new value.
    let before = null;
    if (updates && (updates.price !== undefined || updates.cost !== undefined ||
                    updates.grade !== undefined || updates.name !== undefined ||
                    updates.category !== undefined || updates.stock !== undefined)) {
      try {
        const snapBefore = await getDoc(ref);
        if (snapBefore.exists()) {
          const d = snapBefore.data();
          before = {};
          ['price', 'cost', 'grade', 'name', 'category', 'stock'].forEach(k => {
            if (updates[k] !== undefined) before[k] = d[k] ?? null;
          });
        }
      } catch (e) { /* logging must never block the write */ }
    }

    await updateDoc(ref, {
      ...updates,
      updatedAt: Date.now()
    });
    await this.logActivity('ITEM_UPDATED', before ? { itemId, updates, before } : { itemId, updates });
  },

  async deleteItem(itemId) {
    const ref = doc(db, 'items', itemId);
    await deleteDoc(ref);
    await this.logActivity('ITEM_DELETED', { itemId });
  },

  // Writes the total only, without shelves or a movement. Nothing in the app
  // calls this any more (scanner pick and order delete-restore used to); use
  // quickAdjustStock / removeStockAtLocation / restoreOrderStock instead.
  async updateItemStock(itemId, newStock) {
    const ref = doc(db, 'items', itemId);
    await updateDoc(ref, {
      stock: Math.max(0, toQty(newStock)),
      updatedAt: Date.now()
    });
  },

  // One item, fresh, only if it belongs to the current org.
  async getItem(itemId) {
    if (!currentOrgId || !itemId) return null;
    const snap = await getDoc(doc(db, 'items', itemId));
    if (!snap.exists() || snap.data().orgId !== currentOrgId) return null;
    return { id: snap.id, ...snap.data() };
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
  // The shelf code used for stock that has been received but not put away.
  // Referenced by getOrCreateStagingLocation, addStockAtLocation and the
  // reconciliation helpers; it was previously read but never defined, so a
  // receive with no shelf resolved to `undefined` and the entry was dropped.
  STAGING_CODE: 'STAGING',

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
    // Not a parseable shelf code (e.g. "W4" or "STAGING") — still upper-case
    // it so the same shelf typed two ways can never become two entries. The
    // backend (functions/inventory.js) does exactly this; keep them identical.
    return code.toUpperCase();
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

  // ══════════════════════════════════════════════════════════════════════
  // API KEYS — let a subscriber's own agent read/write their data.
  // The key is shown ONCE at creation and only its SHA-256 hash is stored,
  // so a database leak can't be replayed against the API. Every key is bound
  // to exactly one org; the API layer scopes every query by that org id and
  // never accepts an org id from the caller.
  // ══════════════════════════════════════════════════════════════════════

  async _sha256(text) {
    const buf = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  },

  async createApiKey({ label, scope = 'read' }) {
    if (!currentOrgId) throw new Error('No organization selected');
    if (!['read', 'write'].includes(scope)) throw new Error('Scope must be read or write');

    // 32 random bytes -> 64 hex chars, prefixed so it's recognisable in logs.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const secret = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const key = `sk_${scope === 'write' ? 'rw' : 'ro'}_${secret}`;
    const hash = await this._sha256(key);

    const ref = await addDoc(collection(db, 'apiKeys'), {
      orgId: currentOrgId,
      label: label || 'Untitled key',
      scope,
      keyHash: hash,
      preview: key.slice(0, 12) + '…' + key.slice(-4),
      createdAt: Date.now(),
      createdBy: auth.currentUser?.email || '',
      lastUsedAt: null,
      callCount: 0,
      revoked: false
    });
    await this.logActivity('API_KEY_CREATED', { id: ref.id, label, scope });

    // The only time the full key is ever available.
    return { id: ref.id, key, scope, label };
  },

  async getApiKeys() {
    if (!currentOrgId) return [];
    const q = query(collection(db, 'apiKeys'), where('orgId', '==', currentOrgId));
    const snap = await getDocs(q);
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(k => !k.revoked)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  },

  async revokeApiKey(id) {
    if (!currentOrgId) throw new Error('No organization selected');
    await updateDoc(doc(db, 'apiKeys', id), { revoked: true, revokedAt: Date.now() });
    await this.logActivity('API_KEY_REVOKED', { id });
  },

  // ══════════════════════════════════════════════════════════════════════
  // EXPENSES — money going out. Receipts/invoices/bills with photo capture.
  // Tracks spend only; it never pays anyone.
  // ══════════════════════════════════════════════════════════════════════
  EXPENSE_CATEGORIES: [
    'Employee Pay', 'Contractor', 'Inventory Purchase', 'Freight & Shipping',
    'Warehouse Rent', 'Utilities', 'Equipment', 'Supplies', 'Vehicle & Fuel',
    'Insurance', 'Software & Subscriptions', 'Professional Fees', 'Taxes & Licenses',
    'Marketing', 'Repairs & Maintenance', 'Other'
  ],

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
        .map(e => ({ code: this.canonicalLocationCode(e.code || e.location || ''), qty: toQty(e.qty ?? e.quantity) }))
        .filter(e => e.code && e.qty > 0);
    }
    // legacy shape: single location string + total stock
    const stock = toQty(item.stock);
    const code = this.canonicalLocationCode(item.location || '');
    return (code && stock > 0) ? [{ code, qty: stock }] : [];
  },

  // Where stock that sits on no shelf is put before a shelf write (see
  // seedUnshelved): the item's own location field if it has one, else STAGING.
  unshelvedSeedCode(item) {
    return this.canonicalLocationCode((item && item.location) || '') || this.STAGING_CODE;
  },

  // Write the array back, recomputing the derived fields in one go.
  async setItemLocations(itemId, entries) {
    if (!currentOrgId) throw new Error('No organization selected');
    const clean = [];
    (entries || []).forEach(e => {
      const code = this.canonicalLocationCode(e.code || '');
      const qty = toQty(e.qty);
      if (!code || qty <= 0) return;
      const found = clean.find(c => c.code === code);
      if (found) found.qty += qty; else clean.push({ code, qty });
    });
    const stock = clean.reduce((s, e) => s + e.qty, 0);
    const primary = clean.slice().sort((a, b) => b.qty - a.qty)[0];
    // Flat list of shelf codes, kept in step with `locations` on every write.
    // Firestore can't index inside an array of objects, so without this a
    // "what's on shelf X" query has to read the whole collection and filter
    // in memory. With it, that's one indexed array-contains query — and it
    // finds split holdings, which a query on the primary `location` misses.
    const locationCodes = clean.map(e => e.code);
    await updateDoc(doc(db, 'items', itemId), {
      locations: clean,
      locationCodes,
      stock,
      location: primary ? primary.code : '',
      updatedAt: Date.now()
    });
    return { locations: clean, locationCodes, stock, location: primary ? primary.code : '' };
  },

  // Add qty at a shelf (receiving). Blank code routes to staging.
  // meta: { note, type (default RECEIVE), orderId, orderNumber, pickShelf }.
  // An item holding stock with no shelf at all gets that stock placed in
  // STAGING first, so rewriting the shelves can't silently drop it.
  async addStockAtLocation(itemId, code, qty, meta = {}) {
    const amount = toQty(qty);
    if (amount <= 0) throw new Error('Quantity must be greater than zero');
    const snap = await getDoc(doc(db, 'items', itemId));
    if (!snap.exists()) throw new Error('Item not found');
    const item = { id: itemId, ...snap.data() };
    let target = this.canonicalLocationCode(code || '');
    if (!target) { const st = await this.getOrCreateStagingLocation(); target = st.locationCode || this.STAGING_CODE; }
    const seed = seedUnshelved(this.itemLocations(item), item.stock, this.unshelvedSeedCode(item));
    // Shelf total, not item.stock: the write below re-derives stock from the
    // shelves, so this is the before that matches the after.
    const plan = addAtShelf(seed.entries, target, amount);
    const res = await this.setItemLocations(itemId, plan.entries);
    await this.logMovement({
      itemId, itemName: item.name, sku: item.partNumber || '', grade: item.grade || '',
      quantity: amount, type: meta.type || 'RECEIVE', toLocation: target,
      beforeQty: plan.before, afterQty: res.stock,
      shelfBefore: plan.shelfBefore, shelfAfter: plan.shelfAfter,
      ...(seed.seeded ? { seededToStaging: seed.seeded } : {}),
      ...(meta.orderId ? { orderId: meta.orderId } : {}),
      ...(meta.orderNumber ? { orderNumber: meta.orderNumber } : {}),
      ...(meta.pickShelf !== undefined ? { pickShelf: meta.pickShelf } : {}),
      ...(meta.note ? { note: meta.note } : {})
    });
    return res;
  },

  // Remove qty from a shelf (picking / shipping). Falls back to the largest
  // holding if the named shelf doesn't have it, so stock can't go untracked.
  // `meta` is stamped onto the movement this writes. Pass { orderId, orderNumber }
  // from a pick so the ledger says WHICH order took the units. Without it, an
  // audit has to guess by matching item, quantity and time, and two orders
  // shipping the same SKU in the same week are indistinguishable.
  async removeStockAtLocation(itemId, code, qty, meta = {}) {
    const amount = toQty(qty);
    if (amount <= 0) return null;
    const snap = await getDoc(doc(db, 'items', itemId));
    if (!snap.exists()) return null;
    const item = { id: itemId, ...snap.data() };
    const entries = this.itemLocations(item);
    if (!entries.length) return null;
    const target = this.canonicalLocationCode(code || '');
    const plan = removeFromShelf(entries, target, amount, { spill: !!meta.spill });
    const res = await this.setItemLocations(itemId, plan.entries);
    // quantity is what actually came off. A shelf holding less than was asked
    // for used to log the full request, overstating the pick in the ledger.
    await this.logMovement({
      itemId, itemName: item.name, sku: item.partNumber || '', grade: item.grade || '',
      quantity: plan.removed, type: meta.type || 'PICK',
      fromLocation: plan.taken.map(t => t.code).join(', ') || plan.shelf,
      beforeQty: plan.before, afterQty: res.stock,
      ...(plan.removed !== amount ? { requestedQty: amount } : {}),
      ...(meta.orderId ? { orderId: meta.orderId } : {}),
      ...(meta.orderNumber ? { orderNumber: meta.orderNumber } : {}),
      ...(meta.note ? { note: meta.note } : {})
    });
    return { ...res, removed: plan.removed };
  },

  // Move qty between shelves — total stock unchanged.
  // Move a whole shelf's contents (or a chosen subset) to another shelf.
  // Item-owned model: each item's entry for `fromCode` is retargeted to
  // `toCode`, merging if the item already holds stock there. Totals never
  // change — this is a relocation, not a receive.
  async moveLocationContents(fromCode, toCode, itemIds) {
    if (!currentOrgId) throw new Error('No organization selected');
    const from = this.canonicalLocationCode(fromCode);
    const to = this.canonicalLocationCode(toCode);
    if (!from || !to) throw new Error('Both a source and destination are required');
    if (from === to) throw new Error('Source and destination must be different');

    const only = Array.isArray(itemIds) && itemIds.length ? new Set(itemIds) : null;
    const items = await this.getItems();
    let movedItems = 0, movedUnits = 0, mergedInto = 0;
    const report = [];

    for (const it of items) {
      if (only && !only.has(it.id)) continue;
      const entries = this.itemLocations(it);
      const src = entries.find(e => e.code === from);
      if (!src || src.qty <= 0) continue;

      const qty = src.qty;
      const dst = entries.find(e => e.code === to);
      if (dst) { dst.qty += qty; mergedInto++; } else { entries.push({ code: to, qty }); }

      const remaining = entries.filter(e => e.code !== from && e.qty > 0);
      await this.setItemLocations(it.id, remaining);
      await this.logMovement({
        itemId: it.id, itemName: it.name, sku: it.partNumber || '', grade: it.grade || '',
        quantity: qty, type: 'MOVE', fromLocation: from, toLocation: to
      });

      movedItems++; movedUnits += qty;
      report.push(`${it.partNumber || ''} ${it.name}: ${qty}`);
    }

    return { movedItems, movedUnits, mergedInto, from, to, report };
  },

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
    await this.logMovement({
      itemId, itemName: item.name, sku: item.partNumber || '', grade: item.grade || '',
      quantity: amount, type: 'MOVE', fromLocation: from, toLocation: to
    });
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
  // Canonical copy lives in functions/orderDocument.mjs (shared with the backend).
  brandingFrom(org) { return sharedBrandingFrom(org || currentOrgData || {}); },

  // Small HTML block for document headers (empty string when nothing is set).
  brandingHtml(org, opts) { return sharedBrandingHtml(org || currentOrgData || {}, opts); },


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
  // opts.log === false: the caller takes its own before/after snapshot and logs
  // one movement for the whole save (edit form, grid, CSV import), so logging
  // here too would count the change twice. Otherwise one MOVE (total
  // unchanged) or ADJUST movement is logged with before/after.
  async syncItemToLocation(itemId, locationCode, quantity, opts = {}) {
    const before = opts.log === false ? null : await this.stockSnapshot(itemId);
    // Item-owned model: put the whole quantity at one shelf (exclusive move).
    const code = this.canonicalLocationCode(locationCode || '');
    const qty = toQty(quantity);
    // A BLANK location means "this item is nowhere" — clear its shelves.
    // Returning early here made clearing a location a silent no-op, so the
    // item kept showing on its old shelf in Locations and on the Map.
    if (!code) {
      await this.setItemLocations(itemId, []);
    } else {
      await this.setItemLocations(itemId, qty > 0 ? [{ code, qty }] : []);
    }
    if (before) await this.logStockChange(itemId, before, 'AUTO', opts.reason || 'Item assigned to ' + (code || 'no shelf'));
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

  // opts.log === false when the caller logs the save itself (see syncItemToLocation).
  async updateItemWithSync(itemId, updates, opts = {}) {
    const ref = doc(db, 'items', itemId);

    // Get current item to know the stock
    const itemSnap = await getDoc(ref);
    const currentItem = itemSnap.exists() ? itemSnap.data() : {};
    const before = (opts.log === false || !itemSnap.exists()) ? null : this.stockState(currentItem);
    const stock = toQty(updates.stock !== undefined ? updates.stock : currentItem.stock);

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
      await this.syncItemToLocation(itemId, updates.location, stock, { log: false });
    }
    if (before) await this.logStockChange(itemId, before, 'AUTO', opts.reason || 'Item updated');

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
      ...withoutLedgerFields(poData),
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

    // Re-measuring the boxes invalidates any shipping quote that has not been
    // bought yet. generateShippingLabel purchases by rate id without re-rating,
    // so leaving a stale quote on the order means the label goes out at the old
    // size and weight and the carrier bills the difference. Dropping it here
    // sends the order back to "pending" and forces a fresh Get Rates - the same
    // thing the customer re-sync already does before it re-rates.
    const extra = {};
    try {
      const snap = await getDoc(ref);
      const before = snap.exists() ? snap.data() : null;
      if (shouldClearShippingRates(before, updates)) {
        extra.shippingLabel = null;
        extra.shippingStatus = 'pending';
      }
    } catch (e) {
      // A purchased label must never be wiped on a failed read, so leave the
      // order alone and say so loudly rather than guessing either way.
      console.error('Could not check for stale shipping rates on ' + poId, e);
    }

    await updateDoc(ref, {
      ...withoutLedgerFields(updates),
      ...extra,
      updatedAt: Date.now()
    });
    if (extra.shippingLabel === null) {
      await this.logActivity('SHIPPING_RATES_INVALIDATED', { poId, reason: 'packaging changed' });
    }
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
      // Carried so a PICK movement can name the order in words, not just by id.
      poNumber: po.poNumber || '',
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

  // ── Single, guarded inventory deduction for an order ────────────────────
  // Two bugs this replaces:
  //  1. Shipping used ONLY item.qtyShipped, which the packing step fills in.
  //     Ship an unpacked order (triwalls, or straight from confirmed) and every
  //     line was skipped — the order shipped and stock never moved.
  //  2. Nothing recorded that stock had been taken, so completing a pick list
  //     AND then marking the order shipped deducted the same units twice.
  // The order now carries a stockDeducted flag, so this runs at most once
  // however it's triggered.
  // ── Recover multi-location breakdowns flattened by a CSV round-trip ──────
  // The unify migration READ the old location.inventory maps but never cleared
  // them, so they still hold each item's shelf split as it stood back then.
  // This compares that snapshot against what an item has now and reports any
  // that used to be split but are now on a single shelf.
  // READ-ONLY unless apply is true.
  async recoverSplitLocations(apply) {
    if (!currentOrgId) throw new Error('No organization selected');
    const items = await this.getItems();
    const locations = await this.getLocations();

    // itemId -> [{code, qty}] from the retired maps
    const legacy = {};
    locations.forEach(l => {
      const code = this.canonicalLocationCode(
        l.locationCode || `${l.warehouse}-R${l.rack}-${l.letter}${l.shelf}`);
      const inv = l.inventory || {};
      Object.keys(inv).forEach(id => {
        const q = toQty(inv[id]);
        if (q > 0 && code) (legacy[id] = legacy[id] || []).push({ code, qty: q });
      });
    });

    const flattened = [], restored = [], noSnapshot = [];

    for (const it of items) {
      const now = this.itemLocations(it);
      const was = legacy[it.id] || [];
      if (was.length < 2) continue;             // wasn't split back then
      if (now.length > 1) continue;             // still split — nothing lost

      const legacyTotal = was.reduce((s, e) => s + e.qty, 0);
      const nowTotal = now.reduce((s, e) => s + e.qty, 0) || toQty(it.stock);

      const row = {
        id: it.id, sku: it.partNumber, name: it.name,
        nowAt: now.map(e => `${e.code}:${e.qty}`).join(', ') || '(none)',
        nowTotal,
        wasAt: was.map(e => `${e.code}:${e.qty}`).join(', '),
        wasTotal: legacyTotal
      };

      if (!apply) { flattened.push(row); continue; }

      // Restore the OLD proportions against the CURRENT total, so sales since
      // the snapshot aren't undone.
      let remaining = nowTotal;
      const rebuilt = [];
      was.forEach((e, idx) => {
        const share = idx === was.length - 1
          ? remaining
          : Math.round(nowTotal * (e.qty / legacyTotal));
        if (share > 0) { rebuilt.push({ code: e.code, qty: share }); remaining -= share; }
      });
      if (rebuilt.length > 1 && rebuilt.reduce((s, e) => s + e.qty, 0) === nowTotal) {
        const before = this.stockState(it);
        await this.setItemLocations(it.id, rebuilt);
        await this.logStockChange(it.id, before, 'AUTO', 'Split shelves recovered from pre-migration snapshot');
        restored.push({ ...row, rebuiltAs: rebuilt.map(e => `${e.code}:${e.qty}`).join(', ') });
      } else {
        noSnapshot.push(row);
      }
    }

    return { flattened, restored, noSnapshot, apply: !!apply };
  },

  async deductOrderStock(orderId, opts = {}) {
    if (!currentOrgId) throw new Error('No organization selected');
    const order = await this.getPurchaseOrder(orderId);
    if (!order) return { skipped: 'no-order', deducted: 0 };
    if (order.stockDeducted && !opts.force) {
      return { skipped: 'already-deducted', deducted: 0, at: order.stockDeductedAt || null };
    }

    let deducted = 0, units = 0;
    const report = [];

    for (const line of order.items || []) {
      if (line.source !== 'inventory' && line.source !== 'inventory_contract') continue;
      // What was actually taken: what the picker counted, else what was packed,
      // else what was ordered.
      const qty = toQty(line.pickedQty) || toQty(line.qtyShipped) || toQty(line.quantity);
      if (qty <= 0 || !line.itemId) continue;

      const from = line.pickedFrom || line.location || '';
      let moved = null;
      try {
        moved = await this.removeStockAtLocation(line.itemId, from, qty, { orderId: orderId, orderNumber: order.poNumber || '' });
      } catch (e) {
        console.warn('removeStockAtLocation failed for', line.itemName, e.message);
      }

      if (!moved) {
        // Item has no shelf entries at all — fall back to a plain stock write so
        // the count still moves.
        try {
          const snap = await getDoc(doc(db, 'items', line.itemId));
          if (snap.exists()) {
            const cur = toQty(snap.data().stock);
            const next = Math.max(0, cur - qty);
            await updateDoc(doc(db, 'items', line.itemId), {
              stock: next, updatedAt: Date.now()
            });
            try {
              await this.logMovement({
                itemId: line.itemId, itemName: snap.data().name || line.itemName || '',
                sku: snap.data().partNumber || '', grade: snap.data().grade || '',
                quantity: qty, type: 'PICK', fromLocation: '',
                beforeQty: cur, afterQty: next,
                orderId, ...(order.poNumber ? { orderNumber: order.poNumber } : {}),
                note: 'No shelf entry - stock total reduced directly'
              });
            } catch (e) { console.warn('PICK movement not logged for', line.itemName, e.message); }
          }
        } catch (e) {
          console.warn('stock fallback failed for', line.itemName, e.message);
          continue;
        }
      }
      deducted++; units += qty;
      report.push(`${line.partNumber || ''} ${line.itemName}: -${qty}`);
    }

    await this.updatePurchaseOrder(orderId, {
      stockDeducted: true,
      stockDeductedAt: Date.now(),
      // New stock is out for this order, so an earlier restore no longer
      // covers it (restoreOrderStock also checks the ledger itself).
      stockRestored: false
    });

    return { deducted, units, report };
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
    // Every movement carries sku + grade: items can share a name exactly
    // (a NEW and a #1 of the same parka), and the name alone can't tell them
    // apart. Callers that have the item pass them; otherwise read it here.
    let extra = {};
    if (movementData.itemId && movementData.sku === undefined) {
      try {
        const s = await getDoc(doc(db, 'items', movementData.itemId));
        if (s.exists()) extra = { sku: s.data().partNumber || '', grade: s.data().grade || '' };
      } catch (e) { /* history must never block the stock write it records */ }
    }
    await addDoc(collection(db, 'movements'), {
      ...extra,
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
  
  // Every movement for the given items, all time, newest first. Used when the
  // Movements page is searched for a SKU so its history isn't cut off by the
  // 500-row default view.
  async getMovementsForItems(itemIds) {
    if (!currentOrgId) return [];
    const out = [];
    for (const itemId of [...new Set(itemIds || [])].filter(Boolean)) {
      const base = [collection(db, 'movements'), where('orgId', '==', currentOrgId), where('itemId', '==', itemId)];
      let snap;
      try {
        snap = await getDocs(query(...base, orderBy('timestamp', 'desc')));
      } catch (e) {
        // Index (orgId, itemId, timestamp) not deployed yet - equality only.
        snap = await getDocs(query(...base));
      }
      snap.docs.forEach(d => out.push({ id: d.id, ...d.data() }));
    }
    return out.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  },

  // For paths that write an item's stock/shelves directly (edit form, grid,
  // CSV import): take stockSnapshot() before the write and call
  // logStockChange() after it. One movement is logged with before/after when
  // the total or any shelf changed. Never throws - history must not block
  // the save it records.
  async stockSnapshot(itemId) {
    try {
      const snap = await getDoc(doc(db, 'items', itemId));
      return snap.exists() ? this.stockState(snap.data()) : null;
    } catch (e) { return null; }
  },

  stockState(item) {
    return {
      name: item.name || '', sku: item.partNumber || '', grade: item.grade || '',
      stock: toQty(item.stock),
      locations: this.itemLocations(item)
    };
  },

  // After a CSV import: one IMPORT movement per pre-existing item whose total
  // or shelves changed, and one CREATE per item the import created, carrying
  // its FINAL quantity and shelves. (The import creates items with createItem
  // { logCreate: false } and may then change them in its location pass; a
  // CREATE at creation time would miss that later change.)
  // `createdIds`: the ids the import created. Only those get a CREATE here, so
  // an item someone else adds while the import runs isn't logged twice.
  async logImportChanges(beforeItems, createdIds = []) {
    try {
      const after = await this.getItems();
      const byId = new Map((beforeItems || []).map(i => [i.id, i]));
      const created = new Set(createdIds || []);
      const EMPTY = { stock: 0, locations: [] };
      let logged = 0;
      for (const a of after) {
        const b = byId.get(a.id);
        if (!b && !created.has(a.id)) continue;
        const mv = b
          ? stockChangeMovement(this.stockState(b), this.stockState(a), { type: 'IMPORT', reason: 'CSV import' })
          : stockChangeMovement(EMPTY, this.stockState(a), { type: 'CREATE', reason: 'Item created by CSV import' });
        if (!mv) continue;
        await this.logMovement({ itemId: a.id, itemName: a.name || '', sku: a.partNumber || '', grade: a.grade || '', ...mv });
        logged++;
      }
      return logged;
    } catch (e) {
      console.warn('Import history not fully logged:', e.message);
      return 0;
    }
  },

  async logStockChange(itemId, before, type, reason) {
    if (!before) return null;
    try {
      const after = await this.stockSnapshot(itemId);
      if (!after) return null;
      const mv = stockChangeMovement(before, after, { type, reason });
      if (!mv) return null;
      await this.logMovement({ itemId, itemName: after.name, sku: after.sku, grade: after.grade, ...mv });
      return mv;
    } catch (e) {
      console.warn('Stock change not logged for', itemId, e.message);
      return null;
    }
  },

  // ==================== COUNTS (ORG-SCOPED) ====================
  
  async getCounts() {
    if (!currentOrgId) return [];
    
    const q = query(collection(db, 'counts'), where('orgId', '==', currentOrgId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  },

  // A physical count at one shelf. The count is authoritative: that shelf's
  // entry in item.locations is set to the counted number (dropped at 0, added
  // if the item wasn't listed there), stock is re-derived as the sum of the
  // shelves, and a COUNT movement records the shelf and item before/after.
  //
  // The location document's old `inventory` map is no longer written. Those
  // maps were retired by the unify migration; the only code still reading
  // them is recoverSplitLocations, which uses them as a frozen pre-migration
  // snapshot (writing a count into it would corrupt that snapshot). The
  // scanner screens that used to read them now read item.locations.
  async updateCount(locationId, itemId, count, meta = {}) {
    if (!currentOrgId) throw new Error('No organization selected');
    const snap = await getDoc(doc(db, 'locations', locationId));
    if (!snap.exists()) throw new Error('Location not found');
    if (snap.data().orgId && snap.data().orgId !== currentOrgId) throw new Error('Location not found');
    return await this.countItemAtShelf(itemId, this.locationCodeOf(snap.data()), count, meta);
  },

  async countItemAtShelf(itemId, code, count, meta = {}) {
    if (!currentOrgId) throw new Error('No organization selected');
    const shelf = this.canonicalLocationCode(code || '');
    if (!shelf) throw new Error('A shelf is required for a count');
    const snap = await getDoc(doc(db, 'items', itemId));
    if (!snap.exists()) throw new Error('Item not found');
    const item = snap.data();
    if (item.orgId && item.orgId !== currentOrgId) throw new Error('Item not found');
    // Unshelved stock (stock with no shelf at all) is kept - on the item's
    // location field if it has one, else STAGING - rather than wiped by a
    // count of some other shelf.
    const seed = seedUnshelved(this.itemLocations(item), item.stock, this.unshelvedSeedCode(item));
    const plan = applyCount(seed.entries, shelf, count);
    const storedStock = toQty(item.stock);
    if (!plan.changed && !seed.seeded && storedStock === plan.after) {
      return { changed: false, shelf, shelfQty: plan.shelfAfter, stock: plan.after };
    }
    const res = await this.setItemLocations(itemId, plan.entries);
    await this.logMovement({
      itemId, itemName: item.name || '', sku: item.partNumber || '', grade: item.grade || '',
      type: 'COUNT',
      quantity: Math.abs(plan.shelfAfter - plan.shelfBefore),
      shelf, shelfBefore: plan.shelfBefore, shelfAfter: plan.shelfAfter,
      // Item totals. beforeQty is the shelf sum the count was applied to; when
      // the stored stock field disagreed with it, that is recorded too.
      beforeQty: plan.before, afterQty: res.stock,
      ...(storedStock !== plan.before ? { storedStockBefore: storedStock } : {}),
      ...(seed.seeded ? { seededToStaging: seed.seeded } : {}),
      fromLocation: plan.shelfAfter < plan.shelfBefore ? shelf : '',
      toLocation: plan.shelfAfter > plan.shelfBefore ? shelf : '',
      note: meta.note || `Counted ${plan.shelfAfter} at ${shelf}`
    });
    return { changed: true, shelf, shelfQty: plan.shelfAfter, stock: res.stock, before: plan.before };
  },

  // ── Order restores (cancel / delete with "return to stock") ─────────────
  // Every movement tagged with this order's id, oldest first.
  async getOrderMovements(orderId) {
    if (!currentOrgId || !orderId) return [];
    const snap = await getDocs(query(collection(db, 'movements'),
      where('orgId', '==', currentOrgId), where('orderId', '==', orderId)));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => toQty(a.timestamp) - toQty(b.timestamp));
  },

  // What restoring this order would put back, from the ledger (PICK movements
  // for the order minus RESTORE movements already written for it). Read-only.
  async planOrderRestore(orderOrId) {
    const order = typeof orderOrId === 'string' ? await this.getPurchaseOrder(orderOrId) : orderOrId;
    if (!order) return { lines: [], skipped: 'no-order', unverifiable: false, outstandingUnits: 0 };
    const movements = await this.getOrderMovements(order.id);
    return planOrderRestoreFromLedger(order, movements);
  },

  // Put back what this order actually took, onto the shelf it was taken from
  // (a pick with no shelf recorded goes to the item's primary shelf, else
  // STAGING). Guarded against double restores three ways: a short-lived claim
  // on the order (two tabs / double click), the ledger (only picked minus
  // already-restored units), and the order's stockRestored flag. An order
  // with no tagged PICK movement restores nothing.
  async restoreOrderStock(orderId, opts = {}) {
    if (!currentOrgId) throw new Error('No organization selected');
    const ref = doc(db, 'purchaseOrders', orderId);
    const CLAIM_MS = 2 * 60 * 1000;
    const claimedAt = Date.now();
    await runTransaction(db, async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists() || s.data().orgId !== currentOrgId) throw new Error('Order not found');
      const c = toQty(s.data().stockRestoreClaimAt);
      if (c && claimedAt - c < CLAIM_MS) throw new Error('Stock for this order is already being restored - try again in a minute.');
      tx.update(ref, { stockRestoreClaimAt: claimedAt });
    });

    try {
      const snap = await getDoc(ref);
      const order = { id: orderId, ...snap.data() };
      const plan = await this.planOrderRestore(order);
      const why = opts.reason === 'deleted' ? 'deleted' : 'cancelled';
      const results = [], errors = [];
      for (const line of plan.lines) {
        try {
          const isnap = await getDoc(doc(db, 'items', line.itemId));
          if (!isnap.exists()) { errors.push(`${line.sku || line.itemName}: item no longer exists`); continue; }
          const shelf = restoreShelf(line.pickShelf, this.itemLocations(isnap.data()), this.STAGING_CODE);
          const res = await this.addStockAtLocation(line.itemId, shelf, line.qty, {
            type: 'RESTORE', orderId, orderNumber: order.poNumber || '',
            pickShelf: line.pickShelf,
            note: `Restored from ${why} order ${order.poNumber || orderId}` +
              (line.pickShelf ? '' : ' (pick had no shelf recorded)')
          });
          results.push({ ...line, shelf, stock: res.stock });
        } catch (e) {
          errors.push(`${line.sku || line.itemName}: ${e.message}`);
        }
      }
      const units = results.reduce((sum, r) => sum + r.qty, 0);
      const done = !errors.length;
      const flags = {};
      if (units > 0 || plan.skipped === 'already-restored') {
        flags.stockRestored = done;
        if (done) { flags.stockRestoredAt = Date.now(); flags.stockDeducted = false; }
        flags.stockRestoredUnits = toQty(snap.data().stockRestoredUnits) + units;
      }
      await updateDoc(ref, { ...flags, stockRestoreClaimAt: null, updatedAt: Date.now() });
      return { restored: results, units, errors, skipped: plan.skipped, unverifiable: plan.unverifiable };
    } catch (e) {
      try { await updateDoc(ref, { stockRestoreClaimAt: null }); } catch (e2) { /* the claim expires anyway */ }
      throw e;
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
