// Copies each speech package (hearing models, voices, support models) into the registry's blob store, so Misty
// downloads every model from registry.mistysys.com. A package's blob is named by the sha256 the entry already pins, so
// each is uploaded once and never replaced; build.ts adds it as the package's `mirror` and keeps `url` as where it
// came from (Misty still names a single-file model after `url`). Nothing is copied that doesn't match its pin.
//   node scripts/mirror_speech.ts
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { r2Head, r2Put } from "./r2.ts";
import { blobUrl } from "./blobs.ts";

const root = new URL("../", import.meta.url);
const work = new URL("work/speech-mirror/", root);
const record = new URL("work/speech_mirrors.json", root);

const kept: Record<string, string> = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")).mirrors ?? {} : {};
const packages = new Map<string, { url: string; size: number; ids: string[] }>();
for (const group of ["hearing", "support"]) {
  const folder = new URL(`speech/${group}/`, root);
  for (const name of readdirSync(folder).filter((one) => one.endsWith(".json")).sort()) {
    const entry = JSON.parse(readFileSync(new URL(name, folder), "utf8"));
    const pkg = entry.package;
    const known = packages.get(pkg.sha256);
    if (known) known.ids.push(entry.id);
    else packages.set(pkg.sha256, { url: pkg.url, size: pkg.size, ids: [entry.id] });
  }
}

async function fetchVerified(sha: string, url: string, size: number) {
  mkdirSync(work, { recursive: true });
  const file = new URL(sha, work);
  if (existsSync(file) && statSync(file).size === size) return file;
  const partial = new URL(`${sha}.partial`, work);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
  const hash = createHash("sha256");
  const body = Readable.fromWeb(response.body as never);
  body.on("data", (chunk) => hash.update(chunk));
  await pipeline(body, createWriteStream(partial));
  const got = hash.digest("hex");
  if (got !== sha || statSync(partial).size !== size) {
    rmSync(partial, { force: true });
    throw new Error(`${url} isn't the pinned file (${got})`);
  }
  renameSync(partial, file);
  return file;
}

let failed = false;
for (const [sha, { url, size, ids }] of packages) {
  const label = ids.join(", ");
  if (kept[sha]) continue;
  try {
    if (!(await r2Head(`blobs/${sha}`))) {
      const file = await fetchVerified(sha, url, size);
      await r2Put(`blobs/${sha}`, file.pathname, "application/octet-stream", "public, max-age=31536000, immutable");
      rmSync(file, { force: true });
      console.log(`${label}: uploaded ${(size / 1e6).toFixed(0)} MB`);
    } else console.log(`${label}: hosted`);
    kept[sha] = blobUrl(sha);
  } catch (error) {
    failed = true;
    console.error(`${label}: ${error instanceof Error ? error.message : error}`);
  }
}
writeFileSync(record, `${JSON.stringify({ schema: 1, mirrors: kept }, null, 2)}\n`);
if (failed) process.exitCode = 1;
