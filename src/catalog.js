// Per-tenant catalog / wholesale price-list generator.
// Builds a dense, category-grouped flyer (branded cover sheet + price pages)
// from live inventory and prints it via the browser (Save as PDF), mirroring
// the print pattern used for invoices/estimates.

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPrice(price) {
  const n = parseFloat(price);
  if (!isFinite(n) || n <= 0) return '';
  return '$' + n.toFixed(2);
}

function initialsFrom(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'CO';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Decide whether an item belongs in the catalog.
// catalogVisibility: 'never' -> always excluded; 'always' -> always included;
// 'auto' (default) -> follows the in-stock-only option.
export function includeInCatalog(item, opts) {
  const vis = item.catalogVisibility || 'auto';
  if (vis === 'never') return false;
  if (vis === 'always') return true;
  if (opts && opts.inStockOnly) return (parseInt(item.stock) || 0) > 0;
  return true;
}

// Filter + group items by category. Returns an array of
// { category, items: [...] } sorted alphabetically by category.
export function buildCatalogGroups(items, options) {
  const opts = options || {};
  const selected = Array.isArray(opts.categories) && opts.categories.length > 0
    ? new Set(opts.categories)
    : null;

  const groups = {};
  (items || []).forEach(item => {
    if (!includeInCatalog(item, opts)) return;
    const category = (item.category && String(item.category).trim()) || 'OTHER';
    if (selected && !selected.has(category)) return;
    if (!groups[category]) groups[category] = [];
    groups[category].push(item);
  });

  return Object.keys(groups)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(category => ({
      category,
      items: groups[category].sort((a, b) =>
        String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase())
      )
    }));
}

function buildCoverHtml(branding) {
  const accent = branding.accentColor || '#4a5d23';
  const logo = branding.logoUrl
    ? `<img class="cover-logo" src="${escapeHtml(branding.logoUrl)}" alt="">`
    : `<div class="cover-logo-ph" style="background:${escapeHtml(accent)}">${escapeHtml(initialsFrom(branding.companyName))}</div>`;
  const graphic = branding.coverGraphicUrl
    ? `<img class="cover-graphic" src="${escapeHtml(branding.coverGraphicUrl)}" alt="">`
    : '';
  const addressLines = (branding.addressLines || [])
    .filter(Boolean)
    .map(l => escapeHtml(l))
    .join('<br>');
  const phone = branding.phone ? `<div class="cover-phone">${escapeHtml(branding.phone)}</div>` : '';

  return `
    <div class="sheet cover">
      <div class="cover-frame" style="border-color:${escapeHtml(accent)}">
        ${graphic}
        ${logo}
        <div class="cover-name">${escapeHtml(branding.companyName)}</div>
        ${branding.tagline ? `<div class="cover-tag">${escapeHtml(branding.tagline)}</div>` : ''}
        <div class="cover-rule" style="background:${escapeHtml(accent)}"></div>
        ${branding.title ? `<div class="cover-title" style="color:${escapeHtml(accent)}">${escapeHtml(branding.title)}</div>` : ''}
        ${addressLines ? `<div class="cover-addr">${addressLines}</div>` : ''}
        ${phone}
      </div>
    </div>`;
}

