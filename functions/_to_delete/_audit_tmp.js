const F = [
['CRITICAL','Any signed-in user can make themselves admin of any tenant','firestore.rules:95',
 'The <code>orgMembers</code> create rule checks only that <code>userId == request.auth.uid</code>. It does not constrain the document ID, the <code>orgId</code>, or the <code>role</code> — and role is read from exactly that document ID (<code>orgId + \'_\' + uid</code>).',
 'One console call — <code>setDoc(doc(db,"orgMembers","victim-org_&lt;myUid&gt;"),{userId:myUid,orgId:"victim-org",role:"admin"})</code> — grants full read/write over that tenant\'s items, customers, orders, contracts and activity log. No invite code needed. Writing the same doc for <code>aa-surplus-sales</code> makes the attacker a SkidSling owner: read every org, every member roster, every activity log, and run adminDeleteOrganization against any customer.',
 'Require the doc ID to equal orgId_uid, force role to staff on self-join, and move membership creation into a Cloud Function that validates the invite.'],

['CRITICAL','16 of 18 Cloud Functions never check that the caller belongs to the org they name','functions/index.js — 16 exports',
 'Every callable takes <code>orgId</code> straight from <code>data</code> and acts on it. All 20 check <code>context.auth</code>; only <code>exportOrgData</code> and <code>adminDeleteOrganization</code> check membership — and both are defeated by the rule above. The Admin SDK bypasses Firestore rules entirely, so each function has to do this itself.',
 'A signed-in user of any tenant can: open another tenant\'s Stripe billing portal and cancel their subscription (createBillingPortalSession); buy real shipping labels on another tenant\'s Shippo / ShipStation / EasyPost account, to any address, in unlimited volume (generateShipStationLabel, generateEasyPostLabel, generateShippingLabel); disable their automated shipping (updateShippingSchedule); overwrite the invoice parameters on their UPS account (updateCarrierInvoice); and write insurance values and customs declarations onto their orders (saveInsurance, saveCustomsInfo — which accept orgId and then never use it).',
 'Add one assertMember(context.auth.uid, orgId) helper and call it at the top of every callable that accepts an orgId.'],

['CRITICAL','Order notes reach headless Chrome with web security disabled','functions/orderDocument.mjs:124 + functions/pdf.js:23',
 'The estimate/invoice template interpolates <code>customerName</code>, <code>notes</code> and <code>itemName</code> into HTML with no escaping. The PDF route renders that HTML through Chromium launched with @sparticuz/chromium\'s default args, which include <code>--disable-web-security</code> and <code>--no-sandbox</code>.',
 'A tenant types a script tag into an order note — through their own UI or the write-scoped API — then requests the PDF. With same-origin policy off, that script can read http://metadata.google.internal and exfiltrate the functions\' service-account token, which holds Firestore admin over every tenant. This is the single worst finding: one paying customer escalates to full control of the whole platform.',
 'Escape every interpolation in orderDocument.mjs (an esc() helper already exists in the file), and launch Chromium with web security on and all network requests aborted.'],

['HIGH','Every invite code on the platform is readable by any signed-in user','firestore.rules:118',
 '<code>allow read: if isAuthed()</code> with no orgId predicate. This permits list, not just get.',
 'Any user dumps the whole inviteCodes collection — code, orgId, orgName, role, createdBy email — for every customer organisation. Pick any unexpired code with role admin and join that tenant through the normal UI. No rule bypass required. A second branch of the update rule (line 127) also lets any user reset uses/status on any tenant\'s codes — re-arming spent codes, or revoking a competitor\'s onboarding.',
 'Deny list; validate codes in a Cloud Function that returns only {valid, orgName}.'],

['HIGH','Tenant carrier API keys are stored in the org doc and read into the browser','src/pages/Shipping.jsx:96,138',
 'Live Shippo / ShipStation / EasyPost keys are written to <code>organizations/{orgId}.settings</code> and read back into React state, with a "Show" toggle that renders them in plaintext. The organizations read rule grants access to any member.',
 'Every staff-level user in a tenant can lift their employer\'s live carrier credentials. Combined with the membership hole, an outside attacker self-joins a tenant and walks away with keys that spend real money.',
 'Move carrier keys to Secret Manager or a function-only collection with no client read rule; return a masked preview to the UI.'],

['HIGH','Update rules never pin orgId, so a document can be pushed into another tenant','firestore.rules:156 and 8 more',
 'Create rules correctly gate on <code>request.resource.data.orgId</code>. Update rules authorise against <code>resource.data.orgId</code> — the existing value — and never check the incoming one. The two helpers written for this, belongsToOrg and writingToOrg (lines 41-48), are defined and never called.',
 'A manager edits one of their own items and sets orgId to a victim tenant. The record leaves their inventory and appears inside the victim\'s catalogue, price list and reports — arbitrary data injection: poisoned SKUs, fake customers, fake revenue rows.',
 'Add && request.resource.data.orgId == resource.data.orgId to every update rule.'],

['HIGH','Removed employees keep full access','firestore.rules:20 + src/orgDb.js:230',
 'Membership checks are existence-only. Off-boarding sets <code>status:"removed"</code> rather than deleting the document, and the string "status" never appears in any orgMembers rule.',
 'A fired employee still passes isMember, isStaff, isManager and isAdmin. The UI hides the org, the rules do not — a direct SDK or REST call reads and writes that tenant\'s data indefinitely.',
 'Require membership(orgId).status == "active", or hard-delete the membership row on removal.'],

['HIGH','Billing, plan and trial state are client-side only','firestore.rules:71 + src/App.jsx:240',
 'The rules never protect plan, status, trialEndsAt, subscriptionId or customerId — grep returns zero matches. updateOrganization is an unfiltered passthrough. The subscription gate is a React redirect.',
 'A tenant admin sets their own plan to enterprise and trialEndsAt to 2099 and uses the product free forever. An expired or cancelled tenant keeps working by calling Firestore directly. No Cloud Function checks plan either.',
 'Restrict client writes on the org doc with affectedKeys().hasOnly([...]); leave billing fields to the Stripe webhook; re-check plan in callables.'],

['HIGH','Plan limits are declared but three of five are never enforced anywhere','src/useTier.js:20 + src/pages/Locations.jsx:228',
 'checkLimit has exactly two call sites in the codebase — locations and warehouses. The caps on users, orders and items are never checked, in the browser or the server. Even the two that are checked are an alert() in a click handler.',
 'A Starter tenant holds 40,000 items, 30 seats and unlimited orders on a plan sold with caps of 2,000 / 2 / 50. Feature tiers are the same story: TierGate hides Shipping and Reports in the UI, but a Starter tenant calls generateShippingLabel directly. The gate also fails open on an unmapped feature name.',
 'Keep counters on the org doc via onCreate triggers and enforce in rules; check plan inside gated callables.'],

['MEDIUM','No transactions anywhere — concurrent picks lose stock','src/orgDb.js:687, 1217, 1235, 1293',
 'A grep for runTransaction and increment() across src/ returns zero hits. Every quantity path is read-modify-write: get the doc, mutate the locations array in JS, overwrite the whole array.',
 'Two pickers on the same SKU both read 50, both write 45 — ten units vanish. The stockDeducted guard on orders (orgDb.js:1939) has the same shape: the flag is read, a whole deduction loop runs, then the flag is written, so two users marking one order shipped both deduct. For an inventory system this is the most consequential correctness bug in the file.',
 'Wrap stock mutations in runTransaction, or move them into a Cloud Function.'],

['MEDIUM','Rules have not been touched since May while the schema kept moving','firestore.rules (last commit 4 May 2026)',
 'apiKeys and expenses are written by the client but have no rule block, so they fall through to the catch-all deny. orgDb.js was last changed today; the rules four months ago.',
 'Either the API-key and Expenses features are silently failing in production with permission-denied, or the deployed ruleset is not the file in this repo — in which case the deployed rules are unreviewed and none of this audit can be assumed complete. Worth resolving before anything else here.',
 'Diff deployed rules against the repo; add explicit org-scoped rules for both collections; put rules deployment in CI.'],

['MEDIUM','Print and export paths interpolate user data into HTML unescaped','~18 sites across src/pages/',
 'Every document.write template concatenates raw fields: order.customerName, item.itemName, item.notes, pickList.name, and org logoUrl straight into an unquoted src attribute (Customers.jsx:462).',
 'The generated window is same-origin, so injected script runs with the victim\'s Firebase session. Note the fix already exists in-repo — catalog.js:6 defines an escaper and uses it; the print paths just do not.',
 'Export the existing escapeHtml and wrap every interpolation in the print templates.'],

['MEDIUM','mergeLabelPdfs fetches arbitrary URLs server-side','functions/index.js:848',
 'Takes a list of URLs from the caller and fetches each with no allowlist, no scheme check, and node-fetch following redirects.',
 'Confirmed blind SSRF against internal hosts. Not confirmed metadata exfiltration through this function specifically — the metadata server rejects requests without its header, and non-PDF bodies fail PDFDocument.load. Still worth closing.',
 'Allowlist the label hosts actually used, require https, set redirect: manual.'],

['MEDIUM','Customer PII and carrier account numbers written to Cloud Logging','functions/index.js:315, 493',
 'Full recipient records — name, company, street, email, phone — are logged for every label and every rate quote. Line 493 logs the customer\'s third-party UPS/FedEx billing account number in cleartext.',
 'All tenants share one project\'s logs, where retention and access are not tenant-scoped. No credentials are logged — this is PII and account numbers, not secrets.',
 'Log only city/state/zip, or put these behind a debug flag.'],

['MEDIUM','The rate limiter does not limit anything under load','functions/index.js:24',
 'An in-memory map per function instance. Cloud Functions scales horizontally, so the real limit is maxCalls multiplied by the number of live instances — and burst traffic is exactly what spawns instances.',
 'It is weakest precisely when it matters, and resets on every cold start and deploy. Against the label-purchase abuse above it is worth roughly nothing. The MCP endpoint has no rate limiting at all.',
 'Move counters to Firestore or Memorystore keyed by uid; treat the in-memory map as a courtesy.'],

['LOW','The hourly shipping job has been silently failing','functions/index.js:617, 797',
 '<code>processOrgPackedOrders</code> is called twice and defined nowhere. It is a runtime ReferenceError, so the file still passes node --check.',
 'checkPackedOrdersScheduled throws on every org and swallows it into console.error, so automated label generation has not been running. triggerShippingCheck surfaces it as an internal error.',
 'Either implement it or remove the calls and the scheduled function.'],

['LOW','Dead code and a stale server copy in the repo root','several',
 'src/db.js is a legacy single-tenant layer with zero orgId references, reachable only through AuthContext.jsx / ProtectedRoute.jsx / Login.jsx — none of which are imported by anything (App.jsx defines its own ProtectedRoute). src/companyLogo.js is 107KB of unused base64. A stale 107KB copy of functions/index.js sits in the repo root. CountInventory.jsx, CreateLocation.jsx and ImportData.jsx are unreferenced.',
 'db.js is not in the bundle today, but if anyone repairs that import chain the app immediately starts writing orgId-less rows that the rules reject and a try/catch swallows.',
 'Delete db.js, AuthContext.jsx, ProtectedRoute.jsx, Login.jsx, companyLogo.js, the root index.js and the three orphan pages in one commit.'],

['LOW','Missing composite indexes, with a fallback that returns wrong data quietly','src/orgDb.js:2159',
 'movements and activityLog are queried with where(orgId) + orderBy(timestamp) but have no declared composite index. getMovements catches the index error and retries without the orderBy.',
 'That returns an arbitrary 500 documents, sorted in memory — so recent movements, the dashboard trend and dead-stock show a wrong subset rather than failing visibly.',
 'Declare the orgId+timestamp indexes and remove the silent fallback.'],

['LOW','Unbounded whole-collection reads on every page load','src/orgDb.js:761, 915, 2240',
 'No query paginates. Reports loads six full collections at once; the dashboard reads all items, all locations and 500 movements and aggregates in JS; getPriceChangeLog reads 5,000 activity rows plus all items.',
 'Fine at your scale. A Business tenant with 50,000 SKUs pays for 50,000 document reads per page view and may exhaust browser memory.',
 'Paginate with limit + startAfter; move report aggregation to precomputed rollup docs.'],
];

