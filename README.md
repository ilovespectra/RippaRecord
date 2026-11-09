# Rippa 🔴

Rippa Record is a macOS menu-bar helper for Reason: prepare a session, route system audio into Reason, then automate recording and export. It records the configured system audio route—not an isolated app stream. The standalone, portfolio-independent landing page is in [`rippa-record-site/`](rippa-record-site/).

## What it does when you click **Start Recording**

1. Launches Reason (waits for you if a login window appears)
2. Opens `rippa-record.reason` (patiently — it's a big file)
3. Jumps to the end of the song content and sets the loop range
4. Applies the audio routing and monitor levels configured on this Mac
5. Selects the configured system output and Reason recording input
6. Uses macOS accessibility automation for supported Reason controls
7. Arms Track 1 / disables monitoring (optional coordinate clicks — see below)
8. Hits **Record** (⌘↩) and shows a green **READY** indicator

The widget floats near your cursor during arming. Once you hit Play on your
stream (detected via macOS Now Playing), it glides to the bottom-right corner
and becomes a small red recording dot.

## Controls

| Action | How |
| --- | --- |
| Pause/resume recording **and** playback together | **⌥⌘R**, or ⏸ on the red dot |
| Stop & finish (loop + name + export) | **⌥⌘S**, or ■ on the red dot |
| Manual "playback started" override | tray menu |
| Abort | tray menu |

**Stop & Finish** stops Reason + playback simultaneously, loops the recorded
session (Reason auto-selects the fresh clip; Rippa clicks **Edit → Set Loop to
Selection**), asks local Ollama to name it from the tracks that played
(plus genre and timestamp), then runs **File → Export Loop as Audio File…**
with that name. Your Reason output folder is used as-is.

> Note: if you paused/resumed mid-session, Reason keeps only the *last* take
> selected, so the loop wraps the last take. Sessions recorded in one
> continuous pass loop perfectly.

## Requirements

- macOS, Reason 10.4 at `/Applications/Reason 10/Reason.app`
- Node.js 22.12+ for installation/development only; the installed app includes its own runtime
- `brew install switchaudio-osx nowplaying-cli`
- [Ollama](https://ollama.com) running locally with a small model (default `qwen2.5:3b`) — optional, falls back to timestamp names
- Audio devices and routing configured for your own setup
- **Permissions** (System Settings → Privacy & Security):
  - *Accessibility* for Electron (dev) / Rippa (packaged) — needed for keystrokes
  - *Automation* → allow controlling System Events + Reason (macOS will prompt)

## Install the original menu-bar app (no VS Code required)

```bash
npm install
npm run install:mac
```

This installs **Rippa Record.app** in `~/Applications` with a simple red-dot
app icon. Its menu-bar item is one hollow circle while idle and one solid red
dot while Rippa mode is active. Click that single circle and choose
**Start Recording** to begin the automation.
There is no Apple Shortcuts workflow, Dock window, or VS Code dependency.

The lightweight menu-bar app stays idle between recordings so its dropdown
remains available. Launching the app alone never opens Reason, changes audio,
or starts recording. After export it shows the result for six seconds and
returns to idle. Opening the app again does not create a second recorder.
Use **Quit Rippa** in the dropdown to remove the icon.

When you first select Start Recording, grant **Rippa Record** Accessibility
and Automation permissions in System Settings. Developer Electron permissions
do not transfer to the installed app. Your Reason project and audio-device
requirements above still apply.

A fresh settings profile opens a first-run device setup wizard. It saves the
Reason app and project, recording input, macOS output, optional playback app,
monitor routing, and the Reason track to select. Reopen it any time from the
menu-bar icon → **Preferences & device setup**. The playback-app choice is
used for pausing; Rippa records the system audio route, not an isolated
per-app audio stream.

Installed settings are stored in
`~/Library/Application Support/Rippa Record/config.json` and preserved when
you reinstall. Quit Rippa before running the installer again.

## Run (dev)

```bash
npm install
npm start
```

Look for one hollow circle in the menu bar while idle; it becomes one red dot while Rippa mode is active.

## Config

Settings live in `config.json` (tray → *Open config.json*): the project copy
in development, or the user settings copy described above when installed. The
repository contains only `config.example.json`; the personalized project
`config.json` is ignored and excluded from the packaged app.
Notable keys:

- `reason.projectPath` — the `.reason` file to open
- `reason.audioDevice` — recording input selected in Reason
- `reason.trackName` — sequencer track selected for the take
- `audio.systemOutputDevice` — macOS output used for the recording route
- `recording.sourceApp` — optional player to pause while arming
- `reason.clickPoints.recordArm` / `monitorOff` — optional `{ "x": 123, "y": 456 }`
  screen coordinates to click Track 1's record-arm and monitor buttons.
  **Easiest alternative:** save the project with Track 1 already record-armed
  and monitoring off; leave these `null` and the step is skipped.
- `reason.loopMenuOverride` — e.g. `"Edit > Loop Selection"` if the automatic
  Edit-menu scan doesn't find the right item
- `audio.monitorDevice` — physical monitor output adjusted before the aggregate
- `audio.monitorVolumePercent` — target monitor volume, default 40
- `audio.restoreAudioAfterFinish` — restore previous output device/volume after export
- `ollama.model` — naming model

## Probes (for tuning the automation)

With Reason open:

```bash
npm run probe:menus   # dumps Edit/File/Options menu item names
npm run probe:prefs   # opens Preferences and dumps its popups/labels
```

Use these to refine `loopMenuOverride` / `exportMenuMatch` in `config.json`.

## Developer Console

From the Rippa Record source folder, run `npm run dev:console`. Choose
`next` for one custom digit-rollover step or `current` to rebuild the current
version. For example, `1.0.9` rolls to `1.1.0`, and `1.9.9` rolls to `2.0.0`.
After confirmation the console runs the tests, updates the version and lockfile,
then rebuilds Rippa Record. By default it installs in `~/Applications`. For a
safe isolated candidate that does not replace the installed app, set
`RIPPA_STAGE_ONLY=1` and optionally `RIPPA_STAGE_DIR=/path/to/candidates`
before running the console; an existing candidate is never overwritten. A
failed build restores the prior version metadata. The console source lives in
`dev-console/`, separate from the app bundle and the landing page in
`rippa-record-site/`. This is a local packaging/install workflow only; it does
not upload releases or install owner credentials in the app. Run
`npm run release:preflight` for a read-only check that the local GitHub CLI is
authenticated as `ilovespectra` and has admin access to the official
`ilovespectra/rippa-record` repository. It never publishes. Builds use a
user-configured local signing identity when one is available, otherwise they
use an ad-hoc signature; neither mode is a notarized public release. Public
release hosting and in-app update checks still need a verified release pipeline.

## Tests

```bash
npm test
```

Lifecycle tests use mocked Electron/Reason interfaces and do not start a
recording or change system audio.
