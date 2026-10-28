#!/usr/bin/env node
/**
 * TactaSuite NetSuite Bridge - local companion
 *
 * @author Blane Maher
 *
 * A single-file, zero-dependency companion that lets a desktop MCP client
 * (e.g. Claude Desktop) query a live NetSuite instance through the TactaSuite
 * Chrome extension. It does two things:
 *
 *   1. Speaks MCP over stdio (newline-delimited JSON-RPC) to the MCP client
 *      that launches it. Exposes read-only NetSuite tools.
 *   2. Runs a loopback WebSocket server on 127.0.0.1 that the extension's
 *      service worker connects OUT to. Tool calls are forwarded to the
 *      extension, which runs them in the user's live NetSuite tab and returns
 *      the result.
 *
 * Multiple instances:
 *   Claude Desktop may launch this script more than once (for example one copy
 *   for regular chats and another for Cowork / Code sessions). Only one process
 *   can own the loopback port, and the extension only connects to that port.
 *
 *   - PRIMARY: the first copy to bind the port. It owns the extension
 *     connection and also accepts "relay" connections from other copies.
 *   - SECONDARY: any copy that finds the port already in use. Instead of
 *     exiting, it connects to the primary as a relay client (authenticated with
 *     the same pairing token) and forwards its tool calls through it.
 *   - FAILOVER: if the primary exits, its secondaries race to bind the port.
 *     One wins and becomes the new primary; the rest relay through it. The
 *     extension reconnects to the new primary on its normal retry cycle.
 *
 * Security model (localhost dev bridge):
 *   - The server binds 127.0.0.1 only (never 0.0.0.0), so only local
 *     processes can reach it.
 *   - Every connection (extension or relay) must present the shared pairing
 *     token (TACTA_BRIDGE_TOKEN). Wrong/absent token is rejected.
 *   - Extension connections must come from a chrome-extension:// origin. If
 *     TACTA_BRIDGE_EXT_ID is set, it must match exactly.
 *   - Read-only by default. Write tools are gated on the extension side and
 *     are not exposed here yet.
 *
 * Config (environment variables, set by the MCP client launcher):
 *   TACTA_BRIDGE_TOKEN   required  shared pairing token (must match extension)
 *   TACTA_BRIDGE_PORT    optional  loopback port (default 8787)
 *   TACTA_BRIDGE_EXT_ID  optional  expected chrome extension id (defense in depth)
 *
 * All diagnostic logging goes to stderr. stdout is reserved for MCP.
 */

import { createServer, connect } from 'node:net';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';

const VERSION = '1.1.0';
const TOKEN = process.env.TACTA_BRIDGE_TOKEN || '';
const PORT = Number(process.env.TACTA_BRIDGE_PORT || 8787);
const EXPECTED_EXT_ID = process.env.TACTA_BRIDGE_EXT_ID || '';
const CALL_TIMEOUT_MS = 60000;
const RELAY_MAGIC = 'TACTA-RELAY';
const RELAY_WELCOME_TIMEOUT_MS = 3000;

function log(...args) {
  process.stderr.write('[tacta-bridge] ' + args.map(String).join(' ') + '\n');
}

if (!TOKEN) {
  log('FATAL: TACTA_BRIDGE_TOKEN is not set. Copy the pairing token from the');
  log('extension settings (Claude Desktop bridge card) into this launcher.');
  process.exit(1);
}

function tokenOk(candidate) {
  const a = Buffer.from(String(candidate || ''), 'utf8');
  const b = Buffer.from(TOKEN, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Tool definitions (MCP tools/list). Keep in sync with the extension-side
// dispatcher in background/modules/bridge-client.js.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'netsuite_run_suiteql',
    description:
      'Run a read-only SuiteQL (SELECT / WITH) query against the live NetSuite ' +
      'instance using the signed-in browser session. Returns columns and rows. ' +
      'Paginated up to 200,000 rows. Only SELECT/WITH statements are allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A SuiteQL SELECT or WITH statement.' },
        params: {
          type: 'array',
          description: 'Optional positional bind parameters for ? placeholders.',
          items: {}
        }
      },
      required: ['query']
    }
  },
  {
    name: 'netsuite_get_current_page',
    description:
      'Describe the NetSuite page the user is currently viewing: URL, account ' +
      'id, environment (production/sandbox/release preview), detected record ' +
      'type, record id, and edit/view mode.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'netsuite_get_current_record_fields',
    description:
      'List the fields of the record currently open in the NetSuite tab, with ' +
      'field id, label, type, and current value. Useful for inspecting a record ' +
      'the user is looking at without re-querying.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'netsuite_list_tabs',
    description:
      'List the open NetSuite browser tabs (title and URL) so you can see what ' +
      'the user has available. The active tab is used by the other tools.',
    inputSchema: { type: 'object', properties: {} }
  }
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// Shared helpers: newline-delimited JSON over a raw TCP socket (relay link).
// ---------------------------------------------------------------------------

