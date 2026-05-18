# AI Card Organizer

<img width="1920" height="1008" alt="image" src="https://github.com/user-attachments/assets/affcb971-62d3-4dda-8ccd-8e963a3d42f0" />


A desktop application for browsing, inspecting, and editing **Tavern V2 character cards** embedded in PNG files. Built with [Tauri](https://tauri.app/) (Rust backend + HTML/CSS/JS frontend).

---

## Table of Contents

- [Download](#download)
- [Background](#background)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Usage](#usage)
- [Building from Source](#building-from-source)
- [Project Structure](#project-structure)
- [License](#license)

---

## Download

Pre-built Windows installers are available on the Releases page. Download the latest .exe (NSIS) or .msi installer — no Rust or Node.js required.

	
---

## Background

I found it surprisingly difficult to organize character cards once the collection grew past 100 — and even harder to figure out which cards were unused or outdated. This app was born out of that frustration.

**Is this app useful?** Maybe not to everyone. But it was built during a slow weekend, it solves a real problem for me, and that's enough.

---

## Features

- **Folder scanning** — Point it at a directory and it recursively finds every PNG containing a Tavern V2 `chara` chunk.
- **Card grid view** — Browse all detected cards in a responsive grid with cover art, name overlays, and hover effects.
- **Detail inspector** — Click any card to see its full metadata (name, description, personality, scenario, first message, tags, creator, etc.) in a side panel.
- **Full-page view** — Expand a card into a dedicated page with collapsible sections, token usage stats, and tag display.
- **Inline editing** — Edit every field (name, description, personality, scenario, first message, mes example, creator notes, system prompt, post-history instructions, character version, tags, extensions) and write changes back into the PNG's `tEXt` chunk without altering image data.
- **Image replacement** — Swap a card's cover image while preserving all metadata.
- **Tag cloud & filtering** — Tags are aggregated across the entire library; click a tag to filter.
- **Search** — Filter cards by name or tag in real time.
- **Sort options** — Sort by folder order, name, token count, number of tags, or creator.
- **Import** — Import individual PNG or JSON character card files via drag-and-drop or file picker.
- **NSFW blur toggle** — Blur all cover images with a single click for safe public browsing.
- **Subfolder navigation** — Browse cards by subfolder via the sidebar tree.

---

## Tech Stack

| Layer      | Technology                              |
|------------|-----------------------------------------|
| Framework  | [Tauri 2](https://tauri.app/)           |
| Backend    | Rust (serde, png, rfd, crc32fast, base64, rayon) |
| Frontend   | Vanilla HTML / CSS / JavaScript         |
| Styling    | [Tailwind CSS](https://tailwindcss.com/) (CDN) |
| UI Font    | JetBrains Mono                          |

---

## Getting Started

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable, via `rustup`)
- [Node.js](https://nodejs.org/) (optional, only if you want a local Tailwind build)

### Run in development

```bash
cargo tauri dev
```

This starts the Tauri dev server, compiles the Rust backend, and opens the app window.

---

## Usage

1. **Select a folder** — Click the "Select Folder" button in the top bar or the empty-state prompt. The app will scan every `.png` file for embedded Tavern V2 character card metadata.
2. **Browse** — Cards appear in a grid. Hover to see the name overlay.
3. **Inspect** — Click a card to open the inspector panel on the right.
4. **View detail** — Click "View Detail" for the full-page view with token stats and collapsible sections.
5. **Edit** — Click "Edit" to modify any field. Changes are saved directly back into the PNG file.
6. **Filter** — Use the search bar or click tags in the sidebar to narrow the list.
7. **Sort** — Use the sort dropdown to reorder cards.
8. **Import** — Click the import button to drag-and-drop or select PNG/JSON files.

---

## Building from Source

```bash
cargo tauri build
```

The bundled installer (MSI/NSIS on Windows) will be placed in `src-tauri/target/release/bundle/`.

---

## Project Structure

```
Ai-Card-Organizer/
├── dist/                          # Frontend assets (HTML, CSS, JS)
│   ├── index.html                 # Main app UI
│   ├── app.js                     # Frontend logic
│   └── styles/
│       └── app.css                # Tailwind base import
├── src-tauri/
│   ├── src/
│   │   ├── main.rs                # Tauri entry point & command registration
│   │   ├── png_meta.rs            # PNG chunk parsing, card struct, serialization
│   │   └── commands/
│   │       ├── mod.rs             # Command module declarations
│   │       ├── scan_folder.rs     # Folder scanning logic
│   │       ├── get_card_metadata.rs   # Single-card metadata reader
│   │       ├── update_card_metadata.rs # Write metadata back to PNG
│   │       ├── read_file_base64.rs    # Read file as base64 (for image preview)
│   │       └── replace_image.rs       # Replace card cover image
│   ├── capabilities/
│   │   └── default.json           # Tauri capability permissions
│   ├── tauri.conf.json            # Tauri configuration
│   └── Cargo.toml                 # Rust dependencies
├── .gitignore
└── README.md
```

---

## License

This project is licensed under the [MIT License](LICENSE). Feel free to fork, modify, and use it for your own needs.
