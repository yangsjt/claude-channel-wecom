#!/usr/bin/env bun
/**
 * WeCom Channel Plugin for Claude Code
 *
 * MCP server with embedded HTTP callback server.
 * Supports dual mode: AI Bot (JSON) and Agent (XML).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { loadConfig, type WecomConfig } from "./lib/config.js";
import { WecomCrypto } from "./lib/crypto.js";
import { MessageDeduplicator } from "./lib/utils.js";
import { handleAiBotMessage, type AiBotMessageResult } from "./lib/aibot-handler.js";
import { handleAgentMessage, type AgentMessageResult } from "./lib/agent-handler.js";
import { agentSendText, agentDownloadMedia, type AgentCredentials } from "./lib/agent-api.js";
import { StreamManager, type StreamEntry } from "./lib/stream-manager.js";
import { splitTextByByteLimit } from "./lib/utils.js";
import { parseThinkingContent } from "./lib/think-parser.js";
import {
  isUserAllowed,
  generatePairingCode,
  attemptPairing,
  addUser,
  removeUser,
  listUsers,
  setMode,
  getMode,
  getPairingState,
} from "./lib/access.js";
import {
  TEXT_CHUNK_LIMIT,
  CALLBACK_TIMESTAMP_TOLERANCE_S,
  CALLBACK_MAX_BODY_BYTES,
} from "./lib/constants.js";
import {
  type PendingPermission,
  PENDING_PERMISSION_TTL_MS,
  PERMISSION_REPLY_RE,
  formatPermissionMessage,
  matchPermissionReply,
  findByShortId,
} from "./lib/permission.js";

// ---------------------------------------------------------------------------
// Logging — stdout is reserved for MCP stdio, so all logging goes to stderr
// ---------------------------------------------------------------------------

type LogLevel = "debug" | "info" | "warn" | "error";

function log(msg: string, level: LogLevel = "info", meta?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    src: "wecom-channel",
    msg,
    ...meta,
  };
  console.error(JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config = loadConfig();
const crypto = new WecomCrypto(config.token, config.encodingAesKey);
const deduplicator = new MessageDeduplicator();
const streamManager = new StreamManager();

// Pending messages waiting for Claude's reply (for both modes)
interface PendingMessage {
  fromUser: string;
  chatType: string;
  chatId: string;
  responseUrl: string; // AI Bot mode only
  streamId: string;    // AI Bot mode only
  timestamp: number;
}

const pendingMessages = new Map<string, PendingMessage>();

// Cleanup stale pending messages every 60 seconds (30 min TTL)
const PENDING_MESSAGE_TTL_MS = 30 * 60 * 1000;
const pendingCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, msg] of pendingMessages) {
    if (now - msg.timestamp > PENDING_MESSAGE_TTL_MS) {
      log(`Cleaning up stale pending message: ${key}`);
      pendingMessages.delete(key);
    }
  }
}, 60_000);
if (pendingCleanupTimer.unref) pendingCleanupTimer.unref();

// ---------------------------------------------------------------------------
// Permission request forwarding
// ---------------------------------------------------------------------------

const pendingPermissions = new Map<string, PendingPermission>();

// Cleanup stale pending permissions alongside messages
const permCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, perm] of pendingPermissions) {
    if (now - perm.timestamp > PENDING_PERMISSION_TTL_MS) {
      log(`Cleaning up stale pending permission: ${key}`);
      pendingPermissions.delete(key);
    }
  }
}, 60_000);
if (permCleanupTimer.unref) permCleanupTimer.unref();

/**
 * Find the most recent allowed user from pendingMessages to deliver permission requests.
 */
function findRecentAllowedUser(): PendingMessage | undefined {
  let latest: PendingMessage | undefined;
  for (const [, msg] of pendingMessages) {
    if (!latest || msg.timestamp > latest.timestamp) {
      latest = msg;
    }
  }
  return latest;
}

/**
 * Send a permission request message to the WeCom user.
 */
