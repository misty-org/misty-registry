// Gathers every entry into the index: index.min.json, which publish.ts signs for every Misty, and the shards its
// listings are read from. Nothing of it is committed; it is built from the folders each time. Each section is built from its own folder; apps are the pins refresh wrote.
// What the blob steps made, when they have run, goes in too: each listing's `bundle` and its maker's `avatar`
// (bundle.ts, mirror_images.ts), and each app's pictures as blobs with their addresses kept as `<field>_source`. An
// entry they have nothing for simply has none.
//   node scripts/build.ts          writes site/index.min.json and site/index/ (unsigned, for trying it locally)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { INDEX_SCHEMA, minified, pinnedApps } from "./index.ts";
import { CATEGORIES, dedupe, LISTINGS } from "./kinds.ts";
import { makerLogin, pluginProblems, skillProblems, templateProblems } from "./lib.ts";

const root = new URL("../", import.meta.url);
const entries = (folder: string) =>
  readdirSync(new URL(`${folder}/`, root))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(new URL(`${folder}/${name}`, root), "utf8")));

const priorities = new Map<string, number>(entries("sources").map((source) => [source.id, source.priority ?? 100]));
const crawled = () =>
  existsSync(new URL("work/crawled/", root))
    ? entries("work/crawled").map((file) => ({ ...file, priority: priorities.get(file.source) ?? 100 }))
    : [];

/** What a blob step wrote to work/, or nothing when it hasn't run. */
const made = (name: string) => (existsSync(new URL(`work/${name}`, root)) ? JSON.parse(readFileSync(new URL(`work/${name}`, root), "utf8")) : null);

/** Each listing's bundle, made at the very commit and path the entry is pinned to, and its maker's face. */
function withBlobs(kind: string, entry: any, bundles: any, images: any) {
  const one = bundles?.[kind]?.[entry.id];
  const same = one?.bundle && entry.source && ["repo", "commit", "path"].every((key) => one.source?.[key] === entry.source[key]);
  const avatar = images?.avatars?.[makerLogin(entry) ?? ""]?.url;
  return { ...entry, ...(avatar ? { avatar } : {}), ...(same ? { bundle: one.bundle } : {}) };
}

/** An app's logo, banner and screenshots as their blobs, each keeping the address it was copied from. */
function appWithBlobs(app: any, images: any) {
  const blob = (address: unknown) => (typeof address === "string" ? images?.images?.[address]?.url : undefined);
  const out = { ...app };
  for (const key of ["logo", "banner"]) {
    const url = blob(app[key]);
    if (url) Object.assign(out, { [key]: url, [`${key}_source`]: app[key] });
  }
  const shots = Array.isArray(app.screenshots) ? app.screenshots.map(blob) : [];
  if (shots.length && shots.every(Boolean)) Object.assign(out, { screenshots: shots, screenshots_source: app.screenshots });
  return out;
}

/** What a crawled entry must hold to be listed, checked again at build so an older crawl never lists what a newer rule refuses. */
const CRAWL_CHECKS: Record<string, (entry: any) => string[]> = { plugins: pluginProblems, skills: skillProblems, templates: templateProblems };

/**
 * A listing's hand-written entries (which always win) and what each source's crawl found, as one entry per thing. Misty
 * installs a skill, template or plugin from its bundle, so once the bundle step has run, one it couldn't bundle (its
 * folder only a link at that commit, or too large) isn't listed, and a new one waits for the run that bundles it.
 */
