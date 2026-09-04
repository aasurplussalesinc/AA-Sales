/**
 * SkidSling - MCP (Model Context Protocol) endpoint
 *
 * Exposes the same inventory data as exports.api, but as MCP tools so that
 * Claude (and any other MCP client) can reach it natively from any device -
 * phone included - with no browser or local machine in the loop.
 *
 * Transport: Streamable HTTP, stateless (no Mcp-Session-Id).
 *   POST   /  -> JSON-RPC in, application/json out (202 + empty for notifications)
 *   GET    /  -> 405 (no server-initiated SSE stream)
 *   DELETE /  -> 405 (no sessions to terminate)
 *
 * Auth: reuses the existing apiKeys collection via resolveApiKey(). Add the
 * connector in Claude with auth type "None" and a request header of
 *   Authorization: Bearer <key>
 * OAuth can be layered on later without touching the tool layer below.
 */

var INV = require('./inventory');
var ORD = require('./orders');

module.exports = function createMcpFunction(deps) {
  var functions = deps.functions;
  var db = deps.db;
  var resolveApiKey = deps.resolveApiKey;
  var publicItem = deps.publicItem;

  var SERVER_NAME = 'skidsling';
  var SERVER_VERSION = '1.0.0';
  var LATEST_PROTOCOL = '2025-11-25';
  var SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
  var MAX_RESULT_CHARS = 140000;

  var INSTRUCTIONS = [
    'SkidSling inventory for AA Surplus Sales Inc., a military surplus wholesaler.',
    '',
    'Read this before interpreting any data:',
    '',
    'GRADE is the most important field after SKU. The same product exists in several',
    'conditions and they are different products at different prices: NEW (unissued),',
    '#1 (good used), #2 (lower grade used). Never merge grades in a count or a',
    'recommendation. "How many assault pouches" almost always means "how many of each',
    'grade". Note that the grade field is frequently blank with the grade written into',
    'the item name instead - say so rather than silently guessing.',
    '',
    'LOCATION CODES look like W4-R1-F2: W4 warehouse, R1 rack, F bay/column, 2 shelf.',
    'One item can sit on SEVERAL shelves at once. The `locations` array is the truth;',
    '`location` is only the largest single holding. When asked where something is,',
    'report every shelf and its quantity. STAGING means received but not yet put away.',
    '',
    'QUANTITIES are what is physically on the shelf. Surplus moves in irregular lots -',
    'a number that looks odd usually is odd, not a typo. Never estimate, round, or',
    'infer a quantity you did not read from a tool result.',
    '',
    'If `quantity` does not equal the sum of the `locations` quantities, that is a real',
    'data problem. Report it. Do not fix it.',
    '',
    'Never adjust a quantity unless the user explicitly asked for that change in that',
    'message. "Check the count on 2091" means look, not fix. Always pass a reason.'
  ].join('\n');

  // ---------------------------------------------------------------- tools ----

  var TOOLS = [
    {
      name: 'check_connection',
      title: 'Check Connection',
      description: 'Confirm the API key works and report which organization and scope it is bound to. Use this first if anything looks wrong.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Check Connection', readOnlyHint: true }
    },
    {
      name: 'search_items',
      title: 'Search Inventory Items',
      description: 'Search inventory. `search` words match in any order across name, SKU, grade and category. `location` returns everything on one shelf (checks every shelf an item sits on, not just its largest). `lowStock` returns items at or below their reorder threshold - note that only items with a threshold set can ever match. Use `offset` to page through the full catalogue.',
      inputSchema: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Exact SKU / part number. Much cheaper than a text search - use this whenever you know the SKU.' },
          search: { type: 'string', description: 'Words to match in any order, e.g. "pouch usmc"' },
          location: { type: 'string', description: 'Shelf code, e.g. W4-R1-F2 or STAGING. Indexed and cheap, and it finds items whose primary shelf is elsewhere but that still hold stock here.' },
          lowStock: { type: 'boolean', description: 'Only items at or below their reorder threshold' },
          offset: { type: 'integer', minimum: 0, description: 'Items to skip, for paging (default 0)' },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max items to return (default 100, cap 500)' }
        },
        additionalProperties: false
      },
      annotations: { title: 'Search Inventory Items', readOnlyHint: true }
    },
    {
      name: 'get_item',
      title: 'Get One Item',
      description: 'Fetch a single item by its id, including every shelf it sits on.',
      inputSchema: {
        type: 'object',
        properties: { itemId: { type: 'string', description: 'The item id returned by search_items' } },
        required: ['itemId'],
        additionalProperties: false
      },
      annotations: { title: 'Get One Item', readOnlyHint: true }
    },
    {
      name: 'list_locations',
      title: 'List Shelves',
      description: 'List warehouse shelves with live unit totals and item counts, largest first.',
      inputSchema: {
        type: 'object',
        properties: {
          includeEmpty: { type: 'boolean', description: 'Include shelves holding zero units (default false)' },
          offset: { type: 'integer', minimum: 0, description: 'Shelves to skip, for paging (default 0)' },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max shelves to return (default 100)' }
        },
        additionalProperties: false
      },
      annotations: { title: 'List Shelves', readOnlyHint: true }
    },
    {
      name: 'list_orders',
      title: 'List Orders',
      description: 'List purchase orders, newest first. Filter by status: draft, confirmed, paid, packed, shipped, cancelled.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Exact status to filter by' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max orders to return (default 50)' }
        },
        additionalProperties: false
      },
      annotations: { title: 'List Orders', readOnlyHint: true }
    },
    {
      name: 'find_data_problems',
      title: 'Find Data Problems',
      description: 'Scan the whole catalogue for integrity problems and report them without changing anything: items whose quantity does not match the sum of their shelf quantities, items with stock but no shelf assigned, duplicate SKUs, and inconsistent grade values.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max examples per problem type (default 25)' } },
        additionalProperties: false
      },
      annotations: { title: 'Find Data Problems', readOnlyHint: true }
    },
    {
      name: 'update_draft_order',
      title: 'Update Draft Order',
      description: 'Revise an order that is still a draft - quantities, customer details, terms, notes, tax or shipping. Only drafts can be changed; an order that has been confirmed, picked, packed or shipped is a record of what happened and is edited in SkidSling instead. Passing `lines` replaces the whole line list, so include every line you want to keep. Use this when a customer comes back with quantities on a quote.',
      inputSchema: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'The order id' },
          customerName: { type: 'string' }, customerContact: { type: 'string' },
          customerEmail: { type: 'string' }, customerPhone: { type: 'string' },
          customerAddress: { type: 'string' },
          shipToAddress: { type: 'string' }, shipToCompany: { type: 'string' },
          customerPO: { type: 'string' },
          terms: { type: 'string', description: 'Due on Receipt, Net 15, Net 30, Net 45, Net 60 or Net 90' },
          notes: { type: 'string', description: 'Pass an empty string to clear the notes block from the printed document.' },
          dueDate: { type: 'string' }, invoiceDate: { type: 'string' },
          tax: { type: 'number' }, shipping: { type: 'number' },
          credit: { type: 'number' }, discount: { type: 'number' },
          lines: {
            type: 'array', minItems: 1, maxItems: 200,
            description: 'Replaces every line on the order. Same shape as create_draft_order.',
            items: {
              type: 'object',
              properties: {
                itemId: { type: 'string' }, description: { type: 'string' },
                quantity: { type: 'integer', minimum: 1 },
                unitPrice: { type: 'number' }, quotedPrice: { type: 'number' },
                notes: { type: 'string' }
              },
              required: ['quantity'], additionalProperties: false
            }
          }
        },
        required: ['orderId'],
        additionalProperties: false
      },
      annotations: { title: 'Update Draft Order', readOnlyHint: false, destructiveHint: true }
    },
    {
      name: 'get_order_document',
      title: 'Get Order Estimate or Invoice',
      description: 'Render an order as the estimate (quote) or invoice document, exactly as it prints from the Purchase Orders screen. Returns the full HTML, ready to email. For a PDF attachment use the REST route GET /orders/:id/document?type=estimate&format=pdf - the PDF is not returned through MCP because a base64 document would fill most of a tool result. An estimate prices the quantities ordered; an invoice prices what has actually shipped, so a draft that has not been picked has nothing to invoice yet.',
      inputSchema: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'The order id returned by create_draft_order or list_orders' },
          type: { type: 'string', enum: ['estimate', 'invoice'], description: 'estimate (quote) or invoice. Defaults to estimate.' }
        },
        required: ['orderId'],
        additionalProperties: false
      },
      annotations: { title: 'Get Order Estimate or Invoice', readOnlyHint: true }
    },
    {
      name: 'search_customers',
      title: 'Search Customers',
      description: 'Find an existing customer by business name, contact person or email. Use orderCustomerName and orderCustomerContact when building an order - they are already mapped the way the app maps them. Use this before creating an order so it attaches to the right customer record instead of creating a near-duplicate.',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Name, contact name, or email address' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max customers to return (default 50)' }
        },
        additionalProperties: false
      },
      annotations: { title: 'Search Customers', readOnlyHint: true }
    },
    {
      name: 'create_draft_order',
      title: 'Create Draft Order',
      description: 'Create a purchase order as a DRAFT from lines you have already matched to catalogue items. It never goes past draft - nothing is reserved, picked or shipped until a person presses Confirm & Pick in SkidSling. The catalogue price is always used; a price quoted by the customer is recorded on the line for the paper trail but never becomes the invoice price. Items with too little stock are still included so the order shows what was actually asked for. Confirm the full line list with the user before calling this.',
      inputSchema: {
        type: 'object',
        properties: {
          customerName: { type: 'string', description: 'Required. Business name on the order.' },
          customerId: { type: 'string', description: 'Id from search_customers, when the customer already exists' },
          customerContact: { type: 'string', description: 'Person to attention the order to' },
          customerEmail: { type: 'string' },
          customerPhone: { type: 'string' },
          customerAddress: { type: 'string', description: 'Billing address as one string' },
          shipToAddress: { type: 'string', description: 'Ship-to address, if different from billing' },
          shipToCompany: { type: 'string', description: 'Recipient business name for drop-shipping' },
          customerPO: { type: 'string', description: 'The customer\'s own PO number, if they gave one' },
          terms: { type: 'string', description: 'Due on Receipt, Net 15, Net 30, Net 45, Net 60 or Net 90. Defaults to Net 30.' },
          notes: { type: 'string' },
          sourceRef: { type: 'string', description: 'A stable id for what this order came from, e.g. a Gmail message id. Creating a second order with the same sourceRef is refused, so one email cannot become two orders.' },
          lines: {
            type: 'array', minItems: 1, maxItems: 200,
            description: 'Order lines. Give itemId for anything matched to the catalogue; use description only for a charge or something with no catalogue match.',
            items: {
              type: 'object',
              properties: {
                itemId: { type: 'string', description: 'Catalogue item id from search_items' },
                description: { type: 'string', description: 'Free text, for a line with no catalogue item behind it' },
                quantity: { type: 'integer', minimum: 1, description: 'Quantity ordered' },
                unitPrice: { type: 'number', description: 'Only for free-text lines; catalogue lines always use the catalogue price' },
                quotedPrice: { type: 'number', description: 'The price the customer quoted, when it differs. Recorded for the paper trail, not charged.' },
                notes: { type: 'string' }
              },
              required: ['quantity'],
              additionalProperties: false
            }
          }
        },
        required: ['customerName', 'lines'],
        additionalProperties: false
      },
      annotations: { title: 'Create Draft Order', readOnlyHint: false, destructiveHint: true }
    },
    {
      name: 'adjust_item_quantity',
      title: 'Adjust Item Quantity',
      description: 'Change how much of an item sits on a shelf. `delta` adds (positive) or removes (negative); `quantity` sets an absolute amount. `location` says which shelf - required when the item sits on more than one, and it may name a shelf the item is not on yet, which adds stock there. The item total and primary location are recalculated from the shelves afterwards. Only use this when the user explicitly asked for this change in this message - checking a count is not permission to change it. Requires a write-scoped key.',
      inputSchema: {
        type: 'object',
        properties: {
          itemId: { type: 'string', description: 'The item id returned by search_items' },
          delta: { type: 'integer', description: 'Add or remove this many, e.g. -5 or 12' },
          quantity: { type: 'integer', minimum: 0, description: 'Set the shelf to this absolute amount' },
          location: { type: 'string', description: 'Shelf code, e.g. W4-R1-B2 or STAGING. Required when the item sits on several shelves; may be a new shelf to add stock there.' },
          reason: { type: 'string', description: 'Why - lands in the audit log, e.g. "damaged" or "cycle count"' }
        },
        required: ['itemId', 'reason'],
        additionalProperties: false
      },
      annotations: { title: 'Adjust Item Quantity', readOnlyHint: false, destructiveHint: true }
    }
  ];

  // -------------------------------------------------------------- helpers ----

  // Firestore has no full-text index, so a free-text search must read the
  // collection. Reading 2,000 documents for every question an agent asks is
  // the real cost problem. Three things keep it down:
  //   1. Exact lookups (sku, id) and low-stock use indexed queries and read
  //      only what they return.
  //   2. Anything that genuinely needs the whole collection reads it once and
  //      reuses it for a minute, so a back-and-forth conversation costs one
  //      scan, not one per question.
  //   3. Every result reports documentsRead so the cost is never invisible.
  // Quantities an agent will quote are always read live - see freshItem().
  var itemCache = {};
  var CACHE_TTL_MS = 60 * 1000;

  function invalidateCache(orgId) { delete itemCache[orgId]; }

  async function scanItems(auth) {
    var now = Date.now();
    var hit = itemCache[auth.orgId];
    if (hit && (now - hit.at) < CACHE_TTL_MS) {
      return { items: hit.items, documentsRead: 0, cacheAgeSeconds: Math.round((now - hit.at) / 1000) };
    }
    var snap = await db.collection('items').where('orgId', '==', auth.orgId).get();
    var items = snap.docs.map(function (d) { return publicItem(d.id, d.data()); });
    itemCache[auth.orgId] = { items: items, at: now };
    return { items: items, documentsRead: snap.size, cacheAgeSeconds: 0 };
  }

  function shelfSum(item) {
    return (item.locations || []).reduce(function (a, e) {
      return a + (parseInt(e.qty) || 0);
    }, 0);
  }

  function onShelf(item, code) {
    return (item.location || '').toUpperCase() === code ||
      (item.locations || []).some(function (e) { return String(e.code || '').toUpperCase() === code; });
  }

  function textMatch(item, search) {
    var tokens = search.split(/[^a-z0-9#]+/).filter(Boolean);
    var hay = (item.sku + ' ' + item.name + ' ' + item.grade + ' ' + item.category).toLowerCase();
    return tokens.every(function (t) { return hay.indexOf(t) !== -1; });
  }

  function paginate(list, args) {
    var offset = Math.max(parseInt(args.offset) || 0, 0);
    var limit = Math.min(Math.max(parseInt(args.limit) || 100, 1), 500);
    var page = list.slice(offset, offset + limit);
    return { offset: offset, page: page, hasMore: offset + page.length < list.length };
  }

  // ----------------------------------------------------------- tool calls ----

  async function runTool(name, args, auth) {
    args = args || {};

    if (name === 'check_connection') {
      return { ok: true, org: auth.orgId, scope: auth.scope, key: auth.label || auth.keyId };
    }

    if (name === 'search_items') {
      var search = String(args.search || '').toLowerCase().trim();
      var wantLoc = args.location ? INV.canonicalLocationCode(String(args.location)) : '';
      var base = db.collection('items').where('orgId', '==', auth.orgId);

      // --- exact SKU: indexed, reads only the matching documents -----------
      if (args.sku) {
        var skuSnap = await base.where('partNumber', '==', String(args.sku).trim()).get();
        var skuItems = skuSnap.docs.map(function (d) { return publicItem(d.id, d.data()); });
        return {
          matched: skuItems.length, returned: skuItems.length, hasMore: false,
          documentsRead: skuSnap.size, live: true,
          note: skuItems.length > 1
            ? 'More than one entry shares this SKU - they are usually different grades. Report them separately.'
            : undefined,
          items: skuItems
        };
      }

      // --- low stock: indexed on the threshold, not a full scan ------------
      if (args.lowStock === true) {
        var thrSnap = await base.where('lowStockThreshold', '>', 0).get();
        var low = thrSnap.docs
          .map(function (d) { return publicItem(d.id, d.data()); })
          .filter(function (it) { return it.quantity <= it.lowStockThreshold; });
        if (search) low = low.filter(function (it) { return textMatch(it, search); });
        if (wantLoc) low = low.filter(function (it) { return onShelf(it, wantLoc); });
        var lp = paginate(low, args);
        return {
          matched: low.length, offset: lp.offset, returned: lp.page.length, hasMore: lp.hasMore,
          documentsRead: thrSnap.size, live: true,
          note: 'Only items with a reorder threshold set can ever appear here. Items with no threshold are invisible to this filter, so a short list is not proof that nothing is low.',
          items: lp.page
        };
      }

      // --- no filters: let Firestore cap the read --------------------------
      if (!search && !wantLoc) {
        var lim = Math.min(Math.max(parseInt(args.limit) || 100, 1), 500);
        var off = Math.max(parseInt(args.offset) || 0, 0);
        if (off === 0) {
          var pageSnap = await base.limit(lim).get();
          return {
            matched: null, offset: 0, returned: pageSnap.size, hasMore: pageSnap.size === lim,
            documentsRead: pageSnap.size, live: true,
            note: 'Unfiltered listing - matched is not counted here because the catalogue was never fully read. Use find_data_problems or a filter if you need a total.',
            items: pageSnap.docs.map(function (d) { return publicItem(d.id, d.data()); })
          };
        }
        // Paging past the first page needs the ordered set.
        var allA = await scanItems(auth);
        var pa = paginate(allA.items, args);
        return {
          matched: allA.items.length, offset: pa.offset, returned: pa.page.length, hasMore: pa.hasMore,
          documentsRead: allA.documentsRead, cacheAgeSeconds: allA.cacheAgeSeconds, items: pa.page
        };
      }

      // --- shelf lookup: indexed AND complete ------------------------------
      // locationCodes mirrors every shelf an item holds stock on, so one
      // array-contains query finds split holdings too. Querying the primary
      // `location` field instead is cheaper-looking but silently misses an
      // item whose largest holding is on a different shelf.
      if (wantLoc) {
        var locSnap = await base.where('locationCodes', 'array-contains', wantLoc).get();
        var onShelfItems = locSnap.docs.map(function (d) { return publicItem(d.id, d.data()); });
        if (search) onShelfItems = onShelfItems.filter(function (it) { return textMatch(it, search); });
        var sp = paginate(onShelfItems, args);
        return {
          matched: onShelfItems.length, offset: sp.offset, returned: sp.page.length, hasMore: sp.hasMore,
          documentsRead: locSnap.size, live: true,
          shelf: wantLoc,
          note: 'Includes items whose primary location is a different shelf but that still hold stock here. Each item\'s `locations` array shows every shelf it sits on.',
          items: sp.page
        };
      }

      // --- text search and/or shelf lookup ---------------------------------
      // A shelf answer has to be complete: an item can sit on several shelves
      // and the `locations` array is the only truth, so querying the indexed
      // primary `location` field alone would silently miss split holdings.
      // The scan is cached, so asking several questions in a row is one read.
      var all = await scanItems(auth);
      var found = all.items.filter(function (it) { return textMatch(it, search); });
      var pg = paginate(found, args);
      return {
        matched: found.length, offset: pg.offset, returned: pg.page.length, hasMore: pg.hasMore,
        documentsRead: all.documentsRead, cacheAgeSeconds: all.cacheAgeSeconds,
        items: pg.page
      };
    }

    if (name === 'get_item') {
      var ref = await db.collection('items').doc(String(args.itemId)).get();
      if (!ref.exists) throw new Error('Item not found: ' + args.itemId);
      var data = ref.data();
      if (data.orgId !== auth.orgId) throw new Error('Item not found: ' + args.itemId);
      var item = publicItem(ref.id, data);
      return {
        item: item,
        shelfSum: shelfSum(item),
        quantityMatchesShelves: shelfSum(item) === item.quantity,
        documentsRead: 1,
        live: true
      };
    }

    if (name === 'list_locations') {
      var lsnap = await db.collection('locations').where('orgId', '==', auth.orgId).get();
      var scan2 = await scanItems(auth);
      var items2 = scan2.items;
      var totals = {};
      items2.forEach(function (it) {
        (it.locations || []).forEach(function (e) {
          var c = String(e.code || '').toUpperCase();
          var q = parseInt(e.qty) || 0;
          if (!c || q <= 0) return;
          if (!totals[c]) totals[c] = { total: 0, items: 0 };
          totals[c].total += q;
          totals[c].items += 1;
        });
      });
      var locs = lsnap.docs.map(function (d) {
        var l = d.data();
        var code = (l.locationCode || '').toUpperCase();
        var t = totals[code] || { total: 0, items: 0 };
        return { code: l.locationCode || '', warehouse: l.warehouse || '', rack: l.rack || '',
                 bay: l.letter || '', shelf: l.shelf || '', totalUnits: t.total, itemCount: t.items };
      });
      if (args.includeEmpty !== true) locs = locs.filter(function (l) { return l.totalUnits > 0; });
      locs.sort(function (a, b) { return b.totalUnits - a.totalUnits; });
      var off2 = Math.max(parseInt(args.offset) || 0, 0);
      var lim2 = Math.min(Math.max(parseInt(args.limit) || 100, 1), 500);
      var page2 = locs.slice(off2, off2 + lim2);
      return { matched: locs.length, offset: off2, returned: page2.length,
               hasMore: off2 + page2.length < locs.length,
               documentsRead: lsnap.size + scan2.documentsRead, cacheAgeSeconds: scan2.cacheAgeSeconds,
               locations: page2 };
    }

    if (name === 'list_orders') {
      var osnap = await db.collection('purchaseOrders').where('orgId', '==', auth.orgId).get();
      var orders = osnap.docs.map(function (d) {
        var o = d.data();
        return { id: d.id, orderNumber: o.poNumber || '', customerPO: o.customerPO || '',
                 customer: o.customerName || '', status: o.status || '',
                 createdAt: o.createdAt || null, total: parseFloat(o.total) || 0,
                 itemCount: (o.items || []).length };
      });
      if (args.status) orders = orders.filter(function (o) { return o.status === args.status; });
      orders.sort(function (a, b) { return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0); });
      var lim3 = Math.min(Math.max(parseInt(args.limit) || 50, 1), 200);
      return { matched: orders.length, returned: Math.min(lim3, orders.length), documentsRead: osnap.size, orders: orders.slice(0, lim3) };
    }

    if (name === 'find_data_problems') {
      var cap = Math.min(Math.max(parseInt(args.limit) || 25, 1), 200);
      var scanP = await scanItems(auth);
      var all = scanP.items;
      var mismatched = all.filter(function (i) { return shelfSum(i) !== i.quantity; });
      var stockNoShelf = all.filter(function (i) { return i.quantity > 0 && (!i.locations || i.locations.length === 0); });
      var bySku = {};
      all.forEach(function (i) { var k = i.sku || '(none)'; (bySku[k] = bySku[k] || []).push(i); });
      var dupes = Object.keys(bySku).filter(function (k) { return k !== '(none)' && bySku[k].length > 1; });
      var grades = {};
      all.forEach(function (i) { var g = i.grade === '' ? '(blank)' : i.grade; grades[g] = (grades[g] || 0) + 1; });
      var gradeInName = all.filter(function (i) { return !i.grade && /(^|\s)(#1|#2|NEW)\s*$/i.test(i.name || ''); });

      return {
        scanned: all.length,
        documentsRead: scanP.documentsRead,
        cacheAgeSeconds: scanP.cacheAgeSeconds,
        quantityDoesNotMatchShelves: {
          count: mismatched.length,
          examples: mismatched.slice(0, cap).map(function (i) {
            return { id: i.id, sku: i.sku, name: i.name, grade: i.grade,
                     quantityField: i.quantity, shelfSum: shelfSum(i), shelves: i.locations };
          })
        },
        stockButNoShelfAssigned: {
          count: stockNoShelf.length,
          examples: stockNoShelf.slice(0, cap).map(function (i) {
            return { id: i.id, sku: i.sku, name: i.name, grade: i.grade, quantity: i.quantity };
          })
        },
        duplicateSkus: {
          count: dupes.length,
          examples: dupes.slice(0, cap).map(function (k) {
            return { sku: k, entries: bySku[k].map(function (i) { return { id: i.id, name: i.name, grade: i.grade, quantity: i.quantity }; }) };
          })
        },
        gradeValueCounts: grades,
        gradeBlankButInName: {
          count: gradeInName.length,
          examples: gradeInName.slice(0, cap).map(function (i) { return { id: i.id, sku: i.sku, name: i.name }; })
        },
        note: 'Reported only. Nothing here has been changed.'
      };
    }

    if (name === 'update_draft_order') {
      var oid = args.orderId;
      var patch = Object.assign({}, args, { source: 'mcp' });
      delete patch.orderId;
      return await ORD.updateDraftOrder(db, auth, oid, patch);
    }

    if (name === 'get_order_document') {
      var odoc = await db.collection('purchaseOrders').doc(String(args.orderId)).get();
      if (!odoc.exists) throw new Error('Order not found: ' + args.orderId);
      var od = odoc.data();
      if (od.orgId !== auth.orgId) throw new Error('Order not found: ' + args.orderId);
      var order = Object.assign({ id: odoc.id }, od);
      var dtype = args.type === 'invoice' ? 'invoice' : 'estimate';

      var ids = (order.items || []).map(function (l) { return l.itemId; })
        .filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });
      var lineItems = [];
      for (var ii = 0; ii < ids.length; ii++) {
        var isn = await db.collection('items').doc(ids[ii]).get();
        if (isn.exists && isn.data().orgId === auth.orgId) lineItems.push(Object.assign({ id: isn.id }, isn.data()));
      }
      var orgSnap = await db.collection('organizations').doc(auth.orgId).get();
      var DOC = await import('./orderDocument.mjs');
      var html = DOC.renderOrderDocument(order, dtype, {
        items: lineItems,
        organization: orgSnap.exists ? orgSnap.data() : {},
        branding: DOC.brandingHtml
      });
      return {
        poNumber: order.poNumber || '', status: order.status || '', type: dtype,
        customerName: order.customerName || '', customerEmail: order.customerEmail || '',
        customerContact: order.customerContact || '',
        documentsRead: 2 + lineItems.length, live: true,
        note: dtype === 'invoice' && order.status === 'draft'
          ? 'This order is still a draft, so nothing has shipped and the invoice will price at zero. An estimate is what you want for a quote.'
          : undefined,
        html: html
      };
    }

    if (name === 'search_customers') {
      var csnap = await db.collection('customers').where('orgId', '==', auth.orgId).get();
      // The customers collection stores the business as `company` and the
      // contact person as `customerName` - there is no `name` field. This
      // mirrors selectCustomerForPO() in PurchaseOrders.jsx exactly, so an
      // order built from here matches one built by hand in the app.
      var custs = csnap.docs.map(function (d) {
        var c = d.data();
        return {
          id: d.id,
          company: c.company || '',
          contactName: c.customerName || '',
          orderCustomerName: c.company || c.customerName || '',
          orderCustomerContact: c.company ? (c.customerName || '') : '',
          email: c.email || '', phone: c.phone || '',
          address: [c.address, c.city, c.state, c.zipCode].filter(Boolean).join(', '),
          upsAccount: c.upsAccount || '', fedexAccount: c.fedexAccount || '',
          notes: c.notes || ''
        };
      });
      var cq = String(args.search || '').toLowerCase().trim();
      if (cq) {
        var ctok = cq.split(/[^a-z0-9@.]+/).filter(Boolean);
        custs = custs.filter(function (c) {
        var hay = (c.company + ' ' + c.contactName + ' ' + c.email).toLowerCase();
          return ctok.every(function (t) { return hay.indexOf(t) !== -1; });
        });
      }
      var clim = Math.min(Math.max(parseInt(args.limit) || 50, 1), 200);
      return { matched: custs.length, returned: Math.min(clim, custs.length),
               documentsRead: csnap.size, live: true, customers: custs.slice(0, clim) };
    }

    if (name === 'create_draft_order') {
      var order = await ORD.createDraftOrder(db, auth, Object.assign({}, args, { source: 'mcp' }));
      return order;
    }

    if (name === 'adjust_item_quantity') {
      if (auth.scope !== 'write') throw new Error('This API key is read-only. Ask Alan for a write-scoped key to make adjustments.');
      if (!args.reason || !String(args.reason).trim()) throw new Error('A reason is required - it lands in the audit log.');

      var iref = db.collection('items').doc(String(args.itemId));
      var cur = await iref.get();
      if (!cur.exists) throw new Error('Item not found: ' + args.itemId);
      var c = cur.data();
      if (c.orgId !== auth.orgId) throw new Error('Item not found: ' + args.itemId);

      var beforeStock = parseInt(c.stock) || 0;
      var beforeShelves = INV.itemLocations(c);
      var plan = INV.applyAdjustment(c, { delta: args.delta, quantity: args.quantity, location: args.location });

      await INV.writeItemLocations(db, iref.id, plan.derived.locations);
      invalidateCache(auth.orgId);

      await db.collection('activityLog').add({
        orgId: auth.orgId,
        action: 'ITEM_UPDATED',
        details: {
          itemId: iref.id,
          updates: { stock: plan.derived.stock, location: plan.derived.location, locations: plan.derived.locations },
          before: { stock: beforeStock, locations: beforeShelves },
          shelf: plan.shelf, shelfBefore: plan.shelfBefore, shelfAfter: plan.shelfAfter,
          source: 'mcp', apiKey: auth.label, reason: String(args.reason)
        },
        userEmail: 'MCP: ' + (auth.label || auth.keyId),
        timestamp: Date.now(),
        createdAt: new Date().toISOString()
      });

      return {
        id: iref.id, sku: c.partNumber || '', name: c.name || '', grade: c.grade || '',
        shelf: plan.shelf,
        shelfPreviousQuantity: plan.shelfBefore,
        shelfQuantity: plan.shelfAfter,
        createdShelf: plan.createdShelf,
        clearedShelf: plan.clearedShelf,
        previousQuantity: beforeStock,
        quantity: plan.derived.stock,
        primaryLocation: plan.derived.location,
        locations: plan.derived.locations,
        reason: String(args.reason),
        note: 'Shelf quantities are the source of truth; the item total and primary location were recalculated from them.'
      };
    }

    var err = new Error('Unknown tool: ' + name);
    err.jsonRpcCode = -32602;
    throw err;
  }

  // ------------------------------------------------------------- JSON-RPC ----

  function rpcResult(id, result) { return { jsonrpc: '2.0', id: id, result: result }; }
  function rpcError(id, code, message, data) {
    var e = { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: code, message: message } };
    if (data !== undefined) e.error.data = data;
    return e;
  }

  function asTextResult(payload, isError) {
    var text;
    try { text = JSON.stringify(payload, null, 2); } catch (e) { text = String(payload); }
    if (text.length > MAX_RESULT_CHARS) {
      text = text.slice(0, MAX_RESULT_CHARS) +
        '\n\n[truncated - narrow the search or use offset/limit to page through the rest]';
    }
    return { content: [{ type: 'text', text: text }], isError: !!isError };
  }

  async function handleMessage(msg, auth) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg && msg.id, -32600, 'Invalid Request');
    }
    var id = msg.id;
    var isNotification = (id === undefined || id === null);

    if (msg.method === 'initialize') {
      var asked = msg.params && msg.params.protocolVersion;
      var negotiated = SUPPORTED_PROTOCOLS.indexOf(asked) !== -1 ? asked : LATEST_PROTOCOL;
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: 'SkidSling Inventory', version: SERVER_VERSION },
        instructions: INSTRUCTIONS
      });
    }

    if (msg.method === 'notifications/initialized' || msg.method.indexOf('notifications/') === 0) return null;
    if (msg.method === 'ping') return rpcResult(id, {});
    if (msg.method === 'tools/list') return rpcResult(id, { tools: TOOLS });

    if (msg.method === 'tools/call') {
      var params = msg.params || {};
      var known = TOOLS.some(function (t) { return t.name === params.name; });
      if (!known) return rpcError(id, -32602, 'Unknown tool: ' + params.name);
      try {
        var out = await runTool(params.name, params.arguments, auth);
        return rpcResult(id, asTextResult(out, false));
      } catch (e) {
        // Tool execution failures are reported in-band so the model can self-correct.
        return rpcResult(id, asTextResult({ error: e.message }, true));
      }
    }

    if (isNotification) return null;
    return rpcError(id, -32601, 'Method not found: ' + msg.method);
  }

  // ---------------------------------------------------------------- HTTP ----

  return functions
    .runWith({ timeoutSeconds: 120, memory: '512MB' })
    .https.onRequest(async function (req, res) {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version');
      res.set('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
      res.set('Access-Control-Expose-Headers', 'WWW-Authenticate');
      if (req.method === 'OPTIONS') return res.status(204).send('');

      if (req.method === 'GET' || req.method === 'DELETE') {
        return res.status(405).set('Allow', 'POST, OPTIONS').json({ error: 'Method Not Allowed' });
      }
      if (req.method !== 'POST') {
        return res.status(405).set('Allow', 'POST, OPTIONS').json({ error: 'Method Not Allowed' });
      }

      var pv = req.get('MCP-Protocol-Version');
      if (pv && !/^\d{4}-\d{2}-\d{2}$/.test(pv)) {
        return res.status(400).json({ error: 'Unsupported MCP-Protocol-Version: ' + pv });
      }

      var auth;
      try {
        auth = await resolveApiKey(req.get('Authorization'));
      } catch (e) {
        console.error('MCP key lookup failed:', e.message);
        return res.status(500).json({ error: 'Authentication failed' });
      }
      if (!auth) {
        // Must be a transport-level 401 - an in-band error would not prompt for auth.
        res.set('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Provide a SkidSling API key as: Authorization: Bearer <key>"');
        return res.status(401).json({ error: 'invalid_token', error_description: 'Invalid or missing API key' });
      }

      var body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { return res.status(200).json(rpcError(null, -32700, 'Parse error')); }
      }

      try {
        if (Array.isArray(body)) {
          var results = [];
          for (var i = 0; i < body.length; i++) {
            var r = await handleMessage(body[i], auth);
            if (r) results.push(r);
          }
          if (results.length === 0) return res.status(202).send('');
          return res.status(200).json(results);
        }

        var one = await handleMessage(body, auth);
        if (one === null) return res.status(202).send('');
        return res.status(200).json(one);
      } catch (e) {
        console.error('MCP error:', e);
        return res.status(200).json(rpcError(body && body.id, -32603, 'Internal error'));
      }
    });
};
