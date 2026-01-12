import { useState, useEffect } from 'react';
import { useAuth } from '../OrgAuthContext';
import { OrgDB } from '../orgDb';

export default function OrgSettings() {
  const { organization, userRole, subscriptionStatus, refreshOrganization, inviteUser, isOwnerOrg } = useAuth();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('staff');
  const [inviting, setInviting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  
  // Organization edit state
  const [editing, setEditing] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [orgEmail, setOrgEmail] = useState('');
  const [orgPhone, setOrgPhone] = useState('');
  const [orgAddress, setOrgAddress] = useState('');

  useEffect(() => {
    loadData();
  }, [organization]);

  const loadData = async () => {
    if (!organization) return;
    
    try {
      const memberList = await OrgDB.getOrganizationMembers(organization.id);
      setMembers(memberList);
      
      setOrgName(organization.name || '');
      setOrgEmail(organization.email || '');
      setOrgPhone(organization.phone || '');
      setOrgAddress(organization.address || '');
    } catch (err) {
      console.error('Error loading org data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleInvite = async (e) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    
    setInviting(true);
    setError('');
    setMessage('');
    
    try {
      const invitation = await inviteUser(inviteEmail.trim(), inviteRole);
      setMessage(`Invitation sent to ${inviteEmail}!`);
      setInviteEmail('');
      
      // In a real app, you'd send an email here with the invite link
      console.log('Invite token:', invitation.token);
    } catch (err) {
      setError(err.message || 'Failed to send invitation');
    } finally {
      setInviting(false);
    }
  };

  const handleSaveOrg = async () => {
    try {
      await OrgDB.updateOrganization(organization.id, {
        name: orgName,
        email: orgEmail,
        phone: orgPhone,
        address: orgAddress
      });
      await refreshOrganization();
      setEditing(false);
      setMessage('Organization updated!');
    } catch (err) {
      setError('Failed to update organization');
    }
  };

  const handleRemoveMember = async (member) => {
    if (!confirm(`Remove ${member.email} from the organization?`)) return;
    
    try {
      await OrgDB.removeUserFromOrganization(member.userId, organization.id);
      setMessage(`${member.email} has been removed`);
      loadData();
    } catch (err) {
      setError('Failed to remove member');
    }
  };

  const handleChangeRole = async (member, newRole) => {
    try {
      await OrgDB.updateUserRole(member.userId, organization.id, newRole);
      setMessage(`${member.email} is now a ${newRole}`);
      loadData();
    } catch (err) {
      setError('Failed to update role');
    }
  };

  if (loading) {
    return <div className="page-content"><p>Loading...</p></div>;
  }

  if (!organization) {
    return <div className="page-content"><p>No organization selected</p></div>;
  }

  const isAdmin = userRole === 'admin';

  return (
    <div className="page-content">
      {/* Subscription Banner */}
      {subscriptionStatus && !isOwnerOrg() && (
        <div style={{
          background: subscriptionStatus.plan === 'trial' ? '#fff3cd' : 
                     subscriptionStatus.isActive ? '#d4edda' : '#f8d7da',
          padding: 15,
          borderRadius: 8,
          marginBottom: 20,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10
        }}>
          <div>
            {subscriptionStatus.plan === 'trial' && (
              <>
                <strong>🕐 Trial Period</strong>
                <span style={{ marginLeft: 10 }}>
                  {subscriptionStatus.trialDaysRemaining} days remaining
                </span>
              </>
            )}
            {subscriptionStatus.plan !== 'trial' && subscriptionStatus.isActive && (
              <>
                <strong>✅ {subscriptionStatus.plan.charAt(0).toUpperCase() + subscriptionStatus.plan.slice(1)} Plan</strong>
                <span style={{ marginLeft: 10 }}>Active</span>
              </>
            )}
            {!subscriptionStatus.isActive && subscriptionStatus.plan === 'trial' && (
              <strong>⚠️ Trial Expired - Please subscribe to continue</strong>
            )}
          </div>
          <button 
            className="btn btn-primary"
            onClick={() => alert('Stripe billing portal would open here')}
          >
            {subscriptionStatus.plan === 'trial' ? 'Upgrade Now' : 'Manage Billing'}
          </button>
        </div>
      )}

      {isOwnerOrg() && (
        <div style={{
          background: '#d4edda',
          padding: 15,
          borderRadius: 8,
          marginBottom: 20
        }}>
          <strong>👑 Owner Account</strong> - You have unlimited free access
        </div>
      )}

      {message && (
        <div style={{ background: '#d4edda', padding: 15, borderRadius: 8, marginBottom: 20 }}>
          {message}
        </div>
      )}
      
      {error && (
        <div style={{ background: '#f8d7da', padding: 15, borderRadius: 8, marginBottom: 20 }}>
          {error}
        </div>
      )}

      {/* Organization Details */}
      <div style={{ background: 'white', padding: 20, borderRadius: 8, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
          <h3 style={{ margin: 0 }}>Organization Details</h3>
          {isAdmin && !editing && (
            <button className="btn btn-sm" onClick={() => setEditing(true)} style={{ background: '#ff9800', color: 'white' }}>
              ✏️ Edit
            </button>
          )}
        </div>
        
        {editing ? (
          <div>
            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Company Name</label>
              <input
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                className="form-input"
                style={{ width: '100%', maxWidth: 400 }}
              />
            </div>
            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Email</label>
              <input
                type="email"
                value={orgEmail}
                onChange={(e) => setOrgEmail(e.target.value)}
                className="form-input"
                style={{ width: '100%', maxWidth: 400 }}
              />
            </div>
            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Phone</label>
              <input
                type="tel"
                value={orgPhone}
                onChange={(e) => setOrgPhone(e.target.value)}
                className="form-input"
                style={{ width: '100%', maxWidth: 400 }}
              />
            </div>
            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Address</label>
              <textarea
                value={orgAddress}
                onChange={(e) => setOrgAddress(e.target.value)}
                className="form-input"
                style={{ width: '100%', maxWidth: 400, minHeight: 80 }}
              />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={handleSaveOrg}>Save</button>
              <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div>
            <p><strong>Name:</strong> {organization.name}</p>
            <p><strong>Email:</strong> {organization.email || '-'}</p>
            <p><strong>Phone:</strong> {organization.phone || '-'}</p>
            <p><strong>Address:</strong> {organization.address || '-'}</p>
            <p><strong>Organization ID:</strong> <code>{organization.id}</code></p>
            <p><strong>Created:</strong> {new Date(organization.createdAt).toLocaleDateString()}</p>
          </div>
        )}
      </div>

      {/* Team Members */}
      <div style={{ background: 'white', padding: 20, borderRadius: 8, marginBottom: 20 }}>
        <h3 style={{ marginBottom: 15 }}>Team Members ({members.length})</h3>
        
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f5f5f5' }}>
              <th style={{ padding: 10, textAlign: 'left' }}>Email</th>
              <th style={{ padding: 10, textAlign: 'left' }}>Role</th>
              <th style={{ padding: 10, textAlign: 'left' }}>Joined</th>
              {isAdmin && <th style={{ padding: 10, textAlign: 'left' }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {members.map(member => (
              <tr key={member.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: 10 }}>{member.email}</td>
                <td style={{ padding: 10 }}>
                  {isAdmin && member.role !== 'admin' ? (
                    <select
                      value={member.role}
                      onChange={(e) => handleChangeRole(member, e.target.value)}
                      style={{ padding: 5, borderRadius: 4 }}
                    >
                      <option value="staff">Staff</option>
                      <option value="manager">Manager</option>
                      <option value="admin">Admin</option>
                    </select>
                  ) : (
                    <span style={{
                      padding: '3px 8px',
                      borderRadius: 4,
                      background: member.role === 'admin' ? '#2d5f3f' : '#6c757d',
                      color: 'white',
                      fontSize: 12
                    }}>
                      {member.role}
                    </span>
                  )}
                </td>
                <td style={{ padding: 10, color: '#666', fontSize: 13 }}>
                  {new Date(member.joinedAt).toLocaleDateString()}
                </td>
                {isAdmin && (
                  <td style={{ padding: 10 }}>
                    {member.role !== 'admin' && (
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => handleRemoveMember(member)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Invite User */}
      {isAdmin && (
        <div style={{ background: 'white', padding: 20, borderRadius: 8 }}>
          <h3 style={{ marginBottom: 15 }}>Invite Team Member</h3>
          
          <form onSubmit={handleInvite} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="Email address"
              className="form-input"
              style={{ flex: 1, minWidth: 200 }}
              required
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              className="form-input"
            >
              <option value="staff">Staff</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </select>
            <button type="submit" className="btn btn-primary" disabled={inviting}>
              {inviting ? 'Sending...' : '📧 Send Invite'}
            </button>
          </form>
          
          <p style={{ marginTop: 10, fontSize: 13, color: '#666' }}>
            The invited user will receive an email with instructions to join your organization.
          </p>
        </div>
      )}

      {/* Danger Zone */}
      {isAdmin && (
        <div style={{ background: 'white', padding: 20, borderRadius: 8, marginTop: 20, border: '1px solid #dc3545' }}>
          <h3 style={{ marginBottom: 15, color: '#dc3545' }}>⚠️ Danger Zone</h3>
          <p style={{ marginBottom: 15, color: '#666' }}>
            These actions are irreversible. Please be certain.
          </p>
          <button 
            className="btn btn-danger"
            onClick={() => alert('This would delete all organization data. Feature coming soon.')}
          >
            Delete Organization
          </button>
        </div>
      )}
    </div>
  );
}
