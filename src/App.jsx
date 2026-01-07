import { BrowserRouter, Routes, Route, Link, useLocation, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import ProtectedRoute from './ProtectedRoute';
import Login from './pages/Login';
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
import './App.css';

function NavBar() {
  const location = useLocation();
  const { user, logout } = useAuth();
  
  const isActive = (path) => location.pathname === path;

  const handleLogout = async () => {
    if (window.confirm('Are you sure you want to sign out?')) {
      await logout();
    }
  };
  
  return (
    <>
      <div className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>📦</span>
          <h1>AA Surplus Sales Inc.</h1>
        </div>
        {user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
            <span style={{ fontSize: 14, opacity: 0.9 }}>
              👤 {user.email}
            </span>
            <button 
              onClick={handleLogout}
              style={{
                background: 'rgba(255,255,255,0.2)',
                border: 'none',
                color: 'white',
                padding: '6px 12px',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 13
              }}
            >
              Sign Out
            </button>
          </div>
        )}
      </div>
      <div className="nav-tabs">
        <Link to="/" className={`nav-tab ${isActive('/') ? 'active' : ''}`}>
          📊 Dashboard
        </Link>
        <Link to="/scanner" className={`nav-tab ${isActive('/scanner') ? 'active' : ''}`}>
          📷 Scan
        </Link>
        <Link to="/items" className={`nav-tab ${isActive('/items') ? 'active' : ''}`}>
          📦 Items
        </Link>
        <Link to="/locations" className={`nav-tab ${isActive('/locations') ? 'active' : ''}`}>
          📍 Locations
        </Link>
        <Link to="/pick-lists" className={`nav-tab ${isActive('/pick-lists') ? 'active' : ''}`}>
          📋 Pick Lists
        </Link>
        <Link to="/purchase-orders" className={`nav-tab ${isActive('/purchase-orders') ? 'active' : ''}`}>
          🧾 Orders
        </Link>
        <Link to="/customers" className={`nav-tab ${isActive('/customers') ? 'active' : ''}`}>
          👥 Customers
        </Link>
        <Link to="/receiving" className={`nav-tab ${isActive('/receiving') ? 'active' : ''}`}>
          📥 Receiving
        </Link>
        <Link to="/movements" className={`nav-tab ${isActive('/movements') ? 'active' : ''}`}>
          🔄 Movements
        </Link>
        <Link to="/reports" className={`nav-tab ${isActive('/reports') ? 'active' : ''}`}>
          📈 Reports
        </Link>
        <Link to="/activity" className={`nav-tab ${isActive('/activity') ? 'active' : ''}`}>
          📜 Activity
        </Link>
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

function AppRoutes() {
  const { user } = useAuth();

  return (
    <Routes>
      {/* Public route */}
      <Route 
        path="/login" 
        element={user ? <Navigate to="/" replace /> : <Login />} 
      />
      
      {/* Protected routes */}
      <Route path="/" element={
        <ProtectedRoute>
          <AppLayout><Dashboard /></AppLayout>
        </ProtectedRoute>
      } />
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
          <AppLayout><PickLists /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/purchase-orders" element={
        <ProtectedRoute>
          <AppLayout><PurchaseOrders /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/customers" element={
        <ProtectedRoute>
          <AppLayout><Customers /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/receiving" element={
        <ProtectedRoute>
          <AppLayout><Receiving /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/reports" element={
        <ProtectedRoute>
          <AppLayout><Reports /></AppLayout>
        </ProtectedRoute>
      } />
      
      {/* Catch all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
