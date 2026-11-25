import { CATEGORY_IDS, MOST_ALSO } from "./kinds.ts";

export const ID = /^[a-z][a-z0-9-]{1,62}$/;
export const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
/**
 * Licenses a listed app may carry: OSI-approved ones, copyleft included, since an app runs unmodified and apart from
 * Misty. Source-available licenses (BUSL, SSPL, Elastic, Commons Clause) aren't taken. The same list as misty's
 * `src-tauri/features/apps/resolve.rs`, plus the dual MIT/Apache choice.
 */
export const LICENSES = new Set([
  "0BSD", "AFL-3.0", "AGPL-3.0", "Apache-2.0", "Artistic-2.0", "BSD-2-Clause", "BSD-3-Clause", "BSD-3-Clause-Clear",
  "BSL-1.0", "ECL-2.0", "EPL-1.0", "EPL-2.0", "EUPL-1.1", "EUPL-1.2", "GPL-2.0", "GPL-3.0", "ISC", "LGPL-2.1",
  "LGPL-3.0", "LPPL-1.3c", "MIT", "MIT-0", "MPL-2.0", "MS-PL", "MS-RL", "MulanPSL-2.0", "NCSA", "OFL-1.1", "OSL-3.0",
  "PostgreSQL", "UPL-1.0", "Unlicense", "Zlib", "MIT OR Apache-2.0",
]);
export const PERMISSIONS = new Set(["files", "chat.post", "rooms", "members"]);
/** The most a maker's release may be, as Misty's installer allows. */
export const MAX_ZIP_BYTES = 256 * 1024 * 1024;

const safePath = (path) =>
  typeof path === "string" && path !== "" && !path.includes("\\") && !path.includes(":") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/**
 * The platforms Misty runs an app's MCP program on, confined by the OS (`program.rs` in misty's
 * `src-tauri/features/apps`). Windows waits until it runs in an AppContainer there.
 */
export const PLATFORMS = new Set([
  "macos-aarch64",
  "macos-x86_64",
  "linux-x86_64",
  "linux-aarch64",
]);
const FLAG = /^--[a-z][a-z0-9-]*$/;

/** An app's MCP server as a program of its maker's: its name, its arguments, and a release archive per platform. */
function programProblems(app, upstream) {
  const problems = [];
  const need = (ok, text) => ok || problems.push(`${app?.id ?? "?"}: ${text}`);
  const program = app.mcp_program;
  need(app.manifest?.mcp === "binary" || app.manifest?.mcp === "program", "an app with an mcp_program says mcp: program (or binary) in its manifest");
  need(
    typeof program?.program === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(program.program),
    "mcp_program.program must be the program's file name, without a folder or extension",
  );
  need(
    Array.isArray(program?.args) && program.args.length <= 16 && program.args.every((arg) => typeof arg === "string" && arg.length <= 100),
    "mcp_program.args must be a few short arguments",
  );
  // Misty keeps the program to the run's own folder with these; a program that can't be kept to it isn't run.
  need(FLAG.test(program?.read_root_flag ?? "") && FLAG.test(program?.write_root_flag ?? ""), "mcp_program needs its read and write root flags");
  // Variables the maker documents for running headless; Misty sets the ones that decide where a program loads from,
  // reads and writes itself.
  const reserved = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "IFS"]);
  need(
    program?.env === undefined ||
      (typeof program.env === "object" &&
        Object.entries(program.env).every(
          ([key, value]) =>
            /^[A-Z0-9_]{1,64}$/.test(key) && !reserved.has(key) && !key.startsWith("LD_") && !key.startsWith("DYLD_") &&
            typeof value === "string" && value.length <= 200,
        )),
    "mcp_program.env may set only the maker's own plain variables",
  );
  const builds = Object.entries(program?.builds ?? {});
  need(builds.length > 0, "mcp_program needs a build for at least one platform");
  for (const [platform, build] of builds) {
    need(PLATFORMS.has(platform), `mcp_program platform ${platform} isn't one Misty runs on`);
    need(
      typeof build?.url === "string" &&
        build.url.startsWith(`https://github.com/${upstream}/releases/download/`) &&
        (build.url.endsWith(".zip") || build.url.endsWith(".tar.gz")),
      `mcp_program ${platform} must be the maker's own .zip or .tar.gz release asset`,
    );
    need(typeof build?.sha256 === "string" && SHA256.test(build.sha256), `mcp_program ${platform} needs its sha256`);
    need(Number.isInteger(build?.size) && build.size > 0 && build.size <= MAX_ZIP_BYTES, `mcp_program ${platform} size must be within the limit`);
  }
  return problems;
}

