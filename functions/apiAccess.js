/**
 * SkidSling - AI assistant / API key access rules (plan matrix 2026-10-26).
 *
 * Customers connect their own AI (Claude, ChatGPT, ...) through an API key: REST at exports.api, MCP at
 * exports.mcp. They pay for their own AI, so there are no per-plan AI usage limits. What the plan decides:
 *
 *   Starter (and anything below Pro, e.g. an expired org)  READ-ONLY: inventory, shelves, customers, history.
 *                                                          A key stored as 'write' is treated as 'read'.
 *   Pro and up (trial, business, enterprise, owner too)    FULL CONTROL: write keys can adjust stock, create
 *                                                          items, and the order / invoice tools work.
 *
 * Plus one safety net for every plan: RATE_LIMIT_PER_HOUR requests per key per clock hour, so a runaway agent
 * cannot hammer the database. The counter lives on the apiKeys document, which resolveApiKey already updates on
 * every call, so it costs no extra reads or writes.
 *
 * The plan is always read from the org document on the server; nothing the caller sends can change it.
 */

// Same order as src/useTier.js TIER_RANK. Unknown plans ('expired', missing) rank 0: read-only.
var TIER_RANK = { trial: 3, starter: 1, pro: 2, business: 3, enterprise: 4, owner: 99 };
var PRO_RANK = 2;
var RATE_LIMIT_PER_HOUR = 3000;
var MAX_AI_NOTES = 4000;
var OWNER_ORG_ID = 'aa-surplus-sales';

function planRank(plan) {
  var r = TIER_RANK[plan || 'trial'];
  return r === undefined ? 0 : r;
}
function aiFullControl(plan) { return planRank(plan) >= PRO_RANK; }

/** The scope a key really has: 'write' only when it was created as write AND the org is on Pro or higher. */
function effectiveScope(plan, storedScope) {
  return storedScope === 'write' && aiFullControl(plan) ? 'write' : 'read';
}

function planLabel(plan) {
  var p = String(plan || 'trial');
  return p.charAt(0).toUpperCase() + p.slice(1);
}

// ---------------------------------------------------------------- org notes ----

// AA Surplus Sales' own conventions. They used to be hardcoded into every org's MCP instructions; now they are
// AA's default value of organizations/{id}.aiNotes (any org can write its own in Settings -> API Access). This is
// a default in code, not a data write: once AA saves its own notes, those win.
var AA_DEFAULT_NOTES = [
  'AA Surplus Sales Inc. is a military surplus wholesaler.',
  '',
  'GRADE is the most important field after SKU. The same product exists in several',
  'conditions and they are different products at different prices: NEW (unissued),',
  '#1 (good used), #2 (lower grade used). Never merge grades in a count or a',
  'recommendation. "How many assault pouches" almost always means "how many of each',
  'grade". Note that the grade field is frequently blank with the grade written into',
  'the item name instead - say so rather than silently guessing.',
  '',
  'LOCATION CODES look like W4-R1-F2: W4 warehouse, R1 rack, F bay/column, 2 shelf.',
  '',
  'Surplus moves in irregular lots - a quantity that looks odd usually is odd, not a typo.'
].join('\n');

/** The org's own notes for its AI assistant ('' if none). An org that saved an empty value has cleared them. */
function aiNotesFor(orgId, org) {
  org = org || {};
  if (typeof org.aiNotes === 'string') return org.aiNotes.slice(0, MAX_AI_NOTES).trim();
  return orgId === OWNER_ORG_ID ? AA_DEFAULT_NOTES : '';
}

