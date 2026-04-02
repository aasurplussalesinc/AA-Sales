import { BrowserRouter, Routes, Route, Link, useLocation, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './OrgAuthContext';
import LandingPage from './pages/LandingPage';
import OrgLogin from './pages/OrgLogin';
import SubscriptionRequired from './pages/SubscriptionRequired';
import OrgSettings from './pages/OrgSettings';
import Dashboard from './pages/Dashboard';
import Items from './pages/Items';
import Locations from './pages/Locations';
import Scanner from './pages/Scanner';
import Movements from './pages/Movements';
import ActivityLog from './pages/ActivityLog';
import PickLists from './pages/PickLists';
import Receiving from './pages/Receiving';
import Reports from './pages/Reports';
import PurchaseOrders from './pages/PurchaseOrders';
import Customers from './pages/Customers';
import Contracts from './pages/Contracts';
import Shipping from './pages/Shipping';
import { useTier } from './useTier';
import { ThemeProvider, useTheme } from './ThemeContext';
import './App.css';

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      onClick={toggleTheme}
      className="theme-toggle"
      title={theme === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
    >
      {theme === 'light' ? '🌙' : '☀️'}
    </button>
  );
}

// Full-screen hard block for locked features
export function TierGate({ feature, requiredPlan, children }) {
  const { canUseOrders, canUsePickLists, canUsePacking, canUseReports,
          canUseShipping, canUseContracts } = useTier();
  const gates = {
    orders: canUseOrders, pickLists: canUsePickLists, packing: canUsePacking,
    reports: canUseReports, shipping: canUseShipping, contracts: canUseContracts,
  };
  const allowed = gates[feature] !== false;
  if (allowed) return children;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: '60vh', textAlign: 'center', padding: 40
    }}>
      <div style={{ fontSize: 64, marginBottom: 20 }}>🔒</div>
      <h2 style={{ fontSize: 28, marginBottom: 10, color: '#333' }}>
        {requiredPlan} Plan Required
      </h2>
      <p style={{ color: '#666', fontSize: 16, maxWidth: 400, marginBottom: 30 }}>
        This feature is available on the <strong>{requiredPlan}</strong> plan and above.
        Upgrade to unlock it.
      </p>
      <a href="/subscription-required" style={{
        padding: '12px 32px', background: '#2d5f3f', color: 'white',
        borderRadius: 8, textDecoration: 'none', fontWeight: 700, fontSize: 16
      }}>View Plans & Upgrade</a>
    </div>
  );
}

function NavBar() {
  const location = useLocation();
  const { user, logout, organization, subscriptionStatus, organizations, switchOrganization } = useAuth();
  const tier = useTier();
  
  const isActive = (path) => location.pathname === path;

  const handleLogout = async () => {
    if (window.confirm('Are you sure you want to sign out?')) {
      await logout();
    }
  };

  const { theme } = useTheme();
  const planColors = {
    trial: '#ffc107', starter: '#78909c', pro: '#1976d2',
    business: '#7b1fa2', enterprise: theme === 'dark' ? '#34d399' : '#2d5f3f', owner: '#c62828'
  };
  const planLabels = {
    trial: `Trial · ${subscriptionStatus?.trialDaysRemaining ?? 0}d left`,
    starter: 'Starter', pro: 'Pro', business: 'Business',
    enterprise: 'Enterprise', owner: '⭐ Owner'
  };
  
  return (
    <>
      <div className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>📦</span>
          <h1>{organization?.name || 'Warehouse Manager'}</h1>
        </div>
        {user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 15, flexWrap: 'wrap' }}>
            {organizations.length > 1 && (
              <select
                value={organization?.id || ''}
                onChange={(e) => {
                  const org = organizations.find(o => o.id === e.target.value);
                  if (org) switchOrganization(org);
                }}
                style={{
                  background: 'rgba(255,255,255,0.2)', border: 'none', color: 'white',
                  padding: '6px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 13
                }}
              >
                {organizations.map(org => (
                  <option key={org.id} value={org.id} style={{ color: 'black' }}>{org.name}</option>
                ))}
              </select>
            )}
            {subscriptionStatus?.plan && (
              <span style={{
                background: planColors[subscriptionStatus.plan] || '#666',
                color: 'white', padding: '4px 10px', borderRadius: 12,
                fontSize: 11, fontWeight: 700, letterSpacing: 0.5
              }}>
                {planLabels[subscriptionStatus.plan] || subscriptionStatus.plan}
              </span>
            )}
            <span style={{ fontSize: 14, opacity: 0.9 }}>👤 {user.email}</span>
            <ThemeToggle />
            <button onClick={handleLogout} style={{
              background: 'rgba(255,255,255,0.2)', border: 'none', color: 'white',
              padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 13
            }}>Sign Out</button>
          </div>
        )}
      </div>
      <div className="nav-tabs">
        <Link to="/" className={`nav-tab ${isActive('/') ? 'active' : ''}`}>📊 Dashboard</Link>
        <Link to="/scanner" className={`nav-tab ${isActive('/scanner') ? 'active' : ''}`}>📷 Scan</Link>
        <Link to="/items" className={`nav-tab ${isActive('/items') ? 'active' : ''}`}>📦 Items</Link>
        <Link to="/locations" className={`nav-tab ${isActive('/locations') ? 'active' : ''}`}>📍 Locations</Link>
        <Link to="/customers" className={`nav-tab ${isActive('/customers') ? 'active' : ''}`}>👥 Customers</Link>
        <Link to="/receiving" className={`nav-tab ${isActive('/receiving') ? 'active' : ''}`}>📥 Receiving</Link>
        {tier.canUseOrders && <Link to="/purchase-orders" className={`nav-tab ${isActive('/purchase-orders') ? 'active' : ''}`}>🧾 Orders</Link>}
        {tier.canUsePickLists && <Link to="/pick-lists" className={`nav-tab ${isActive('/pick-lists') ? 'active' : ''}`}>📋 Pick Lists</Link>}
        {tier.canUseReports && <Link to="/reports" className={`nav-tab ${isActive('/reports') ? 'active' : ''}`}>📈 Reports</Link>}
        {tier.canUseShipping && <Link to="/shipping" className={`nav-tab ${isActive('/shipping') ? 'active' : ''}`}>🚚 Shipping</Link>}
        {tier.canUseContracts && <Link to="/contracts" className={`nav-tab ${isActive('/contracts') ? 'active' : ''}`}>📄 Contracts</Link>}
        <Link to="/movements" className={`nav-tab ${isActive('/movements') ? 'active' : ''}`}>🔄 Movements</Link>
        <Link to="/activity" className={`nav-tab ${isActive('/activity') ? 'active' : ''}`}>📜 Activity</Link>
        <Link to="/settings" className={`nav-tab ${isActive('/settings') ? 'active' : ''}`}>⚙️ Settings</Link>
      </div>
    </>
  );
}

