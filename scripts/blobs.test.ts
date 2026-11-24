import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { tarEntries, tarGz } from "./blobs.ts";

const files = [
  { path: "SKILL.md", data: Buffer.from("---\nname: x\n---\n") },
  { path: "scripts/run.sh", data: Buffer.from("#!/bin/sh\n"), executable: true },
  { path: `${"deep/".repeat(40)}file.txt`, data: Buffer.from("long") },
  { path: "notes/café.md", data: Buffer.from("non-ascii") },
];

test("the same files always make the same bundle, whatever order they come in", async () => {
  const one = await tarGz(files);
  const two = await tarGz([...files].reverse());
  assert.deepEqual(one, two);
  assert.deepEqual([...one.subarray(0, 10)], [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff]);
});

test("a bundle reads back as the files it was made of, long and non-ASCII paths included", async () => {
  const read: Record<string, { data: string; mode: number }> = {};
  for await (const entry of tarEntries(Readable.from([gunzipSync(await tarGz(files))]))) {
    read[entry.path] = { data: (await entry.read()).toString(), mode: entry.mode };
  }
  assert.deepEqual(Object.keys(read).sort(), files.map((file) => file.path).sort());
  assert.equal(read["scripts/run.sh"].mode, 0o755);
  assert.equal(read["SKILL.md"].mode, 0o644);
  assert.equal(read["notes/café.md"].data, "non-ascii");
});
