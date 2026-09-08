# RedstonePanel

**RedstonePanel** is a modern desktop app for managing multiple Minecraft servers from one simple, clean interface. Built as a native desktop application with Tauri, Rust, React, and TypeScript, it starts, stops, and restarts real server processes, streams live console output, sends commands, browses and edits server files, and monitors host CPU/RAM.

> Ideal for creators running Paper, Purpur, Spigot, Forge, Fabric, or any jar-based server type.

---

## 🎮 Features

**Working now**
- ✅ **Multi-server manager**: create as many servers as you want, each gets its own folder
- 📜 **Live Console**: real-time output streamed from the server process, type commands directly
- 🔁 **Start / Stop / Restart / Force Kill** buttons
- 📁 **Server File Browser + Editor**: open and edit `server.properties` and friends, with save
- 💾 **Persistent Logs**: every console line is appended to `logs/<server>.log`
- 📊 **Host Monitor**: live CPU + RAM usage of the machine running the servers
- 🗂️ **Auto-generated storage folder**: the app creates its data folder on first launch and stores everything there

**Planned** (panels are already in the UI)
- 🧩 Plugin manager, player management (OP/kick/ban), backups & time machine
- ⏰ Task scheduler, mod wizard, icon/MOTD manager, no-router playit.gg sharing

---

## 🗂️ Where the app stores things

On first launch the app creates its data folder (standard per-OS location):

| OS | Path |
|---|---|
| Windows | `%APPDATA%\dev.redstonepanel.app` |
| Ubuntu / Linux | `~/.config/dev.redstonepanel.app` |
| macOS | `~/Library/Application Support/dev.redstonepanel.app` |

Inside it:

```
├── servers/
│   └── <your-server>/   ← drop your Paper/Forge .jar here, the world lives here
└── logs/
    └── <your-server>.log
```

The current path is shown at the bottom of the sidebar.

---

## 🧱 Requirements

- Node.js **20+**, Rust stable, a recent **JDK (21+)** to run Minecraft servers
- Tauri system prerequisites (webview2 on Windows, webkit2gtk on Ubuntu)
- OS: **Windows**, **Linux**, or **macOS**

## 🚀 Run it locally

```bash
npm install
npm run icons        # generates src-tauri/icons (one-time, also runs in CI)
npm run tauri dev
```

Build a release binary for your own machine:

```bash
npm run tauri build
```

---

## 📦 Releasing on GitHub

Releases are built automatically by GitHub Actions (`.github/workflows/release.yml`) on three hosted runners — one per OS — so every installer is compiled natively:

| OS | Artifacts |
|---|---|
| Windows | `RedstonePanel_x.y.z_x64-setup.exe` (NSIS) + `.msi` |
| Ubuntu | `RedstonePanel_x.y.z_amd64.AppImage` + `RedstonePanel_x.y.z_amd64.deb` |
| macOS | `RedstonePanel_x.y.z_aarch64.dmg` (Apple Silicon — the hosted `macos-latest` runner) |

**To cut a release:**

1. Bump `version` in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (e.g. `0.1.0`)
2. Push a tag with a `v` prefix:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. Watch it build at **Actions → Release** (~5–15 min). When all three OS jobs finish, a GitHub Release appears at **Releases** with all installers attached.

For a test build without touching tags: **Actions → Release → Run workflow** — this creates a *draft* release you can download and discard.