export const MAX_SERVER_BYTES = 1024 * 1024 * 1024;
const SERVER_PLACEHOLDERS = new Set(["{port}", "{data}", "{parent}"]);

function serverProblems(app, upstream) {
  const problems = [];
  const need = (ok, text) => ok || problems.push(`${app?.id ?? "?"}: ${text}`);
  const server = app.server_program;
  need(app.manifest?.server === true, "an app with a server_program says server: true in its manifest");
  need(
    typeof server?.program === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(server.program),
    "server_program.program must be the program's file name, without a folder or extension",
  );
  const args = Array.isArray(server?.args) ? server.args : [];
  need(
    Array.isArray(server?.args) && args.length <= 24 &&
      args.every((arg) => typeof arg === "string" && arg.length <= 100 && (!arg.includes("{") || SERVER_PLACEHOLDERS.has(arg))),
    "server_program.args must be a few short arguments, with {port}, {data} and {parent} only as whole arguments",
  );
  need(args.includes("{port}"), "server_program.args must take the port Misty picks as {port}");
  need(typeof server?.ready === "string" && server.ready.length > 0 && server.ready.length <= 100, "server_program.ready must be the line its log prints once it serves");
  const reserved = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "IFS"]);
  need(
    server?.env === undefined ||
      (typeof server.env === "object" &&
        Object.entries(server.env).every(
          ([key, value]) =>
            /^[A-Z0-9_]{1,64}$/.test(key) && !reserved.has(key) && !key.startsWith("LD_") && !key.startsWith("DYLD_") &&
            typeof value === "string" && value.length <= 200,
        )),
    "server_program.env may set only the maker's own plain variables",
  );
  const builds = Object.entries(server?.builds ?? {});
  need(builds.length > 0, "server_program needs a build for at least one platform");
  for (const [platform, build] of builds) {
    need(PLATFORMS.has(platform), `server_program platform ${platform} isn't one Misty runs on`);
    need(
      typeof build?.url === "string" &&
        build.url.startsWith(`https://github.com/${upstream}/releases/download/`) &&
        (build.url.endsWith(".zip") || build.url.endsWith(".tar.gz")),
      `server_program ${platform} must be the maker's own .zip or .tar.gz release asset`,
    );
    need(typeof build?.sha256 === "string" && SHA256.test(build.sha256), `server_program ${platform} needs its sha256`);
    need(Number.isInteger(build?.size) && build.size > 0 && build.size <= MAX_SERVER_BYTES, `server_program ${platform} size must be within the limit`);
  }
  return problems;
}

