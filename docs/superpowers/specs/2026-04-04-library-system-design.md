# Resource Library System Design

**Date:** 2026-04-04
**Status:** Approved
**Approach:** A — Lightroom Mode (DB co-located with library folder)

## Overview

Redesign QuickAsset from a single global database to a proper resource library system. Each library is a folder on disk with its own SQLite database and thumbnail cache stored inside a `.quickasset/` hidden subdirectory. The system targets 10k–100k assets with instant loading, paginated queries, and parallel scanning via rayon.

## Architecture Choice

**Approach A: Lightroom Mode** — selected over:
- B (centralized AppData DB) — rejected: breaks when folder moves, no portability
- C (hybrid distributed) — rejected: over-engineered, dual-write sync issues

Key properties:
- One library = one folder = one SQLite DB
- DB and thumbnails travel with the folder (portable, backup-friendly)
- App only maintains a lightweight global registry of recently opened libraries
- Single library open at a time (no concurrent multi-library)

## Data Layer

### Library Directory Structure

```
<library-root>/
├── .quickasset/
│   ├── library.db          # SQLite metadata (no thumbnails)
│   ├── library.json        # Library config (name, created_at, version)
│   └── thumbnails/
│       ├── a1/             # First 2 chars of path hash as subdirectory
│       │   ├── b2c3d4e5.webp
│       │   └── ...
│       └── ...
├── <user-subfolders>/
│   └── <files>
└── ...
```

### Global AppData

```
<app-data-dir>/QuickAsset/
└── registry.json           # Recently opened library paths
```

`registry.json` format:
```json
{
  "recent_libraries": [
    { "path": "D:/我的素材库", "name": "我的素材库", "last_opened": 1712200000 }
  ]
}
```

### SQLite Schema — `library.db`

```sql
-- Core asset metadata (thumbnail_base64 removed)
CREATE TABLE assets (
    id TEXT PRIMARY KEY,             -- Full absolute path
    name TEXT NOT NULL,
    path TEXT NOT NULL,              -- Full absolute path
    relative_path TEXT NOT NULL,     -- Path relative to library root (for relocation)
    asset_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    dominant_color TEXT,
    tags TEXT,                       -- JSON array string
    description TEXT,
    rating INTEGER,
    workspace_ids TEXT,              -- JSON array string
    created_at INTEGER DEFAULT 0,
    modified_at INTEGER DEFAULT 0,
    p_hash TEXT,
    is_trashed INTEGER DEFAULT 0,
    width INTEGER,
    height INTEGER,
    source_url TEXT,
    duration REAL,
    thumbnail_mtime INTEGER          -- File mtime when thumbnail was generated (staleness check)
);

-- Performance indexes
CREATE INDEX idx_assets_type ON assets(asset_type);
CREATE INDEX idx_assets_trashed ON assets(is_trashed);
CREATE INDEX idx_assets_created ON assets(created_at);
CREATE INDEX idx_assets_modified ON assets(modified_at);
CREATE INDEX idx_assets_rating ON assets(rating);
CREATE INDEX idx_assets_name ON assets(name);

-- Workspaces (persisted, not hardcoded)
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER DEFAULT 0
);

-- Folder tree cache (for left sidebar browsing)
CREATE TABLE folders (
    path TEXT PRIMARY KEY,           -- Relative path
    parent_path TEXT,
    display_name TEXT NOT NULL,
    asset_count INTEGER DEFAULT 0
);
```

### Thumbnail Strategy

- Format: WebP (~30% smaller than JPEG)
- Filename: first 12 chars of `sha256(relative_path)`
- Directory: first 2 chars as subdirectory (avoids single-dir bottleneck)
- Location: `<library-root>/.quickasset/thumbnails/<2chars>/<10chars>.webp`
- Staleness: compare `thumbnail_mtime` against file's current mtime; regenerate if changed
- Frontend loading: use Tauri `convertFileSrc()` to load directly from disk via asset protocol — no base64 in memory

## Backend — Tauri Commands

### AppState

```rust
pub struct AppState {
    pub library_root: Mutex<Option<PathBuf>>,
    pub db_path: Mutex<Option<PathBuf>>,
}
```

Startup: `library_root = None`. User must open or create a library before anything else.

### Command Inventory

| Command | Purpose | Notes |
|---------|---------|-------|
| `create_library` | Create new library at selected folder | Creates `.quickasset/`, `library.db`, `library.json` |
| `open_library` | Open existing library | Validates `.quickasset/` exists, loads DB |
| `close_library` | Close current library | Clears state |
| `get_library_info` | Current library metadata | Name, asset count, disk usage |
| `get_recent_libraries` | Read registry.json | Recent library list |
| `scan_library` | Full/incremental scan | Rayon parallel processing (see below) |
| `query_assets` | Paginated query | Returns lightweight `AssetInfoLite` (no tags/desc/phash) |
| `get_asset_detail` | Single asset full info | Includes thumbnail path |
| `get_thumbnail_path` | Resolve thumbnail file path | Frontend uses `convertFileSrc` |
| `update_asset` | Partial metadata update | Existing pattern preserved |
| `delete_assets` | Batch delete | Supports array of IDs |
| `get_folders` | Folder tree from DB | Reads `folders` table |
| `get_tags_summary` | Tag statistics | All tags with counts |
| `find_similar_images` | pHash similarity | Existing logic preserved |
| `check_health` | Detect missing files | Existing logic preserved |
| `start_watcher` | FS watcher for library root | Existing logic, now scoped to library root |
| `show_in_folder` | Reveal in file explorer | Existing, unchanged |
| `open_in_default_app` | Open with OS default | Existing, unchanged |
| `rename_asset` | Rename on disk + update DB | Existing logic, now also updates relative_path |

