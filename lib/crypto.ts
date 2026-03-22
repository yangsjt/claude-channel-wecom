/**
 * WeCom AES-256-CBC crypto implementation.
 *
 * Supports both AI Bot and Agent modes:
 * - AI Bot: encrypt + decrypt + sign (JSON messages, stream responses)
 * - Agent: decrypt + sign (XML messages, verify-only)
 *
 * Ported from:
 * - pre-v2.0 crypto.js (WecomCrypto class with encrypt)
 * - v2.1+ wecom/callback-crypto.js (verifyCallbackSignature + decryptCallbackMessage)
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { AES_BLOCK_SIZE, AES_KEY_LENGTH } from "./constants.js";

export class WecomCrypto {
  private readonly aesKey: Buffer;
  private readonly iv: Buffer;

  constructor(
    private readonly token: string,
    encodingAesKey: string,
  ) {
    if (!encodingAesKey || encodingAesKey.length !== AES_KEY_LENGTH) {
      throw new Error(
        `EncodingAESKey invalid: length must be ${AES_KEY_LENGTH}, got ${encodingAesKey?.length ?? 0}`,
      );
    }
    if (!token) {
      throw new Error("Token is required");
    }
    this.aesKey = Buffer.from(encodingAesKey + "=", "base64");
    this.iv = this.aesKey.subarray(0, 16);
  }

  /**
   * SHA1 signature for WeCom callback verification.
   * Sort [token, timestamp, nonce, encrypt] lexicographically, then SHA1.
   */
  getSignature(timestamp: string, nonce: string, encrypt: string): string {
    const sorted = [this.token, timestamp, nonce, encrypt]
      .map((v) => String(v))
      .sort();
    return createHash("sha1").update(sorted.join("")).digest("hex");
  }

  /**
   * Verify a callback signature.
   */
  verifySignature(
    timestamp: string,
    nonce: string,
    msgEncrypt: string,
    signature: string,
  ): boolean {
    return this.getSignature(timestamp, nonce, msgEncrypt) === signature;
  }

  /**
   * Decrypt AES-256-CBC encrypted message.
   *
   * Plaintext layout (after PKCS7 unpad):
   *   [16 random bytes | 4-byte msgLen (BE) | message | corpId/appId]
   *
   * For AI Bot mode, corpId is empty — skip validation.
   */
  decrypt(ciphertext: string): { message: string; corpId: string } {
    const decipher = createDecipheriv("aes-256-cbc", this.aesKey, this.iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext, "base64"),
      decipher.final(),
    ]);

    // Strip PKCS7 padding
    const padLen = decrypted[decrypted.length - 1];
    if (padLen < 1 || padLen > AES_BLOCK_SIZE) {
      throw new Error(`Invalid PKCS7 padding byte: ${padLen}`);
    }
    const content = decrypted.subarray(0, decrypted.length - padLen);

    // Strip 16-byte random prefix
    const withoutRandom = content.subarray(16);
    if (withoutRandom.length < 4) {
      throw new Error("Decrypted content too short");
    }

    const msgLen = withoutRandom.readUInt32BE(0);
    if (withoutRandom.length < 4 + msgLen) {
      throw new Error(
        `Decrypted content shorter than declared msgLen (${msgLen})`,
      );
    }

    const message = withoutRandom.subarray(4, 4 + msgLen).toString("utf8");
    const corpId = withoutRandom.subarray(4 + msgLen).toString("utf8");

    return { message, corpId };
  }

  /**
   * Encrypt a plaintext message (AI Bot mode).
   * Used for stream responses and URL verification replies.
   */
  encrypt(text: string): string {
    const random16 = randomBytes(16);
    const msgBuffer = Buffer.from(text);
    const lenBuffer = Buffer.alloc(4);
    lenBuffer.writeUInt32BE(msgBuffer.length, 0);

    const rawMsg = Buffer.concat([random16, lenBuffer, msgBuffer]);
    const encoded = this.encodePkcs7(rawMsg);

    const cipher = createCipheriv("aes-256-cbc", this.aesKey, this.iv);
    cipher.setAutoPadding(false);
    const ciphered = Buffer.concat([cipher.update(encoded), cipher.final()]);
    return ciphered.toString("base64");
  }

  /**
   * Build an encrypted stream JSON response (AI Bot mode).
   */
  buildStreamResponse(
    streamId: string,
    content: string,
    finish: boolean,
    timestamp: string,
    nonce: string,
    options: {
      thinkingContent?: string;
      msgItem?: Array<Record<string, unknown>>;
      feedbackId?: string;
    } = {},
  ): string {
    const stream: Record<string, unknown> = {
      id: streamId,
      finish,
      content,
    };

    if (options.thinkingContent) {
      stream.thinking_content = options.thinkingContent;
    }
    if (options.msgItem && options.msgItem.length > 0) {
      stream.msg_item = options.msgItem;
    }
    if (options.feedbackId) {
      stream.feedback = { id: options.feedbackId };
    }

    const plain = JSON.stringify({ msgtype: "stream", stream });
    const encrypted = this.encrypt(plain);
    const signature = this.getSignature(timestamp, nonce, encrypted);

    return JSON.stringify({
      encrypt: encrypted,
      msgsignature: signature,
      timestamp,
      nonce,
    });
  }

  /**
   * Decrypt media/file downloaded from WeCom AI Bot.
   * Files are encrypted with the same AES-256-CBC key as messages.
   * Uses PKCS7 padding with 32-byte blocks.
   */
  decryptMedia(encryptedData: Buffer): Buffer {
    const decipher = createDecipheriv("aes-256-cbc", this.aesKey, this.iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final(),
    ]);

    // Remove PKCS7 padding (32-byte blocks)
    const padLen = decrypted[decrypted.length - 1];
    if (padLen >= 1 && padLen <= 32) {
      let validPadding = true;
      for (let i = decrypted.length - padLen; i < decrypted.length; i++) {
        if (decrypted[i] !== padLen) {
          validPadding = false;
          break;
        }
      }
      if (validPadding) {
        return decrypted.subarray(0, decrypted.length - padLen);
      }
    }
    return decrypted;
  }

  private encodePkcs7(buff: Buffer): Buffer {
    const amountToPad = AES_BLOCK_SIZE - (buff.length % AES_BLOCK_SIZE);
    const pad = Buffer.alloc(amountToPad, amountToPad);
    return Buffer.concat([buff, pad]);
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers for Agent mode (stateless, no class instance needed)
// ---------------------------------------------------------------------------

/**
 * Verify a WeCom callback signature (Agent mode, stateless).
 */
export function verifyCallbackSignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  msgEncrypt: string;
  signature: string;
}): boolean {
  const items = [
    String(params.token),
    String(params.timestamp),
    String(params.nonce),
    String(params.msgEncrypt),
  ].sort();
  const digest = createHash("sha1").update(items.join("")).digest("hex");
  return digest === String(params.signature);
}

/**
 * Decrypt a WeCom AES-256-CBC message (Agent mode, stateless).
 */
export function decryptCallbackMessage(params: {
  encodingAESKey: string;
  encrypted: string;
}): { xml: string; corpId: string } {
  const key = Buffer.from(params.encodingAESKey + "=", "base64");
  const iv = key.subarray(0, 16);
  const ciphertext = Buffer.from(params.encrypted, "base64");

  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  const padLen = decrypted[decrypted.length - 1];
  if (padLen < 1 || padLen > 32) {
    throw new Error(`Invalid PKCS7 padding byte: ${padLen}`);
  }
  const content = decrypted.subarray(0, decrypted.length - padLen);

  const withoutRandom = content.subarray(16);
  if (withoutRandom.length < 4) {
    throw new Error("Decrypted content too short");
  }

  const msgLen = withoutRandom.readUInt32BE(0);
  if (withoutRandom.length < 4 + msgLen) {
    throw new Error(
      `Decrypted content shorter than declared msgLen (${msgLen})`,
    );
  }

  const xml = withoutRandom.subarray(4, 4 + msgLen).toString("utf8");
  const corpId = withoutRandom.subarray(4 + msgLen).toString("utf8");

  return { xml, corpId };
}
