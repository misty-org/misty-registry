import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT, build, pinOf, recipeIds, recipeOf, savePin, zipName } from "./build_apps.mjs";
import { r2Get, r2Put } from "./r2.mjs";

const wanted = process.argv.slice(2);
let failed = false;
for (const id of wanted.length ? wanted : recipeIds()) {
  try {
    const recipe = recipeOf(id);
    const name = zipName(id, recipe);
    const key = `apps/${name}`;
    const already = await r2Get(key);
    if (already) {
      mkdirSync(BUILT, { recursive: true });
      writeFileSync(join(BUILT, name), already);
      const pin = pinOf(id, recipe, name, already);
      savePin(pin);
      console.log(`${id}: ${name} is hosted, sha256 ${pin.sha256}`);
      continue;
    }
    const made = build(id);
    await r2Put(key, made.file, "application/zip", "public, max-age=31536000, immutable");
    const back = await r2Get(key);
    const check = back && pinOf(id, recipe, name, back);
    if (!check || check.sha256 !== made.pin.sha256) throw new Error(`${key} didn't come back as it was uploaded`);
    console.log(`${id}: ${name} built and uploaded`);
  } catch (error) {
    console.error(`${id}: ${error.message}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