const done = [
 'API key design is sound — 256 bits from crypto.getRandomValues, only the SHA-256 stored, plaintext shown once, revocation honoured on every request, and orgId always derived from the key rather than the request.',
 'The Stripe webhook is correct: signature verified against req.rawBody as the very first statement, before any Firestore write.',
 'No secrets in the client bundle. Nothing is VITE_ prefixed; .env and functions/.env are gitignored and have never been committed. The Firebase web config in src/firebase.js is public by design and is not a finding.',
 'Create rules do correctly gate on the incoming orgId — it is only the update rules that miss it.',
 'Movements and activity logs are immutable in the rules.',
 'The catch-all deny at the end of firestore.rules is present and correct.',
 'No dangerouslySetInnerHTML, eval, innerHTML or srcdoc anywhere in src/.',
 'The metadata-server access token is never returned to a caller and never logged.',
];

const order = ['CRITICAL','HIGH','MEDIUM','LOW'];
const col = {CRITICAL:'#b3261e',HIGH:'#b26a00',MEDIUM:'#1976d2',LOW:'#5f6368'};
const counts = order.map(s=>[s,F.filter(f=>f[0]===s).length]);
const cards = counts.map(([s,n])=>`<div class="stat"><b style="color:${col[s]}">${n}</b><span>${s}</span></div>`).join('');
const body = F.map((f,i)=>`<div class="find">
<div class="fh"><span class="sev" style="background:${col[f[0]]}">${f[0]}</span><span class="num">${String(i+1).padStart(2,'0')}</span><span class="ft">${f[1]}</span></div>
<div class="loc">${f[2]}</div>
<div class="row"><b>What it is</b><p>${f[3]}</p></div>
<div class="row"><b>Why it matters</b><p>${f[4]}</p></div>
<div class="row fix"><b>Fix</b><p>${f[5]}</p></div>
</div>`).join('');

