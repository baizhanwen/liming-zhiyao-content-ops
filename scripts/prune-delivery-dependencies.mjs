import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [packageRoot, includeVideo, includeWechat, includeInsights] = process.argv.slice(2);
if (!packageRoot) throw new Error("Package root is required.");

const packagePath = path.join(packageRoot, "package.json");
const lockPath = path.join(packageRoot, "package-lock.json");
const [packageJson, packageLock] = await Promise.all([
  readFile(packagePath, "utf8").then(JSON.parse),
  readFile(lockPath, "utf8").then(JSON.parse),
]);

for (const script of ["typecheck", "test", "lint", "db:generate"]) {
  delete packageJson.scripts?.[script];
}

function removeDependency(name, development = false) {
  const group = development ? "devDependencies" : "dependencies";
  delete packageJson[group]?.[name];
  delete packageLock.packages?.[""]?.[group]?.[name];
}

if (includeWechat !== "true") {
  removeDependency("html-to-image");
  delete packageLock.packages?.["node_modules/html-to-image"];
}

if (includeVideo !== "true") {
  removeDependency("fflate");
}

if (includeInsights !== "true") {
  removeDependency("echarts");
  removeDependency("papaparse");
  removeDependency("@types/papaparse", true);
  for (const name of [
    "node_modules/@types/papaparse",
    "node_modules/echarts",
    "node_modules/echarts/node_modules/tslib",
    "node_modules/papaparse",
    "node_modules/zrender",
    "node_modules/zrender/node_modules/tslib",
  ]) delete packageLock.packages?.[name];
}

await Promise.all([
  writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8"),
  writeFile(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`, "utf8"),
]);
