# Build plan: Stripe invoicing & automatic collections in SkidSling

Owner: Alan (AA Surplus Sales, first tenant). Written 2026-09-28 by the AA Chief of Staff for the coding agent.
**Goal (Alan's words):** "I want the system to be able to send these invoices without me having to call each one and
chase people down." Build it so a company can send invoices, get paid online (card + ACH), and have SkidSling chase
unpaid balances automatically, with every payment landing back on the order.

**Read first:** `..\HANDOFF.md` sections 2C, 5, 6, 7 (hard rules: multi-tenant, tenant isolation by `orgId`, never break
existing data, tests `node --test tests/unit/*.mjs`, the agent never pushes/deploys; Alan deploys).

---

## 0. Ground rules for this build

- **Test mode first, end to end.** Everything runs against Stripe **test mode** until Alan signs off. No live keys in
  code, env or commits. Live mode is a separate, final step Alan does (section 9).
- **SkidSling's invoice stays the source of truth.** Stripe only collects money. No Stripe Invoicing product (it would
  duplicate numbering, add a per-invoice fee, and pull customers off SkidSling branding).
- **Stripe Connect, Standard accounts.** Each company (tenant) connects its OWN Stripe account; SkidSling stores only
  the connected account id. Never store or ask for a tenant's API keys. Never touch card data (Stripe-hosted pages only).
- **Tenant isolation:** every Stripe call for a company uses its connected account (`Stripe-Account` header); every
  webhook event is mapped to exactly one org by account id and ignored if unknown. Same rule as everything else.
- **Feature flag per org:** `org.payments.enabled` (off by default). Automatic sending/reminders are a separate
  per-org setting, also off by default (section 6). Nothing emails a customer unless the org turned it on.
- Branch `stripe-invoicing` from `main`; small commits per phase; don't push, merge or deploy.

## 1. Platform setup (Alan does this in Stripe, test mode; document the steps for him)

- **Use the EXISTING SkidSling platform Stripe account** (Alan, 2026-09-28: it already takes SkidSling subscription
  payments; see `functions/index.js` ~line 1023 "STRIPE INTEGRATION": `stripe` SDK, `STRIPE_SECRET_KEY`,
  `STRIPE_PRICE_*`, `createCheckoutSession`, billing portal, and `exports.stripeWebhook` with `STRIPE_WEBHOOK_SECRET`).
  Alan enables **Connect** on it (Standard accounts, Account Links/OAuth, redirect to the SkidSling settings page,
  branding "SkidSling"). NOT the Squarespace-managed AA retail account.
- **Subscription billing must not change or break.** Keep `stripeWebhook`, its secret, `stripeCustomerId` /
  `stripeSubscriptionId` and the plan/price logic exactly as they are. Invoicing code lives in its own module
  (e.g. `functions/invoicing.js`), with its OWN webhook endpoint (`stripeConnectWebhook`) registered in Stripe as a
  **Connect** webhook ("events on connected accounts") with its own secret. Note: the subscription webhook already
  handles Stripe `invoice.*` events for SkidSling's own billing; the Connect endpoint must not handle platform events,
  and the platform endpoint must ignore events that carry `event.account`.
- **Test mode without touching live billing:** the existing `STRIPE_SECRET_KEY` may be live. Invoicing uses its own
  env so it can run in test mode while subscriptions stay live: `STRIPE_CONNECT_SECRET_KEY` (platform key, **test**
  `sk_test_...` during testing), `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID` if using OAuth,
  `APP_BASE_URL`, `INVOICING_MODE=test|live`. Guard: refuse to start invoicing if the mode and key prefix disagree.
- The `stripe` SDK is already a functions dependency; reuse it (a second client instance for the Connect key).
  No new dependencies expected; say so if one is needed.
- Org fields: keep billing fields (`stripeCustomerId`, `stripeSubscriptionId`) separate from invoicing fields
  (`payments.stripeAccountId` ...) so a company's SkidSling subscription and its own customers' payments never mix.

## 2. Data model (Firestore; additive only)

- `organizations/{orgId}.payments`: `{ enabled, stripeAccountId, chargesEnabled, payoutsEnabled, detailsSubmitted,
  connectedAt, methods: ['card','us_bank_account'], autoSend: {...section 6}, cardSurcharge: {...section 7} }`.
- `purchaseOrders/{id}` additions (never remove existing fields): `invoice: { number, issuedAt, dueAt, terms,
  sentAt, sentTo, lastReminderAt, reminderCount, status }` where status ∈ `draft | sent | partially_paid | paid |
  overdue | void`; `amountPaid`, `balanceDue` (derived, stored for querying), `payStatusUpdatedAt`.
  `dueAt` comes from the existing terms (Net 30 etc.) and the invoice date the documents already use.
