// Adds MCP servers to mcps/ by hand, from their entry in the official MCP registry (registry.modelcontextprotocol.io).
// Only big names are listed; anyone can ask for one, and this writes its file for review:
//   node scripts/add_mcp.ts <registry name>...         e.g. io.github.github/github-mcp-server
//   node scripts/add_mcp.ts --stars 1000                proposes every server whose repository has that many stars
// A hosted address is kept only if it signs in the way Misty offers (asked as Misty's own sign-in would); a package
// is pinned at the version listed.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { categorize, cut, digestOf, slug, starsOf } from "./crawl_lib.ts";
import { mcpProblems, PACKAGE_TYPES } from "./lib.ts";

const API = "https://registry.modelcontextprotocol.io/v0.1/servers";
const META = "io.modelcontextprotocol.registry/official";

async function page(cursor: string, search = "") {
  const query = new URLSearchParams({ version: "latest", limit: "100", ...(cursor ? { cursor } : {}), ...(search ? { search } : {}) });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(`${API}?${query}`, { headers: { "user-agent": "misty-registry-crawl" } });
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
  }
  throw new Error(`the MCP registry didn't answer for ${query}`);
}

/** Who made a server, from the namespace it is named under: `io.github.owner/x` is owner, `com.example/x` is example.com. */
export function makerOf(name: string) {
  const space = name.split("/")[0];
  const github = /^io\.github\.(.+)$/.exec(space);
  if (github) return github[1];
  return space.split(".").reverse().join(".");
}

/** An id for a server's name that stays within an id's length and never collides after cutting. */
export function idOf(name: string) {
  const whole = `x-${slug(name)}`.replace(/^x-([a-z])/, "$1");
  if (whole.length <= 63 && /^[a-z]/.test(whole)) return whole;
  const hash = digestOf(name).slice(0, 6);
  return `${whole.slice(0, 56).replace(/-+$/, "")}-${hash}`.replace(/^[^a-z]+/, "x");
}

/** The domain a host belongs to, so one service's hosts count as one: `mcp.example.co.uk` is example.co.uk. */
export function homeOf(host: string) {
  const labels = host.toLowerCase().split(".");
  const keep = labels.length >= 3 && ["co", "com", "org", "net"].includes(labels.at(-2)!) && labels.at(-1)!.length === 2 ? 3 : 2;
  return labels.slice(-keep).join(".");
}

const PROBE_MS = 10_000;

async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const jsonAt = (url: string) =>
  within(PROBE_MS, async (signal) => {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal, redirect: "follow" });
    return response.ok ? await response.json() : null;
  });

const field = (challenge: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(challenge)?.[1] ?? null;

/**
 * How a hosted server is reached, the way Misty's own sign-in finds out (`connected_apps/direct/oauth.rs`): `open`
 * answers with no sign-in; `keyless` asks for a sign-in that registers Misty there and then (OAuth with dynamic client
 * registration and PKCE), which is the only kind Misty offers; `needs_app` asks for a client registered beforehand;
 * anything else is `unreachable`.
 */
export async function access(server: string): Promise<"open" | "keyless" | "needs_app" | "unreachable"> {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return "unreachable";
  }
  const answer = await within(PROBE_MS, (signal) =>
    fetch(server, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Misty", version: "registry" } },
      }),
      signal,
    }),
  );
  if (!answer) return "unreachable";
  await answer.body?.cancel().catch(() => {});
  if (answer.ok) return "open";
  if (answer.status !== 401) return "unreachable";
  const challenge = answer.headers.get("www-authenticate") ?? "";
  const base = url.origin;
  const path = url.pathname.replace(/\/+$/, "");
  let metadata: any = null;
  const named = field(challenge, "resource_metadata");
  if (named) metadata = await jsonAt(named);
  for (const candidate of [`${base}/.well-known/oauth-protected-resource${path}`, `${base}/.well-known/oauth-protected-resource`]) {
    if (metadata) break;
    metadata = await jsonAt(candidate);
  }
  const issuer = String(metadata?.authorization_servers?.[0] ?? base).replace(/\/+$/, "");
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    return "unreachable";
  }
  const issuerPath = issuerUrl.pathname.replace(/\/+$/, "");
  let found: any = null;
  for (const candidate of [
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
    `${issuer}/.well-known/openid-configuration`,
  ]) {
    found = await jsonAt(candidate);
    if (found) break;
  }
  if (!found) return "unreachable";
  const methods = found.code_challenge_methods_supported;
  const pkce = !Array.isArray(methods) || methods.includes("S256");
  const has = (name: string) => typeof found[name] === "string";
  if (has("authorization_endpoint") && has("token_endpoint") && has("registration_endpoint") && pkce) return "keyless";
  if (has("authorization_endpoint") && has("token_endpoint")) return "needs_app";
  return "unreachable";
}

