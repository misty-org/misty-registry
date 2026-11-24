import { pinnedApps } from "./index.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BUILDS_ORIGIN } from "./lib.ts";

const root = new URL("../", import.meta.url);
const pins = pinnedApps().filter((app) => app.built || app.source);
let bad = false;
for (const pin of pins) {
  if (!pin.url.startsWith(BUILDS_ORIGIN)) {
    console.error(`${pin.id}: pinned at ${pin.url}, not on ${BUILDS_ORIGIN}`);
    bad = true;
    continue;
  }
  const response = await fetch(pin.url, { headers: { "user-agent": "misty-registry-publish" } });
  if (!response.ok) {
    console.error(`${pin.id}: ${pin.url} answered ${response.status}; upload the zip before publishing its pin`);
    bad = true;
    continue;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== pin.sha256 || bytes.length !== pin.size) {
    console.error(`${pin.id}: the hosted zip is ${sha256} (${bytes.length} bytes), pinned ${pin.sha256} (${pin.size} bytes)`);
    bad = true;
    continue;
  }
  console.log(`${pin.id}: hosted zip matches its pin`);
}
if (bad) process.exitCode = 1;