function writeLine(socket, obj) {
  try { socket.write(JSON.stringify(obj) + '\n'); } catch (_) {}
}

function lineReader(onMsg) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      onMsg(msg);
    }
  };
}

// ---------------------------------------------------------------------------
// Instance role
// ---------------------------------------------------------------------------

let mode = 'starting';          // 'starting' | 'primary' | 'secondary'
let server = null;              // primary: the listening net.Server

// Primary state
let activeSocket = null;        // the paired extension WS connection, or null
const pending = new Map();      // callId -> { resolve, reject, timer }
const relayClients = new Set(); // connected secondary instances

// Secondary state
let relaySocket = null;         // connection to the primary, once welcomed
const relayPending = new Map(); // callId -> { resolve, reject, timer }
let loggedWaitingForPrimary = false;

// ---------------------------------------------------------------------------
// WebSocket server (hand-rolled, zero dependency). Single extension client.
// ---------------------------------------------------------------------------

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

function parseHeaders(raw) {
  const lines = raw.split('\r\n');
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx > 0) headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
  }
  return headers;
}

function sendFrame(socket, str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // 64-bit length, high 32 bits assumed 0 for our payloads
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x81; // FIN + text opcode
  socket.write(Buffer.concat([header, payload]));
}

function sendControl(socket, opcode, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(2);
  header[0] = 0x80 | opcode;
  header[1] = payload.length;
  socket.write(Buffer.concat([header, payload]));
}

function send(obj) {
  if (activeSocket) sendFrame(activeSocket, JSON.stringify(obj));
}

function closeActive(reason) {
  if (!activeSocket) return;
  try { sendControl(activeSocket, 0x8); } catch (_) {}
  try { activeSocket.destroy(); } catch (_) {}
  log('bridge disconnected' + (reason ? ': ' + reason : ''));
  activeSocket = null;
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('Bridge disconnected.')); }
  pending.clear();
}

function handleFrames(socket, state, onMessage) {
  let buf = state.buf;
  while (buf.length >= 2) {
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      const hi = buf.readUInt32BE(2);
      const lo = buf.readUInt32BE(6);
      len = hi * 0x100000000 + lo;
      offset = 10;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) break;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) break; // wait for more data
    let payload = buf.slice(offset, offset + len);
    if (masked && maskKey) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
      payload = out;
    }
    buf = buf.slice(offset + len);

    if (opcode === 0x8) { // close
      if (socket === activeSocket) closeActive('client close');
      else { try { socket.destroy(); } catch (_) {} }
      state.buf = Buffer.alloc(0);
      return;
    } else if (opcode === 0x9) { // ping -> pong
      sendControl(socket, 0xA, payload);
    } else if (opcode === 0xA) { // pong
      // ignore
    } else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      state.fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(state.fragments).toString('utf8');
        state.fragments = [];
        onMessage(full);
      }
    }
  }
  state.buf = buf;
}

/**
 * Primary side: accept a relay connection from a secondary instance.
 * Returns a feed function for subsequent socket data, or null if rejected.
 */
function acceptRelay(socket, token) {
  if (!tokenOk(token)) {
    log('rejected relay connection: bad or missing token');
    writeLine(socket, { type: 'error', message: 'Invalid pairing token.' });
    socket.end();
    return null;
  }
  relayClients.add(socket);
  socket.on('close', () => {
    relayClients.delete(socket);
    log('secondary instance detached (' + relayClients.size + ' attached)');
  });
  writeLine(socket, { type: 'relay-welcome', server: 'tacta-bridge', version: VERSION });
  log('secondary instance attached (' + relayClients.size + ' attached)');

  return lineReader((msg) => {
    if (msg.type !== 'call' || !msg.id) return;
    if (!TOOL_NAMES.has(msg.tool)) {
      writeLine(socket, { type: 'result', id: msg.id, ok: false, error: 'Unknown tool: ' + msg.tool });
      return;
    }
    callExtensionDirect(msg.tool, msg.args).then(
      (data) => writeLine(socket, { type: 'result', id: msg.id, ok: true, data }),
      (e) => writeLine(socket, { type: 'result', id: msg.id, ok: false, error: e.message })
    );
  });
}

