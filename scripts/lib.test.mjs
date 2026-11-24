import assert from "node:assert/strict";
import test from "node:test";
import { entryProblems, mirrorName } from "./lib.mjs";

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
import { engineProblems, speechProblems } from "./lib.mjs";

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

import { ignoreProblems } from "./lib.mjs";

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
