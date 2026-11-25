# misty-registry

The reviewed apps Misty lists in Explore, under the MIT license. A person installs an app on their own computer,
where it opens in whichever Space their window shows. Misty makes no apps of its own, and an app is one of two
things, never a pasted address:

- **An open-source web build:** a maker's own release, which a person gets from Explore once it is listed here.
  Each entry names the maker's own repository, the version it is
  pinned to, the address of the maker's own release zip (or `.war`) as `source`, the checksum GitHub reports for it,
  and the maker's own icon. The registry keeps an unchanged copy of that zip beside its own builds, at
  `registry.mistysys.com/apps/<id>-<version>-<first 12 of the checksum>.zip` (the entry's `url`), so every app comes
  from one place. Misty downloads it when the person installs the app, checks it against the pinned checksum (the
  maker's own, so the copy can't differ from the release), and adds a small wrapper around it (`manifest`,
  `add_copies`, `strip_top`); the maker's files are not changed.
- **A web build the registry makes** (`build: true`): for an MIT or Apache-2.0 app whose maker publishes no web
  build, a recipe here builds it from one pinned upstream commit, and the registry hosts the zip it makes at
  `registry.mistysys.com/apps/`, pinned by its checksum like any other. A zip is uploaded once and never
  replaced: its name carries the recipe's version and a fingerprint of its files, so any change to a recipe is a
  new zip under a new name.
- **A reviewed website entry** (`kind: "site"`): a site that already works as an app, opened at its own address in
  the person's apps sign-in on their computer. It lands only by reviewed pull request here, as Discord's Activities
  come only from registered developers. Explore stays a store: a website that isn't an app is for the person's own
  browser, or an agent's.

**The repository holds no app and no binary.** The registry hosts every app's zip, the ones it builds and an
unchanged copy of each maker's release, served beside the signed registry and never committed. A program an app's MCP
server runs (`mcp_program`) is still the maker's own release asset, downloaded from the maker.

- `apps/<id>.json`: what we say about an app: its name, the maker's repository, which release asset is its web build,
  where its icon is and, optionally, how it renders (`icon_render`: `color` as drawn, the default; `theme` for a
  one-color icon that follows the theme; `plate-dark` or `plate-light` where it would disappear on one theme, by
  `@misty/ui`'s marks rules), optionally where its `banner` (a wide picture for Explore's featured card and the top of its
  details) and `screenshots` (up to 8) are, all paths in the maker's repository, and the wrapper Misty adds.
  An app whose MCP server is a program of its maker's (`manifest.mcp` is `binary`) adds `mcp_program`: the program's
  file name, its arguments, the maker's flags that keep it to a read and a write folder, any variables the maker
  documents for running headless, and which release archive holds it per platform. Refresh pins each archive like
  the web build; Misty takes only that one file out of it and runs it confined to a chat's folder.
  An app that works through a local server of its maker's (`manifest.server` is `true`) adds `server_program`: the
  program's file name, its arguments (`{port}`, `{data}` and `{parent}` stand for the port Misty picks, the app's
  data folder and Misty's own process, which the server ends with), the line its log prints once it serves
  (`ready`), any variables the maker documents, and which release archive holds it per platform. Refresh pins each
  archive, for a built app from the release its recipe names as `ref`; Misty takes only that one file out, runs one
  per computer on `127.0.0.1`, and lets only that app's page reach it. Voicebox is one: Misty's voice, everywhere it
  speaks, comes from its server. A platform with no build has no server, and nothing that needs one is offered there.
- `builds/<id>/`: how the registry builds an app, as small text files: `recipe.json` (the upstream repository, the
  exact commit, its version and license, the folders a sparse checkout needs, and `sdk`, the `misty-sdk` commit
  an app built on it uses), `build.sh` (run in the checkout with `OUT` to fill), `patches/*.patch` applied before
  it, and the app's `adapter.js`. `npm run build:apps [id]` builds each into `work/builds/` (gitignored) with its
  checksum; the zip keeps the upstream's `LICENSE`, and `NOTICE` credits it.
- `.github/workflows/publish.yml`: on every push to `main`, once the checks pass, builds each recipe whose zip
  isn't in the bucket yet and uploads it (`scripts/ship_builds.ts`), pins the hosted zips and commits the pins,
  then signs the index and uploads it beside them. Before that it copies each maker's release zip that
  isn't in the bucket yet (`scripts/ship_mirrors.ts`): it downloads the pin's `source`, keeps it only if it is the
  file the pin's checksum names, and uploads it once under a name made of that checksum, never replaced. Nobody
  uploads a zip by hand.
- Adapters (`adapters/*.js`, `apps/<id>/*.js`, `builds/<id>/adapter.js`) are never copied into the registry. An entry
  names each by its checksum, `{ url, sha256, size }` at `registry.mistysys.com/files/<sha256>.js`; publish uploads
  them (`scripts/ship_files.ts`), and Misty fetches one when it installs the app or opens the site, checks it and
  keeps it. The checks fail when a pin names a script no file here has: run refresh for that app.
- `pins.json`: each app's pin, written by `scripts/refresh.ts`; the index's `apps` come from it. A built app is pinned there once its zip is hosted
  (`REGISTRY_BUILDS_URL`); a local build's pin, with a `file:` address, goes to `work/apps.local.json` instead. A
  debug build of Misty started with `MISTY_LOCAL_APPS` set to that file lists those apps over its registry and
  installs them from `work/builds/` only; a release build ignores both.
- `scripts/refresh.ts`: moves each pin to the maker's latest release. `.github/workflows/refresh.yml` runs it daily
  and opens a pull request.

## The index

`index.min.json` is the one file Misty starts from, and it holds nothing but pointers, so it stays small however
much is listed. Each pointer is a **shard**'s path with its checksum and size: one per section Misty reads whole at
launch (`sections.categories`, `apps`, `engines`, `speech`, `ignore`, at `index/sections/<name>.<checksum>.json`), and
for each kind of listing a top shard and one per category (`listings.<kind>`), read only when someone opens that
listing. A shard is named by its own checksum so it never changes under its name, and is checked against the root. Publishing signs
the exact bytes of the root with the registry's key (`index.min.json.sig`), and that one signature covers every
shard. `npm run build` writes it to `site/` to try locally; a release carries a copy for a first run
(`npm run sync:registry`).

### The blob store

Everything else Misty fetches from the registry is a **blob**: a file at `registry.mistysys.com/blobs/<sha256>`, named by
the sha256 of its exact bytes, uploaded once and never replaced, and checked by Misty against that sha256 and its size.
Installs and previews come from it, never from GitHub:

- Each plugin, skill and agent template carries `bundle: { url, sha256, size }`, a tar.gz of exactly what it is at its
  pinned commit (`npm run bundle`, after the crawl): a skill's or plugin's folder at the top, with the repository's
  `LICENSE` beside it when that is the license it takes, or a template's one Markdown file. Bundles are made
  deterministically (sorted paths, time and owner 0), so the same files are always the same blob.
- Each app's `logo`, `banner` and `screenshots`, and each listing's maker's face (`avatar`, their GitHub picture),
  are copies (`npm run images`); an app keeps the addresses they were copied from as `logo_source`, `banner_source`
  and `screenshots_source`.

The steps write `work/blobs/` and `work/bundles.json` and `images.json`, which `build` reads; an entry
they have nothing for has none. `publish.yml` keeps those files between runs, so what didn't change isn't made
again, and uploads the new blobs (`scripts/ship_blobs.ts`) before it signs and uploads the index.

**Git holds only what people write:** the sources, the apps, the MCP servers, the engines and speech models, and
`pins.json` (each app's pin, written by `refresh`). Everything else, the crawl of the sources and the index itself, is
made afresh at every publish, at least once a day.

Where everything comes from:

| Kind | What | Where it comes from |
| --- | --- | --- |
| `apps` | open-source web builds and reviewed websites | picked by hand (`apps/<id>.json`), pinned by `refresh` |
| `plugins` | bundles of skills, agents, commands, hooks or tools, with what each `includes` | the sources' marketplaces |
| `skills` | a folder with a `SKILL.md` | the sources |
| `templates` | ready-made instructions to start an agent from | the sources |
| `mcps` | MCP servers: hosted at the maker's address, run from the maker's package, or both | picked by hand (`mcps/<id>.json`) |
| `engines`, `speech` | engines, speech models and voices | picked by hand |
| `ignore` | `.mistyignore` templates Files offers; not shown in Explore | picked by hand |

Nothing is read from an engine's own marketplace: Explore shows the index, and the index grows over time.

Listings share one shape (`id`, `name`, `description`, `maker`, one of the registry's `categories`, a `rank` to sort
by, and where it came from) and nothing of them is kept here. Files from a source are pinned at one full commit with
their `license`; an MCP server carries no license, since nothing of it is copied. `scripts/kinds.ts` holds the kinds,
the categories and the size limits. `npm run check` fails when the root or a shard passes its size (1 MB and 6 MB): a
listing that has is split further, never read whole.

### MCP servers

Only big names are listed, by hand: a server earns a place by being one a person would look for, roughly a
repository with a thousand stars or a hosted service of a known maker. Anyone can ask for one. `npm run add:mcp --
<registry name>` writes its file from the official MCP registry (`registry.modelcontextprotocol.io`) for review; a
hosted address is kept only if it signs in the way Misty offers, found by asking it as Misty's own sign-in would, and a
package is pinned at the version listed. `npm run add:mcp -- --stars 1000` proposes every server whose repository has
that many stars. The MCP registry itself holds some 70,000 servers, mostly the same services listed again and again,
so it is a place to look things up, never mirrored.

### Sources

A repository that holds skills, agent templates or plugins is a **source**, as an extension repository is in
Keiyoushi's: `sources/<id>.json` names the repo (`repo`, optionally `ref`), a `priority`, and what to read:
`skills.paths`, `templates.paths` with a `match` on the file's path, and `plugins.index`, the repository's marketplace
file (`.claude-plugin/marketplace.json`). `npm run discover` searches GitHub for repositories with real skills, agents
or a marketplace and enough stars (`--stars`, 500 by default) and, with `--write`, adds them as sources.

`npm run crawl` (in `publish.yml`, `--jobs 8`) reads each source at its latest commit, fetching only the files it reads,
into `work/crawled/<id>.json`, every entry pinned to that commit, its id starting with the source's. Plugins are
taken only when they live inside the repository.

- **Licenses.** A skill takes the license of its own `LICENSE` file, else the one its front matter names, else the
  repository's; a template or plugin takes its folder's or the repository's. Anything whose license isn't one Misty may
  carry, or can't be told, is left out and counted.
- **Categories.** Each listing sorts under one of the registry's categories, chosen from its folder, name and
  description (`categorize` in `scripts/crawl_lib.ts`), never a free word, so the same thing isn't filed two ways.
- **Rank.** Each listing from a source carries its repository's stars as its `rank`, so Explore can put the most used
  first.
- **Duplicates.** Each listing carries a `digest` of its text. When two sources hold the same thing, the one from the
  source with the lowest `priority` stays and names the others in `also`; the rest are not listed. Different things
  with the same name stay apart, their ids told apart by their folder. An entry written by hand always wins, and a
  crawl never lists it again.

Search over the wider world of skills (skills.sh) is not part of Explore: only what is listed here is shown.

An app's name says what is installed; the makers' trademarks never brand Misty. The icons are the makers' own, loaded
from their repositories.

```bash
npm run check      # validates the registry
npm run refresh    # re-pins (GITHUB_TOKEN avoids the anonymous rate limit)
```

## How an app gets in

A pasted link is always a GitHub repository; Misty never opens a pasted address as an app. It resolves the link in
this order: an entry here for that repository (listed); else the maker's own
`misty-app.json` at the top of their repository (unlisted until reviewed); else a basic check: an OSI open-source
license and one web build (a `.zip` with "web" in its name) in the latest release, added at level 0 with Misty's
wrapper only. A maker's own `misty-app.json` always wins: refresh reads it first, and the file here then only says
the app is listed.

Anyone can submit an app, or an integration for one, as a pull request here:

1. Add `apps/<id>.json` (the same shape a maker's `misty-app.json` has): `name`, `upstream`, `web_asset`, `icon`,
   and the `manifest` Misty writes around the release: `entry`, `logo`, `opens`, `permissions` (`files`,
   `chat.post`, `rooms`, `members`), `platforms` (`macos`, `windows`, `linux`; none means all), `network` (the
   hosts it may reach, `{ "host": "api.example.com", "paid": true }` for one that spends money), `own_origin`,
   `inline_scripts`, `shim`. In `web_asset`, `{version}` is the release's version and `*` stands for any part of a
   name the maker changes each release (a commit, a version spelled `4_2_2`), as long as one asset matches; an
   `entry` may hold `{version}` too, for a release whose page is named after it.
2. Optionally an integration: `mcp` (`frame` for the maker's in-page server, `program` with `mcp_program` for their
   native CLI, or `adapter` with `adapter` naming a script under `apps/<id>/` that Misty loads into the running app),
   and `collab: "room"` when the app ties its state to the Space's live document (`@misty/sdk`'s `room()`), or
   `collab: "adapter"` when the adapter does that for an app that can't, with Misty's copy of `@misty/sdk`
   (`window.MistySDK`) loaded before it.
3. Run `npm run refresh <id>` and `npm run check`. Licenses must be OSI-approved; source-available ones aren't taken.

## Website apps

`apps/<id>.json` with `kind: "site"` describes a website app, and an optional adapter sits beside it as
`apps/<id>/<adapter>`:

- `address`: the https page it opens at; `origins`: the https origins it may stay within (`https://*.example.com`
  for a domain's hosts). Anything else, and every new window, opens in the person's own browser.
- `icon`: the maker's own icon, on one of its origins, with `icon_render` as for a web build. `platforms`: where it was checked to play, and `media` for
  each of them: `{ "drm": false }`. Misty's webviews carry no Widevine, so a site that needs it isn't listed there.
- `version`: the adapter's version; `manifest`: its `name`, `permissions` (as an app's), `platforms` and `mcp:
  "adapter"` when it has an adapter.
- `adapter`: a script Misty loads into the running site in an isolated world of its own, on macOS, with Misty's
  copy of `@misty/sdk` (`window.MistySDK`) before it. Only the adapter reaches the Space (`mistyAdapterHost.connect()`
  gives it the SDK's client); the site's own scripts never see it. It sets `window.mistyAdapter` (`tools` and
  `call`) for agents' tools. On Windows, where WebView2 has no isolated world, a website app gets no Space features.

There is nothing to pin: refresh carries the entry as it is, naming its adapter by address and checksum
(`adapter`), which the registry's signature covers. Nobody's session is shared or sent anywhere: each person signs in on their own computer.
YouTube Music is the first with an adapter: what's playing, play, pause, skip and the queue for agents, and listening
together over the Space's live room, where whoever plays, pauses or skips leads.

The others are listed as they are, with no adapter yet: Figma, Canva, Photopea, Miro and tldraw for design; Notion,
Google Docs, Sheets and Slides, Trello, Linear and Airtable for work; YouTube and Twitch to watch; Lichess, Gartic
Phone and skribbl.io to play. Each one's `origins` hold its own hosts and the sign-in pages it sends people to (Google,
Apple, Microsoft, Atlassian), and Cloudflare's check for the sites behind it, since a frame the page loads is held to
the same origins as the page.

## Speech models and engines

Everything a person can add to Misty is listed here, and shows in Explore. Beside the apps:

- `speech/hearing/<id>.json`: a speech recognition model Misty can hear with. Misty picks one for the person from
  their languages and what their computer can run; nobody has to choose.
- `speech/support/<id>.json`: what every hearing model needs beside it, such as Silero VAD, which finds where speech
  starts and ends.
- `engines/<id>.json`: how Misty installs an engine's CLI and where it comes from, and nothing else. An engine's
  models, modes, plugins, skills and connectors stay the engine's own.
- `ignore/<id>.json`: an ignore template for a kind of project (Node, Python, Rust, Unity, Xcode, video work):
  its `name`, the `markers` that show a folder is one (a file's name, `*.ext` for any name ending so, a trailing
  `/` for a folder) and the `rules`, `.gitignore` lines that only leave things out. When a folder in a Space's
  drive holds a marker and its `.mistyignore` lacks the rules, Files offers to add them there.

Like the apps, nothing is kept here. A speech entry pins the release asset sherpa-onnx publishes for the maker's
model (`package`: its url, `sha256`, size, and the folder it unpacks to), names the files Misty loads from it, and
says what it covers (`languages`, `*` for any), what it takes (`disk_mb`, `memory_mb`) and how it compares (`accuracy`
and `speed`, 1 to 3). Only open models are listed: Apache-2.0, MIT, CC-BY-4.0 and the like. Nothing non-commercial,
and nothing whose weights or training data carry such terms; a CC BY model names its `credit`, which Misty shows.

`npm run build` writes the index to `site/`; `npm run check` fails when an entry is incomplete or a part of the index is too big.

## How it reaches people

The registry works the way Homebrew's does. This repository is where entries are reviewed, like homebrew-core;
nobody's Misty reads it.

1. A change lands by pull request, after `ci.yml` checks it. `refresh.yml` opens one each day for the makers' new
   releases.
2. On every merge, `publish.yml` stamps `index.min.json` with the time it was published, signs its exact bytes with
   the registry's key (Ed25519) into `index.min.json.sig` (`{ kid, alg, signature }`) and puts both on the registry's
   address, `https://registry.mistysys.com/index.min.json`.
3. Misty fetches that file when it starts, if its copy is more than a day old, asking only for a newer one. It
   checks its signature against the keys it carries and that it is no older than what it has, then keeps it in
   `misty.db`. A file that fails either check is dropped and the last good one stays.
4. A Misty release carries `index.min.json` as it was then (`npm run sync:registry` in `misty`), for its first run
   before it has fetched anything.

People's computers never call GitHub's API for the registry; only `refresh.yml` does, with its token.

### The signing key

Made once with `mkdir -p -m 700 ~/.config/misty-registry && npm run keygen -- ~/.config/misty-registry/misty-registry.pem`,
beside Misty's updater key in `~/.config/misty-release/`, never in `~/.misty`. The private key never enters this repository: it
lives in the `REGISTRY_SIGNING_KEY` secret (and `REGISTRY_KEY_ID` as a variable when it isn't `misty-registry`). The
public key it prints goes into Misty's `REGISTRY_KEYS` (`src-tauri/features/registry/mod.rs`). To rotate, add the new
public key to Misty first, ship that release, then switch the secret.

