// Renders one short sample of each voice in speech/voices/ for Explore to play before anyone downloads it, the way
// Misty speaks: sherpa-onnx's own Node package (the version Misty's helper is built on) with the voice's own pinned
// package, its `files` and `speaker`, at Misty's settings (one sentence at a time, silence scale 0.2, speed 1), each
// sentence after the last. It is MP3 when ffmpeg is on the PATH, else WAV, kept as a blob (scripts/blobs.ts) and
// recorded in work/samples.json; build.ts adds each voice's `sample` to the index. A voice whose sentence, speaker,
// files and package haven't changed keeps its sample, and nothing is downloaded when every voice has one.
//   npm install --no-package-lock (for sherpa-onnx-node), then node scripts/voice_samples.ts [voice id...]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { put } from "./blobs.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES = join(root, "work", "samples.json");
const speech = join(root, "work", "speech");
/** The sherpa-onnx Misty's speech helper is built on (its `sherpa-onnx` crate), so a sample sounds as Misty will. */
const SHERPA = "2.0.2";

/**
 * What each voice says, in its first language: the languages Kokoro speaks. Misty splits text into sentences at
 * these marks, so each sample is two sentences spoken one after the other. A name in Latin letters isn't in the
 * Chinese, Japanese or Hindi lexicon and would be skipped, so those say none.
 */
const SENTENCES: Record<string, (name: string) => string> = {
  en: (name) => `Hi, I'm ${name}. This is how I sound.`,
  zh: () => "你好。这就是我的声音。",
  es: (name) => `Hola, soy ${name}. Así es como sueno.`,
  fr: (name) => `Bonjour, je suis ${name}. Voici ma voix.`,
  it: (name) => `Ciao, sono ${name}. Ecco come suono.`,
  pt: (name) => `Olá, eu sou ${name}. É assim que eu soo.`,
  ja: () => "こんにちは。これが私の声です。",
  hi: () => "नमस्ते। मेरी आवाज़ ऐसी है।",
};

type Voice = { id: string; name: string; languages: string[]; speaker: number; files: Record<string, string>; package: { url: string; sha256: string; size: number; kind: string; folder: string } };
type Sample = { url: string; sha256: string; size: number; type: string };
type Made = { text: string; speaker: number; files: Record<string, string>; package: string; sherpa: string; sample: Sample };

