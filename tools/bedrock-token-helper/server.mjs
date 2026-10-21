/**
 * NetSuite TactaSuite - Bedrock token helper
 *
 * @author Blane Maher
 *
 * Tiny local service that mints SHORT-TERM Amazon Bedrock API keys (bearer
 * tokens) from the AWS credentials already on this machine (an Identity Center
 * / SSO profile, env vars, or ~/.aws/credentials) and hands them to the
 * NetSuite TactaSuite extension. Nothing long-lived is created in AWS and no
 * secret is pasted into the browser: the extension asks for a fresh token
 * when it needs one, and tokens expire with the AWS session (max 12 hours).
 *
 * Run:   npm start                      (uses AWS_PROFILE / AWS_REGION, defaults below)
 *        set AWS_PROFILE=aws-code-ai && npm start
 * Then pick "Use my AWS login" under Settings > AI Assistant in the extension.
 *
 * Endpoints (127.0.0.1 only):
 *   GET /health -> { ok, profile, region }
 *   GET /token  -> { token, expiresAt, region, profile }   requires header X-Tacta-Helper: 1
 *
 * The header requirement means a web page cannot read the token with a plain
 * fetch (the CORS preflight is refused); the extension sends it because it
 * holds the optional 127.0.0.1 host permission.
 */
import http from 'node:http';
import { getTokenProvider } from '@aws/bedrock-token-generator';

const PORT = Number(process.env.TACTA_HELPER_PORT || 38790);
const PROFILE = process.env.AWS_PROFILE || 'aws-code-ai';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
process.env.AWS_PROFILE = PROFILE;
process.env.AWS_REGION = REGION;

// The generator caches the token and refreshes it before expiry.
const provideToken = getTokenProvider({ region: REGION });
const TOKEN_TTL_MS = 11 * 60 * 60 * 1000; // tokens live at most 12h; report a conservative expiry

function json(res, status, body, extra) {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extra || {}));
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const origin = req.headers.origin || '';
  const fromExtension = origin.startsWith('chrome-extension://');
  const cors = fromExtension ? { 'access-control-allow-origin': origin, 'vary': 'origin' } : {};

  if (req.method === 'OPTIONS') {
    // Only extensions may preflight successfully; pages get nothing.
    if (!fromExtension) { res.writeHead(403); res.end(); return; }
    res.writeHead(204, Object.assign({ 'access-control-allow-headers': 'x-tacta-helper', 'access-control-allow-methods': 'GET' }, cors));
    res.end();
    return;
  }
  if (req.method !== 'GET') { json(res, 405, { error: 'GET only' }, cors); return; }

  if (url.pathname === '/health') {
    json(res, 200, { ok: true, profile: PROFILE, region: REGION, port: PORT }, cors);
    return;
  }
  if (url.pathname === '/token') {
    if (req.headers['x-tacta-helper'] !== '1') { json(res, 403, { error: 'missing X-Tacta-Helper header' }, cors); return; }
    try {
      const token = await provideToken();
      json(res, 200, { token, expiresAt: Date.now() + TOKEN_TTL_MS, region: REGION, profile: PROFILE }, cors);
      console.log(new Date().toISOString(), 'token issued to', origin || 'local caller');
    } catch (e) {
      const msg = String((e && e.message) || e);
      const hint = /sso|token|expired|login|credentials/i.test(msg)
        ? ' Run: aws sso login --profile ' + PROFILE
        : '';
      json(res, 502, { error: 'Could not mint a Bedrock token from profile ' + PROFILE + ': ' + msg + hint }, cors);
      console.error(new Date().toISOString(), 'token error:', msg);
    }
    return;
  }
  json(res, 404, { error: 'not found' }, cors);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('TactaSuite Bedrock token helper listening on http://127.0.0.1:' + PORT);
  console.log('  profile: ' + PROFILE + '   region: ' + REGION);
  console.log('  In the extension: Settings > AI Assistant > Claude on Amazon Bedrock > Use my AWS login');
});
