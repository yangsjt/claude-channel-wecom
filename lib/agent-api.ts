/**
 * WeCom Agent API Client.
 *
 * Manages AccessToken caching and API calls for self-built applications.
 * Ported from wecom/agent-api.js, replacing wecomFetch with native fetch.
 */

import crypto from "node:crypto";
import {
  AGENT_API_ENDPOINTS,
  AGENT_API_REQUEST_TIMEOUT_MS,
  TOKEN_REFRESH_BUFFER_MS,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentCredentials {
  corpId: string;
  corpSecret: string;
  agentId: string;
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

interface TokenCache {
  token: string;
  expiresAt: number;
  refreshPromise: Promise<string> | null;
}

const tokenCaches = new Map<string, TokenCache>();

/**
 * Get a valid AccessToken, with caching and concurrent-refresh protection.
 */
export async function getAccessToken(agent: AgentCredentials): Promise<string> {
  const cacheKey = `${agent.corpId}:${agent.agentId}`;
  let cache = tokenCaches.get(cacheKey);

  if (!cache) {
    cache = { token: "", expiresAt: 0, refreshPromise: null };
    tokenCaches.set(cacheKey, cache);
  }

  const now = Date.now();
  if (cache.token && cache.expiresAt > now + TOKEN_REFRESH_BUFFER_MS) {
    return cache.token;
  }

  // Reuse in-flight refresh
  if (cache.refreshPromise) {
    return cache.refreshPromise;
  }

  cache.refreshPromise = (async () => {
    try {
      const url = `${AGENT_API_ENDPOINTS.GET_TOKEN}?corpid=${encodeURIComponent(agent.corpId)}&corpsecret=${encodeURIComponent(agent.corpSecret)}`;
      const res = await fetchWithTimeout(url);
      const json = (await res.json()) as Record<string, any>;

      if (!json?.access_token) {
        throw new Error(
          `gettoken failed: ${json?.errcode} ${json?.errmsg}`,
        );
      }

      cache!.token = json.access_token;
      cache!.expiresAt = Date.now() + (json.expires_in ?? 7200) * 1000;
      return cache!.token;
    } finally {
      cache!.refreshPromise = null;
    }
  })();

  return cache.refreshPromise;
}

// ---------------------------------------------------------------------------
// Send text message
// ---------------------------------------------------------------------------

export async function agentSendText(params: {
  agent: AgentCredentials;
  toUser?: string;
  toParty?: string;
  toTag?: string;
  chatId?: string;
  text: string;
  format?: "text" | "markdown";
}): Promise<void> {
  const { agent, toUser, toParty, toTag, chatId, text, format = "text" } = params;
  const msgtype = format === "markdown" ? "markdown" : "text";
  const token = await getAccessToken(agent);

  const useChat = Boolean(chatId);
  const url = useChat
    ? `${AGENT_API_ENDPOINTS.SEND_APPCHAT}?access_token=${encodeURIComponent(token)}`
    : `${AGENT_API_ENDPOINTS.SEND_MESSAGE}?access_token=${encodeURIComponent(token)}`;

  const body = useChat
    ? { chatid: chatId, msgtype, [msgtype]: { content: text } }
    : {
        touser: toUser,
        toparty: toParty,
        totag: toTag,
        msgtype,
        agentid: agent.agentId,
        [msgtype]: { content: text },
      };

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, any>;

  if (json?.errcode === 45009) {
    // Rate limited — retry once after 1 second
    await new Promise((r) => setTimeout(r, 1000));
    const retryRes = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const retryJson = (await retryRes.json()) as Record<string, any>;
    if (retryJson?.errcode !== 0) {
      throw new Error(
        `agent send ${msgtype} rate-limited and retry failed: ${retryJson?.errcode} ${retryJson?.errmsg}`,
      );
    }
    return;
  }

  if (json?.errcode !== 0) {
    throw new Error(
      `agent send ${msgtype} failed: ${json?.errcode} ${json?.errmsg}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Upload media
// ---------------------------------------------------------------------------

export async function agentUploadMedia(params: {
  agent: AgentCredentials;
  type: "image" | "voice" | "video" | "file";
  buffer: Buffer;
  filename: string;
}): Promise<string> {
  const { agent, type, buffer, filename } = params;
  const token = await getAccessToken(agent);
  const url = `${AGENT_API_ENDPOINTS.UPLOAD_MEDIA}?access_token=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}`;

  const boundary = `----WebKitFormBoundary${crypto.randomBytes(16).toString("hex")}`;

  const contentTypeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    bmp: "image/bmp",
    amr: "voice/amr",
    mp4: "video/mp4",
  };
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const fileContentType = contentTypeMap[ext] || "application/octet-stream";

  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="${filename}"; filelength=${buffer.length}\r\n` +
      `Content-Type: ${fileContentType}\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buffer, footer]);

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
  });
  const json = (await res.json()) as Record<string, any>;

  if (!json?.media_id) {
    throw new Error(
      `agent upload media failed: ${json?.errcode} ${json?.errmsg}`,
    );
  }
  return json.media_id;
}

// ---------------------------------------------------------------------------
// Download media
// ---------------------------------------------------------------------------

export async function agentDownloadMedia(params: {
  agent: AgentCredentials;
  mediaId: string;
}): Promise<{ buffer: Buffer; contentType: string }> {
  const { agent, mediaId } = params;
  const token = await getAccessToken(agent);
  const url = `${AGENT_API_ENDPOINTS.DOWNLOAD_MEDIA}?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`;

  const res = await fetchWithTimeout(url);

  if (!res.ok) {
    throw new Error(`agent download media failed: ${res.status}`);
  }

  const contentType =
    res.headers.get("content-type") || "application/octet-stream";

  // WeCom may return error JSON instead of binary
  if (contentType.includes("application/json")) {
    const json = (await res.json()) as Record<string, any>;
    throw new Error(
      `agent download media failed: ${json?.errcode} ${json?.errmsg}`,
    );
  }

  const arrayBuf = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuf), contentType };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    AGENT_API_REQUEST_TIMEOUT_MS,
  );
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timeoutId),
  );
}
