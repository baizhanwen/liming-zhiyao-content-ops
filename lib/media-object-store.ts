export type MediaObjectSource = "primary" | "legacy";

export type LocatedMediaObject = {
  object: R2ObjectBody;
  source: MediaObjectSource;
};

export type MediaMigrationStatus =
  | "already_primary"
  | "would_copy"
  | "copied"
  | "legacy_unavailable"
  | "missing"
  | "too_large"
  | "primary_size_mismatch"
  | "legacy_size_mismatch"
  | "legacy_hash_mismatch"
  | "copy_failed"
  | "copy_verification_failed";

export type MediaMigrationResult = {
  key: string;
  status: MediaMigrationStatus;
  sourceSize: number | null;
  expectedSize: number | null;
  expectedSha256: string | null;
  actualSha256: string | null;
  message: string;
};

function normalizedHash(value: string | null | undefined) {
  const result = value?.trim().toLowerCase() ?? "";
  return /^[a-f0-9]{64}$/.test(result) ? result : null;
}

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function locateMediaObject(
  primary: R2Bucket,
  legacy: R2Bucket | null,
  key: string,
  options?: R2GetOptions,
): Promise<LocatedMediaObject | null> {
  const primaryObject = await primary.get(key, options);
  if (primaryObject) return { object: primaryObject, source: "primary" };
  if (!legacy) return null;
  const legacyObject = await legacy.get(key, options);
  return legacyObject ? { object: legacyObject, source: "legacy" } : null;
}

export async function migrateMediaObjectToPrimary(input: {
  primary: R2Bucket;
  legacy: R2Bucket | null;
  key: string;
  dryRun: boolean;
  expectedSize?: number | null;
  expectedSha256?: string | null;
  maximumBytes?: number;
}): Promise<MediaMigrationResult> {
  const expectedSize = Number.isSafeInteger(input.expectedSize) && Number(input.expectedSize) >= 0
    ? Number(input.expectedSize)
    : null;
  const expectedSha256 = normalizedHash(input.expectedSha256);
  const maximumBytes = Math.max(1, input.maximumBytes ?? 16 * 1024 * 1024);
  const result = (
    status: MediaMigrationStatus,
    message: string,
    sourceSize: number | null = null,
    actualSha256: string | null = null,
  ): MediaMigrationResult => ({
    key: input.key,
    status,
    sourceSize,
    expectedSize,
    expectedSha256,
    actualSha256,
    message,
  });

  const primaryObject = await input.primary.head(input.key);
  if (primaryObject) {
    if (expectedSize !== null && primaryObject.size !== expectedSize) {
      return result("primary_size_mismatch", "主桶对象存在，但大小与数据库记录不一致。", primaryObject.size);
    }
    return result("already_primary", "对象已经位于主桶，无需复制。", primaryObject.size);
  }
  if (!input.legacy) return result("legacy_unavailable", "主桶缺少对象，且历史桶未绑定。");

  const legacyObject = await input.legacy.get(input.key);
  if (!legacyObject) return result("missing", "主桶与历史桶都不存在该对象。");
  if (expectedSize !== null && legacyObject.size !== expectedSize) {
    return result("legacy_size_mismatch", "历史桶对象大小与数据库记录不一致。", legacyObject.size);
  }
  if (legacyObject.size > maximumBytes) {
    return result("too_large", "对象超过单次安全迁移上限 " + maximumBytes + " 字节。", legacyObject.size);
  }

  const bytes = await legacyObject.arrayBuffer();
  const actualSha256 = expectedSha256 ? await sha256Hex(bytes) : null;
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    return result("legacy_hash_mismatch", "历史桶对象哈希与数据库记录不一致。", legacyObject.size, actualSha256);
  }
  if (input.dryRun) return result("would_copy", "试跑校验通过；正式执行时会复制到主桶。", legacyObject.size, actualSha256);

  const copied = await input.primary.put(input.key, bytes, {
    httpMetadata: legacyObject.httpMetadata,
    customMetadata: {
      ...legacyObject.customMetadata,
      migratedFrom: "legacy",
      migratedAt: new Date().toISOString(),
    },
  });
  if (!copied) return result("copy_failed", "主桶拒绝了对象写入。", legacyObject.size, actualSha256);

  const verified = await input.primary.head(input.key);
  if (!verified || verified.size !== legacyObject.size || (expectedSize !== null && verified.size !== expectedSize)) {
    return result("copy_verification_failed", "对象已写入，但复制后大小校验失败；历史对象仍保留。", verified?.size ?? null, actualSha256);
  }
  return result("copied", "对象已复制到主桶并通过大小校验；历史对象未删除。", verified.size, actualSha256);
}