async function sendPermissionRequest(perm: PendingPermission): Promise<void> {
  const text = formatPermissionMessage(perm);

  const target = findRecentAllowedUser();
  if (!target) {
    log("No recent user to send permission request to", "warn");
    return;
  }

  if (config.mode === "aibot") {
    if (target.responseUrl) {
      await postResponseUrl(target.responseUrl, text).catch((err) =>
        log(`Permission request response_url POST failed: ${err}`, "error"),
      );
    } else {
      log("No response_url available for permission request (aibot mode)", "warn");
    }
  } else {
    if (config.corpId && config.corpSecret && config.agentId) {
      await agentSendText({
        agent: { corpId: config.corpId, corpSecret: config.corpSecret, agentId: config.agentId },
        toUser: target.fromUser,
        text,
      }).catch((err) => log(`Permission request agent send failed: ${err}`, "error"));
    } else {
      log("Agent credentials missing for permission request", "warn");
    }
  }
}

/**
 * Handle a permission reply from the user.
 * Returns true if the message was a permission reply (and was handled), false otherwise.
 */
async function handlePermissionReply(
  text: string,
  fromUser: string,
  replyFn: (msg: string) => Promise<void>,
): Promise<boolean> {
  const parsed = matchPermissionReply(text);
  if (!parsed) return false;

  const { approved, shortId } = parsed;
  const result = findByShortId(pendingPermissions, shortId);

  if (!result) {
    await replyFn(`⚠️ 未找到匹配的权限请求 (${shortId})`).catch(() => {});
    return true; // Still consumed the message pattern
  }

  // Send permission decision back to Claude
  await mcp.notification({
    method: "notifications/claude/channel/permission",
    params: {
      request_id: result.perm.requestId,
      behavior: approved ? "allow" : "deny",
    },
  });

  pendingPermissions.delete(result.key);

  const emoji = approved ? "✅" : "❌";
  const action = approved ? "已批准" : "已拒绝";
  await replyFn(`${emoji} ${action}: ${result.perm.toolName}`).catch(() => {});

  log(`Permission ${action}: ${result.perm.toolName} (${result.perm.requestId})`, "info", { fromUser });
  return true;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: "wecom-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {}, "claude/channel/permission": {} },
      tools: {},
    },
    instructions: [
      "Messages from the wecom-channel arrive as <channel source=\"wecom-channel\" ...>.",
      "Each message is from a WeCom (Enterprise WeChat) user.",
      "Attributes include: sender (user ID), chat_type (single or group), and msg_type.",
      "Use the reply tool to respond to the user. Messages support Markdown formatting in AI Bot mode.",
      "To manage access control, use the manage_access tool:",
      "- 'pair' generates a 6-char pairing code (15 min). Tell the WeCom user to send the code as a message.",
      "- 'list' shows allowed users and mode. 'add'/'remove' manage users. 'mode' switches open/paired.",
      "When the user asks for a pairing code or says '配对码', use manage_access with action 'pair' — do NOT use reply.",
    ].join(" "),
  },
);

