/* Switch SkidSling invoicing from the Stripe sandbox to LIVE (and back). Secrets are never printed.
 *
 *   node scripts/setup_invoicing_live.cjs check    read-only: is the live key / Connect / client id ready?
 *   node scripts/setup_invoicing_live.cjs apply    go live (then: firebase deploy --only functions)
 *   node scripts/setup_invoicing_live.cjs revert   back to the sandbox values saved by "apply"
 *
 * Live key: STRIPE_CONNECT_LIVE_SECRET_KEY if present in functions/.env, else the live platform key the
 * subscriptions already use (STRIPE_SECRET_KEY). Live OAuth client id: STRIPE_CONNECT_LIVE_CLIENT_ID (ca_...).
 * "apply":
 *   1. saves the sandbox invoicing values to functions/.env.sandbox (gitignored);
 *   2. creates (or reuses) the LIVE Connect webhook for stripeConnectWebhook (same 11 events, API 2023-10-16);
 *   3. sets STRIPE_CONNECT_SECRET_KEY / _WEBHOOK_SECRET / _CLIENT_ID to the live ones, INVOICING_MODE=live, and
 *      a new INVOICE_LINK_SECRET (old sandbox pay links stop working).
 * Nothing moves money. Companies must reconnect Stripe in Settings > Payments after the deploy. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV = path.join(__dirname, '..', 'functions', '.env');
const SANDBOX = path.join(__dirname, '..', 'functions', '.env.sandbox');
const URL = 'https://us-central1-warehouse-inventory-cec3b.cloudfunctions.net/stripeConnectWebhook';
const API_VERSION = '2023-10-16';
const EVENTS = [
  'account.updated', 'account.application.deauthorized',
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'payment_intent.processing', 'payment_intent.succeeded', 'payment_intent.payment_failed',
  'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed',
];
const SWAPPED = ['STRIPE_CONNECT_SECRET_KEY', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_CLIENT_ID', 'INVOICE_LINK_SECRET', 'INVOICING_MODE'];

function readEnv(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const map = {};
  text.split(/\r?\n/).forEach((l) => { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) map[m[1]] = m[2].trim(); });
  return { text, map };
}

function setVars(vars) {
  let { text } = readEnv(ENV);
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : text.replace(/\s*$/, '') + `\n${k}=${v}\n`;
  }
  fs.writeFileSync(ENV, text);
}

const isLive = (k) => /^(sk|rk)_live_/.test(k || '');

(async () => {
  const cmd = process.argv[2] || 'check';
  const { map } = readEnv(ENV);

  if (cmd === 'revert') {
    const saved = readEnv(SANDBOX).map;
    if (!saved.STRIPE_CONNECT_SECRET_KEY) { console.error('No functions/.env.sandbox to restore from.'); process.exit(1); }
    const vars = {};
    SWAPPED.forEach((k) => { vars[k] = saved[k] || ''; });
    setVars(vars);
    console.log('Restored sandbox invoicing values (' + SWAPPED.join(', ') + '). Now: firebase deploy --only functions');
    return;
  }

  const key = map.STRIPE_CONNECT_LIVE_SECRET_KEY || map.STRIPE_SECRET_KEY || '';
  const keySource = map.STRIPE_CONNECT_LIVE_SECRET_KEY ? 'STRIPE_CONNECT_LIVE_SECRET_KEY' : 'STRIPE_SECRET_KEY (the subscriptions key)';
  if (!isLive(key)) { console.error('No live key: ' + keySource + ' is not an sk_live_/rk_live_ key.'); process.exit(1); }
  const clientId = map.STRIPE_CONNECT_LIVE_CLIENT_ID || '';
  const stripe = require(path.join(__dirname, '..', 'functions', 'node_modules', 'stripe'))(key, { apiVersion: API_VERSION });

  const acct = await stripe.accounts.retrieve();
  console.log(`Live key (${keySource}) OK for platform ${acct.id} (${acct.settings?.dashboard?.display_name || acct.business_profile?.name || '?'}), charges_enabled=${acct.charges_enabled}.`);
  let connectOk = true;
  try { await stripe.accounts.list({ limit: 1 }); } catch (e) { connectOk = false; console.log('Connect: NOT ready - ' + e.message); }
  if (connectOk) console.log('Connect: responds on the live platform.');
  const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find((w) => w.url === URL);
  console.log('Live Connect webhook: ' + (existing ? `exists (${existing.id})` : 'not created yet'));
  console.log('Live OAuth client id (STRIPE_CONNECT_LIVE_CLIENT_ID): ' + (/^ca_/.test(clientId) ? 'set' : 'MISSING - "Connect an existing Stripe account" will not work'));
  console.log('Current INVOICING_MODE: ' + (map.INVOICING_MODE || '(unset)'));
  if (cmd === 'check') return;
  if (cmd !== 'apply') { console.error('Unknown command: ' + cmd); process.exit(1); }
  if (!connectOk) { console.error('Refusing to go live: Connect is not ready on the live platform.'); process.exit(1); }
  if (map.INVOICING_MODE === 'live') { console.error('Already live. Nothing changed.'); process.exit(1); }

  // 1) keep the sandbox values so "revert" can put them back
  fs.writeFileSync(SANDBOX, '# Sandbox invoicing values saved by setup_invoicing_live.cjs apply. Never commit.\n' +
    SWAPPED.map((k) => `${k}=${map[k] || ''}`).join('\n') + '\n');
  console.log('Saved sandbox values to functions/.env.sandbox.');

  // 2) the live Connect webhook
  const vars = {};
  if (existing) {
    const missing = EVENTS.filter((e) => !existing.enabled_events.includes(e));
    if (missing.length) await stripe.webhookEndpoints.update(existing.id, { enabled_events: EVENTS });
    console.log(`Live webhook already existed (${existing.id}). Its signing secret is shown only once by Stripe:`);
    console.log('copy it from Developers > Webhooks > that endpoint > Signing secret into STRIPE_CONNECT_WEBHOOK_SECRET.');
  } else {
    const wh = await stripe.webhookEndpoints.create({
      url: URL, connect: true, api_version: API_VERSION, enabled_events: EVENTS,
      description: 'SkidSling invoicing (Connect) - live',
    });
    vars.STRIPE_CONNECT_WEBHOOK_SECRET = wh.secret;
    console.log(`Created live Connect webhook ${wh.id} (${EVENTS.length} events). Signing secret written to functions/.env.`);
  }

  // 3) switch the invoicing values
  vars.STRIPE_CONNECT_SECRET_KEY = key;
  vars.STRIPE_CONNECT_CLIENT_ID = /^ca_/.test(clientId) ? clientId : '';
  vars.INVOICE_LINK_SECRET = crypto.randomBytes(32).toString('hex');
  vars.INVOICING_MODE = 'live';
  setVars(vars);
  console.log('functions/.env now LIVE: ' + Object.keys(vars).join(', ') + ' (values not shown). Next: firebase deploy --only functions');
})().catch((e) => { console.error('Stripe error:', e.message); process.exit(1); });
