import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_SCRIPT_BYTES, SCRIPTS_ORIGIN } from "./lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "work", "files");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function scriptFile(path, { local = false } = {}) {
  const bytes = readFileSync(path);
  if (bytes.length > MAX_SCRIPT_BYTES) throw new Error(`${path} is larger than a script Misty adds may be`);
  const hash = sha256(bytes);
  const name = `${hash}.js`;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, name), bytes);
  return { url: local ? pathToFileURL(join(out, name)).href : `${SCRIPTS_ORIGIN}${name}`, sha256: hash, size: bytes.length };
}

export function scriptSources() {
  const found = new Map();
  const add = (path) => found.set(sha256(readFileSync(path)), path);
  const scripts = (folder) =>
    existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".js")).map((name) => join(folder, name)) : [];
  for (const path of scripts(join(root, "adapters"))) add(path);
  for (const kind of ["apps", "builds"]) {
    const folder = join(root, kind);
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) for (const path of scripts(join(folder, entry.name))) add(path);
    }
  }
  return found;
}

export function referencedScripts(apps) {
  const files = [];
  for (const app of apps) {
    for (const file of app.add_files ?? []) files.push({ id: app.id, ...file });
    if (app.adapter) files.push({ id: app.id, ...app.adapter });
  }
  return files;
}
