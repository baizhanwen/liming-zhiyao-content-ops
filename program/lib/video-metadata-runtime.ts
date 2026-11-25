import { getD1, getMediaBucket } from "../db/runtime";
import { readEffectiveTikHubKey } from "./tikhub-settings";
import { OrganizationSettingsError } from "./organization-settings-credential";
import { refreshVideoMetadata } from "./video-metadata-refresh";
import type { ProjectWriteScope } from "./project-write-access";

export async function collectVideoMetadata(scope: ProjectWriteScope & { videoId: string }) {
  let apiKey: string;
  try {
    apiKey = await readEffectiveTikHubKey(scope.organizationId);
  } catch (error) {
    if (error instanceof OrganizationSettingsError) return { status: "failed" as const, message: error.message, httpStatus: error.status };
    throw error;
  }
  return refreshVideoMetadata({ db: getD1(), bucket: getMediaBucket(), apiKey }, scope);
}
