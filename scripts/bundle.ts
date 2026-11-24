// Makes each listing's bundle: exactly what a skill, agent template or plugin is at its pinned commit, as a
// deterministic tar.gz blob (scripts/blobs.ts) that Misty installs from and checks by its sha256 and size. Run after
// the crawl; build.ts adds each entry's `bundle` to the index from work/bundles.json.
//   skill     the skill's folder at the bundle's top (SKILL.md first), and LICENSE when its license is the repository's
//   template  the one Markdown file, under its own name
//   plugin    the plugin's folder at the top (.claude-plugin/plugin.json, skills/, commands/, agents/, hooks/,
//             .mcp.json and the rest), and LICENSE when its license is the repository's
// Each repository is fetched once per commit (codeload's tarball, streamed, keeping only the folders listed) into
// work/bundle/src/, and an entry whose source didn't change keeps its blob without fetching anything.
//   node scripts/bundle.ts [--jobs 8] [source or entry id...]
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import { put, tarEntries, tarGz, type TarFile } from "./blobs.ts";
import { detectLicense, frontmatter, isLicenseFile, namedLicense } from "./crawl_lib.ts";
import { MAX_BUNDLE_BYTES } from "./lib.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = join(root, "work", "bundle", "src");
export const BUNDLES = join(root, "work", "bundles.json");
const KINDS = ["skills", "templates", "plugins"] as const;
type Kind = (typeof KINDS)[number];

/** The most one file in a bundle may be, all of a bundle's files together, and how many files it may hold. */
const MOST_FILE = 16 * 1024 * 1024;
const MOST_FILES = 2000;
/** The most a repository's tarball may be fetched for, and kept of it. */
const MOST_DOWNLOAD = 2 * 1024 * 1024 * 1024;
const MOST_KEPT = 1024 * 1024 * 1024;

type Source = { repo: string; commit: string; path: string };
type Entry = { kind: Kind; id: string; license: string; source: Source; from: string };
type Mapping = { source: Source; bundle?: { url: string; sha256: string; size: number }; none?: string };
type Bundles = { schema: 1 } & { [kind in Kind]: Record<string, Mapping> };

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sameSource = (a: Source, b: Source) => a?.repo === b?.repo && a?.commit === b?.commit && a?.path === b?.path;

export const readBundles = (): Bundles =>
  existsSync(BUNDLES) ? json(BUNDLES) : { schema: 1, skills: {}, templates: {}, plugins: {} };

/** Every listing of files: what each source's crawl found, and the hand-written ones with a `source`. */
function listings(): Entry[] {
  const found: Entry[] = [];
  const crawled = join(root, "work", "crawled");
  if (existsSync(crawled)) {
    for (const name of readdirSync(crawled).filter((one) => one.endsWith(".json")).sort()) {
      const file = json(join(crawled, name));
      for (const kind of KINDS) for (const entry of file[kind] ?? []) found.push({ kind, id: entry.id, license: entry.license, source: entry.source, from: file.source });
    }
  }
  for (const kind of KINDS) {
    const folder = join(root, kind);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).filter((one) => one.endsWith(".json")).sort()) {
      const entry = json(join(folder, name));
      if (entry.source) found.push({ kind, id: entry.id, license: entry.license, source: entry.source, from: entry.id });
    }
  }
  return found;
}

const under = (path: string, folder: string) => folder === "." || path === folder || path.startsWith(`${folder}/`);
const relative = (path: string, folder: string) => (folder === "." ? path : path.slice(folder.length + 1));

type Fetched = { dir: string; files: Set<string>; exec: Set<string>; links: Record<string, string>; big: Set<string> };

const cacheDir = (repo: string, commit: string) => join(sources, repo.replace("/", "__"), commit);

function cached(repo: string, commit: string, needed: string[]): Fetched | null {
  const dir = cacheDir(repo, commit);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) return null;
  const meta = json(metaPath);
  if (!needed.every((one) => meta.wanted.some((have: string) => under(one, have)))) return null;
  return { dir: join(dir, "files"), files: new Set(meta.files), exec: new Set(meta.exec), links: meta.links, big: new Set(meta.big) };
}

