# RedstonePanel

**RedstonePanel** is a modern desktop app for managing multiple Minecraft servers from one simple, clean interface. Designed with a redstone-themed aesthetic and built as a native desktop application with Tauri, Rust, React, and TypeScript, it supports starting, stopping, and restarting servers, viewing live console output, sending commands, browsing plugin folders, and monitoring real-time resource usage (CPU/RAM).

> Ideal for creators running Paper, Velocity, Forge, or other Minecraft server types.

---

## 🎮 Features

- ✅ **Multi-server tabs**: Manage as many Minecraft servers as you want
- 📜 **Live Console**: View output, type commands directly
- 🔁 **Start / Stop / Restart** buttons
- 🧩 **Plugin Manager**: Browse and explore your `/plugins` folder visually
- 💾 **Persistent Logs**: Console logs are saved between sessions
- 🧠 **Smart Add Server**: Easily create new server folders via GUI
- 📊 **Status Monitor**: View online/offline status + CPU & RAM usage per server
- 🖼️ **Custom Logo Support**: Use your own logo by replacing `assets/logo.png`

---

## 🧱 Requirements

- Node.js **20+**, Rust stable, and the Tauri system prerequisites
- OS: **Windows**, **Linux**, or **macOS**
- Install dependencies and run the desktop shell:
  ```bash
  npm install
  npm run tauri dev
  ```
