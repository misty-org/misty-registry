import assert from "node:assert/strict";
import test from "node:test";
import { entryProblems, mirrorName, skillProblems, templateProblems } from "./lib.ts";

const good = {
  id: "photocraft", name: "PhotoCraft", description: "Open-source image editor", maker: "storytold",
  upstream: "storytold/photocraft", license: "MIT OR Apache-2.0", version: "0.23.1", tag: "v0.23.1",
  source: "https://github.com/storytold/photocraft/releases/download/v0.23.1/photocraft-web-0.23.1.zip",
  url: `https://registry.mistysys.com/apps/${mirrorName("photocraft", "0.23.1", "a".repeat(64))}`,
  sha256: "a".repeat(64), size: 16064050,
  logo: "https://raw.githubusercontent.com/storytold/photocraft/v0.23.1/assets/icon.png",
  permissions: ["files"],
  manifest: { name: "PhotoCraft", logo: "logo.png", entry: "index.html", permissions: ["files"], own_origin: true },
  add_copies: [{ from: "snippets", to: "app/snippets" }], strip_top: true,
};

test("a complete entry has no problems", () => assert.deepEqual(entryProblems(good), []));

test("an entry that could not be trusted is refused", () => {
  for (const bad of [
    { ...good, id: "Photo Craft" },
    { ...good, license: "Proprietary" },
    { ...good, version: "../x" },
    { ...good, url: "http://registry.mistysys.com/apps/photocraft-0.23.1-aaaaaaaaaaaa.zip" },
    // A bundle served from anywhere but the registry's own address, or a mirror of anything but the maker's release.
    { ...good, url: good.source },
    { ...good, url: "https://registry.mistysys.com/apps/photocraft-0.23.1-bbbbbbbbbbbb.zip" },
    { ...good, source: "https://github.com/misty-org/misty-apps/releases/download/v1/a.zip" },
    { ...good, sha256: "ABC" },
    { ...good, size: 0 },
    { ...good, logo: "https://example.com/icon.png" },
    { ...good, manifest: { ...good.manifest, permissions: ["root"] } },
    { ...good, manifest: { ...good.manifest, id: "other" } },
    { ...good, manifest: { ...good.manifest, entry: "../index.html" } },
    { ...good, add_copies: [{ from: "../x", to: "y" }] },
    { ...good, strip_top: "yes" },
    { ...good, maker: "" },
  ]) assert.notDeepEqual(entryProblems(bad), [], JSON.stringify(bad).slice(0, 120));
});

import { readFileSync } from "node:fs";
import { engineProblems, speechProblems } from "./lib.ts";

const parakeet = JSON.parse(readFileSync(new URL("../speech/hearing/parakeet-tdt-0-6b-v3.json", import.meta.url), "utf8"));
const heart = JSON.parse(readFileSync(new URL("../speech/voices/kokoro-heart.json", import.meta.url), "utf8"));

test("the listed speech models and voices have no problems", () => {
  assert.deepEqual(speechProblems(parakeet, "hearing"), []);
  assert.deepEqual(speechProblems(heart, "voices"), []);
});

test("a speech model that isn't open, or comes from elsewhere, is refused", () => {
  for (const bad of [
    { ...parakeet, license: "CC-BY-NC-4.0" },
    { ...parakeet, credit: undefined },
    { ...parakeet, family: "unknown" },
    { ...parakeet, languages: ["english"] },
    { ...parakeet, package: { ...parakeet.package, url: "https://example.com/model.tar.bz2" } },
    { ...parakeet, package: { ...parakeet.package, sha256: "x" } },
    { ...parakeet, files: { encoder: "../encoder.onnx" } },
  ]) assert.notDeepEqual(speechProblems(bad, "hearing"), []);
  assert.notDeepEqual(speechProblems({ ...heart, gender: "unknown" }, "voices"), []);
});

test("an engine entry says only how it installs", () => {
  const claude = { id: "claude", name: "Claude Code", install: { route: "maker-build", npm: "@anthropic-ai/claude-code" } };
  assert.deepEqual(engineProblems(claude), []);
  assert.notDeepEqual(engineProblems({ ...claude, models: ["opus"] }), []);
  assert.notDeepEqual(engineProblems({ ...claude, install: { route: "npm" } }), []);
});

import { ignoreProblems } from "./lib.ts";

const node = JSON.parse(readFileSync(new URL("../ignore/node.json", import.meta.url), "utf8"));

