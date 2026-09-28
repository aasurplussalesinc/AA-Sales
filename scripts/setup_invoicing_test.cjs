/* One-time TEST-MODE setup for SkidSling invoicing (docs/PLAN_stripe_invoicing.md, HANDOFF §11).
 *
 * Reads STRIPE_CONNECT_SECRET_KEY (sk_test_… from the Stripe sandbox/test mode) from functions/.env, then:
 *   1. refuses anything that isn't a test key;
 *   2. creates (or reuses) the Connect webhook endpoint for stripeConnectWebhook with the 11 events, API 2023-10-16;
 *   3. writes STRIPE_CONNECT_WEBHOOK_SECRET, INVOICE_LINK_SECRET, INVOICING_MODE=test and APP_BASE_URL into functions/.env.
 * Secrets are written to the file only and are never printed. Safe to run again (no duplicate webhooks).
 * Run from the repo root:  node scripts/setup_invoicing_test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV = path.join(__dirname, '..', 'functions', '.env');
const URL = 'https://us-central1-warehouse-inventory-cec3b.cloudfunctions.net/stripeConnectWebhook';
const API_VERSION = '2023-10-16';
const EVENTS = [
  'account.updated', 'account.application.deauthorized',
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'payment_intent.processing', 'payment_intent.succeeded', 'payment_intent.payment_failed',
  'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed',
];

function readEnv() {
  const text = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  const map = {};
  text.split(/\r?\n/).forEach((l) => { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) map[m[1]] = m[2].trim(); });
  return { text, map };
}

function setVars(vars) {
  let { text } = readEnv();
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : text.replace(/\s*$/, '') + `\n${k}=${v}\n`;
  }
  fs.writeFileSync(ENV, text);
}

(async () => {
  const { map } = readEnv();
  const key = map.STRIPE_CONNECT_SECRET_KEY || '';
  if (!key) { console.error('STRIPE_CONNECT_SECRET_KEY is not in functions/.env yet.'); process.exit(1); }
  if (!key.startsWith('sk_test_')) { console.error('Refusing: STRIPE_CONNECT_SECRET_KEY is not a test key (must start with sk_test_).'); process.exit(1); }
  const stripe = require(path.join(__dirname, '..', 'functions', 'node_modules', 'stripe'))(key, { apiVersion: API_VERSION });

  const acct = await stripe.accounts.retrieve();
  console.log(`Test key OK for platform account ${acct.id} (${acct.settings?.dashboard?.display_name || acct.business_profile?.name || 'no display name'}).`);

  const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find((w) => w.url === URL);
  const vars = {};
  if (existing) {
    const missing = EVENTS.filter((e) => !existing.enabled_events.includes(e));
    if (missing.length) await stripe.webhookEndpoints.update(existing.id, { enabled_events: EVENTS });
    console.log(`Webhook already existed (${existing.id}); events ${missing.length ? 'updated' : 'already correct'}.`);
    if (!map.STRIPE_CONNECT_WEBHOOK_SECRET) {
      console.log('NOTE: its signing secret is only shown once by Stripe. Copy it from Developers > Webhooks > this endpoint > Signing secret into STRIPE_CONNECT_WEBHOOK_SECRET in functions/.env.');
    }
  } else {
    const wh = await stripe.webhookEndpoints.create({
      url: URL, connect: true, api_version: API_VERSION, enabled_events: EVENTS,
      description: 'SkidSling invoicing (Connect) - test',
    });
    vars.STRIPE_CONNECT_WEBHOOK_SECRET = wh.secret;
    console.log(`Created Connect webhook ${wh.id} (API ${API_VERSION}, ${EVENTS.length} events). Signing secret written to functions/.env.`);
  }
  if (!map.INVOICE_LINK_SECRET) { vars.INVOICE_LINK_SECRET = crypto.randomBytes(32).toString('hex'); console.log('Generated INVOICE_LINK_SECRET.'); }
  vars.INVOICING_MODE = 'test';
  if (!map.APP_BASE_URL) vars.APP_BASE_URL = 'https://skidsling.com';
  setVars(vars);
  console.log('functions/.env updated: ' + Object.keys(vars).join(', ') + ' (values not shown).');
})().catch((e) => { console.error('Stripe error:', e.message); process.exit(1); });
