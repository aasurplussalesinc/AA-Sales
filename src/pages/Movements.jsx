import { useState, useEffect } from 'react';
import { OrgDB as DB } from '../orgDb';

export default function Movements() {
  const [movements, setMovements] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadMovements();
  }, []);

  const loadMovements = async () => {
    const data = await DB.getMovements();
    setMovements(data);
    setLoading(false);
  };

  const formatDate = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  if (loading) {
    return <div className="page-content"><div className="loading">Loading...</div></div>;
  }

  return (
    <div className="page-content">
      <div style={{background: 'var(--bg-surface)', padding: 20, borderRadius: 8}}>
        <h2 style={{marginBottom: 15}}>Movement History</h2>
        <div className="data-table">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>User</th>
                <th>Item</th>
                <th>From</th>
                <th>To</th>
                <th>Quantity</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {movements.map(mov => (
                <tr key={mov.id}>
                  <td>{formatDate(mov.timestamp)}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {mov.userEmail || 'Unknown'}
                  </td>
                  <td>{mov.itemName}</td>
                  <td>{mov.fromLocation || '-'}</td>
                  <td>{mov.toLocation || '-'}</td>
                  <td>{mov.quantity}</td>
                  <td>
                    <span style={{
                      padding: '4px 8px',
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 'bold',
                      background: mov.type === 'ADD' ? '#4CAF50' : 
                                 mov.type === 'PICK' ? '#f44336' : '#2196F3',
                      color: 'var(--text-on-dark)'
                    }}>
                      {mov.type}
                    </span>
                  </td>
                </tr>
              ))}
              {movements.length === 0 && (
                <tr>
                  <td colSpan="7">
                    <div className="empty-state">
                      <p>No movements recorded yet</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
