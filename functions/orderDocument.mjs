/**
 * SkidSling - the Estimate / Invoice document.
 *
 * THIS IS THE ONLY COPY. The Purchase Orders screen imports it for the print
 * button, and the Cloud Function imports it to render the same document into
 * an email. Moved here verbatim from PurchaseOrders.jsx rather than retyped,
 * so what a customer receives by email is byte-for-byte what prints from the UI.
 *
 *   renderOrderDocument(order, 'estimate' | 'invoice', {
 *     items,          // catalogue rows, used only to fall back to an item's grade
 *     organization,   // the org doc
 *     branding        // (org, {accent}) => { logo, details }
 *   }) -> full HTML document string
 */

// Every value in this template comes from a tenant's own records - order notes,
// customer names, item descriptions - and the result is rendered by headless
// Chrome server-side. Unescaped, a tenant could put script in an order note and
// have it run inside our own browser process. Escape at every interpolation;
// there is no safe field here.
export function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A tagged template that escapes every interpolation by default. The print
// screens build large HTML strings out of order, customer and item text, and
// wrapping each value by hand means one missed value is one hole - so the
// default is escaped and the exceptions are marked. Wrap a value in raw() to
// say "this is already HTML": a nested h`` fragment, a stylesheet, or something
// brandingHtml()/refHtml() escaped on the way out.
export function raw(value) {
  return { __rawHtml: value == null ? '' : String(value) };
}
export function h(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += (v && typeof v === 'object' && '__rawHtml' in v) ? v.__rawHtml : escapeHtml(v);
    out += strings[i + 1];
  }
  return out;
}

export function brandingFrom(org) {
  const o = org || {};
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
}

export function brandingHtml(org, opts) {
  const b = brandingFrom(org);
  const accent = (opts && opts.accent) || '#333';
  const esc = escapeHtml;
  const logo = b.logoUrl
    ? '<img src="' + esc(b.logoUrl) + '" class="logo" alt="" />'
    : (b.name ? '<div style="font-size:18px;font-weight:bold;color:' + esc(accent) + '">' + esc(b.name) + '</div>' : '');
  const details = [];
  if (b.name) details.push('<strong>' + esc(b.name) + '</strong>');
  if (b.addressLines.length) details.push(b.addressLines.map(esc).join('<br>'));
  if (b.phone) details.push(esc(b.phone));
  return { logo, details: details.join('<br>') };
}

// Also used directly by the pick list, packing lists and shipping labels in
// PurchaseOrders.jsx - these moved here with the estimate template, so they are
// exported rather than kept private to renderOrderDocument().
export const refHtml = (order, opts = {}) => {
  const cpo = (order.customerPO || '').trim();
  const mine = order.poNumber || '';
  const size = opts.size || 'lg';   // 'lg' = document header, 'sm' = label
  if (!cpo) {
    return `<div class="ref-main ref-${size}">${escapeHtml(mine)}</div>`;
  }
  return `
    <div class="ref-block">
      <div class="ref-label">CUSTOMER PO</div>
      <div class="ref-main ref-${size}">${escapeHtml(cpo)}</div>
      <div class="ref-ours">Our Ref: ${escapeHtml(mine)}</div>
    </div>`;
};

export const refStyles = `
  .ref-block { line-height: 1.15; }
  .ref-label { font-size: 9px; letter-spacing: .12em; font-weight: 800; color: #777; text-transform: uppercase; }
  .ref-main { font-weight: 800; letter-spacing: .02em; }
  .ref-main.ref-lg { font-size: 22px; }
  .ref-main.ref-sm { font-size: 15px; }
  .ref-ours { font-size: 11px; color: #666; font-weight: 600; margin-top: 1px; }
`;

