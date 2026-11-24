import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ID, LICENSES, VERSION } from "./lib.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const builds = join(root, "builds");
const work = join(root, "work");
const out = join(work, "builds");
const COMMIT = /^[0-9a-f]{40}$/;
const SDK_REPOSITORY = "misty-org/misty-sdk";

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
const git = (cwd, ...args) => run("git", args, { cwd });

export function recipeOf(id) {
  const file = join(builds, id, "recipe.json");
  if (!existsSync(file)) throw new Error(`builds/${id}/recipe.json is missing`);
  const recipe = JSON.parse(readFileSync(file, "utf8"));
  const problems = [];
  if (recipe.id !== id || !ID.test(id)) problems.push("id must match its folder");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(recipe.upstream ?? "")) problems.push("upstream must be owner/name");
  if (!COMMIT.test(recipe.commit ?? "")) problems.push("commit must be the full commit the build is pinned to");
  if (!VERSION.test(recipe.version ?? "")) problems.push("version must be one folder name");
  if (!LICENSES.has(recipe.license) || !["MIT", "Apache-2.0", "MIT OR Apache-2.0"].includes(recipe.license)) {
    problems.push("license must be MIT or Apache-2.0");
  }
  if (recipe.paths !== undefined && !(Array.isArray(recipe.paths) && recipe.paths.every((path) => typeof path === "string"))) {
    problems.push("paths must list the folders the build needs");
  }
  if (recipe.sdk !== undefined && !COMMIT.test(recipe.sdk)) problems.push("sdk must be the full misty-sdk commit the build uses");
  if (!existsSync(join(builds, id, "build.sh"))) problems.push("build.sh is missing");
  if (problems.length) throw new Error(`builds/${id}: ${problems.join("; ")}`);
  return recipe;
}

export function fingerprint(id, recipe) {
  const files = execFileSync("git", ["ls-files", "-z", "--", join("builds", id)], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .sort();
  if (!files.length) throw new Error(`builds/${id} has no committed files`);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${relative(join("builds", id), file)}\0`);
    hash.update(readFileSync(join(root, file)));
    hash.update("\0");
  }
  hash.update(`sdk ${recipe.sdk ?? ""}`);
  return hash.digest("hex").slice(0, 12);
}

export function zipName(id, recipe) {
  return `${id}-web-${recipe.version}-${fingerprint(id, recipe)}.zip`;
}

export function pinOf(id, recipe, name, bytes) {
  return {
    id,
    version: recipe.version,
    commit: recipe.commit,
    ...(recipe.sdk ? { sdk: recipe.sdk } : {}),
    zip: name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

export function savePin(pin) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${pin.id}.json`), `${JSON.stringify(pin, null, 2)}\n`);
}

function fetchAt(upstream, commit, source, paths) {
  rmSync(source, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  git(source, "init", "--quiet");
  git(source, "remote", "add", "origin", `https://github.com/${upstream}.git`);
  if (paths) git(source, "sparse-checkout", "set", "--no-cone", ...paths.map((path) => `/${path}`));
  git(source, "fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", commit);
  git(source, "checkout", "--quiet", "FETCH_HEAD");
}

function sdkAt(commit) {
  const source = join(work, "src", `misty-sdk-${commit}`);
  const done = join(source, "packages", "sdk", "dist", "index.js");
  if (existsSync(done)) return join(source, "packages", "sdk");
  fetchAt(SDK_REPOSITORY, commit, source);
  run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: source });
  run("npm", ["run", "build"], { cwd: source });
  return join(source, "packages", "sdk");
}

function checkout(recipe) {
  const source = join(work, "src", recipe.id);
  const head = existsSync(join(source, ".git"))
    ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim()
    : "";
  if (head === recipe.commit) {
    git(source, "reset", "--hard", "--quiet");
    git(source, "clean", "-fdq", "-e", "node_modules");
    return source;
  }
  fetchAt(recipe.upstream, recipe.commit, source, recipe.paths);
  return source;
}

function patch(recipe, source) {
  const folder = join(builds, recipe.id, "patches");
  if (!existsSync(folder)) return;
  for (const file of readdirSync(folder).filter((name) => name.endsWith(".patch")).sort()) {
    git(source, "apply", "--whitespace=nowarn", join(folder, file));
  }
}

function zip(stage, target) {
  rmSync(target, { force: true });
  const files = execFileSync("find", [".", "-type", "f"], { cwd: stage, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((path) => path.replace(/^\.\//, ""))
    .sort();
  for (const file of files) run("touch", ["-t", "202001010000", file], { cwd: stage });
  execFileSync("zip", ["-X", "-q", "-D", "-@", target], { cwd: stage, input: files.join("\n") });
}

export function build(id) {
  const recipe = recipeOf(id);
  const sdk = recipe.sdk ? sdkAt(recipe.sdk) : null;
  const source = checkout(recipe);
  patch(recipe, source);
  const stage = join(work, "stage", id);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  run("bash", [join(builds, id, "build.sh")], {
    cwd: source,
    env: {
      ...process.env,
      SRC: source,
      OUT: stage,
      VERSION: recipe.version,
      RECIPE: join(builds, id),
      ...(sdk ? { MISTY_SDK: sdk } : {}),
    },
  });
  mkdirSync(out, { recursive: true });
  const name = zipName(id, recipe);
  const target = join(out, name);
  zip(stage, target);
  const pin = pinOf(id, recipe, name, readFileSync(target));
  savePin(pin);
  console.log(`${id}: ${name} ${pin.size} bytes, sha256 ${pin.sha256}`);
  return { recipe, pin, file: target };
}

export function recipeIds() {
  return readdirSync(builds).filter((name) => existsSync(join(builds, name, "recipe.json"))).sort();
}

export const BUILT = out;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const wanted = process.argv.slice(2);
  let failed = false;
  for (const id of wanted.length ? wanted : recipeIds()) {
    try {
      build(id);
    } catch (error) {
      console.error(`${id}: ${error.message}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}