export const SCRIPTS_ORIGIN = "https://registry.mistysys.com/files/";
/** Where every blob is served: a file named by the sha256 of its exact bytes, uploaded once and never replaced. */
export const BLOBS_ORIGIN = "https://registry.mistysys.com/blobs/";
/** The most a listing's bundle may be, compressed. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export const isBlobUrl = (url) => typeof url === "string" && url.startsWith(BLOBS_ORIGIN) && SHA256.test(url.slice(BLOBS_ORIGIN.length));

/** A blob as an entry names it: its address on the registry, which is its checksum, and its size. */
function blobProblems(blob, need, what, most, keys = ["url", "sha256", "size"]) {
  need(blob && typeof blob === "object", `${what} must be a blob`);
  need(typeof blob?.sha256 === "string" && SHA256.test(blob.sha256), `${what} sha256 must be 64 lowercase hex digits`);
  need(typeof blob?.url === "string" && blob.url === `${BLOBS_ORIGIN}${blob?.sha256}`, `${what} url must be its blob on the registry, named by its sha256`);
  need(Number.isInteger(blob?.size) && blob.size > 0 && blob.size <= most, `${what} size must be its bytes, within the limit`);
  need(Object.keys(blob ?? {}).every((key) => keys.includes(key)), `${what} says only ${keys.join(", ")}`);
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * The GitHub login whose face a listing wears: its repository's owner, or for an MCP server the owner its MCP registry
 * name says it is published by (`io.github.<login>/…`). Lowercase, as logins don't tell case apart.
 */
export function makerLogin(entry) {
  const owner = entry?.source?.repo?.split("/")[0] ?? /^io\.github\.([^/]+)\//.exec(entry?.registry?.name ?? "")?.[1];
  return typeof owner === "string" && LOGIN.test(owner) ? owner.toLowerCase() : null;
}

/**
 * A picture the registry mirrored: the entry's field is then its blob and `<field>_source` the address it was copied
 * from, which must pass the same check the field would without the mirror.
 */
const mirroredPicture = (app, key, ok) =>
  app?.[`${key}_source`] === undefined ? app?.[key] === undefined || ok(app[key]) : isBlobUrl(app?.[key]) && ok(app[`${key}_source`]);
export const MAX_SCRIPT_BYTES = 256 * 1024;

function scriptProblems(file, need, what, { local = false } = {}) {
  need(file && typeof file === "object", `${what} needs its file`);
  need(typeof file?.sha256 === "string" && SHA256.test(file.sha256), `${what} sha256 must be 64 lowercase hex digits`);
  need(Number.isInteger(file?.size) && file.size > 0 && file.size <= MAX_SCRIPT_BYTES, `${what} size must be its bytes, within 256 KB`);
  need(
    typeof file?.url === "string" &&
      (file.url === `${SCRIPTS_ORIGIN}${file.sha256}.js` || (local && file.url.startsWith("file:///") && file.url.endsWith(`/${file.sha256}.js`))),
    `${what} is a script on the registry's address, named by its checksum`,
  );
  need(!("content" in (file ?? {})), `${what} carries no source: Misty fetches it by its checksum`);
}

/** Problems with one registry entry, as sentences. An empty list means it is fit to ship. */
export const BUILDS_ORIGIN = "https://registry.mistysys.com/apps/";

/**
 * The name a maker's release is mirrored under in the bucket: the app, its version and the start of its checksum, so a
 * zip is uploaded once and never replaced.
 */
export const mirrorName = (id, version, sha256) => `${id}-${version}-${String(sha256).slice(0, 12)}.zip`;

export function entryProblems(app, { local = false } = {}) {
  const problems = [];
  const need = (ok, text) => ok || problems.push(`${app?.id ?? "?"}: ${text}`);
  const upstream = typeof app?.upstream === "string" ? app.upstream : "";
  need(typeof app?.id === "string" && ID.test(app.id), "id must be lowercase letters, digits and hyphens");
  need(typeof app?.name === "string" && app.name.trim() !== "", "needs a name");
  need(
    app?.description === undefined || (typeof app.description === "string" && app.description.length <= 200),
    "description must be a short line",
  );
  need(typeof app?.maker === "string" && app.maker.trim() !== "", "needs a maker, who is credited in the directory");
  need(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(upstream), "upstream must be the maker's repository, owner/name");
  need(LICENSES.has(app?.license), `license ${JSON.stringify(app?.license)} isn't one Misty may carry`);
  need(typeof app?.version === "string" && VERSION.test(app.version), "version must be one folder name");
  need(typeof app?.tag === "string" && VERSION.test(app.tag), "tag must be the release's tag");
  // Every bundle is served from the registry's own address. A built app is the zip the registry made; any other is a
  // mirror of the maker's own release, whose address (`source`) is kept so the copy can be checked against it.
  if (app?.built) {
    need(/^[0-9a-f]{40}$/.test(app?.commit ?? ""), "a built app names the upstream commit it was built from");
    need(app?.license === "MIT" || app?.license === "Apache-2.0", "a built app is MIT or Apache-2.0");
    need(
      typeof app?.url === "string" &&
        (app.url.startsWith(BUILDS_ORIGIN) || (local && app.url.startsWith("file:///"))) &&
        app.url.endsWith(".zip"),
      "a built app's url is its zip on the registry's own address",
    );
  } else {
    need(
      typeof app?.source === "string" &&
        app.source.startsWith(`https://github.com/${upstream}/releases/download/`) &&
        (app.source.endsWith(".zip") || app.source.endsWith(".war")),
      "source must be the maker's own release asset",
    );
    need(
      typeof app?.url === "string" && app.url === `${BUILDS_ORIGIN}${mirrorName(app?.id, app?.version, app?.sha256)}`,
      "url must be the mirror of the maker's release on the registry's own address, named by its checksum",
    );
  }
  need(typeof app?.sha256 === "string" && SHA256.test(app.sha256), "sha256 must be 64 lowercase hex digits");
  need(Number.isInteger(app?.size) && app.size > 0 && app.size <= MAX_ZIP_BYTES, "size must be the zip's bytes, within the limit");
  need(
    app?.logo !== undefined &&
      mirroredPicture(app, "logo", (url) => typeof url === "string" && url.startsWith(`https://raw.githubusercontent.com/${upstream}/`) && /\.(png|svg|webp)$/.test(url)),
    "logo must be the maker's own icon in their repository",
  );
  need(
    app?.icon_render === undefined || ["theme", "color", "plate-dark", "plate-light"].includes(app.icon_render),
    "icon_render must be theme, color, plate-dark or plate-light",
  );
  // Optional pictures for Explore, from the maker's repository at the pinned tag, like the logo.
  const picture = (url) =>
    typeof url === "string" && url.startsWith(`https://raw.githubusercontent.com/${upstream}/`) && /\.(png|jpg|jpeg|webp)$/.test(url);
  need(mirroredPicture(app, "banner", picture), "banner must be a picture in the maker's repository");
  const pictures = (list) => Array.isArray(list) && list.length <= 8 && list.every(picture);
  need(
    app?.screenshots_source === undefined
      ? app?.screenshots === undefined || pictures(app.screenshots)
      : pictures(app.screenshots_source) && Array.isArray(app?.screenshots) &&
          app.screenshots.length === app.screenshots_source.length && app.screenshots.every(isBlobUrl),
    "screenshots must be at most 8 pictures in the maker's repository",
  );
  const manifest = app?.manifest;
  need(manifest && typeof manifest === "object", "needs a manifest");
  if (manifest && typeof manifest === "object") {
    need(typeof manifest.name === "string" && safePath(manifest.entry) && manifest.entry.endsWith(".html"), "manifest needs a name and an html entry");
    need(safePath(manifest.logo), "manifest logo must be a path inside the bundle");
    need(!("id" in manifest) && !("version" in manifest), "manifest leaves out id and version, which the install fills in");
    need(
      Array.isArray(manifest.permissions) && manifest.permissions.every((p) => PERMISSIONS.has(p)) &&
        new Set(manifest.permissions).size === manifest.permissions.length,
      "permissions must be known and listed once",
    );
  }
  if (app?.mcp_program !== undefined) problems.push(...programProblems(app, upstream));
  if (app?.server_program !== undefined) problems.push(...serverProblems(app, upstream));
  need(app?.server_program !== undefined || app?.manifest?.server === undefined, "manifest server needs the app's server_program");
  need(Array.isArray(app?.add_copies) && app.add_copies.every((c) => safePath(c?.from) && safePath(c?.to)), "add_copies must be paths inside the bundle");
  need(app?.add_files === undefined || Array.isArray(app.add_files), "add_files must be a list");
  for (const file of Array.isArray(app?.add_files) ? app.add_files : []) {
    need(safePath(file?.path) && file.path.startsWith("misty/") && file.path.endsWith(".js"), "an added file is a script under misty/");
    scriptProblems(file, need, `added ${file?.path ?? "file"}`, { local });
  }
  need(typeof app?.strip_top === "boolean", "strip_top must say whether the release is in one folder");
  return problems;
}

/** Licenses a speech model may carry: open weights only, never non-commercial or behind an agreement. */
export const MODEL_LICENSES = new Set(["Apache-2.0", "MIT", "CC-BY-4.0", "CC0-1.0", "BSD-3-Clause"]);
/** The model families Misty's speech pipeline runs (sherpa-onnx, `voice_speech` in misty's `src-tauri`). */
export const HEARING_FAMILIES = new Set(["nemo_transducer", "qwen3_asr", "whisper", "moonshine", "omnilingual_ctc"]);
/** Where every speech package comes from: sherpa-onnx's own conversions of the makers' models. */
const MODEL_RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download/";
/** The most one speech package may be. */
export const MAX_MODEL_BYTES = 2 * 1024 * 1024 * 1024;
const LANGUAGE = /^(?:[a-z]{2,3}|\*)$/;
const FILE_ROLES = /^[a-z_]{1,32}$/;

function packageProblems(entry, need) {
  const pkg = entry?.package;
  need(pkg && typeof pkg === "object", "needs its package");
  if (!pkg || typeof pkg !== "object") return;
  need(typeof pkg.url === "string" && pkg.url.startsWith(MODEL_RELEASES), "package url must be a sherpa-onnx release asset");
  need(typeof pkg.sha256 === "string" && SHA256.test(pkg.sha256), "package sha256 must be 64 lowercase hex digits");
  need(Number.isInteger(pkg.size) && pkg.size > 0 && pkg.size <= MAX_MODEL_BYTES, "package size must be its bytes, within the limit");
  need(pkg.kind === "tar.bz2" || pkg.kind === "file", "package kind must be tar.bz2 or file");
  need(pkg.kind !== "tar.bz2" || safePath(pkg.folder), "an archive names the folder it unpacks to");
  need(pkg.mirror === undefined || pkg.mirror === `${BLOBS_ORIGIN}${pkg.sha256}`, "package mirror must be its blob, named by its sha256");
}

function filesProblems(entry, need) {
  const files = entry?.files;
  need(files && typeof files === "object" && Object.keys(files).length > 0, "needs its files");
  for (const [role, path] of Object.entries(files ?? {})) {
    need(FILE_ROLES.test(role), `file role ${role} must be a short lowercase name`);
    need(
      typeof path === "string" && path.split(",").every((part) => safePath(part)),
      `file ${role} must be paths inside the package`,
    );
  }
}

/** Problems with one speech entry (`hearing` or `support`), as sentences. */
export function speechProblems(entry, group) {
  const problems = [];
  const need = (ok, text) => ok || problems.push(`speech/${group}/${entry?.id ?? "?"}: ${text}`);
  need(typeof entry?.id === "string" && ID.test(entry.id), "id must be lowercase letters, digits and hyphens");
  need(typeof entry?.name === "string" && entry.name.trim() !== "", "needs a name");
  need(typeof entry?.maker === "string" && entry.maker.trim() !== "", "needs its maker, who is credited");
  need(typeof entry?.source === "string" && entry.source.startsWith("https://"), "needs the maker's page");
  need(MODEL_LICENSES.has(entry?.license), `license ${JSON.stringify(entry?.license)} isn't an open one Misty may carry`);
  need(entry?.license !== "CC-BY-4.0" || (typeof entry?.credit === "string" && entry.credit.length > 0), "a CC BY model names its credit");
  packageProblems(entry, need);
  filesProblems(entry, need);
  if (group === "support") {
    need(entry?.role === "vad", "a support model's role must be vad");
    return problems;
  }
  need(
    Array.isArray(entry?.languages) && entry.languages.length > 0 && entry.languages.every((code) => LANGUAGE.test(code)),
    "languages must be language codes, or * for any",
  );
  need(Number.isInteger(entry?.disk_mb) && entry.disk_mb > 0, "disk_mb must be its size unpacked");
  need(Number.isInteger(entry?.memory_mb) && entry.memory_mb > 0, "memory_mb must be what it takes to run");
  need(group === "hearing", `speech/${group} isn't a kind Misty lists`);
  need(HEARING_FAMILIES.has(entry?.family), `family ${JSON.stringify(entry?.family)} isn't one Misty runs`);
  need(typeof entry?.description === "string" && entry.description.length <= 80, "needs a short description");
  need(typeof entry?.detects_language === "boolean", "detects_language must be true or false");
  need(typeof entry?.words === "boolean", "words must say whether it times each word");
  need([1, 2, 3].includes(entry?.accuracy) && [1, 2, 3].includes(entry?.speed), "accuracy and speed are 1 to 3");
  need(entry?.sample === undefined, "a speech model has no sample");
  return problems;
}

export const ENGINE_ROUTES = new Set(["maker-build", "npm", "script", "none"]);
const NPM = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Problems with one engine entry: how Misty installs it and where it comes from, nothing else. */
export function engineProblems(entry) {
  const problems = [];
  const need = (ok, text) => ok || problems.push(`engines/${entry?.id ?? "?"}: ${text}`);
  need(typeof entry?.id === "string" && ID.test(entry.id), "id must be lowercase letters, digits and hyphens");
  need(typeof entry?.name === "string" && entry.name.trim() !== "", "needs a name");
  need(entry?.maker === undefined || (typeof entry.maker === "string" && entry.maker.trim() !== ""), "maker must be a name");
  need(entry?.source === undefined || (typeof entry.source === "string" && entry.source.startsWith("https://")), "source must be an https page");
  const install = entry?.install;
  need(install && ENGINE_ROUTES.has(install.route), "install.route must be maker-build, npm, script or none");
  need(install?.npm === undefined || NPM.test(install.npm), "install.npm must be an npm package name");
  need(install?.route !== "npm" || typeof install?.npm === "string", "an npm engine names its package");
  need(install?.windows === undefined || install.windows === "npm", "install.windows may only say npm");
  const allowed = new Set(["id", "name", "maker", "source", "install"]);
  need(Object.keys(entry ?? {}).every((key) => allowed.has(key)), "an engine entry says only how it installs and where it comes from");
  return problems;
}

const MARKER = /^(?:\*\.[A-Za-z0-9][A-Za-z0-9._-]{0,31}|[A-Za-z0-9][A-Za-z0-9._ -]{0,63})\/?$/;

/**
 * Problems with one ignore template: the lines Misty offers to add to a folder's .mistyignore when the folder holds
 * one of its markers (a file's name, `*.ext` for any name ending so, a trailing `/` for a folder).
 */
export function ignoreProblems(entry) {
  const problems = [];
  const need = (ok, text) => ok || problems.push(`ignore/${entry?.id ?? "?"}: ${text}`);
  need(typeof entry?.id === "string" && ID.test(entry.id), "id must be lowercase letters, digits and hyphens");
  need(typeof entry?.name === "string" && entry.name.trim() !== "" && entry.name.length <= 40, "needs a short name");
  need(
    Array.isArray(entry?.markers) && entry.markers.length > 0 && entry.markers.length <= 16 &&
      entry.markers.every((marker) => typeof marker === "string" && MARKER.test(marker)),
    "markers must be a few file or folder names, or *.ext",
  );
  need(
    Array.isArray(entry?.rules) && entry.rules.length > 0 && entry.rules.length <= 100 &&
      entry.rules.every(
        (rule) =>
          typeof rule === "string" && rule.trim() === rule && rule !== "" && rule.length <= 200 &&
          !/[\r\n]/.test(rule) && !rule.startsWith("#") && !rule.startsWith("!"),
      ),
    "rules must be .gitignore lines that leave things out, one per entry",
  );
  need(new Set(entry?.rules ?? []).size === (entry?.rules ?? []).length, "a rule is listed twice");
  const allowed = new Set(["id", "name", "markers", "rules"]);
  need(Object.keys(entry ?? {}).every((key) => allowed.has(key)), "an ignore template says only its name, markers and rules");
  return problems;
}

/** Where a listing comes from: a folder or file of a public repository, at one full commit. */
function sourceProblems(source, need, what) {
  need(source && typeof source === "object", `${what} needs its source`);
  if (!source || typeof source !== "object") return;
  need(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repo ?? ""), `${what} repo must be the maker's repository, owner/name`);
  need(/^[0-9a-f]{40}$/.test(source.commit ?? ""), `${what} commit must be the full commit it is pinned to`);
  need(source.path === "." || safePath(source.path), `${what} path must be a path inside the repository, or . for its top`);
  need(Object.keys(source).every((key) => ["repo", "commit", "path"].includes(key)), `${what} says only its repo, commit and path`);
}

const REGISTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * What every listing says, whatever its kind: who made it, what it is, how it is filed and where it came from, the
 * other places the same thing was found, and its `rank`, how it sorts among its kind (its repository's stars). A
 * listing of files comes from a maker's repository at a commit (`source`, with its `license`); an MCP server is picked
 * by hand and carries no license, since nothing of it is copied. `extra` names what a kind adds.
 */
function listingProblems(entry, folder: string, from: "repo" | "hand", extra: string[]) {
  const problems: string[] = [];
  const need = (ok, text) => ok || problems.push(`${folder}/${entry?.id ?? "?"}: ${text}`);
  need(typeof entry?.id === "string" && ID.test(entry.id), "id must be lowercase letters, digits and hyphens");
  need(typeof entry?.name === "string" && entry.name.trim() !== "" && entry.name.length <= 80, "needs a short name");
  need(typeof entry?.description === "string" && entry.description.trim() !== "" && entry.description.length <= 200, "needs a short description");
  need(typeof entry?.maker === "string" && entry.maker.trim() !== "", "needs its maker, who is credited");
  need(CATEGORY_IDS.has(entry?.category), "category must be one of the registry's categories");
  need(entry?.digest === undefined || /^[0-9a-f]{32}$/.test(entry.digest), "digest must be 32 lowercase hex digits");
  need(entry?.rank === undefined || (Number.isInteger(entry.rank) && entry.rank >= 0), "rank must be a count, such as its repository's stars");
  const same = (other) =>
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(other?.repo ?? "") && (other?.path === "." || safePath(other?.path));
  need(
    entry?.also === undefined || (Array.isArray(entry.also) && entry.also.length <= MOST_ALSO && entry.also.every(same)),
    "also must name the other places with the same thing",
  );
  // What the index adds to a listing: its bundle, exactly what it is at its pinned commit, and its maker's face, both
  // blobs on the registry (`scripts/bundle.ts`, `scripts/mirror_images.ts`).
  need(entry?.avatar === undefined || isBlobUrl(entry.avatar), "avatar must be a blob on the registry");
  if (entry?.bundle !== undefined) {
    need(from === "repo", "only a listing of files from a repository has a bundle");
    blobProblems(entry.bundle, need, "bundle", MAX_BUNDLE_BYTES);
  }
  const allowed = ["id", "name", "description", "maker", "category", "digest", "also", "rank", "avatar", "bundle", ...extra];
  if (from === "repo") {
    allowed.push("license", "source");
    need(LICENSES.has(entry?.license), `license ${JSON.stringify(entry?.license)} isn't one Misty may carry`);
    sourceProblems(entry?.source, need, "source");
  }
  need(Object.keys(entry ?? {}).every((key) => allowed.includes(key)), `a ${folder} entry says only ${allowed.join(", ")}`);
  return { problems, need };
}

/** A skill (`skills/<id>.json`): a folder holding a `SKILL.md`, pinned in its maker's repository; nothing of it is kept here. */
export function skillProblems(entry) {
  return listingProblems(entry, "skills", "repo", []).problems;
}

/** An agent template (`templates/<id>.json`): a Markdown file of ready-made instructions to start an agent from. */
export function templateProblems(entry) {
  const { problems, need } = listingProblems(entry, "templates", "repo", []);
  need(typeof entry?.source?.path === "string" && entry.source.path.endsWith(".md"), "a template's path is its Markdown file");
  return problems;
}

/**
 * A plugin (`plugins/<id>.json`): a bundle in a marketplace of its maker's repository, pinned at one commit. It says
 * what it brings (`includes`) so a person can tell a plugin of skills from one of agents, commands or tools.
 */
export function pluginProblems(entry) {
  const { problems, need } = listingProblems(entry, "plugins", "repo", ["includes"]);
  const includes = entry?.includes;
  need(includes && typeof includes === "object", "needs what it includes");
  if (includes && typeof includes === "object") {
    for (const key of ["skills", "agents", "commands"]) need(Number.isInteger(includes[key]) && includes[key] >= 0, `includes.${key} must be a count`);
    for (const key of ["hooks", "mcp"]) need(typeof includes[key] === "boolean", `includes.${key} must say whether it has them`);
    need(Object.keys(includes).every((key) => ["skills", "agents", "commands", "hooks", "mcp"].includes(key)), "includes says only skills, agents, commands, hooks and mcp");
    need(includes.skills > 0 || includes.agents > 0 || includes.commands > 0 || includes.hooks === true || includes.mcp === true, "a plugin brings at least one skill, agent, command, hook or MCP server");
  }
  return problems;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** The package kinds Misty runs a server from, in the order it prefers them: npx, uvx, then a container. */
export const PACKAGE_TYPES = ["npm", "pypi", "oci"];

/**
 * An MCP server (`mcps/<id>.json`), picked by hand: only big names are listed, and anyone may ask for one by pull
 * request (`npm run add:mcp`). It is reached at its maker's https address (`remote`, signed in to the way Misty's own
 * sign-in offers), run from a package its maker published at an exact version (`package`, with the variables it asks
 * for in `env`), or both. `registry` names it in the MCP registry, where its versions come from.
 */
export function mcpProblems(entry) {
  const { problems, need } = listingProblems(entry, "mcps", "hand", ["homepage", "remote", "package", "env", "registry"]);
  need(entry?.remote !== undefined || entry?.package !== undefined, "an MCP server is reached at an address (remote), run from a package, or both");
  need(entry?.homepage === undefined || (typeof entry.homepage === "string" && /^https:\/\/\S+$/.test(entry.homepage)), "homepage must be the maker's https page");
  if (entry?.remote !== undefined) {
    need(
      typeof entry.remote?.url === "string" && /^https:\/\/[^\s{}]+$/.test(entry.remote.url) && entry.remote.url.length <= 300 && Object.keys(entry.remote).length === 1,
      "remote says only its url, the server's https address",
    );
  }
  const pkg = entry?.package;
  if (pkg !== undefined) {
    need(pkg && typeof pkg === "object", "package must be an object");
    need(PACKAGE_TYPES.includes(pkg?.type), "package.type must be npm, pypi or oci, the kinds Misty runs");
    need(typeof pkg?.identifier === "string" && pkg.identifier.length > 0 && pkg.identifier.length <= 200 && !/\s/.test(pkg.identifier), "package.identifier must be the package's name");
    need(typeof pkg?.version === "string" && VERSION.test(pkg.version), "package.version must be one version");
    need(
      pkg?.args === undefined ||
        (Array.isArray(pkg.args) && pkg.args.length <= 32 && pkg.args.every((one) => typeof one === "string" && one.length > 0 && one.length <= 200 && !/[\n\r\0]/.test(one))),
      "package.args must be the arguments the server starts with, each one plain text",
    );
    need(Object.keys(pkg ?? {}).every((key) => ["type", "identifier", "version", "args"].includes(key)), "package says only its type, identifier, version and args");
  }
  need(
    entry?.env === undefined ||
      (Array.isArray(entry.env) && entry.env.length <= 16 &&
        entry.env.every(
          (one) =>
            ENV_NAME.test(one?.name ?? "") && typeof one?.secret === "boolean" && typeof one?.required === "boolean" &&
            Object.keys(one).every((key) => ["name", "secret", "required"].includes(key)),
        )),
    "env must list the variables it asks for, each with its name and whether it is secret and required",
  );
  if (entry?.registry !== undefined) {
    need(REGISTRY_NAME.test(entry.registry?.name ?? ""), "registry.name must be the server's name in the MCP registry");
    need(Object.keys(entry.registry ?? {}).every((key) => key === "name"), "registry says only its name");
  }
  return problems;
}

/**
 * A source (`sources/<id>.json`): a public repository the crawl reads plugins, skills and agent templates from.
 * Everything it finds is pinned to the commit it was read at.
 */
export function sourceConfigProblems(entry) {
  const problems: string[] = [];
  const need = (ok, text) => ok || problems.push(`sources/${entry?.id ?? "?"}: ${text}`);
  need(typeof entry?.id === "string" && ID.test(entry.id) && entry.id.length <= 32, "id must be lowercase letters, digits and hyphens, short enough to lead an entry's id");
  need(typeof entry?.name === "string" && entry.name.trim() !== "" && entry.name.length <= 60, "needs a short name");
  need(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry?.repo ?? ""), "repo must be the maker's repository, owner/name");
  need(entry?.maker === undefined || (typeof entry.maker === "string" && entry.maker.trim() !== ""), "maker must be a name");
  need(entry?.ref === undefined || /^[A-Za-z0-9._\/-]{1,100}$/.test(entry.ref), "ref must be a branch or tag name");
  need(entry?.limit === undefined || (Number.isInteger(entry.limit) && entry.limit >= 1 && entry.limit <= 1000), "limit is 1 to 1000");
  need(entry?.priority === undefined || (Number.isInteger(entry.priority) && entry.priority >= 1 && entry.priority <= 1000), "priority is 1 to 1000, the lowest winning when two sources list the same thing");
  need(entry?.skills !== undefined || entry?.templates !== undefined || entry?.plugins !== undefined, "a source holds plugins, skills, templates or any of them");
  for (const kind of ["skills", "templates", "plugins"]) {
    const part = entry?.[kind];
    if (part === undefined) continue;
    need(part && typeof part === "object" && !Array.isArray(part), `${kind} must be an object`);
    if (!part || typeof part !== "object") continue;
    const allowed = kind === "skills" ? ["paths"] : kind === "templates" ? ["paths", "match"] : ["index"];
    need(Object.keys(part).every((key) => allowed.includes(key)), `${kind} says only ${allowed.join(", ")}`);
    need(
      part.paths === undefined || (Array.isArray(part.paths) && part.paths.length <= 32 && part.paths.every(safePath)),
      `${kind}.paths must be folders inside the repository`,
    );
    need(part.index === undefined || safePath(part.index), "plugins.index must be the marketplace file inside the repository");
    need(kind !== "plugins" || part.index !== undefined, "plugins.index names the marketplace file, usually .claude-plugin/marketplace.json");
    if (part.match !== undefined) {
      let valid = typeof part.match === "string" && part.match.length <= 120;
      if (valid) {
        try {
          new RegExp(part.match);
        } catch {
          valid = false;
        }
      }
      need(valid, "templates.match must be a short regular expression");
    }
  }
  need(
    Object.keys(entry ?? {}).every((key) => ["id", "name", "repo", "maker", "ref", "limit", "priority", "skills", "templates", "plugins"].includes(key)),
    "a source says only its name, repo, maker, ref, limit, priority and what it holds",
  );
  return problems;
}
