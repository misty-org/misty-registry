// The registry's one content-addressed store: every file Misty fetches besides the index (a listing's bundle, an
// app's pictures, a maker's face, a voice's sample) is a blob named by the sha256 of its exact bytes, served at
// registry.mistysys.com/blobs/<sha256>, uploaded once and never replaced. Blobs are made in work/blobs/ (gitignored),
// each with a `<sha256>.type` beside it naming its content type, and ship_blobs.ts uploads what the bucket lacks.
// This file also holds the deterministic tar.gz writer bundles are made with, so the same files always make the same
// blob, and a streaming tar reader for the repositories' own tarballs.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { constants, crc32, deflateRaw } from "node:zlib";
import { BLOBS_ORIGIN } from "./lib.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BLOBS = join(root, "work", "blobs");
export const BLOB_NAME = /^[0-9a-f]{64}$/;

export type Blob = { url: string; sha256: string; size: number };

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const blobUrl = (hash: string) => `${BLOBS_ORIGIN}${hash}`;

/** Keeps `bytes` as a blob in work/blobs/ with its content type, and says where Misty will find it. */
export function put(bytes: Uint8Array, type: string): Blob {
  const hash = sha256(bytes);
  mkdirSync(BLOBS, { recursive: true });
  const file = join(BLOBS, hash);
  if (!existsSync(file)) {
    writeFileSync(`${file}.part`, bytes);
    renameSync(`${file}.part`, file);
  }
  writeFileSync(`${file}.type`, `${type}\n`);
  return { url: blobUrl(hash), sha256: hash, size: bytes.length };
}

/** The blobs made here, by name, and the content type each was put with. */
export function localBlobs() {
  if (!existsSync(BLOBS)) return new Map<string, string>();
  const found = new Map<string, string>();
  for (const name of readdirSync(BLOBS).filter((one) => BLOB_NAME.test(one)).sort()) {
    const type = existsSync(join(BLOBS, `${name}.type`)) ? readFileSync(join(BLOBS, `${name}.type`), "utf8").trim() : "";
    found.set(name, type || "application/octet-stream");
  }
  return found;
}

export type TarFile = { path: string; data: Uint8Array; executable?: boolean };

const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;

function header(name: string, prefix: string, size: number, mode: number, type: string) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write(octal(mode, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(0, 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write(type, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  block.write(octal(0, 8), 329, 8, "ascii");
  block.write(octal(0, 8), 337, 8, "ascii");
  block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

const pad = (size: number) => Buffer.alloc((512 - (size % 512)) % 512);

/** A path in ustar's name and prefix fields, or null when it needs a pax record (too long, or not plain ASCII). */
function split(path: string): [string, string] | null {
  if (!/^[\x20-\x7e]+$/.test(path)) return null;
  if (path.length <= 100) return [path, ""];
  for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) {
    if (at <= 155 && path.length - at - 1 <= 100 && path.length - at - 1 > 0) return [path.slice(at + 1), path.slice(0, at)];
  }
  return null;
}

function paxRecord(key: string, value: string) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
  return Buffer.from(`${length}${body}`);
}

/**
 * A ustar archive of `files` that depends on nothing but their paths, bytes and executable bits: entries sorted by
 * path, every time 0, owner 0:0 with no names, mode 0644 or 0755, and a pax record only for a path ustar can't hold.
 */
export function tar(files: TarFile[]) {
  const parts: Buffer[] = [];
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let at = 1; at < sorted.length; at++) {
    if (sorted[at].path === sorted[at - 1].path) throw new Error(`${sorted[at].path} is in the archive twice`);
  }
  for (const file of sorted) {
    const mode = file.executable ? 0o755 : 0o644;
    const fits = split(file.path);
    if (!fits) {
      const record = paxRecord("path", file.path);
      parts.push(header("PaxHeader", "", record.length, 0o644, "x"), record, pad(record.length));
    }
    const [name, prefix] = fits ?? [file.path.replace(/[^\x20-\x7e]/g, "_").slice(-100), ""];
    parts.push(header(name, prefix, file.data.length, mode, "0"), Buffer.from(file.data), pad(file.data.length));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const deflate = promisify(deflateRaw);

/**
 * Gzip with a fixed header (no name, time 0, unknown OS) around the deflate stream, so the same bytes always
 * compress to the same blob with one zlib build, wherever it runs.
 */
export async function gzip(bytes: Uint8Array) {
  const body = await deflate(bytes, { level: 9, memLevel: 9, windowBits: 15, strategy: constants.Z_DEFAULT_STRATEGY });
  const head = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff]);
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(bytes) >>> 0, 0);
  tail.writeUInt32LE(bytes.length % 2 ** 32, 4);
  return Buffer.concat([head, body, tail]);
}

