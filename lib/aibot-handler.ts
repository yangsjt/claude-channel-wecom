/**
 * AI Bot (智能机器人) message handler.
 *
 * Parses JSON-format messages from WeCom AI Bot URL callback.
 * Ported from pre-v2.0 webhook.js (WecomWebhook class).
 */

import type { WecomCrypto } from "./crypto.js";
import type { MessageDeduplicator } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiBotMessage {
  msgId: string;
  msgType: string;
  content: string;
  fromUser: string;
  chatType: string;
  chatId: string;
  aibotId: string;
  responseUrl: string;
  imageUrls?: string[];
  fileUrl?: string;
  fileName?: string;
  quote?: {
    msgType: string;
    content: string;
  };
}

export type AiBotMessageResult =
  | { type: "message"; message: AiBotMessage }
  | { type: "stream"; streamId: string }
  | { type: "event"; event: unknown }
  | { type: "duplicate" };

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleAiBotMessage(
  crypto: WecomCrypto,
  query: { signature: string; timestamp: string; nonce: string },
  body: string,
  deduplicator: MessageDeduplicator,
): AiBotMessageResult | null {
  const { signature, timestamp, nonce } = query;

  // 1. Parse JSON body to get encrypt field
  let encrypt: string;
  try {
    const jsonBody = JSON.parse(body);
    encrypt = jsonBody.encrypt;
  } catch {
    return null;
  }

  if (!encrypt) return null;

  // 2. Verify signature
  if (!crypto.verifySignature(timestamp, nonce, encrypt, signature)) {
    return null;
  }

  // 3. Decrypt
  let decryptedContent: string;
  try {
    const result = crypto.decrypt(encrypt);
    decryptedContent = result.message;
  } catch {
    return null;
  }

  // 4. Parse decrypted JSON
  let data: Record<string, any>;
  try {
    data = JSON.parse(decryptedContent);
  } catch {
    return null;
  }

  // 5. Process based on message type
  const msgtype = data.msgtype;

  if (msgtype === "stream") {
    // Stream continuation request from WeCom
    return { type: "stream", streamId: data.stream?.id ?? "" };
  }

  if (msgtype === "event") {
    return { type: "event", event: data.event };
  }

  if (msgtype === "text") {
    return handleTextMessage(data, deduplicator);
  }

  if (msgtype === "image") {
    return handleImageMessage(data, deduplicator);
  }

  if (msgtype === "voice") {
    return handleVoiceMessage(data, deduplicator);
  }

  if (msgtype === "mixed") {
    return handleMixedMessage(data, deduplicator);
  }

  if (msgtype === "file") {
    return handleFileMessage(data, deduplicator);
  }

  if (msgtype === "location") {
    return handleLocationMessage(data, deduplicator);
  }

  if (msgtype === "link") {
    return handleLinkMessage(data, deduplicator);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Message type handlers
// ---------------------------------------------------------------------------

function extractCommon(data: Record<string, any>) {
  return {
    msgId: data.msgid || `msg_${Date.now()}`,
    fromUser: data.from?.userid || "",
    responseUrl: data.response_url || "",
    chatType: data.chattype || "single",
    chatId: data.chatid || "",
    aibotId: data.aibotid || "",
  };
}

function handleTextMessage(
  data: Record<string, any>,
  dedup: MessageDeduplicator,
): AiBotMessageResult | null {
  const common = extractCommon(data);
  if (dedup.isDuplicate(common.msgId)) return { type: "duplicate" };

  const quote = data.quote
    ? {
        msgType: data.quote.msgtype ?? "",
        content: data.quote.text?.content || data.quote.image?.url || "",
      }
    : undefined;

  return {
    type: "message",
    message: {
      ...common,
      msgType: "text",
      content: data.text?.content || "",
      quote,
    },
  };
}

function handleImageMessage(
  data: Record<string, any>,
  dedup: MessageDeduplicator,
): AiBotMessageResult | null {
  const common = extractCommon(data);
  if (dedup.isDuplicate(common.msgId)) return { type: "duplicate" };

  return {
    type: "message",
    message: {
      ...common,
      msgType: "image",
      content: "",
      imageUrls: data.image?.url ? [data.image.url] : [],
    },
  };
}

function handleVoiceMessage(
  data: Record<string, any>,
  dedup: MessageDeduplicator,
): AiBotMessageResult | null {
  const common = extractCommon(data);
  if (dedup.isDuplicate(common.msgId)) return { type: "duplicate" };

  const content = data.voice?.content || "";
  if (!content.trim()) return null;

  // Treat voice as text (WeCom auto-transcribes)
  return {
    type: "message",
    message: {
      ...common,
      msgType: "text",
      content,
    },
  };
}

function handleMixedMessage(
  data: Record<string, any>,
  dedup: MessageDeduplicator,
): AiBotMessageResult | null {
  const common = extractCommon(data);
  if (dedup.isDuplicate(common.msgId)) return { type: "duplicate" };

  const msgItems: Array<Record<string, any>> = data.mixed?.msg_item || [];
  const textParts: string[] = [];
  const imageUrls: string[] = [];

  for (const item of msgItems) {
    if (item.msgtype === "text" && item.text?.content) {
      textParts.push(item.text.content);
    } else if (item.msgtype === "image" && item.image?.url) {
      imageUrls.push(item.image.url);
    }
  }

  return {
    type: "message",
    message: {
      ...common,
      msgType: "mixed",
      content: textParts.join("\n"),
      imageUrls,
    },
  };
}

function handleFileMessage(
  data: Record<string, any>,
  dedup: MessageDeduplicator,
): AiBotMessageResult | null {
  const common = extractCommon(data);
  if (dedup.isDuplicate(common.msgId)) return { type: "duplicate" };

  return {
    type: "message",
    message: {
      ...common,
      msgType: "file",
      content: "",
      fileUrl: data.file?.url || "",
      fileName: data.file?.name || data.file?.filename || "",
    },
  };
}

function handleLocationMessage(
  data: Record<string, any>,
  dedup: MessageDeduplicator,
): AiBotMessageResult | null {
  const common = extractCommon(data);
  if (dedup.isDuplicate(common.msgId)) return { type: "duplicate" };

  const lat = data.location?.latitude || "";
  const lng = data.location?.longitude || "";
  const name = data.location?.name || data.location?.label || "";
  const content = name
    ? `[位置] ${name} (${lat}, ${lng})`
    : `[位置] ${lat}, ${lng}`;

  return {
    type: "message",
    message: {
      ...common,
      msgType: "text",
      content,
    },
  };
}

function handleLinkMessage(
  data: Record<string, any>,
  dedup: MessageDeduplicator,
): AiBotMessageResult | null {
  const common = extractCommon(data);
  if (dedup.isDuplicate(common.msgId)) return { type: "duplicate" };

  const title = data.link?.title || "";
  const description = data.link?.description || "";
  const url = data.link?.url || "";

  const parts: string[] = [];
  if (title) parts.push(`[链接] ${title}`);
  if (description) parts.push(description);
  if (url) parts.push(url);
  const content = parts.join("\n") || "[链接]";

  return {
    type: "message",
    message: {
      ...common,
      msgType: "text",
      content,
    },
  };
}
