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
    pub library_root: RwLock<Option<PathBuf>>,
    pub db_path: RwLock<Option<PathBuf>>,
    pub watcher_handle: Mutex<Option<RecommendedWatcher>>,  // Drop to stop
}
```

Startup: `library_root = None`. User must open or create a library before anything else. All asset commands return `Err("No library is currently open")` when no library is loaded. `close_library` drops the watcher handle to stop file watching.

### Command Inventory

| Command | Purpose | Notes |
|---------|---------|-------|
| `create_library` | Create new library at selected folder | Creates `.quickasset/`, `library.db`, `library.json` |
| `open_library` | Open existing library | Validates `.quickasset/` exists, loads DB |
| `close_library` | Close current library | Clears state, stops watcher |
| `get_library_info` | Current library metadata | Name, asset count, disk usage |
| `get_recent_libraries` | Read registry.json | Recent library list |
| `relocate_library` | Fix paths after folder move | Recalculates id/path from relative_path |
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

## Migration from v0.x (Current System)

On first launch of the new version:

1. Detect old `<app-data-dir>/assets.db`. If it exists and contains data:
   - Show a one-time migration dialog: "发现旧版数据，是否将其迁移到新的资源库？"
   - User chooses a folder (or defaults to the folder that was previously scanned)
   - Migration process:
     - Read all rows from old `assets` table
     - For each row: compute `relative_path` from `path` relative to chosen library root
     - Decode `thumbnail_base64` → write to `.quickasset/thumbnails/` as WebP
     - Insert into new `library.db` with the new schema
     - Copy tags, workspaces (hardcoded) into the new DB's `workspaces` table
   - Rename old `assets.db` to `assets.db.v0.bak`
2. If user declines migration, the old DB is left untouched (can be migrated later manually)
3. `library.json` version field starts at `1`

## Path Convention for `relative_path`

- Always use forward slashes `/` regardless of OS (canonical form)
- Computed as `pathdiff(library_root, absolute_path)` with `/` separator
- On Windows: `D:\素材库\项目A\img.png` → `项目A/img.png`
- On library relocation: `relocate_library(new_root)` command iterates all rows, recalculates `id` and `path` from `relative_path` + new root, updates DB

### `relocate_library` Command

When the user opens a library and `.quickasset/` is found but file paths don't match (library was moved/copied):
```
1. Detect mismatch: SELECT path FROM assets LIMIT 1 → check if file exists
2. If mismatch, prompt user: "资源库已移动，是否更新路径？"
3. UPDATE all rows: id = new_root + relative_path, path = new_root + relative_path
4. Update library_root in AppState and registry.json
```

## Error Handling in Parallel Scan

Each rayon thread returns `Result<ProcessedAsset, ScanError>`:
```rust
struct ProcessedAsset {
    asset: AssetInfo,
    thumbnail_path: Option<PathBuf>,
}

struct ScanError {
    path: String,
    message: String,
}
```

- Individual image failures are accumulated, not fatal
- After scan completes, return a scan report: `{ added: N, updated: N, deleted: N, errors: Vec<ScanError> }`
- Frontend shows a notification if errors occurred

## Crate Version Notes

- `image` crate must be upgraded from `0.23.14` to `>= 0.25.x` for WebP encoding support
- `img_hash` `3.2.0`: `HasherConfig` and `ImageHash` are `Send` + `Sync` safe — verified compatible with rayon
- Add `rayon = "1.10"` to Cargo.toml

## Asset Protocol Configuration

Tauri v2 asset protocol for thumbnail loading:
- Import: `import { convertFileSrc } from '@tauri-apps/api/core'`
- Usage: `convertFileSrc(thumbnailAbsolutePath)` → returns `http://asset.localhost/<encoded-path>`
- `tauri.conf.json`: maintain `"assetProtocol": { "enable": true, "scope": { "allow": ["**"] } }` — required because library paths are user-chosen and dynamic
- `capabilities/default.json`: add `"core:asset:default"` permission

Security note: the wildcard scope is acceptable for a local desktop app that manages user's own files. Restricting scope per-library would require dynamic scope management not supported in Tauri v2 static config.

## `query_assets` Filter Specification

### Rust Input Struct

```rust
#[derive(Serialize, Deserialize)]
pub struct AssetFilters {
    pub search_query: Option<String>,      // FTS on name (LIKE %query%)
    pub asset_types: Option<Vec<String>>,  // IN ('image', 'video', ...)
    pub is_trashed: Option<bool>,          // WHERE is_trashed = ?
    pub workspace_id: Option<String>,      // workspace_ids JSON contains ?
    pub folder_path: Option<String>,       // relative_path LIKE 'folder/%'
    pub min_rating: Option<u8>,            // rating >= ?
    pub min_size: Option<u64>,             // size >= ?
    pub max_size: Option<u64>,             // size <= ?
    pub sort_field: String,                // created_at | modified_at | name | size | rating
    pub sort_order: String,                // asc | desc
    pub page: u32,
    pub page_size: u32,
}
```

### Server-side vs Client-side Filters