/** Misty's own sentence split (`sentences` in its speaking.rs). */
function sentences(text: string) {
  const out: string[] = [];
  let current = "";
  for (const character of text) {
    current += character;
    if (".!?。！？\n".includes(character) && current.trim().length > 1) {
      out.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

const threads = () => Math.min(4, Math.max(1, availableParallelism() - 1));

function wav(samples: Float32Array, rate: number) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, at) => data.writeInt16LE(Math.trunc(Math.max(-1, Math.min(1, sample)) * 32767), at * 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const hasFfmpeg = () => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** A voice's sample as an MP3 (mono, 64 kbit/s, no encoder tag) when ffmpeg is here, else the WAV itself. */
function encode(audio: Buffer, scratch: string) {
  if (!hasFfmpeg()) return { bytes: audio, type: "audio/wav" };
  const input = join(scratch, "sample.wav");
  const output = join(scratch, "sample.mp3");
  writeFileSync(input, audio);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", input, "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "64k", output], { stdio: "inherit" });
  return { bytes: readFileSync(output), type: "audio/mpeg" };
}

const sha256File = async (path: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

/** The voice's package, downloaded once into work/speech/, checked against its pinned sha256 and size, and unpacked. */
async function unpacked(pkg: Voice["package"]) {
  const folder = join(speech, pkg.sha256);
  const done = join(folder, ".unpacked");
  if (existsSync(done)) return join(folder, pkg.folder);
  mkdirSync(folder, { recursive: true });
  const archive = join(speech, `${pkg.sha256}.${pkg.kind}`);
  if (!existsSync(archive) || statSync(archive).size !== pkg.size || (await sha256File(archive)) !== pkg.sha256) {
    console.log(`downloading ${pkg.url} (${(pkg.size / 1024 / 1024).toFixed(0)} MB)`);
    const response = await fetch(pkg.url, { headers: { "user-agent": "misty-registry-samples" }, redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`${pkg.url} answered ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(archive));
    const hash = await sha256File(archive);
    if (hash !== pkg.sha256 || statSync(archive).size !== pkg.size) {
      rmSync(archive, { force: true });
      throw new Error(`${pkg.url} is ${hash}, pinned ${pkg.sha256}`);
    }
  }
  if (pkg.kind !== "tar.bz2") throw new Error(`a ${pkg.kind} package isn't one a voice comes in`);
  execFileSync("tar", ["-xjf", archive, "-C", folder]);
  writeFileSync(done, "");
  return join(folder, pkg.folder);
}

/** Opens the voice as Misty's helper does (`Voice::open` in its voice.rs). */
function open(sherpa: any, dir: string, files: Record<string, string>) {
  const path = (role: string) => (files[role] ? files[role].split(",").map((name) => join(dir, name.trim())).join(",") : undefined);
  return new sherpa.OfflineTts({
    model: {
      kokoro: { model: path("model"), voices: path("voices"), tokens: path("tokens"), lexicon: path("lexicon"), dictDir: path("dict") },
      numThreads: threads(),
      provider: "cpu",
    },
    maxNumSentences: 1,
    silenceScale: 0.2,
  });
}

const voices: Voice[] = readdirSync(join(root, "speech", "voices"))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(root, "speech", "voices", name), "utf8")));
const wanted = process.argv.slice(2);
const before: { schema: 1; voices: Record<string, Made> } = existsSync(SAMPLES) ? JSON.parse(readFileSync(SAMPLES, "utf8")) : { schema: 1, voices: {} };
const after: Record<string, Made> = {};
const todo: { voice: Voice; text: string }[] = [];
let failed = 0;
let rendered = 0;
for (const voice of voices) {
  const say = SENTENCES[voice.languages[0]];
  if (!say) {
    console.error(`${voice.id}: no sample sentence in ${voice.languages[0]}`);
    failed += 1;
    continue;
  }
  const text = say(voice.name);
  const prior = before.voices[voice.id];
  const same =
    prior && prior.text === text && prior.speaker === voice.speaker && prior.package === voice.package.sha256 &&
    prior.sherpa === SHERPA && JSON.stringify(prior.files) === JSON.stringify(voice.files);
  if (same || (wanted.length && !wanted.includes(voice.id))) {
    if (prior) after[voice.id] = prior;
    continue;
  }
  todo.push({ voice, text });
}

if (todo.length) {
  let sherpa: any;
  try {
    sherpa = (await import("sherpa-onnx-node")).default;
  } catch {
    throw new Error(`sherpa-onnx-node isn't installed: run npm install --no-package-lock (it is pinned at ${SHERPA})`);
  }
  const scratch = join(speech, "render");
  mkdirSync(scratch, { recursive: true });
  const opened = new Map<string, any>();
  for (const { voice, text } of todo) {
    try {
      const dir = await unpacked(voice.package);
      const key = `${voice.package.sha256}\0${JSON.stringify(voice.files)}`;
      if (!opened.has(key)) opened.set(key, open(sherpa, dir, voice.files));
      const tts = opened.get(key);
      const parts: Float32Array[] = [];
      let rate = 0;
      for (const sentence of sentences(text)) {
        const audio = tts.generate({ text: sentence.replace(/\0/g, " "), sid: voice.speaker, speed: 1, generationConfig: { sid: voice.speaker, speed: 1 } });
        parts.push(audio.samples);
        rate = Math.max(1, audio.sampleRate);
      }
      const samples = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
      let at = 0;
      for (const part of parts) {
        samples.set(part, at);
        at += part.length;
      }
      const { bytes, type } = encode(wav(samples, rate), scratch);
      const blob = put(bytes, type);
      after[voice.id] = { text, speaker: voice.speaker, files: voice.files, package: voice.package.sha256, sherpa: SHERPA, sample: { ...blob, type } };
      rendered += 1;
      console.log(`${voice.id}: ${(samples.length / rate).toFixed(1)}s, ${(bytes.length / 1024).toFixed(0)} KB ${type}`);
    } catch (error) {
      console.error(`${voice.id}: ${(error as Error).message}`);
      if (before.voices[voice.id]) after[voice.id] = before.voices[voice.id];
      failed += 1;
    }
  }
}

mkdirSync(dirname(SAMPLES), { recursive: true });
writeFileSync(SAMPLES, `${JSON.stringify({ schema: 1, voices: Object.fromEntries(Object.entries(after).sort(([a], [b]) => a.localeCompare(b))) })}\n`);
console.log(`work/samples.json: ${rendered} rendered, ${Object.keys(after).length} voices with a sample`);
if (failed) process.exitCode = 1;
