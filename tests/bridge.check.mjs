/**
 * TactaSuite bridge companion check (not a Playwright test).
 *
 * Spawns companion/tacta-bridge.mjs, connects a fake "extension" over the
 * loopback WebSocket (Node 24 global WebSocket client), then drives the MCP
 * stdio side (initialize, tools/list, tools/call) and verifies a round trip.
 *
 * Run with Node 24+:  node tests/bridge.check.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = path.resolve(process.cwd());
const COMPANION = path.join(ROOT, 'companion', 'tacta-bridge.mjs');
const TOKEN = 'test-token-123';
const PORT = 8799;

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function ok(msg) { console.log('ok:', msg); }

const child = spawn(process.execPath, [COMPANION], {
  env: { ...process.env, TACTA_BRIDGE_TOKEN: TOKEN, TACTA_BRIDGE_PORT: String(PORT) },
  stdio: ['pipe', 'pipe', 'pipe']
});
child.stderr.on('data', (d) => process.stderr.write('[companion] ' + d));

const mcpReplies = new Map(); // id -> resolve
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  if (msg.id !== undefined && mcpReplies.has(msg.id)) {
    mcpReplies.get(msg.id)(msg);
    mcpReplies.delete(msg.id);
  }
});

function mcp(method, params) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve) => {
    mcpReplies.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  await wait(700); // let the server bind

  // Fake extension client connects with a chrome-extension origin + token.
  const extId = 'abcdefghijklmnopabcdefghijklmnop';
  const ws = new WebSocket('ws://127.0.0.1:' + PORT, {
    headers: { Origin: 'chrome-extension://' + extId }
  });

  let welcomed = false;
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'welcome') { welcomed = true; return; }
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: msg.t })); return; }
    if (msg.type === 'call') {
      // Echo a canned result depending on tool.
      let data;
      if (msg.tool === 'netsuite_run_suiteql') data = { columns: ['id'], rows: [{ id: 1 }, { id: 2 }], count: 2 };
      else if (msg.tool === 'netsuite_list_tabs') data = { tabs: [{ id: 5, url: 'https://x.netsuite.com/app', title: 'NS' }] };
      else data = { echoed: msg.args };
      ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, data }));
    }
  });

  await new Promise((res, rej) => {
    ws.addEventListener('open', () => { ws.send(JSON.stringify({ type: 'hello', token: TOKEN, extId })); res(); });
    ws.addEventListener('error', rej);
    setTimeout(() => rej(new Error('ws open timeout')), 4000);
  });
  await wait(300);
  welcomed ? ok('extension paired (welcome received)') : fail('no welcome after hello');

  // MCP handshake.
  const init = await mcp('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  init?.result?.serverInfo?.name ? ok('initialize: ' + init.result.serverInfo.name) : fail('initialize bad: ' + JSON.stringify(init));

  const list = await mcp('tools/list', {});
  const names = (list?.result?.tools || []).map((t) => t.name);
  names.length === 4 ? ok('tools/list: ' + names.join(', ')) : fail('expected 4 tools, got ' + JSON.stringify(names));

  // Read-only query round trip through the fake extension.
  const call = await mcp('tools/call', { name: 'netsuite_run_suiteql', arguments: { query: 'SELECT id FROM transaction' } });
  const text = call?.result?.content?.[0]?.text || '';
  text.includes('"count": 2') ? ok('tools/call round trip returned rows') : fail('bad tools/call result: ' + JSON.stringify(call));

  // Large-payload framing test (exercise 16-bit/64-bit length path).
  const bigArgs = { query: 'SELECT ' + 'x'.repeat(70000) + ' FROM dual' };
  // This query is >65535 bytes so the server must use extended length framing
  // when forwarding the 'call' frame to the extension.
  const bigCall = await mcp('tools/call', { name: 'netsuite_run_suiteql', arguments: bigArgs });
  const bigText = bigCall?.result?.content?.[0]?.text || '';
  bigText.includes('"count": 2') ? ok('large-frame round trip ok') : fail('large-frame round trip failed');

  ws.close();
  await wait(200);
  child.kill();
  console.log('\nbridge check complete.');
}

run().catch((e) => { fail(e.message); child.kill(); });
