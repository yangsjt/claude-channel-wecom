/**
 * Unit tests for lib/aibot-handler.ts and lib/agent-handler.ts
 * Run: bun test tests/handlers.test.ts
 */

import { describe, test, expect } from "bun:test";
import { WecomCrypto } from "../lib/crypto.js";
import { handleAiBotMessage } from "../lib/aibot-handler.js";
import { handleAgentMessage, parseCallbackMessageXml } from "../lib/agent-handler.js";
import { MessageDeduplicator } from "../lib/utils.js";

const TOKEN = "testtoken123";
const AES_KEY = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

function buildEncryptedAiBotMessage(crypto: WecomCrypto, data: Record<string, unknown>) {
  const plaintext = JSON.stringify(data);
  const encrypt = crypto.encrypt(plaintext);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "testnonce";
  const signature = crypto.getSignature(timestamp, nonce, encrypt);
  return {
    body: JSON.stringify({ encrypt }),
    query: { signature, timestamp, nonce },
  };
}

describe("handleAiBotMessage", () => {
  const crypto = new WecomCrypto(TOKEN, AES_KEY);

  test("parses text message", () => {
    const dedup = new MessageDeduplicator();
    const { body, query } = buildEncryptedAiBotMessage(crypto, {
      msgtype: "text",
      msgid: "msg001",
      text: { content: "hello world" },
      from: { userid: "user1" },
      chattype: "single",
      response_url: "https://example.com/response",
    });

    const result = handleAiBotMessage(crypto, query, body, dedup);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("message");
    if (result!.type === "message") {
      expect(result!.message!.content).toBe("hello world");
      expect(result!.message!.fromUser).toBe("user1");
      expect(result!.message!.msgType).toBe("text");
      expect(result!.message!.responseUrl).toBe("https://example.com/response");
    }
  });

  test("detects duplicate messages", () => {
    const dedup = new MessageDeduplicator();
    const { body, query } = buildEncryptedAiBotMessage(crypto, {
      msgtype: "text",
      msgid: "msg002",
      text: { content: "test" },
      from: { userid: "user1" },
    });

    const result1 = handleAiBotMessage(crypto, query, body, dedup);
    expect(result1!.type).toBe("message");

    const result2 = handleAiBotMessage(crypto, query, body, dedup);
    expect(result2!.type).toBe("duplicate");
  });

  test("parses stream refresh request", () => {
    const dedup = new MessageDeduplicator();
    const { body, query } = buildEncryptedAiBotMessage(crypto, {
      msgtype: "stream",
      stream: { id: "stream-123" },
    });

    const result = handleAiBotMessage(crypto, query, body, dedup);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("stream");
    if (result!.type === "stream") {
      expect(result!.streamId).toBe("stream-123");
    }
  });

  test("parses image message", () => {
    const dedup = new MessageDeduplicator();
    const { body, query } = buildEncryptedAiBotMessage(crypto, {
      msgtype: "image",
      msgid: "img001",
      image: { url: "https://example.com/image.jpg" },
      from: { userid: "user1" },
    });

    const result = handleAiBotMessage(crypto, query, body, dedup);
    expect(result!.type).toBe("message");
    if (result!.type === "message") {
      expect(result!.message!.msgType).toBe("image");
      expect(result!.message!.imageUrls).toEqual(["https://example.com/image.jpg"]);
    }
  });

  test("parses location message as text", () => {
    const dedup = new MessageDeduplicator();
    const { body, query } = buildEncryptedAiBotMessage(crypto, {
      msgtype: "location",
      msgid: "loc001",
      location: { latitude: "31.23", longitude: "121.47", name: "上海" },
      from: { userid: "user1" },
    });

    const result = handleAiBotMessage(crypto, query, body, dedup);
    expect(result!.type).toBe("message");
    if (result!.type === "message") {
      expect(result!.message!.content).toContain("上海");
      expect(result!.message!.content).toContain("31.23");
    }
  });

  test("rejects invalid signature", () => {
    const dedup = new MessageDeduplicator();
    const { body } = buildEncryptedAiBotMessage(crypto, {
      msgtype: "text",
      msgid: "msg003",
      text: { content: "test" },
      from: { userid: "user1" },
    });

    const result = handleAiBotMessage(
      crypto,
      { signature: "invalidsig", timestamp: "12345", nonce: "nonce" },
      body,
      dedup,
    );
    expect(result).toBeNull();
  });

  test("returns event for event messages", () => {
    const dedup = new MessageDeduplicator();
    const { body, query } = buildEncryptedAiBotMessage(crypto, {
      msgtype: "event",
      event: "subscribe",
    });

    const result = handleAiBotMessage(crypto, query, body, dedup);
    expect(result!.type).toBe("event");
  });
});

describe("parseCallbackMessageXml", () => {
  test("parses text message XML", () => {
    const xml = `<xml>
      <MsgType><![CDATA[text]]></MsgType>
      <MsgId>12345</MsgId>
      <FromUserName><![CDATA[user1]]></FromUserName>
      <Content><![CDATA[hello from agent]]></Content>
    </xml>`;

    const result = parseCallbackMessageXml(xml);
    expect(result).not.toBeNull();
    expect(result!.msgId).toBe("12345");
    expect(result!.senderId).toBe("user1");
    expect(result!.text).toBe("hello from agent");
  });

  test("parses image message XML", () => {
    const xml = `<xml>
      <MsgType><![CDATA[image]]></MsgType>
      <MsgId>12346</MsgId>
      <FromUserName><![CDATA[user2]]></FromUserName>
      <MediaId><![CDATA[media123]]></MediaId>
    </xml>`;

    const result = parseCallbackMessageXml(xml);
    expect(result!.mediaId).toBe("media123");
    expect(result!.mediaType).toBe("image");
  });

  test("parses voice with recognition", () => {
    const xml = `<xml>
      <MsgType><![CDATA[voice]]></MsgType>
      <MsgId>12347</MsgId>
      <FromUserName><![CDATA[user3]]></FromUserName>
      <MediaId><![CDATA[voice123]]></MediaId>
      <Recognition><![CDATA[你好世界]]></Recognition>
    </xml>`;

    const result = parseCallbackMessageXml(xml);
    expect(result!.text).toBe("你好世界");
    expect(result!.voiceRecognition).toBe("你好世界");
  });

  test("returns null for event messages", () => {
    const xml = `<xml><MsgType><![CDATA[event]]></MsgType></xml>`;
    expect(parseCallbackMessageXml(xml)).toBeNull();
  });

  test("returns null for missing sender", () => {
    const xml = `<xml><MsgType><![CDATA[text]]></MsgType><Content>hi</Content></xml>`;
    expect(parseCallbackMessageXml(xml)).toBeNull();
  });
});
