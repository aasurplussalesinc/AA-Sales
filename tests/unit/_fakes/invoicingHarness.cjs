'use strict';
// Builds invoicing.js against fakes so callables, the Connect webhook and the
// scheduled jobs can be driven end to end in a unit test, with no network:
//   - firebase-functions: onCall/onRequest/schedule return the raw handler
//   - Firestore: tests/unit/_fakes/fakeFirestore.cjs
//   - Stripe: a recording fake; webhook signatures use the REAL stripe SDK
//     helpers (local HMAC), so the signature path is the production one
//   - email / PDF: recording fakes
var path = require('path');
var { createFakeDb } = require('./fakeFirestore.cjs');
var functionsDir = path.join(__dirname, '..', '..', '..', 'functions');
var RealStripe = require(path.join(functionsDir, 'node_modules', 'stripe'));
var createAuthz = require(path.join(functionsDir, 'authz.js'));
var createInvoicing = require(path.join(functionsDir, 'invoicing.js'));

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function fakeFunctions() {
  var sched = {};
  var chain = {
    https: {
      HttpsError: HttpsError,
      onCall: function (fn) { return fn; },
      onRequest: function (fn) { return fn; }
    },
    pubsub: {
      schedule: function (expr) {
        return { timeZone: function () { return { onRun: function (fn) { fn.schedule = expr; return fn; } }; },
                 onRun: function (fn) { fn.schedule = expr; return fn; } };
      }
    },
    firestore: {
      document: function (p) {
        return { onUpdate: function (fn) { fn.trigger = p; return fn; },
                 onWrite: function (fn) { fn.trigger = p; return fn; } };
      }
    },
    runWith: function () { return chain; },
    _sched: sched
  };
  return chain;
}

function fakeStripe() {
  var real = RealStripe('sk_test_harness');
  var calls = [];
  var n = 0;
  var s = {
    calls: calls,
    webhooks: real.webhooks,
    accountsById: {},
    paymentIntents: {},
    charges: {},
    accounts: {
      create: async function (params) {
        calls.push({ fn: 'accounts.create', params: params });
        var id = 'acct_test_' + (++n);
        s.accountsById[id] = { id: id, charges_enabled: false, payouts_enabled: false, details_submitted: false, requirements: { currently_due: ['external_account'] } };
        return { id: id };
      },
      retrieve: async function (id) {
        calls.push({ fn: 'accounts.retrieve', id: id });
        return s.accountsById[id] || { id: id };
      }
    },
    accountLinks: {
      create: async function (params) {
        calls.push({ fn: 'accountLinks.create', params: params });
        return { url: 'https://connect.stripe.com/setup/s/fake_' + params.account };
      }
    },
    oauth: {
      token: async function (params) {
        calls.push({ fn: 'oauth.token', params: params });
        return { stripe_user_id: 'acct_oauth_1', livemode: false };
      }
    },
    checkout: {
      sessions: {
        create: async function (params, opts) {
          calls.push({ fn: 'checkout.sessions.create', params: params, opts: opts });
          var id = 'cs_test_' + (++n);
          return { id: id, url: 'https://checkout.stripe.com/c/pay/' + id };
        },
        expire: async function (id, params, opts) {
          calls.push({ fn: 'checkout.sessions.expire', id: id, opts: opts });
          return { id: id, status: 'expired' };
        }
      }
    },
    paymentIntentsApi: null,
    charges_api: null
  };
  s.paymentIntents = {
    _store: {},
    retrieve: async function (id, params, opts) {
      calls.push({ fn: 'paymentIntents.retrieve', id: id, opts: opts || params });
      var pi = s.paymentIntents._store[id];
      if (!pi) { var e = new Error('No such payment_intent'); e.statusCode = 404; throw e; }
      return pi;
    }
  };
  s.charges = {
    _store: {},
    retrieve: async function (id, params, opts) {
      calls.push({ fn: 'charges.retrieve', id: id, params: params, opts: opts });
      var ch = s.charges._store[id];
      if (!ch) { var e = new Error('No such charge'); e.statusCode = 404; throw e; }
      return ch;
    }
  };
  return s;
}

function build(opts) {
  opts = opts || {};
  var db = createFakeDb(opts.seed || {});
  var functions = fakeFunctions();
  var stripe = opts.stripe || fakeStripe();
  var clock = { now: opts.now || Date.UTC(2026, 8, 28, 14, 0, 0) };
  var emails = [];
  var pdfs = [];
  var env = Object.assign({
    INVOICING_MODE: 'test',
    STRIPE_CONNECT_SECRET_KEY: 'sk_test_connect_fake',
    STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_fake',
    INVOICE_LINK_SECRET: 'link-secret-for-tests',
    APP_BASE_URL: 'https://app.test',
    BREVO_API_KEY: 'brevo-fake'
  }, opts.env || {});
  var AUTHZ = createAuthz({ functions: functions, db: db });
  var inv = createInvoicing({
    functions: functions, db: db, AUTHZ: AUTHZ, env: env,
    now: function () { return clock.now; },
    stripeFactory: function () { return stripe; },
    sendEmail: opts.sendEmail || async function (msg) { emails.push(msg); return { success: true, id: '<msg-' + emails.length + '@brevo>' }; },
    renderPdf: async function (html) { pdfs.push(html); return Buffer.from('%PDF-fake'); }
  });
  function signed(event) {
    var payload = JSON.stringify(event);
    var header = RealStripe('sk_test_x').webhooks.generateTestHeaderString({ payload: payload, secret: env.STRIPE_CONNECT_WEBHOOK_SECRET });
    return { rawBody: Buffer.from(payload), headers: { 'stripe-signature': header } };
  }
  async function deliver(event, badSig) {
    var req = signed(event);
    if (badSig) req.headers['stripe-signature'] = 't=1,v1=deadbeef';
    var res = { statusCode: 200, body: null,
      status: function (c) { this.statusCode = c; return this; },
      send: function (b) { this.body = b; return this; },
      json: function (b) { this.body = b; return this; } };
    await inv.stripeConnectWebhook(req, res);
    return res;
  }
  var ctx = function (uid, email) { return { auth: { uid: uid, token: { email: email || (uid + '@x.com') } }, rawRequest: { ip: '127.0.0.1' } }; };
  return { db: db, inv: inv, stripe: stripe, clock: clock, emails: emails, pdfs: pdfs, env: env, deliver: deliver, ctx: ctx, HttpsError: HttpsError };
}

module.exports = { build: build, fakeStripe: fakeStripe, fakeFunctions: fakeFunctions, HttpsError: HttpsError };