const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>SkidSling security audit</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Arial,sans-serif;color:#333;font-size:10px;line-height:1.45;padding:0}
code{font-family:Consolas,monospace;background:#f1f3f4;padding:0 3px;border-radius:2px;font-size:9.5px}
.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1976d2;padding-bottom:9px;margin-bottom:11px}
.t{font-size:21px;font-weight:300;color:#1976d2;letter-spacing:.5px}
.s{font-size:12px;font-weight:700;margin-top:1px}
.co{text-align:right;font-size:9px;color:#555}.co strong{font-size:11px;color:#333;display:block}
.lede{background:#fff4f4;border-left:3px solid #b3261e;padding:9px 11px;margin-bottom:11px;font-size:10px}
.stats{display:flex;gap:9px;margin-bottom:12px}
.stat{flex:1;background:#f8f9fa;border-left:3px solid #1976d2;padding:7px 10px}
.stat b{display:block;font-size:19px;line-height:1.1}
.stat span{font-size:8px;letter-spacing:.8px;color:#888;text-transform:uppercase}
h2{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#1976d2;margin:14px 0 7px;padding-bottom:3px;border-bottom:1px solid #e0e0e0}
.find{border:1px solid #e0e0e0;border-radius:3px;margin-bottom:8px;padding:8px 10px;page-break-inside:avoid}
.fh{display:flex;align-items:baseline;gap:7px;margin-bottom:2px}
.sev{color:#fff;font-size:7.5px;font-weight:700;letter-spacing:.6px;padding:1.5px 5px;border-radius:2px}
.num{font-size:9px;color:#bbb;font-weight:700}
.ft{font-size:11.5px;font-weight:700;flex:1}
.loc{font-family:Consolas,monospace;font-size:8.5px;color:#777;margin-bottom:5px}
.row{display:flex;gap:8px;margin-top:3px}
.row b{flex:0 0 66px;font-size:8px;text-transform:uppercase;letter-spacing:.5px;color:#999;padding-top:1px}
.row p{flex:1}
.fix p{color:#0d7a52;font-weight:600}
.ok li{margin-bottom:3px;padding-left:13px;position:relative;list-style:none}
.ok li:before{content:"\\2713";position:absolute;left:0;color:#0d7a52;font-weight:700}
.plan{background:#f8f9fa;border-left:3px solid #0d7a52;padding:9px 11px;font-size:10px}
.plan ol{margin-left:15px}.plan li{margin-bottom:3px}
.foot{margin-top:14px;padding-top:7px;border-top:1px solid #e0e0e0;text-align:center;font-size:8px;color:#999}
@page{size:Letter;margin:.45in}
</style></head><body>
<div class="header"><div><div class="t">SECURITY &amp; CODE AUDIT</div><div class="s">SkidSling — multi-tenant inventory platform</div></div>
<div class="co"><strong>AA Surplus Sales</strong>Repo: aasurplussalesinc/AA-Sales<br>3 September 2026<br>Read-only review — nothing changed</div></div>

<div class="lede"><b>Verdict: the tenant boundary does not currently hold.</b> Two independent findings each grant one customer full access to every other customer's data. Finding 01 lets any signed-in user write their own membership record into any organisation, including the SkidSling owner org. Finding 02 is that sixteen Cloud Functions accept an <code>orgId</code> from the caller and never check they belong to it — and the Admin SDK bypasses Firestore rules, so nothing else stops them. Finding 03 turns an order note into a service-account token. This is a working product with real customers and real money moving through it; these are worth treating as urgent rather than as backlog.</div>

<div class="stats">${cards}<div class="stat" style="border-color:#0d7a52"><b style="color:#0d7a52">8</b><span>Done well</span></div></div>

<h2>Findings</h2>
${body}

<h2>What is already right</h2>
<div class="find"><ul class="ok">${done.map(d=>`<li>${d}</li>`).join('')}</ul></div>

<h2>Suggested order</h2>
<div class="plan"><ol>
<li><b>Confirm which rules are actually deployed.</b> The repo's rules are four months older than the code. Everything below assumes the file in the repo is live — verify that first, because if it isn't, this audit is reviewing the wrong document.</li>
<li><b>Finding 01</b> — the orgMembers create rule. One rule, and it subsumes several others.</li>
<li><b>Finding 02</b> — one assertMember helper, called at the top of sixteen functions. Mechanical, and it closes the money leaks.</li>
<li><b>Finding 03</b> — escape the document template and lock down Chromium. Small change, worst consequence.</li>
<li><b>Findings 04-09</b> — invite codes, carrier keys, update-rule orgId pinning, removed staff, billing fields, plan limits.</li>
<li><b>Finding 10</b> — transactions on stock. Not a security issue, but it is quietly costing you count accuracy today.</li>
<li>The rest as cleanup.</li>
</ol></div>

<div class="foot">Generated 3 September 2026 · four parallel reviews: Firestore rules · Cloud Functions · React client · repo hygiene · no files were modified</div>
</body></html>`;
(async()=>{
  const chromium=require('@sparticuz/chromium'); const puppeteer=require('puppeteer-core');
  const b=await puppeteer.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});
  const p=await b.newPage(); await p.setContent(html,{waitUntil:'load'});
  const buf=await p.pdf({format:'Letter',printBackground:true,margin:{top:'.45in',right:'.45in',bottom:'.45in',left:'.45in'}});
  require('fs').writeFileSync('/sessions/rcw-01qsssopzvcng16d8zxkjjxg/mnt/AA Inventory System/SkidSling-security-audit.pdf',Buffer.from(buf));
  console.log('PDF bytes:',buf.length); await b.close(); process.exit(0);
})().catch(e=>{console.log('FAILED:',e.message);process.exit(1);});