export function renderOrderDocument(order, printType, ctx) {
const { items = [], organization = null, branding } = ctx || {};
  const isEstimate = printType === 'estimate';
  const accentColor = isEstimate ? '#1976d2' : '#4a5d23';
  const lineItems = (order.items || []).map(item => {
    const qty = isEstimate ? (item.quantity || 0) : (item.qtyShipped || 0);
    const price = parseFloat(item.unitPrice) || 0;
    const resolvedGrade = item.grade || (items.find(it => it.id === item.itemId)?.grade) || '';
    return { ...item, displayQty: qty, displayTotal: qty * price, resolvedGrade };
  });
  const subtotal = lineItems.reduce((sum, i) => sum + i.displayTotal, 0);
  const tax = parseFloat(order.tax) || 0;
  const shipping = parseFloat(order.shipping) || 0;
  const credit = parseFloat(order.credit) || 0;
  const discount = parseFloat(order.discount) || 0;
  const total = subtotal + tax + shipping - credit - discount;
  const formatFullDate = (ts) => { 
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts); 
    const m = ['January','February','March','April','May','June','July','August','September','October','November','December']; 
    return m[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); 
  };
  // Use invoiceDate if set, otherwise use createdAt
  const displayDate = order.invoiceDate ? formatFullDate(order.invoiceDate) : formatFullDate(order.createdAt);
  const printContent = `<!DOCTYPE html><html><head><title>${isEstimate ? 'Estimate' : 'Invoice'} - ${escapeHtml(order.poNumber)}</title>
    <style>${refStyles}
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Segoe UI',Arial,sans-serif;padding:20px 25px;max-width:800px;margin:0 auto;color:#333;line-height:1.3;font-size:11px}
      .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:15px;padding-bottom:10px;border-bottom:2px solid ${accentColor}}
      .logo{max-width:120px;max-height:60px}
      .company-details{text-align:right;font-size:10px;color:#555}
      .company-details strong{font-size:13px;color:#333;display:block;margin-bottom:2px}
      .doc-title{font-size:22px;font-weight:300;color:${accentColor};letter-spacing:1px;margin-bottom:2px}
      .doc-number{font-size:14px;color:#000;font-weight:700}
      .info-section{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin:15px 0}
      .info-box{background:#f8f9fa;padding:10px 12px;border-radius:4px;border-left:3px solid ${accentColor}}
      .info-box h3{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:5px}
      .info-box p{margin:2px 0;font-size:11px}
      .info-box .highlight{font-size:13px;font-weight:600;color:#333}
      table{width:100%;border-collapse:collapse;margin-bottom:15px}
      th{background:${accentColor};color:white;padding:6px 8px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.3px}
      td{padding:6px 8px;border-bottom:1px solid #e0e0e0;font-size:11px;vertical-align:top}
      .totals-section{display:flex;justify-content:flex-end}
      .totals-box{width:200px;background:#f8f9fa;border-radius:4px;padding:10px 12px;border:1px solid ${accentColor}}
      .totals-row{display:flex;justify-content:space-between;padding:4px 0;font-size:11px}
      .totals-row.final{border-top:2px solid ${accentColor};margin-top:6px;padding-top:8px;font-size:14px;font-weight:700;color:${accentColor}}
      .notes{background:#fffde7;padding:10px;border-radius:4px;margin-top:15px;border-left:3px solid #ffc107;font-size:10px}
      .notes h3{font-size:9px;text-transform:uppercase;color:#888;margin-bottom:4px}
      .footer{margin-top:20px;padding-top:10px;border-top:1px solid #e0e0e0;text-align:center;font-size:10px;color:#888}
      @media print{body{padding:15px}@page{margin:0.3in}}
    </style></head><body>
    <div class="header"><div>${branding(organization, { accent: accentColor }).logo}</div><div class="company-details">${branding(organization, { accent: accentColor }).details}</div></div>
    <div class="doc-title">${isEstimate ? 'ESTIMATE' : 'INVOICE'}</div><div class="doc-number">${refHtml(order)}</div>
    <div class="info-section"><div class="info-box"><h3>Bill To</h3><p class="highlight">${escapeHtml(order.customerName)}</p>${order.customerContact ? '<p>Attn: ' + escapeHtml(order.customerContact) + '</p>' : ''}${order.customerAddress ? '<p>' + escapeHtml(order.customerAddress) + '</p>' : ''}${order.customerPhone ? '<p>' + escapeHtml(order.customerPhone) + '</p>' : ''}${order.customerEmail ? '<p>' + escapeHtml(order.customerEmail) + '</p>' : ''}</div>${order.shipToAddress ? '<div class="info-box"><h3>Ship To</h3>' + (order.shipToCompany ? '<p class="highlight">' + escapeHtml(order.shipToCompany) + '</p>' : '') + '<p>' + escapeHtml(order.shipToAddress).replace(/\n/g, '<br>') + '</p></div>' : ''}<div class="info-box"><h3>Details</h3><p><strong>Date:</strong> ${displayDate}</p><p><strong>Terms:</strong> ${escapeHtml(order.terms || 'Net 30')}</p>${order.customerPO ? '<p><strong>Customer PO:</strong> ' + escapeHtml(order.customerPO) + '</p>' : ''}</div></div>
    <table><thead><tr><th style="width:60px">SKU</th><th>Description</th>${isEstimate ? '<th style="text-align:center;width:50px">Qty</th>' : '<th style="text-align:center;width:50px">Ord</th><th style="text-align:center;width:50px">Ship</th>'}<th style="text-align:right;width:70px">Unit Price</th><th style="text-align:right;width:70px">Amount</th></tr></thead><tbody>${lineItems.map(item => '<tr><td style="font-size:10px;color:#000;font-weight:700">' + escapeHtml(item.partNumber || '-') + '</td><td style="font-weight:500">' + escapeHtml(item.itemName) + (item.resolvedGrade ? '<div style="font-size:9px;color:' + accentColor + ';font-weight:600;margin-top:1px">Condition: ' + escapeHtml(item.resolvedGrade) + '</div>' : '') + (item.notes ? '<div style="font-size:9px;color:#666;font-style:italic">' + escapeHtml(item.notes) + '</div>' : '') + '</td>' + (isEstimate ? '<td style="text-align:center">' + (item.quantity || 0) + '</td>' : '<td style="text-align:center">' + (item.quantity || 0) + '</td><td style="text-align:center;font-weight:bold">' + (item.qtyShipped || 0) + '</td>') + '<td style="text-align:right">$' + (item.unitPrice || 0).toFixed(2) + '</td><td style="text-align:right;font-weight:500">$' + item.displayTotal.toFixed(2) + '</td></tr>').join('')}</tbody></table>
    <div class="totals-section"><div class="totals-box"><div class="totals-row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>${tax > 0 ? '<div class="totals-row"><span>Tax</span><span>$' + tax.toFixed(2) + '</span></div>' : ''}${shipping > 0 ? '<div class="totals-row"><span>Shipping</span><span>$' + shipping.toFixed(2) + '</span></div>' : (order.shippingBilledToCustomer ? '<div class="totals-row" style="color:#555;font-size:0.9em"><span>Shipping</span><span>Billed to your carrier account</span></div>' : '')}${credit > 0 ? '<div class="totals-row" style="color:#2e7d32"><span>Credit</span><span>-$' + credit.toFixed(2) + '</span></div>' : ''}${discount > 0 ? '<div class="totals-row" style="color:#2e7d32"><span>Discount</span><span>-$' + discount.toFixed(2) + '</span></div>' : ''}<div class="totals-row final"><span>Total</span><span>$${total.toFixed(2)}</span></div></div></div>
    <div style="margin-top:10px;font-size:9px;color:#666;font-style:italic;text-align:right">Payments by credit card are subject to a 3.5% processing fee</div>
    ${order.notes ? '<div class="notes"><h3>Notes</h3><p>' + escapeHtml(order.notes) + '</p></div>' : ''}
    <div class="footer">Thank you for your business!${organization?.email ? '<br>Questions? Contact us at ' + escapeHtml(organization.email) : ''}</div></body></html>`;
  return printContent;
}
