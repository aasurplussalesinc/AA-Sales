import { createContext, useContext, useState, useEffect } from 'react';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword,
  signOut, 
  onAuthStateChanged,
  sendPasswordResetEmail
} from 'firebase/auth';
import { auth } from './firebase';
import { OrgDB, OWNER_ORG_ID } from './orgDb';

const AuthContext = createContext();

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [organization, setOrganization] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [organizations, setOrganizations] = useState([]);
  const [subscriptionStatus, setSubscriptionStatus] = useState(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      console.log('Auth state changed:', firebaseUser?.email);
      setUser(firebaseUser);
      
      if (firebaseUser && firebaseUser.uid) {
        // Load user's organizations
        try {
          const orgs = await OrgDB.getUserOrganizations(firebaseUser.uid);
          console.log('Loaded orgs:', orgs.length);
          setOrganizations(orgs);
          
          // Auto-select first org if only one, or previously selected
          const savedOrgId = localStorage.getItem('selectedOrgId');
          
          let orgToSelect = null;
          if (orgs.length === 1) {
            orgToSelect = orgs[0];
          } else if (savedOrgId) {
            orgToSelect = orgs.find(o => o.id === savedOrgId);
          }
          
          if (orgToSelect) {
            // Select organization inline to avoid state timing issues
            const membership = await OrgDB.getUserOrgMembership(firebaseUser.uid, orgToSelect.id);
            const role = membership?.role || orgToSelect.userRole || 'staff';
            
            setOrganization(orgToSelect);
            setUserRole(role);
            
            // Check subscription status
            const isActive = OrgDB.isSubscriptionActive(orgToSelect);
            const trialDays = OrgDB.getTrialDaysRemaining(orgToSelect);
            
            setSubscriptionStatus({
              isActive,
              plan: orgToSelect.plan,
              trialDaysRemaining: trialDays,
              status: orgToSelect.status
            });
            
            // Set in OrgDB for queries
            OrgDB.setCurrentOrg(orgToSelect.id, orgToSelect, role);
            
            // Save selection
            localStorage.setItem('selectedOrgId', orgToSelect.id);
            console.log('Selected org:', orgToSelect.name);
          }
        } catch (error) {
          console.error('Error loading organizations:', error);
        }
      } else {
        // Clear everything on logout
        setOrganization(null);
        setUserRole(null);
        setOrganizations([]);
        setSubscriptionStatus(null);
        OrgDB.clearCurrentOrg();
      }
      
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  const loadUserOrganizations = async (userId) => {
    try {
      const orgs = await OrgDB.getUserOrganizations(userId);
      setOrganizations(orgs);
      
      // Auto-select first org if only one, or previously selected
      const savedOrgId = localStorage.getItem('selectedOrgId');
      
      if (orgs.length === 1) {
        await selectOrganization(orgs[0], userId);
      } else if (savedOrgId) {
        const savedOrg = orgs.find(o => o.id === savedOrgId);
        if (savedOrg) {
          await selectOrganization(savedOrg, userId);
        }
      }
    } catch (error) {
      console.error('Error loading organizations:', error);
    }
  };

  const selectOrganization = async (org, userId = null) => {
    const uid = userId || user?.uid;
    if (!uid) {
      console.error('No user ID available for selectOrganization');
      return;
    }
    
    const membership = await OrgDB.getUserOrgMembership(uid, org.id);
    const role = membership?.role || org.userRole || 'staff';
    
    setOrganization(org);
    setUserRole(role);
    
    // Check subscription status
    const isActive = OrgDB.isSubscriptionActive(org);
    const trialDays = OrgDB.getTrialDaysRemaining(org);
    
    setSubscriptionStatus({
      isActive,
      plan: org.plan,
      trialDaysRemaining: trialDays,
      status: org.status
    });
    
    // Set in OrgDB for queries
    OrgDB.setCurrentOrg(org.id, org, role);
    
    // Save selection
    localStorage.setItem('selectedOrgId', org.id);
  };

  const login = async (email, password) => {
    const result = await signInWithEmailAndPassword(auth, email, password);
    await loadUserOrganizations(result.user.uid);
    
    // Check for pending invitations
    const invitations = await OrgDB.getInvitationsByEmail(email);
    if (invitations.length > 0) {
      // Auto-accept invitations
      for (const inv of invitations) {
        try {
          await OrgDB.acceptInvitation(inv.id, result.user.uid);
        } catch (e) {
          console.error('Error accepting invitation:', e);
        }
      }
      // Reload orgs after accepting invitations
      await loadUserOrganizations(result.user.uid);
    }
    
    return result;
  };

  // Create organization for existing user (no new Firebase account needed)
  const createOrganizationForCurrentUser = async (companyName) => {
    if (!user) throw new Error('Must be logged in');
    
    const orgId = await OrgDB.createOrganization({
      name: companyName,
      email: user.email
    });
    
    await loadUserOrganizations(user.uid);
    return orgId;
  };

  const signup = async (email, password, companyName) => {
    // Create user account
    const result = await createUserWithEmailAndPassword(auth, email, password);
    
    // Create organization
    const orgId = await OrgDB.createOrganization({
      name: companyName,
      email: email
    });
    
    // Load the new org
    await loadUserOrganizations(result.user.uid);
    
    return result;
  };

  const signupWithInviteCode = async (email, password, inviteCode) => {
    // Create user account
    const result = await createUserWithEmailAndPassword(auth, email, password);
    
    // Use invite code to join organization
    await OrgDB.useInviteCode(inviteCode, result.user.uid, email);
    
    // Load the org
    await loadUserOrganizations(result.user.uid);
    
    return result;
  };

  const logout = async () => {
    localStorage.removeItem('selectedOrgId');
    OrgDB.clearCurrentOrg();
    await signOut(auth);
  };

  const resetPassword = (email) => {
    return sendPasswordResetEmail(auth, email);
  };

  const switchOrganization = async (org) => {
    await selectOrganization(org);
  };

  const refreshOrganization = async () => {
    if (organization) {
      const freshOrg = await OrgDB.getOrganizationById(organization.id);
      if (freshOrg) {
        await selectOrganization(freshOrg);
      }
    }
  };

  const inviteUser = async (email, role = 'staff') => {
    if (!organization) throw new Error('No organization selected');
    return await OrgDB.createInvitation(organization.id, email, role);
  };

  const isOwnerOrg = () => {
    return organization?.id === OWNER_ORG_ID || organization?.plan === 'owner';
  };

  const value = {
    user,
    organization,
    organizations,
    userRole,
    subscriptionStatus,
    loading,
    login,
    signup,
    signupWithInviteCode,
    logout,
    resetPassword,
    switchOrganization,
    refreshOrganization,
    inviteUser,
    isOwnerOrg,
    selectOrganization,
    loadUserOrganizations,
    createOrganizationForCurrentUser
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
}