/** MCP `instructions` for one organization. */
function buildInstructions(auth) {
  auth = auth || {};
  var name = String(auth.orgName || '').trim() || 'this organization';
  var full = aiFullControl(auth.plan);
  var lines = [
    'SkidSling inventory for ' + name + '.',
    '',
    'Read this before interpreting any data:',
    '',
    'LOCATIONS: one item can sit on SEVERAL shelves at once. The `locations` array is the truth;',
    '`location` is only the largest single holding. When asked where something is, report every',
    'shelf and its quantity. STAGING means received but not yet put away.',
    '',
    'QUANTITIES are what is physically on the shelf. Never estimate, round, or infer a quantity',
    'you did not read from a tool result.',
    '',
    'If `quantity` does not equal the sum of the `locations` quantities, that is a real data',
    'problem. Report it. Do not fix it.',
    '',
    'Items that share a name or SKU but differ in grade are different products. Report them',
    'separately and never merge them in a count.',
    ''
  ];
  if (full) {
    lines.push(
      'Never adjust a quantity unless the user explicitly asked for that change in that',
      'message. "Check the count on 2091" means look, not fix. Always pass a reason.',
      '',
      'INVOICES AND PAYMENTS: list_orders and list_open_invoices carry each invoice\'s',
      'real payment status from the payments ledger (Stripe and recorded checks/cash).',
      'balanceDue is what is still owed; daysOverdue counts from the due date. Report',
      'these as read - never infer that an invoice was paid from anything else.',
      '',
      auth.scope === 'write'
        ? 'ACCESS: this key can make changes (stock, items, draft orders).'
        : 'ACCESS: this key is read-only. Changes need a read & write key (Settings -> API Access).'
    );
  } else {
    lines.push(
      'ACCESS: ' + name + ' is on the ' + planLabel(auth.plan) + ' plan, so the assistant can read',
      'inventory, shelves, customers and stock history but cannot change anything, and orders',
      'and invoices are not available. Letting the assistant run orders and invoices needs the',
      'Pro plan or higher (an admin can upgrade in SkidSling Settings).'
    );
  }
  var notes = aiNotesFor(auth.orgId, auth.org);
  if (notes) {
    lines.push('', 'NOTES FROM ' + name.toUpperCase() + ' (their own conventions, set in SkidSling Settings):', '', notes);
  }
  return lines.join('\n');
}

/** Fill in the plan-derived fields of an auth record from the org document. Safe to call twice. */
function applyPlan(auth, org) {
  org = org || {};
  var stored = auth.storedScope || auth.scope || 'read';
  auth.storedScope = stored;
  auth.plan = org.plan || 'trial';
  auth.orgName = org.name || '';
  auth.org = { aiNotes: org.aiNotes };
  auth.aiFullControl = aiFullControl(auth.plan);
  auth.scope = effectiveScope(auth.plan, stored);
  return auth;
}

// ---------------------------------------------------------------- tool rules ----

// Orders and invoices through the AI are a Pro feature (the app's orders/invoices are Pro too).
var PRO_TOOLS = ['list_orders', 'list_open_invoices', 'get_order_document', 'create_draft_order', 'update_draft_order'];
// Tools that change data: need a write key AND Pro+.
var WRITE_TOOLS = ['adjust_item_quantity', 'create_item', 'create_draft_order', 'update_draft_order'];

function upgradeMessage(auth, what) {
  return what + ' through the AI assistant needs the Pro plan or higher. ' +
    (auth.orgName || 'This organization') + ' is on ' + planLabel(auth.plan) +
    ', where the assistant is read-only (it can still look up inventory, shelves, customers and stock history). ' +
    'An admin can upgrade in SkidSling Settings.';
}

/** null when the tool may run, otherwise the message to return. */
function toolBlock(name, auth) {
  auth = auth || {};
  var write = WRITE_TOOLS.indexOf(name) !== -1;
  if ((write || PRO_TOOLS.indexOf(name) !== -1) && !aiFullControl(auth.plan)) {
    return upgradeMessage(auth, write ? 'Changing data' : 'Orders and invoices');
  }
  if (write && auth.scope !== 'write') {
    return 'This API key is read-only. An admin can create a read & write key in SkidSling Settings -> API Access.';
  }
  return null;
}

/** Tools to advertise in tools/list: below Pro only the read-only inventory tools. */
function visibleTools(tools, auth) {
  if (aiFullControl((auth || {}).plan)) return tools;
  return tools.filter(function (t) { return PRO_TOOLS.indexOf(t.name) === -1 && WRITE_TOOLS.indexOf(t.name) === -1; });
}

/** REST: null when the route may run, otherwise { status, message }. */
function restBlock(method, path, auth) {
  auth = auth || {};
  var orderRoute = path === '/orders' || path.indexOf('/orders/') === 0 || path === '/diagnostics/stock-deduction';
  var write = method === 'POST' || method === 'PATCH';
  if ((orderRoute || write) && !aiFullControl(auth.plan)) {
    return { status: 403, message: upgradeMessage(auth, write ? 'Changing data' : 'Orders and invoices') };
  }
  if (write && auth.scope !== 'write') return { status: 403, message: 'This key is read-only' };
  return null;
}