/** Streams the repository's tarball at `commit` and keeps the files under `wanted` and the licenses at its top. */
async function fetchRepo(repo: string, commit: string, wanted: string[]): Promise<Fetched> {
  const have = cached(repo, commit, wanted);
  if (have) return have;
  const dir = cacheDir(repo, commit);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "files"), { recursive: true });
  let lastError: unknown;
  let stop = () => {};
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`https://codeload.github.com/${repo}/tar.gz/${commit}`, {
        headers: { "user-agent": "misty-registry-bundle" },
        redirect: "follow",
      });
      if (!response.ok || !response.body) throw new Error(`codeload answered ${response.status}`);
      let downloaded = 0;
      const body = Readable.fromWeb(response.body as any);
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, next) {
          downloaded += chunk.length;
          next(downloaded > MOST_DOWNLOAD ? new Error("its tarball is larger than the registry fetches") : null, chunk);
        },
      });
      const unpacked = body.pipe(counted).pipe(createGunzip());
      for (const stream of [body, counted]) stream.on("error", (error) => unpacked.destroy(error));
      stop = () => {
        body.destroy();
        unpacked.destroy();
      };
      const files = new Set<string>();
      const exec = new Set<string>();
      const links: Record<string, string> = {};
      const big = new Set<string>();
      let kept = 0;
      for await (const entry of tarEntries(unpacked)) {
        const slash = entry.path.indexOf("/");
        if (slash === -1) continue;
        const path = posix.normalize(entry.path.slice(slash + 1)).replace(/\/$/, "");
        if (!path || path === "." || path.startsWith("../") || path.startsWith("/") || path.split("/").includes(".git")) continue;
        const top = !path.includes("/") && isLicenseFile(path);
        if (!top && !wanted.some((folder) => under(path, folder))) continue;
        if (entry.kind === "link") {
          links[path] = entry.link;
          continue;
        }
        if (entry.kind !== "file") continue;
        if (entry.size > MOST_FILE) {
          big.add(path);
          continue;
        }
        kept += entry.size;
        if (kept > MOST_KEPT) throw new Error("what its listings hold is larger than the registry keeps");
        const data = await entry.read();
        mkdirSync(join(dir, "files", posix.dirname(path)), { recursive: true });
        writeFileSync(join(dir, "files", path), data);
        files.add(path);
        if (entry.mode & 0o111) exec.add(path);
      }
      const meta = { repo, commit, wanted, files: [...files].sort(), exec: [...exec].sort(), links, big: [...big].sort() };
      writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta)}\n`);
      return { dir: join(dir, "files"), files, exec, links, big };
    } catch (error) {
      lastError = error;
      stop();
      rmSync(join(dir, "files"), { recursive: true, force: true });
      mkdirSync(join(dir, "files"), { recursive: true });
      await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Where a link inside `folder` leads, when it leads to a file inside that folder; links that leave it are skipped. */
function follow(fetched: Fetched, path: string, folder: string) {
  let at = path;
  for (let hop = 0; hop < 8; hop++) {
    const target = fetched.links[at];
    if (target === undefined) return fetched.files.has(at) ? at : null;
    if (target.startsWith("/")) return null;
    const next = posix.normalize(posix.join(posix.dirname(at), target));
    if (next.startsWith("../") || !under(next, folder)) return null;
    at = next;
  }
  return null;
}

/** The repository's license file for `license`, when the entry takes the repository's. */
function repoLicenseFile(fetched: Fetched, license: string) {
  const top = [...fetched.files].filter((path) => !path.includes("/") && isLicenseFile(path)).sort();
  return top.find((path) => detectLicense(readFileSync(join(fetched.dir, path), "utf8")) === license) ?? null;
}

/** The files of one entry's bundle, at the paths they have in it, or why it has none. */
function bundleFiles(entry: Entry, fetched: Fetched): TarFile[] | string {
  const { path: folder } = entry.source;
  const read = (path: string) => readFileSync(join(fetched.dir, path));
  if (entry.kind === "templates") {
    if (!fetched.files.has(folder)) return fetched.big.has(folder) ? "its file is too large" : "its file isn't at that commit";
    return [{ path: posix.basename(folder), data: read(folder) }];
  }
  if (folder !== "." && ![...fetched.files].some((path) => under(path, folder))) return "its folder isn't at that commit";
  if ([...fetched.big].some((path) => under(path, folder))) return "a file in it is too large";
  const files: TarFile[] = [];
  for (const path of [...fetched.files].filter((one) => under(one, folder)).sort()) {
    files.push({ path: relative(path, folder), data: read(path), executable: fetched.exec.has(path) });
  }
  for (const link of Object.keys(fetched.links).filter((one) => under(one, folder)).sort()) {
    const target = follow(fetched, link, folder);
    if (target) files.push({ path: relative(link, folder), data: read(target), executable: fetched.exec.has(target) });
  }
  if (folder !== ".") {
    const own = files.some((file) => !file.path.includes("/") && isLicenseFile(file.path));
    const skill = entry.kind === "skills" ? files.find((file) => file.path === "SKILL.md") : undefined;
    const named = skill ? namedLicense(frontmatter(Buffer.from(skill.data).toString("utf8")).license) : null;
    if (!own && !named) {
      const license = repoLicenseFile(fetched, entry.license);
      if (!license) return "its repository's license file isn't at that commit";
      files.push({ path: "LICENSE", data: read(license) });
    }
  }
  if (entry.kind === "skills" && !files.some((file) => file.path === "SKILL.md")) return "it has no SKILL.md";
  if (entry.kind === "plugins" && !files.some((file) => !file.path.startsWith(".claude-plugin/") && !(file.path.split("/").length === 1 && isLicenseFile(file.path))))
    return "it brings nothing at that commit";
  if (files.length > MOST_FILES) return "it holds too many files";
  if (files.reduce((sum, file) => sum + file.data.length, 0) > MAX_BUNDLE_BYTES) return "it is too large";
  return files;
}

async function pool<T>(items: T[], jobs: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const jobs = args.includes("--jobs") ? Number(args[args.indexOf("--jobs") + 1]) || 1 : 1;
  const wanted = args.filter((arg, at) => arg !== "--jobs" && args[at - 1] !== "--jobs");
  const before = readBundles();
  const all = listings();
  const chosen = wanted.length ? all.filter((entry) => wanted.includes(entry.from) || wanted.includes(entry.id)) : all;
  const after: Bundles = wanted.length ? before : { schema: 1, skills: {}, templates: {}, plugins: {} };
  const sorted = (one: Record<string, Mapping>) => Object.fromEntries(Object.entries(one).sort(([a], [b]) => a.localeCompare(b)));
  const save = () =>
    writeFileSync(BUNDLES, `${JSON.stringify({ schema: 1, ...Object.fromEntries(KINDS.map((kind) => [kind, sorted(after[kind])])) })}\n`);
  const todo = new Map<string, Entry[]>();
  let reused = 0;
  for (const entry of chosen) {
    const prior = before[entry.kind]?.[entry.id];
    if (prior && sameSource(prior.source, entry.source)) {
      after[entry.kind][entry.id] = prior;
      reused += 1;
      continue;
    }
    const key = `${entry.source.repo}@${entry.source.commit}`;
    todo.set(key, [...(todo.get(key) ?? []), entry]);
  }
  mkdirSync(dirname(BUNDLES), { recursive: true });
  let made = 0;
  let none = 0;
  let failed = 0;
  let done = 0;
  await pool([...todo.entries()], jobs, async ([key, entries]) => {
    const [repo, commit] = key.split("@");
    try {
      const fetched = await fetchRepo(repo, commit, [...new Set(entries.map((entry) => entry.source.path))].sort());
      for (const entry of entries) {
        const files = bundleFiles(entry, fetched);
        if (typeof files === "string") {
          after[entry.kind][entry.id] = { source: entry.source, none: files };
          none += 1;
          continue;
        }
        after[entry.kind][entry.id] = { source: entry.source, bundle: put(await tarGz(files), "application/gzip") };
        made += 1;
      }
      console.log(`${repo}: ${entries.length} bundled at ${commit.slice(0, 8)}`);
    } catch (error) {
      console.error(`${repo}: left out this time, ${String((error as Error).message).split("\n")[0]}`);
      failed += 1;
    }
    if (++done % 25 === 0) save();
  });
  save();
  if (!wanted.length && existsSync(sources)) {
    const current = new Set(all.map((entry) => cacheDir(entry.source.repo, entry.source.commit)));
    for (const repo of readdirSync(sources)) {
      for (const commit of readdirSync(join(sources, repo))) {
        if (!current.has(join(sources, repo, commit))) rmSync(join(sources, repo, commit), { recursive: true, force: true });
      }
    }
  }
  console.log(`work/bundles.json: ${made} bundled, ${reused} kept from before, ${none} with none, ${failed} of ${todo.size} repositories left out`);
  if (failed > Math.max(2, todo.size / 10)) process.exitCode = 1;
}
