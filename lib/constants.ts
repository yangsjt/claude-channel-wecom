/**
 * Constants for WeCom Channel Plugin.
 */

// Crypto
export const AES_BLOCK_SIZE = 32;
export const AES_KEY_LENGTH = 43;

// HTTP Callback
export const CALLBACK_TIMESTAMP_TOLERANCE_S = 300;
export const CALLBACK_MAX_BODY_BYTES = 1 * 1024 * 1024;

// Text limits
export const TEXT_CHUNK_LIMIT = 4000;
export const AGENT_TEXT_BYTE_LIMIT = 2000;

// Timeouts
export const AGENT_API_REQUEST_TIMEOUT_MS = 15_000;
export const TOKEN_REFRESH_BUFFER_MS = 60_000;
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;

// Stream
export const STREAM_MAX_LIFETIME_MS = 5 * 60 * 1000;
export const STREAM_CLEANUP_INTERVAL_MS = 60_000;

// Media
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_MAX_BYTES = 20 * 1024 * 1024;

// API Endpoints
const DEFAULT_API_BASE = "https://qyapi.weixin.qq.com";

function resolveApiBase(): string {
  const env = (process.env.WECOM_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return env || DEFAULT_API_BASE;
}

export const AGENT_API_ENDPOINTS = {
  get GET_TOKEN() {
    return `${resolveApiBase()}/cgi-bin/gettoken`;
  },
  get SEND_MESSAGE() {
    return `${resolveApiBase()}/cgi-bin/message/send`;
  },
  get SEND_APPCHAT() {
    return `${resolveApiBase()}/cgi-bin/appchat/send`;
  },
  get UPLOAD_MEDIA() {
    return `${resolveApiBase()}/cgi-bin/media/upload`;
  },
  get DOWNLOAD_MEDIA() {
    return `${resolveApiBase()}/cgi-bin/media/get`;
  },
};
