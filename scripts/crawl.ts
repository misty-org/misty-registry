// Reads each source in sources/<id>.json at its repository's latest commit, fetching only the files it reads, and writes
// what it holds, pinned to that commit, to work/crawled/<id>.json (built from, never committed): the skills (folders with a SKILL.md) and agent templates (Markdown files with a name
// and description) it carries. Only what has a license Misty may carry is kept; everything else is counted and left out.
//   node scripts/crawl.ts [--jobs 8] [id...]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { categorize, cut, detectLicense, digestOf, entryId, frontmatter, isLicenseFile, namedLicense, slug, starsOf, title } from "./crawl_lib.ts";
import { pluginProblems, skillProblems, templateProblems } from "./lib.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = join(root, "work", "crawl");
const SKIP_FILES = /^(README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|SKILL|AGENTS|CLAUDE|LICENSE|NOTICE)(\.|$)/i;
const MOST_FILE = 256 * 1024;
const MOST_DEPTH = 8;

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" } });

function latest(repo, ref) {
  const out = git(root, "ls-remote", `https://github.com/${repo}.git`, ref || "HEAD").trim().split("\n")[0];
  const commit = out.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${repo} has no ${ref || "HEAD"}`);
  return commit;
}

const SPARSE = [
  "SKILL.md", "LICENSE*", "LICENCE*", "COPYING*", "**/agents/*.md", "**/commands/*.md", ".claude-plugin/", "**/.claude-plugin/",
  "**/.mcp.json", "**/hooks/", "**/hooks.json",
];

/** Only the files the crawl reads: a source that names its own template files needs its Markdown too. */
const sparseFor = (source) => {
  const own = source.templates && (source.templates.paths?.length || (source.templates.match && !source.templates.match.includes("agents/")));
  return own ? [...SPARSE, "*.md"] : SPARSE;
};

function checkout(source, commit) {
  const folder = join(work, source.id);
  let head = "";
  try {
    head = existsSync(join(folder, ".git")) ? git(folder, "rev-parse", "HEAD").trim() : "";
  } catch {}
  if (head === commit) return folder;
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  git(folder, "init", "--quiet");
  git(folder, "remote", "add", "origin", `https://github.com/${source.repo}.git`);
  git(folder, "sparse-checkout", "set", "--no-cone", ...sparseFor(source));
  git(folder, "fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", commit);
  git(folder, "checkout", "--quiet", "FETCH_HEAD");
  return folder;
}

