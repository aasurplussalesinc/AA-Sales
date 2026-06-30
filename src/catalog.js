// Per-tenant catalog / wholesale price-list generator.
// Builds a dense, category-grouped flyer (branded cover + price pages) from live
// inventory and opens an interactive preview where rows can be unchecked before
// printing (Save as PDF). Unchecking is print-only and does not change any item.

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

// Filter + group items by category, sorted alphabetically by category.
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
  const graphic = branding.coverGraphicUrl
    ? `<img class="cover-graphic" src="${escapeHtml(branding.coverGraphicUrl)}" alt="">`
    : '';
  const addressLines = (branding.addressLines || [])
    .filter(Boolean).map(l => escapeHtml(l)).join('<br>');
  const phone = branding.phone ? `<div class="cover-phone">${escapeHtml(branding.phone)}</div>` : '';

  return `
    <div class="sheet cover">
      <div class="cover-frame" style="border-color:${escapeHtml(accent)}">
        ${graphic}
        <div class="cover-name">${escapeHtml(branding.companyName)}</div>
        <div class="cover-rule" style="background:${escapeHtml(accent)}"></div>
        ${branding.title ? `<div class="cover-title" style="color:${escapeHtml(accent)}">${escapeHtml(branding.title)}</div>` : ''}
        ${addressLines ? `<div class="cover-addr">${addressLines}</div>` : ''}
        ${phone}
      </div>
    </div>`;
}

function buildTableHtml(groups, branding, options) {
  const accent = branding.accentColor || '#4a5d23';
  const showSku = options.showSku !== false;
  const showCondition = options.showCondition !== false;
  const showStock = options.showStock !== false;
  // columns: checkbox + [sku] + item + [cond] + [qty] + price
  const colCount = 1 + (showSku ? 1 : 0) + 1 + (showCondition ? 1 : 0) + (showStock ? 1 : 0) + 1;

  const head = ['<th class="chkcol"></th>'];
  if (showSku) head.push('<th class="c-inv">INV</th>');
  head.push('<th class="c-item">ITEM</th>');
  if (showCondition) head.push('<th class="c-cond">COND</th>');
  if (showStock) head.push('<th class="c-qty">QTY</th>');
  head.push('<th class="c-price">PRICE</th>');

  let body = '';
  groups.forEach(group => {
    body += `<tr class="catrow"><td class="chkcol"></td><td colspan="${colCount - 1}" style="background:${escapeHtml(accent)}">${escapeHtml(group.category)}</td></tr>`;
    group.items.forEach(item => {
      const cells = ['<td class="chkcol"><input type="checkbox" checked onchange="tog(this)"></td>'];
      if (showSku) cells.push(`<td class="c-inv">${escapeHtml(item.partNumber || '')}</td>`);
      cells.push(`<td class="c-item">${escapeHtml(item.name || '')}</td>`);
      if (showCondition) cells.push(`<td class="c-cond">${escapeHtml(item.grade || '')}</td>`);
      if (showStock) cells.push(`<td class="c-qty">${parseInt(item.stock) || 0}</td>`);
      cells.push(`<td class="c-price">${formatPrice(item.price)}</td>`);
      body += `<tr class="item">${cells.join('')}</tr>`;
    });
  });

  return `<table class="pricelist"><thead><tr>${head.join('')}</tr></thead><tbody>${body}</tbody></table>`;
}