### Parallel Scan Strategy (`scan_library`)

```
Phase 1: File Discovery (single-threaded walkdir)
  → Walk library_root recursively
  → Skip .quickasset/ internal files
  → Collect all file paths into Vec<PathBuf>

Phase 2: Diff Against DB (single-threaded SQLite)
  → SELECT id, modified_at FROM assets
  → Compare each file's mtime
  → Produce three queues:
    · new_files     (not in DB)
    · changed_files (mtime differs)
    · deleted_files (in DB but not on disk)

Phase 3: Parallel Processing (rayon par_iter)
  → Process new_files + changed_files in parallel
  → Per file: generate thumbnail, extract dominant color, compute pHash
  → Write thumbnails to .quickasset/thumbnails/

Phase 4: Batch DB Write (single-threaded SQLite transaction)
  → INSERT new_files
  → UPDATE changed_files
  → DELETE deleted_files
  → Rebuild folders table
  → Emit Tauri event → frontend refreshes
```

### Paginated Query (`query_assets`)

Input: `page`, `page_size`, `sort_field`, `sort_order`, `filters`
Output: `{ total_count, items: Vec<AssetInfoLite> }`

`AssetInfoLite` fields only: `id, name, path, asset_type, size, dominant_color, width, height, created_at, modified_at, rating, is_trashed`

SQL pattern:
```sql
SELECT id, name, path, asset_type, size, dominant_color, width, height,
       created_at, modified_at, rating, is_trashed
FROM assets
WHERE is_trashed = 0 AND asset_type = 'image'
ORDER BY created_at DESC
LIMIT 100 OFFSET 0;
```

## Frontend Architecture

### Startup Flow

```
App launches
  → Read registry.json (recent libraries)
  → Has entries?
    ├── Yes → Auto-open last used library
    │        → query_assets(page=1, page_size=100)
    │        → Render first screen
    └── No  → Show Welcome Page
             → User creates or opens a library
```

### Store Changes

```typescript
interface AssetStore {
  // Library state (new)
  currentLibrary: LibraryInfo | null
  recentLibraries: LibraryInfo[]
  isLoadingLibrary: boolean

  // Pagination state (new)
  pagination: {
    page: number
    pageSize: number          // default: 100
    totalCount: number
    hasMore: boolean
  }

  // Asset list (changed — now lightweight)
  assets: AssetLite[]         // No thumbnail base64, no tags/desc/phash
  assetDetail: Asset | null   // Full info for selected asset only

  // Existing filter/sort state unchanged
}
```

### Key Interaction Flows

**Scroll loading:**
```
User scrolls near bottom (virtual scroll threshold)
  → store.loadMore()
  → query_assets(page=next, page_size=100, current filters/sort)
  → Append to assets[]
  → Virtual scroll renders only visible items
```

**Asset selection:**
```
User clicks asset card
  → get_asset_detail(id)
  → Open right sidebar / lightbox
  → Thumbnail: <img src={convertFileSrc(thumbnailPath)}>
  → No base64 — direct disk read via Tauri asset protocol
```

**Filter/sort change:**
```
User changes filter or sort
  → Reset page=1
  → query_assets(page=1, page_size=100, newFilters, newSort)
  → Replace assets[] entirely
```

**Library switch:**
```
User selects different library from switcher
  → close_library() (cleanup current)
  → open_library(new path)
  → Reset store state
  → query_assets(page=1, page_size=100)
  → Render
```

### Virtual Scroll Optimization

- Already using `@tanstack/react-virtual` — keep it
- Thumbnails: `<img loading="lazy">` + Intersection Observer
- No base64 in memory — only file paths, browser handles disk caching
- Overscan: render 5 extra rows above/below viewport

### UI Changes

**Left sidebar:**
- Top: Library switcher dropdown (current library name + recent list)
- Folder tree: read from `folders` table (no live walkdir)
- Workspaces: read from `workspaces` table (persisted)

**Welcome page (no library open):**
- Create new library button
- Open existing folder button
- Recent libraries quick-access list

## Performance Targets

| Scenario | Target | Mechanism |
|----------|--------|-----------|
| Library open | < 200ms | SQLite indexed query, 100 items first page |
| Page turn / scroll | < 50ms | Paginated SQL, virtual scroll |
| Full scan (10k images) | < 30s | rayon parallel processing |
| Thumbnail load | < 10ms per image | Disk file via asset protocol, browser cache |
| Filter/sort change | < 100ms | SQL indexes, server-side query |
| Library switch | < 500ms | Close DB, open new, first page query |

## Dependencies

- `rayon` — parallel image processing (add to Cargo.toml)
- Existing: `rusqlite`, `image`, `img_hash`, `walkdir`, `notify`
- No new frontend dependencies needed

## Migration Path

1. Add `rayon` dependency
2. Create new library management commands (create/open/close)
3. Redesign `init_db` with new schema + indexes
4. Redesign `scan_library` with parallel processing
5. Add `query_assets` paginated command
6. Move thumbnails from SQLite to disk files
7. Update frontend store for pagination
8. Add library switcher UI
9. Add welcome page
