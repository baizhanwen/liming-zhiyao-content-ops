import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export const customerDocuments = ["docs/产品使用手册.html", "docs/产品使用手册.md", "docs/operations/备份恢复与升级操作.md", "docs/电商素材使用说明.md"];

/** Validate the reviewed offline documents, without copying internal reports. */
export function verifyDeliveryDocumentation(packageRoot, sourceRoot) {
  const root = path.resolve(packageRoot);
  for (const document of customerDocuments) {
    assert.deepEqual(readFileSync(path.join(root, document)), readFileSync(path.join(sourceRoot, document)), `Customer documentation missing or changed: ${document}`);
  }
  const html = readFileSync(path.join(root, customerDocuments[0]), "utf8");
  assert.match(html, /<meta\s+charset="utf-8"/i, "Offline manual needs UTF-8");
  assert.doesNotMatch(html, /url\s*\(|@import\b/i, "Offline manual must not load CSS resources");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  let anchors = 0, linkedFiles = 0;
  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const reference = decodeURIComponent(match[1]);
    if (reference.startsWith("#")) {
      assert.ok(ids.has(reference.slice(1)), `Broken manual anchor: ${reference}`); anchors += 1;
    } else {
      assert.ok(reference && !/^[a-z][a-z\d+.-]*:|^[\\/]/i.test(reference), `Manual must use local links: ${reference}`);
      const target = path.resolve(root, "docs", reference);
      const relative = path.relative(root, target);
      assert.ok(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative), `Manual link escapes delivery: ${reference}`);
      assert.ok(statSync(target).isFile(), `Missing manual resource: ${reference}`); linkedFiles += 1;
    }
  }
  assert.ok(anchors >= 16 && linkedFiles >= customerDocuments.length - 1, "Manual needs its navigation and linked customer guides");
  const guide = readFileSync(path.join(root, "DELIVERY-GUIDE.txt"), "utf8");
  assert.ok(guide.includes("docs\\产品使用手册.html") && guide.includes("docs\\operations\\备份恢复与升级操作.md"), "Installation guide must locate the offline documents");
  return { documents: customerDocuments.length, anchors, linkedFiles };
}
