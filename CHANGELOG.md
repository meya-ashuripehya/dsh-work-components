# Changelog

## 0.5.0

Formal npm release on the `latest` tag. The unpublished `0.4.4` candidate is included here and was not published as its own version. Chinese notes: `docs/release/CHANGELOG-0.5.0.md`. The longer candidate write-up remains `docs/release/CHANGELOG-0.4.4.md`.

The desktop broker URL for this release is `https://github.com/meya-ashuripehya/dsh-work-components/releases/download/v0.5.0/DSHDesktopBroker-win-x64.exe`. The repository manifest stays an unhashed template. `publish.yml` fills the hashes from the exe built for tag `v0.5.0`.

`scripts/pack-release.mjs` still deletes `scripts` from the packed `package.json`, so `npm install dsh-work-components@0.5.0 --ignore-scripts` does not need `scripts/prepare.mjs`. Git checkouts keep `prepare`.

The settings save bar no longer paints an opaque banner. Its background is transparent and the save button stays centered.

Live host install, browser settings, and UI Automation were not run for this release. Do not read this file as a compatibility certificate or a security audit.

## 0.4.4 (candidate, not published on its own)

This candidate was not an npm release and its tag was not pushed. Its tree is the `0.4.4-beta.1` commit `57c5901` plus the functional changes that shipped in `0.5.0`. The broker URL below was the candidate plan; the published asset is the `v0.5.0` URL in the section above.

Live host install, browser settings, and UI Automation were not run. Do not read this file as a compatibility certificate or a security audit.

### Packaging

- `scripts/pack-release.mjs` builds one tarball and deletes `scripts` from the packed `package.json`, so the published package has no `prepare` script pointing at a file the tarball does not contain. Git installs keep `prepare`.
- `package.json` `files` no longer uses `src/components/desktop/**`. The desktop entry is `index.mjs`, `broker-install.mjs`, and `broker-manifest.json`.
- `scripts/verify-package.mjs` reports source, tarball, and host separately. A missing host evidence file is `not-run`, not a pass.
- CI and `publish.yml` verify that same tarball before `npm publish <tarball>`. Provenance stays on the workflow OIDC path. This candidate was not published.
- `dsh.marketplace.profiles` is `["web"]` only. That is a manifest field. It is not a marketplace listing. `dsh-plugin.json` was not added.

### Desktop broker

The self-contained `DSHDesktopBroker.exe` measured on 2026-11-25 is 79,395,535 bytes. More compression cannot put that binary under the 50 MiB marketplace tarball limit, so the npm package does not contain it.

- Nothing downloads the exe during `postinstall`.
- A `broker/dist` exe already built in a source checkout is used as-is.
- Otherwise the settings page install action downloads one pinned HTTPS URL, checks the declared size, SHA-256, and SHA-512, then replaces the previous file. A bad checksum does not replace a good exe.
- The URL is `https://github.com/meya-ashuripehya/dsh-work-components/releases/download/v0.4.4/DSHDesktopBroker-win-x64.exe`. The repository manifest is an unhashed template and refuses download. `publish.yml` fills the hashes from the exe built in that run and uploads this filename. No tag has been pushed, so the asset is not uploaded yet.
- `desktop` is not `builtin`, so the install control is visible. `desktopEnabled` still defaults to false.

### Updates and other downloads

- npm apply reads one packument, checks the version, requires an HTTPS tarball on the registry host, checks `dist.integrity` (sha512), then checks the inner package name and version. The download is a random temp file. `dsh plugin add` runs only after those checks. Failure does not write the profile.
- A `targetVersion` is not replaced by a later `latest` tag. The download cap is 96 MiB. Concurrent applies share one lock.
- uv no longer downloads `/releases/latest/download/...` as the artifact URL. It resolves a concrete tag, then verifies the upstream `.sha256` before extract. Node still uses the existing SHA-256 sums file. Godot signature verification is unchanged.

### Host declaration

- `engines.dsh` and the optional peer are both `0.2.2-rc.5`. That does not include `0.2.1-rc.5`, `0.2.0-rc.2`, or stable `0.2.0`.
- The gate matches local `dsh-app-boot@0.2.2-rc.5`: an own `engines.dsh` decides alone. It does not look at `peerDependenciesMeta.optional`. Missing metadata skips the gate; a skip is not compatibility. A mismatch disables the plugin, so its `settings.section` entry is never registered.
- Three inject lists stay separate: `package.json` `dsh.client.inject` names `@deepseek-ai/dsh-client-ui-renderer` and `@deepseek-ai/dsh-client-ui-conversation`; `lib/client.js` injects the service names `slots`, `sessions`, `uiConversation`; `src/index.mjs` injects `tools`, `agents`, `sessions`, `sessionController`, `schedule`.
- `./client` is a browser entry. A Node import error is not a client result.
- The local Desktop build is `@deepseek-ai/dsh-desktop` `0.2.2-rc.5` at `C:\Users\10917\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`. No other `0.2.x` release is claimed. The previous exact pin `0.2.1-rc.5` is what removed the settings entry after this host update.

### Channels, memory, sessions, video, GameBot

These areas are part of the candidate because they are in the working tree. Packaging tests do not prove them against a live host or a live game.

- Channels include the QQ runtime and the Telegram / QQ behavior already noted for `0.4.4-beta.1` (outbound send, metadata prefix, stickers, companion compaction, seat management, immersion, Google tool search).
- Cross-session memory keeps a process-local runtime handle so the host bundle and the channel bundles see the same gates. That handle does not store transcripts or credentials. Peer search stays inside the caller preset circle.
- Session sampling stores per-session `temperature` and `top_p` for DeepSeek official and DeepSeek account message calls. Other providers are out of scope. Cross-site sampling requests are refused.
- `describe_video` and `watch_video` split long videos (default 10 minutes, 5 second overlap, at most two Gemini requests at once) and map pieces back onto the original timeline. The cache stores segment parameters, the model name, and a credential hash, not the secret itself. Files are sent to Google. YouTube URLs are passed through and not downloaded.
- GameBot remains bundled. Minecraft autonomy code in this tree covers public world memory, runtime state, action verification, navigation, resource actions, semantic perception, and player private chat, plus the NeoForge bridge sources. Private turns are not written by the public memory recorder. The settings page does not show Minecraft or Civilization VI. The vision desktop driver, its settings, and the screenshot dependencies are removed. Live Minecraft and UI Automation were not run. `scripts/mc-live-*.mjs` are developer scripts: they are in the source snapshot and are not in the npm tarball.
- Settings responses replace saved secret fields with `__dsh_secret_saved__`. An empty string is not that mask. This does not encrypt settings at rest. Settings, downloaded tools, and GameBot data stay in `$DSH_HOME/data/dsh-work-components/` and are not deleted on uninstall.

### Not in the candidate snapshot

Python `__pycache__`, the NeoForge `.eclipse` directory, `docs/video-segmentation-samples/` (media cache), and the root task briefs `SAMPLING-TASK.md`, `SAMPLING-SLIDERS-TASK.md`, and `VIDEO-SEGMENTATION-TASK.md`. Those files were left on disk.