// ---------------------------------------------------------------------------
// reply tool
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a text or Markdown reply to the WeCom user who sent the most recent message. " +
        "In AI Bot mode, replies are delivered via stream response or response_url fallback. " +
        "In Agent mode, replies are sent via WeCom Agent REST API.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "The reply text (supports Markdown in AI Bot mode)",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "download_attachment",
      description:
        "Download an image or file attachment from a WeCom message. " +
        "In AI Bot mode, downloads directly from the image URL. " +
        "In Agent mode, downloads via Agent API using media_id. " +
        "Returns the local file path where the attachment was saved.",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: {
            type: "string",
            description: "The image/file URL (AI Bot mode) or media_id (Agent mode)",
          },
          filename: {
            type: "string",
            description: "Optional filename to save as (default: auto-generated)",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "manage_access",
      description:
        "Manage WeCom channel access control. Actions: " +
        "'pair' generates a 6-character pairing code (valid 15 min) for a WeCom user to authorize themselves. " +
        "'add' directly adds a user ID to the allowlist. " +
        "'remove' removes a user from the allowlist. " +
        "'list' shows all allowed users and current access mode. " +
        "'mode' sets access mode to 'open' (allow all) or 'paired' (allowlist only).",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            description: "Action to perform: pair, add, remove, list, mode",
          },
          value: {
            type: "string",
            description: "User ID (for add/remove) or mode value (open/paired). Not needed for pair/list.",
          },
        },
        required: ["action"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { text } = req.params.arguments as { text: string };
    try {
      const result = await handleReply(text);
      return {
        content: [{ type: "text" as const, text: result }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Reply failed: ${message}` }],
        isError: true,
      };
    }
  }

  if (req.params.name === "download_attachment") {
    const { url, filename } = req.params.arguments as {
      url: string;
      filename?: string;
    };
    try {
      const result = await handleDownloadAttachment(url, filename);
      return {
        content: [{ type: "text" as const, text: result }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Download failed: ${message}` }],
        isError: true,
      };
    }
  }

  if (req.params.name === "manage_access") {
    const { action, value } = req.params.arguments as {
      action: string;
      value?: string;
    };
    try {
      const result = handleManageAccess(action, value);
      return {
        content: [{ type: "text" as const, text: result }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Access management failed: ${message}` }],
        isError: true,
      };
    }
  }

  throw new Error(`Unknown tool: ${req.params.name}`);
});

// ---------------------------------------------------------------------------
// Access management handler
// ---------------------------------------------------------------------------

function handleManageAccess(action: string, value?: string): string {
  switch (action) {
    case "pair": {
      const code = generatePairingCode("developer");
      return `Pairing code generated: ${code}\nValid for 15 minutes. The WeCom user should send this code as a message to pair.`;
    }
    case "add": {
      if (!value) throw new Error("User ID required for 'add' action");
      addUser(value);
      return `User ${value} added to allowlist.`;
    }
    case "remove": {
      if (!value) throw new Error("User ID required for 'remove' action");
      removeUser(value);
      return `User ${value} removed from allowlist.`;
    }
    case "list": {
      const users = listUsers();
      const mode = getMode();
      const pairing = getPairingState();
      const lines = [
        `Access mode: ${mode}`,
        `Allowed users (${users.length}): ${users.length > 0 ? users.join(", ") : "(none)"}`,
      ];
      if (pairing.hasPendingPairing) {
        lines.push(`Pending pairing code: ${pairing.code}`);
      }
      return lines.join("\n");
    }
    case "mode": {
      if (value !== "open" && value !== "paired") {
        throw new Error("Mode must be 'open' or 'paired'");
      }
      setMode(value);
      return `Access mode set to: ${value}`;
    }
    default:
      throw new Error(`Unknown action: ${action}. Use: pair, add, remove, list, mode`);
  }
}

// ---------------------------------------------------------------------------
// Reply handler
// ---------------------------------------------------------------------------

async function handleReply(text: string): Promise<string> {
  // Find the most recent pending message
  let latest: PendingMessage | undefined;
  let latestKey: string | undefined;
  for (const [key, msg] of pendingMessages) {
    if (!latest || msg.timestamp > latest.timestamp) {
      latest = msg;
      latestKey = key;
    }
  }

  if (!latest || !latestKey) {
    throw new Error("No pending message to reply to");
  }

  const { visibleContent, thinkingContent } = parseThinkingContent(text);
  const replyText = visibleContent || text;

  if (config.mode === "aibot") {
    // AI Bot mode: update stream with final reply
    const stream = streamManager.get(latest.streamId);
    log("Reply handler invoked", "info", {
      streamId: latest.streamId, streamExists: !!stream, streamFinished: stream?.finished,
      streamExpired: latest.streamId ? streamManager.isExpired(latest.streamId) : null,
      hasResponseUrl: !!latest.responseUrl, fromUser: latest.fromUser,
    });
    if (stream && !stream.finished) {
      streamManager.finish(latest.streamId, replyText, thinkingContent);
      log(`Reply: stream finished with ${replyText.length} chars`);
      pendingMessages.delete(latestKey);
      return `Reply delivered via stream (streamId: ${latest.streamId})`;
    }

    // Stream expired — fallback to response_url
    if (latest.responseUrl) {
      const chunks = splitTextByByteLimit(replyText, TEXT_CHUNK_LIMIT);
      for (const chunk of chunks) {
        await postResponseUrl(latest.responseUrl, chunk);
      }
      pendingMessages.delete(latestKey);
      return `Reply delivered via response_url (${chunks.length} chunk(s))`;
    }

    throw new Error("Stream expired and no response_url available");
  } else {
    // Agent mode: send via Agent REST API
    const agent: AgentCredentials = {
      corpId: config.corpId!,
      corpSecret: config.corpSecret!,
      agentId: config.agentId!,
    };
    const chunks = splitTextByByteLimit(replyText, TEXT_CHUNK_LIMIT);
    for (const chunk of chunks) {
      await agentSendText({
        agent,
        toUser: latest.fromUser,
        text: chunk,
      });
    }
    pendingMessages.delete(latestKey);
    return `Reply delivered via Agent API (${chunks.length} chunk(s))`;
  }
}

async function postResponseUrl(responseUrl: string, text: string): Promise<void> {
  const body = JSON.stringify({
    msgtype: "markdown",
    markdown: { content: text },
  });
  log(`response_url POST: url=${responseUrl.substring(0, 60)}... bodyLen=${body.length}`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  const resBody = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`response_url POST failed: ${res.status} ${resBody}`);
  }
  log(`response_url POST result: ${resBody.substring(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Download attachment handler
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INBOX_DIR = join(
  process.env.HOME || "/tmp",
  ".claude",
  "channels",
  "wecom",
  "inbox",
);

async function handleDownloadAttachment(
  urlOrMediaId: string,
  filename?: string,
): Promise<string> {
  // Ensure inbox directory exists
  if (!existsSync(INBOX_DIR)) {
    mkdirSync(INBOX_DIR, { recursive: true });
  }

  let buffer: Buffer;
  let contentType: string;
  let resolvedFilename: string;

  if (config.mode === "aibot") {
    // AI Bot mode: direct URL download
    if (!urlOrMediaId.startsWith("http")) {
      throw new Error("In AI Bot mode, provide a full URL to download");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(urlOrMediaId, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Download failed: HTTP ${res.status}`);
      }
      const rawBuffer = Buffer.from(await res.arrayBuffer());

      // WeCom AI Bot encrypts downloaded media with AES-256-CBC
      buffer = crypto.decryptMedia(rawBuffer);
      log(`Attachment downloaded: ${rawBuffer.length} → decrypted: ${buffer.length} bytes`);

      // Determine content type from filename extension (WeCom often returns generic octet-stream)
      const ext = (filename || urlOrMediaId).split(".").pop()?.toLowerCase().split("?")[0] || "";
      const extTypeMap: Record<string, string> = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
        md: "text/markdown", txt: "text/plain", pdf: "application/pdf",
        doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      };
      contentType = extTypeMap[ext] || res.headers.get("content-type") || "application/octet-stream";

      // Try to extract filename from URL or Content-Disposition
      const disposition = res.headers.get("content-disposition") ?? "";
      const nameMatch = disposition.match(/filename[*\s]*=\s*(?:UTF-8''|")?([^";]+)/i);
      resolvedFilename =
        filename ||
        nameMatch?.[1]?.trim() ||
        urlOrMediaId.split("/").pop()?.split("?")[0] ||
        `download-${Date.now()}`;
    } finally {
      clearTimeout(timeoutId);
    }
  } else {
    // Agent mode: download via Agent API
    const agent: AgentCredentials = {
      corpId: config.corpId!,
      corpSecret: config.corpSecret!,
      agentId: config.agentId!,
    };

    const result = await agentDownloadMedia({ agent, mediaId: urlOrMediaId });
    buffer = result.buffer;
    contentType = result.contentType;

    // Determine filename from content type
    const extMap: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "voice/amr": ".amr",
      "video/mp4": ".mp4",
    };
    const ext = extMap[contentType] || ".bin";
    resolvedFilename = filename || `${urlOrMediaId}${ext}`;
  }

  // Sanitize filename
  resolvedFilename = resolvedFilename.replace(/[/\\:*?"<>|]/g, "_");

  const filePath = join(INBOX_DIR, resolvedFilename);
  writeFileSync(filePath, buffer);

  log(`Attachment saved: ${filePath} (${buffer.length} bytes, ${contentType})`);
  return `Saved to ${filePath} (${buffer.length} bytes, ${contentType})`;
}

// ---------------------------------------------------------------------------
// Channel notification helper
// ---------------------------------------------------------------------------

async function emitChannelMessage(opts: {
  sender: string;
  chatType: string;
  msgType: string;
  content: string;
  msgId: string;
  extraMeta?: Record<string, string>;
}) {
  const meta: Record<string, string> = {
    sender: opts.sender,
    chat_type: opts.chatType,
    msg_type: opts.msgType,
    msg_id: opts.msgId,
    ...opts.extraMeta,
  };

  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: opts.content,
      meta,
    },
  });

  log("Channel message emitted", "info", { sender: opts.sender, msgType: opts.msgType, msgId: opts.msgId });
}

// ---------------------------------------------------------------------------
// HTTP Callback Server
// ---------------------------------------------------------------------------

function startHttpServer() {
  const server = Bun.serve({
    port: config.callbackPort,
    hostname: "0.0.0.0",

    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return new Response(
          JSON.stringify({ status: "ok", channel: "wecom", mode: config.mode }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      // Callback endpoint
      if (url.pathname === "/callback" || url.pathname === "/") {
        return handleCallback(req, url);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  log(`HTTP callback server listening on 0.0.0.0:${server.port} (mode: ${config.mode})`);
  return server;
}

async function handleCallback(req: Request, url: URL): Promise<Response> {
  const signature = url.searchParams.get("msg_signature") ?? "";
  const timestamp = url.searchParams.get("timestamp") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";

  // --- GET: URL verification ---
  if (req.method === "GET") {
    const echostr = url.searchParams.get("echostr") ?? "";
    if (!echostr) {
      return new Response("missing echostr", { status: 400 });
    }

    const calcSig = crypto.getSignature(timestamp, nonce, echostr);
    if (calcSig !== signature) {
      log(`GET signature mismatch: expected=${signature} calc=${calcSig}`);
      return new Response("forbidden", { status: 403 });
    }

    try {
      const decrypted = crypto.decrypt(echostr);
      return new Response(decrypted.message, {
        headers: { "Content-Type": "text/plain" },
      });
    } catch (err) {
      log(`GET echostr decrypt failed: ${err instanceof Error ? err.message : err}`);
      return new Response("error", { status: 500 });
    }
  }

  // --- POST: message callback ---
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // Timestamp anti-replay check
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > CALLBACK_TIMESTAMP_TOLERANCE_S) {
    log(`Timestamp out of tolerance: ${timestamp}`);
    return new Response("forbidden", { status: 403 });
  }

  const body = await req.text();
  if (body.length > CALLBACK_MAX_BODY_BYTES) {
    return new Response("request body too large", { status: 413 });
  }

  // Auto-detect mode from body format: JSON (AI Bot) vs XML (Agent)
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    return handleAiBotCallback(body, signature, timestamp, nonce);
  } else if (trimmed.startsWith("<")) {
    return handleAgentCallback(body, signature, timestamp, nonce);
  } else if (config.mode === "aibot") {
    return handleAiBotCallback(body, signature, timestamp, nonce);
  } else {
    return handleAgentCallback(body, signature, timestamp, nonce);
  }
}

// ---------------------------------------------------------------------------
// AI Bot callback (JSON)
// ---------------------------------------------------------------------------

async function handleAiBotCallback(
  body: string,
  signature: string,
  timestamp: string,
  nonce: string,
): Promise<Response> {
  const result = handleAiBotMessage(crypto, { signature, timestamp, nonce }, body, deduplicator);

  if (!result) {
    return new Response("ok", { status: 200 });
  }

  if (result.type === "duplicate") {
    // Return empty stream continuation for duplicate
    return new Response("ok", { status: 200 });
  }

  if (result.type === "stream") {
    // Stream refresh request — return current stream state
    const stream = streamManager.get(result.streamId);
    if (stream) {
      log("Stream poll", "debug", { streamId: stream.id, finished: stream.finished, contentLen: stream.content.length });
      const responseBody = crypto.buildStreamResponse(
        stream.id,
        stream.finished ? stream.content : "正在思考...",
        stream.finished,
        timestamp,
        nonce,
        { thinkingContent: stream.thinkingContent },
      );
      return new Response(responseBody, {
        headers: { "Content-Type": "application/json" },
      });
    }
    log(`Stream poll: unknown streamId=${result.streamId}`);
    // Unknown stream — return empty
    return new Response("ok", { status: 200 });
  }

  if (result.type === "message") {
    const msg = result.message!;

    // Access control check
    if (!isUserAllowed(msg.fromUser)) {
      // Check if this is a pairing attempt
      const pairingState = getPairingState();
      if (pairingState.hasPendingPairing && msg.content) {
        const paired = attemptPairing(msg.fromUser, msg.content.trim());
        if (paired) {
          log(`User ${msg.fromUser} paired successfully`);
          // Return a success stream
          const streamId = streamManager.create();
          streamManager.finish(streamId, "✅ 配对成功！你现在可以与 Claude Code 对话了。");
          const responseBody = crypto.buildStreamResponse(
            streamId, "✅ 配对成功！", true, timestamp, nonce,
          );
          return new Response(responseBody, {
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      log("Access denied", "warn", { fromUser: msg.fromUser });
      const streamId = streamManager.create();
      streamManager.finish(streamId, "⚠️ 无权限。请让开发者在 Claude Code 中输入「wecom 配对码」生成配对码，然后将配对码发送到此对话即可完成授权。");
      const responseBody = crypto.buildStreamResponse(
        streamId, "⚠️ 无权限", true, timestamp, nonce,
      );
      return new Response(responseBody, {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Permission reply intercept
    if (msg.content && PERMISSION_REPLY_RE.test(msg.content.trim())) {
      const replyStreamId = streamManager.create();
      const handled = await handlePermissionReply(
        msg.content,
        msg.fromUser,
        async (confirmText) => {
          streamManager.finish(replyStreamId, confirmText);
        },
      );
      if (handled) {
        const responseBody = crypto.buildStreamResponse(
          replyStreamId,
          streamManager.get(replyStreamId)?.content || "✅",
          true,
          timestamp,
          nonce,
        );
        return new Response(responseBody, {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Create a stream for this message
    const streamId = streamManager.create();
    log("Stream created", "info", { streamId, fromUser: msg.fromUser, msgId: msg.msgId });

    // Store pending message for reply
    const pendingKey = `${msg.fromUser}:${msg.msgId}`;
    pendingMessages.set(pendingKey, {
      fromUser: msg.fromUser,
      chatType: msg.chatType,
      chatId: msg.chatId,
      responseUrl: msg.responseUrl,
      streamId,
      timestamp: Date.now(),
    });

    // Emit to Claude Code
    const contentParts: string[] = [];
    if (msg.content) contentParts.push(msg.content);
    if (msg.imageUrls?.length) {
      for (const url of msg.imageUrls) {
        contentParts.push(`[图片: ${url}]`);
      }
    }
    if (msg.fileUrl) {
      contentParts.push(`[文件: ${msg.fileName || "unknown"}] ${msg.fileUrl}`);
    }
    const content = contentParts.join("\n") || "[消息]";

    const meta: Record<string, string> = {
      sender: msg.fromUser,
      chat_type: msg.chatType,
      msg_type: msg.msgType,
      msg_id: msg.msgId,
    };
    if (msg.imageUrls?.length) {
      meta.image_urls = JSON.stringify(msg.imageUrls);
    }
    if (msg.fileUrl) {
      meta.file_url = msg.fileUrl;
      meta.file_name = msg.fileName || "";
    }

    emitChannelMessage({
      sender: msg.fromUser,
      chatType: msg.chatType,
      msgType: msg.msgType,
      content,
      msgId: msg.msgId,
      extraMeta: meta,
    }).catch((err) => log(`Failed to emit channel message: ${err}`));

    // Return initial stream response
    const responseBody = crypto.buildStreamResponse(
      streamId,
      "正在思考...",
      false,
      timestamp,
      nonce,
    );
    return new Response(responseBody, {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (result.type === "event") {
    log(`Received event: ${JSON.stringify(result.event)}`);
    return new Response("ok", { status: 200 });
  }

  return new Response("ok", { status: 200 });
}

// ---------------------------------------------------------------------------
// Agent callback (XML)
// ---------------------------------------------------------------------------

async function handleAgentCallback(
  body: string,
  signature: string,
  timestamp: string,
  nonce: string,
): Promise<Response> {
  const result = handleAgentMessage(
    { token: config.token, encodingAESKey: config.encodingAesKey, corpId: config.corpId! },
    { signature, timestamp, nonce },
    body,
    deduplicator,
  );

  // Always respond immediately for Agent mode
  const successResponse = new Response("success", {
    headers: { "Content-Type": "text/plain" },
  });

  if (!result) {
    return successResponse;
  }

  if (result.type === "duplicate") {
    return successResponse;
  }

  if (result.type === "message") {
    const msg = result.message!;

    // Access control check
    if (!isUserAllowed(msg.senderId)) {
      // Check if this is a pairing attempt
      const pairingState = getPairingState();
      if (pairingState.hasPendingPairing && msg.text) {
        const paired = attemptPairing(msg.senderId, msg.text.trim());
        if (paired) {
          log(`User ${msg.senderId} paired successfully`);
          // Send confirmation via Agent API (async, don't block response)
          if (config.corpId && config.corpSecret && config.agentId) {
            agentSendText({
              agent: { corpId: config.corpId, corpSecret: config.corpSecret, agentId: config.agentId },
              toUser: msg.senderId,
              text: "✅ 配对成功！你现在可以与 Claude Code 对话了。",
            }).catch((err) => log(`Pairing confirmation send failed: ${err}`));
          }
          return successResponse;
        }
      }
      log("Access denied", "warn", { senderId: msg.senderId });
      // Send rejection via Agent API (async)
      if (config.corpId && config.corpSecret && config.agentId) {
        agentSendText({
          agent: { corpId: config.corpId, corpSecret: config.corpSecret, agentId: config.agentId },
          toUser: msg.senderId,
          text: "⚠️ 无权限。请让开发者在 Claude Code 中输入「wecom 配对码」生成配对码，然后将配对码发送到此对话即可完成授权。",
        }).catch((err) => log(`Access denied reply failed: ${err}`));
      }
      return successResponse;
    }

    // Permission reply intercept
    if (msg.text && PERMISSION_REPLY_RE.test(msg.text.trim())) {
      const agentCreds = config.corpId && config.corpSecret && config.agentId
        ? { corpId: config.corpId, corpSecret: config.corpSecret, agentId: config.agentId }
        : null;
      handlePermissionReply(
        msg.text,
        msg.senderId,
        async (confirmText) => {
          if (agentCreds) {
            await agentSendText({ agent: agentCreds, toUser: msg.senderId, text: confirmText });
          }
        },
      ).catch((err) => log(`Permission reply handling failed: ${err}`, "error"));
      return successResponse;
    }

    // Store pending message for reply
    const pendingKey = `${msg.senderId}:${msg.msgId}`;
    pendingMessages.set(pendingKey, {
      fromUser: msg.senderId,
      chatType: msg.isGroupChat ? "group" : "single",
      chatId: msg.chatId,
      responseUrl: "",
      streamId: "",
      timestamp: Date.now(),
    });

    // Emit to Claude Code
    const agentContent = msg.text || (msg.mediaId ? `[${msg.mediaType}: media_id=${msg.mediaId}]` : "[消息]");
    const agentMeta: Record<string, string> = {
      sender: msg.senderId,
      chat_type: msg.isGroupChat ? "group" : "single",
      msg_type: msg.mediaType || "text",
      msg_id: msg.msgId,
    };
    if (msg.mediaId) {
      agentMeta.media_id = msg.mediaId;
      agentMeta.media_type = msg.mediaType || "";
    }
    emitChannelMessage({
      sender: msg.senderId,
      chatType: msg.isGroupChat ? "group" : "single",
      msgType: msg.mediaType || "text",
      content: agentContent,
      msgId: msg.msgId,
      extraMeta: agentMeta,
    }).catch((err) => log(`Failed to emit channel message: ${err}`));
  }

  return successResponse;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let httpServer: ReturnType<typeof Bun.serve> | null = null;

async function main() {
  log("Starting WeCom Channel Plugin", "info", { mode: config.mode, port: config.callbackPort });

  // Start HTTP callback server
  try {
    httpServer = startHttpServer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Warning: Could not start HTTP server on port ${config.callbackPort}: ${message}`, "warn");
  }

  // Register permission request notification handler
  mcp.setNotificationHandler(
    z.object({
      method: z.literal("notifications/claude/channel/permission_request"),
      params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
      }),
    }),
    async ({ params }) => {
      const { request_id, tool_name, description, input_preview } = params;
      log("Permission request received", "info", { request_id, tool_name });

      const perm: PendingPermission = {
        requestId: request_id,
        toolName: tool_name,
        description,
        inputPreview: input_preview,
        timestamp: Date.now(),
      };
      pendingPermissions.set(request_id, perm);
      await sendPermissionRequest(perm);
    },
  );

  // Connect MCP server over stdio
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  log("MCP server connected — WeCom channel is live");
}

// Graceful shutdown
function shutdown(signal: string) {
  log(`Received ${signal}, shutting down`, "info");
  if (httpServer) {
    httpServer.stop();
    log("HTTP server stopped", "info");
  }
  streamManager.destroy();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  log(`Fatal error: ${err}`, "error");
  process.exit(1);
});
