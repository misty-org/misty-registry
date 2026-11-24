# misty-registry

The reviewed apps Misty lists for a Space, under the MIT license. Misty makes no apps of its own, and an app is one
of two things, never a pasted address:

- **An open-source web build:** a maker's own release, which a Space mod adds by pasting its GitHub repository's
  link (or from Explore once it is listed here). Each entry names the maker's own repository, the version it is
  pinned to, the address of the maker's own release zip (or `.war`) as `source`, the checksum GitHub reports for it,
  and the maker's own icon. The registry keeps an unchanged copy of that zip beside its own builds, at
  `registry.mistysys.com/apps/<id>-<version>-<first 12 of the checksum>.zip` (the entry's `url`), so every app comes
  from one place. Misty downloads it when a Space first opens the app, checks it against the pinned checksum (the
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
- `builds/<id>/`: how the registry builds an app, as small text files: `recipe.json` (the upstream repository, the
  exact commit, its version and license, the folders a sparse checkout needs, and `sdk`, the `misty-sdk` commit
  an app built on it uses), `build.sh` (run in the checkout with `OUT` to fill), `patches/*.patch` applied before
  it, and the app's `adapter.js`. `npm run build:apps [id]` builds each into `work/builds/` (gitignored) with its
  checksum; the zip keeps the upstream's `LICENSE`, and `NOTICE` credits it.
- `.github/workflows/publish.yml`: on every push to `main`, once the checks pass, builds each recipe whose zip
  isn't in the bucket yet and uploads it (`scripts/ship_builds.mjs`), pins the hosted zips and commits the pins,
  then signs `registry.jws.json` and uploads it beside them. Before that it copies each maker's release zip that
  isn't in the bucket yet (`scripts/ship_mirrors.mjs`): it downloads the pin's `source`, keeps it only if it is the
  file the pin's checksum names, and uploads it once under a name made of that checksum, never replaced. Nobody
  uploads a zip by hand.
- Adapters (`adapters/*.js`, `apps/<id>/*.js`, `builds/<id>/adapter.js`) are never copied into the registry. An entry
  names each by its checksum, `{ url, sha256, size }` at `registry.mistysys.com/files/<sha256>.js`; publish uploads
  them (`scripts/ship_files.mjs`), and Misty fetches one when it installs the app or opens the site, checks it and
  keeps it. The checks fail when a pin names a script no file here has: run refresh for that app.
- `apps.json`: the pins, written by `scripts/refresh.mjs`. A built app is pinned there once its zip is hosted
  (`REGISTRY_BUILDS_URL`); a local build's pin, with a `file:` address, goes to `work/apps.local.json` instead. A
  debug build of Misty started with `MISTY_LOCAL_APPS` set to that file lists those apps over its registry and
  installs them from `work/builds/` only; a release build ignores both.
- `scripts/refresh.mjs`: moves each pin to the maker's latest release. `.github/workflows/refresh.yml` runs it daily
  and opens a pull request.

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
YouTube Music is the first: what's playing, play, pause, skip and the queue for agents, and listening together over
the Space's live room, where whoever plays, pauses or skips leads.

## Speech models, voices and engines

Everything a person can add to Misty is listed here, and shows in Explore. Beside the apps:

- `speech/hearing/<id>.json`: a speech recognition model Misty can hear with. Misty picks one for the person from
  their languages and what their computer can run; nobody has to choose.
- `speech/voices/<id>.json`: a voice Misty and agents can speak in. A person picks each agent's voice when they make
  it, and Misty's own in setup.
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

`npm run build` gathers them into `speech.json`, `engines.json` and `ignore.json`, and everything into `registry.json`;
`npm run check` fails when any is out of date.

## How it reaches people

The registry works the way Homebrew's does. This repository is where entries are reviewed, like homebrew-core;
nobody's Misty reads it.

1. A change lands by pull request, after `ci.yml` checks it. `refresh.yml` opens one each day for the makers' new
   releases.
2. On every merge, `publish.yml` signs `registry.json` with the registry's key into `registry.jws.json` (Ed25519, in
   JWS's JSON form, with the time it was published) and puts it on GitHub Pages at
   `https://registry.mistysys.com/registry.jws.json`.
3. Misty fetches that one file when it starts, if its copy is more than a day old, asking only for a newer one. It
   checks the signature against the keys it carries and that it is no older than what it has, then keeps it in
   `misty.db`. A file that fails either check is dropped and the last good one stays.
4. A Misty release carries `registry.json` as it was then (`npm run sync:registry` in `misty`), for its first run
   before it has fetched anything.

People's computers never call GitHub's API for the registry; only `refresh.yml` does, with its token.

### The signing key

Made once with `npm run keygen -- ~/.misty/.env/misty-registry.pem`. The private key never enters this repository: it
lives in the `REGISTRY_SIGNING_KEY` secret (and `REGISTRY_KEY_ID` as a variable when it isn't `misty-registry`). The
public key it prints goes into Misty's `REGISTRY_KEYS` (`src-tauri/features/registry/mod.rs`). To rotate, add the new
public key to Misty first, ship that release, then switch the secret.

