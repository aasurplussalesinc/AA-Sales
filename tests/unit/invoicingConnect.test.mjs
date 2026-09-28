// Phase 1 of Stripe invoicing: a company connects its OWN Stripe account
// (Connect, Standard), and SkidSling keeps only the account id and its flags.
// These pin the config guard (test key only in test mode), the tenant
// boundary (one account, one org; unknown accounts ignored; platform events
// never processed here) and the webhook signature path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const CORE = require('../../functions/invoicingCore.js');
const { build } = require('./_fakes/invoicingHarness.cjs');

const seed = () => ({
  'organizations/acme': { name: 'Acme Surplus', email: 'office@acme.test', plan: 'pro', stripeCustomerId: 'cus_platform' },
  'organizations/victim': { name: 'Victim Co', plan: 'pro' },
  'orgMembers/acme_alice': { orgId: 'acme', userId: 'alice', role: 'admin', status: 'active' },
  'orgMembers/acme_carol': { orgId: 'acme', userId: 'carol', role: 'staff', status: 'active' },
  'orgMembers/victim_bob': { orgId: 'victim', userId: 'bob', role: 'admin', status: 'active' }
});

// ---- config guard -----------------------------------------------------------

test('test mode needs a test key; live mode needs a live key', () => {
  assert.equal(CORE.invoicingConfig({ INVOICING_MODE: 'test', STRIPE_CONNECT_SECRET_KEY: 'sk_test_abc' }).ok, true);
  assert.equal(CORE.invoicingConfig({ INVOICING_MODE: 'live', STRIPE_CONNECT_SECRET_KEY: 'sk_live_abc' }).ok, true);
  const bad = CORE.invoicingConfig({ INVOICING_MODE: 'test', STRIPE_CONNECT_SECRET_KEY: 'sk_live_abc' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /refusing to start invoicing in test mode/);
  assert.equal(CORE.invoicingConfig({ INVOICING_MODE: 'live', STRIPE_CONNECT_SECRET_KEY: 'sk_test_abc' }).ok, false);
  assert.equal(CORE.invoicingConfig({ STRIPE_CONNECT_SECRET_KEY: 'sk_test_abc' }).ok, false, 'mode is required');
  assert.equal(CORE.invoicingConfig({ INVOICING_MODE: 'test' }).ok, false, 'key is required');
  assert.equal(CORE.invoicingConfig({ INVOICING_MODE: 'test', STRIPE_CONNECT_SECRET_KEY: 'rk_test_restricted' }).ok, true);
});

test('invoicing never falls back to the subscription key', () => {
  const cfg = CORE.invoicingConfig({ INVOICING_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_subscriptions' });
  assert.equal(cfg.ok, false);
  assert.equal(cfg.secretKey, '');
});

test('APP_BASE_URL defaults to skidsling.com and loses a trailing slash', () => {
  assert.equal(CORE.invoicingConfig({}).appBaseUrl, 'https://skidsling.com');
  assert.equal(CORE.invoicingConfig({ APP_BASE_URL: 'https://x.test/' }).appBaseUrl, 'https://x.test');
});

// ---- OAuth state --------------------------------------------------------------

test('OAuth state is bound to the org, the user and a time window', () => {
  const t0 = 1_800_000_000_000;
  const st = CORE.signOAuthState('s3cret', 'acme', 'alice', t0);
  assert.deepEqual(CORE.verifyOAuthState('s3cret', st, 'alice', t0 + 1000), { orgId: 'acme', uid: 'alice', issuedAt: t0 });
  assert.equal(CORE.verifyOAuthState('s3cret', st, 'mallory', t0 + 1000), null, 'another user');
  assert.equal(CORE.verifyOAuthState('other', st, 'alice', t0 + 1000), null, 'another secret');
  assert.equal(CORE.verifyOAuthState('s3cret', st, 'alice', t0 + 31 * 60 * 1000), null, 'expired');
  const forged = Buffer.from('victim.alice.' + t0).toString('base64').replace(/=+$/, '') + '.' + st.split('.').pop();
  assert.equal(CORE.verifyOAuthState('s3cret', forged, 'alice', t0 + 1000), null, 'org swapped');
});

// ---- settings -----------------------------------------------------------------

test('settings: only the editable keys, validated', () => {
  const s = CORE.sanitizePaymentSettings({ enabled: true, methods: ['card', 'us_bank_account', 'bitcoin'], billingEmail: ' AR@Acme.test ',
    stripeAccountId: 'acct_evil', chargesEnabled: true });
  assert.deepEqual(s, { enabled: true, methods: ['card', 'us_bank_account'], billingEmail: 'ar@acme.test' });
  assert.throws(() => CORE.sanitizePaymentSettings({ methods: [] }), /at least one/);
  assert.throws(() => CORE.sanitizePaymentSettings({ billingEmail: 'nope' }), /not a valid/);
  assert.equal(CORE.sanitizePaymentSettings({ enabled: 'yes' }).enabled, false, 'only a real true turns it on');
});

test('connection state: connected / needs info / disconnected', () => {
  assert.equal(CORE.connectionState({}), 'disconnected');
  assert.equal(CORE.connectionState({ stripeAccountId: 'acct_1' }), 'needs_info');
  assert.equal(CORE.connectionState({ stripeAccountId: 'acct_1', chargesEnabled: true, detailsSubmitted: true }), 'connected');
  assert.equal(CORE.connectionState({ stripeAccountId: 'acct_1', chargesEnabled: true, detailsSubmitted: true, connected: false }), 'disconnected');
});

// ---- onboarding callables -------------------------------------------------------

test('connect: admin gets an Account Link; the account is mapped to that org only', async () => {
  const h = build({ seed: seed() });
  const r = await h.inv.paymentsConnectStart({ orgId: 'acme' }, h.ctx('alice'));
  assert.match(r.url, /^https:\/\/connect\.stripe\.com\/setup/);
  const create = h.stripe.calls.find(c => c.fn === 'accounts.create');
  assert.equal(create.params.type, 'standard');
  const link = h.stripe.calls.find(c => c.fn === 'accountLinks.create');
  assert.equal(link.params.return_url, 'https://app.test/settings/payments?connect=return');
  const org = h.db.data('organizations/acme');
  assert.equal(org.payments.stripeAccountId, r.stripeAccountId);
  assert.equal(org.payments.mode, 'test');
  assert.equal(org.stripeCustomerId, 'cus_platform', 'billing fields untouched');
  assert.deepEqual(h.db.data('stripeAccounts/' + r.stripeAccountId).orgId, 'acme');
  // A second click reuses the same account rather than creating another.
  await h.inv.paymentsConnectStart({ orgId: 'acme' }, h.ctx('alice'));
  assert.equal(h.stripe.calls.filter(c => c.fn === 'accounts.create').length, 1);
});

test('connect: staff and other tenants are refused', async () => {
  const h = build({ seed: seed() });
  await assert.rejects(h.inv.paymentsConnectStart({ orgId: 'acme' }, h.ctx('carol')), /requires admin/);
  await assert.rejects(h.inv.paymentsConnectStart({ orgId: 'acme' }, h.ctx('bob')), /Not a member/);
  assert.equal(h.stripe.calls.length, 0);
});

test('connect refuses to run with a live key in test mode', async () => {
  const h = build({ seed: seed(), env: { STRIPE_CONNECT_SECRET_KEY: 'sk_live_oops' } });
  await assert.rejects(h.inv.paymentsConnectStart({ orgId: 'acme' }, h.ctx('alice')), /not configured.*does not look like a test key/);
  assert.equal(h.stripe.calls.length, 0);
});

test('an account already connected to another org cannot be claimed', async () => {
  const h = build({ seed: Object.assign(seed(), { 'stripeAccounts/acct_oauth_1': { orgId: 'victim', accountId: 'acct_oauth_1' } }) });
  const { url } = await h.inv.paymentsConnectStart({ orgId: 'acme', method: 'oauth' }, h.ctx('alice'))
    .catch(e => ({ url: null, e }));
  assert.equal(url, null, 'oauth needs STRIPE_CONNECT_CLIENT_ID');
  const h2 = build({ seed: Object.assign(seed(), { 'stripeAccounts/acct_oauth_1': { orgId: 'victim', accountId: 'acct_oauth_1' } }),
    env: { STRIPE_CONNECT_CLIENT_ID: 'ca_test_1' } });
  const start = await h2.inv.paymentsConnectStart({ orgId: 'acme', method: 'oauth' }, h2.ctx('alice'));
  const state = decodeURIComponent(start.url.match(/state=([^&]+)/)[1]);
  await assert.rejects(h2.inv.paymentsOAuthComplete({ orgId: 'acme', code: 'ac_123456', state }, h2.ctx('alice')), /already connected to another/);
  assert.equal(h2.db.data('organizations/acme').payments, undefined);
});

test('oauth state from one org cannot complete in another', async () => {
  const h = build({ seed: Object.assign(seed(), { 'orgMembers/victim_alice': { orgId: 'victim', userId: 'alice', role: 'admin', status: 'active' } }),
    env: { STRIPE_CONNECT_CLIENT_ID: 'ca_test_1' } });
  const start = await h.inv.paymentsConnectStart({ orgId: 'acme', method: 'oauth' }, h.ctx('alice'));
  const state = decodeURIComponent(start.url.match(/state=([^&]+)/)[1]);
  await assert.rejects(h.inv.paymentsOAuthComplete({ orgId: 'victim', code: 'ac_123456', state }, h.ctx('alice')), /expired or belongs to another/);
  const ok = await h.inv.paymentsOAuthComplete({ orgId: 'acme', code: 'ac_123456', state }, h.ctx('alice'));
  assert.equal(ok.stripeAccountId, 'acct_oauth_1');
  assert.equal(h.db.data('stripeAccounts/acct_oauth_1').orgId, 'acme');
});

test('save settings: admin only, and cannot smuggle in an account id', async () => {
  const h = build({ seed: seed() });
  await assert.rejects(h.inv.paymentsSaveSettings({ orgId: 'acme', settings: { enabled: true } }, h.ctx('carol')), /requires admin/);
  await h.inv.paymentsSaveSettings({ orgId: 'acme', settings: { enabled: true, stripeAccountId: 'acct_evil' } }, h.ctx('alice'));
  const p = h.db.data('organizations/acme').payments;
  assert.equal(p.enabled, true);
  assert.equal(p.stripeAccountId, undefined);
});

test('disconnect stops new links but keeps the account mapping for late events', async () => {
  const h = build({ seed: seed() });
  const r = await h.inv.paymentsConnectStart({ orgId: 'acme' }, h.ctx('alice'));
  const v = await h.inv.paymentsDisconnect({ orgId: 'acme' }, h.ctx('alice'));
  assert.equal(v.state, 'disconnected');
  assert.equal(h.db.data('stripeAccounts/' + r.stripeAccountId).orgId, 'acme');
});

// ---- Connect webhook: account.updated ------------------------------------------

async function connected() {
  const h = build({ seed: seed() });
  const r = await h.inv.paymentsConnectStart({ orgId: 'acme' }, h.ctx('alice'));
  return { h, acct: r.stripeAccountId };
}
const accountUpdated = (acct, over = {}) => ({
  id: 'evt_acct_' + Math.random().toString(36).slice(2), type: 'account.updated', account: acct, livemode: false, created: 1,
  data: { object: Object.assign({ id: acct, charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [] } }, over) }
});

test('account.updated keeps the flags current', async () => {
  const { h, acct } = await connected();
  const res = await h.deliver(accountUpdated(acct));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'account:flags');
  const p = h.db.data('organizations/acme').payments;
  assert.equal(p.chargesEnabled, true);
  assert.equal(p.payoutsEnabled, true);
  assert.ok(p.connectedAt);
  assert.equal(CORE.connectionState(p), 'connected');
});

test('webhook: bad signature is rejected, nothing written', async () => {
  const { h, acct } = await connected();
  const before = h.db.writes.length;
  const res = await h.deliver(accountUpdated(acct), true);
  assert.equal(res.statusCode, 400);
  assert.equal(h.db.writes.length, before);
});

test('webhook: unknown account and platform events are acknowledged and ignored', async () => {
  const { h } = await connected();
  const before = h.db.writes.length;
  const r1 = await h.deliver(accountUpdated('acct_stranger'));
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.body.outcome, 'ignored:unknown-account');
  const platform = accountUpdated('x'); delete platform.account;
  const r2 = await h.deliver(platform);
  assert.equal(r2.body.outcome, 'ignored:platform-event');
  assert.equal(h.db.writes.length, before);
});

test('webhook: a live event is ignored while invoicing runs in test mode', async () => {
  const { h, acct } = await connected();
  const r = await h.deliver(Object.assign(accountUpdated(acct), { livemode: true }));
  assert.equal(r.body.outcome, 'ignored:mode-mismatch');
  assert.equal(h.db.data('organizations/acme').payments.chargesEnabled, false);
});

test('webhook: replaying the same event is a no-op', async () => {
  const { h, acct } = await connected();
  const e = accountUpdated(acct);
  await h.deliver(e);
  const n = h.db.writes.length;
  const again = await h.deliver(e);
  assert.equal(again.body.outcome, 'duplicate');
  assert.equal(h.db.writes.length, n);
});

test('webhook: another org cannot be steered by an account it does not use', async () => {
  const { h, acct } = await connected();
  // victim somehow maps an old account, but account.updated for acme's account
  // must only ever touch acme.
  await h.deliver(accountUpdated(acct));
  assert.equal(h.db.data('organizations/victim').payments, undefined);
});
