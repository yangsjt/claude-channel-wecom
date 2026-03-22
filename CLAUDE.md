# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code Channel plugin that bridges WeCom (Enterprise WeChat) messages into Claude Code sessions via MCP over stdio. It runs as a subprocess spawned by Claude Code, combining an MCP server (stdio transport) with an embedded HTTP callback server (Bun.serve on port 8788) that receives WeCom webhook callbacks.

## Commands

```bash
npm install                  # Install dependencies
npx tsc --noEmit             # Type-check (no build output needed — Bun runs .ts directly)
bun run server.ts            # Run the plugin standalone (requires WECOM_TOKEN + WECOM_ENCODING_AES_KEY env vars)
curl http://localhost:8788/health  # Health check when running
```

There are no tests yet. The runtime is Bun (not Node), executed via `.mcp.json` `"command": "bun"`.

## Architecture

### Dual-Mode Design

The plugin supports two WeCom application types controlled by `WECOM_MODE` env var:

- **`aibot`** (default) — WeCom AI Bot. Inbound: JSON `{ encrypt: "..." }`. Outbound: encrypted stream responses (WeCom polls) with response_url fallback. Minimal config: Token + EncodingAESKey.
- **`agent`** — WeCom Self-built App. Inbound: XML `<Encrypt>...</Encrypt>`. Outbound: Agent REST API `/cgi-bin/message/send`. Requires corpId + corpSecret + agentId + Token + EncodingAESKey.

Both modes share the same AES-256-CBC + SHA1 crypto layer; they differ in message parsing (JSON vs XML) and reply delivery path.

### Message Flow

```
WeCom → HTTPS (nginx reverse proxy) → HTTP :8788/callback → server.ts
  → signature verify + AES decrypt
  → mode dispatch: aibot-handler.ts (JSON) | agent-handler.ts (XML)
  → access control check (lib/access.ts, ~/.claude/channels/wecom/access.json)
  → MCP notification → Claude Code session
  → Claude calls `reply` tool → stream update (aibot) | Agent API POST (agent)
```

### Key Constraint: stdout is MCP-only

All logging MUST use `console.error` (stderr). Any stdout output breaks the MCP stdio transport. The `log()` helper in server.ts enforces this.

### Stream Protocol (AI Bot mode only)

When a message arrives, server.ts creates a stream via `StreamManager`, returns an encrypted `{ stream: { id, content: "🤔", finish: false } }` response. WeCom polls with `msgtype: "stream"` requests. When Claude calls the `reply` tool, the stream is finished and the next poll returns the full reply. If the stream expires (~5 min), falls back to POSTing to `response_url`.

### Code Provenance

Most `lib/` modules were ported from `openclaw-plugin-wecom`:
- `crypto.ts` — merged from pre-v2.0 `crypto.js` (WecomCrypto class with encrypt) + v2.1 `callback-crypto.js` (stateless decrypt)
- `aibot-handler.ts` — from pre-v2.0 `webhook.js` (JSON message parsing)
- `agent-handler.ts` — from v2.1 `callback-inbound.js` (XML parsing + `parseCallbackMessageXml`)
- `agent-api.ts` — from `wecom/agent-api.js` (replaced `wecomFetch` with native `fetch`)
- `utils.ts` — from `utils.js` (TTLCache, MessageDeduplicator, splitTextByByteLimit)
- `think-parser.ts` — from `think-parser.js` (code-block-aware `<think>` tag handling)

### MCP Tools

| Tool | Purpose |
|------|---------|
| `reply` | Send text/Markdown to the most recent message sender |
| `download_attachment` | Download image/file — URL in aibot mode, media_id in agent mode → saves to `~/.claude/channels/wecom/inbox/` |

### Local State

- `~/.claude/channels/wecom/access.json` — pairing-based access control (allowed user IDs)
- `~/.claude/channels/wecom/inbox/` — downloaded attachments

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WECOM_MODE` | No | `aibot` | `aibot` or `agent` |
| `WECOM_TOKEN` | Yes | — | Callback token from WeCom app config |
| `WECOM_ENCODING_AES_KEY` | Yes | — | 43-char AES key from WeCom app config |
| `WECOM_CORP_ID` | Agent only | — | Enterprise corpId |
| `WECOM_CORP_SECRET` | Agent only | — | App corpSecret |
| `WECOM_AGENT_ID` | Agent only | — | App agentId |
| `WECOM_CALLBACK_PORT` | No | `8788` | HTTP callback server port |
| `WECOM_API_BASE_URL` | No | `https://qyapi.weixin.qq.com` | API proxy base URL |
