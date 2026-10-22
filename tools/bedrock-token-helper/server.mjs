/**
 * NetSuite TactaSuite - Bedrock token helper
 *
 * @author Blane Maher
 *
 * Tiny local service (127.0.0.1 only) that lets the NetSuite TactaSuite AI
 * Assistant call Amazon Bedrock with the user's own AWS identity, without a
 * long-lived key in the browser:
 *
 *   1. The extension's Settings page sends the AWS IAM Identity Center (SSO)
 *      details here (POST /config): start URL, SSO region, account id, role
 *      name, Bedrock region, registration scopes.
 *   2. "Sign in with AWS" (POST /login) runs the OIDC device-authorization
 *      flow: the helper registers itself as a public OIDC client, asks AWS for
 *      a device code, and returns the verification URL. The extension opens it
 *      in a tab; the user signs in through Okta (or whatever the identity
 *      provider is); the helper polls until AWS issues an access token.
 *   3. GET /token exchanges the access token for temporary role credentials
 *      (GetRoleCredentials) and mints a SHORT-TERM Bedrock API key from them
 *      with @aws/bedrock-token-generator. Tokens expire with the credentials
 *      (12 hours at most). Nothing long-lived is created in AWS.
 *
 * Alternatively, mode "profile" reuses an AWS CLI profile that already exists
 * on this machine (requires the CLI to have done `aws sso login`).
 *
 * All state lives under %USERPROFILE%\.tactasuite\ (config, OIDC client
 * registration, SSO access token). Only requests that carry the
 * X-Tacta-Helper header are served; browsers will not add that header to a
 * cross-site request without a successful preflight, and the preflight is only
 * granted to chrome-extension:// origins.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTokenProvider } from '@aws/bedrock-token-generator';
import { SSOOIDCClient, RegisterClientCommand, StartDeviceAuthorizationCommand, CreateTokenCommand } from '@aws-sdk/client-sso-oidc';
import { SSOClient, GetRoleCredentialsCommand } from '@aws-sdk/client-sso';

const PORT = Number(process.env.TACTA_HELPER_PORT || 38790);
const STATE_DIR = path.join(os.homedir(), '.tactasuite');
const CONFIG_FILE = path.join(STATE_DIR, 'bedrock-helper.json');
const CLIENT_FILE = path.join(STATE_DIR, 'sso-client.json');
const TOKEN_FILE = path.join(STATE_DIR, 'sso-token.json');
const CLIENT_NAME = 'NetSuite TactaSuite Bedrock helper';
const MAX_TOKEN_TTL_MS = 11 * 60 * 60 * 1000;

fs.mkdirSync(STATE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Small file helpers
// ---------------------------------------------------------------------------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

const DEFAULT_CONFIG = {
  mode: 'sso',                       // 'sso' (helper signs in) or 'profile' (AWS CLI profile)
  profileName: '',                   // label in sso mode, CLI profile name in profile mode
  ssoStartUrl: '',
  ssoRegion: 'us-east-1',
  ssoAccountId: '',
  ssoRoleName: '',
  region: 'us-east-1',               // Bedrock region
  ssoRegistrationScopes: 'sso:account:access'
};

function loadConfig() {
  const cfg = Object.assign({}, DEFAULT_CONFIG, readJson(CONFIG_FILE, {}));
  // First run: environment variables can seed a profile-mode config.
  if (!readJson(CONFIG_FILE, null) && process.env.AWS_PROFILE) {
    cfg.mode = 'profile';
    cfg.profileName = process.env.AWS_PROFILE;
    cfg.region = process.env.AWS_REGION || cfg.region;
  }
  return cfg;
}

function validateConfig(input) {
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  cfg.mode = input.mode === 'profile' ? 'profile' : 'sso';
  cfg.profileName = String(input.profileName || '').trim().slice(0, 64);
  cfg.ssoStartUrl = String(input.ssoStartUrl || '').trim().replace(/#.*$/, '');
  cfg.ssoRegion = String(input.ssoRegion || 'us-east-1').trim().toLowerCase();
  cfg.ssoAccountId = String(input.ssoAccountId || '').trim();
  cfg.ssoRoleName = String(input.ssoRoleName || '').trim();
  cfg.region = String(input.region || 'us-east-1').trim().toLowerCase();
  cfg.ssoRegistrationScopes = String(input.ssoRegistrationScopes || 'sso:account:access').trim();
  const errors = [];
  if (!/^[a-z0-9-]+$/.test(cfg.region)) errors.push('Bedrock region looks wrong.');
  if (cfg.mode === 'profile') {
    if (!/^[A-Za-z0-9._-]+$/.test(cfg.profileName)) errors.push('Profile name is required (letters, numbers, . _ -).');
  } else {
    if (!/^https:\/\/[a-z0-9.-]+\.awsapps\.com\/start\/?$/i.test(cfg.ssoStartUrl) && !/^https:\/\/[a-z0-9.-]+\/start\/?$/i.test(cfg.ssoStartUrl)) errors.push('SSO start URL should look like https://d-xxxxxxxxxx.awsapps.com/start');
    if (!/^[a-z0-9-]+$/.test(cfg.ssoRegion)) errors.push('SSO region looks wrong.');
    if (!/^\d{12}$/.test(cfg.ssoAccountId)) errors.push('Account id must be 12 digits.');
    if (!/^[\w+=,.@-]{1,64}$/.test(cfg.ssoRoleName)) errors.push('Role name is required.');
  }
  return { cfg, errors };
}

/** Parse ~/.aws/config so the Settings page can offer "import from CLI profile". */
function readCliProfiles() {
  const file = path.join(os.homedir(), '.aws', 'config');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const sections = {};
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { current = sec[1].trim(); sections[current] = {}; continue; }
    const kv = line.match(/^([A-Za-z_]+)\s*=\s*(.*)$/);
    if (kv && current) sections[current][kv[1]] = kv[2].trim();
  }
  const out = [];
  for (const [name, vals] of Object.entries(sections)) {
    if (!name.startsWith('profile ')) continue;
    const profile = name.slice(8).trim();
    let startUrl = vals.sso_start_url || '';
    let ssoRegion = vals.sso_region || '';
    let scopes = '';
    if (vals.sso_session && sections['sso-session ' + vals.sso_session]) {
      const sess = sections['sso-session ' + vals.sso_session];
      startUrl = startUrl || sess.sso_start_url || '';
      ssoRegion = ssoRegion || sess.sso_region || '';
      scopes = sess.sso_registration_scopes || '';
    }
    if (!startUrl && !vals.sso_account_id) continue; // not an SSO profile
    out.push({
      profileName: profile,
      ssoStartUrl: startUrl.replace(/#.*$/, ''),
      ssoRegion: ssoRegion || 'us-east-1',
      ssoAccountId: vals.sso_account_id || '',
      ssoRoleName: vals.sso_role_name || '',
      region: vals.region || 'us-east-1',
      ssoRegistrationScopes: scopes || 'sso:account:access'
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSO device flow
// ---------------------------------------------------------------------------
let login = { state: 'idle', message: '', verificationUri: '', userCode: '', expiresAt: 0 };
let credsCache = { key: '', credentials: null, expiresAt: 0 };
let tokenCache = { key: '', token: '', expiresAt: 0 };

function oidcClient(cfg) { return new SSOOIDCClient({ region: cfg.ssoRegion }); }

async function registerClient(cfg) {
  const cached = readJson(CLIENT_FILE, null);
  const key = cfg.ssoStartUrl + '|' + cfg.ssoRegion + '|' + cfg.ssoRegistrationScopes;
  if (cached && cached.key === key && cached.expiresAt > Date.now() + 60000) return cached;
  const res = await oidcClient(cfg).send(new RegisterClientCommand({
    clientName: CLIENT_NAME,
    clientType: 'public',
    scopes: cfg.ssoRegistrationScopes.split(/[\s,]+/).filter(Boolean)
  }));
  const reg = { key, clientId: res.clientId, clientSecret: res.clientSecret, expiresAt: (res.clientSecretExpiresAt || 0) * 1000 };
  writeJson(CLIENT_FILE, reg);
  return reg;
}

async function startLogin(cfg) {
  if (cfg.mode !== 'sso') {
    login = { state: 'error', message: 'Helper is in AWS CLI profile mode. Run: aws sso login --profile ' + cfg.profileName, verificationUri: '', userCode: '', expiresAt: 0 };
    return login;
  }
  const reg = await registerClient(cfg);
  const auth = await oidcClient(cfg).send(new StartDeviceAuthorizationCommand({
    clientId: reg.clientId,
    clientSecret: reg.clientSecret,
    startUrl: cfg.ssoStartUrl
  }));
  const intervalMs = Math.max(1, auth.interval || 5) * 1000;
  const expiresAt = Date.now() + (auth.expiresIn || 600) * 1000;
  login = { state: 'pending', message: 'Waiting for you to approve the sign-in in the browser.', verificationUri: auth.verificationUriComplete || auth.verificationUri, userCode: auth.userCode || '', expiresAt };
  console.log(new Date().toISOString(), 'sign-in started; user code', login.userCode);

  (async () => {
    while (login.state === 'pending' && Date.now() < expiresAt) {
      await new Promise((r) => setTimeout(r, intervalMs));
      try {
        const tok = await oidcClient(cfg).send(new CreateTokenCommand({
          clientId: reg.clientId,
          clientSecret: reg.clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode: auth.deviceCode
        }));
        const tokenExpiresAt = Date.now() + (tok.expiresIn || 3600) * 1000;
        writeJson(TOKEN_FILE, { startUrl: cfg.ssoStartUrl, region: cfg.ssoRegion, accessToken: tok.accessToken, expiresAt: tokenExpiresAt });
        credsCache = { key: '', credentials: null, expiresAt: 0 };
        tokenCache = { key: '', token: '', expiresAt: 0 };
        login = { state: 'ok', message: 'Signed in.', verificationUri: '', userCode: '', expiresAt: tokenExpiresAt };
        console.log(new Date().toISOString(), 'sign-in complete; AWS session until', new Date(tokenExpiresAt).toISOString());
        return;
      } catch (e) {
        const name = (e && e.name) || '';
        if (name === 'AuthorizationPendingException' || name === 'SlowDownException') continue;
        login = { state: 'error', message: 'Sign-in failed: ' + ((e && e.message) || name), verificationUri: '', userCode: '', expiresAt: 0 };
        console.error(new Date().toISOString(), 'sign-in error:', login.message);
        return;
      }
    }
    if (login.state === 'pending') login = { state: 'error', message: 'Sign-in timed out. Click Sign in with AWS again.', verificationUri: '', userCode: '', expiresAt: 0 };
  })();

  return login;
}

function readAccessToken(cfg) {
  const tok = readJson(TOKEN_FILE, null);
  if (!tok || tok.startUrl !== cfg.ssoStartUrl || !tok.accessToken) return null;
  if (tok.expiresAt <= Date.now() + 60000) return null;
  return tok;
}

async function roleCredentials(cfg) {
  const key = cfg.ssoStartUrl + '|' + cfg.ssoAccountId + '|' + cfg.ssoRoleName;
  if (credsCache.credentials && credsCache.key === key && credsCache.expiresAt > Date.now() + 5 * 60000) return credsCache;
  const tok = readAccessToken(cfg);
  if (!tok) { const err = new Error('Not signed in to AWS. Click "Sign in with AWS" in the extension settings.'); err.needsLogin = true; throw err; }
  const res = await new SSOClient({ region: cfg.ssoRegion }).send(new GetRoleCredentialsCommand({
    accessToken: tok.accessToken, accountId: cfg.ssoAccountId, roleName: cfg.ssoRoleName
  }));
  const rc = res.roleCredentials;
  credsCache = {
    key,
    credentials: { accessKeyId: rc.accessKeyId, secretAccessKey: rc.secretAccessKey, sessionToken: rc.sessionToken, expiration: new Date(rc.expiration) },
    expiresAt: rc.expiration
  };
  return credsCache;
}

async function mintBedrockToken(cfg) {
  if (cfg.mode === 'profile') {
    process.env.AWS_PROFILE = cfg.profileName;
    process.env.AWS_REGION = cfg.region;
    const key = 'profile|' + cfg.profileName + '|' + cfg.region;
    if (tokenCache.token && tokenCache.key === key && tokenCache.expiresAt > Date.now() + 60000) return tokenCache;
    const token = await getTokenProvider({ region: cfg.region })();
    tokenCache = { key, token, expiresAt: Date.now() + MAX_TOKEN_TTL_MS };
    return tokenCache;
  }
  const creds = await roleCredentials(cfg);
  const key = 'sso|' + creds.key + '|' + cfg.region + '|' + creds.expiresAt;
  if (tokenCache.token && tokenCache.key === key && tokenCache.expiresAt > Date.now() + 60000) return tokenCache;
  const token = await getTokenProvider({ credentials: creds.credentials, region: cfg.region })();
  tokenCache = { key, token, expiresAt: Math.min(creds.expiresAt, Date.now() + MAX_TOKEN_TTL_MS) };
  return tokenCache;
}

function healthBody(cfg) {
  const tok = cfg.mode === 'sso' ? readAccessToken(cfg) : null;
  return {
    ok: true,
    port: PORT,
    mode: cfg.mode,
    profile: cfg.profileName,
    region: cfg.region,
    ssoRegion: cfg.ssoRegion,
    account: cfg.ssoAccountId ? cfg.ssoAccountId.replace(/^(\d{4})\d{4}(\d{4})$/, '$1....$2') : '',
    role: cfg.ssoRoleName,
    configured: cfg.mode === 'profile' ? !!cfg.profileName : !!(cfg.ssoStartUrl && cfg.ssoAccountId && cfg.ssoRoleName),
    signedIn: cfg.mode === 'profile' ? null : !!tok,
    sessionExpiresAt: tok ? tok.expiresAt : null,
    login: { state: login.state, message: login.message, verificationUri: login.state === 'pending' ? login.verificationUri : '', userCode: login.state === 'pending' ? login.userCode : '' }
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function send(res, status, body, cors) {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, cors || {}));
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 65536) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } }); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const origin = req.headers.origin || '';
  const fromExtension = origin.startsWith('chrome-extension://');
  const cors = fromExtension ? { 'access-control-allow-origin': origin, 'vary': 'origin' } : {};

  if (req.method === 'OPTIONS') {
    if (!fromExtension) { res.writeHead(403); res.end(); return; }
    res.writeHead(204, Object.assign({ 'access-control-allow-headers': 'x-tacta-helper, content-type', 'access-control-allow-methods': 'GET, POST', 'access-control-max-age': '600' }, cors));
    res.end();
    return;
  }

  const cfg = loadConfig();
  if (url.pathname === '/health' && req.method === 'GET') { send(res, 200, healthBody(cfg), cors); return; }

  if (req.headers['x-tacta-helper'] !== '1') { send(res, 403, { error: 'missing X-Tacta-Helper header' }, cors); return; }

  try {
    if (url.pathname === '/config' && req.method === 'GET') {
      send(res, 200, { config: cfg, cliProfiles: readCliProfiles(), health: healthBody(cfg) }, cors);
      return;
    }
    if (url.pathname === '/config' && req.method === 'POST') {
      const { cfg: next, errors } = validateConfig(await readBody(req));
      if (errors.length) { send(res, 400, { error: errors.join(' ') }, cors); return; }
      const prev = loadConfig();
      writeJson(CONFIG_FILE, next);
      if (prev.ssoStartUrl !== next.ssoStartUrl || prev.ssoAccountId !== next.ssoAccountId || prev.ssoRoleName !== next.ssoRoleName) {
        credsCache = { key: '', credentials: null, expiresAt: 0 };
        tokenCache = { key: '', token: '', expiresAt: 0 };
      }
      console.log(new Date().toISOString(), 'config saved:', next.mode, next.mode === 'sso' ? next.ssoRoleName + '@' + next.ssoAccountId : next.profileName);
      send(res, 200, { ok: true, config: next, health: healthBody(next) }, cors);
      return;
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const state = await startLogin(cfg);
      send(res, state.state === 'error' ? 400 : 200, { login: state }, cors);
      return;
    }
    if (url.pathname === '/login/status' && req.method === 'GET') {
      send(res, 200, { login: { state: login.state, message: login.message, expiresAt: login.expiresAt }, health: healthBody(cfg) }, cors);
      return;
    }
    if (url.pathname === '/logout' && req.method === 'POST') {
      try { fs.unlinkSync(TOKEN_FILE); } catch (_) { /* none */ }
      credsCache = { key: '', credentials: null, expiresAt: 0 };
      tokenCache = { key: '', token: '', expiresAt: 0 };
      login = { state: 'idle', message: '', verificationUri: '', userCode: '', expiresAt: 0 };
      send(res, 200, { ok: true }, cors);
      return;
    }
    if (url.pathname === '/token' && req.method === 'GET') {
      const t = await mintBedrockToken(cfg);
      console.log(new Date().toISOString(), 'token issued to', origin || 'local caller');
      send(res, 200, { token: t.token, expiresAt: t.expiresAt, region: cfg.region, mode: cfg.mode }, cors);
      return;
    }
    send(res, 404, { error: 'not found' }, cors);
  } catch (e) {
    const msg = String((e && e.message) || e);
    const needsLogin = !!(e && e.needsLogin) || /UnauthorizedException|expired|token|sso|login|credentials/i.test(msg);
    console.error(new Date().toISOString(), req.method, url.pathname, 'error:', msg);
    send(res, needsLogin ? 401 : 502, { error: msg, needsLogin }, cors);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const cfg = loadConfig();
  console.log('TactaSuite Bedrock token helper listening on http://127.0.0.1:' + PORT);
  console.log('  mode: ' + cfg.mode + (cfg.mode === 'profile' ? '   profile: ' + cfg.profileName : (cfg.ssoRoleName ? '   role: ' + cfg.ssoRoleName + ' @ ' + cfg.ssoAccountId : '   (not configured yet)')) + '   Bedrock region: ' + cfg.region);
  console.log('  Configure and sign in from the extension: Settings > AI Assistant > Claude on Amazon Bedrock > My AWS login');
});
