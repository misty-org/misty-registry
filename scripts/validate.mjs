// CI: the registry is what every Misty installs from, so every entry must be complete and safe before it can land.
import { readFileSync, readdirSync } from "node:fs";
import { built } from "./build.mjs";
import { engineProblems, entryProblems, ignoreProblems, speechProblems } from "./lib.mjs";

const root = new URL("../", import.meta.url);
const pins = JSON.parse(readFileSync(new URL("apps.json", root), "utf8"));
const problems = [];
if (pins.schema !== 2) problems.push("apps.json: schema must be 2");
if (!Array.isArray(pins.apps)) problems.push("apps.json: apps must be a list");
const seen = new Set();
for (const app of pins.apps ?? []) {
  problems.push(...entryProblems(app));
  if (seen.has(app.id)) problems.push(`${app.id}: listed twice`);
  seen.add(app.id);
}
// Every app that is described here is pinned, and nothing is pinned that isn't.
// An app's own folder (`apps/<id>/`) holds its adapter; only `apps/<id>.json` describes an app.
const described = readdirSync(new URL("apps/", root))
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(/\.json$/, ""));
const awaitingHosting = (id) => {
  const config = JSON.parse(readFileSync(new URL(`apps/${id}.json`, root), "utf8"));
  if (!config.build) return false;
  try {
    readFileSync(new URL(`builds/${id}/recipe.json`, root));
    readFileSync(new URL(`builds/${id}/build.sh`, root));
    return true;
  } catch {
    problems.push(`${id}: a built app needs builds/${id}/recipe.json and build.sh`);
    return true;
  }
};
for (const id of described) {
  if (!seen.has(id) && !awaitingHosting(id)) problems.push(`${id}: described in apps/ but not pinned in apps.json`);
}
for (const id of seen) if (!described.includes(id)) problems.push(`${id}: pinned in apps.json but not described in apps/`);
// Speech models, voices and engines: each entry fit to ship, every id once, and the gathered files current.
const speechIds = new Set();
for (const group of ["hearing", "voices", "support"]) {
  for (const name of readdirSync(new URL(`speech/${group}/`, root)).filter((file) => file.endsWith(".json"))) {
    const entry = JSON.parse(readFileSync(new URL(`speech/${group}/${name}`, root), "utf8"));
    problems.push(...speechProblems(entry, group));
    if (`${entry.id}.json` !== name) problems.push(`speech/${group}/${name}: its file is named after its id`);
    if (speechIds.has(entry.id)) problems.push(`speech/${group}/${entry.id}: listed twice`);
    speechIds.add(entry.id);
  }
}
for (const name of readdirSync(new URL("engines/", root)).filter((file) => file.endsWith(".json"))) {
  const entry = JSON.parse(readFileSync(new URL(`engines/${name}`, root), "utf8"));
  problems.push(...engineProblems(entry));
  if (`${entry.id}.json` !== name) problems.push(`engines/${name}: its file is named after its id`);
}
const ignoreIds = new Set();
for (const name of readdirSync(new URL("ignore/", root)).filter((file) => file.endsWith(".json"))) {
  const entry = JSON.parse(readFileSync(new URL(`ignore/${name}`, root), "utf8"));
  problems.push(...ignoreProblems(entry));
  if (`${entry.id}.json` !== name) problems.push(`ignore/${name}: its file is named after its id`);
  if (ignoreIds.has(entry.id)) problems.push(`ignore/${entry.id}: listed twice`);
  ignoreIds.add(entry.id);
}
for (const [name, text] of Object.entries(built())) {
  let current = "";
  try {
    current = readFileSync(new URL(name, root), "utf8");
  } catch {}
  if (current !== text) problems.push(`${name}: out of date, run npm run build`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `apps.json: ${seen.size} app(s) valid; ${speechIds.size} speech model(s) and voice(s) valid; ${ignoreIds.size} ignore template(s) valid.`,
);