function buildRowsHtml(groups, branding, options) {
  const accent = branding.accentColor || '#4a5d23';
  const showSku = options.showSku !== false;
  const showCondition = options.showCondition !== false;
  const colCount = 2 + (showSku ? 1 : 0) + (showCondition ? 1 : 0);

  let body = '';
  groups.forEach(group => {
    body += `<tr class="catrow"><td colspan="${colCount}" style="background:${escapeHtml(accent)}">${escapeHtml(group.category)}</td></tr>`;
    group.items.forEach(item => {
      const cells = [];
      if (showSku) cells.push(`<td class="c-inv">${escapeHtml(item.partNumber || '')}</td>`);
      cells.push(`<td class="c-item">${escapeHtml(item.name || '')}</td>`);
      if (showCondition) cells.push(`<td class="c-cond">${escapeHtml(item.grade || '')}</td>`);
      cells.push(`<td class="c-price">${formatPrice(item.price)}</td>`);
      body += `<tr>${cells.join('')}</tr>`;
    });
  });

  const head = [];
  if (showSku) head.push('<th class="c-inv">INV</th>');
  head.push('<th class="c-item">ITEM</th>');
  if (showCondition) head.push('<th class="c-cond">COND</th>');
  head.push('<th class="c-price">PRICE</th>');

  return `
    <table class="pricelist">
      <thead><tr>${head.join('')}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

export function buildCatalogHtml(items, branding, options) {
  const b = branding || {};
  const opts = options || {};
  const accent = b.accentColor || '#4a5d23';
  const groups = buildCatalogGroups(items, opts);
  const generated = new Date().toLocaleDateString();
  const totalItems = groups.reduce((n, g) => n + g.items.length, 0);

  const pageHeaderCompany = escapeHtml(b.companyName || '');
  const pageHeaderTitle = escapeHtml(b.title || '');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(b.title || b.companyName || 'Catalog')}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; }
  .sheet { width: 100%; }
  .cover { page-break-after: always; padding: 18px; }
  .cover-frame { border: 3px solid ${accent}; padding: 40px 24px 48px; min-height: 9.2in;
    display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .cover-graphic { width: 100%; max-height: 2in; object-fit: contain; margin-bottom: 24px; }
  .cover-logo { max-width: 3.2in; max-height: 2.4in; object-fit: contain; margin: 12px 0 18px; }
  .cover-logo-ph { width: 1.7in; height: 1.7in; border-radius: 50%; color: #fff; display: flex;
    align-items: center; justify-content: center; font-size: 54px; font-weight: bold; margin: 12px 0 18px; letter-spacing: 2px; }
  .cover-name { font-size: 34px; font-weight: bold; letter-spacing: 1px; }
  .cover-tag { font-size: 14px; letter-spacing: 3px; color: #333; margin-top: 8px; }
  .cover-rule { width: 70px; height: 4px; margin: 26px 0 0; }
  .cover-title { font-size: 22px; font-weight: bold; margin-top: 22px; }
  .cover-addr { font-size: 13px; color: #444; margin-top: 14px; line-height: 1.7; }
  .cover-phone { font-size: 13px; color: #444; margin-top: 4px; }

  .page-head { display: flex; align-items: baseline; border-bottom: 2px solid ${accent}; padding-bottom: 6px; margin-bottom: 8px; }
  .page-head .co { font-size: 14px; font-weight: bold; }
  .page-head .ti { margin-left: auto; font-size: 11px; color: #555; }

  table.pricelist { width: 100%; border-collapse: collapse; }
  table.pricelist thead { display: table-header-group; }
  table.pricelist th { font-size: 8px; letter-spacing: 0.5px; text-align: left; color: #fff;
    background: ${accent}; padding: 3px 5px; }
  table.pricelist td { font-size: 9.5px; padding: 1.5px 5px; border-bottom: 0.5px solid #e6e6e6; vertical-align: top; }
  tr.catrow td { color: #fff; font-weight: bold; font-size: 10px; letter-spacing: 0.5px;
    padding: 3px 6px; border-bottom: none; }
  .c-inv { width: 0.55in; color: #888; }
  .c-cond { width: 0.7in; color: #555; }
  .c-price { width: 0.7in; text-align: right; white-space: nowrap; font-weight: bold; }
  tr { page-break-inside: avoid; }
  .foot { margin-top: 10px; font-size: 9px; color: #777; text-align: center; }
  @page { margin: 0.5in 0.45in; }
  @media print { .no-print { display: none; } }
</style></head>
<body>
  ${buildCoverHtml(b)}
  <div class="pricelist-page">
    <div class="page-head">
      <span class="co">${pageHeaderCompany}</span>
      <span class="ti">${pageHeaderTitle}</span>
    </div>
    ${buildRowsHtml(groups, b, opts)}
    <div class="foot">${pageHeaderCompany} &middot; ${totalItems} items &middot; generated ${escapeHtml(generated)}</div>
  </div>
</body></html>`;
}

// Open a print window with the catalog and trigger the browser print dialog.
export function printCatalog(items, branding, options) {
  const html = buildCatalogHtml(items, branding, options);
  const win = window.open('', '_blank');
  if (!win) {
    throw new Error('Popup blocked. Allow popups for this site to generate the catalog.');
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => {
    try { win.print(); } catch (e) { /* user can print manually */ }
  }, 400);
  return win;
}
