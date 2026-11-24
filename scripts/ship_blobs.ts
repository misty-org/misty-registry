// Uploads every blob in work/blobs/ that the bucket doesn't hold yet, at blobs/<sha256> with the content type it was
// made with, once and never replaced (scripts/blobs.ts). Run before the index is signed and shipped, so a Misty never
// reads a root that names a blob that isn't up. A blob the work files still name from an earlier run (kept by the
// workflow's cache) that is neither here nor in the bucket is forgotten, so the index leaves it out and the next run
// makes it again.
//   node scripts/ship_blobs.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOBS, localBlobs, sha256 } from "./blobs.ts";
import { r2List, r2Put } from "./r2.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hosted = new Set((await r2List("blobs/")).map((key) => key.slice("blobs/".length)));
const local = localBlobs();

let uploaded = 0;
let already = 0;
let failed = false;
for (const [name, type] of local) {
  if (hosted.has(name)) {
    already += 1;
    continue;
  }
  const file = join(BLOBS, name);
  try {
    if (sha256(readFileSync(file)) !== name) throw new Error("its bytes aren't the checksum it is named by");
    await r2Put(`blobs/${name}`, file, type, "public, max-age=31536000, immutable");
    hosted.add(name);
    uploaded += 1;
  } catch (error) {
    console.error(`blobs/${name}: ${(error as Error).message}`);
    failed = true;
  }
}

/** Drops each record whose blob isn't up, from one of the work files the index is built from. */
function forget(name: string, groups: (data: any) => Record<string, any>[], blobOf: (record: any) => string | undefined) {
  const path = join(root, "work", name);
  if (!existsSync(path)) return;
  const data = JSON.parse(readFileSync(path, "utf8"));
  let dropped = 0;
  for (const group of groups(data)) {
    for (const [key, record] of Object.entries(group)) {
      const blob = blobOf(record);
      if (blob && !hosted.has(blob)) {
        delete group[key];
        dropped += 1;
      }
    }
  }
  if (!dropped) return;
  writeFileSync(path, `${JSON.stringify(data)}\n`);
  console.error(`work/${name}: forgot ${dropped} blob(s) that aren't hosted; the next run makes them again`);
}

forget("bundles.json", (data) => [data.skills ?? {}, data.templates ?? {}, data.plugins ?? {}], (record) => record.bundle?.sha256);
forget("images.json", (data) => [data.images ?? {}, data.avatars ?? {}], (record) => record.sha256);
forget("samples.json", (data) => [data.voices ?? {}], (record) => record.sample?.sha256);

console.log(`blobs: ${uploaded} uploaded, ${already} of the ${local.size} made here already hosted`);
if (failed) process.exitCode = 1;