export function buildCatalogHtml(items, branding, options) {
  const b = branding || {};
  const opts = options || {};
  const accent = b.accentColor || '#4a5d23';
  const groups = buildCatalogGroups(items, opts);
  const generated = new Date().toLocaleDateString();
  const totalItems = groups.reduce((n, g) => n + g.items.length, 0);
  const co = escapeHtml(b.companyName || '');
  const title = escapeHtml(b.title || '');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(b.title || b.companyName || 'Catalog')}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; }

  .toolbar { background: #2b2b2b; color: #fff; padding: 10px 16px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .toolbar .msg { font-size: 13px; color: #ddd; }
  .toolbar .count { font-size: 13px; font-weight: bold; }
  .toolbar button { font-size: 13px; padding: 7px 14px; border: none; border-radius: 6px; cursor: pointer; }
  .toolbar .print { background: ${accent}; color: #fff; font-weight: bold; }
  .toolbar .ghost { background: #555; color: #fff; }

  .sheet { background: #fff; }
  .cover { page-break-after: always; padding: 18px; }
  .cover-frame { border: 3px solid ${accent}; padding: 56px 24px; min-height: 9in;
    display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .cover-graphic { max-width: 100%; max-height: 4in; object-fit: contain; margin-bottom: 30px; }
  .cover-name { font-size: 38px; font-weight: bold; letter-spacing: 1px; }
  .cover-rule { width: 80px; height: 5px; margin: 28px 0 0; }
  .cover-title { font-size: 24px; font-weight: bold; margin-top: 24px; }
  .cover-addr { font-size: 14px; color: #444; margin-top: 18px; line-height: 1.8; }
  .cover-phone { font-size: 14px; color: #444; margin-top: 4px; }

  .page-head { display: flex; align-items: baseline; border-bottom: 2px solid ${accent}; padding-bottom: 6px; margin-bottom: 6px; }
  .page-head .co { font-size: 15px; font-weight: bold; }
  .page-head .tt { margin-left: auto; font-size: 12px; color: #555; }

  table.pricelist { width: 100%; border-collapse: collapse; }
  table.pricelist thead { display: table-header-group; }
  table.pricelist th { font-size: 10px; letter-spacing: 0.5px; text-align: left; color: #fff;
    background: ${accent}; padding: 4px 6px; }
  table.pricelist td { font-size: 12px; padding: 3px 6px; border-bottom: 0.5px solid #e6e6e6; vertical-align: top; }
  tr.catrow td { color: #fff; font-weight: bold; font-size: 13px; letter-spacing: 0.5px;
    padding: 6px 8px; border-bottom: none; text-transform: uppercase; }
  .chkcol { width: 26px; text-align: center; }
  .c-inv { width: 0.6in; color: #888; }
  .c-cond { width: 0.7in; color: #555; }
  .c-qty { width: 0.55in; text-align: right; color: #444; }
  .c-price { width: 0.75in; text-align: right; white-space: nowrap; font-weight: bold; }
  tr.item { page-break-inside: avoid; }
  tr.item.x td:not(.chkcol) { opacity: 0.3; text-decoration: line-through; }
  .foot { margin-top: 10px; font-size: 10px; color: #777; text-align: center; }

  @media screen {
    body { background: #525659; }
    .doc { padding: 20px 0; }
    .sheet { width: 8.5in; margin: 0 auto 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.4); }
    .pricelist-page { width: 8.5in; margin: 0 auto 16px; background: #fff; padding: 0.5in 0.45in; box-shadow: 0 2px 10px rgba(0,0,0,0.4); }
    .toolbar { position: sticky; top: 0; z-index: 10; }
  }
  @media print {
    .toolbar { display: none !important; }
    .chkcol { display: none !important; }
    tr.item.x { display: none !important; }
    tr.catrow.x { display: none !important; }
    @page { margin: 0.5in 0.45in; }
  }
</style></head>
<body>
  <div class="toolbar">
    <span class="msg">Uncheck any rows you don't want, then print.</span>
    <span class="count" id="count">${totalItems} of ${totalItems} items</span>
    <button class="ghost" onclick="all(true)">Select all</button>
    <button class="ghost" onclick="all(false)">Clear all</button>
    <button class="print" onclick="doPrint()">Print / Save PDF</button>
  </div>
  <div class="doc">
    ${buildCoverHtml(b)}
    <div class="pricelist-page">
      <div class="page-head"><span class="co">${co}</span><span class="tt">${title}</span></div>
      ${buildTableHtml(groups, b, opts)}
      <div class="foot">${co} &middot; generated ${escapeHtml(generated)}</div>
    </div>
  </div>
  <script>
    var TOTAL = ${totalItems};
    function refresh(){
      var on = document.querySelectorAll('tr.item:not(.x)').length;
      document.getElementById('count').textContent = on + ' of ' + TOTAL + ' items';
    }
    function tog(cb){ cb.closest('tr').classList.toggle('x', !cb.checked); refresh(); }
    function all(state){
      document.querySelectorAll('tr.item input[type=checkbox]').forEach(function(cb){
        cb.checked = state; cb.closest('tr').classList.toggle('x', !state);
      });
      refresh();
    }
    function hideEmptyCategories(){
      var rows = Array.prototype.slice.call(document.querySelectorAll('tr.catrow, tr.item'));
      var cat = null, anyOn = false;
      rows.forEach(function(r){
        if (r.classList.contains('catrow')) {
          if (cat) cat.classList.toggle('x', !anyOn);
          cat = r; anyOn = false;
        } else if (!r.classList.contains('x')) {
          anyOn = true;
        }
      });
      if (cat) cat.classList.toggle('x', !anyOn);
    }
    function doPrint(){ hideEmptyCategories(); window.print(); }
    window.onbeforeprint = hideEmptyCategories;
  </script>
</body></html>`;
}

// Open the interactive catalog preview in a new window.
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
  return win;
}