function listing(kind: (typeof LISTINGS)[number], bundles: any, images: any) {
  const hand = existsSync(new URL(`${kind}/`, root)) ? entries(kind).map((entry) => ({ entry, priority: 0 })) : [];
  const sound = CRAWL_CHECKS[kind] ?? (() => []);
  const found = crawled().flatMap((file) =>
    (file[kind] ?? []).filter((entry) => !sound(entry).length).map((entry) => ({ entry, priority: file.priority })),
  );
  const listed = dedupe([...hand, ...found]).map((entry) => withBlobs(kind, entry, bundles, images));
  return bundles && kind !== "mcps" ? listed.filter((entry) => entry.bundle) : listed;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** How many of each category's first entries a kind's top shard carries, for the shelves of its page. */
export const TOP_PER_CATEGORY = 12;

const byRank = (a: any, b: any) => (b.rank ?? 0) - (a.rank ?? 0) || a.id.localeCompare(b.id);

/**
 * The index as a root and its shards. The root holds nothing but pointers, each a path and the checksum and size of
 * what is there, so it stays small however much is listed: one per section (the categories, apps, engines, speech
 * models and ignore templates, read whole at launch) and, for each listing, its top shard (the first few of each
 * category by rank, which is all its page needs) and one shard per category, read when someone opens that category
 * or searches it. A shard is named by its own checksum so it never changes under its name, and is checked against
 * the root, which is what the signature covers.
 */
export function built() {
  const shards: Record<string, string> = {};
  const shard = (name: string, body: unknown) => {
    const text = minified(body);
    const hash = sha256(text);
    const path = `index/${name}.${hash.slice(0, 12)}.json`;
    shards[path] = text;
    return { path, sha256: hash, size: Buffer.byteLength(text) };
  };
  const bundles = made("bundles.json");
  const images = made("images.json");
  const mirrors: Record<string, string> = made("speech_mirrors.json")?.mirrors ?? {};
  const mirrored = (entry: any) =>
    mirrors[entry.package?.sha256] ? { ...entry, package: { ...entry.package, mirror: mirrors[entry.package.sha256] } } : entry;
  const listings: Record<string, unknown> = {};
  for (const kind of LISTINGS) {
    const items = listing(kind, bundles, images).sort(byRank);
    const groups = new Map<string, any[]>();
    for (const item of items) groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
    const categories: Record<string, unknown> = {};
    for (const [id] of CATEGORIES) {
      const group = groups.get(id);
      if (group) categories[id] = { ...shard(`${kind}/${id}`, { schema: INDEX_SCHEMA, kind, category: id, items: group }), count: group.length };
    }
    const top = [...groups.values()].flatMap((group) => group.slice(0, TOP_PER_CATEGORY));
    listings[kind] = { count: items.length, top: shard(`${kind}/top`, { schema: INDEX_SCHEMA, kind, items: top }), categories };
  }
  const section = (name: string, data: unknown) =>
    shard(`sections/${name}`, { schema: INDEX_SCHEMA, section: name, data });
  const root = {
    schema: INDEX_SCHEMA,
    sections: {
      categories: section("categories", CATEGORIES.map(([id, name]) => ({ id, name }))),
      apps: section("apps", pinnedApps().map((app) => appWithBlobs(app, images))),
      engines: section("engines", entries("engines")),
      speech: section("speech", {
        hearing: entries("speech/hearing").map(mirrored),
        support: entries("speech/support").map(mirrored),
      }),
      ignore: section("ignore", entries("ignore")),
    },
    listings,
  };
  return { root, shards };
}

/** Writes the index where it is served from: site/index.min.json and site/index/. */
export function write(document = built(), stamp: Record<string, unknown> = {}) {
  const site = new URL("site/", root);
  rmSync(new URL("index/", site), { recursive: true, force: true });
  for (const [path, text] of Object.entries(document.shards)) {
    mkdirSync(new URL(".", new URL(path, site)), { recursive: true });
    writeFileSync(new URL(path, site), text);
  }
  const body = minified({ ...document.root, ...stamp });
  writeFileSync(new URL("index.min.json", site), body);
  return body;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const document = built();
  write(document);
  const sizes = Object.entries(document.root.listings).map(([kind, one]: [string, any]) => `${one.count} ${kind}`);
  const biggest = Math.max(...Object.values(document.shards).map((text) => Buffer.byteLength(text)));
  console.log(`site/index.min.json written (${(Buffer.byteLength(JSON.stringify(document.root)) / 1024).toFixed(0)} KB); ${sizes.join(", ")}; ${Object.keys(document.shards).length} shards, the biggest ${(biggest / 1024).toFixed(0)} KB`);
}
