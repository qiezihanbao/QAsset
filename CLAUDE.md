# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

QuickAsset is a cross-platform desktop asset management application built with **Rust + Tauri v2** (backend) and **React + TypeScript + Vite** (frontend). It manages visual assets (images, videos, 3D models, documents) with features like thumbnail generation, perceptual hash similarity search, file system watching, color filtering, tagging, and workspace organization.

## Build & Development Commands

```bash
# Development (starts Vite dev server + Tauri window)
npm run tauri dev

# Type checking only
npm run check

# Build frontend
npm run build

# Lint frontend
npm run lint

# Run Rust backend tests
cd src-tauri && cargo test

# Build production binary
npm run tauri build
```

Note: `npm run tauri dev` runs `beforeDevCommand: "npm run dev"` automatically (starts Vite on port 5173).

## Architecture

### Backend (src-tauri/src/lib.rs)

Single-file Rust backend. All Tauri commands and the data model live in `lib.rs`:

- **AssetInfo** struct: the core data model (id=file path, name, path, asset_type, size, dominant_color, thumbnail_base64, tags, description, rating, workspace_ids, timestamps, p_hash, dimensions, etc.)
- **AppState**: holds `db_path` (PathBuf to SQLite database in app data dir)
- **init_db()**: creates SQLite `assets` table + runs ALTER TABLE migrations for new columns
- **SQLite database**: stored at `{app_data_dir}/assets.db`, using `rusqlite` with bundled SQLite

**Tauri Commands** (registered in `run()`):
| Command | Purpose |
|---------|---------|
| `scan_directory` | Recursively scan folder, index files, generate thumbnails/hashes |
| `get_all_assets` | Load all assets from DB |
| `update_asset` | Partial update (tags, description, rating, workspace_ids, is_trashed, etc.) |
| `delete_asset` | Hard delete from DB |
| `find_similar_images` | Perceptual hash similarity search with threshold |
| `check_health` | Detect missing files on disk |
| `show_in_folder` | Platform-specific reveal in file explorer |
| `start_watcher` | File system watcher (notify crate), emits `fs-event` to frontend |
| `open_in_default_app` | Open file with OS default app |
| `rename_asset` | Rename on disk + update DB |

All async commands use `tokio::task::spawn_blocking` for SQLite operations.

### Frontend (src/)

**State Management**: Single Zustand store (`src/store/useAssetStore.ts`) with all application state: assets, filters, selection, workspaces, UI preferences, sort config, etc. Use `getSafeArray()` helper to parse JSON string arrays from backend.

**Component Structure**:
- `App.tsx` - Root: loads assets on mount, handles keyboard shortcuts (Tab/Shift+Tab for sidebars, Delete), file-drop import, and `fs-event` hot reload listener
- `components/layout/MainLayout.tsx` - Shell with left sidebar + main content + right sidebar
- `components/layout/LeftSidebar.tsx` - Navigation: workspace list, folder tree, views (all/unorganized/trash/tags/workspace)
- `components/layout/RightSidebar.tsx` - Asset detail panel: metadata, tags, rating, description editing
- `components/Lightbox.tsx` - Fullscreen image preview
- `pages/AssetsPage.tsx` - Main grid/masonry view with virtualization, filtering, drag selection
- `pages/TagsView.tsx` - Tag management view

**Frontend-Backend Communication**: Uses `invoke()` from `@tauri-apps/api/core`. Events: `assets-updated`, `fs-event`, `tauri://file-drop`.

**Styling**: Tailwind CSS with Radix UI primitives. Dark mode supported via `dark:` classes. Path alias `@/*` maps to `./src/*`.

### Asset Type Detection

File extensions map to types in `scan_directory`: png/jpg/jpeg/gif/webp → "image", svg → "vector", mp4/avi/mov/webm → "video", mp3/wav/ogg → "audio", obj/fbx/gltf/glb → "3d", others → "document". Only "image" type gets thumbnails, dominant color extraction, and perceptual hashing.

## Key Patterns

- Asset `id` is the file's full path (used as SQLite primary key)
- Tags and workspace_ids stored as JSON strings in SQLite, parsed on frontend with `getSafeArray()`
- `is_trashed` is a soft-delete flag (INTEGER 0/1 in SQLite, bool on frontend)
- Schema migrations use `ALTER TABLE ... ADD COLUMN` with `let _ =` to silently ignore "column already exists" errors
- `update_asset` uses "fetch current → merge with new values → write back" pattern to support partial updates
- File watcher filters out `.db`, `-journal`, and hidden files
- The app detects Tauri runtime with `window.__TAURI_INTERNALS__` for graceful web-preview fallback

## Configuration

- `tauri.conf.json`: product name "QuickAsset", window 800x600, CSP disabled, devUrl localhost:5173
- `capabilities/default.json`: `core:default` + `dialog:default` permissions
- TypeScript strict mode is disabled (`strict: false`)
- Rust edition 2021, minimum Rust version 1.71
