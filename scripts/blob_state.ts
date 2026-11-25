// What the blob steps made last time (which bundle each listing has, each copied picture, each mirrored speech
// model) is kept on the registry's bucket under `state/` as well as in the workflow's cache, so a run
// that finds the cache empty (a new cache, an evicted one, another machine) starts from it instead of bundling every
// source again. `restore` fetches each file that isn't here; `keep` uploads each one that is.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { r2Get, r2Put } from "./r2.ts";

const root = new URL("../", import.meta.url);
export const STATE_FILES = ["bundles.json", "images.json", "speech_mirrors.json"];

export async function restore() {
  mkdirSync(new URL("work/", root), { recursive: true });
  for (const name of STATE_FILES) {
    const local = new URL(`work/${name}`, root);
    if (existsSync(local)) {
      console.log(`work/${name}: kept from the cache`);
      continue;
    }
    const body = await r2Get(`state/${name}`);
    if (!body) {
      console.log(`work/${name}: none yet`);
      continue;
    }
    JSON.parse(body.toString("utf8"));
    writeFileSync(local, body);
    console.log(`work/${name}: restored from the bucket`);
  }
}

export async function keep() {
  for (const name of STATE_FILES) {
    const local = new URL(`work/${name}`, root);
    if (!existsSync(local)) continue;
    await r2Put(`state/${name}`, local.pathname, "application/json", "no-store");
    console.log(`state/${name}: kept on the bucket`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const step = process.argv[2];
  if (step === "restore") await restore();
  else if (step === "keep") await keep();
  else {
    console.error("usage: node scripts/blob_state.ts restore|keep");
    process.exit(1);
  }
}
