// Copies every picture Explore shows into the blob store (scripts/blobs.ts), so Misty loads them from the registry
// and checks each by its sha256: each app's logo, banner and screenshots, and the GitHub face of each listing's maker
// (its repository's owner, fetched once per login). work/images.json keeps each blob beside the address it was copied
// from; build.ts puts the blobs in the index and keeps the addresses as provenance. A picture pinned at a tag or commit
// is fetched once; a site's own icon is fetched again after a week, and a face after a month.
//   node scripts/mirror_images.ts [--jobs 8] [app id or login...]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { put } from "./blobs.ts";
import { pinnedApps } from "./index.ts";
import { makerLogin } from "./lib.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGES = join(root, "work", "images.json");
const MOST_IMAGE = 8 * 1024 * 1024;
const DAY = 24 * 3600 * 1000;
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

type Mirrored = { url: string; sha256: string; size: number; type: string; source: string; at: number };
type Images = { schema: 1; images: Record<string, Mirrored>; avatars: Record<string, Mirrored> };

const readImages = (): Images =>
  existsSync(IMAGES) ? JSON.parse(readFileSync(IMAGES, "utf8")) : { schema: 1, images: {}, avatars: {} };

/** What a picture is: the extension its pinned path names, else what the server says, and only ever a picture. */
function typeOf(address: string, said: string | null) {
  const extension = /\.([a-z]+)$/i.exec(new URL(address).pathname)?.[1]?.toLowerCase();
  const header = (said ?? "").split(";")[0].trim().toLowerCase();
  const type = (extension && TYPES[extension]) || header;
  return Object.values(TYPES).includes(type) ? type : null;
}

async function mirror(address: string): Promise<Omit<Mirrored, "at">> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(address, { headers: { "user-agent": "misty-registry-images" }, redirect: "follow" });
      if (response.status === 404) throw Object.assign(new Error("not found"), { final: true });
      if (!response.ok) throw new Error(`answered ${response.status}`);
      const type = typeOf(response.url || address, response.headers.get("content-type"));
      if (!type) throw Object.assign(new Error(`isn't a picture (${response.headers.get("content-type")})`), { final: true });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MOST_IMAGE) throw Object.assign(new Error("is empty or larger than a picture may be"), { final: true });
      return { ...put(bytes, type), type, source: address };
    } catch (error) {
      lastError = error;
      if ((error as { final?: boolean }).final) break;
      await new Promise((done) => setTimeout(done, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Every listing's maker login: the sources' crawls, the hand-written listings and the MCP servers. */
function logins() {
  const found = new Set<string>();
  const add = (entry: unknown) => {
    const login = makerLogin(entry);
    if (login) found.add(login);
  };
  const crawled = join(root, "work", "crawled");
  const files = (folder: string) =>
    existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(folder, name), "utf8"))) : [];
  for (const file of files(crawled)) for (const kind of ["skills", "templates", "plugins"]) for (const entry of file[kind] ?? []) add(entry);
  for (const kind of ["skills", "templates", "plugins", "mcps"]) for (const entry of files(join(root, kind))) add(entry);
  return [...found].sort();
}

/** An app's pictures: its logo, banner and screenshots, wherever its entry says they are. */
const pictures = (app: any): string[] => [app.logo, app.banner, ...(app.screenshots ?? [])].filter((one) => typeof one === "string");

const pinned = (address: string) => address.startsWith("https://raw.githubusercontent.com/");

async function pool<T>(items: T[], jobs: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

const args = process.argv.slice(2);
const jobs = args.includes("--jobs") ? Number(args[args.indexOf("--jobs") + 1]) || 1 : 8;
const wanted = args.filter((arg, at) => arg !== "--jobs" && args[at - 1] !== "--jobs").map((one) => one.toLowerCase());
const before = readImages();
const after: Images = { schema: 1, images: {}, avatars: {} };
const now = Date.now();
let fetched = 0;
let kept = 0;
let failed = 0;
const fresh = (one: Mirrored | undefined, most: number) => one && (most === Infinity || now - one.at < most);

/** Copies each picture that isn't fresh, keeping the last copy of one that can't be fetched now. */
async function update(into: Record<string, Mirrored>, from: Record<string, Mirrored>, keys: string[], address: (key: string) => string, most: (key: string) => number) {
  await pool(keys, jobs, async (key) => {
    const prior = from[key];
    if (fresh(prior, most(key))) {
      into[key] = prior;
      kept += 1;
      return;
    }
    try {
      into[key] = { ...(await mirror(address(key))), at: now };
      fetched += 1;
    } catch (error) {
      if (prior) into[key] = prior;
      console.error(`${address(key)}: ${(error as Error).message}`);
      failed += 1;
    }
  });
}

const apps = pinnedApps().filter((app) => !wanted.length || wanted.includes(app.id));
const addresses = [...new Set(apps.flatMap(pictures))].sort();
const faces = logins().filter((login) => !wanted.length || wanted.includes(login));
if (wanted.length) {
  after.images = { ...before.images };
  after.avatars = { ...before.avatars };
}
await update(after.images, before.images, addresses, (address) => address, (address) => (pinned(address) ? Infinity : 7 * DAY));
await update(after.avatars, before.avatars, faces, (login) => `https://github.com/${login}.png?size=160`, () => 30 * DAY);

const sorted = <T>(one: Record<string, T>) => Object.fromEntries(Object.entries(one).sort(([a], [b]) => a.localeCompare(b)));
mkdirSync(dirname(IMAGES), { recursive: true });
writeFileSync(IMAGES, `${JSON.stringify({ schema: 1, images: sorted(after.images), avatars: sorted(after.avatars) })}\n`);
console.log(`work/images.json: ${fetched} copied, ${kept} kept from before, ${failed} couldn't be copied`);
