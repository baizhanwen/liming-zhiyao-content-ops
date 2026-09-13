import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { locateMediaObject, migrateMediaObjectToPrimary } from "../lib/media-object-store.ts";

function record(bytes, metadata = {}) {
  const value = Uint8Array.from(bytes);
  return {
    value,
    httpMetadata: { contentType: metadata.contentType || "image/jpeg" },
    customMetadata: metadata.customMetadata || {},
  };
}

class FakeBucket {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
    this.getCalls = [];
    this.putCalls = [];
  }

  object(key, entry, withBody) {
    if (!entry) return null;
    return {
      key,
      size: entry.value.byteLength,
      httpMetadata: entry.httpMetadata,
      customMetadata: entry.customMetadata,
      ...(withBody ? {
        body: null,
        bodyUsed: false,
        arrayBuffer: async () => entry.value.slice().buffer,
        bytes: async () => entry.value.slice(),
        text: async () => new TextDecoder().decode(entry.value),
        json: async () => JSON.parse(new TextDecoder().decode(entry.value)),
        blob: async () => new Blob([entry.value]),
        writeHttpMetadata() {},
      } : {}),
    };
  }

  async head(key) {
    return this.object(key, this.entries.get(key), false);
  }

  async get(key) {
    this.getCalls.push(key);
    return this.object(key, this.entries.get(key), true);
  }

  async put(key, bytes, options = {}) {
    const value = new Uint8Array(bytes);
    this.putCalls.push(key);
    this.entries.set(key, record(value, {
      contentType: options.httpMetadata?.contentType,
      customMetadata: options.customMetadata,
    }));
    return this.object(key, this.entries.get(key), false);
  }
}

test("media lookup prefers primary and falls back to legacy only when needed", async () => {
  const primary = new FakeBucket({ "primary.jpg": record([1, 2, 3]) });
  const legacy = new FakeBucket({ "legacy.jpg": record([4, 5, 6]) });

  const first = await locateMediaObject(primary, legacy, "primary.jpg");
  assert.equal(first?.source, "primary");
  assert.deepEqual(legacy.getCalls, []);

  const second = await locateMediaObject(primary, legacy, "legacy.jpg");
  assert.equal(second?.source, "legacy");
  assert.deepEqual(legacy.getCalls, ["legacy.jpg"]);
  assert.equal(await locateMediaObject(primary, legacy, "missing.jpg"), null);
});

test("media migration is dry-run by default, copies once, and remains idempotent", async () => {
  const bytes = Buffer.from("verified-keyframe");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  const primary = new FakeBucket();
  const legacy = new FakeBucket({ "frame.jpg": record(bytes) });

  const preview = await migrateMediaObjectToPrimary({
    primary,
    legacy,
    key: "frame.jpg",
    dryRun: true,
    expectedSize: bytes.length,
    expectedSha256,
  });
  assert.equal(preview.status, "would_copy");
  assert.deepEqual(primary.putCalls, []);

  const copied = await migrateMediaObjectToPrimary({
    primary,
    legacy,
    key: "frame.jpg",
    dryRun: false,
    expectedSize: bytes.length,
    expectedSha256,
  });
  assert.equal(copied.status, "copied");
  assert.deepEqual(primary.putCalls, ["frame.jpg"]);

  const repeated = await migrateMediaObjectToPrimary({
    primary,
    legacy,
    key: "frame.jpg",
    dryRun: false,
    expectedSize: bytes.length,
    expectedSha256,
  });
  assert.equal(repeated.status, "already_primary");
  assert.deepEqual(primary.putCalls, ["frame.jpg"]);
});

test("media migration refuses a corrupt legacy object without writing", async () => {
  const primary = new FakeBucket();
  const legacy = new FakeBucket({ "frame.jpg": record(Buffer.from("wrong")) });
  const result = await migrateMediaObjectToPrimary({
    primary,
    legacy,
    key: "frame.jpg",
    dryRun: false,
    expectedSize: 5,
    expectedSha256: createHash("sha256").update("expected").digest("hex"),
  });
  assert.equal(result.status, "legacy_hash_mismatch");
  assert.deepEqual(primary.putCalls, []);
});