function AppLayout({ children }) {
  return (
    <div className="app">
      <NavBar />
      {children}
    </div>
  );
}

// Protected route that also checks organization and subscription
function ProtectedRoute({ children }) {
  const { user, organization, subscriptionStatus, loading } = useAuth();
  
  if (loading) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100vh',
        background: '#f5f5f5'
      }}>
        <p>Loading...</p>
      </div>
    );
  }
  
  // Not logged in
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  
  // No organization selected (needs to create or select one)
  if (!organization) {
    return <Navigate to="/login" replace />;
  }
  
  // Subscription expired (not owner)
  if (subscriptionStatus && !subscriptionStatus.isActive) {
    return <Navigate to="/subscription-required" replace />;
  }
  
  return children;
}

function AppRoutes() {
  const { user, organization, subscriptionStatus } = useAuth();

  return (
    <Routes>
      {/* Landing page - show at root for logged out users */}
      <Route 
        path="/" 
        element={user && organization ? (
          <ProtectedRoute>
            <AppLayout><Dashboard /></AppLayout>
          </ProtectedRoute>
        ) : <LandingPage />} 
      />
      
      {/* Keep /welcome as alias */}
      <Route 
        path="/welcome" 
        element={user && organization ? <Navigate to="/dashboard" replace /> : <LandingPage />} 
      />
      
      {/* Dashboard route for logged in users */}
      <Route path="/dashboard" element={
        <ProtectedRoute>
          <AppLayout><Dashboard /></AppLayout>
        </ProtectedRoute>
      } />
      
      {/* Public routes */}
      <Route 
        path="/login" 
        element={user && organization ? <Navigate to="/dashboard" replace /> : <OrgLogin />} 
      />
      
      <Route 
        path="/subscription-required" 
        element={
          !user ? <Navigate to="/login" replace /> : 
          (subscriptionStatus?.isActive ? <Navigate to="/dashboard" replace /> : <SubscriptionRequired />)
        } 
      />
      
      {/* Protected routes */}
      <Route path="/items" element={
        <ProtectedRoute>
          <AppLayout><Items /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/locations" element={
        <ProtectedRoute>
          <AppLayout><Locations /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/scanner" element={
        <ProtectedRoute>
          <AppLayout><Scanner /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/movements" element={
        <ProtectedRoute>
          <AppLayout><Movements /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/activity" element={
        <ProtectedRoute>
          <AppLayout><ActivityLog /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/pick-lists" element={
        <ProtectedRoute>
          <AppLayout><TierGate feature="pickLists" requiredPlan="Pro"><PickLists /></TierGate></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/purchase-orders" element={
        <ProtectedRoute>
          <AppLayout><TierGate feature="orders" requiredPlan="Pro"><PurchaseOrders /></TierGate></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/customers" element={
        <ProtectedRoute>
          <AppLayout><Customers /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/contracts" element={
        <ProtectedRoute>
          <AppLayout><TierGate feature="contracts" requiredPlan="Business"><Contracts /></TierGate></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/shipping" element={
        <ProtectedRoute>
          <AppLayout><TierGate feature="shipping" requiredPlan="Business"><Shipping /></TierGate></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/receiving" element={
        <ProtectedRoute>
          <AppLayout><Receiving /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/reports" element={
        <ProtectedRoute>
          <AppLayout><TierGate feature="reports" requiredPlan="Pro"><Reports /></TierGate></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/settings" element={
        <ProtectedRoute>
          <AppLayout><OrgSettings /></AppLayout>
        </ProtectedRoute>
      } />
      
      {/* Catch all */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