const githubRepo = (server: any) =>
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(server.repository?.url ?? ""))?.[1] ?? null;

/**
 * The arguments a package starts with, from what its maker wrote in the MCP registry: each fixed value, a named one
 * after its name, and a required named one with no value as the flag alone (`--start`). A fixed positional value
 * listed for the runtime is the program's own subcommand in practice (`firebase-tools mcp`), so it goes first. A
 * package that needs something only the person could fill in, or a flag for the runtime itself, is one Misty can't
 * start by itself, so it is passed over (null).
 */
export function argsOf(pkg: any): string[] | null {
  const args: string[] = [];
  for (const one of pkg.runtimeArguments ?? []) {
    if (one?.type !== "positional" || typeof one.value !== "string" || /[{}]/.test(one.value)) return null;
    args.push(one.value);
  }
  for (const one of pkg.packageArguments ?? []) {
    const value = typeof one?.value === "string" ? one.value : typeof one?.default === "string" ? one.default : undefined;
    if (one?.type === "named" && typeof one.name !== "string") return null;
    if (value === undefined) {
      if (one?.type === "named" && one.isRequired) args.push(one.name);
      else if (one?.isRequired || one?.type === "positional") return null;
      continue;
    }
    if (/[{}]/.test(value)) return null;
    if (one?.type === "named") args.push(one.name);
    args.push(value);
  }
  return args;
}

/** A registry entry as a listing, before its address is asked how it signs in. */
export function entryOf(item: any, rank = 0) {
  const server = item.server ?? item;
  const name = String(server.name ?? "");
  const remote = (Array.isArray(server.remotes) ? server.remotes : []).find(
    (one: any) =>
      ["streamable-http", "sse"].includes(one?.type) && typeof one.url === "string" && /^https:\/\/[^\s{}]+$/.test(one.url) && !one.variables &&
      !(one.headers ?? []).some((header: any) => header?.isRequired || header?.isSecret),
  );
  const runnable = (Array.isArray(server.packages) ? server.packages : []).filter(
    (one: any) =>
      PACKAGE_TYPES.includes(one?.registryType) && typeof one.identifier === "string" && typeof one.version === "string" &&
      (!one.transport?.type || one.transport.type === "stdio") && argsOf(one) !== null,
  );
  const pkg = runnable.sort((a: any, b: any) => PACKAGE_TYPES.indexOf(a.registryType) - PACKAGE_TYPES.indexOf(b.registryType))[0];
  const args = pkg ? argsOf(pkg) : null;
  const env = (pkg?.environmentVariables ?? [])
    .filter((one: any) => typeof one?.name === "string")
    .slice(0, 16)
    .map((one: any) => ({ name: one.name, secret: one.isSecret === true, required: one.isRequired === true }));
  return {
    id: idOf(name),
    name: cut(String(server.title || name.split("/")[1] || name), 80),
    description: cut(String(server.description ?? ""), 200),
    maker: makerOf(name),
    category: categorize(name.split("/")[1] ?? "", String(server.title ?? ""), String(server.description ?? "")),
    ...(rank ? { rank } : {}),
    ...(typeof server.websiteUrl === "string" && server.websiteUrl.startsWith("https://") ? { homepage: server.websiteUrl } : {}),
    ...(remote ? { remote: { url: remote.url } } : {}),
    ...(pkg ? { package: { type: pkg.registryType, identifier: pkg.identifier, version: pkg.version, ...(args?.length ? { args } : {}) } } : {}),
    ...(pkg && env.length ? { env } : {}),
    registry: { name },
  };
}

