import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export const scriptPolicy = JSON.parse(readFileSync(new URL("../resources/delivery/runtime-scripts.json", import.meta.url), "utf8"));
assert.equal(scriptPolicy.version, 1, "Unsupported runtime script policy");
const names = [...scriptPolicy.common, ...scriptPolicy.videoAnalysis];
assert.equal(new Set(names).size, names.length, "Duplicate approved script");
assert.ok(names.every(name => /^[a-z0-9][a-z0-9_-]*\.(ps1|mjs|py)$/.test(name)), "Invalid approved script name");

export function expectedDeliveryScripts(features) {
  return [...scriptPolicy.common, ...(features.videoAnalysis ? scriptPolicy.videoAnalysis : [])].map(name => "scripts/" + name).sort();
}

export function verifyDeliveryScripts(files, features) {
  const actual = files.filter(file => /^scripts\//i.test(file)).sort();
  assert.deepEqual(actual, expectedDeliveryScripts(features), "Customer scripts differ from the approved runtime inventory");
  return { approvedScripts: actual.length };
}
