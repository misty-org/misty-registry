// Gathers the entries into speech.json, engines.json and ignore.json, and everything into registry.json: the document
// publish.mjs signs for every Misty, and the copy a Misty release carries for its first run.
//   node scripts/build.mjs          writes them
//   node scripts/build.mjs --check  fails when they are out of date
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const entries = (folder) =>
  readdirSync(new URL(`${folder}/`, root))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(new URL(`${folder}/${name}`, root), "utf8")));

export function built() {
  const speech = {
    schema: 1,
    hearing: entries("speech/hearing"),
    voices: entries("speech/voices"),
    support: entries("speech/support"),
  };
  const engines = { schema: 1, engines: entries("engines") };
  const ignore = { schema: 1, templates: entries("ignore") };
  const apps = JSON.parse(readFileSync(new URL("apps.json", root), "utf8"));
  const registry = { schema: 1, apps, engines, speech, ignore };
  return {
    "speech.json": `${JSON.stringify(speech, null, 2)}\n`,
    "engines.json": `${JSON.stringify(engines, null, 2)}\n`,
    "ignore.json": `${JSON.stringify(ignore, null, 2)}\n`,
    "registry.json": `${JSON.stringify(registry, null, 2)}\n`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  let stale = false;
  for (const [name, text] of Object.entries(built())) {
    const path = new URL(name, root);
    if (check) {
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {}
      if (current !== text) {
        console.error(`${name} is out of date: run npm run build`);
        stale = true;
      }
    } else {
      writeFileSync(path, text);
      console.log(`${name} written`);
    }
  }
  if (stale) process.exit(1);
}