async function signsIn(entry: any) {
  if (!entry.remote) return entry;
  if ((await access(entry.remote.url)) === "keyless") return entry;
  const { remote, ...rest } = entry;
  return rest;
}

const listedAlready = (folder: string) => {
  const seen = new Set<string>();
  for (const name of readdirSync(folder).filter((file) => file.endsWith(".json"))) {
    const entry = JSON.parse(readFileSync(join(folder, name), "utf8"));
    if (entry.registry?.name) seen.add(entry.registry.name);
    if (entry.remote?.url) seen.add(homeOf(new URL(entry.remote.url).hostname));
    if (entry.package) seen.add(`${entry.package.type}:${entry.package.identifier}`);
  }
  return seen;
};

async function save(folder: string, entry: any, seen: Set<string>) {
  const home = entry.remote ? homeOf(new URL(entry.remote.url).hostname) : null;
  const pkg = entry.package ? `${entry.package.type}:${entry.package.identifier}` : null;
  if (seen.has(entry.registry.name) || (home && seen.has(home)) || (pkg && seen.has(pkg))) return `${entry.registry.name}: already listed`;
  const checked = await signsIn(entry);
  const problems = mcpProblems(checked);
  if (problems.length) return `${entry.registry.name}: ${problems.join("; ")}`;
  writeFileSync(join(folder, `${checked.id}.json`), `${JSON.stringify(checked, null, 2)}\n`);
  for (const key of [checked.registry.name, home, pkg]) if (key) seen.add(key);
  return `${checked.registry.name}: added as mcps/${checked.id}.json${entry.remote && !checked.remote ? " (its address takes no sign-in Misty offers, so only its package)" : ""}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const folder = join(root, "mcps");
  mkdirSync(folder, { recursive: true });
  const args = process.argv.slice(2);
  const seen = listedAlready(folder);
  if (args[0] === "--stars") {
    const least = Number(args[1]) || 1000;
    const all: any[] = [];
    let cursor = "";
    for (let pages = 0; pages < 2000; pages++) {
      const answer = await page(cursor);
      all.push(...(answer.servers ?? []).filter((item: any) => item._meta?.["io.modelcontextprotocol.registry/official"]?.status === "active"));
      cursor = answer.metadata?.nextCursor ?? "";
      if (!cursor) break;
    }
    mkdirSync(join(root, "work"), { recursive: true });
    const stars = await starsOf(all.map((item) => githubRepo(item.server)).filter(Boolean) as string[], join(root, "work", "stars.json"));
    const picked = all
      .map((item) => ({ item, rank: stars(githubRepo(item.server)) }))
      .filter((one) => one.rank >= least)
      .sort((a, b) => b.rank - a.rank);
    for (const one of picked) console.log(await save(folder, entryOf(one.item, one.rank), seen));
  } else {
    for (const name of args) {
      const answer = await page("", name);
      const item = (answer.servers ?? []).find((one: any) => one.server?.name === name);
      if (!item) {
        console.error(`${name}: not in the MCP registry`);
        process.exitCode = 1;
        continue;
      }
      const repo = githubRepo(item.server);
      const stars = repo ? await starsOf([repo], join(root, "work", "stars.json")) : () => 0;
      console.log(await save(folder, entryOf(item, stars(repo)), seen));
    }
  }
}