| Filter | Where | How |
|--------|-------|-----|
| Text search | Server | `WHERE name LIKE '%query%'` |
| Asset type | Server | `WHERE asset_type IN (...)` |
| Trash status | Server | `WHERE is_trashed = ?` |
| Workspace | Server | `WHERE workspace_ids LIKE '%"id"%'` (JSON string search) |
| Folder | Server | `WHERE relative_path LIKE 'folder/%'` |
| Rating | Server | `WHERE rating >= ?` |
| Size range | Server | `WHERE size BETWEEN ? AND ?` |
| Sort + Pagination | Server | `ORDER BY ... LIMIT ... OFFSET ...` |
| **Color distance** | Client | Load `dominant_color` from `AssetLite`, compute Euclidean distance |
| **Shape (aspect ratio)** | Client | Compute from `width`/`height` in `AssetLite` |
| **Tags** | Client | Parse `tags` JSON from full asset detail (not in lite) |

Color and shape filters remain client-side because SQLite lacks native color distance functions and the logic is trivial in JS. These are applied to the already-loaded `AssetLite[]` in the store.

## Type Definitions

### Rust

```rust
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetInfoLite {
    pub id: String,
    pub name: String,
    pub path: String,
    pub asset_type: String,
    pub size: u64,
    pub dominant_color: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub created_at: u64,
    pub modified_at: u64,
    pub rating: Option<u8>,
    pub is_trashed: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetDetail {
    // All AssetInfoLite fields plus:
    pub relative_path: String,
    pub tags: Option<String>,
    pub description: Option<String>,
    pub workspace_ids: Option<String>,
    pub p_hash: Option<String>,
    pub source_url: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail_path: Option<String>,  // Absolute path to thumbnail file
}

#[derive(Serialize, Deserialize)]
pub struct QueryResult {
    pub total_count: u32,
    pub items: Vec<AssetInfoLite>,
}
```

### TypeScript

```typescript
interface AssetLite {
  id: string
  name: string
  path: string
  asset_type: string
  size: number
  dominant_color?: string
  width?: number
  height?: number
  created_at: number
  modified_at: number
  rating?: number
  is_trashed: boolean
}

interface AssetDetail extends AssetLite {
  relative_path: string
  tags?: string
  description?: string
  workspace_ids?: string
  p_hash?: string
  source_url?: string
  duration?: number
  thumbnail_path?: string
}

interface LibraryInfo {
  name: string
  path: string
  asset_count: number
  last_opened: number
}

interface PaginationState {
  page: number
  pageSize: number
  totalCount: number
  hasMore: boolean
}
```

## AppState Concurrency Model

```rust
pub struct AppState {
    pub library_root: RwLock<Option<PathBuf>>,  // RwLock: reads >> writes
    pub db_path: RwLock<Option<PathBuf>>,
}
```

- All commands check `library_root.read()` first. If `None`, return `Err("No library is currently open".into())`
- `create_library`, `open_library`, `close_library` acquire write lock
- All other commands acquire read lock (non-blocking for concurrent reads)
- `close_library` also stops the file watcher by dropping the watcher handle (stored separately)

### Watcher Lifecycle

```rust
pub struct AppState {
    pub library_root: RwLock<Option<PathBuf>>,
    pub db_path: RwLock<Option<PathBuf>>,
    pub watcher_handle: Mutex<Option<RecommendedWatcher>>,  // Drop to stop
}
```

- `start_watcher` stores the watcher in `watcher_handle`
- `close_library` drops the watcher (stops watching)
- `open_library` starts a new watcher for the new root

## Workspace CRUD Commands

| Command | Purpose |
|---------|---------|
| `create_workspace` | INSERT into workspaces table |
| `update_workspace` | UPDATE name |
| `delete_workspace` | DELETE, also clear workspace_ids refs in assets |
| `get_workspaces` | SELECT all from workspaces table |

## Folder Tree Rebuild

On full scan (Phase 4):
- `DELETE FROM folders` then re-INSERT from file paths (full rebuild)
- Simple and correct for the scan cadence

On file watcher events:
- Single file events: increment/decrement `asset_count` on the parent folder
- No full rebuild needed for small changes
- If watcher event count exceeds threshold (>50 in rapid succession), trigger a full rebuild

## Scan Progress Reporting

- Backend emits `scan-progress` Tauri event every 100 files processed:
  ```json
  { "phase": "discovering" | "processing", "scanned": 1500, "total": 10000 }
  ```
- Frontend shows a progress bar in the header area during scan
- Scan is not cancellable in v1 (can be added later if needed)

## Additional Indexes

```sql
CREATE INDEX idx_assets_relative_path ON assets(relative_path);
CREATE INDEX idx_assets_dominant_color ON assets(domininant_color);
```

The `relative_path` index supports folder filtering. The `dominant_color` index may help future server-side color filtering but is not critical for v1.

## Known Limitation: Similarity Search at Scale

`find_similar_images` with brute-force pHash comparison will be O(n) per query. For 100k assets, a single similarity search scans all rows. Acceptable for occasional use. Future optimization: BK-tree or locality-sensitive hashing for sub-linear lookup.

## Implementation Steps

1. Add `rayon` dependency, upgrade `image` crate to 0.25.x
2. Create new library management commands (create/open/close)
3. Redesign `init_db` with new schema + indexes
4. Implement `scan_library` with rayon parallel processing
5. Implement `query_assets` with `AssetFilters` struct
6. Move thumbnails from SQLite to disk files (WebP)
7. Add workspace CRUD commands
8. Add `relocate_library` for moved libraries
9. Update frontend store for pagination + library state
10. Add library switcher UI + welcome page
11. Add scan progress bar
12. Data migration tool from v0.x global DB