// ---------------------------------------------------------------- rate limit ----

function hourOf(now) { return Math.floor(now / 3600000); }

/**
 * Per-key hourly window from the fields on the apiKeys document. Returns { allowed, used, hour, retryAfterSeconds }.
 * Counts can run a little low under heavy parallel bursts (the read is a moment old); fine for a safety net.
 */
function rateCheck(keyData, now, limit) {
  limit = limit || RATE_LIMIT_PER_HOUR;
  var hour = hourOf(now);
  var used = keyData && keyData.rateHour === hour ? (parseInt(keyData.rateHourCount) || 0) : 0;
  return {
    allowed: used < limit, used: used, hour: hour, limit: limit,
    retryAfterSeconds: Math.max(1, Math.ceil(((hour + 1) * 3600000 - now) / 1000))
  };
}

function rateLimitMessage(rate) {
  return 'Rate limit reached: this API key made ' + rate.limit + ' requests in the last clock hour, the safety limit that ' +
    'stops a runaway agent from hammering the database. It resets in ' + Math.ceil(rate.retryAfterSeconds / 60) +
    ' minute(s). If your assistant is looping, stop it; if you genuinely need more, contact info@skidsling.com.';
}

// ---------------------------------------------------------------- resolve ----

/**
 * resolveApiKey(authHeader) -> null (unknown / revoked) or
 *   { orgId, scope, storedScope, keyId, label, plan, orgName, aiFullControl, rateLimited?, rate? }
 * deps: { db, FieldValue, sha256Hex, now? }
 */
function makeResolveApiKey(deps) {
  var db = deps.db, FieldValue = deps.FieldValue, sha256Hex = deps.sha256Hex;
  var clock = deps.now || function () { return Date.now(); };

  return async function resolveApiKey(authHeader) {
    if (!authHeader || authHeader.indexOf('Bearer ') !== 0) return null;
    var raw = authHeader.slice(7).trim();
    if (!raw) return null;

    var snap = await db.collection('apiKeys').where('keyHash', '==', sha256Hex(raw)).limit(1).get();
    if (snap.empty) return null;
    var docSnap = snap.docs[0];
    var data = docSnap.data();
    if (data.revoked) return null;

    var now = clock();
    var auth = { orgId: data.orgId, scope: data.scope || 'read', keyId: docSnap.id, label: data.label };
    var rate = rateCheck(data, now);
    if (!rate.allowed) {
      auth.rateLimited = true;
      auth.rate = rate;
      return auth;
    }

    // Fire-and-forget usage stamp + hourly counter; never block the request on it.
    var stamp = { lastUsedAt: now, callCount: (data.callCount || 0) + 1 };
    if (data.rateHour === rate.hour && FieldValue && FieldValue.increment) stamp.rateHourCount = FieldValue.increment(1);
    else { stamp.rateHour = rate.hour; stamp.rateHourCount = rate.used + 1; }
    docSnap.ref.update(stamp).catch(function () {});

    var org = await db.collection('organizations').doc(String(data.orgId)).get();
    return applyPlan(auth, org.exists ? org.data() : {});
  };
}

module.exports = {
  TIER_RANK: TIER_RANK,
  RATE_LIMIT_PER_HOUR: RATE_LIMIT_PER_HOUR,
  MAX_AI_NOTES: MAX_AI_NOTES,
  AA_DEFAULT_NOTES: AA_DEFAULT_NOTES,
  PRO_TOOLS: PRO_TOOLS,
  WRITE_TOOLS: WRITE_TOOLS,
  planRank: planRank,
  aiFullControl: aiFullControl,
  effectiveScope: effectiveScope,
  aiNotesFor: aiNotesFor,
  buildInstructions: buildInstructions,
  applyPlan: applyPlan,
  toolBlock: toolBlock,
  visibleTools: visibleTools,
  restBlock: restBlock,
  rateCheck: rateCheck,
  rateLimitMessage: rateLimitMessage,
  makeResolveApiKey: makeResolveApiKey,
};
