// Pins each app to its maker's latest release and writes apps.json:
//   node scripts/refresh.mjs [id...]      (set GITHUB_TOKEN to avoid the anonymous rate limit)
// Nothing is downloaded or kept here: the release's own zip address and the checksum GitHub reports for it are
// what get pinned, and Misty downloads the maker's zip itself, at install, and checks it against this checksum.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { zipName } from "./build_apps.mjs";
import { entryProblems } from "./lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wanted = process.argv.slice(2);
const headers = {
  "user-agent": "misty-apps-refresh",
  accept: "application/vnd.github+json",
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

const exists = async (url) => (await fetch(url, { method: "HEAD", headers, redirect: "follow" })).ok;

async function licenseAt(upstream, tag) {
  const response = await fetch(`https://api.github.com/repos/${upstream}/license?ref=${encodeURIComponent(tag)}`, { headers });
  if (!response.ok) throw new Error(`${upstream} ${tag} has no license GitHub can read (${response.status})`);
  const spdx = (await response.json())?.license?.spdx_id;
  if (typeof spdx !== "string" || !spdx || spdx === "NOASSERTION") throw new Error(`${upstream} ${tag} has a license GitHub can't name`);
  return spdx;
}

/**
 * The maker's own `misty-app.json` at the top of their repository, when they wrote one: it wins over the file here,
 * which then only says the app is listed (and holds what the maker's leaves out).
 */
async function withMakersManifest(config) {
  const response = await fetch(`https://raw.githubusercontent.com/${config.upstream}/HEAD/misty-app.json`, {
    headers,
  });
  if (response.status === 404) return config;
  if (!response.ok) throw new Error(`${config.upstream}: misty-app.json answered ${response.status}`);
  const theirs = await response.json();
  return { ...config, ...theirs, id: config.id, upstream: config.upstream };
}

function releaseAsset(assets, pattern, where) {
  if (!pattern.includes("*")) {
    const asset = assets.find((candidate) => candidate.name === pattern);
    if (!asset) throw new Error(`${where} has no ${pattern}`);
    return asset;
  }
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  const matcher = new RegExp(`^${escaped.join("[^/]+")}$`);
  const found = assets.filter((candidate) => matcher.test(candidate.name));
  if (found.length !== 1) throw new Error(`${where} has ${found.length || "no"} assets matching ${pattern}, not one`);
  return found[0];
}

function versioned(manifest, version) {
  if (typeof manifest?.entry !== "string" || !manifest.entry.includes("{version}")) return manifest;
  return { ...manifest, entry: manifest.entry.replaceAll("{version}", version) };
}

function site(config) {
  const adapter = config.adapter ? join(root, "apps", config.id, config.adapter) : null;
  if (adapter && !existsSync(adapter)) throw new Error(`${config.id}: apps/${config.id}/${config.adapter} is missing`);
  const entry = {
    kind: "site",
    id: config.id,
    name: config.name,
    description: config.description,
    maker: config.maker,
    version: config.version,
    address: config.address,
    origins: config.origins,
    logo: config.icon,
    ...(config.icon_render ? { icon_render: config.icon_render } : {}),
    platforms: config.platforms,
    media: config.media,
    permissions: config.manifest.permissions,
    manifest: config.manifest,
    ...(adapter ? { adapter_source: readFileSync(adapter, "utf8") } : {}),
    add_copies: [],
    strip_top: false,
  };
  const problems = entryProblems(entry);
  if (problems.length) throw new Error(problems.join("\n"));
  return entry;
}

const BUILDS_URL = (process.env.REGISTRY_BUILDS_URL ?? "").replace(/\/+$/, "");

async function built(config) {
  const recipePath = join(root, "builds", config.id, "recipe.json");
  if (!existsSync(recipePath)) throw new Error(`${config.id}: builds/${config.id}/recipe.json is missing`);
  const recipe = JSON.parse(readFileSync(recipePath, "utf8"));
  const pinPath = join(root, "work", "builds", `${config.id}.json`);
  if (!existsSync(pinPath)) return null;
  const made = JSON.parse(readFileSync(pinPath, "utf8"));
  if (made.zip !== zipName(config.id, recipe)) {
    throw new Error(`${config.id}: the build is of another recipe than builds/${config.id}; build it again`);
  }
  const raw = `https://raw.githubusercontent.com/${recipe.upstream}/${recipe.commit}`;
  const logo = `${raw}/${config.icon}`;
  if (!(await exists(logo))) throw new Error(`${recipe.upstream} ${recipe.commit} has no icon at ${config.icon}`);
  const url = BUILDS_URL
    ? `${BUILDS_URL}/${made.zip}`
    : pathToFileURL(join(root, "work", "builds", made.zip)).href;
  const entry = {
    id: config.id,
    name: config.name,
    description: config.description,
    maker: config.maker,
    upstream: recipe.upstream,
    license: recipe.license,
    version: recipe.version,
    tag: recipe.version,
    commit: recipe.commit,
    built: true,
    url,
    sha256: made.sha256,
    size: made.size,
    logo,
    ...(config.icon_render ? { icon_render: config.icon_render } : {}),
    permissions: config.manifest.permissions,
    manifest: versioned(config.manifest, recipe.version),
    add_copies: config.add_copies ?? [],
    strip_top: config.strip_top ?? false,
    ...adapterOf(config),
  };
  const problems = entryProblems(entry, { local: !BUILDS_URL });
  if (problems.length) throw new Error(problems.join("\n"));
  return entry;
}

async function pin(listed) {
  if (listed.kind === "site") return site(listed);
  if (listed.build) return built(listed);
  const config = await withMakersManifest(listed);
  const response = await fetch(`https://api.github.com/repos/${config.upstream}/releases/latest`, { headers });
  if (!response.ok) throw new Error(`${config.upstream}: releases/latest answered ${response.status}`);
  const release = await response.json();
  if (release.draft || release.prerelease) throw new Error(`${config.upstream}: ${release.tag_name} is a draft or pre-release`);
  const tag = release.tag_name;
  const version = tag.replace(/^v/, "");
  const name = config.web_asset.replace("{version}", version);
  const asset = releaseAsset(release.assets, name, `${config.upstream} ${tag}`);
  if (!String(asset.digest ?? "").startsWith("sha256:")) throw new Error(`${name} has no checksum from GitHub`);
  const raw = `https://raw.githubusercontent.com/${config.upstream}/${encodeURIComponent(tag)}`;
  // An app whose MCP server is a program of the maker's: each platform's release archive that holds it, pinned
  // like the web build. A platform the release has no build for is left out, and the app's tools aren't offered there.
  let mcpProgram;
  if (config.mcp_program) {
    const { builds: names, ...rest } = config.mcp_program;
    const builds = {};
    for (const [platform, pattern] of Object.entries(names ?? {})) {
      const file = pattern.replace("{version}", version);
      const build = release.assets.find((candidate) => candidate.name === file);
      if (!build) throw new Error(`${config.upstream} ${tag} has no ${file} for ${platform}`);
      if (!String(build.digest ?? "").startsWith("sha256:")) throw new Error(`${file} has no checksum from GitHub`);
      builds[platform] = { url: build.browser_download_url, sha256: build.digest.slice("sha256:".length), size: build.size };
    }
    mcpProgram = { ...rest, builds };
  }
  // What the release says it is licensed under: both files is a choice of either.
  const mit = await exists(`${raw}/LICENSE-MIT`);
  const apache = await exists(`${raw}/LICENSE-APACHE`);
  const license = mit || apache ? (mit && apache ? "MIT OR Apache-2.0" : mit ? "MIT" : "Apache-2.0") : await licenseAt(config.upstream, tag);
  const logo = `${raw}/${config.icon}`;
  if (!(await exists(logo))) throw new Error(`${config.upstream} ${tag} has no icon at ${config.icon}`);
  // The banner and screenshots are optional: a maker exports them in their repository for Explore.
  const banner = config.banner ? `${raw}/${config.banner}` : undefined;
  if (banner && !(await exists(banner))) throw new Error(`${config.upstream} ${tag} has no banner at ${config.banner}`);
  const screenshots = (config.screenshots ?? []).map((path) => `${raw}/${path}`);
  for (const shot of screenshots) if (!(await exists(shot))) throw new Error(`${config.upstream} ${tag} has no screenshot at ${shot}`);
  const entry = {
    id: config.id,
    name: config.name,
    description: config.description,
    maker: config.maker,
    upstream: config.upstream,
    license,
    version,
    tag,
    url: asset.browser_download_url,
    sha256: asset.digest.slice("sha256:".length),
    size: asset.size,
    logo,
    ...(config.icon_render ? { icon_render: config.icon_render } : {}),
    ...(banner ? { banner } : {}),
    ...(screenshots.length ? { screenshots } : {}),
    permissions: config.manifest.permissions,
    manifest: versioned(config.manifest, version),
    ...(mcpProgram ? { mcp_program: mcpProgram } : {}),
    add_copies: config.add_copies ?? [],
    strip_top: config.strip_top ?? false,
    // An adapter written here (`apps/<id>/adapter.js`) gives an app with no tools of its own its MCP tools; Misty
    // writes it beside the maker's release, under `misty/`, and loads it into the running app.
    ...adapterOf(config),
  };
  const problems = entryProblems(entry);
  if (problems.length) throw new Error(problems.join("\n"));
  return entry;
}

/** The adapter script of an app whose manifest says `mcp: adapter`, as a file Misty adds to the release. */
function adapterOf(config) {
  if (config.manifest?.mcp !== "adapter") return {};
  const path = config.manifest.adapter;
  if (typeof path !== "string" || !path.startsWith("misty/")) throw new Error(`${config.id}: an adapter goes under misty/`);
  const folder = config.build ? "builds" : "apps";
  const shared = typeof config.adapter_shared === "string" ? config.adapter_shared : null;
  if (shared !== null && !/^[a-z][a-z0-9-]*$/.test(shared)) throw new Error(`${config.id}: adapter_shared names a file in adapters/`);
  const file = shared ? join(root, "adapters", `${shared}.js`) : join(root, folder, config.id, "adapter.js");
  if (!existsSync(file)) throw new Error(`${config.id}: ${shared ? `adapters/${shared}.js` : `${folder}/${config.id}/adapter.js`} is missing`);
  return { add_files: [{ path, content: readFileSync(file, "utf8") }] };
}

const pinsPath = join(root, "apps.json");
const previous = existsSync(pinsPath) ? JSON.parse(readFileSync(pinsPath, "utf8")).apps : [];
const kept = new Map(previous.map((app) => [app.id, app]));
const localPath = join(root, "work", "apps.local.json");
const local = new Map(
  (existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")).apps : []).map((app) => [app.id, app]),
);
const failed = [];
// Each app is `apps/<id>.json`; an app's own folder (`apps/<id>/`) holds its adapter.
for (const file of readdirSync(join(root, "apps")).filter((name) => name.endsWith(".json")).sort()) {
  const config = JSON.parse(readFileSync(join(root, "apps", file), "utf8"));
  if (wanted.length && !wanted.includes(config.id)) continue;
  try {
    const entry = await pin(config);
    if (!entry) {
      console.log(`${config.id}: not built here, keeps its pin`);
      continue;
    }
    if (entry.url.startsWith("file:")) {
      local.set(config.id, entry);
      console.log(`${config.id}: ${entry.version} (local build, in work/apps.local.json)`);
      continue;
    }
    const before = kept.get(config.id);
    console.log(`${config.id}: ${before && before.version !== entry.version ? `${before.version} -> ` : ""}${entry.version}`);
    kept.set(config.id, entry);
  } catch (error) {
    // An app that can't be pinned keeps the pin it had; the others still move.
    console.error(`${config.id}: ${error.message}`);
    failed.push(config.id);
  }
}
const apps = [...kept.values()].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(pinsPath, `${JSON.stringify({ schema: 2, apps }, null, 2)}\n`);
for (const id of kept.keys()) local.delete(id);
if (local.size) {
  mkdirSync(dirname(localPath), { recursive: true });
  const localApps = [...local.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(localPath, `${JSON.stringify({ schema: 2, apps: localApps }, null, 2)}\n`);
}
if (failed.length) process.exitCode = 1;