- New collection `payments/{id}`: `{ orgId, orderId, orderNumber, customerId, amount, currency, method
  (card|ach|check|cash|other), stripe: { accountId, checkoutSessionId, paymentIntentId, chargeId }, fee, net,
  status (pending|succeeded|failed|refunded|partially_refunded), createdAt, succeededAt, refundedAmount, source
  (stripe|manual), note, createdBy }`. **Manual payments** (check, cash, Zelle) are recorded here too, so balances are
  always right regardless of how the customer paid.
- Unique key per Stripe event/payment intent to make every write **idempotent** (store processed `event.id`s in
  `stripeEvents/{eventId}` with orgId + processedAt).
- Firestore rules: payments readable/writable only by the org's staff; `stripeEvents` server-only. Add rules tests in
  `tests/rules/` like the existing ones.

## 3. Connect onboarding (Phase 1)

- **Settings → Payments** page: "Connect with Stripe" button → server creates an Account Link (or OAuth URL) →
  returns to SkidSling → server stores `stripeAccountId` and refreshes `chargesEnabled/payoutsEnabled/detailsSubmitted`.
- Status panel: Connected / Needs info (with a "Finish setup in Stripe" link) / Disconnected; "Disconnect" stops
  new pay links (doesn't touch past payments).
- `account.updated` webhook keeps the flags current.
- **Acceptance:** a test Standard account connects, flags show correctly, a second org can't see or use it.

## 4. "Pay online" on invoices (Phase 2)

- Server endpoint `createInvoiceCheckout(orgId, orderId)`: loads the order, recomputes the **current balance due**,
  refuses if 0, and creates a **Stripe Checkout Session** on the connected account:
  one line "Invoice AA6676 (PO KB-15317)" for the balance, `payment_method_types` from org settings
  (card + `us_bank_account` for ACH), `customer_email` from the order, metadata `{orgId, orderId, orderNumber}`,
  success/cancel URLs to a simple SkidSling "Thank you / Invoice status" page.
- **Stable pay link on the document:** the invoice PDF and email carry a SkidSling URL
  `/{org}/pay/{orderId}?t=<signed token>`; opening it creates a fresh Checkout Session for the balance at that moment
  (so links never go stale and partial payments just work). Token: HMAC of orderId+orgId, no expiry needed while
  balance > 0; revoke on void.
- Show on the order screen: balance due, payments list, "Copy pay link", "Record manual payment".
- `orderDocument.mjs`: invoice shows **Amount paid / Balance due** and a "Pay online" link/button + the short URL
  text (so a printed copy is usable). Estimates never get a pay link.
- **Acceptance:** test card and test ACH pay a test invoice; partial payment leaves a correct balance; a second
  payment clears it; the pay link for a fully paid invoice shows "Paid, thank you" instead of a checkout.

## 5. Webhooks → payments ledger → order status (Phase 3) — this is what ends the manual chasing

- One Connect webhook endpoint (`stripeConnectWebhook`, raw body, signature verified with
  `STRIPE_CONNECT_WEBHOOK_SECRET`), separate from the existing subscription `stripeWebhook` (section 1).
- **Regression test for billing:** add a unit test proving the subscription webhook's event handling is unchanged
  and that it ignores connected-account events.
- Handle: `checkout.session.completed` (card: paid now; ACH: payment pending), `payment_intent.succeeded`,
  `payment_intent.payment_failed` (ACH failures arrive days later), `charge.refunded`, `charge.dispute.created`,
  `account.updated`. Map `event.account` → org; unknown account → 200 + ignore + log.
- Write/merge the `payments` doc, recompute `amountPaid/balanceDue`, set invoice status (`paid` / `partially_paid`;
  ACH pending shows "Payment pending (bank transfer)"), record Stripe fee + net from the balance transaction.
- Idempotent by event id and payment intent id. Out-of-order events must converge to the same final state.
- Notify the org (in-app + optional email to the org's billing address): "AA6676 paid $1,200.00 by ACH".
- **Overdue logic:** daily job marks `sent` invoices past `dueAt` with balance > 0 as `overdue`.
- **Report for agents/humans:** extend the MCP `list_orders` (and add `list_open_invoices`, read-only) with
  `invoice.status`, `balanceDue`, `dueAt`, `daysOverdue`, `lastReminderAt`, so the AA Chief of Staff's overdue report
  reads real payment status instead of guessing.
- **Acceptance:** Stripe CLI `stripe trigger` / test payments drive every status; replaying the same event twice
  changes nothing; an ACH failure flips a "pending" payment back and restores the balance; refunds reduce amountPaid.

## 6. Automatic sending & reminders (Phase 4) — "without me having to call each one"

Per-org settings (Settings → Payments → Automatic collections), all **off by default**:
- **Send invoice automatically when an order ships** (on/off). Otherwise a "Send invoice" button on the order.
- **Reminder schedule** (editable list of days relative to due date, default: `-3` (friendly "coming due"),
  `0` (due today), `+7`, `+14`, `+30` (final notice)). Stop as soon as balance = 0, invoice void, or the customer
  is marked "Do not remind".
- **Per-customer overrides** on the customer record: billing email(s) (separate from the ordering contact),
  "Do not remind", "Remind by phone instead" (just flags it on the collections list), custom terms.
- Email via the existing **Brevo** helper (`functions/index.js` ~line 1788; `BREVO_API_KEY`) from the org's name with
  reply-to = org billing address; body = friendly text + invoice PDF attached + big "Pay online" button + balance and
  due date. Each send logged on the order (`invoice.sentAt`, `lastReminderAt`, `reminderCount`, email id). Respect
  Brevo free-tier limits (300/day); queue and spread if needed.
- Scheduled function (pattern: existing `functions.pubsub.schedule(...)` jobs) runs daily at 9:00 AM org time, finds
  due reminders, sends, logs. Hard caps: max 1 email per invoice per day; never email a paid/void invoice.
- **Statement email** (monthly or on demand): one email per customer listing ALL open invoices with one pay link for
  the total (a Checkout Session for the sum, allocated to invoices oldest-first in the webhook).
- **Collections view**: a page listing open balances by customer (current / 1-30 / 31-60 / 61-90 / 90+), last
  reminder, next reminder, "Send now", "Pause reminders", "Record payment". This replaces the manual overdue CSV.
- **Acceptance (test mode, with Stripe test clocks or a fake "now" in tests):** an invoice created with due date in
  the past gets the right reminders on the right days, stops the moment it's paid, never double-sends.

## 7. Card fees (decision for Alan before live)

AA's invoices already say "Payments by credit card are subject to a 3.5% processing fee". Options:
(a) offer ACH prominently (cheap: ~0.8% capped) and absorb card fees; (b) show card as a separate option with a
surcharge line added to the Checkout Session (surcharging has card-network rules, a cap (currently 3% in the US) and
some states restrict it — needs Alan's/accountant's OK); (c) cards off for large invoices (e.g. > $2,500 ACH only).
Build the setting (`cardSurcharge: {enabled, percent, maxInvoiceForCards}`) but ship with surcharge **off**.

## 8. Tests & verification

- Unit tests (pure helpers, like `stockLedger`): balance math (partials, refunds, overpayment → credit), invoice
  status transitions, reminder schedule planner (given dueAt/now/history → which email today), statement allocation
  oldest-first, webhook event → ledger reducer (idempotent, order-independent), pay-link token sign/verify.
- Rules tests for `payments` and `stripeEvents`.
- Stripe test mode walkthrough script for Alan (section 9) with test card `4242 4242 4242 4242` and Stripe's test
  bank account numbers.
- `node --check` functions; parse JSX (no root node_modules; don't install beyond `stripe` in functions).

## 9. Alan's test run (test mode) and go-live

1. Alan enables Connect on the existing SkidSling platform account, switches the dashboard to **Test mode**, copies
   the test secret key and creates the Connect webhook (test), then puts `STRIPE_CONNECT_SECRET_KEY`,
   `STRIPE_CONNECT_WEBHOOK_SECRET` and `INVOICING_MODE=test` in the functions `.env` himself (never in chat).
   Subscription billing keeps running on its live key the whole time.
2. Deploy functions + frontend (usual steps). Connect a **test** Stripe account for AA in Settings → Payments.
3. Create a test customer with Alan's own email, a small test order, ship it → invoice email arrives with the PDF and
   "Pay online" → pay with the test card → order shows Paid, payment in the ledger, confirmation email.
4. Second order: pay half by test ACH, check "partially paid / pending", then the rest.
5. Back-date a third order's due date → run the reminder job manually → reminder arrives; pay → reminders stop.
6. Sign-off → switch env to live keys, reconnect AA's real Stripe account (a NEW Stripe account for SkidSling
   payments is fine; it must not be the Squarespace-managed retail account), enable automatic collections for AA.

## 10. Deliverables & report

Branch `stripe-invoicing`, one commit per phase (1 onboarding, 2 pay online, 3 webhooks/ledger, 4 automatic
collections, 5 collections view + statements), each with passing tests. Update `..\HANDOFF.md` (env names only, how
it works, the test script). Report: what's built per phase, test results, exact deploy steps (functions, frontend,
firestore rules/indexes), Stripe dashboard steps for Alan, and what's unverified.