test("the ignore templates have no problems", () => {
  for (const id of ["java", "node", "python", "rust", "unity", "video", "xcode"]) {
    const entry = JSON.parse(readFileSync(new URL(`../ignore/${id}.json`, import.meta.url), "utf8"));
    assert.deepEqual(ignoreProblems(entry), []);
  }
});

test("an ignore template only leaves things out", () => {
  assert.notDeepEqual(ignoreProblems({ ...node, rules: ["!keep.txt"] }), []);
  assert.notDeepEqual(ignoreProblems({ ...node, rules: ["a\nb"] }), []);
  assert.notDeepEqual(ignoreProblems({ ...node, markers: ["../package.json"] }), []);
  assert.notDeepEqual(ignoreProblems({ ...node, markers: [] }), []);
  assert.notDeepEqual(ignoreProblems({ ...node, script: "x" }), []);
});

const skill = JSON.parse(readFileSync(new URL("../skills/mcp-builder.json", import.meta.url), "utf8"));
const template = JSON.parse(readFileSync(new URL("../templates/ui-designer.json", import.meta.url), "utf8"));

test("a skill and a template are pinned to a commit in their maker's repository", () => {
  assert.deepEqual(skillProblems(skill), []);
  assert.deepEqual(templateProblems(template), []);
  for (const bad of [
    { ...skill, source: { ...skill.source, commit: "main" } },
    { ...skill, source: { ...skill.source, path: "../x" } },
    { ...skill, license: "Proprietary" },
    { ...skill, extra: true },
  ]) assert.notDeepEqual(skillProblems(bad), [], JSON.stringify(bad).slice(0, 120));
  for (const bad of [
    { ...template, source: { ...template.source, path: "design/ui" } },
    { ...template, category: "Design Team" },
    { ...template, category: "made-up" },
  ]) assert.notDeepEqual(templateProblems(bad), [], JSON.stringify(bad).slice(0, 120));
});

import { categorize, cut, detectLicense, frontmatter, title } from "./crawl_lib.ts";
import { dedupe } from "./kinds.ts";
import { sourceConfigProblems } from "./lib.ts";

test("a source's files are read as the crawl needs them", () => {
  const meta = frontmatter('---\nname: "UI Designer"\ndescription: >\n  Expert UI\n  designer\nlicense: MIT\n---\n# Body');
  assert.equal(meta.name, "UI Designer");
  assert.equal(meta.description, "Expert UI designer");
  assert.equal(detectLicense("Apache License\nVersion 2.0, January 2004"), "Apache-2.0");
  assert.equal(detectLicense("MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy"), "MIT");
  assert.equal(detectLicense("All rights reserved. Proprietary."), null);
  assert.equal(title("frontend-design"), "Frontend design");
  assert.equal(title("UI Designer"), "UI Designer");
  assert.equal(categorize("security-auditing"), "security");
  assert.equal(categorize("", "Frontend design", "visual interfaces"), "design");
  assert.equal(categorize("zzz"), "general");
  assert.equal(cut("a ".repeat(200), 20).length <= 20, true);
});

test("a source names a public repository and what to read in it", () => {
  const source = JSON.parse(readFileSync(new URL("../sources/wshobson-agents.json", import.meta.url), "utf8"));
  assert.deepEqual(sourceConfigProblems(source), []);
  for (const bad of [
    { ...source, repo: "not a repo" },
    { ...source, skills: undefined, templates: undefined, plugins: undefined },
    { ...source, skills: { paths: ["../x"] } },
    { ...source, templates: { match: "(" } },
    { ...source, extra: 1 },
  ]) assert.notDeepEqual(sourceConfigProblems(bad), [], JSON.stringify(bad).slice(0, 100));
});

test("the same thing found in two sources is listed once, under the source that comes first", () => {
  const a = { id: "one-x", source: { repo: "a/a", path: "skills/x" }, digest: "d".repeat(32) };
  const b = { id: "two-x", source: { repo: "b/b", path: "skills/x" }, digest: "d".repeat(32) };
  const c = { id: "two-y", source: { repo: "b/b", path: "skills/y" }, digest: "e".repeat(32) };
  const kept = dedupe([{ entry: b, priority: 20 }, { entry: a, priority: 10 }, { entry: c, priority: 20 }]);
  assert.deepEqual(kept.map((entry) => entry.id), ["one-x", "two-y"]);
  assert.deepEqual(kept[0].also, [{ repo: "b/b", path: "skills/x" }]);
});

import { mcpProblems } from "./lib.ts";

