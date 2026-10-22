# TactaSuite NetSuite Bridge (local companion)

This small, zero-dependency Node program lets a desktop MCP client (such as
Claude Desktop) query your **live** NetSuite instance through the NetSuite
TactaSuite Chrome extension, using your already signed-in browser session.

- No NetSuite-side setup. No integration record, no RESTlet, no OAuth.
- No role switch. It uses whatever role your browser tab is in.
- Read-only by default. Only `SELECT` / `WITH` SuiteQL is allowed unless you
  turn on "Allow write queries" in the extension settings.
- Local only. The companion listens on `127.0.0.1` and is reachable only by
  processes on your own machine, and only with the pairing token.

## How it works

```
Claude Desktop  --stdio/MCP-->  tacta-bridge.mjs  --loopback WS-->  TactaSuite extension  -->  your NetSuite tab
```

Claude Desktop launches `tacta-bridge.mjs` and talks to it over MCP (stdio).
The companion also runs a loopback WebSocket server; the extension's service
worker connects out to it. When Claude calls a tool, the companion forwards it
to the extension, which runs it in your NetSuite tab and returns the result.

The extension dials out to the companion (rather than the reverse) because an
extension cannot run a server, and an open WebSocket keeps the extension's
Manifest V3 service worker alive.

## Install

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. Download `tacta-bridge.mjs` and save it somewhere stable on your PC (there is
   nothing to `npm install` - it has no dependencies). Get it from the
   [latest release](https://github.com/Theblane/TactaSuiteNSToolkit/releases/latest/download/tacta-bridge.mjs),
   or use the **Download the companion** button in the extension's bridge
   settings card.
3. In the extension, open **Options -> Claude Desktop bridge**:
   - Click **Generate** to create a pairing token.
   - Click **Grant local access** (approves the `127.0.0.1` connection).
   - Copy the generated Claude Desktop config block.
4. Paste the block into your Claude Desktop config file and fix the path to
   `tacta-bridge.mjs`:
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
5. Restart Claude Desktop. Open your NetSuite tab. Enable the bridge toggle in
   the extension. The status turns **Connected**.

Example config:

```json
{
  "mcpServers": {
    "netsuite-tactasuite": {
      "command": "node",
      "args": ["C:\\path\\to\\companion\\tacta-bridge.mjs"],
      "env": {
        "TACTA_BRIDGE_TOKEN": "<token from the extension>",
        "TACTA_BRIDGE_PORT": "8787",
        "TACTA_BRIDGE_EXT_ID": "<extension id from the extension>"
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `TACTA_BRIDGE_TOKEN` | yes | - | Shared pairing token; must match the extension. |
| `TACTA_BRIDGE_PORT` | no | `8787` | Loopback port; must match the extension. |
| `TACTA_BRIDGE_EXT_ID` | no | - | If set, only this chrome extension id may connect. |

## Tools exposed to the MCP client

| Tool | What it does |
|------|--------------|
| `netsuite_run_suiteql` | Run a read-only SuiteQL (`SELECT` / `WITH`) query. Paginated to 200k rows. |
| `netsuite_get_current_page` | Describe the NetSuite page you are viewing (URL, account, record type/id, mode). |
| `netsuite_get_current_record_fields` | List fields (id, label, type, value) of the record currently open. |
| `netsuite_list_tabs` | List your open NetSuite browser tabs. |

## Security notes

- The WebSocket server binds `127.0.0.1` only (never `0.0.0.0`).
- Every connection must present the pairing token and a `chrome-extension://`
  origin. Set `TACTA_BRIDGE_EXT_ID` to pin a single extension id.
- Keep your token private. Regenerate it in the extension if it leaks (then
  update this config and restart Claude Desktop).
- Write queries are off by default. The extension gates them behind an explicit
  "Allow write queries" toggle.

## Troubleshooting

- **Status stays "Not connected":** make sure the companion is running (Claude
  Desktop launches it), the port and token match, and a NetSuite tab is open.
- **"port already in use":** set `TACTA_BRIDGE_PORT` to a free port in both the
  config and the extension settings.
- **Tool says the extension is not connected:** open your NetSuite tab and
  confirm the bridge toggle is on; the extension reconnects within ~1 minute.