function walk(folder, base, depth = 0, found = []) {
  if (depth > MOST_DEPTH) return found;
  for (const name of readdirSync(join(folder, base)).sort()) {
    if (name === ".git" || name === "node_modules") continue;
    const path = base ? posix.join(base, name) : name;
    let stat;
    try {
      stat = statSync(join(folder, path));
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(folder, path, depth + 1, found);
    else if (stat.isFile()) found.push(path);
  }
  return found;
}

const read = (folder, path) => {
  try {
    return statSync(join(folder, path)).size <= MOST_FILE ? readFileSync(join(folder, path), "utf8") : null;
  } catch {
    return null;
  }
};

/** The license of a folder's own file, or of the repository's: undefined when it names none, null when it is one Misty may not carry. */
function licenseIn(folder, directory, files) {
  const own = files.filter((path) => posix.dirname(path) === (directory || ".") && isLicenseFile(posix.basename(path)));
  if (!own.length) return undefined;
  return own.map((path) => detectLicense(read(folder, path) ?? "")).find((license) => license) ?? null;
}

const inside = (path, paths) => !paths?.length || paths.some((base) => path === base || path.startsWith(`${base}/`));

export function crawl(source, folder, commit, taken, rank = 0) {
  const files = walk(folder, "");
  const skipped = { license: 0, invalid: 0, duplicate: 0 };
  const repoLicense = licenseIn(folder, "", files);
  const found = { plugins: [], skills: [], templates: [] };
  const ids = new Map();
  const maker = source.maker ?? source.repo.split("/")[0];
  const limit = source.limit ?? 500;
  const checks = { plugins: pluginProblems, skills: skillProblems, templates: templateProblems };
  const add = (kind, entry, parent) => {
    if (found[kind].length >= limit) return;
    const key = `${kind}/`;
    if (taken.has(`${source.repo}/${entry.source.path}`)) return void (skipped.duplicate += 1);
    let id = entry.id;
    if (id && ids.has(key + id)) {
      if (ids.get(key + id) === entry.digest) return void (skipped.duplicate += 1);
      id = entryId(source.id, `${parent}-${entry.name}`) ?? null;
    }
    if (!id || ids.has(key + id)) return void (skipped.duplicate += 1);
    const complete = { ...entry, id, ...(rank ? { rank } : {}) };
    if (checks[kind](complete).length) return void (skipped.invalid += 1);
    ids.set(key + id, entry.digest);
    found[kind].push(complete);
  };
  const leaf = (path) => posix.basename(posix.dirname(path));
  if (source.skills) {
    for (const path of files.filter((file) => posix.basename(file) === "SKILL.md" && inside(file, source.skills.paths))) {
      const directory = posix.dirname(path);
      const top = directory === ".";
      const text = read(folder, path) ?? "";
      const meta = frontmatter(text);
      const own = top ? undefined : licenseIn(folder, directory, files);
      const license = own === undefined ? namedLicense(meta.license) ?? repoLicense : own;
      if (!license) {
        skipped.license += 1;
        continue;
      }
      if (!meta.description) {
        skipped.invalid += 1;
        continue;
      }
      const name = meta.name || (top ? source.repo.split("/")[1] : posix.basename(directory));
      add(
        "skills",
        {
          id: top ? source.id : entryId(source.id, posix.basename(directory)),
          name: cut(title(name), 60),
          description: cut(meta.description, 200),
          maker,
          license,
          category: categorize(top ? "" : directory.split("/").slice(0, -1).join(" "), name, meta.description),
          source: { repo: source.repo, commit, path: directory },
          digest: digestOf(text),
        },
        slug(leaf(directory)),
      );
    }
  }
  if (source.templates) {
    const match = source.templates.match ? new RegExp(source.templates.match) : null;
    for (const path of files.filter(
      (file) => file.endsWith(".md") && !SKIP_FILES.test(posix.basename(file)) && inside(file, source.templates.paths) && (!match || match.test(file)),
    )) {
      const text = read(folder, path) ?? "";
      const meta = frontmatter(text);
      if (!meta.name || !meta.description) continue;
      if (!repoLicense) {
        skipped.license += 1;
        continue;
      }
      const base = source.templates.paths?.length ? source.templates.paths.find((one) => path.startsWith(`${one}/`)) : null;
      const rest = (base ? path.slice(base.length + 1) : path).split("/");
      add(
        "templates",
        {
          id: entryId(source.id, posix.basename(path, ".md")),
          name: cut(title(meta.name), 60),
          description: cut(meta.description, 200),
          maker,
          license: repoLicense,
          category: categorize(rest.length > 1 ? rest[0] : "", meta.name, meta.description),
          source: { repo: source.repo, commit, path },
          digest: digestOf(text),
        },
        slug(rest.length > 1 ? rest[0] : ""),
      );
    }
  }
  if (source.plugins) {
    const index = JSON.parse(read(folder, source.plugins.index) ?? "{}");
    for (const plugin of Array.isArray(index.plugins) ? index.plugins : []) {
      if (typeof plugin?.source !== "string" || !plugin.source.startsWith("./")) continue;
      const directory = posix.normalize(plugin.source.slice(2)).replace(/\/$/, "");
      if (!directory || directory.startsWith("..") || directory === ".") continue;
      const inPlugin = files.filter((file) => file.startsWith(`${directory}/`));
      if (!inPlugin.length || typeof plugin.description !== "string" || typeof plugin.name !== "string") {
        skipped.invalid += 1;
        continue;
      }
      const own = licenseIn(folder, directory, files);
      const license = own === undefined ? repoLicense : own;
      if (!license) {
        skipped.license += 1;
        continue;
      }
      const under = (kind) => inPlugin.filter((file) => file.startsWith(`${directory}/${kind}/`) && file.endsWith(".md")).length;
      const manifest = inPlugin.filter((file) => file.startsWith(`${directory}/.claude-plugin/`) || file.startsWith(`${directory}/hooks`) || file === `${directory}/.mcp.json`).sort();
      add(
        "plugins",
        {
          id: entryId(source.id, plugin.name),
          name: cut(title(plugin.name), 60),
          description: cut(plugin.description, 200),
          maker: typeof plugin.author?.name === "string" && plugin.author.name.trim() ? plugin.author.name.trim() : maker,
          license,
          category: categorize(typeof plugin.category === "string" ? plugin.category : "", plugin.name, plugin.description),
          source: { repo: source.repo, commit, path: directory },
          includes: {
            skills: inPlugin.filter((file) => posix.basename(file) === "SKILL.md").length,
            agents: under("agents"),
            commands: under("commands"),
            hooks: inPlugin.some((file) => file.startsWith(`${directory}/hooks/`) || file === `${directory}/hooks.json`),
            mcp: inPlugin.includes(`${directory}/.mcp.json`),
          },
          digest: digestOf(manifest.map((file) => `${file}\0${read(folder, file) ?? ""}`).join("\n") + inPlugin.length),
        },
        slug(directory),
      );
    }
  }
  const by = (a, b) => a.id.localeCompare(b.id);
  return { plugins: found.plugins.sort(by), skills: found.skills.sort(by), templates: found.templates.sort(by), skipped };
}

/** Where each hand-listed entry comes from, so a crawl never lists the same thing twice. */
function listed() {
  const taken = new Set();
  for (const kind of ["plugins", "skills", "templates"]) {
    for (const name of readdirSync(join(root, kind)).filter((file) => file.endsWith(".json"))) {
      const entry = JSON.parse(readFileSync(join(root, kind, name), "utf8"));
      taken.add(`${entry.source.repo}/${entry.source.path}`);
    }
  }
  return taken;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const jobs = args.includes("--jobs") ? Number(args[args.indexOf("--jobs") + 1]) || 1 : 1;
  const wanted = args.filter((arg, at) => arg !== "--jobs" && args[at - 1] !== "--jobs");
  mkdirSync(join(root, "work", "crawled"), { recursive: true });
  const all = readdirSync(join(root, "sources")).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(join(root, "sources", file), "utf8")).repo);
  const stars = await starsOf(all, join(root, "work", "stars.json"));
  if (jobs > 1) {
    const ids = readdirSync(join(root, "sources"))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(/\.json$/, ""))
      .filter((id) => !wanted.length || wanted.includes(id))
      .sort();
    const groups = Array.from({ length: jobs }, (_, n) => ids.filter((_, at) => at % jobs === n)).filter((group) => group.length);
    const codes = await Promise.all(
      groups.map(
        (group) =>
          new Promise<number>((done) =>
            spawn(process.execPath, [fileURLToPath(import.meta.url), ...group], { stdio: "inherit" }).on("close", (code) => done(code ?? 1)),
          ),
      ),
    );
    process.exit(codes.some((code) => code !== 0) ? 1 : 0);
  }
  const taken = listed();
  let failed = 0;
  for (const name of readdirSync(join(root, "sources")).filter((file) => file.endsWith(".json")).sort()) {
    const source = JSON.parse(readFileSync(join(root, "sources", name), "utf8"));
    if (wanted.length && !wanted.includes(source.id)) continue;
    try {
      const commit = latest(source.repo, source.ref);
      const folder = checkout(source, commit);
      const found = crawl(source, folder, commit, taken, stars(source.repo));
      writeFileSync(
        join(root, "work", "crawled", `${source.id}.json`),
        `${JSON.stringify({ schema: 1, source: source.id, repo: source.repo, commit, ...found }, null, 2)}\n`,
      );
      const { skipped } = found;
      console.log(
        `${source.id}: ${found.plugins.length} plugins, ${found.skills.length} skills, ${found.templates.length} templates at ${commit.slice(0, 8)}; left out ${skipped.license} by license, ${skipped.invalid} incomplete, ${skipped.duplicate} duplicate`,
      );
    } catch (error) {
      console.error(`${source.id}: left out this time, ${String(error.message).split("\n")[0]}`);
      failed += 1;
    }
  }
  if (failed > Math.max(2, wanted.length / 10)) process.exitCode = 1;
}
