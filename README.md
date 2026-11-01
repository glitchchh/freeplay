# Freeplay

**Turn your PC into a local AirPlay receiver** — mirror your iPhone or iPad screen straight onto your computer, over your own network, with nothing in the cloud.

By **Glitchchh**.

---

## Start it

```bash
cd freeplay
npm start          # or: node bin/freeplay.js
```

The dashboard opens at <http://localhost:7373> (it climbs to the next free port if that one is taken).

1. Click **Install engine** the first time (Windows: ~108 MB portable build, one click).
2. Click **Start receiver**.
3. On your iPhone/iPad: Control Center → **Screen Mirroring** → pick your Freeplay name.

Both devices must be on the same Wi-Fi/LAN. Allow the Windows Firewall prompt the first time.

## Why there is an "engine"

AirPlay screen mirroring is not plain H.264: the stream is FairPlay-encrypted and the key exchange is not publicly specified. No Node/Python library implements a mirroring *receiver* — the working implementations are C++/GStreamer. So Freeplay is the app layer (discovery, configuration, lifecycle, status, dashboard) and drives **UxPlay**, the established open-source receiver, as its engine.

What Freeplay adds on top:

- one-click install of the portable Windows engine, into `./engine` (no admin, no installer, nothing global)
- automatic engine discovery: configured path → `./engine` → `PATH` → common install dirs
- correct engine flags for your settings (`-n`, `-nh`, `-pin`, `-h265`, `-fs`), including writing the GUI build's `arguments.txt` and warning you if a machine-wide one overrides it
- real readiness detection: Freeplay asks the network over mDNS for `_airplay._tcp`, exactly like an iPhone does, so "Live" means your device can actually see it (engines pick their own port — the Windows build uses a random one)
- live connection count read from the OS socket table (locale-independent, so it also works on non-English Windows)
- pick up and restart the receiver without a terminal

## Settings

| Setting | What it does |
| --- | --- |
| **Name** | What appears in the Screen Mirroring list. Saved to `data/config.json`. |
| **PIN** | Optional fixed 4-digit code clients must enter (`-pin 1234`). |
| **H.265** | Advertises 4K/HEVC support (CLI engine builds only). Good for M-series iPads over Ethernet. |
| **Fullscreen** | Asks the engine for a fullscreen mirror window (CLI engine builds only). |
| **Extra flags** | Passed through to the engine verbatim, e.g. `-fps 60`, `-vsync no`. |

## Platform notes

- **Windows** — one-click engine download (the community `uxplay-windows` portable build, unsigned, so SmartScreen may warn). It runs as a tray/GUI app that may re-launch itself detached from the process Freeplay started; Freeplay handles that (it tracks the receiver by its mDNS advertisement, and stopping kills the engine binary by name). It takes its settings from `%APPDATA%\leapbtw\uxplay-windows\arguments.txt`, which Freeplay writes for you (your previous file is backed up once).
- **Linux** — `sudo apt install uxplay` (or build from source); Freeplay picks it up from `PATH`.
- **macOS** — `brew install uxplay`. Note that macOS also has its own built-in AirPlay Receiver in System Settings.

## Files

```
bin/freeplay.js     CLI: flags, banner, browser launch, shutdown
src/server.js       dashboard server, JSON API, SSE stream
src/engine.js       engine discovery, spawn/stop, port + client probing, log ring
src/download.js     portable engine download + install plan per platform
src/zip.js          dependency-free ZIP extractor (store + deflate)
public/             dashboard UI
data/config.json    your settings (git-ignored)
engine/             downloaded engine (git-ignored)
```

## Honest limitations

- Mirroring quality, latency and codec support come from the engine, not from Freeplay.
- DRM-protected video (Apple TV app, Netflix etc.) will show black — no third-party receiver can decrypt that.
- iOS updates have broken the legacy AirPlay protocol before; if mirroring regresses, update the engine.
- Freeplay's dashboard listens on loopback only (`127.0.0.1`), so it is not exposed to your network.

## License

Freeplay's own code: MIT. The engine is UxPlay (GPLv3); its license and source are linked from the dashboard's engine panel.