export const tarGz = async (files: TarFile[]) => gzip(tar(files));

/** Reads exactly as many bytes as are asked for from a stream of chunks, or skips them without keeping them. */
class Bytes {
  private chunks: Buffer[] = [];
  private length = 0;
  private done = false;
  private iterator: AsyncIterator<Buffer>;
  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  private async fill(n: number) {
    while (this.length < n && !this.done) {
      const next = await this.iterator.next();
      if (next.done) this.done = true;
      else {
        this.chunks.push(next.value);
        this.length += next.value.length;
      }
    }
    return this.length >= n;
  }
  async take(n: number) {
    if (!(await this.fill(n))) return null;
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const head = this.chunks[0];
      const count = Math.min(head.length, n - at);
      head.copy(out, at, 0, count);
      at += count;
      if (count === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(count);
    }
    this.length -= n;
    return out;
  }
  async skip(n: number) {
    while (n > 0) {
      if (!this.length && !(await this.fill(1))) throw new Error("the archive ends inside a file");
      const head = this.chunks[0];
      const count = Math.min(head.length, n);
      n -= count;
      this.length -= count;
      if (count === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(count);
    }
  }
}

const field = (block: Buffer, start: number, length: number) => {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
};

function number(block: Buffer, start: number, length: number) {
  if (block[start] & 0x80) {
    let value = 0;
    for (let at = start + 1; at < start + length; at++) value = value * 256 + block[at];
    return value;
  }
  const text = field(block, start, length).trim();
  return text ? parseInt(text, 8) : 0;
}

function paxFields(data: Buffer) {
  const found: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const length = parseInt(data.subarray(at, space).toString("ascii"), 10);
    if (!length) break;
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) found[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return found;
}

export type TarEntry = {
  path: string;
  kind: "file" | "directory" | "link" | "other";
  size: number;
  mode: number;
  link: string;
  /** The entry's bytes; an entry that isn't read is skipped without being kept. */
  read: () => Promise<Buffer>;
};

/**
 * The entries of a tar stream (already ungzipped), one at a time, with pax and GNU long names applied. Only what the
 * caller reads is held in memory, so a large repository streams through.
 */
export async function* tarEntries(source: AsyncIterable<Buffer>): AsyncGenerator<TarEntry> {
  const bytes = new Bytes(source);
  let pax: Record<string, string> = {};
  let longName = "";
  let longLink = "";
  for (;;) {
    const block = await bytes.take(512);
    if (!block || block.every((byte) => byte === 0)) return;
    const type = String.fromCharCode(block[156] || 0x30);
    const size = number(block, 124, 12);
    const padded = size + ((512 - (size % 512)) % 512);
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      const data = await bytes.take(padded);
      if (!data) throw new Error("the archive ends inside a header");
      const body = data.subarray(0, size);
      if (type === "x") pax = paxFields(body);
      if (type === "L") longName = field(body, 0, body.length);
      if (type === "K") longLink = field(body, 0, body.length);
      continue;
    }
    const ustar = field(block, 257, 6).startsWith("ustar");
    const prefix = ustar ? field(block, 345, 155) : "";
    const name = field(block, 0, 100);
    const path = pax.path ?? (longName || (prefix ? `${prefix}/${name}` : name));
    const link = pax.linkpath ?? (longLink || field(block, 157, 100));
    const length = pax.size !== undefined ? Number(pax.size) : size;
    const total = length + ((512 - (length % 512)) % 512);
    pax = {};
    longName = "";
    longLink = "";
    const kind = type === "0" || type === "\0" || type === "7" ? "file" : type === "5" ? "directory" : type === "1" || type === "2" ? "link" : "other";
    let consumed = false;
    const entry: TarEntry = {
      path,
      kind,
      size: length,
      mode: number(block, 100, 8),
      link,
      read: async () => {
        if (consumed) throw new Error(`${path} was read already`);
        consumed = true;
        const data = await bytes.take(total);
        if (!data) throw new Error("the archive ends inside a file");
        return data.subarray(0, length);
      },
    };
    yield entry;
    if (!consumed) await bytes.skip(total);
  }
}
