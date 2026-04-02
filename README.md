# CODEXT

> Context Bundler — flatten any codebase into a single `.txt` file, ready for LLM ingestion.

Built with **Rust + Tauri v2 + React + TypeScript**.

---

## Prerequisites

Install these before running:

1. **Rust** — https://rustup.rs
2. **Node.js** (v18+) — https://nodejs.org
3. **Tauri CLI v2** — installed automatically via npm
4. **System dependencies** (Linux only):
   ```bash
   sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
   ```
   On macOS and Windows, no extra deps needed.

---

## Setup & Run

```bash
# 1. Install frontend deps
npm install

# 2. Run in dev mode (hot-reload)
npm run tauri dev

# 3. Build for production
npm run tauri build
```

The built binary will be in `src-tauri/target/release/`.

---

## What It Does

CODEXT takes any folder you drop on it and produces a single `.txt` file with:

```
╔══════════════════════════════════════════════════════════════╗
║                        CODEXT OUTPUT                        ║
╚══════════════════════════════════════════════════════════════╝

━━━ INFO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Folder name   : my-project
  File count    : 42
  Token estimate: ~18,400 tokens

━━━ STRUCTURE TREE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📁 my-project/
├── 📁 src/
│   ├── App.tsx
│   └── main.tsx
└── package.json

━━━ CONTENT LAYOUT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📁 src/
  📄 App.tsx
  ```
  // your code here, with full indentation preserved
  ```
= = = = = = = = = = = = = = = = = = = = = = = =
```

### Options

| Option | Default | Description |
|---|---|---|
| Respect .gitignore | ✓ | Skips files matching .gitignore rules |
| Skip defaults | ✓ | Auto-ignores `node_modules`, `.git`, `dist`, `build`, `.next`, `target`, etc. |
| Token count | ✓ | Estimates GPT-style token count in output header |
| Max file size | 500 KB | Files larger than this are listed by name only |

### Binary handling

Non-text files (`.png`, `.jpg`, `.exe`, `.wasm`, etc.) are listed by name with a `[Binary file — content not included]` note. No garbage data in your output.

---

## Architecture

```
codext/
├── src/                    # React frontend (TypeScript)
│   ├── App.tsx             # Main UI — all states
│   ├── styles.css          # Full design system
│   └── main.tsx
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── lib.rs          # Core engine: tree builder, content renderer, Tauri commands
│   │   └── main.rs         # Entry point
│   ├── Cargo.toml
│   └── tauri.conf.json
├── index.html
├── package.json
└── vite.config.ts
```

### Key Rust crates

- `walkdir` — recursive directory traversal
- `encoding_rs` — handles non-UTF-8 files (Windows-1252, etc.)
- `tauri-plugin-dialog` — native file/folder picker
- `tauri-plugin-fs` — filesystem access

---

## Why CODEXT?

In 2026, the friction of getting a local codebase into an LLM context is real:
- Uploading 50 files one by one is tedious
- Copy-pasting loses structure
- IDEs don't produce clean, portable context bundles

CODEXT solves this in one drag-and-drop.