function makeServer() {
  return createServer((socket) => {
    let upgraded = false;
    let relayFeed = null;
    let rejected = false;
    let headerBuf = Buffer.alloc(0);
    const state = { buf: Buffer.alloc(0), fragments: [] };

    socket.on('data', (chunk) => {
      if (rejected) return;
      if (relayFeed) { relayFeed(chunk); return; }

      if (!upgraded) {
        headerBuf = Buffer.concat([headerBuf, chunk]);

        // Relay connections from secondary instances start with one line:
        //   TACTA-RELAY <token>\n
        // followed by newline-delimited JSON.
        const nl = headerBuf.indexOf('\n');
        if (nl === -1) return;
        if (headerBuf.slice(0, RELAY_MAGIC.length + 1).toString('utf8') === RELAY_MAGIC + ' ') {
          const first = headerBuf.slice(0, nl).toString('utf8').trim();
          const rest = headerBuf.slice(nl + 1);
          relayFeed = acceptRelay(socket, first.slice(RELAY_MAGIC.length + 1));
          if (!relayFeed) { rejected = true; return; }
          if (rest.length) relayFeed(rest);
          return;
        }

        // Otherwise: WebSocket upgrade from the extension.
        const sep = headerBuf.indexOf('\r\n\r\n');
        if (sep === -1) return;
        const raw = headerBuf.slice(0, sep).toString('utf8');
        const rest = headerBuf.slice(sep + 4);
        const headers = parseHeaders(raw);
        const key = headers['sec-websocket-key'];
        const origin = headers['origin'] || '';

        if (!key) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); rejected = true; return; }
        if (!origin.startsWith('chrome-extension://')) {
          log('rejected connection: non-extension origin', origin || '(none)');
          socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
          rejected = true;
          return;
        }
        if (EXPECTED_EXT_ID && origin !== 'chrome-extension://' + EXPECTED_EXT_ID) {
          log('rejected connection: extension id mismatch', origin);
          socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
          rejected = true;
          return;
        }

        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
        );
        upgraded = true;
        state.origin = origin;
        state.buf = rest;
        if (rest.length) handleFrames(socket, state, onMessage);
        return;
      }
      state.buf = Buffer.concat([state.buf, chunk]);
      handleFrames(socket, state, onMessage);
    });

    socket.on('error', (e) => { log('socket error:', e.message); });
    socket.on('close', () => { if (socket === activeSocket) closeActive('socket closed'); });

    let authed = false;
    function onMessage(text) {
      let msg;
      try { msg = JSON.parse(text); } catch (_) { return; }

      if (!authed) {
        if (msg.type === 'hello' && tokenOk(msg.token)) {
          authed = true;
          if (activeSocket && activeSocket !== socket) closeActive('replaced by new connection');
          activeSocket = socket;
          send({ type: 'welcome', server: 'tacta-bridge', version: VERSION });
          log('extension paired from', state.origin);
        } else {
          log('rejected connection: bad or missing token');
          sendFrame(socket, JSON.stringify({ type: 'error', message: 'Invalid pairing token.' }));
          sendControl(socket, 0x8);
          socket.destroy();
        }
        return;
      }

      if (msg.type === 'result' && msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error || 'Tool execution failed.'));
      } else if (msg.type === 'pong') {
        // heartbeat ack
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Startup / role election
// ---------------------------------------------------------------------------

function start() {
  mode = 'starting';
  const s = makeServer();

  s.once('listening', () => {
    server = s;
    mode = 'primary';
    loggedWaitingForPrimary = false;
    log('loopback bridge listening on 127.0.0.1:' + PORT + ' (primary, waiting for extension)');
  });

  s.on('error', (e) => {
    if (mode === 'starting' && e.code === 'EADDRINUSE') {
      try { s.close(); } catch (_) {}
      becomeSecondary();
      return;
    }
    if (mode === 'starting') {
      log('FATAL: could not listen on 127.0.0.1:' + PORT + ': ' + e.message);
      process.exit(1);
    }
    log('server error:', e.message);
  });

  s.listen(PORT, '127.0.0.1');
}

function scheduleStart(delayMs) {
  setTimeout(start, delayMs);
}

/**
 * Secondary side: connect to the primary that owns the port and relay through it.
 * If the link drops (primary exited), try to take over the port.
 */
function becomeSecondary() {
  mode = 'secondary';
  const sock = connect(PORT, '127.0.0.1');
  let welcomed = false;

  const welcomeTimer = setTimeout(() => {
    if (!welcomed) {
      if (!loggedWaitingForPrimary) {
        log('port ' + PORT + ' is in use but did not answer as a tacta-bridge 1.1+ instance.');
        log('Will keep retrying. If this persists, another program holds the port, or an');
        log('older tacta-bridge (1.0.x) is still running. Restart Claude Desktop to clear it.');
        loggedWaitingForPrimary = true;
      }
      sock.destroy();
    }
  }, RELAY_WELCOME_TIMEOUT_MS);

  const feed = lineReader((msg) => {
    if (msg.type === 'relay-welcome') {
      welcomed = true;
      clearTimeout(welcomeTimer);
      relaySocket = sock;
      loggedWaitingForPrimary = false;
      log('port ' + PORT + ' is owned by another tacta-bridge (' + (msg.version || '?') +
        '); relaying tool calls through it (secondary)');
    } else if (msg.type === 'result' && msg.id && relayPending.has(msg.id)) {
      const p = relayPending.get(msg.id);
      relayPending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error || 'Tool execution failed.'));
    } else if (msg.type === 'error') {
      log('primary rejected relay: ' + (msg.message || 'unknown error') +
        ' (check that every launcher uses the same TACTA_BRIDGE_TOKEN)');
    }
  });

  sock.on('connect', () => { sock.write(RELAY_MAGIC + ' ' + TOKEN + '\n'); });
  sock.on('data', feed);
  sock.on('error', (e) => { if (welcomed) log('relay error:', e.message); });
  sock.on('close', () => {
    clearTimeout(welcomeTimer);
    if (relaySocket === sock) {
      relaySocket = null;
      log('lost connection to primary; attempting to take over port ' + PORT);
    }
    for (const [, p] of relayPending) {
      clearTimeout(p.timer);
      p.reject(new Error('Lost connection to the primary bridge instance. Try again in a moment.'));
    }
    relayPending.clear();
    // After a working link drops, retry quickly with jitter so sibling
    // secondaries don't all collide. Otherwise back off.
    scheduleStart(welcomed ? 200 + Math.floor(Math.random() * 600) : 3000);
  });
}

