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

const SITE_PLATFORMS = new Set(["macos", "windows", "linux"]);
const ORIGIN = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function originAllows(origin, address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port || url.username) return false;
  const allowed = origin.slice("https://".length);
  if (!allowed.startsWith("*.")) return url.hostname === allowed;
  const domain = allowed.slice(1);
  return url.hostname.endsWith(domain) && url.hostname.length > domain.length;
}

export const SCRIPTS_ORIGIN = "https://registry.mistysys.com/files/";
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

function siteProblems(app) {
  const problems = [];
  const need = (ok, text) => ok || problems.push(`${app?.id ?? "?"}: ${text}`);
  need(typeof app?.id === "string" && ID.test(app.id), "id must be lowercase letters, digits and hyphens");
  need(typeof app?.name === "string" && app.name.trim() !== "", "needs a name");
  need(app?.description === undefined || (typeof app.description === "string" && app.description.length <= 200), "description must be a short line");
  need(typeof app?.maker === "string" && app.maker.trim() !== "", "needs a maker, who is credited in the directory");
  need(typeof app?.version === "string" && VERSION.test(app.version), "version must be one folder name: the adapter's version");
  const origins = Array.isArray(app?.origins) ? app.origins : [];
  need(origins.length > 0 && origins.length <= 32 && origins.every((origin) => typeof origin === "string" && ORIGIN.test(origin)), "origins must be https origins, a leading *. for a domain's hosts");
  need(typeof app?.address === "string" && origins.some((origin) => originAllows(origin, app.address)), "address must be an https page on one of its origins");
  need(typeof app?.logo === "string" && origins.some((origin) => originAllows(origin, app.logo)), "logo must be the maker's own icon, on one of its origins");
  need(
    app?.icon_render === undefined || ["theme", "color", "plate-dark", "plate-light"].includes(app.icon_render),
    "icon_render must be theme, color, plate-dark or plate-light",
  );
  const platforms = Array.isArray(app?.platforms) ? app.platforms : [];
  need(platforms.length > 0 && platforms.every((platform) => SITE_PLATFORMS.has(platform)), "platforms must list where it was checked to play");
  for (const platform of platforms) need(app?.media?.[platform]?.drm === false, `media.${platform} must say it plays without DRM there`);
  need(
    Array.isArray(app?.permissions) && app.permissions.every((p) => PERMISSIONS.has(p)) && new Set(app.permissions).size === app.permissions.length,
    "permissions must be known and listed once",
  );
  need(app?.manifest?.name === app?.name, "manifest name is the app's name");
  need(JSON.stringify(app?.manifest?.permissions) === JSON.stringify(app?.permissions), "manifest permissions match the entry's");
  need(app?.manifest?.mcp !== "adapter" || app?.adapter !== undefined, "an adapter site names its adapter");
  if (app?.adapter !== undefined) scriptProblems(app.adapter, need, "adapter");
  need(!("adapter_source" in (app ?? {})), "an adapter is a file on the registry's address, never source in the entry");
  need(!("url" in (app ?? {})) && !("sha256" in (app ?? {})) && !("upstream" in (app ?? {})), "a website app pins no release: it is the maker's own live site");
  return problems;
}

/** Problems with one registry entry, as sentences. An empty list means it is fit to ship. */
export const BUILDS_ORIGIN = "https://registry.mistysys.com/apps/";

/**
 * The name a maker's release is mirrored under in the bucket: the app, its version and the start of its checksum, so a
 * zip is uploaded once and never replaced.
 */
export const mirrorName = (id, version, sha256) => `${id}-${version}-${String(sha256).slice(0, 12)}.zip`;

export function entryProblems(app, { local = false } = {}) {
  if (app?.kind === "site") return siteProblems(app);
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
    typeof app?.logo === "string" && app.logo.startsWith(`https://raw.githubusercontent.com/${upstream}/`) && /\.(png|svg|webp)$/.test(app.logo),
    "logo must be the maker's own icon in their repository",
  );
  need(
    app?.icon_render === undefined || ["theme", "color", "plate-dark", "plate-light"].includes(app.icon_render),
    "icon_render must be theme, color, plate-dark or plate-light",
  );
  // Optional pictures for Explore, from the maker's repository at the pinned tag, like the logo.
  const picture = (url) =>
    typeof url === "string" && url.startsWith(`https://raw.githubusercontent.com/${upstream}/`) && /\.(png|jpg|jpeg|webp)$/.test(url);
  need(app?.banner === undefined || picture(app.banner), "banner must be a picture in the maker's repository");
  need(
    app?.screenshots === undefined || (Array.isArray(app.screenshots) && app.screenshots.length <= 8 && app.screenshots.every(picture)),
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
  need(Array.isArray(app?.add_copies) && app.add_copies.every((c) => safePath(c?.from) && safePath(c?.to)), "add_copies must be paths inside the bundle");
  need(app?.add_files === undefined || Array.isArray(app.add_files), "add_files must be a list");
  for (const file of Array.isArray(app?.add_files) ? app.add_files : []) {
    need(safePath(file?.path) && file.path.startsWith("misty/") && file.path.endsWith(".js"), "an added file is a script under misty/");
    scriptProblems(file, need, `added ${file?.path ?? "file"}`, { local });
  }
  need(typeof app?.strip_top === "boolean", "strip_top must say whether the release is in one folder");
  return problems;
}

/** Licenses a speech model or voice may carry: open weights only, never non-commercial or behind an agreement. */
export const MODEL_LICENSES = new Set(["Apache-2.0", "MIT", "CC-BY-4.0", "CC0-1.0", "BSD-3-Clause"]);
/** The model families Misty's speech pipeline runs (sherpa-onnx, `voice_speech` in misty's `src-tauri`). */
export const HEARING_FAMILIES = new Set(["nemo_transducer", "qwen3_asr", "whisper", "moonshine", "omnilingual_ctc"]);
export const VOICE_FAMILIES = new Set(["kokoro"]);
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

/** Problems with one speech entry (`hearing`, `voices` or `support`), as sentences. */
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
  if (group === "hearing") {
    need(HEARING_FAMILIES.has(entry?.family), `family ${JSON.stringify(entry?.family)} isn't one Misty runs`);
    need(typeof entry?.description === "string" && entry.description.length <= 80, "needs a short description");
    need(typeof entry?.detects_language === "boolean", "detects_language must be true or false");
    need(typeof entry?.words === "boolean", "words must say whether it times each word");
    need([1, 2, 3].includes(entry?.accuracy) && [1, 2, 3].includes(entry?.speed), "accuracy and speed are 1 to 3");
  } else {
    need(VOICE_FAMILIES.has(entry?.family), `family ${JSON.stringify(entry?.family)} isn't one Misty runs`);
    need(entry?.gender === "female" || entry?.gender === "male", "gender is as the model states it, female or male");
    need(Number.isInteger(entry?.speaker) && entry.speaker >= 0, "speaker must be the model's speaker id");
  }
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
