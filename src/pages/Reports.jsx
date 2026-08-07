import { useState, useEffect } from 'react';
import { OrgDB as DB } from '../orgDb';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useAuth } from '../OrgAuthContext';

const fbFunctions = getFunctions();

const fieldLbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '.04em' };
const inp = { padding: '7px 9px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, background: 'var(--bg-input)', color: 'var(--text-primary)' };

export default function Reports() {
  const { userRole } = useAuth();
  const isAdmin = userRole === 'admin';
  const isManager = userRole === 'manager';
  const canViewReports = isAdmin || isManager;
  
  const [activeTab, setActiveTab] = useState('summary');
  const [loading, setLoading] = useState(false);
  
  // Summary data
  const [items, setItems] = useState([]);
  const [locations, setLocations] = useState([]);
  
  // Dead Stock
  const [deadStockDays, setDeadStockDays] = useState(90);
  const [deadStock, setDeadStock] = useState([]);
  
  // Inventory Turnover
  const [turnoverDays, setTurnoverDays] = useState(30);
  const [turnover, setTurnover] = useState([]);
  
  // Custom Report
  const [customFilters, setCustomFilters] = useState({
    dateFrom: '',
    dateTo: '',
    type: '',
    user: ''
  });
  const [customData, setCustomData] = useState([]);
  const [movements, setMovements] = useState([]);
  const [orders, setOrders] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [phCustomerId, setPhCustomerId] = useState('all');
  const [phSearch, setPhSearch] = useState('');
  const [phPaidOnly, setPhPaidOnly] = useState(false);
  const [phView, setPhView] = useState('detail');
  const [salesPeriod, setSalesPeriod] = useState('ytd');
  const [salesFrom, setSalesFrom] = useState('');
  const [salesTo, setSalesTo] = useState('');
  const [salesGroup, setSalesGroup] = useState('month');
  // ---- expenses ----
  const [expenses, setExpenses] = useState([]);
  const [expPeriod, setExpPeriod] = useState('ytd');
  const [expFrom, setExpFrom] = useState('');
  const [expTo, setExpTo] = useState('');
  const [expCat, setExpCat] = useState('');
  const [expWh, setExpWh] = useState('');
  const [expSaving, setExpSaving] = useState(false);
  const [expForm, setExpForm] = useState({
    date: new Date().toISOString().slice(0, 10), vendor: '', category: 'Other',
    amount: '', taxAmount: '', paymentMethod: '', reference: '',
    warehouse: '', employee: '', notes: '', receiptUrl: ''
  });
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState(''); // 'detail' = every line, 'summary' = per-item totals

  useEffect(() => {
    loadAllData();
  }, []);

  const loadAllData = async () => {
    setLoading(true);
    const [itemsData, locsData, movementsData, ordersData, customersData, expenseData] = await Promise.all([
      DB.getItems(),
      DB.getLocations(),
      DB.getMovements(),
      DB.getPurchaseOrders(),
      DB.getCustomers(),
      DB.getExpenses()
    ]);
    setItems(itemsData);
    setLocations(locsData);
    setMovements(movementsData);
    setOrders(ordersData || []);
    setCustomers(customersData || []);
    setExpenses(expenseData || []);
    setLoading(false);
  };

  // Calculate summary stats
  const summaryStats = {
    totalItems: items.length,
    totalStock: items.reduce((sum, i) => sum + (i.stock || 0), 0),
    totalValue: items.reduce((sum, i) => sum + ((i.stock || 0) * (i.price || 0)), 0),
    avgItemValue: items.length > 0 ? items.reduce((sum, i) => sum + (i.price || 0), 0) / items.length : 0,
    outOfStock: items.filter(i => (i.stock || 0) === 0).length,
    lowStock: items.filter(i => {
      const stock = i.stock || 0;
      const threshold = i.lowStockThreshold || 10;
      return stock > 0 && stock <= threshold;
    }).length,
    needsReorder: items.filter(i => {
      const stock = i.stock || 0;
      const reorderPoint = i.reorderPoint || 0;
      return stock <= reorderPoint && reorderPoint > 0;
    }).length,
    categories: [...new Set(items.map(i => i.category).filter(Boolean))].length,
    totalLocations: locations.length
  };

  // Value by category
  const valueByCategory = items.reduce((acc, item) => {
    const cat = item.category || 'Uncategorized';
    if (!acc[cat]) acc[cat] = { category: cat, items: 0, stock: 0, value: 0 };
    acc[cat].items++;
    acc[cat].stock += item.stock || 0;
    acc[cat].value += (item.stock || 0) * (item.price || 0);
    return acc;
  }, {});
  const categoryData = Object.values(valueByCategory).sort((a, b) => b.value - a.value);

  // Top items by value
  const topValueItems = [...items]
    .map(i => ({ ...i, totalValue: (i.stock || 0) * (i.price || 0) }))
    .sort((a, b) => b.totalValue - a.totalValue)
    .slice(0, 15);

  // Low stock items
  const lowStockItems = items
    .filter(i => {
      const stock = i.stock || 0;
      const threshold = i.lowStockThreshold || 10;
      return stock <= threshold;
    })
    .sort((a, b) => (a.stock || 0) - (b.stock || 0));

  const loadDeadStock = async () => {
    setLoading(true);
    const data = await DB.getDeadStock(deadStockDays);
    setDeadStock(data);
    setLoading(false);
  };

  const loadTurnover = async () => {
    setLoading(true);
    const data = await DB.getInventoryTurnover(turnoverDays);
    setTurnover(data);
    setLoading(false);
  };

  const generateCustomReport = () => {
    let filtered = [...movements];
    
    if (customFilters.dateFrom) {
      const from = new Date(customFilters.dateFrom).getTime();
      filtered = filtered.filter(m => m.timestamp >= from);
    }
    
    if (customFilters.dateTo) {
      const to = new Date(customFilters.dateTo).setHours(23, 59, 59, 999);
      filtered = filtered.filter(m => m.timestamp <= to);
    }
    
    if (customFilters.type) {
      filtered = filtered.filter(m => m.type === customFilters.type);
    }
    
    if (customFilters.user) {
      filtered = filtered.filter(m => m.userEmail === customFilters.user);
    }
    
    setCustomData(filtered);
  };

  const exportToCSV = (data, filename, headers, rowMapper) => {
    const csvContent = [
      headers.join(','),
      ...data.map(item => rowMapper(item).map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportDeadStock = () => {
    exportToCSV(
      deadStock,
      'dead-stock-report',
      ['SKU', 'Item Name', 'Category', 'Current Stock', 'Days Since Movement', 'Last Movement Date'],
      (item) => [
        item.partNumber || '',
        item.name || '',
        item.category || '',
        item.stock || 0,
        item.daysSinceMovement,
        item.lastMovement ? new Date(item.lastMovement).toLocaleDateString() : 'Never'
      ]
    );
  };

  const exportTurnover = () => {
    exportToCSV(
      turnover,
      'inventory-turnover-report',
      ['SKU', 'Item Name', 'Current Stock', 'Total Picked', 'Total Added', 'Total Moved', 'Movement Count'],
      (item) => [
        item.partNumber || '',
        item.name || '',
        item.stock || 0,
        item.totalPicked,
        item.totalAdded,
        item.totalMoved,
        item.movementCount
      ]
    );
  };

  const exportCustom = () => {
    exportToCSV(
      customData,
      'custom-report',
      ['Date', 'Type', 'Item', 'Quantity', 'From', 'To', 'User'],
      (m) => [
        new Date(m.timestamp).toLocaleString(),
        m.type,
        m.itemName || '',
        m.quantity || 0,
        m.fromLocation || '-',
        m.toLocation || '-',
        m.userEmail || ''
      ]
    );
  };

  // Get unique values for filters
  const users = [...new Set(movements.map(m => m.userEmail).filter(Boolean))].sort();
  const types = [...new Set(movements.map(m => m.type).filter(Boolean))].sort();

  const formatDate = (timestamp) => {
    if (!timestamp) return 'Never';
    return new Date(timestamp).toLocaleDateString();
  };

  const tabs = [
    { id: 'summary', label: '📊 Summary' },
    { id: 'value', label: '💰 Inventory Value' },
    { id: 'lowstock', label: '⚠️ Low Stock' },
    { id: 'deadstock', label: '💀 Dead Stock' },
    { id: 'turnover', label: '📈 Turnover' },
    { id: 'sales', label: '💵 Sales' },
    { id: 'expenses', label: '🧾 Expenses' },
    { id: 'purchases', label: '🧾 Customer Purchases' },
    { id: 'custom', label: '📋 Custom' }
  ];

  // ── SALES REPORT ────────────────────────────────────────────────────────
  const SALE_STATUSES = new Set(['invoiced', 'shipped', 'paid', 'packed', 'completed']);
  const saleDate = (o) => o.paidAt || o.shippedAt || o.invoiceDate || o.createdAt || 0;

  // Resolve the chosen period into a [start, end) window.
  const salesRange = (() => {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const startOf = (yy, mm, dd) => new Date(yy, mm, dd || 1).getTime();
    const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x.getTime(); };
    switch (salesPeriod) {
      case 'mtd':      return { from: startOf(y, m), to: endOfDay(now), label: 'Month to date' };
      case 'lastmonth':return { from: startOf(y, m - 1), to: startOf(y, m) - 1, label: 'Last month' };
      case 'ytd':      return { from: startOf(y, 0), to: endOfDay(now), label: 'Year to date' };
      case 'lastyear': return { from: startOf(y - 1, 0), to: startOf(y, 0) - 1, label: `${y - 1}` };
      case 'prev2':    return { from: startOf(y - 2, 0), to: startOf(y - 1, 0) - 1, label: `${y - 2}` };
      case 'last30':   return { from: now.getTime() - 30 * 864e5, to: endOfDay(now), label: 'Last 30 days' };
      case 'last90':   return { from: now.getTime() - 90 * 864e5, to: endOfDay(now), label: 'Last 90 days' };
      case 'all':      return { from: 0, to: endOfDay(now), label: 'All time' };
      case 'custom':   return {
        from: salesFrom ? new Date(salesFrom + 'T00:00:00').getTime() : 0,
        to:   salesTo   ? endOfDay(new Date(salesTo + 'T00:00:00')) : endOfDay(now),
        label: `${salesFrom || 'start'} → ${salesTo || 'today'}`
      };
      default: return { from: 0, to: endOfDay(now), label: 'All time' };
    }
  })();

  // Every qualifying order in the window, with its computed totals.
  const salesOrders = (orders || [])
    .filter(o => SALE_STATUSES.has(o.status))
    .map(o => {
      const when = saleDate(o);
      const lines = (o.items || []).map(li => ({
        qty: parseInt(li.qtyShipped) || parseInt(li.quantity) || 0,
        price: parseFloat(li.unitPrice) || 0,
        sku: li.partNumber || '', name: li.itemName || '',
        cost: parseFloat(li.cost) || 0
      }));
      const subtotal = lines.reduce((s, l) => s + l.qty * l.price, 0);
      const cogs = lines.reduce((s, l) => s + l.qty * l.cost, 0);
      const units = lines.reduce((s, l) => s + l.qty, 0);
      const tax = parseFloat(o.tax) || 0;
      const shipping = parseFloat(o.shipping) || 0;
      const discount = parseFloat(o.discount) || 0;
      return {
        id: o.id, when, po: o.poNumber || '', customer: o.customerName || '',
        customerId: o.customerId || '', status: o.status,
        payment: o.paymentMethod || '', lines, units,
        subtotal, tax, shipping, discount, cogs,
        total: subtotal + tax + shipping - discount
      };
    })
    .filter(o => o.when >= salesRange.from && o.when <= salesRange.to)
    .sort((a, b) => b.when - a.when);

  const salesTotals = salesOrders.reduce((a, o) => {
    a.orders += 1; a.units += o.units; a.subtotal += o.subtotal;
    a.tax += o.tax; a.shipping += o.shipping; a.discount += o.discount;
    a.cogs += o.cogs; a.revenue += o.total;
    return a;
  }, { orders: 0, units: 0, subtotal: 0, tax: 0, shipping: 0, discount: 0, cogs: 0, revenue: 0 });
  salesTotals.avgOrder = salesTotals.orders ? salesTotals.revenue / salesTotals.orders : 0;
  salesTotals.margin = salesTotals.subtotal ? ((salesTotals.subtotal - salesTotals.cogs) / salesTotals.subtotal) * 100 : 0;

  // Break the window into buckets (day / month / year) for the trend table.
  const salesBuckets = (() => {
    const keyOf = (ts) => {
      const d = new Date(ts);
      if (salesGroup === 'day') return d.toLocaleDateString();
      if (salesGroup === 'year') return String(d.getFullYear());
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
    };
    const map = new Map();
    salesOrders.forEach(o => {
      const k = keyOf(o.when);
      const b = map.get(k) || { key: k, ts: o.when, orders: 0, units: 0, revenue: 0, subtotal: 0, cogs: 0 };
      b.orders += 1; b.units += o.units; b.revenue += o.total;
      b.subtotal += o.subtotal; b.cogs += o.cogs;
      if (o.when > b.ts) b.ts = o.when;
      map.set(k, b);
    });
    return [...map.values()].sort((a, b) => b.ts - a.ts);
  })();

  // Top customers and top items within the window.
  const topCustomers = (() => {
    const m = new Map();
    salesOrders.forEach(o => {
      const k = o.customer || '(no customer)';
      const c = m.get(k) || { name: k, orders: 0, revenue: 0, units: 0 };
      c.orders += 1; c.revenue += o.total; c.units += o.units;
      m.set(k, c);
    });
    return [...m.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  })();

  const topItems = (() => {
    const m = new Map();
    salesOrders.forEach(o => o.lines.forEach(l => {
      if (!l.qty) return;
      const k = (l.sku || '') + '|' + l.name;
      const it = m.get(k) || { sku: l.sku, name: l.name, units: 0, revenue: 0 };
      it.units += l.qty; it.revenue += l.qty * l.price;
      m.set(k, it);
    }));
    return [...m.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  })();

  const exportSales = () => {
    exportToCSV(salesOrders, `sales-${salesPeriod}`,
      ['Date', 'Order #', 'Customer', 'Status', 'Payment', 'Units', 'Subtotal', 'Discount', 'Tax', 'Shipping', 'Total'],
      (o) => [
        o.when ? new Date(o.when).toLocaleDateString() : '', o.po, o.customer, o.status, o.payment,
        o.units, o.subtotal.toFixed(2), o.discount.toFixed(2), o.tax.toFixed(2), o.shipping.toFixed(2), o.total.toFixed(2)
      ]);
  };

  // ── EXPENSES ────────────────────────────────────────────────────────────
  const expRange = (() => {
    const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
    const startOf = (yy, mm) => new Date(yy, mm, 1).getTime();
    const eod = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x.getTime(); };
    switch (expPeriod) {
      case 'mtd':       return { from: startOf(y, m), to: eod(now), label: 'Month to date' };
      case 'lastmonth': return { from: startOf(y, m - 1), to: startOf(y, m) - 1, label: 'Last month' };
      case 'ytd':       return { from: startOf(y, 0), to: eod(now), label: 'Year to date' };
      case 'lastyear':  return { from: startOf(y - 1, 0), to: startOf(y, 0) - 1, label: `${y - 1}` };
      case 'all':       return { from: 0, to: eod(now), label: 'All time' };
      case 'custom':    return {
        from: expFrom ? new Date(expFrom + 'T00:00:00').getTime() : 0,
        to: expTo ? eod(new Date(expTo + 'T00:00:00')) : eod(now),
        label: `${expFrom || 'start'} → ${expTo || 'today'}` };
      default:          return { from: 0, to: eod(now), label: 'All time' };
    }
  })();

  const expRows = (expenses || [])
    .filter(e => (e.date || 0) >= expRange.from && (e.date || 0) <= expRange.to)
    .filter(e => !expCat || e.category === expCat)
    .filter(e => !expWh || e.warehouse === expWh);

  const expTotal = expRows.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

  const expByCategory = (() => {
    const m = new Map();
    expRows.forEach(e => {
      const k = e.category || 'Other';
      const c = m.get(k) || { name: k, total: 0, count: 0 };
      c.total += parseFloat(e.amount) || 0; c.count += 1;
      m.set(k, c);
    });
    return [...m.values()].sort((a, b) => b.total - a.total);
  })();

  const expWarehouses = [...new Set((expenses || []).map(e => e.warehouse).filter(Boolean))].sort();

  // Money in vs money out for the same window
  const expVsSales = (() => {
    const revenue = (orders || [])
      .filter(o => SALE_STATUSES.has(o.status))
      .map(o => ({ when: saleDate(o), total: (o.items || []).reduce((s, li) =>
          s + (parseInt(li.qtyShipped) || parseInt(li.quantity) || 0) * (parseFloat(li.unitPrice) || 0), 0)
          + (parseFloat(o.tax) || 0) + (parseFloat(o.shipping) || 0) - (parseFloat(o.discount) || 0) }))
      .filter(o => o.when >= expRange.from && o.when <= expRange.to)
      .reduce((s, o) => s + o.total, 0);
    return { revenue, expenses: expTotal, net: revenue - expTotal };
  })();

  const saveExpense = async () => {
    if (expSaving) return;
    if (!expForm.amount || parseFloat(expForm.amount) <= 0) { alert('Enter an amount.'); return; }
    setExpSaving(true);
    try {
      await DB.createExpense(expForm);
      setExpForm({
        date: new Date().toISOString().slice(0, 10), vendor: '', category: 'Other',
        amount: '', taxAmount: '', paymentMethod: '', reference: '',
        warehouse: '', employee: '', notes: '', receiptUrl: ''
      });
      const fresh = await DB.getExpenses();
      setExpenses(fresh || []);
    } catch (e) { alert('Could not save: ' + (e.message || e)); }
    setExpSaving(false);
  };

  // Upload the receipt AND read it — OCR pre-fills the form, you confirm.
  const attachReceipt = async (file) => {
    if (!file) return;
    setReceiptBusy(true);
    try {
      const url = await DB.uploadReceipt(file);
      setExpForm(f => ({ ...f, receiptUrl: url }));

      // read it
      setScanning(true);
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onloadend = () => res(String(r.result).split(',')[1] || '');
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      const fn = httpsCallable(fbFunctions, 'parseReceipt');
      const out = await fn({ imageBase64: b64, mimeType: file.type || 'image/jpeg' });
      const d = out?.data || {};
      const vendor = d.vendor || '';
      // remember what this vendor was filed under last time
      const remembered = vendor ? DB.vendorCategory(expenses, vendor) : '';
      setExpForm(f => ({
        ...f,
        vendor: vendor || f.vendor,
        date: d.date || f.date,
        amount: d.total != null ? String(d.total) : f.amount,
        taxAmount: d.tax != null ? String(d.tax) : f.taxAmount,
        reference: d.reference || f.reference,
        category: remembered || f.category
      }));
      setScanNote(
        d.total != null
          ? `Read by ${d.engine === 'documentai' ? 'Document AI' : 'Vision'} — check the numbers before saving.`
          : 'Could not read a total — enter it manually.'
      );
    } catch (e) {
      setScanNote('Receipt saved, but could not be read automatically — enter the details manually.');
      console.warn('OCR failed:', e && e.message);
    }
    setScanning(false);
    setReceiptBusy(false);
  };

  const removeExpense = async (id) => {
    try { await DB.deleteExpense(id); setExpenses(prev => prev.filter(e => e.id !== id)); }
    catch (e) { alert('Delete failed: ' + (e.message || e)); }
  };

  const exportExpenses = () => {
    exportToCSV(expRows, `expenses-${expPeriod}`,
      ['Date', 'Vendor', 'Category', 'Amount', 'Tax', 'Payment', 'Reference', 'Warehouse', 'Employee', 'Notes', 'Receipt'],
      (e) => [
        e.date ? new Date(e.date).toLocaleDateString() : '', e.vendor, e.category,
        (parseFloat(e.amount) || 0).toFixed(2), (parseFloat(e.taxAmount) || 0).toFixed(2),
        e.paymentMethod, e.reference, e.warehouse, e.employee, e.notes, e.receiptUrl
      ]);
  };

  // ── Customer purchase history: flatten every order line into one row ──
  // Only orders that represent a real sale (invoiced/shipped/paid), never drafts.
  const SOLD_STATUSES = new Set(['invoiced', 'shipped', 'paid', 'packed', 'completed']);
  const purchaseRows = (() => {
    const rows = [];
    (orders || []).forEach(o => {
      if (!SOLD_STATUSES.has(o.status)) return;
      if (phCustomerId !== 'all' && o.customerId !== phCustomerId) return;
      if (phPaidOnly && !o.paymentMethod && o.status !== 'paid') return;
      const when = o.paidAt || o.shippedAt || o.invoiceDate || o.createdAt || 0;
      (o.items || []).forEach(li => {
        const qty = parseInt(li.qtyShipped) || parseInt(li.quantity) || 0;
        const price = parseFloat(li.unitPrice) || 0;
        rows.push({
          date: when,
          customerName: o.customerName || '',
          poNumber: o.poNumber || '',
          status: o.status || '',
          sku: li.partNumber || '',
          itemName: li.itemName || '',
          grade: li.grade || '',
          qty,
          unitPrice: price,
          lineTotal: qty * price,
          paymentMethod: o.paymentMethod || '',
          customerPO: o.customerPO || ''
        });
      });
    });
    const q = phSearch.trim().toLowerCase();
    const filtered = q
      ? rows.filter(r =>
          r.itemName.toLowerCase().includes(q) ||
          r.sku.toLowerCase().includes(q) ||
          r.customerName.toLowerCase().includes(q))
      : rows;
    return filtered.sort((a, b) => b.date - a.date);
  })();

  const purchaseTotals = purchaseRows.reduce(
    (acc, r) => { acc.qty += r.qty; acc.value += r.lineTotal; return acc; },
    { qty: 0, value: 0 }
  );

  // Collapse the line items into one row per distinct item (SKU + name), with
  // total qty, total spend, order count, and the most recent purchase date.
  const purchaseSummary = (() => {
    const map = new Map();
    purchaseRows.forEach(r => {
      const key = (r.sku || '') + '|' + (r.itemName || '');
      const prev = map.get(key) || {
        sku: r.sku, itemName: r.itemName, grade: r.grade,
        qty: 0, value: 0, orders: new Set(), lastDate: 0
      };
      prev.qty += r.qty;
      prev.value += r.lineTotal;
      if (r.poNumber) prev.orders.add(r.poNumber);
      if (r.date > prev.lastDate) prev.lastDate = r.date;
      if (!prev.grade && r.grade) prev.grade = r.grade;
      map.set(key, prev);
    });
    return [...map.values()]
      .map(s => ({ ...s, orderCount: s.orders.size }))
      .sort((a, b) => b.qty - a.qty);
  })();

  const exportPurchases = () => {
    if (phView === 'summary') {
      exportToCSV(
        purchaseSummary,
        'customer-purchases-summary',
        ['SKU', 'Item', 'Condition', 'Total Qty', 'Orders', 'Total Spent', 'Last Purchased'],
        (s) => [
          s.sku, s.itemName, s.grade, s.qty, s.orderCount,
          s.value.toFixed(2),
          s.lastDate ? new Date(s.lastDate).toLocaleDateString() : ''
        ]
      );
      return;
    }
    exportToCSV(
      purchaseRows,
      'customer-purchases',
      ['Date', 'Customer', 'Order #', 'Customer PO', 'Status', 'SKU', 'Item', 'Condition', 'Qty', 'Unit Price', 'Line Total', 'Payment'],
      (r) => [
        r.date ? new Date(r.date).toLocaleDateString() : '',
        r.customerName, r.poNumber, r.customerPO, r.status,
        r.sku, r.itemName, r.grade, r.qty,
        r.unitPrice.toFixed(2), r.lineTotal.toFixed(2), r.paymentMethod
      ]
    );
  };

  // Staff cannot access reports
  if (!canViewReports) {
    return (
      <div className="page-content">
        <h2 style={{ marginBottom: 20 }}>Reports</h2>
        <div style={{ 
          background: 'var(--bg-warning)', 
          padding: 30, 
          borderRadius: 8, 
          textAlign: 'center',
          border: '1px solid #ffc107'
        }}>
          <h3 style={{ color: '#856404', marginBottom: 10 }}>🔒 Access Restricted</h3>
          <p style={{ color: '#856404' }}>Reports are only available to Managers and Admins.</p>
          <p style={{ color: '#856404', fontSize: 14 }}>Contact your administrator if you need access.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-content">
      <h2 style={{ marginBottom: 20 }}>Reports</h2>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 5, marginBottom: 20, borderBottom: '2px solid #eee', paddingBottom: 10, flexWrap: 'wrap' }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '10px 20px',
              border: 'none',
              background: activeTab === tab.id ? '#0d7a52' : '#e0e0e0',
              color: activeTab === tab.id ? 'white' : '#333',
              borderRadius: '6px 6px 0 0',
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Summary Tab */}
      {activeTab === 'summary' && (
        <div>
          {/* KPI Cards */}
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', 
            gap: 15, 
            marginBottom: 20 
          }}>
            <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent)' }}>
                {summaryStats.totalItems.toLocaleString()}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Total Items</div>
            </div>
            <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent)' }}>
                {summaryStats.totalStock.toLocaleString()}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Total Units</div>
            </div>
            <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-success)' }}>
                ${summaryStats.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Total Value</div>
            </div>
            <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8, textAlign: 'center', borderLeft: '4px solid var(--text-error)' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-error)' }}>
                {summaryStats.outOfStock}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Out of Stock</div>
            </div>
            <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8, textAlign: 'center', borderLeft: '4px solid var(--text-badge-orange)' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#ff9800' }}>
                {summaryStats.lowStock}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Low Stock</div>
            </div>
            <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#2196F3' }}>
                {summaryStats.categories}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Categories</div>
            </div>
          </div>

          {/* Category Breakdown */}
          <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8 }}>
            <h3 style={{ marginBottom: 15 }}>📊 Value by Category</h3>
            {categoryData.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>No category data available</p>
            ) : (
              <div>
                {categoryData.slice(0, 10).map((cat, idx) => {
                  const maxValue = categoryData[0]?.value || 1;
                  return (
                    <div key={cat.category} style={{ marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontWeight: 500 }}>{cat.category}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                          {cat.items} items | {cat.stock} units | ${cat.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                      <div style={{ background: 'var(--bg-surface-3)', borderRadius: 4, height: 20, overflow: 'hidden' }}>
                        <div style={{
                          width: `${(cat.value / maxValue) * 100}%`,
                          height: '100%',
                          background: `hsl(${120 - (idx * 12)}, 60%, 45%)`,
                          borderRadius: 4
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Value Report Tab */}
      {activeTab === 'value' && (
        <div>
          <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8, marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
              <h3>💰 Inventory Value Report</h3>
              <button
                className="btn btn-primary"
                onClick={() => exportToCSV(
                  topValueItems,
                  'inventory-value-report',
                  ['SKU', 'Name', 'Category', 'Stock', 'Unit Price', 'Total Value'],
                  (i) => [i.partNumber || '', i.name || '', i.category || '', i.stock || 0, i.price || 0, i.totalValue.toFixed(2)]
                )}
              >
                📥 Export CSV
              </button>
            </div>
            
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', 
              gap: 15,
              marginBottom: 20,
              padding: 15,
              background: 'var(--bg-surface-2)',
              borderRadius: 8
            }}>
              <div>
                <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-success)' }}>
                  ${summaryStats.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Total Inventory Value</div>
              </div>
              <div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#2196F3' }}>
                  ${summaryStats.avgItemValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Average Item Price</div>
              </div>
            </div>

            <h4 style={{ marginBottom: 10 }}>Top 15 Items by Value</h4>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg-surface-2)' }}>
                  <th style={{ padding: 10, textAlign: 'left' }}>SKU</th>
                  <th style={{ padding: 10, textAlign: 'left' }}>Item Name</th>
                  <th style={{ padding: 10, textAlign: 'left' }}>Category</th>
                  <th style={{ padding: 10, textAlign: 'right' }}>Stock</th>
                  <th style={{ padding: 10, textAlign: 'right' }}>Unit Price</th>
                  <th style={{ padding: 10, textAlign: 'right' }}>Total Value</th>
                </tr>
              </thead>
              <tbody>
                {topValueItems.map((item, idx) => (
                  <tr key={item.id} style={{ borderBottom: '1px solid var(--border)', background: idx < 3 ? '#fffde7' : 'white' }}>
                    <td style={{ padding: 10, fontFamily: 'monospace' }}>{item.partNumber || '-'}</td>
                    <td style={{ padding: 10 }}>{item.name}</td>
                    <td style={{ padding: 10, color: 'var(--text-muted)' }}>{item.category || '-'}</td>
                    <td style={{ padding: 10, textAlign: 'right' }}>{item.stock || 0}</td>
                    <td style={{ padding: 10, textAlign: 'right' }}>${(item.price || 0).toFixed(2)}</td>
                    <td style={{ padding: 10, textAlign: 'right', fontWeight: 600, color: 'var(--text-success)' }}>
                      ${item.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Low Stock Tab */}
      {activeTab === 'lowstock' && (
        <div>
          <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
              <h3>⚠️ Low Stock Report</h3>
              <button
                className="btn btn-primary"
                onClick={() => exportToCSV(
                  lowStockItems,
                  'low-stock-report',
                  ['SKU', 'Name', 'Category', 'Current Stock', 'Low Threshold', 'Reorder Point', 'Status'],
                  (i) => [
                    i.partNumber || '', 
                    i.name || '', 
                    i.category || '', 
                    i.stock || 0, 
                    i.lowStockThreshold || 10,
                    i.reorderPoint || 0,
                    (i.stock || 0) === 0 ? 'OUT OF STOCK' : (i.stock || 0) <= (i.lowStockThreshold || 10) ? 'LOW' : 'REORDER'
                  ]
                )}
              >
                📥 Export CSV
              </button>
            </div>

            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', 
              gap: 15,
              marginBottom: 20
            }}>
              <div style={{ background: 'var(--bg-badge-red)', padding: 15, borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-error)' }}>
                  {items.filter(i => (i.stock || 0) === 0).length}
                </div>
                <div style={{ color: 'var(--text-error)', fontSize: 12 }}>Out of Stock</div>
              </div>
              <div style={{ background: 'var(--bg-badge-orange)', padding: 15, borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-badge-orange)' }}>
                  {summaryStats.lowStock}
                </div>
                <div style={{ color: 'var(--text-badge-orange)', fontSize: 12 }}>Low Stock</div>
              </div>
              <div style={{ background: 'var(--bg-badge-blue)', padding: 15, borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-badge-blue)' }}>
                  {summaryStats.needsReorder}
                </div>
                <div style={{ color: 'var(--text-badge-blue)', fontSize: 12 }}>Needs Reorder</div>
              </div>
            </div>

            {lowStockItems.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                🎉 All items are well stocked!
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-surface-2)' }}>
                    <th style={{ padding: 10, textAlign: 'left' }}>Status</th>
                    <th style={{ padding: 10, textAlign: 'left' }}>SKU</th>
                    <th style={{ padding: 10, textAlign: 'left' }}>Item Name</th>
                    <th style={{ padding: 10, textAlign: 'right' }}>Stock</th>
                    <th style={{ padding: 10, textAlign: 'right' }}>Threshold</th>
                    <th style={{ padding: 10, textAlign: 'right' }}>Reorder At</th>
                  </tr>
                </thead>
                <tbody>
                  {lowStockItems.map(item => {
                    const stock = item.stock || 0;
                    const isOutOfStock = stock === 0;
                    const isLow = stock > 0 && stock <= (item.lowStockThreshold || 10);
                    return (
                      <tr key={item.id} style={{ 
                        borderBottom: '1px solid var(--border)',
                        background: isOutOfStock ? '#ffebee' : isLow ? '#fff3e0' : 'white'
                      }}>
                        <td style={{ padding: 10 }}>
                          <span style={{
                            padding: '3px 8px',
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 600,
                            background: isOutOfStock ? '#f44336' : isLow ? '#ff9800' : '#2196F3',
                            color: 'var(--text-on-dark)'
                          }}>
                            {isOutOfStock ? 'OUT' : isLow ? 'LOW' : 'REORDER'}
                          </span>
                        </td>
                        <td style={{ padding: 10, fontFamily: 'monospace' }}>{item.partNumber || '-'}</td>
                        <td style={{ padding: 10 }}>{item.name}</td>
                        <td style={{ padding: 10, textAlign: 'right', fontWeight: 600, color: isOutOfStock ? '#c62828' : '#e65100' }}>
                          {stock}
                        </td>
                        <td style={{ padding: 10, textAlign: 'right', color: 'var(--text-muted)' }}>{item.lowStockThreshold || 10}</td>
                        <td style={{ padding: 10, textAlign: 'right', color: 'var(--text-muted)' }}>{item.reorderPoint || '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Dead Stock Tab */}
      {activeTab === 'deadstock' && (
        <div>
          <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8, marginBottom: 20 }}>
            <h3 style={{ marginBottom: 15 }}>Dead Stock Report</h3>
            <p style={{ color: 'var(--text-muted)', marginBottom: 15 }}>
              Items with no movement in the specified number of days.
            </p>
            
            <div style={{ display: 'flex', gap: 15, alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <label style={{ marginRight: 10 }}>Days without movement:</label>
                <select
                  className="form-input"
                  value={deadStockDays}
                  onChange={e => setDeadStockDays(parseInt(e.target.value))}
                  style={{ width: 100 }}
                >
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                  <option value={180}>180 days</option>
                  <option value={365}>1 year</option>
                </select>
              </div>
              
              <button className="btn btn-primary" onClick={loadDeadStock} disabled={loading}>
                {loading ? 'Loading...' : 'Generate Report'}
              </button>
              
              {deadStock.length > 0 && (
                <button className="btn" onClick={exportDeadStock} style={{ background: '#17a2b8', color: 'var(--text-on-dark)' }}>
                  📥 Export CSV
                </button>
              )}
            </div>
          </div>

          {deadStock.length > 0 && (
            <div className="data-table">
              <p style={{ marginBottom: 10, color: 'var(--text-muted)' }}>
                Found <strong>{deadStock.length}</strong> items with no movement in {deadStockDays}+ days
              </p>
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Item Name</th>
                    <th>Category</th>
                    <th>Stock</th>
                    <th>Days Since Movement</th>
                    <th>Last Movement</th>
                  </tr>
                </thead>
                <tbody>
                  {deadStock.map(item => (
                    <tr key={item.id}>
                      <td>{item.partNumber}</td>
                      <td>{item.name}</td>
                      <td>{item.category || '-'}</td>
                      <td>{item.stock || 0}</td>
                      <td style={{ 
                        color: item.daysSinceMovement === 'Never' || item.daysSinceMovement > 180 ? '#f44336' : '#ff9800',
                        fontWeight: 600
                      }}>
                        {item.daysSinceMovement}
                      </td>
                      <td>{formatDate(item.lastMovement)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Inventory Turnover Tab */}
      {activeTab === 'turnover' && (
        <div>
          <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8, marginBottom: 20 }}>
            <h3 style={{ marginBottom: 15 }}>Inventory Turnover Report</h3>
            <p style={{ color: 'var(--text-muted)', marginBottom: 15 }}>
              See which items are moving fastest (most picked) and slowest.
            </p>
            
            <div style={{ display: 'flex', gap: 15, alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <label style={{ marginRight: 10 }}>Time period:</label>
                <select
                  className="form-input"
                  value={turnoverDays}
                  onChange={e => setTurnoverDays(parseInt(e.target.value))}
                  style={{ width: 100 }}
                >
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                </select>
              </div>
              
              <button className="btn btn-primary" onClick={loadTurnover} disabled={loading}>
                {loading ? 'Loading...' : 'Generate Report'}
              </button>
              
              {turnover.length > 0 && (
                <button className="btn" onClick={exportTurnover} style={{ background: '#17a2b8', color: 'var(--text-on-dark)' }}>
                  📥 Export CSV
                </button>
              )}
            </div>
          </div>

          {turnover.length > 0 && (
            <div className="data-table">
              <p style={{ marginBottom: 10, color: 'var(--text-muted)' }}>
                Showing movement stats for the last {turnoverDays} days
              </p>
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Item Name</th>
                    <th>Stock</th>
                    <th>Picked</th>
                    <th>Added</th>
                    <th>Moved</th>
                    <th>Total Movements</th>
                  </tr>
                </thead>
                <tbody>
                  {turnover.slice(0, 100).map((item, idx) => (
                    <tr key={item.id}>
                      <td>{item.partNumber}</td>
                      <td>
                        {idx < 3 && item.totalPicked > 0 && <span style={{ marginRight: 5 }}>🏆</span>}
                        {item.name}
                      </td>
                      <td>{item.stock || 0}</td>
                      <td style={{ color: 'var(--text-error)', fontWeight: item.totalPicked > 0 ? 600 : 400 }}>
                        {item.totalPicked}
                      </td>
                      <td style={{ color: 'var(--text-success)' }}>{item.totalAdded}</td>
                      <td style={{ color: '#2196F3' }}>{item.totalMoved}</td>
                      <td>{item.movementCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Sales Tab */}
      {activeTab === 'sales' && (
        <div>
          <h3 style={{ marginBottom: 4 }}>💵 Sales</h3>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
            Showing <strong>{salesRange.label}</strong>
          </div>

          {/* period selector */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {[
              ['mtd', 'Month to date'], ['lastmonth', 'Last month'],
              ['ytd', 'Year to date'], ['lastyear', 'Last year'], ['prev2', '2 years ago'],
              ['last30', 'Last 30 days'], ['last90', 'Last 90 days'],
              ['all', 'All time'], ['custom', 'Custom…']
            ].map(([id, label]) => (
              <button key={id} onClick={() => setSalesPeriod(id)}
                style={{
                  padding: '6px 13px', borderRadius: 16, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                  border: salesPeriod === id ? '1px solid #4a5d23' : '1px solid var(--border)',
                  background: salesPeriod === id ? '#4a5d23' : 'transparent',
                  color: salesPeriod === id ? '#fff' : 'var(--text-secondary)'
                }}>{label}</button>
            ))}
          </div>

          {salesPeriod === 'custom' && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>From</label>
              <input type="date" value={salesFrom} onChange={e => setSalesFrom(e.target.value)}
                style={{ padding: 6, borderRadius: 6, border: '1px solid var(--border)' }} />
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>To</label>
              <input type="date" value={salesTo} onChange={e => setSalesTo(e.target.value)}
                style={{ padding: 6, borderRadius: 6, border: '1px solid var(--border)' }} />
            </div>
          )}

          {/* KPI cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 18 }}>
            {[
              ['Revenue', `$${salesTotals.revenue.toFixed(2)}`, '#2e7d32'],
              ['Orders', salesTotals.orders, '#1565c0'],
              ['Units sold', salesTotals.units, '#6b7f3e'],
              ['Avg order', `$${salesTotals.avgOrder.toFixed(2)}`, '#7b1fa2'],
              ['Product sales', `$${salesTotals.subtotal.toFixed(2)}`, '#00838f'],
              ['Shipping billed', `$${salesTotals.shipping.toFixed(2)}`, '#d98a1f'],
              ['Tax', `$${salesTotals.tax.toFixed(2)}`, '#8d6e63'],
              ['Gross margin', salesTotals.cogs > 0 ? `${salesTotals.margin.toFixed(1)}%` : '—', '#c62828']
            ].map(([label, val, color]) => (
              <div key={label} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700 }}>{label}</div>
                <div style={{ fontSize: 21, fontWeight: 800, color, marginTop: 3 }}>{val}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Group by</span>
            {[['day', 'Day'], ['month', 'Month'], ['year', 'Year']].map(([id, l]) => (
              <button key={id} onClick={() => setSalesGroup(id)}
                style={{
                  padding: '4px 12px', borderRadius: 14, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                  border: salesGroup === id ? '1px solid #4a5d23' : '1px solid var(--border)',
                  background: salesGroup === id ? '#4a5d23' : 'transparent',
                  color: salesGroup === id ? '#fff' : 'var(--text-secondary)'
                }}>{l}</button>
            ))}
            <button className="btn" onClick={exportSales} disabled={!salesOrders.length}
              style={{ marginLeft: 'auto', background: '#17a2b8', color: 'var(--text-on-dark)' }}>
              ⬇️ Export CSV
            </button>
          </div>

          {/* trend */}
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 20 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg-surface-2)', textAlign: 'left' }}>
                  {['Period', 'Orders', 'Units', 'Product sales', 'Revenue'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', borderBottom: '2px solid var(--border)' }}>{h}</th>))}
                </tr>
              </thead>
              <tbody>
                {salesBuckets.length === 0 ? (
                  <tr><td colSpan={5} style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>No sales in this period.</td></tr>
                ) : salesBuckets.map(b => (
                  <tr key={b.key} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 10px', fontWeight: 600 }}>{b.key}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>{b.orders}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>{b.units}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>${b.subtotal.toFixed(2)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700 }}>${b.revenue.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* top customers + items */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 16 }}>
            <div>
              <h4 style={{ marginBottom: 8 }}>🏆 Top customers</h4>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <tbody>
                    {topCustomers.length === 0 ? (
                      <tr><td style={{ padding: 16, color: 'var(--text-muted)', textAlign: 'center' }}>No data</td></tr>
                    ) : topCustomers.map(c => (
                      <tr key={c.name} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '6px 10px' }}>{c.name}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>{c.orders} ord</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700 }}>${c.revenue.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h4 style={{ marginBottom: 8 }}>📦 Top items</h4>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <tbody>
                    {topItems.length === 0 ? (
                      <tr><td style={{ padding: 16, color: 'var(--text-muted)', textAlign: 'center' }}>No data</td></tr>
                    ) : topItems.map(i => (
                      <tr key={i.sku + i.name} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '6px 10px', color: 'var(--text-muted)', fontSize: 12 }}>{i.sku}</td>
                        <td style={{ padding: '6px 10px' }}>{i.name}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>{i.units}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700 }}>${i.revenue.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Expenses Tab */}
      {activeTab === 'expenses' && (
        <div>
          <h3 style={{ marginBottom: 4 }}>🧾 Expenses</h3>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
            Money going out — receipts, bills, invoices and pay. Showing <strong>{expRange.label}</strong>.
          </div>

          {/* ---- capture ---- */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginBottom: 18 }}>
            <h4 style={{ margin: '0 0 12px' }}>➕ Log an expense</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
              <div><label style={fieldLbl}>Date</label>
                <input type="date" value={expForm.date} onChange={e => setExpForm(f => ({ ...f, date: e.target.value }))} style={inp} /></div>
              <div><label style={fieldLbl}>Vendor / paid to</label>
                <input value={expForm.vendor} placeholder="e.g. Uline, John Smith" onChange={e => setExpForm(f => ({ ...f, vendor: e.target.value }))} style={inp} /></div>
              <div><label style={fieldLbl}>Category</label>
                <select value={expForm.category} onChange={e => setExpForm(f => ({ ...f, category: e.target.value }))} style={inp}>
                  {DB.EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select></div>
              <div><label style={fieldLbl}>Amount</label>
                <input type="number" step="0.01" min="0" value={expForm.amount} placeholder="0.00"
                  onChange={e => setExpForm(f => ({ ...f, amount: e.target.value }))} style={inp} /></div>
              <div><label style={fieldLbl}>Tax (optional)</label>
                <input type="number" step="0.01" min="0" value={expForm.taxAmount} placeholder="0.00"
                  onChange={e => setExpForm(f => ({ ...f, taxAmount: e.target.value }))} style={inp} /></div>
              <div><label style={fieldLbl}>Paid with</label>
                <input value={expForm.paymentMethod} placeholder="Card, Check #, ACH" onChange={e => setExpForm(f => ({ ...f, paymentMethod: e.target.value }))} style={inp} /></div>
              <div><label style={fieldLbl}>Invoice / bill #</label>
                <input value={expForm.reference} onChange={e => setExpForm(f => ({ ...f, reference: e.target.value }))} style={inp} /></div>
              <div><label style={fieldLbl}>Warehouse / site</label>
                <input value={expForm.warehouse} placeholder="W1, W4…" onChange={e => setExpForm(f => ({ ...f, warehouse: e.target.value }))} style={inp} /></div>
              <div><label style={fieldLbl}>Employee (if pay)</label>
                <input value={expForm.employee} onChange={e => setExpForm(f => ({ ...f, employee: e.target.value }))} style={inp} /></div>
            </div>

            <div style={{ marginTop: 10 }}>
              <label style={fieldLbl}>Notes</label>
              <input value={expForm.notes} onChange={e => setExpForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inp, width: '100%' }} />
            </div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
              <label className="btn" style={{ cursor: 'pointer', background: '#1565c0', color: '#fff' }}>
                {scanning ? '🔎 Reading…' : receiptBusy ? '⏳ Uploading…' : expForm.receiptUrl ? '📷 Replace receipt' : '📷 Photograph / attach receipt'}
                <input type="file" accept="image/*,application/pdf" capture="environment" hidden disabled={receiptBusy}
                  onChange={e => attachReceipt(e.target.files && e.target.files[0])} />
              </label>
              {expForm.receiptUrl && (
                <a href={expForm.receiptUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#2e7d32', fontWeight: 700 }}>
                  ✓ Receipt attached — view
                </a>
              )}
              {scanning && <span style={{ fontSize: 12, color: '#1565c0', fontWeight: 700 }}>🔎 Reading receipt…</span>}
              {!scanning && scanNote && <span style={{ fontSize: 12, color: '#7a5a12' }}>{scanNote}</span>}
              <button className="btn" onClick={saveExpense} disabled={expSaving}
                style={{ marginLeft: 'auto', background: '#4a5d23', color: '#fff' }}>
                {expSaving ? 'Saving…' : '💾 Save expense'}
              </button>
            </div>
          </div>

          {/* ---- period + filters ---- */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {[['mtd', 'Month to date'], ['lastmonth', 'Last month'], ['ytd', 'Year to date'],
              ['lastyear', 'Last year'], ['all', 'All time'], ['custom', 'Custom…']].map(([id, label]) => (
              <button key={id} onClick={() => setExpPeriod(id)}
                style={{
                  padding: '6px 13px', borderRadius: 16, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                  border: expPeriod === id ? '1px solid #4a5d23' : '1px solid var(--border)',
                  background: expPeriod === id ? '#4a5d23' : 'transparent',
                  color: expPeriod === id ? '#fff' : 'var(--text-secondary)'
                }}>{label}</button>
            ))}
          </div>
          {expPeriod === 'custom' && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>From</label>
              <input type="date" value={expFrom} onChange={e => setExpFrom(e.target.value)} style={inp} />
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>To</label>
              <input type="date" value={expTo} onChange={e => setExpTo(e.target.value)} style={inp} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
            <select value={expCat} onChange={e => setExpCat(e.target.value)} style={inp}>
              <option value="">All categories</option>
              {DB.EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            {expWarehouses.length > 0 && (
              <select value={expWh} onChange={e => setExpWh(e.target.value)} style={inp}>
                <option value="">All sites</option>
                {expWarehouses.map(w => <option key={w} value={w}>{w}</option>)}
              </select>
            )}
            <button className="btn" onClick={exportExpenses} disabled={!expRows.length}
              style={{ marginLeft: 'auto', background: '#17a2b8', color: 'var(--text-on-dark)' }}>⬇️ Export CSV</button>
          </div>

          {/* ---- totals ---- */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12, marginBottom: 18 }}>
            {[
              ['Total out', `$${expTotal.toFixed(2)}`, '#c62828'],
              ['Entries', expRows.length, '#1565c0'],
              ['Revenue in', `$${expVsSales.revenue.toFixed(2)}`, '#2e7d32'],
              ['Net', `$${expVsSales.net.toFixed(2)}`, expVsSales.net >= 0 ? '#2e7d32' : '#c62828']
            ].map(([l, v, c]) => (
              <div key={l} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700 }}>{l}</div>
                <div style={{ fontSize: 21, fontWeight: 800, color: c, marginTop: 3 }}>{v}</div>
              </div>
            ))}
          </div>

          {/* ---- by category ---- */}
          {expByCategory.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <h4 style={{ marginBottom: 8 }}>By category</h4>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <tbody>
                    {expByCategory.map(c => (
                      <tr key={c.name} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '7px 10px', fontWeight: 600 }}>{c.name}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>{c.count}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', width: 120 }}>
                          <div style={{ background: '#c62828', height: 6, borderRadius: 3,
                            width: `${expTotal ? Math.max(4, (c.total / expTotal) * 100) : 0}%`, marginLeft: 'auto' }} />
                        </td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700 }}>${c.total.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ---- list ---- */}
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg-surface-2)', textAlign: 'left' }}>
                  {['Date', 'Vendor', 'Category', 'Site', 'Employee', 'Ref', 'Receipt', 'Amount', ''].map(h => (
                    <th key={h} style={{ padding: '8px 10px', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>))}
                </tr>
              </thead>
              <tbody>
                {expRows.length === 0 ? (
                  <tr><td colSpan={9} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                    No expenses in this period.</td></tr>
                ) : expRows.map(e => (
                  <tr key={e.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{e.date ? new Date(e.date).toLocaleDateString() : '—'}</td>
                    <td style={{ padding: '6px 10px' }}>{e.vendor}</td>
                    <td style={{ padding: '6px 10px' }}>{e.category}</td>
                    <td style={{ padding: '6px 10px' }}>{e.warehouse}</td>
                    <td style={{ padding: '6px 10px' }}>{e.employee}</td>
                    <td style={{ padding: '6px 10px', color: 'var(--text-muted)', fontSize: 12 }}>{e.reference}</td>
                    <td style={{ padding: '6px 10px' }}>
                      {e.receiptUrl
                        ? <a href={e.receiptUrl} target="_blank" rel="noreferrer" style={{ color: '#1565c0', fontWeight: 700 }}>View</a>
                        : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                    </td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700 }}>${(parseFloat(e.amount) || 0).toFixed(2)}</td>
                    <td style={{ padding: '6px 10px' }}>
                      <button onClick={() => removeExpense(e.id)}
                        style={{ border: '1px solid var(--border)', background: '#fff', color: '#c62828',
                          borderRadius: 4, cursor: 'pointer', fontSize: 11, padding: '2px 7px', fontWeight: 700 }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Customer Purchases Tab */}
      {activeTab === 'purchases' && (
        <div>
          <h3 style={{ marginBottom: 15 }}>🧾 Customer Purchase History</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Customer</label>
              <select value={phCustomerId} onChange={e => setPhCustomerId(e.target.value)}
                style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', minWidth: 220 }}>
                <option value="all">All customers</option>
                {[...customers].sort((a, b) =>
                  String(a.company || a.customerName || '').localeCompare(String(b.company || b.customerName || ''))
                ).map(c => (
                  <option key={c.id} value={c.id}>{c.company || c.customerName || '(unnamed)'}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Search item / SKU</label>
              <input type="text" value={phSearch} onChange={e => setPhSearch(e.target.value)} placeholder="e.g. duffle, 2454"
                style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={phPaidOnly} onChange={e => setPhPaidOnly(e.target.checked)} /> Paid orders only
            </label>
            <button className="btn" onClick={exportPurchases} disabled={!purchaseRows.length}
              style={{ background: '#17a2b8', color: 'var(--text-on-dark)' }}>
              ⬇️ Export CSV
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {[
              { id: 'detail', label: 'Every purchase' },
              { id: 'summary', label: 'Totals per item' },
            ].map(v => (
              <button key={v.id} onClick={() => setPhView(v.id)}
                style={{
                  padding: '6px 14px', borderRadius: 16, cursor: 'pointer', fontSize: 13,
                  border: phView === v.id ? '1px solid #4a5d23' : '1px solid var(--border)',
                  background: phView === v.id ? '#4a5d23' : 'transparent',
                  color: phView === v.id ? '#fff' : 'var(--text-secondary)'
                }}>
                {v.label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 24, marginBottom: 12, fontSize: 14 }}>
            {phView === 'summary'
              ? <div><strong>{purchaseSummary.length}</strong> distinct items</div>
              : <div><strong>{purchaseRows.length}</strong> line items</div>}
            <div><strong>{purchaseTotals.qty}</strong> units</div>
            <div>Total: <strong>${purchaseTotals.value.toFixed(2)}</strong></div>
          </div>

          {phView === 'summary' ? (
            <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-surface-2)', textAlign: 'left' }}>
                    {['SKU', 'Item', 'Cond', 'Total Qty', 'Orders', 'Total Spent', 'Last Purchased'].map(h => (
                      <th key={h} style={{ padding: '8px 10px', whiteSpace: 'nowrap', borderBottom: '2px solid var(--border)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {purchaseSummary.length === 0 ? (
                    <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
                      No purchases found{phCustomerId !== 'all' ? ' for this customer' : ''}.
                    </td></tr>
                  ) : purchaseSummary.map((s, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 10px', color: 'var(--text-muted)' }}>{s.sku}</td>
                      <td style={{ padding: '6px 10px' }}>{s.itemName}</td>
                      <td style={{ padding: '6px 10px' }}>{s.grade}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600 }}>{s.qty}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}>{s.orderCount}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}>${s.value.toFixed(2)}</td>
                      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{s.lastDate ? new Date(s.lastDate).toLocaleDateString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg-surface-2)', textAlign: 'left' }}>
                  {['Date', 'Customer', 'Order #', 'SKU', 'Item', 'Cond', 'Qty', 'Unit', 'Total', 'Payment'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', whiteSpace: 'nowrap', borderBottom: '2px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {purchaseRows.length === 0 ? (
                  <tr><td colSpan={10} style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
                    No purchases found{phCustomerId !== 'all' ? ' for this customer' : ''}.
                  </td></tr>
                ) : purchaseRows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{r.date ? new Date(r.date).toLocaleDateString() : '—'}</td>
                    <td style={{ padding: '6px 10px' }}>{r.customerName}</td>
                    <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{r.poNumber}</td>
                    <td style={{ padding: '6px 10px', color: 'var(--text-muted)' }}>{r.sku}</td>
                    <td style={{ padding: '6px 10px' }}>{r.itemName}</td>
                    <td style={{ padding: '6px 10px' }}>{r.grade}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>{r.qty}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>${r.unitPrice.toFixed(2)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600 }}>${r.lineTotal.toFixed(2)}</td>
                    <td style={{ padding: '6px 10px' }}>{r.paymentMethod}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </div>
      )}

      {/* Custom Report Tab */}
      {activeTab === 'custom' && (
        <div>
          <div style={{ background: 'var(--bg-surface)', padding: 20, borderRadius: 8, marginBottom: 20 }}>
            <h3 style={{ marginBottom: 15 }}>Custom Report Builder</h3>
            <p style={{ color: 'var(--text-muted)', marginBottom: 15 }}>
              Filter movements by date range, type, and user.
            </p>
            
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 15,
              marginBottom: 15
            }}>
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>From Date</label>
                <input
                  type="date"
                  className="form-input"
                  value={customFilters.dateFrom}
                  onChange={e => setCustomFilters({ ...customFilters, dateFrom: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>To Date</label>
                <input
                  type="date"
                  className="form-input"
                  value={customFilters.dateTo}
                  onChange={e => setCustomFilters({ ...customFilters, dateTo: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>Type</label>
                <select
                  className="form-input"
                  value={customFilters.type}
                  onChange={e => setCustomFilters({ ...customFilters, type: e.target.value })}
                  style={{ width: '100%' }}
                >
                  <option value="">All Types</option>
                  {types.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              
              <div>
                <label style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 13 }}>User</label>
                <select
                  className="form-input"
                  value={customFilters.user}
                  onChange={e => setCustomFilters({ ...customFilters, user: e.target.value })}
                  style={{ width: '100%' }}
                >
                  <option value="">All Users</option>
                  {users.map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>
            
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={generateCustomReport}>
                Generate Report
              </button>
              
              {customData.length > 0 && (
                <button className="btn" onClick={exportCustom} style={{ background: '#17a2b8', color: 'var(--text-on-dark)' }}>
                  📥 Export CSV
                </button>
              )}
              
              <button 
                className="btn" 
                onClick={() => {
                  setCustomFilters({ dateFrom: '', dateTo: '', type: '', user: '' });
                  setCustomData([]);
                }}
                style={{ background: 'var(--btn-secondary-bg)', color: 'var(--btn-secondary-color)' }}
              >
                Clear
              </button>
            </div>
          </div>

          {customData.length > 0 && (
            <div className="data-table">
              <p style={{ marginBottom: 10, color: 'var(--text-muted)' }}>
                Found <strong>{customData.length}</strong> movements
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Item</th>
                    <th>Quantity</th>
                    <th>From</th>
                    <th>To</th>
                    <th>User</th>
                  </tr>
                </thead>
                <tbody>
                  {customData.slice(0, 200).map(m => (
                    <tr key={m.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{new Date(m.timestamp).toLocaleString()}</td>
                      <td>
                        <span style={{
                          padding: '3px 8px',
                          borderRadius: 4,
                          fontSize: 11,
                          fontWeight: 600,
                          background: m.type === 'PICK' ? '#f44336' : m.type === 'ADD' ? '#4CAF50' : '#2196F3',
                          color: 'var(--text-on-dark)'
                        }}>
                          {m.type}
                        </span>
                      </td>
                      <td>{m.itemName}</td>
                      <td>{m.quantity}</td>
                      <td>{m.fromLocation || '-'}</td>
                      <td>{m.toLocation || '-'}</td>
                      <td style={{ fontSize: 12 }}>{m.userEmail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {customData.length > 200 && (
                <p style={{ padding: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
                  Showing first 200 results. Export to CSV for full data.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
