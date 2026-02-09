import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { OrgDB as DB } from '../orgDb';
import { COMPANY_LOGO } from '../companyLogo';
import { useAuth } from '../OrgAuthContext';

export default function Customers() {
  const { userRole } = useAuth();
  const isAdmin = userRole === 'admin';
  const isManager = userRole === 'manager';
  const canEdit = isAdmin || isManager;
  const [searchParams, setSearchParams] = useSearchParams();
  
  const [customers, setCustomers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [customerOrders, setCustomerOrders] = useState([]);
  const [customerStats, setCustomerStats] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('company'); // company, customerName, location
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [editingOrder, setEditingOrder] = useState(null);
  const fileInputRef = useRef(null);

  // Edit form
  const [editForm, setEditForm] = useState({
    company: '',
    customerName: '',
    addressShort: '',
    email: '',
    phone: '',
    phoneType: 'Cell',
    phone2: '',
    phone2Type: 'Office',
    address: '',
    city: '',
    state: '',
    zipCode: '',
    country: '',
    notes: ''
  });

  const phoneTypeOptions = ['Cell', 'Office', 'Store', 'Home', 'Fax'];

  useEffect(() => {
    loadData();
  }, []);

  // Auto-open customer from URL param
  useEffect(() => {
    const customerId = searchParams.get('customer');
    if (customerId && customers.length > 0 && !selectedCustomer) {
      const customer = customers.find(c => c.id === customerId);
      if (customer) {
        selectCustomer(customer);
      }
    }
  }, [customers, searchParams]);

  const loadData = async () => {
    setLoading(true);
    const [customersData, ordersData, itemsData] = await Promise.all([
      DB.getCustomers(),
      DB.getPurchaseOrders(),
      DB.getItems()
    ]);
    setCustomers(customersData);
    setOrders(ordersData);
    setItems(itemsData);
    setLoading(false);
  };

  const selectCustomer = async (customer) => {
    setSelectedCustomer(customer);
    setSearchParams({ customer: customer.id }); // Update URL
    setEditForm({
      company: customer.company || '',
      customerName: customer.customerName || '',
      addressShort: customer.addressShort || '',
      email: customer.email || '',
      phone: customer.phone || '',
      phoneType: customer.phoneType || 'Cell',
      phone2: customer.phone2 || '',
      phone2Type: customer.phone2Type || 'Office',
      address: customer.address || '',
      city: customer.city || '',
      state: customer.state || '',
      zipCode: customer.zipCode || '',
      country: customer.country || '',
      notes: customer.notes || ''
    });
    
    // Get customer's orders
    const custOrders = orders.filter(o => o.customerId === customer.id);
    setCustomerOrders(custOrders);
    
    // Calculate stats
    const paidAmount = custOrders
      .filter(o => o.status === 'paid')
      .reduce((sum, o) => sum + (o.total || 0), 0);
    const unpaidAmount = custOrders
      .filter(o => o.status !== 'paid')
      .reduce((sum, o) => sum + (o.total || 0), 0);
    setCustomerStats({ paidAmount, unpaidAmount });
  };

  const saveCustomer = async () => {
    if (!editForm.company && !editForm.customerName) {
      alert('Enter company or customer name');
      return;
    }

    let formToSave = { ...editForm };
    
    // Auto-lookup country if missing but zip code exists
    if (!formToSave.country && formToSave.zipCode) {
      const country = await lookupCountryFromZip(formToSave.zipCode);
      if (country) {
        formToSave.country = country;
        setEditForm(formToSave); // Update form to show the detected country
      }
    }

    if (selectedCustomer) {
      await DB.updateCustomer(selectedCustomer.id, formToSave);
    } else {
      await DB.createCustomer(formToSave);
    }
    
    setShowCreate(false);
    setSelectedCustomer(null);
    loadData();
  };

  const closeDetail = () => {
    setSelectedCustomer(null);
    setCustomerOrders([]);
    setCustomerStats(null);
    setSearchParams({}); // Clear URL param
  };

  const deleteCustomer = async () => {
    if (customerOrders.length > 0) {
      alert(`Cannot delete customer with ${customerOrders.length} purchase orders. Delete or reassign their orders first.`);
      return;
    }
    
    if (!confirm(`Are you sure you want to delete ${selectedCustomer.company || selectedCustomer.customerName}? This cannot be undone.`)) {
      return;
    }
    
    try {
      // Delete from Firestore
      const { deleteDoc, doc } = await import('firebase/firestore');
      const { db } = await import('../firebase');
      await deleteDoc(doc(db, 'customers', selectedCustomer.id));
      await DB.logActivity('CUSTOMER_DELETED', { 
        customerId: selectedCustomer.id,
        customerName: selectedCustomer.company || selectedCustomer.customerName 
      });
      
      closeDetail();
      loadData();
    } catch (error) {
      alert('Delete failed: ' + error.message);
    }
  };

  // Lookup country from zip code using Zippopotam.us API
  const lookupCountryFromZip = async (zipCode) => {
    if (!zipCode || zipCode.length < 3) return null;
    
    // Try common country codes in order of likelihood
    const countryCodes = ['us', 'ca', 'gb', 'au', 'de', 'fr', 'nl', 'be', 'it', 'es', 'mx', 'br', 'jp', 'kr', 'nz'];
    
    for (const countryCode of countryCodes) {
      try {
        const response = await fetch(`https://api.zippopotam.us/${countryCode}/${encodeURIComponent(zipCode)}`);
        if (response.ok) {
          const data = await response.json();
          if (data.country) {
            return data.country;
          }
        }
      } catch (e) {
        // Continue to next country
      }
    }
    return null;
  };

  // Batch lookup countries for multiple customers (with rate limiting)
  const batchLookupCountries = async (customers) => {
    const results = [...customers];
    let lookupCount = 0;
    
    for (let i = 0; i < results.length; i++) {
      const customer = results[i];
      if (!customer.country && customer.zipCode) {
        // Rate limit: small delay between requests
        if (lookupCount > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        const country = await lookupCountryFromZip(customer.zipCode);
        if (country) {
          results[i] = { ...customer, country };
          lookupCount++;
        }
      }
    }
    
    return { customers: results, lookupsPerformed: lookupCount };
  };

  // Import CSV
  const handleImportCSV = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setImporting(true);
    const reader = new FileReader();

    reader.onload = async (e) => {
      try {
        const text = e.target.result;
        const lines = text.split('\n').filter(line => line.trim());

        if (lines.length < 2) {
          alert('CSV file is empty');
          setImporting(false);
          return;
        }

        const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));

        // Map headers
        const headerMap = {
          'company': ['company', 'company name', 'companyname'],
          'customerName': ['customer name', 'customername', 'name', 'contact', 'contact name'],
          'addressShort': ['address short', 'addressshort', 'short address'],
          'email': ['email', 'e-mail', 'email address'],
          'phone': ['phone', 'phone number', 'tel', 'telephone'],
          'address': ['address', 'street', 'street address'],
          'city': ['city'],
          'state': ['state', 'province', 'state/province'],
          'zipCode': ['zip code', 'zipcode', 'zip', 'postal code', 'postal', 'postcode'],
          'country': ['country', 'country/region', 'nation']
        };

        const columnIndices = {};
        for (const [field, variations] of Object.entries(headerMap)) {
          const index = headers.findIndex(h => variations.includes(h));
          if (index !== -1) columnIndices[field] = index;
        }

        const newCustomers = [];
        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          if (values.length === 0) continue;

          const customer = {
            company: columnIndices.company !== undefined ? values[columnIndices.company]?.trim() : '',
            customerName: columnIndices.customerName !== undefined ? values[columnIndices.customerName]?.trim() : '',
            addressShort: columnIndices.addressShort !== undefined ? values[columnIndices.addressShort]?.trim() : '',
            email: columnIndices.email !== undefined ? values[columnIndices.email]?.trim() : '',
            phone: columnIndices.phone !== undefined ? values[columnIndices.phone]?.trim() : '',
            address: columnIndices.address !== undefined ? values[columnIndices.address]?.trim() : '',
            city: columnIndices.city !== undefined ? values[columnIndices.city]?.trim() : '',
            state: columnIndices.state !== undefined ? values[columnIndices.state]?.trim() : '',
            zipCode: columnIndices.zipCode !== undefined ? values[columnIndices.zipCode]?.trim() : '',
            country: columnIndices.country !== undefined ? values[columnIndices.country]?.trim() : ''
          };

          if (customer.company || customer.customerName) {
            newCustomers.push(customer);
          }
        }

        if (newCustomers.length === 0) {
          alert('No valid customers found in CSV');
          setImporting(false);
          return;
        }

        // Auto-lookup countries for customers missing country but having zip code
        const customersNeedingLookup = newCustomers.filter(c => !c.country && c.zipCode);
        let countryLookupMsg = '';
        
        if (customersNeedingLookup.length > 0) {
          const { customers: enrichedCustomers, lookupsPerformed } = await batchLookupCountries(newCustomers);
          newCustomers.splice(0, newCustomers.length, ...enrichedCustomers);
          if (lookupsPerformed > 0) {
            countryLookupMsg = `\n✓ ${lookupsPerformed} countries auto-detected from zip codes`;
          }
        }

        const result = await DB.importCustomers(newCustomers);
        alert(`Import complete!\n\n✓ ${result.added} new customers added\n✓ ${result.updated} existing customers updated${countryLookupMsg}\n○ ${result.skipped} rows skipped (no company name)`);
        loadData();
      } catch (error) {
        alert('Import failed: ' + error.message);
      } finally {
        setImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };

    reader.onerror = () => {
      alert('Failed to read file');
      setImporting(false);
    };

    reader.readAsText(file);
  };

  const parseCSVLine = (line) => {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  };

  // Export CSV with stats
  const exportToCSV = async () => {
    const headers = ['Company', 'Customer Name', 'Address Short', 'Email', 'Phone', 'Address', 'City', 'State', 'Zip Code', 'Country', 'Unpaid Invoice Amount', 'Paid Invoice Amount'];

    const rows = await Promise.all(customers.map(async (c) => {
      const custOrders = orders.filter(o => o.customerId === c.id);
      const paidAmount = custOrders.filter(o => o.status === 'paid').reduce((sum, o) => sum + (o.total || 0), 0);
      const unpaidAmount = custOrders.filter(o => o.status !== 'paid').reduce((sum, o) => sum + (o.total || 0), 0);

      return [
        c.company || '',
        c.customerName || '',
        c.addressShort || '',
        c.email || '',
        c.phone || '',
        c.address || '',
        c.city || '',
        c.state || '',
        c.zipCode || '',
        c.country || '',
        unpaidAmount.toFixed(2),
        paidAmount.toFixed(2)
      ];
    }));

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const filteredCustomers = customers
    .filter(c =>
      !search ||
      c.company?.toLowerCase().includes(search.toLowerCase()) ||
      c.customerName?.toLowerCase().includes(search.toLowerCase()) ||
      c.email?.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      switch (sortBy) {
        case 'customerName':
          return (a.customerName || '').localeCompare(b.customerName || '');
        case 'location':
          // Sort by state, then city
          const aLocation = `${a.state || ''} ${a.city || ''}`.trim();
          const bLocation = `${b.state || ''} ${b.city || ''}`.trim();
          return aLocation.localeCompare(bLocation);
        case 'company':
        default:
          return (a.company || '').localeCompare(b.company || '');
      }
    });

  const getStatusColor = (status) => {
    const colors = {
      draft: '#9e9e9e',
      confirmed: '#2196F3',
      picking: '#ff9800',
      shipped: '#9c27b0',
      paid: '#4CAF50'
    };
    return colors[status] || '#9e9e9e';
  };

  const formatDate = (timestamp) => new Date(timestamp).toLocaleDateString();
  const formatCurrency = (val) => `$${(val || 0).toFixed(2)}`;

  const getDaysPastDue = (order) => {
    if (order.status === 'paid') return '-';
    if (!order.dueDate) return '-';
    const due = new Date(order.dueDate);
    const now = new Date();
    const diff = Math.floor((now - due) / (1000 * 60 * 60 * 24));
    return diff > 0 ? diff : '-';
  };

  const printPO = (order) => {
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <html>
        <head>
          <title>Purchase Order - ${order.poNumber}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 30px; border-bottom: 3px solid #4a5d23; padding-bottom: 20px; }
            .company-info { display: flex; flex-direction: column; align-items: flex-start; }
            .company-logo { max-width: 250px; height: auto; margin-bottom: 5px; }
            .company-location { font-size: 14px; color: #333; margin-top: 5px; }
            .po-info { text-align: right; }
            .po-number { font-size: 24px; font-weight: bold; color: #4a5d23; }
            .po-meta { font-size: 14px; color: #666; margin-top: 5px; }
            .customer-info { margin-bottom: 30px; padding: 15px; background: #f5f5f5; border-radius: 8px; border-left: 4px solid #4a5d23; }
            .customer-info h3 { margin: 0 0 10px 0; font-size: 14px; color: #666; text-transform: uppercase; }
            .customer-info p { margin: 3px 0; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
            th { background: #4a5d23; color: white; padding: 12px; text-align: left; }
            td { padding: 10px; border-bottom: 1px solid #ddd; }
            .text-right { text-align: right; }
            .totals { width: 300px; margin-left: auto; }
            .totals td { padding: 8px; }
            .totals .total-row { font-weight: bold; font-size: 18px; background: #f0f0f0; }
            .notes { margin-top: 30px; padding: 15px; background: #fffde7; border-radius: 8px; }
            .footer { margin-top: 40px; text-align: center; color: #666; font-size: 12px; border-top: 1px solid #ddd; padding-top: 20px; }
            @media print { body { padding: 20px; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="company-info">
              <img src="${COMPANY_LOGO}" alt="AA Surplus Sales Inc." class="company-logo" />
              <div class="company-location">Ronkonkoma, NY • 716-496-2451</div>
            </div>
            <div class="po-info">
              <div class="po-number">${order.poNumber}</div>
              <div class="po-meta">Date: ${new Date(order.createdAt).toLocaleDateString()}</div>
              <div class="po-meta">Status: ${order.status?.toUpperCase()}</div>
            </div>
          </div>

          <div class="customer-info">
            <h3>Bill To:</h3>
            <p><strong>${order.customerName}</strong></p>
            ${order.customerAddress ? `<p>${order.customerAddress}</p>` : ''}
            ${order.customerPhone ? `<p>Phone: ${order.customerPhone}</p>` : ''}
            ${order.customerEmail ? `<p>Email: ${order.customerEmail}</p>` : ''}
          </div>

          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Description</th>
                <th class="text-right">Qty</th>
                <th class="text-right">Unit Price</th>
                <th class="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              ${order.items?.map(item => `
                <tr>
                  <td>${item.partNumber || '-'}</td>
                  <td>${item.itemName}</td>
                  <td class="text-right">${item.quantity}</td>
                  <td class="text-right">$${(item.unitPrice || 0).toFixed(2)}</td>
                  <td class="text-right">$${(item.lineTotal || 0).toFixed(2)}</td>
                </tr>
              `).join('') || ''}
            </tbody>
          </table>

          <table class="totals">
            <tr>
              <td>Subtotal:</td>
              <td class="text-right">$${(order.subtotal || 0).toFixed(2)}</td>
            </tr>
            ${order.tax ? `<tr><td>Tax:</td><td class="text-right">$${order.tax.toFixed(2)}</td></tr>` : ''}
            ${order.shipping ? `<tr><td>Shipping:</td><td class="text-right">$${order.shipping.toFixed(2)}</td></tr>` : ''}
            <tr class="total-row">
              <td>TOTAL:</td>
              <td class="text-right">$${(order.total || 0).toFixed(2)}</td>
            </tr>
          </table>

          ${order.notes ? `<div class="notes"><strong>Notes:</strong> ${order.notes}</div>` : ''}

          <div class="footer">
            <p>Thank you for your business!</p>
            <p>AA Surplus Sales Inc. • Genuine U.S. Military Goods • Est. 1973</p>
          </div>
        </body>
      </html>
    `);
    printWindow.document.close();
    setTimeout(() => printWindow.print(), 300);
  };

  if (loading) {
    return <div className="page-content"><div className="loading">Loading...</div></div>;
  }

  // Customer Detail View
  if (selectedCustomer) {
    return (
      <div className="page-content">
        <button 
          className="btn" 
          onClick={closeDetail}
          style={{ marginBottom: 20, background: '#6c757d', color: 'white' }}
        >
          ← Back to Customers
        </button>

        <div style={{ display: 'grid', gridTemplateColumns: '350px 1fr', gap: 20 }}>
          {/* Sidebar - Customer Info */}
          <div style={{ background: 'white', padding: 20, borderRadius: 8, height: 'fit-content' }}>
            <h3 style={{ marginBottom: 20 }}>Customer Information</h3>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Company</label>
              <input
                type="text"
                className="form-input"
                value={editForm.company}
                onChange={e => setEditForm({ ...editForm, company: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Customer Name</label>
              <input
                type="text"
                className="form-input"
                value={editForm.customerName}
                onChange={e => setEditForm({ ...editForm, customerName: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Address Short</label>
              <input
                type="text"
                className="form-input"
                value={editForm.addressShort}
                onChange={e => setEditForm({ ...editForm, addressShort: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Email</label>
              <input
                type="email"
                className="form-input"
                value={editForm.email}
                onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Phone 1</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  value={editForm.phoneType}
                  onChange={e => setEditForm({ ...editForm, phoneType: e.target.value })}
                  style={{ padding: '8px 10px', border: '1px solid #ddd', borderRadius: 4, minWidth: 90 }}
                >
                  {phoneTypeOptions.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Phone number..."
                  value={editForm.phone}
                  onChange={e => setEditForm({ ...editForm, phone: e.target.value })}
                  style={{ flex: 1 }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Phone 2</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  value={editForm.phone2Type}
                  onChange={e => setEditForm({ ...editForm, phone2Type: e.target.value })}
                  style={{ padding: '8px 10px', border: '1px solid #ddd', borderRadius: 4, minWidth: 90 }}
                >
                  {phoneTypeOptions.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Phone number..."
                  value={editForm.phone2}
                  onChange={e => setEditForm({ ...editForm, phone2: e.target.value })}
                  style={{ flex: 1 }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Address</label>
              <input
                type="text"
                className="form-input"
                value={editForm.address}
                onChange={e => setEditForm({ ...editForm, address: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 100px', gap: 10, marginBottom: 15 }}>
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>City</label>
                <input
                  type="text"
                  className="form-input"
                  value={editForm.city}
                  onChange={e => setEditForm({ ...editForm, city: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>State</label>
                <input
                  type="text"
                  className="form-input"
                  value={editForm.state}
                  onChange={e => setEditForm({ ...editForm, state: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Zip</label>
                <input
                  type="text"
                  className="form-input"
                  value={editForm.zipCode}
                  onChange={e => setEditForm({ ...editForm, zipCode: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Country</label>
              <input
                type="text"
                className="form-input"
                placeholder="USA, Canada, etc."
                value={editForm.country}
                onChange={e => setEditForm({ ...editForm, country: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Notes</label>
              <textarea
                className="form-input"
                placeholder="Customer notes..."
                value={editForm.notes}
                onChange={e => setEditForm({ ...editForm, notes: e.target.value })}
                style={{ width: '100%', minHeight: 80, resize: 'vertical' }}
              />
            </div>

            <button className="btn btn-primary" onClick={saveCustomer} style={{ width: '100%' }}>
              💾 Save Changes
            </button>

            {canEdit && (
              <button 
                className="btn" 
                onClick={deleteCustomer} 
                style={{ width: '100%', marginTop: 10, background: '#dc3545', color: 'white' }}
              >
                🗑️ Delete Customer
              </button>
            )}

            {/* Stats */}
            {customerStats && (
              <div style={{ marginTop: 20, padding: 15, background: '#f9f9f9', borderRadius: 8 }}>
                <h4 style={{ marginBottom: 10 }}>Account Summary</h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                  <span>Unpaid:</span>
                  <span style={{ color: customerStats.unpaidAmount > 0 ? '#f44336' : '#666', fontWeight: 600 }}>
                    {formatCurrency(customerStats.unpaidAmount)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Paid:</span>
                  <span style={{ color: '#4CAF50', fontWeight: 600 }}>
                    {formatCurrency(customerStats.paidAmount)}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Main Area - Purchase Orders */}
          <div style={{ background: 'white', padding: 20, borderRadius: 8 }}>
            <h3 style={{ marginBottom: 20 }}>Purchase Orders ({customerOrders.length})</h3>

            <div className="data-table">
              <table>
                <thead>
                  <tr>
                    <th>PO Number</th>
                    <th>Date Submitted</th>
                    <th>Grand Total</th>
                    <th>Status</th>
                    <th>Due Date</th>
                    <th>Days Past Due</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {customerOrders.map(order => {
                    const daysPastDue = getDaysPastDue(order);
                    return (
                      <tr key={order.id}>
                        <td><strong>{order.poNumber}</strong></td>
                        <td>{formatDate(order.createdAt)}</td>
                        <td style={{ fontWeight: 600 }}>{formatCurrency(order.total)}</td>
                        <td>
                          <span style={{
                            padding: '4px 10px', borderRadius: 4, fontSize: 12, fontWeight: 600,
                            background: getStatusColor(order.status), color: 'white'
                          }}>
                            {order.status === 'paid' ? 'PAID' : 'UNPAID'}
                          </span>
                        </td>
                        <td>{order.dueDate ? formatDate(order.dueDate) : '-'}</td>
                        <td style={{ 
                          color: typeof daysPastDue === 'number' && daysPastDue > 0 ? '#f44336' : '#666',
                          fontWeight: typeof daysPastDue === 'number' && daysPastDue > 0 ? 600 : 400
                        }}>
                          {daysPastDue}
                        </td>
                        <td>
                          <button 
                            className="btn btn-primary btn-sm"
                            onClick={() => setSelectedOrder(order)}
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {customerOrders.length === 0 && (
                    <tr>
                      <td colSpan="7">
                        <div className="empty-state">
                          <p>No purchase orders for this customer</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* PO Detail Modal - inside customer detail view */}
        {selectedOrder && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', zIndex: 1001, padding: 20
          }}>
            <div style={{
              background: 'white', borderRadius: 12, padding: 30,
              maxWidth: 700, width: '100%', maxHeight: '90vh', overflow: 'auto'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div>
                  <h3 style={{ margin: 0 }}>{selectedOrder.poNumber}</h3>
                  <p style={{ color: '#666', margin: '5px 0 0 0' }}>{selectedOrder.customerName}</p>
                </div>
                <span style={{
                  padding: '6px 16px', borderRadius: 20, fontSize: 14, fontWeight: 600,
                  background: getStatusColor(selectedOrder.status), color: 'white'
                }}>
                  {selectedOrder.status?.toUpperCase()}
                </span>
              </div>

              {/* Customer Info */}
              <div style={{ background: '#f9f9f9', padding: 15, borderRadius: 8, marginBottom: 20 }}>
                <p style={{ margin: '3px 0' }}><strong>Customer:</strong> {selectedOrder.customerName}</p>
                {selectedOrder.customerPhone && <p style={{ margin: '3px 0' }}>Phone: {selectedOrder.customerPhone}</p>}
                {selectedOrder.customerEmail && <p style={{ margin: '3px 0' }}>Email: {selectedOrder.customerEmail}</p>}
                {selectedOrder.customerAddress && <p style={{ margin: '3px 0' }}>Address: {selectedOrder.customerAddress}</p>}
              </div>

              {/* Items */}
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
                <thead>
                  <tr style={{ background: '#f5f5f5' }}>
                    <th style={{ padding: 10, textAlign: 'left' }}>Item</th>
                    <th style={{ padding: 10, textAlign: 'right' }}>Qty</th>
                    <th style={{ padding: 10, textAlign: 'right' }}>Unit Price</th>
                    <th style={{ padding: 10, textAlign: 'right' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedOrder.items?.map((item, idx) => (
                    <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: 10 }}>
                        <strong>{item.itemName}</strong>
                        <div style={{ fontSize: 12, color: '#666' }}>{item.partNumber}</div>
                      </td>
                      <td style={{ padding: 10, textAlign: 'right' }}>{item.quantity}</td>
                      <td style={{ padding: 10, textAlign: 'right' }}>{formatCurrency(item.unitPrice)}</td>
                      <td style={{ padding: 10, textAlign: 'right' }}>{formatCurrency(item.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Totals */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
                <div style={{ width: 250 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
                    <span>Subtotal:</span>
                    <span>{formatCurrency(selectedOrder.subtotal)}</span>
                  </div>
                  {selectedOrder.tax > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
                      <span>Tax:</span>
                      <span>{formatCurrency(selectedOrder.tax)}</span>
                    </div>
                  )}
                  {selectedOrder.shipping > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
                      <span>Shipping:</span>
                      <span>{formatCurrency(selectedOrder.shipping)}</span>
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: '2px solid #333', fontWeight: 'bold', fontSize: 18 }}>
                    <span>Total:</span>
                    <span>{formatCurrency(selectedOrder.total)}</span>
                  </div>
                </div>
              </div>

              {selectedOrder.notes && (
                <div style={{ background: '#fffde7', padding: 15, borderRadius: 8, marginBottom: 20 }}>
                  <strong>Notes:</strong> {selectedOrder.notes}
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button 
                  className="btn"
                  onClick={() => {
                    setEditingOrder({...selectedOrder});
                    setSelectedOrder(null);
                  }}
                  style={{ background: '#ff9800', color: 'white' }}
                >
                  ✏️ Edit
                </button>
                <button 
                  className="btn btn-primary"
                  onClick={() => printPO(selectedOrder)}
                >
                  🖨️ Print
                </button>
                <button 
                  className="btn" 
                  onClick={() => setSelectedOrder(null)} 
                  style={{ background: '#6c757d', color: 'white', marginLeft: 'auto' }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Edit PO Modal */}
        {editingOrder && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', zIndex: 1002, padding: 20
          }}>
            <div style={{
              background: 'white', borderRadius: 12, padding: 30,
              maxWidth: 800, width: '100%', maxHeight: '90vh', overflow: 'auto'
            }}>
              <h3 style={{ marginBottom: 20 }}>Edit Purchase Order - {editingOrder.poNumber}</h3>

              {/* Customer Info */}
              <div style={{ padding: 15, background: '#f9f9f9', borderRadius: 8, marginBottom: 20 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 15 }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Customer Name *</label>
                    <input
                      type="text"
                      className="form-input"
                      value={editingOrder.customerName || ''}
                      onChange={e => setEditingOrder({ ...editingOrder, customerName: e.target.value })}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Phone</label>
                    <input
                      type="text"
                      className="form-input"
                      value={editingOrder.customerPhone || ''}
                      onChange={e => setEditingOrder({ ...editingOrder, customerPhone: e.target.value })}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Email</label>
                    <input
                      type="email"
                      className="form-input"
                      value={editingOrder.customerEmail || ''}
                      onChange={e => setEditingOrder({ ...editingOrder, customerEmail: e.target.value })}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Due Date</label>
                    <input
                      type="date"
                      className="form-input"
                      value={editingOrder.dueDate || ''}
                      onChange={e => setEditingOrder({ ...editingOrder, dueDate: e.target.value })}
                      style={{ width: '100%' }}
                    />
                  </div>
                </div>
                <div style={{ marginTop: 15 }}>
                  <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Address</label>
                  <input
                    type="text"
                    className="form-input"
                    value={editingOrder.customerAddress || ''}
                    onChange={e => setEditingOrder({ ...editingOrder, customerAddress: e.target.value })}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>

              {/* Items */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <label style={{ fontWeight: 600 }}>Line Items</label>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      const newItem = {
                        itemId: `manual-${Date.now()}`,
                        itemName: '',
                        partNumber: '',
                        quantity: 1,
                        unitPrice: 0,
                        lineTotal: 0
                      };
                      setEditingOrder({
                        ...editingOrder,
                        items: [...(editingOrder.items || []), newItem]
                      });
                    }}
                    style={{ background: '#4a5d23', color: 'white' }}
                  >
                    + Add Item
                  </button>
                </div>

                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f5f5f5' }}>
                      <th style={{ padding: 10, textAlign: 'left' }}>Item Name</th>
                      <th style={{ padding: 10, textAlign: 'left', width: 100 }}>Part #</th>
                      <th style={{ padding: 10, textAlign: 'center', width: 80 }}>Qty</th>
                      <th style={{ padding: 10, textAlign: 'right', width: 100 }}>Price</th>
                      <th style={{ padding: 10, textAlign: 'right', width: 100 }}>Total</th>
                      <th style={{ padding: 10, width: 50 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(editingOrder.items || []).map((item, idx) => (
                      <tr key={item.itemId || idx} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: 8 }}>
                          <input
                            type="text"
                            className="form-input"
                            value={item.itemName || ''}
                            onChange={e => {
                              const updatedItems = [...editingOrder.items];
                              updatedItems[idx] = { ...item, itemName: e.target.value };
                              setEditingOrder({ ...editingOrder, items: updatedItems });
                            }}
                            style={{ width: '100%' }}
                          />
                        </td>
                        <td style={{ padding: 8 }}>
                          <input
                            type="text"
                            className="form-input"
                            value={item.partNumber || ''}
                            onChange={e => {
                              const updatedItems = [...editingOrder.items];
                              updatedItems[idx] = { ...item, partNumber: e.target.value };
                              setEditingOrder({ ...editingOrder, items: updatedItems });
                            }}
                            style={{ width: '100%' }}
                          />
                        </td>
                        <td style={{ padding: 8 }}>
                          <input
                            type="number"
                            className="form-input"
                            value={item.quantity || ''}
                            min="1"
                            placeholder="1"
                            onChange={e => {
                              const qty = e.target.value === '' ? '' : parseInt(e.target.value) || 1;
                              const updatedItems = [...editingOrder.items];
                              updatedItems[idx] = { 
                                ...item, 
                                quantity: qty,
                                lineTotal: (parseInt(qty) || 0) * (item.unitPrice || 0)
                              };
                              const subtotal = updatedItems.reduce((sum, i) => sum + (i.lineTotal || 0), 0);
                              setEditingOrder({ 
                                ...editingOrder, 
                                items: updatedItems,
                                subtotal,
                                total: subtotal + (editingOrder.tax || 0) + (editingOrder.shipping || 0)
                              });
                            }}
                            style={{ width: '100%', textAlign: 'center' }}
                          />
                        </td>
                        <td style={{ padding: 8 }}>
                          <input
                            type="number"
                            className="form-input"
                            value={item.unitPrice || ''}
                            step="0.01"
                            min="0"
                            placeholder="0.00"
                            onChange={e => {
                              const price = e.target.value === '' ? '' : parseFloat(e.target.value) || 0;
                              const updatedItems = [...editingOrder.items];
                              updatedItems[idx] = { 
                                ...item, 
                                unitPrice: price,
                                lineTotal: (item.quantity || 1) * (parseFloat(price) || 0)
                              };
                              const subtotal = updatedItems.reduce((sum, i) => sum + (i.lineTotal || 0), 0);
                              setEditingOrder({ 
                                ...editingOrder, 
                                items: updatedItems,
                                subtotal,
                                total: subtotal + (editingOrder.tax || 0) + (editingOrder.shipping || 0)
                              });
                            }}
                            style={{ width: '100%', textAlign: 'right' }}
                          />
                        </td>
                        <td style={{ padding: 8, textAlign: 'right', fontWeight: 600 }}>
                          ${(item.lineTotal || 0).toFixed(2)}
                        </td>
                        <td style={{ padding: 8 }}>
                          <button
                            onClick={() => {
                              const updatedItems = editingOrder.items.filter((_, i) => i !== idx);
                              const subtotal = updatedItems.reduce((sum, i) => sum + (i.lineTotal || 0), 0);
                              setEditingOrder({
                                ...editingOrder,
                                items: updatedItems,
                                subtotal,
                                total: subtotal + (editingOrder.tax || 0) + (editingOrder.shipping || 0)
                              });
                            }}
                            style={{ background: '#f44336', color: 'white', border: 'none', borderRadius: 4, padding: '5px 10px', cursor: 'pointer' }}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Totals */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 15 }}>
                  <div style={{ width: 250 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
                      <span>Subtotal:</span>
                      <span>${(editingOrder.subtotal || 0).toFixed(2)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', alignItems: 'center' }}>
                      <span>Tax:</span>
                      <input
                        type="number"
                        value={editingOrder.tax || 0}
                        onChange={e => {
                          const tax = parseFloat(e.target.value) || 0;
                          setEditingOrder({
                            ...editingOrder,
                            tax,
                            total: (editingOrder.subtotal || 0) + tax + (editingOrder.shipping || 0)
                          });
                        }}
                        style={{ width: 80, padding: 5, textAlign: 'right' }}
                        step="0.01"
                        min="0"
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', alignItems: 'center' }}>
                      <span>Shipping:</span>
                      <input
                        type="number"
                        value={editingOrder.shipping || 0}
                        onChange={e => {
                          const shipping = parseFloat(e.target.value) || 0;
                          setEditingOrder({
                            ...editingOrder,
                            shipping,
                            total: (editingOrder.subtotal || 0) + (editingOrder.tax || 0) + shipping
                          });
                        }}
                        style={{ width: 80, padding: 5, textAlign: 'right' }}
                        step="0.01"
                        min="0"
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: '2px solid #333', fontWeight: 'bold', fontSize: 18 }}>
                      <span>Total:</span>
                      <span>${(editingOrder.total || 0).toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Notes</label>
                <textarea
                  className="form-input"
                  value={editingOrder.notes || ''}
                  onChange={e => setEditingOrder({ ...editingOrder, notes: e.target.value })}
                  style={{ width: '100%', minHeight: 60 }}
                />
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 10 }}>
                <button 
                  className="btn btn-primary"
                  onClick={async () => {
                    if (!editingOrder.customerName) {
                      alert('Customer name is required');
                      return;
                    }
                    await DB.updatePurchaseOrder(editingOrder.id, editingOrder);
                    setEditingOrder(null);
                    loadData();
                  }}
                  style={{ flex: 1 }}
                >
                  Save Changes
                </button>
                <button 
                  className="btn" 
                  onClick={() => setEditingOrder(null)} 
                  style={{ flex: 1, background: '#6c757d', color: 'white' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Customer List View
  return (
    <div className="page-content">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <h2>Customers</h2>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImportCSV}
            accept=".csv"
            style={{ display: 'none' }}
          />
          {canEdit && (
            <button
              className="btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              style={{ background: '#17a2b8', color: 'white' }}
            >
              {importing ? '⏳ Importing...' : '📤 Import CSV'}
            </button>
          )}
          <button className="btn" onClick={exportToCSV} style={{ background: '#6c757d', color: 'white' }}>
            📥 Export CSV
          </button>
          {canEdit && (
            <button className="btn btn-primary" onClick={() => {
              setEditForm({
                company: '', customerName: '', addressShort: '', email: '',
                phone: '', phoneType: 'Cell', phone2: '', phone2Type: 'Office',
                address: '', city: '', state: '', zipCode: '', country: '', notes: ''
              });
              setShowCreate(true);
            }}>
              + New Customer
            </button>
          )}
        </div>
      </div>

      {/* Search and Sort */}
      <div style={{ marginBottom: 20, display: 'flex', gap: 15, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          className="form-input"
          placeholder="Search customers..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth: 400, width: '100%', flex: 1 }}
        />
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={{ fontWeight: 500, fontSize: 14 }}>Sort by:</label>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid #ddd',
              fontSize: 14
            }}
          >
            <option value="company">Company (A-Z)</option>
            <option value="customerName">Customer Name (A-Z)</option>
            <option value="location">Location (State/City)</option>
          </select>
        </div>
      </div>

      {/* Create Customer Modal */}
      {showCreate && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 1000, padding: 20
        }}>
          <div style={{
            background: 'white', borderRadius: 12, padding: 30,
            maxWidth: 500, width: '100%', maxHeight: '90vh', overflow: 'auto'
          }}>
            <h3 style={{ marginBottom: 20 }}>New Customer</h3>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Company</label>
              <input
                type="text"
                className="form-input"
                value={editForm.company}
                onChange={e => setEditForm({ ...editForm, company: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Customer Name</label>
              <input
                type="text"
                className="form-input"
                value={editForm.customerName}
                onChange={e => setEditForm({ ...editForm, customerName: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Email</label>
              <input
                type="email"
                className="form-input"
                value={editForm.email}
                onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Phone 1</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  value={editForm.phoneType}
                  onChange={e => setEditForm({ ...editForm, phoneType: e.target.value })}
                  style={{ padding: '8px 10px', border: '1px solid #ddd', borderRadius: 4, minWidth: 90 }}
                >
                  {phoneTypeOptions.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Phone number..."
                  value={editForm.phone}
                  onChange={e => setEditForm({ ...editForm, phone: e.target.value })}
                  style={{ flex: 1 }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Phone 2</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  value={editForm.phone2Type}
                  onChange={e => setEditForm({ ...editForm, phone2Type: e.target.value })}
                  style={{ padding: '8px 10px', border: '1px solid #ddd', borderRadius: 4, minWidth: 90 }}
                >
                  {phoneTypeOptions.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Phone number..."
                  value={editForm.phone2}
                  onChange={e => setEditForm({ ...editForm, phone2: e.target.value })}
                  style={{ flex: 1 }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Address</label>
              <input
                type="text"
                className="form-input"
                value={editForm.address}
                onChange={e => setEditForm({ ...editForm, address: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 100px', gap: 10, marginBottom: 15 }}>
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>City</label>
                <input
                  type="text"
                  className="form-input"
                  value={editForm.city}
                  onChange={e => setEditForm({ ...editForm, city: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>State</label>
                <input
                  type="text"
                  className="form-input"
                  value={editForm.state}
                  onChange={e => setEditForm({ ...editForm, state: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Zip</label>
                <input
                  type="text"
                  className="form-input"
                  value={editForm.zipCode}
                  onChange={e => setEditForm({ ...editForm, zipCode: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Country</label>
              <input
                type="text"
                className="form-input"
                placeholder="USA, Canada, etc."
                value={editForm.country}
                onChange={e => setEditForm({ ...editForm, country: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', marginBottom: 5, fontWeight: 600 }}>Notes</label>
              <textarea
                className="form-input"
                placeholder="Customer notes..."
                value={editForm.notes}
                onChange={e => setEditForm({ ...editForm, notes: e.target.value })}
                style={{ width: '100%', minHeight: 80, resize: 'vertical' }}
              />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={saveCustomer} style={{ flex: 1 }}>
                Create Customer
              </button>
              <button className="btn" onClick={() => setShowCreate(false)} style={{ flex: 1, background: '#6c757d', color: 'white' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Customers Table */}
      <div className="data-table">
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>Contact</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Location</th>
              <th>Orders</th>
            </tr>
          </thead>
          <tbody>
            {filteredCustomers.map(customer => {
              const custOrders = orders.filter(o => o.customerId === customer.id);
              const unpaid = custOrders.filter(o => o.status !== 'paid').reduce((sum, o) => sum + (o.total || 0), 0);
              const locationParts = [customer.city, customer.state, customer.country].filter(Boolean);
              
              return (
                <tr 
                  key={customer.id} 
                  onClick={() => selectCustomer(customer)}
                  style={{ cursor: 'pointer' }}
                >
                  <td><strong>{customer.company || '-'}</strong></td>
                  <td>{customer.customerName || '-'}</td>
                  <td>{customer.email || '-'}</td>
                  <td>
                    {customer.phone ? (
                      <div>
                        <span style={{ fontSize: 10, color: '#666' }}>{customer.phoneType || 'Cell'}:</span> {customer.phone}
                        {customer.phone2 && (
                          <div style={{ fontSize: 12, marginTop: 2 }}>
                            <span style={{ fontSize: 10, color: '#666' }}>{customer.phone2Type || 'Office'}:</span> {customer.phone2}
                          </div>
                        )}
                      </div>
                    ) : '-'}
                  </td>
                  <td>{locationParts.length > 0 ? locationParts.join(', ') : '-'}</td>
                  <td>
                    <span>{custOrders.length} orders</span>
                    {unpaid > 0 && (
                      <span style={{ color: '#f44336', marginLeft: 10, fontSize: 12 }}>
                        ({formatCurrency(unpaid)} unpaid)
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {filteredCustomers.length === 0 && (
              <tr>
                <td colSpan="6">
                  <div className="empty-state">
                    <p>No customers found</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: 15, color: '#666' }}>
        Showing {filteredCustomers.length} of {customers.length} customers
      </p>
    </div>
  );
}
