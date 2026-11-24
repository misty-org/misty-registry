import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { referencedScripts, scriptSources } from "./files.ts";
import { pinnedApps } from "./index.ts";
import { r2Get, r2Put } from "./r2.ts";

const pins = { apps: pinnedApps() };
const sources = scriptSources();
const wanted = new Map();
for (const file of referencedScripts(pins.apps)) wanted.set(file.sha256, file);

let failed = false;
for (const [sha256, file] of wanted) {
  try {
    const source = sources.get(sha256);
    if (!source) throw new Error(`no script here has ${sha256}; run refresh for it`);
    const key = `files/${sha256}.js`;
    const hosted = await r2Get(key);
    if (hosted) {
      if (createHash("sha256").update(hosted).digest("hex") !== sha256) throw new Error(`${key} is hosted with other content`);
      console.log(`${file.id}: ${key} is hosted`);
      continue;
    }
    await r2Put(key, source, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable");
    console.log(`${file.id}: ${key} uploaded`);
  } catch (error) {
    console.error(`${file.id}: ${error.message}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
