/**
 * Firestore for local maintenance scripts: uses GOOGLE_APPLICATION_CREDENTIALS if set, otherwise the signed-in
 * gcloud user (`gcloud auth print-access-token`). No key file needed, nothing written to disk.
 *     const { db, FieldValue } = require('./_cred');
 */
const { execSync } = require('child_process');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
// Use the auth library Firestore's own transport (google-gax) is built on: firebase-admin 13 ships two majors
// (9 for gax, 10 at the top) and a client from the other one is silently ignored.
const { OAuth2Client, GoogleAuth } = (() => {
  try { return require('google-gax/node_modules/google-auth-library'); } catch (e) { return require('google-auth-library'); }
})();

const projectId = process.env.GCLOUD_PROJECT || 'warehouse-inventory-cec3b';

function gcloudClient() {
  const client = new OAuth2Client();
  const refresh = () => client.setCredentials({
    access_token: execSync('gcloud auth print-access-token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
    expiry_date: Date.now() + 45 * 60 * 1000,
  });
  refresh();
  client.refreshAccessToken = async () => { refresh(); return { credentials: client.credentials }; };
  return client;
}

const db = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? new Firestore({ projectId })
  : new Firestore({ projectId, auth: new GoogleAuth({ authClient: gcloudClient(), projectId }) });

module.exports = { db, FieldValue };
