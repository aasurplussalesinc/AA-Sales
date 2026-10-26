# SkidSling plans and AI access: changes of 2026-10-26

Branch `plans-ai-1026`. Nothing has been pushed, deployed or changed in live data or in Stripe.
This note covers what changed, the Stripe steps that are yours to do, and the deploy order.

## 1. The plans as they are now

| | Starter | Pro | Business | Enterprise |
|---|---|---|---|---|
| Price | $100/mo, $1,000/yr | $250/mo, $2,500/yr | **$400/mo, $4,000/yr** | Contact us (custom) |
| Users | 2 | 5 | 15 | Unlimited |
| SKUs (items) | **5,000** | 10,000 | 50,000 | Unlimited |
| Warehouses | 1 | 3 | 10 | Unlimited |
| Shelf locations | 250 | 2,000 | 20,000 | Unlimited |
| Orders per month | **Unlimited** | **Unlimited** | **Unlimited** | Unlimited |
| AI assistant | Read-only | Full control | Full control | Full control |

The trial keeps Business-level features and its own limits (15 users, 10,000 SKUs, 2 warehouses,
500 locations), but orders are now unlimited there too.

**Every plan:** inventory, multi-location shelves, QR codes, warehouse map, receiving, CSV import/export,
customer CRM, roles and audit log, your company logo on documents, the free trial, and the AI assistant
in read-only mode.

**Pro adds:** AI assistant with full control, orders, pick lists, box packing, triwall packing (moved down
from Business), invoices and packing slips, online invoices with card/ACH and automatic reminders.

**Business adds:** reports (dead stock, turnover; moved up from Pro), voice-assisted receiving, live rates
(UPS, USPS, FedEx, DHL), your Shippo / ShipStation / EasyPost accounts, labels and batch printing,
international and customs, scheduled auto-shipping, blind drop-ship, bill shipping to the customer's UPS
account and dual insurance comparison (both moved down from Enterprise), vendor contracts. Service:
done-for-you setup, AI assistant set up for you, priority direct line.

**Enterprise:** everything in Business, unlimited everything, custom price. The button opens an email to
info@skidsling.com. Marketplace sync (Shopify, eBay, Squarespace) and several companies under one login are
shown as "coming soon".

**Founding customers (first 10):** free done-for-you setup, AI assistant setup and a direct line, on any
plan. You grant it by hand (see section 2, Admin page).

Logo branding was checked: the logo from Settings appears on invoices and packing lists, customer
statements, the online payment page, the invoice and reminder emails, and the catalog / price list.

## 2. What changed in the app

**Limits**
- Orders are no longer capped anywhere (app, server, database rules).
- Starter goes from 2,000 to 5,000 SKUs.
- The warehouse cap is now enforced by the database, not only by the browser. A "warehouse" is the first
  part of a location code (W1, W2 and so on, or the first level of a custom location layout). A new shelf in
  a warehouse you already use is always fine; opening a new warehouse is refused once the plan's number is
  reached. STAGING never counts. Moving a shelf into a new warehouse is checked the same way.
- The usage counters behind the caps can no longer be edited by a customer admin.

**Feature gates**
- Reports page needs Business. Pro customers lose the Reports tab (see decisions below).
- Triwall packing needs Pro (the packing screen hides the Triwall button below Pro).
- The Activity Log page is open on every plan. It was locked behind Pro, which contradicted "roles and
  audit on every plan".
- AA Surplus Sales' own account (plan "owner") keeps everything.

**Pricing pages**
- The landing page and the in-app "choose a plan" page now read from one list (`src/pricingPlans.js`), so
  they always agree.
- Business shows $400 / $4,000. The Enterprise card says "Contact us" and never starts a checkout.
- The approved founders line replaces the old "40% off for 24 months" founding box.
- The landing page features grid has a new "AI Assistant" tile with the approved wording. The
  "$100/mo Starting Price" stat stays.
- The Terms of Service price sentence now says Business $400 / $4,000 and Enterprise custom pricing (last
  updated date set to October 26, 2026).
- The trial welcome email now lists the real trial limits (2 warehouses, 500 locations, 10,000 items,
  unlimited orders).

**AI assistant (API keys, the MCP connector)**
- The connector's opening instructions now start with "SkidSling inventory for <the customer's company
  name>" and give only general guidance. AA's own notes (grades NEW/#1/#2, the W4-R1-F2 shelf code format,
  military surplus) are now AA's default "Notes for your AI assistant". That default lives in the code; no
  data was written. Any admin can write their own notes in Settings, API Access. If AA saves its notes
  there, the saved text replaces the default.
- Starter (and any expired account) is read-only. A key created as "read and write" works as read-only
  until the account is on Pro or higher. Order and invoice tools (create and update draft orders, list
  orders, open invoices, order documents) need Pro or higher, on the connector and on the REST API alike.
  The customer sees a plain message saying which plan they need.
- Settings, API Access: below Pro only "Read only" keys can be created, with a short explanation and a link
  to the plans. The database rules also refuse a write key below Pro.
- No per-plan AI usage limits. A safety limit stops any single key at 3,000 requests per clock hour, with a
  clear message saying when it resets. (The REST API also keeps its existing 300 per minute.)
- The "Ask Alan for a write-scoped key" messages are gone; customers are told to ask their admin.

