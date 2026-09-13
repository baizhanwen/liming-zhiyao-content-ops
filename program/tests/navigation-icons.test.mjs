import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("navigation uses a consistent component icon system", async () => {
  const [shell, styles, manifest] = await Promise.all([
    readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(manifest, /"lucide-react"/);
  assert.match(shell, /from "lucide-react"/);
  assert.match(shell, /<Icon className="nav-icon"/);
  assert.doesNotMatch(shell, /icon: "[^"]+"/);
  assert.match(styles, /\.nav-icon \{[^}]+stroke-width: 1\.7/);
  assert.match(styles, /\.nav-item\.active \.nav-icon/);
});
