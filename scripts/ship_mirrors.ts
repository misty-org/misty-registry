// Puts a copy of each maker's release zip in the bucket, beside the zips the registry builds, so every app is served
// from registry.mistysys.com. The copy is taken from the pin's `source` and kept only if it is the very file the pin's
// checksum names; it is uploaded once under a name made of that checksum and never replaced.
//   node scripts/ship_mirrors.ts [id...]
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILDS_ORIGIN, MAX_ZIP_BYTES } from "./lib.ts";
import { pinnedApps } from "./index.ts";
import { r2Get, r2Put } from "./r2.ts";

const pins = pinnedApps();
const wanted = process.argv.slice(2);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const folder = join(tmpdir(), "misty-registry-mirrors");
mkdirSync(folder, { recursive: true });

let failed = false;
for (const app of pins) {
  if (app.built || !app.source) continue;
  if (wanted.length && !wanted.includes(app.id)) continue;
  try {
    if (!app.url.startsWith(BUILDS_ORIGIN)) throw new Error(`${app.url} isn't on ${BUILDS_ORIGIN}`);
    const name = app.url.slice(BUILDS_ORIGIN.length);
    const key = `apps/${name}`;
    const hosted = await r2Get(key);
    if (hosted) {
      if (sha256(hosted) !== app.sha256) throw new Error(`${key} is hosted with other content`);
      console.log(`${app.id}: ${name} is hosted`);
      continue;
    }
    const response = await fetch(app.source, { headers: { "user-agent": "misty-registry-publish" }, redirect: "follow" });
    if (!response.ok) throw new Error(`${app.source} answered ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_ZIP_BYTES) throw new Error(`${app.source} is larger than a bundle may be`);
    if (sha256(bytes) !== app.sha256 || bytes.length !== app.size) {
      throw new Error(`${app.source} is ${sha256(bytes)} (${bytes.length} bytes), pinned ${app.sha256} (${app.size} bytes)`);
    }
    const file = join(folder, name);
    writeFileSync(file, bytes);
    await r2Put(key, file, "application/zip", "public, max-age=31536000, immutable");
    const back = await r2Get(key);
    if (!back || sha256(back) !== app.sha256) throw new Error(`${key} didn't come back as it was uploaded`);
    console.log(`${app.id}: ${name} mirrored from ${app.source}`);
  } catch (error) {
    console.error(`${app.id}: ${error.message}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