**Stripe (code side)**
- Business price ids are still read from `functions/.env`. Nothing was created in Stripe.
- A checkout request for Enterprise is refused by the server, whatever the browser sends.
- Old Business prices keep mapping to "business" through two new optional settings (section 3).

**Founder flag**
- Admin page (owner only): a Founder checkbox on each organization and a "Founders: n / 10" count.
- Only the owner can set it. Customers cannot set it on themselves or at signup.
- The customer sees a small "Founder" badge on their plan banner in Settings.

## 3. Stripe steps (yours)

Do these before the new pricing page goes live. Otherwise the page says $400 and checkout still charges
$350.

1. In Stripe (live mode), open Product catalog and the **SkidSling Business** product.
2. Add a price: **$400.00 USD, recurring, monthly** (every 1 month). Save it and copy its price id
   (`price_...`).
3. Add another price: **$4,000.00 USD, recurring, yearly** (every 1 year). Save it and copy its price id.
   Checkout refuses an "annual" price that bills monthly, so check the interval.
4. Open `functions/.env` (on your machine, not in git):
   - Add `STRIPE_PRICE_BUSINESS_MONTHLY_LEGACY=` set to the **current** value of
     `STRIPE_PRICE_BUSINESS_MONTHLY` (the old $350 price).
   - Add `STRIPE_PRICE_BUSINESS_ANNUAL_LEGACY=` set to the **current** value of
     `STRIPE_PRICE_BUSINESS_ANNUAL` (the old $3,500 price).
   - Then set `STRIPE_PRICE_BUSINESS_MONTHLY=` to the new $400 price id and
     `STRIPE_PRICE_BUSINESS_ANNUAL=` to the new $4,000 price id.
   - Leave the Enterprise price settings as they are. Checkout no longer uses them; they only keep any
     existing Enterprise subscription mapped correctly.
5. If your Stripe customer portal lets customers switch plans (Settings, Billing, Customer portal,
   Products), replace the old Business prices with the new ones there too.
6. You may archive the old $350 / $3,500 prices so nobody new lands on them. Archiving does not touch
   existing subscriptions.

Existing Business subscribers, if any, keep their old price: Stripe never moves a subscription to a new
price by itself, and the legacy settings keep those subscribers on the "business" plan in SkidSling.

After deploying functions, check once: start a Business checkout from a trial account and confirm Stripe
shows $400 (close the page without paying).

## 4. Deploy order

1. **Stripe and `functions/.env`** (section 3).
2. **Functions:** `firebase deploy --only functions`. This brings the plan rules for the AI assistant, the
   rate limit, the Enterprise checkout refusal, the new Business price, and the trigger that keeps each
   account's warehouse list.
3. Optional, writes live data: `cd functions && node scripts/recount-usage.js` fills in every account's
   warehouse list at once. Without it, each account's list fills in the first time someone adds, edits or
   deletes a location. Until then the database allows a new warehouse for that account (it fails open, never
   closed).
4. **Database rules:** `firebase deploy --only firestore:rules`. Brings the warehouse cap, unlimited orders,
   the founder and usage-counter protection, and write keys on Pro only.
5. **Website/app:** merge `plans-ai-1026` into `main` and push (Vercel builds `main`). Do this last, so the
   Founder checkbox and the $400 page only appear once the rules and prices behind them are live.

Steps 2 and 4 can be swapped without breaking anything, but the order above is the safest.

## 5. Your decisions

1. **The old founding offer.** The landing page used to promise "40% off for 24 months, locked in, plus
   free onboarding and data migration". It is replaced by the approved founders line. If anyone was
   promised the 40%, honor it by hand in Stripe (coupon). If you want to keep that offer on the page,
   say so.
2. **Pro customers lose Reports.** Any current Pro customer who uses Reports will hit an upgrade screen.
   Consider telling them first, or keeping them on it by hand.
3. **Terms of Service.** The price sentence and "last updated" date changed. The terms already say prices
   can change with 30 days' notice; read it once before deploying.
4. **"List orders" on Starter.** The connector's list_orders tool (and REST GET /orders) now needs Pro
   like the other order tools. Starter has no orders in the app anyway.
5. **Existing Starter write keys** keep existing but act read-only. Nothing to do unless a Starter customer
   asks why their assistant can no longer change stock.
6. **Admin page revenue estimate** counts every Business account at $400. Anyone still paying $350 is
   over-counted by $50.
7. **Rate limit.** 3,000 requests per key per hour. Counts can run slightly low under heavy parallel
   bursts; it is a safety net, not billing.

## 6. Tests and checks run

- Unit tests (`node --test tests/unit/*.test.mjs`): 284 pass, 0 fail (247 before this work). New:
  plan limits and the warehouse list, feature gates, billing plans, AI access (scopes, plan gating,
  per-org instructions, notes, rate limit, REST), pricing pages.
- Rules tests (`cd tests/rules && npm test`): 136 pass, 0 fail. Worst-case document reads per request
  went from 11 to 9 (Firestore's limit is 10).
- Real Firestore emulator (`tests/rules/emulator_smoke.mjs`): 23 of 23 cases pass.
- `npm run build` (Vite) succeeds. The functions code loads cleanly.
- The landing page pricing section was checked in a browser.
