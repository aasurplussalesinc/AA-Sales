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
var HIST = require('./itemHistory');
var INVC = require('./invoicingCore');

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
    'message. "Check the count on 2091" means look, not fix. Always pass a reason.',
    '',
    'INVOICES AND PAYMENTS: list_orders and list_open_invoices carry each invoice\'s',
    'real payment status from the payments ledger (Stripe and recorded checks/cash).',
    'balanceDue is what is still owed; daysOverdue counts from the due date. Report',
    'these as read - never infer that an invoice was paid from anything else.'
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
      description: 'List purchase orders, newest first. Filter by status: draft, confirmed, paid, packed, shipped, cancelled. ' +
        'Orders with a shipping label include `shipping`: carrier, service, trackingNumber, trackingUrl, and one tracking number per box for multi-box shipments ' +
        '(the same data as the Shipping tab). An order shipped on the customer\'s own carrier account without a label made in SkidSling has no `shipping`. ' +
        'Shipped and paid orders include `invoice`: status (draft = not sent, sent, partially_paid, paid, overdue, void), invoiceTotal, amountPaid, balanceDue, ' +
        'paymentPending (a bank transfer still clearing), dueDate, daysOverdue, sentAt, lastReminderAt, reminderCount - read from the payments ledger. ' +
        'For "who owes us money" use list_open_invoices.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Exact status to filter by' },
          customer: { type: 'string', description: 'Only orders whose customer name contains this text (case-insensitive)' },
          orderNumber: { type: 'string', description: 'Only this order, e.g. AA6676' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max orders to return (default 50)' }
        },
        additionalProperties: false
      },
      annotations: { title: 'List Orders', readOnlyHint: true }
    },
    {
      name: 'list_open_invoices',
      title: 'List Open Invoices',
      description: 'Every invoice with money still owed (shipped, not paid, not cancelled), most overdue first, with the real payment status from the payments ledger: ' +
        'invoiceTotal, amountPaid, balanceDue, paymentPending (bank transfer still clearing), dueDate, daysOverdue, agingBucket (current, 1-30, 31-60, 61-90, 90+), ' +
        'sentAt, lastReminderAt, reminderCount, remindersPaused, and the customer\'s doNotRemind / remindByPhone flags. Read-only. ' +
        'Amounts are dollars; the *Cents fields are the exact integers. Orders a person marked Paid by hand count as paid.',
      inputSchema: {
        type: 'object',
        properties: {
          customer: { type: 'string', description: 'Only invoices whose customer name contains this text (case-insensitive)' },
          overdueOnly: { type: 'boolean', description: 'Only invoices past their due date' },
          minDaysOverdue: { type: 'integer', minimum: 0, description: 'Only invoices at least this many days past due' },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max invoices to return (default 100)' }
        },
        additionalProperties: false
      },
      annotations: { title: 'List Open Invoices', readOnlyHint: true }
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
      name: 'find_stock_mismatches',
      title: 'Find Stock Mismatches',
      description: 'Find items whose stock history does not add up since a date: each movement\'s before-quantity should equal the previous movement\'s after-quantity, and the last after-quantity should equal the current quantity. A break means the quantity changed with nothing logged (e.g. stock put back twice, or an edit that bypassed the ledger). Only items with at least one movement since the date are checked. Paged: pass nextCursor back as cursor. Read-only - reports, never fixes; use get_item_history for the full ledger of one SKU.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'Check movements at or after this ISO date/time, e.g. 2026-08-20 (default: 30 days ago)' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Items checked per page (default 50)' },
          cursor: { type: 'string', description: 'nextCursor from the previous page' },
          maxMovements: { type: 'integer', minimum: 100, maximum: 20000, description: 'Newest movements read since the date (default 5000). If the result says truncated, narrow the date instead.' }
        },
        additionalProperties: false
      },
      annotations: { title: 'Find Stock Mismatches', readOnlyHint: true }
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
          customerAddressUnit: { type: 'string', description: 'Unit / suite / apt for the customer address. Prints on its own label line.' },
          customerAttention: { type: 'string', description: 'Person or department the shipment is attention to (ATTN) at the customer address.' },
          shipToAddress: { type: 'string' }, shipToCompany: { type: 'string' },
          shipToUnit: { type: 'string', description: 'Unit / suite / apt for the ship-to address.' },
          shipToAttention: { type: 'string', description: 'ATTN person or department at the ship-to address.' },
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
      description: 'Create a purchase order as a DRAFT from lines you have already matched to catalogue items. It never goes past draft - nothing is reserved, picked or shipped until a person presses Confirm & Pick in SkidSling. Lines default to the catalogue price. Pass unitPrice to price a line deliberately (a show price, a negotiated deal) - that writes to the order only and never changes the item. A price merely quoted by the customer goes in quotedPrice, which is recorded for the paper trail and never charged. Items with too little stock are still included so the order shows what was actually asked for. Confirm the full line list with the user before calling this.',
      inputSchema: {
        type: 'object',
        properties: {
          customerName: { type: 'string', description: 'Required. Business name on the order.' },
          customerId: { type: 'string', description: 'Id from search_customers, when the customer already exists' },
          customerContact: { type: 'string', description: 'Person to attention the order to' },
          customerEmail: { type: 'string' },
          customerPhone: { type: 'string' },
          customerAddress: { type: 'string', description: 'Billing address as one string (street, city, state, zip). Put the unit/suite in customerAddressUnit, not here.' },
          customerAddressUnit: { type: 'string', description: 'Unit / suite / apt, e.g. "Suite 25". Use the addressUnit from search_customers. Prints on its own line of the shipping label.' },
          customerAttention: { type: 'string', description: 'ATTN person or department for the shipping label. Use the attention from search_customers.' },
          shipToAddress: { type: 'string', description: 'Ship-to address, if different from billing' },
          shipToCompany: { type: 'string', description: 'Recipient business name for drop-shipping' },
          shipToUnit: { type: 'string', description: 'Unit / suite / apt for the ship-to address' },
          shipToAttention: { type: 'string', description: 'ATTN person or department at the ship-to address' },
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
                unitPrice: { type: 'number', description: 'Price this line deliberately, overriding the catalogue price. Applies to catalogue and free-text lines alike, is stored on the order only, and never alters the item. Omit to use the catalogue price.' },
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
      name: 'get_item_history',
      title: 'Get Item Stock History',
      description: 'Read the stock history (movements ledger) of one item: every pick, receive, move, adjustment, import and restore, newest first, with time, quantity, shelves, user, order and reason. Look up by exact `sku` or by `itemId`. When several items share a SKU (usually different grades) each is returned separately. `summary` totals each movement type and compares the net change the ledger implies with the current quantity, so an unlogged change shows up as a mismatch. Older stock edits made through the API/MCP or the item edit form were recorded only in the audit log; those appear under `auditLogOnlyEdits`. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Exact SKU / part number' },
          itemId: { type: 'string', description: 'The item id returned by search_items' },
          since: { type: 'string', description: 'Only movements at or after this ISO date/time, e.g. 2026-09-01' },
          until: { type: 'string', description: 'Only movements before this ISO date/time' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max movements per item, newest first (default 200, cap 1000)' }
        },
        additionalProperties: false
      },
      annotations: { title: 'Get Item Stock History', readOnlyHint: true }
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

  // ---- invoices (read-only; the same rules as functions/invoicingCore.js) ----
  async function invoiceContext(orgId) {
    var org = await db.collection('organizations').doc(orgId).get();
    var p = (org.exists && org.data().payments) || {};
    var tz = p.autoSend && INVC.validTimeZone(p.autoSend.timeZone) ? p.autoSend.timeZone : INVC.DEFAULT_TZ;
    var today = INVC.localDay(Date.now(), tz);
    return { tz: tz, today: today, todayIso: INVC.dayToIso(today) };
  }
  function invoiceRow(o, ctx) {
    var st = INVC.invoiceState(o, null, ctx.today, ctx.tz);
    if (!st.issued && !o.invoice) return null;
    var inv = o.invoice || {};
    return {
      status: st.status,
      invoiceTotal: INVC.centsToDollars(st.totalCents), amountPaid: INVC.centsToDollars(st.paidCents),
      balanceDue: INVC.centsToDollars(st.balanceCents),
      invoiceTotalCents: st.totalCents, amountPaidCents: st.paidCents, balanceDueCents: st.balanceCents,
      paymentPending: st.paymentPending, pendingAmount: INVC.centsToDollars(st.pendingCents),
      markedPaidByHand: st.manualPaid,
      dueDate: st.dueDate || null, daysOverdue: st.daysOverdue,
      sentAt: inv.sentAt || null, lastReminderAt: inv.lastReminderAt || null, reminderCount: inv.reminderCount || 0,
      remindersPaused: !!inv.remindersPaused
    };
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
      var invCtx = await invoiceContext(auth.orgId);
      var orders = osnap.docs.map(function (d) {
        var o = d.data();
        var row = { id: d.id, orderNumber: o.poNumber || '', customerPO: o.customerPO || '',
                 customer: o.customerName || '', status: o.status || '',
                 createdAt: o.createdAt || null, total: parseFloat(o.total) || 0,
                 itemCount: (o.items || []).length };
        var lbl = o.shippingLabel;
        if (lbl && (lbl.trackingNumber || lbl.labelStatus)) {
          var rate = lbl.selectedRate || {};
          row.shipping = {
            carrier: rate.provider || null,
            service: (rate.servicelevel && rate.servicelevel.name) || null,
            labelStatus: lbl.labelStatus || null,
            trackingNumber: lbl.trackingNumber || null,
            trackingUrl: lbl.trackingUrl || null,
            boxes: (lbl.allLabels || []).map(function (b) { return b.trackingNumber; }).filter(Boolean)
          };
        }
        var inv = invoiceRow(o, invCtx);
        if (inv) row.invoice = inv;
        return row;
      });
      if (args.status) orders = orders.filter(function (o) { return o.status === args.status; });
      if (args.customer) {
        var cq = String(args.customer).toLowerCase();
        orders = orders.filter(function (o) { return o.customer.toLowerCase().indexOf(cq) !== -1; });
      }
      if (args.orderNumber) orders = orders.filter(function (o) { return o.orderNumber.toUpperCase() === String(args.orderNumber).toUpperCase(); });
      orders.sort(function (a, b) { return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0); });
      var lim3 = Math.min(Math.max(parseInt(args.limit) || 50, 1), 200);
      return { matched: orders.length, returned: Math.min(lim3, orders.length), documentsRead: osnap.size, orders: orders.slice(0, lim3) };
    }

    if (name === 'list_open_invoices') {
      var isnap = await db.collection('purchaseOrders').where('orgId', '==', auth.orgId).get();
      var ictx = await invoiceContext(auth.orgId);
      var csnap2 = await db.collection('customers').where('orgId', '==', auth.orgId).get();
      var custFlags = {};
      csnap2.docs.forEach(function (d) {
        var c = d.data();
        custFlags[d.id] = { doNotRemind: !!c.doNotRemind, remindByPhone: !!c.remindByPhone };
      });
      var open = [];
      isnap.docs.forEach(function (d) {
        var o = d.data();
        var inv = invoiceRow(o, ictx);
        if (!inv || inv.balanceDueCents <= 0 || inv.status === 'void') return;
        var flags = custFlags[o.customerId] || {};
        open.push(Object.assign({
          orderId: d.id, orderNumber: o.poNumber || '', customerPO: o.customerPO || '',
          customer: o.customerName || '', customerId: o.customerId || '',
          doNotRemind: !!flags.doNotRemind, remindByPhone: !!flags.remindByPhone,
          agingBucket: INVC.agingBucket(inv.daysOverdue)
        }, inv));
      });
      if (args.customer) {
        var cq2 = String(args.customer).toLowerCase();
        open = open.filter(function (r) { return r.customer.toLowerCase().indexOf(cq2) !== -1; });
      }
      if (args.overdueOnly) open = open.filter(function (r) { return r.daysOverdue > 0; });
      if (args.minDaysOverdue) open = open.filter(function (r) { return r.daysOverdue >= parseInt(args.minDaysOverdue); });
      open.sort(function (a, b) { return (b.daysOverdue - a.daysOverdue) || (b.balanceDueCents - a.balanceDueCents); });
      var totalCents = open.reduce(function (t, r) { return t + r.balanceDueCents; }, 0);
      var byBucket = {};
      INVC.AGING_BUCKETS.forEach(function (k) { byBucket[k] = 0; });
      open.forEach(function (r) { byBucket[r.agingBucket] += r.balanceDueCents; });
      Object.keys(byBucket).forEach(function (k) { byBucket[k] = INVC.centsToDollars(byBucket[k]); });
      var lim4 = Math.min(Math.max(parseInt(args.limit) || 100, 1), 500);
      return { matched: open.length, returned: Math.min(lim4, open.length), today: ictx.todayIso,
               totalOutstanding: INVC.centsToDollars(totalCents), outstandingByAge: byBucket,
               documentsRead: isnap.size + csnap2.size + 1, invoices: open.slice(0, lim4) };
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

    if (name === 'find_stock_mismatches') {
      var sinceMs = args.since ? Date.parse(String(args.since)) : Date.now() - 30 * 86400000;
      if (!isFinite(sinceMs)) throw new Error('since must be an ISO date, e.g. 2026-08-20');
      var pageSize = Math.min(Math.max(parseInt(args.limit) || 50, 1), 200);
      var maxMov = Math.min(Math.max(parseInt(args.maxMovements) || 5000, 100), 20000);
      var offset = Math.max(parseInt(args.cursor) || 0, 0);
      var smRead = 0, smIndexMissing = false, smTruncated = false, smDocs;
      var smBase = db.collection('movements').where('orgId', '==', auth.orgId);
      try {
        var smSnap = await smBase.where('timestamp', '>=', sinceMs).orderBy('timestamp', 'desc').limit(maxMov + 1).get();
        smRead += smSnap.size;
        smDocs = smSnap.docs;
      } catch (e) {
        // Index (orgId, timestamp desc) not deployed yet: equality only,
        // filtered here. Costs a read of the org's whole ledger.
        if (!/index/i.test(e.message || '')) throw e;
        smIndexMissing = true;
        var smAll = await smBase.get();
        smRead += smAll.size;
        smDocs = smAll.docs.filter(function (d) { return (Number(d.data().timestamp) || 0) >= sinceMs; })
          .sort(function (a, b) { return (Number(b.data().timestamp) || 0) - (Number(a.data().timestamp) || 0); });
      }
      if (smDocs.length > maxMov) { smTruncated = true; smDocs = smDocs.slice(0, maxMov); }
      var effectiveSince = smDocs.length ? Number(smDocs[smDocs.length - 1].data().timestamp) || sinceMs : sinceMs;

      var byItem = {};
      smDocs.forEach(function (d) {
        var m = d.data();
        if (!m.itemId) return;
        (byItem[m.itemId] = byItem[m.itemId] || []).push(Object.assign({ id: d.id }, m));
      });
      var itemIds = Object.keys(byItem).sort();
      var pageIds = itemIds.slice(offset, offset + pageSize);
      var itemDocs = pageIds.length ? await db.getAll.apply(db, pageIds.map(function (x) { return db.collection('items').doc(x); })) : [];
      smRead += itemDocs.length;

      var mismatches = [], missing = [];
      itemDocs.forEach(function (d) {
        var movs = byItem[d.id];
        if (!d.exists || d.data().orgId !== auth.orgId) {
          missing.push({ itemId: d.id, sku: (movs[0] && movs[0].sku) || '', name: (movs[0] && movs[0].itemName) || '', movementsSince: movs.length });
          return;
        }
        var pi = publicItem(d.id, d.data());
        var rec = HIST.reconcileLedger(movs, pi.quantity);
        if (rec.reconciles) return;
        mismatches.push({
          id: pi.id, sku: pi.sku, name: pi.name, grade: pi.grade,
          quantity: pi.quantity, shelfSum: shelfSum(pi), shelves: pi.locations,
          movementsSince: rec.movementCount,
          firstRecordedBefore: rec.firstRecordedBefore,
          lastRecordedAfter: rec.lastRecordedAfter,
          unloggedSinceLastMovement: rec.unloggedSinceLastMovement,
          movementsWithUnknownDirection: rec.movementsWithUnknownDirection,
          chainBreaks: rec.chainBreaks.slice(0, 10),
          chainBreakCount: rec.chainBreaks.length
        });
      });
      var nextOffset = offset + pageIds.length;
      return {
        since: new Date(sinceMs).toISOString(),
        effectiveSince: new Date(effectiveSince).toISOString(),
        truncated: smTruncated || undefined,
        indexMissing: smIndexMissing || undefined,
        movementsRead: smDocs.length,
        itemsWithMovements: itemIds.length,
        checkedThisPage: pageIds.length,
        mismatchCount: mismatches.length,
        mismatches: mismatches,
        itemsDeletedOrOtherOrg: missing.length ? missing : undefined,
        nextCursor: nextOffset < itemIds.length ? String(nextOffset) : null,
        documentsRead: smRead,
        note: 'Reported only. Nothing has been changed. unloggedChange in a chain break is recordedBefore minus the previous after: positive means stock rose with nothing logged. A break can also come from two writers disagreeing about the total on an item whose quantity did not match its shelves. Movements written before 2026-09-28 often lack before/after, which weakens the check for older dates.' +
          (smTruncated ? ' Truncated: only the newest ' + maxMov + ' movements were read, so the check starts at effectiveSince. Narrow the date or raise maxMovements.' : '')
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
          addressUnit: c.addressUnit || '', attention: c.attention || '',
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

    if (name === 'get_item_history') {
      var hLimit = Math.min(Math.max(parseInt(args.limit) || 200, 1), 1000);
      var since = args.since ? Date.parse(String(args.since)) : null;
      var until = args.until ? Date.parse(String(args.until)) : null;
      if (args.since && isNaN(since)) throw new Error('`since` is not a valid ISO date: ' + args.since);
      if (args.until && isNaN(until)) throw new Error('`until` is not a valid ISO date: ' + args.until);
      var hRead = 0;

      // Resolve the item(s). Tenant isolation: every item must belong to the
      // key's org, and the movements query below is scoped to it as well.
      var hItems = [];
      if (args.itemId) {
        var hRef = await db.collection('items').doc(String(args.itemId)).get();
        hRead++;
        if (!hRef.exists || hRef.data().orgId !== auth.orgId) throw new Error('Item not found: ' + args.itemId);
        hItems.push({ id: hRef.id, data: hRef.data() });
      } else if (args.sku) {
        var hSnap = await db.collection('items').where('orgId', '==', auth.orgId)
          .where('partNumber', '==', String(args.sku).trim()).get();
        hRead += hSnap.size;
        hSnap.docs.forEach(function (d) { hItems.push({ id: d.id, data: d.data() }); });
        if (!hItems.length) throw new Error('No item with SKU ' + args.sku);
      } else {
        throw new Error('Pass `sku` or `itemId`.');
      }

      var orderNumbers = {};
      var results = [];
      var indexMissing = false;
      for (var hi = 0; hi < hItems.length; hi++) {
        var hid = hItems[hi].id;
        var hd = hItems[hi].data;
        var mq = db.collection('movements').where('orgId', '==', auth.orgId).where('itemId', '==', hid);
        var movDocs;
        try {
          var iq = mq.orderBy('timestamp', 'desc');
          if (since !== null) iq = iq.where('timestamp', '>=', since);
          if (until !== null) iq = iq.where('timestamp', '<', until);
          var ms = await iq.limit(hLimit + 1).get();
          movDocs = ms.docs;
        } catch (e) {
          // Composite index (orgId, itemId, timestamp desc) not deployed yet:
          // read this item's whole ledger with equality filters and sort here.
          if (!/index/i.test(e.message || '')) throw e;
          indexMissing = true;
          var fs = await mq.get();
          hRead += fs.size;
          movDocs = fs.docs.filter(function (d) {
            var t = Number(d.data().timestamp) || 0;
            return (since === null || t >= since) && (until === null || t < until);
          }).sort(function (a, b) {
            return (Number(b.data().timestamp) || 0) - (Number(a.data().timestamp) || 0);
          }).slice(0, hLimit + 1);
        }
        if (!indexMissing) hRead += movDocs.length;
        var truncated = movDocs.length > hLimit;
        if (truncated) movDocs = movDocs.slice(0, hLimit);
        var raw = movDocs.map(function (d) { return { id: d.id, data: d.data() }; });

        // Order numbers for PICK movements tagged with an order id but written
        // before the number was stamped alongside it.
        for (var ri = 0; ri < raw.length; ri++) {
          var oid2 = raw[ri].data.orderId;
          if (!oid2 || raw[ri].data.orderNumber || orderNumbers[oid2] !== undefined) continue;
          orderNumbers[oid2] = '';
          var os = await db.collection('purchaseOrders').doc(String(oid2)).get();
          hRead++;
          if (os.exists && os.data().orgId === auth.orgId) orderNumbers[oid2] = os.data().poNumber || '';
        }

        // Stock edits recorded only in the audit log (API/MCP adjustments and
        // item edits made before those paths wrote movements).
        var auditSnap = await db.collection('activityLog').where('orgId', '==', auth.orgId)
          .where('details.itemId', '==', hid).get();
        hRead += auditSnap.size;
        var audit = auditSnap.docs.map(function (d) { return HIST.auditStockChange(d.data()); })
          .filter(function (a) {
            return a && (since === null || a.timestamp >= since) && (until === null || a.timestamp < until);
          });
        var auditOnly = HIST.unmatchedAuditEdits(audit, raw.map(function (r) { return r.data; }))
          .sort(function (a, b) { return b.timestamp - a.timestamp; });

        var hItem = publicItem(hid, hd);
        results.push({
          item: { id: hid, sku: hItem.sku, name: hItem.name, grade: hItem.grade,
                  quantity: hItem.quantity, locations: hItem.locations,
                  createdAt: hd.createdAt || null },
          summary: HIST.summarizeHistory(raw.map(function (r) { return r.data; }), hItem.quantity, {
            coversFullHistory: since === null && until === null && !truncated,
            auditOnlyEdits: auditOnly
          }),
          returned: raw.length,
          truncated: truncated,
          movements: raw.map(function (r) { return HIST.formatMovement(r.id, r.data, orderNumbers); }),
          auditLogOnlyEdits: auditOnly
        });
      }

      return {
        matched: results.length,
        note: results.length > 1
          ? 'More than one item shares this SKU - they are usually different grades. Report them separately.'
          : undefined,
        indexMissing: indexMissing || undefined,
        documentsRead: hRead,
        live: true,
        items: results
      };
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

      var adjNow = Date.now();
      var adjUser = 'MCP: ' + (auth.label || auth.keyId);
      await db.collection('movements').add(HIST.adjustMovement(
        c, iref.id, auth.orgId, plan, beforeShelves, String(args.reason), 'mcp', adjUser, adjNow));

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
        userEmail: adjUser,
        timestamp: adjNow,
        createdAt: new Date(adjNow).toISOString()
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