// Heartbeat: keep the extension service worker alive and detect dead sockets.
setInterval(() => { if (activeSocket) send({ type: 'ping', t: Date.now() }); }, 20000);

// ---------------------------------------------------------------------------
// Tool call routing
// ---------------------------------------------------------------------------

/**
 * Primary: forward a tool call to the paired extension and await its result.
 */
function callExtensionDirect(tool, args) {
  return new Promise((resolve, reject) => {
    if (!activeSocket) {
      reject(new Error(
        'The TactaSuite extension is not connected. Open your NetSuite tab, make ' +
        'sure the bridge is enabled in the extension settings, and that the pairing ' +
        'token and port match.'
      ));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Timed out waiting for the extension to respond.'));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    send({ type: 'call', id, tool, args: args || {} });
  });
}

/**
 * Secondary: send a tool call to the primary over the relay link.
 */
function callViaRelay(tool, args) {
  return new Promise((resolve, reject) => {
    if (!relaySocket) {
      reject(new Error(
        'The bridge is reconnecting to the TactaSuite extension. Try again in a few seconds.'
      ));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      relayPending.delete(id);
      reject(new Error('Timed out waiting for the extension to respond.'));
    }, CALL_TIMEOUT_MS + 5000);
    relayPending.set(id, { resolve, reject, timer });
    writeLine(relaySocket, { type: 'call', id, tool, args: args || {} });
  });
}

function callExtension(tool, args) {
  if (mode === 'primary') return callExtensionDirect(tool, args);
  if (mode === 'secondary') return callViaRelay(tool, args);
  return Promise.reject(new Error('The bridge is still starting up. Try again in a moment.'));
}

// ---------------------------------------------------------------------------
// MCP server over stdio (newline-delimited JSON-RPC 2.0).
// ---------------------------------------------------------------------------

function writeRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function rpcResult(id, result) { writeRpc({ jsonrpc: '2.0', id, result }); }
function rpcError(id, code, message) { writeRpc({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handleToolCall(name, args) {
  if (!TOOL_NAMES.has(name)) throw new Error('Unknown tool: ' + name);
  const data = await callExtension(name, args);
  return data;
}

function toToolContent(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch (_) { return; }

  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  try {
    switch (method) {
      case 'initialize':
        rpcResult(id, {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'tacta-netsuite-bridge', version: VERSION }
        });
        return;
      case 'notifications/initialized':
      case 'initialized':
        return; // notification, no response
      case 'ping':
        if (isRequest) rpcResult(id, {});
        return;
      case 'tools/list':
        rpcResult(id, { tools: TOOLS });
        return;
      case 'tools/call': {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        try {
          const data = await handleToolCall(name, args);
          rpcResult(id, toToolContent(data));
        } catch (e) {
          // Report tool failures as MCP tool errors, not protocol errors.
          rpcResult(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
        }
        return;
      }
      default:
        if (isRequest) rpcError(id, -32601, 'Method not found: ' + method);
        return;
    }
  } catch (e) {
    if (isRequest) rpcError(id, -32603, e.message);
  }
});

function shutdown(code) {
  closeActive('shutting down');
  for (const s of relayClients) { try { s.destroy(); } catch (_) {} }
  if (relaySocket) { try { relaySocket.destroy(); } catch (_) {} }
  if (server) { try { server.close(); } catch (_) {} }
  process.exit(code);
}

rl.on('close', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

log('tacta-bridge ' + VERSION + ' ready (MCP on stdio).');
start();