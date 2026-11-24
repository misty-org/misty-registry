// CI: the registry is what every Misty installs from, so every entry must be complete and safe before it can land.
import { readFileSync, readdirSync } from "node:fs";
import { built } from "./build.ts";
import { referencedScripts, scriptSources } from "./files.ts";
import { pinnedApps } from "./index.ts";
import { MOST_ROOT_BYTES, MOST_SHARD_BYTES } from "./kinds.ts";
import { engineProblems, entryProblems, mcpProblems, ignoreProblems, pluginProblems, skillProblems, sourceConfigProblems, speechProblems, templateProblems } from "./lib.ts";

const root = new URL("../", import.meta.url);
const pins = { apps: pinnedApps() };
const problems: string[] = [];
if (!Array.isArray(pins.apps)) problems.push("index.min.json: apps must be a list");
const seen = new Set();
for (const app of pins.apps ?? []) {
  problems.push(...entryProblems(app));
  if (seen.has(app.id)) problems.push(`${app.id}: listed twice`);
  seen.add(app.id);
}
const sources = scriptSources();
for (const file of referencedScripts(pins.apps ?? [])) {
  if (!sources.has(file.sha256)) problems.push(`${file.id}: no script here has the checksum its pin names; run refresh for it`);
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
  if (!seen.has(id) && !awaitingHosting(id)) problems.push(`${id}: described in apps/ but not pinned in index.min.json`);
}
for (const id of seen) if (!described.includes(id)) problems.push(`${id}: pinned in index.min.json but not described in apps/`);
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
const kinds: [string, (entry: any) => string[]][] = [
  ["plugins", pluginProblems],
  ["skills", skillProblems],
  ["templates", templateProblems],
  ["mcps", mcpProblems],
];
const counts = {};
const where = new Map();
const list = (folder) => readdirSync(new URL(`${folder}/`, root)).filter((file) => file.endsWith(".json"));
const json = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
for (const [folder, check] of kinds) {
  const ids = new Set();
  const take = (entry, label) => {
    if (ids.has(entry.id)) problems.push(`${label}: ${entry.id} is listed twice`);
    ids.add(entry.id);
    if (!entry.source) return;
    const from = `${entry.source.repo}/${entry.source.path}`;
    if (where.has(from)) problems.push(`${label}: ${from} is already listed as ${where.get(from)}`);
    where.set(from, `${folder}/${entry.id}`);
  };
  for (const name of list(folder)) {
    const entry = json(`${folder}/${name}`);
    problems.push(...check(entry));
    if (`${entry.id}.json` !== name) problems.push(`${folder}/${name}: its file is named after its id`);
    take(entry, `${folder}/${name}`);
  }
  counts[folder] = { hand: ids.size, ids };
}
// Sources: each names a repository the crawl reads at publish time, its entries pinned to the commit it read.
const sourceIds = new Set();
for (const name of list("sources")) {
  const source = json(`sources/${name}`);
  problems.push(...sourceConfigProblems(source));
  if (`${source.id}.json` !== name) problems.push(`sources/${name}: its file is named after its id`);
  sourceIds.add(source.id);
}
// The index builds, and no part of it has grown past what is read whole: a part that has is split further.
const index = built();
if (Buffer.byteLength(JSON.stringify(index.root)) > MOST_ROOT_BYTES) problems.push("index.min.json: the root is past its size; move a part into a shard");
for (const [path, text] of Object.entries(index.shards)) {
  if (Buffer.byteLength(text) > MOST_SHARD_BYTES) problems.push(`${path}: a shard is past its size; split the listing`);
}
// What the index adds from the blob steps (bundles, faces, mirrored pictures, samples) is checked as it is published.
const shard = (pointer: any) => JSON.parse(index.shards[pointer.path]);
for (const app of shard(index.root.sections.apps).data) {
  if (app.logo_source !== undefined || app.banner_source !== undefined || app.screenshots_source !== undefined) problems.push(...entryProblems(app));
}
for (const voice of shard(index.root.sections.speech).data.voices) {
  if (voice.sample !== undefined) problems.push(...speechProblems(voice, "voices"));
}
for (const [kind, check] of kinds) {
  for (const pointer of Object.values((index.root.listings as any)[kind].categories)) {
    for (const item of shard(pointer).items) if (item.bundle !== undefined || item.avatar !== undefined) problems.push(...check(item));
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `index.min.json: ${seen.size} app(s), ${counts.plugins.ids.size} plugin(s), ${counts.skills.ids.size} skill(s) and ${counts.templates.ids.size} agent template(s) and ${counts.mcps.ids.size} MCP server(s) by hand, and ${sourceIds.size} source(s), ${speechIds.size} speech model(s) and voice(s), ${ignoreIds.size} ignore template(s) valid.`,
);
