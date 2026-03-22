/**
 * Agent (自建应用) message handler.
 *
 * Parses XML-format messages from WeCom self-built app URL callback.
 * Ported from v2.1+ wecom/callback-inbound.js.
 */

import {
  verifyCallbackSignature,
  decryptCallbackMessage,
} from "./crypto.js";
import type { MessageDeduplicator } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentMessage {
  msgId: string;
  senderId: string;
  chatId: string;
  isGroupChat: boolean;
  text: string | null;
  mediaId: string | null;
  mediaType: string | null;
  voiceRecognition: string | null;
}

export type AgentMessageResult =
  | { type: "message"; message: AgentMessage }
  | { type: "duplicate" };

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/**
 * Extract a CDATA or plain element value from WeCom XML.
 */
function extractXmlValue(xml: string, tag: string): string | null {
  const cdata = xml.match(
    new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`),
  );
  if (cdata) return cdata[1];
  const plain = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return plain ? plain[1] ?? null : null;
}

/**
 * Parse a decrypted WeCom callback XML message into a normalised structure.
 * Returns null for event frames (enter_chat, subscribe, etc.).
 */
export function parseCallbackMessageXml(xml: string): AgentMessage | null {
  const msgType = extractXmlValue(xml, "MsgType");

  // Events are not user messages
  if (!msgType || msgType === "event") return null;

  const msgId = extractXmlValue(xml, "MsgId") ?? String(Date.now());
  const senderId = extractXmlValue(xml, "FromUserName") ?? "";
  if (!senderId) return null;

  // Self-built app basic callback: no group chat support
  const isGroupChat = false;
  const chatId = senderId;

  let text: string | null = null;
  let mediaId: string | null = null;
  let mediaType: string | null = null;
  let voiceRecognition: string | null = null;

  if (msgType === "text") {
    text = extractXmlValue(xml, "Content") ?? "";
  } else if (msgType === "image") {
    mediaId = extractXmlValue(xml, "MediaId");
    mediaType = "image";
  } else if (msgType === "voice") {
    mediaId = extractXmlValue(xml, "MediaId");
    mediaType = "voice";
    voiceRecognition = extractXmlValue(xml, "Recognition");
    text = voiceRecognition || null;
  } else if (msgType === "file") {
    mediaId = extractXmlValue(xml, "MediaId");
    mediaType = "file";
  } else if (msgType === "video") {
    mediaId = extractXmlValue(xml, "MediaId");
    mediaType = "file"; // treat video as generic file
  } else {
    return null;
  }

  return {
    msgId,
    senderId,
    chatId,
    isGroupChat,
    text,
    mediaId,
    mediaType,
    voiceRecognition,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleAgentMessage(
  credentials: { token: string; encodingAESKey: string; corpId: string },
  query: { signature: string; timestamp: string; nonce: string },
  body: string,
  deduplicator: MessageDeduplicator,
): AgentMessageResult | null {
  const { signature, timestamp, nonce } = query;

  // Extract encrypted payload from outer XML
  const encryptMatch = body.match(
    /<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/,
  );
  const msgEncrypt = encryptMatch?.[1];
  if (!msgEncrypt) return null;

  // Verify signature
  if (
    !verifyCallbackSignature({
      token: credentials.token,
      timestamp,
      nonce,
      msgEncrypt,
      signature,
    })
  ) {
    return null;
  }

  // Decrypt
  let decryptedXml: string;
  let callbackCorpId: string;
  try {
    const result = decryptCallbackMessage({
      encodingAESKey: credentials.encodingAESKey,
      encrypted: msgEncrypt,
    });
    decryptedXml = result.xml;
    callbackCorpId = result.corpId;
  } catch {
    return null;
  }

  // CorpId integrity check
  if (callbackCorpId !== credentials.corpId) {
    return null;
  }

  // Parse XML message
  const parsedMsg = parseCallbackMessageXml(decryptedXml);
  if (!parsedMsg) return null;

  // Deduplication
  if (deduplicator.isDuplicate(`agent:${parsedMsg.msgId}`)) {
    return { type: "duplicate" };
  }

  return { type: "message", message: parsedMsg };
}