test("an MCP server is reached at an address, run from a package, or both", () => {
  const hosted = JSON.parse(readFileSync(new URL("../mcps/notion.json", import.meta.url), "utf8"));
  assert.deepEqual(mcpProblems(hosted), []);
  const local = {
    id: "example", name: "Example", description: "Example tools", maker: "example", category: "development",
    package: { type: "npm", identifier: "@example/mcp", version: "1.2.3" }, env: [{ name: "EXAMPLE_KEY", secret: true, required: true }],
    registry: { name: "io.github.example/mcp" },
  };
  assert.deepEqual(mcpProblems(local), []);
  for (const bad of [
    { ...hosted, remote: undefined },
    { ...hosted, remote: { url: "http://mcp.notion.com/mcp" } },
    { ...local, package: { ...local.package, type: "apt" } },
    { ...local, env: [{ name: "1BAD", secret: true, required: true }] },
    { ...hosted, license: "MIT" },
  ]) assert.notDeepEqual(mcpProblems(bad), [], JSON.stringify(bad).slice(0, 100));
});

import { BLOBS_ORIGIN, makerLogin } from "./lib.ts";

test("what the blob steps add to the index is a blob on the registry, named by its checksum", () => {
  const hash = "b".repeat(64);
  const blob = { url: `${BLOBS_ORIGIN}${hash}`, sha256: hash, size: 1024 };
  assert.deepEqual(skillProblems({ ...skill, bundle: blob, avatar: blob.url }), []);
  for (const bad of [
    { ...skill, bundle: { ...blob, url: "https://example.com/x.tar.gz" } },
    { ...skill, bundle: { ...blob, sha256: "c".repeat(64) } },
    { ...skill, bundle: { ...blob, size: 0 } },
    { ...skill, bundle: { ...blob, type: "application/gzip" } },
    { ...skill, avatar: "https://github.com/anthropics.png" },
  ]) assert.notDeepEqual(skillProblems(bad), [], JSON.stringify(bad).slice(0, 120));
  assert.notDeepEqual(mcpProblems({ id: "x-y", name: "X", description: "X", maker: "x", category: "general", remote: { url: "https://x.example/mcp" }, bundle: blob }), []);
  const mirrored = { ...good, logo: blob.url, logo_source: good.logo, screenshots: [blob.url], screenshots_source: [`https://raw.githubusercontent.com/${good.upstream}/v1/shot.png`] };
  assert.deepEqual(entryProblems(mirrored), []);
  assert.notDeepEqual(entryProblems({ ...mirrored, logo_source: "https://example.com/icon.png" }), []);
  assert.notDeepEqual(entryProblems({ ...mirrored, logo: "https://example.com/icon.png" }), []);
  assert.notDeepEqual(entryProblems({ ...mirrored, screenshots: ["https://example.com/shot.png"] }), []);
  assert.deepEqual(speechProblems({ ...heart, sample: { ...blob, type: "audio/mpeg" } }, "voices"), []);
  assert.notDeepEqual(speechProblems({ ...heart, sample: { ...blob, type: "video/mp4" } }, "voices"), []);
  assert.notDeepEqual(speechProblems({ ...parakeet, sample: { ...blob, type: "audio/mpeg" } }, "hearing"), []);
  assert.equal(makerLogin(skill), "anthropics");
  assert.equal(makerLogin({ registry: { name: "io.github.ChromeDevTools/chrome-devtools-mcp" } }), "chromedevtools");
  assert.equal(makerLogin({ registry: { name: "com.example/mcp" } }), null);
});

test("an MCP package starts with the arguments its maker listed, or is passed over when Misty can't fill them", async () => {
  const { argsOf } = await import("./add_mcp.ts");
  assert.deepEqual(argsOf({ packageArguments: [{ type: "positional", value: "server" }, { type: "positional", value: "start" }] }), ["server", "start"]);
  assert.deepEqual(argsOf({ packageArguments: [{ type: "named", name: "--start", isRequired: true }] }), ["--start"]);
  assert.deepEqual(argsOf({ packageArguments: [{ type: "named", name: "--port", default: "3000" }, { type: "named", name: "--debug" }] }), ["--port", "3000"]);
  assert.deepEqual(argsOf({ runtimeArguments: [{ type: "positional", value: "mcp" }] }), ["mcp"]);
  assert.equal(argsOf({ packageArguments: [{ type: "positional", isRequired: true }] }), null);
  assert.equal(argsOf({ packageArguments: [{ type: "named", name: "--root", value: "{folder}" }] }), null);
  assert.equal(argsOf({ runtimeArguments: [{ type: "named", name: "--node-options", value: "x" }] }), null);
});
