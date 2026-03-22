/**
 * Unit tests for lib/crypto.ts
 * Run: bun test tests/crypto.test.ts
 */

import { describe, test, expect } from "bun:test";
import { WecomCrypto, verifyCallbackSignature, decryptCallbackMessage } from "../lib/crypto.js";

const TEST_TOKEN = "testtoken123";
const TEST_AES_KEY = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"; // 43 chars

describe("WecomCrypto", () => {
  test("constructor validates token", () => {
    expect(() => new WecomCrypto("", TEST_AES_KEY)).toThrow("Token is required");
  });

  test("constructor validates AES key length", () => {
    expect(() => new WecomCrypto(TEST_TOKEN, "short")).toThrow("EncodingAESKey invalid");
  });

  test("constructor accepts valid params", () => {
    const crypto = new WecomCrypto(TEST_TOKEN, TEST_AES_KEY);
    expect(crypto).toBeDefined();
  });

  test("encrypt then decrypt roundtrip", () => {
    const crypto = new WecomCrypto(TEST_TOKEN, TEST_AES_KEY);
    const original = "Hello, WeCom! 你好企业微信";
    const encrypted = crypto.encrypt(original);

    expect(encrypted).not.toBe(original);
    expect(typeof encrypted).toBe("string");

    const { message } = crypto.decrypt(encrypted);
    expect(message).toBe(original);
  });

  test("encrypt produces different ciphertext each time (random IV)", () => {
    const crypto = new WecomCrypto(TEST_TOKEN, TEST_AES_KEY);
    const text = "same text";
    const a = crypto.encrypt(text);
    const b = crypto.encrypt(text);
    expect(a).not.toBe(b); // random prefix makes each encryption unique
  });

  test("getSignature produces consistent SHA1", () => {
    const crypto = new WecomCrypto(TEST_TOKEN, TEST_AES_KEY);
    const sig1 = crypto.getSignature("12345", "nonce1", "encrypt1");
    const sig2 = crypto.getSignature("12345", "nonce1", "encrypt1");
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(40); // SHA1 hex = 40 chars
  });

  test("verifySignature matches getSignature", () => {
    const crypto = new WecomCrypto(TEST_TOKEN, TEST_AES_KEY);
    const sig = crypto.getSignature("ts", "nc", "enc");
    expect(crypto.verifySignature("ts", "nc", "enc", sig)).toBe(true);
    expect(crypto.verifySignature("ts", "nc", "enc", "wrong")).toBe(false);
  });

  test("buildStreamResponse produces valid encrypted JSON", () => {
    const crypto = new WecomCrypto(TEST_TOKEN, TEST_AES_KEY);
    const response = crypto.buildStreamResponse("stream-1", "hello", true, "12345", "nonce");
    const parsed = JSON.parse(response);

    expect(parsed.encrypt).toBeDefined();
    expect(parsed.msgsignature).toBeDefined();
    expect(parsed.timestamp).toBe("12345");
    expect(parsed.nonce).toBe("nonce");

    // Decrypt and verify content
    const { message } = crypto.decrypt(parsed.encrypt);
    const inner = JSON.parse(message);
    expect(inner.msgtype).toBe("stream");
    expect(inner.stream.id).toBe("stream-1");
    expect(inner.stream.content).toBe("hello");
    expect(inner.stream.finish).toBe(true);
  });

  test("decryptMedia handles encrypted buffer", () => {
    const crypto = new WecomCrypto(TEST_TOKEN, TEST_AES_KEY);
    // Create a buffer that simulates encrypted media (must be multiple of 16 bytes)
    const original = Buffer.from("This is test media content!!");
    // Pad to 32-byte block
    const padLen = 32 - (original.length % 32);
    const padded = Buffer.concat([original, Buffer.alloc(padLen, padLen)]);

    // Encrypt with same AES key
    const { createCipheriv } = require("node:crypto");
    const key = Buffer.from(TEST_AES_KEY + "=", "base64");
    const iv = key.subarray(0, 16);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

    const decrypted = crypto.decryptMedia(encrypted);
    expect(decrypted.toString("utf8")).toBe("This is test media content!!");
  });
});

describe("Standalone helpers", () => {
  test("verifyCallbackSignature validates correctly", () => {
    const result = verifyCallbackSignature({
      token: TEST_TOKEN,
      timestamp: "12345",
      nonce: "nonce1",
      msgEncrypt: "encrypt1",
      signature: "", // will compute and compare
    });
    expect(result).toBe(false);

    // Compute correct signature
    const { createHash } = require("node:crypto");
    const sorted = [TEST_TOKEN, "12345", "nonce1", "encrypt1"].sort();
    const correctSig = createHash("sha1").update(sorted.join("")).digest("hex");

    const result2 = verifyCallbackSignature({
      token: TEST_TOKEN,
      timestamp: "12345",
      nonce: "nonce1",
      msgEncrypt: "encrypt1",
      signature: correctSig,
    });
    expect(result2).toBe(true);
  });

  test("decryptCallbackMessage roundtrip with WecomCrypto.encrypt", () => {
    const crypto = new WecomCrypto(TEST_TOKEN, TEST_AES_KEY);
    const original = "<xml><Content>hello</Content></xml>";
    const encrypted = crypto.encrypt(original);

    const { xml } = decryptCallbackMessage({
      encodingAESKey: TEST_AES_KEY,
      encrypted,
    });
    expect(xml).toBe(original);
  });
});
