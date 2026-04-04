# Bugfixes & Enhancements Design

Date: 2026-04-04

## Overview

Five fixes/enhancements for QuickAsset covering database consistency, tag management, file watching, folder tree, and tag quick-add.

---

## Fix 1: Auto-generate Missing p_hash (Database Consistency)

### Problem

When opening a database created with an early version of the app, assets may lack `p_hash` values. The system silently ignores these assets in similarity searches, producing incomplete results.

### Solution

Add a **background migration step** that runs after `open_library_cmd`:

1. **New command `migrate_missing_hashes`**:
   - Queries `SELECT id, path, relative_path FROM assets WHERE p_hash IS NULL AND asset_type = 'image'`
   - For each row, calls `process_image(library_root, &relative_path, &abs_path)` to generate hash + thumbnail
   - Updates `p_hash`, `dominant_color`, `width`, `height`, `thumbnail_mtime` in DB
   - If `image::open` fails for a corrupted file, logs the error and skips (p_hash remains NULL — idempotent retry on next open)

2. **Make `process_image` public** in `scanner.rs` (currently private). No extraction needed — it already takes `library_root`, `relative_path`, `abs_path` as standalone parameters.

3. **Triggered automatically** after `open_library_cmd` succeeds — runs in a `tokio::task::spawn_blocking` so it doesn't block the UI.

4. **Progress events**: emits `hash-migration-progress` events to the frontend `{ scanned: u32, total: u32 }`.

5. **Frontend**: shows a small non-blocking toast/indicator while migration runs, dismisses when `phase = "done"`.

6. **Idempotent**: only processes assets where `p_hash IS NULL`, safe to run multiple times.

### Files Changed

- `src-tauri/src/commands.rs` — add `migrate_missing_hashes` command
- `src-tauri/src/scanner.rs` — change `fn process_image` to `pub fn process_image`
- `src-tauri/src/lib.rs` — register new command
- `src/App.tsx` or store — listen for `hash-migration-progress` events, show indicator

---

## Fix 2: Tag Changes Not Propagating in Real-time

### Problem

After adding/removing a tag in the RightSidebar:
- The detail panel updates (via `setAssetDetail`)
- But the asset grid/tags view and tag summary don't refresh
- `TagsView` page currently fetches `get_tags_summary` independently on mount, so its counts become stale after tag mutations in RightSidebar

### Solution

1. **Store-level `tagsSummary` state** (type: `Record<string, number>`):
   - Add `tagsSummary: Record<string, number>` to store state
   - Add `refreshTagsSummary()` action: calls `get_tags_summary` backend command and updates `tagsSummary`

2. **After any tag mutation** (add/remove in RightSidebar):
   - Call `store.refreshTagsSummary()` to update the global cache

3. **TagsView**: change from independent `loadTags()` on mount to reading `tagsSummary` from store. Add a `useEffect` that calls `refreshTagsSummary()` on mount if `tagsSummary` is empty.

4. **LeftSidebar tag filter** reads from `tagsSummary` for consistent data.

### Files Changed

- `src/store/useAssetStore.ts` — add `tagsSummary: Record<string, number>` state and `refreshTagsSummary()` action
- `src/components/layout/RightSidebar.tsx` — call `refreshTagsSummary()` after tag add/remove
- `src/pages/TagsView.tsx` — read from store's `tagsSummary` instead of independent fetch

---

## Fix 3: File Watcher Implementation

### Problem

`start_watcher` does not exist anywhere in the codebase — no function definition, no command registration. `AppState.watcher_handle` field exists but is never populated. New files added to the library directory are not detected.

The existing frontend `fs-event` handler in App.tsx currently does a **full `scan_library` rescan** on every file event, which is extremely expensive and defeats the purpose of incremental updates.

### Solution

Create `start_watcher` from scratch using the `notify` crate (already a dependency):

#### 3a: New `start_watcher` command in `commands.rs`

```
start_watcher(state, app_handle) -> Result<(), String>
```

1. **Stop existing watcher** if any: `*state.watcher_handle.lock()? = None`
2. **Read library_root** from state
3. **Create `RecommendedWatcher`** with a debounced callback:
   - **Debounce mechanism**: use a `tokio::sync::mpsc` channel. The watcher callback sends raw events to the channel. A background task receives from the channel with a 500ms timeout — if more events arrive within the window, they're batched together. After the timeout, the batch is processed.
   - **Event classification**:
     - `EventKind::Create(Any)` → treat as file create
     - `EventKind::Remove(Any)` → treat as file remove
     - `EventKind::Modify(ModifyKind::Data(_))` → treat as file modify
     - `EventKind::Modify(ModifyKind::Name(RenameMode::From))` + corresponding `RenameMode::To` → detect as rename pair
     - `EventKind::Modify(ModifyKind::Name(RenameMode::Other))` → treat as Remove(old) + Create(new) fallback
   - **Filters**: skip `.quickasset` directory, non-indexable extensions, hidden files
4. **Store watcher** in `state.watcher_handle`
5. **Emit `fs-event`** to frontend after processing each batch

#### 3b: New `process_single_file` function in `scanner.rs` (pub)

Handles a single file (used by watcher and migration):
1. Determines asset type via `asset_type_for_ext`
2. Reads file metadata (size, mtime)
3. If image type: calls `process_image` for thumbnail, color, p_hash
4. Computes `relative_path` by stripping `library_root` prefix
5. INSERT or UPDATE the asset in DB (check by id = abs_path)

#### 3c: Watcher event processing in backend

- **Create**: call `process_single_file` → INSERT into DB
- **Remove**: `DELETE FROM assets WHERE id = abs_path` + remove thumbnail file
- **Modify**: call `process_single_file` → UPDATE in DB
- **Rename pair (From + To)**:
  - Individual file rename: UPDATE `id`, `path`, `relative_path`, `name` in DB
  - Folder rename: detect when path is a directory; use transaction to UPDATE all assets with `path LIKE old_prefix%`, replacing the prefix with new path

#### 3d: Auto-start and lifecycle

- **On `open_library_cmd`**: stop old watcher first (if any), then invoke `start_watcher` from the Rust side (not via frontend invoke — pass `app_handle` directly to a helper function)
- **On `close_library`**: `*state.watcher_handle.lock()? = None` already drops the watcher
- **On library switch**: `open_library_cmd` stops old + starts new automatically

#### 3e: Frontend handler update

Replace the current naive full-rescan handler in App.tsx:
- **Current**: `fs-event` → `scan_library()` (full rescan) + `__loadAssets()`
- **New**: `fs-event` → `__loadAssets()` only (backend watcher already processed the file, just refresh the query)
- Show a brief "syncing..." indicator while refreshing

#### 3f: Folder cache update

After watcher processes file events, call `rebuild_folders` to update the folder cache. **Important**: `rebuild_folders` must be updated to preserve `show_subfolders` settings (see Fix 4).

### Files Changed

- `src-tauri/src/commands.rs` — create `start_watcher` command from scratch
- `src-tauri/src/scanner.rs` — add `pub fn process_single_file`, make `rebuild_folders` public
- `src-tauri/src/lib.rs` — register `start_watcher` command
- `src/App.tsx` — replace full-rescan handler with lightweight refresh + sync indicator

---

## Fix 4: Physical Folder Tree Enhancement

### Problem

1. Folder tree is built from asset absolute paths in JS (`a.path.split(...)`), not using the backend `get_folders` API
2. Tree doesn't use library root as the root node
3. No toggle to show/hide subfolder contents
4. Subfolder contents not properly displayed

### Solution

#### 4a: Use backend `folders` table

- LeftSidebar calls `get_folders` API instead of computing tree from asset paths
- Backend `get_folders` returns entries with `path` (relative path like `"photos/2024"`), `parent_path`, `display_name`, `asset_count`
- Root node is the library folder name (from `library.json` config or store state), with empty string `""` as its path
- Tree is built from `parent_path` relationships
- **Path semantics**: all folder paths in the `folders` table use forward slashes (relative paths from `strip_prefix`)

#### 4b: Add `show_subfolders` column to folders table

- **Migration**: add to `init_library_db` in `db.rs`:
  ```sql
  ALTER TABLE folders ADD COLUMN show_subfolders INTEGER DEFAULT 1;
  ```
  Use `let _ = conn.execute_batch(...)` to silently ignore if column already exists.

- `1` = show this folder's direct files AND all descendant files (default, current behavior)
- `0` = only show files directly in this folder (one level deep)
- **New command** `set_folder_show_subfolders(path: String, value: bool)` in `commands.rs`
- Right-click context menu on folder nodes in LeftSidebar to toggle

#### 4c: Update `rebuild_folders` to preserve `show_subfolders`

Current `rebuild_folders` does `DELETE FROM folders` then re-inserts, which would erase user preferences. Change to **upsert pattern**:

1. Before clearing, SELECT all existing `path → show_subfolders` values into a HashMap
2. `DELETE FROM folders`
3. Re-insert folders as before, but restore `show_subfolders` from the saved HashMap (default 1 for new folders)

Make `rebuild_folders` `pub` so the watcher can call it.

#### 4d: Enhance `query_assets` folder filtering

When `folder_path` filter is provided:

1. First query: `SELECT show_subfolders FROM folders WHERE path = ?folder_path` to get the setting
2. If `show_subfolders = 1` (or folder not found / NULL → default):
   ```sql
   relative_path LIKE 'folder/%'
   ```
3. If `show_subfolders = 0`:
   ```sql
   relative_path GLOB 'folder/*' AND relative_path NOT GLOB 'folder/*/*'
   ```
   This correctly matches only direct children (one path segment deep).
4. Add `show_subfolders` info to the `get_folders` response so the frontend can display the toggle state

#### 4e: Rebuild folders on watcher events

After watcher processes file events (Fix 3), call `rebuild_folders` to update the folder cache. The updated `rebuild_folders` (4c) preserves `show_subfolders` settings.

### Files Changed

- `src-tauri/src/db.rs` — add `show_subfolders` column migration in `init_library_db`
- `src-tauri/src/scanner.rs` — update `rebuild_folders` to use upsert pattern preserving `show_subfolders`; make it `pub`
- `src-tauri/src/commands.rs` — add `set_folder_show_subfolders` command; update `query_assets` filtering; update `get_folders` response to include `show_subfolders`
- `src-tauri/src/models.rs` — no new fields needed in `AssetFilters` (folder_path already exists)
- `src-tauri/src/lib.rs` — register new command
- `src/components/layout/LeftSidebar.tsx` — rewrite folder tree to use `get_folders` API with relative paths; add right-click context menu for `show_subfolders` toggle
- `src/store/useAssetStore.ts` — add `folders` state and `showSubfolders` map if needed

---

## Fix 5: Tag Quick-Add Dropdown

### Problem

RightSidebar tag input only supports typing new tags. No way to quickly select from existing tags.

### Solution

Add an autocomplete/tag-selector to the tag input area:

1. **Plus button popover**: clicking the `+` icon opens a popover showing all existing tags (from `tagsSummary` in store from Fix 2).
   - Already-applied tags are shown with a checkmark
   - Click an unchecked tag to add it
   - Click a checked tag to remove it

2. **Input autocomplete**: as the user types, a dropdown appears below the input showing matching existing tags.
   - Shows tags that match the input (case-insensitive substring)
   - Clicking a suggestion adds the tag
   - If no match, pressing Enter creates a new tag (current behavior preserved)

3. **UI component choice**: Use a simple custom dropdown/popover implementation (no new dependency). The project already has `@radix-ui/react-context-menu` for right-click menus. For the tag popover, use a `div` with `position: absolute` + click-outside handling, keeping it lightweight. Alternatively, install `@radix-ui/react-popover` if a more polished component is desired.

4. **UX details**:
   - Popover/dropdown positioned below the input area
   - Max height with scroll for long tag lists
   - Tags sorted by frequency (most used first)
   - Keyboard navigation (arrow keys + Enter) in dropdown

### Files Changed

- `src/components/layout/RightSidebar.tsx` — add tag popover and autocomplete dropdown
- `src/store/useAssetStore.ts` — `tagsSummary` from Fix 2 provides the tag list

---

## Implementation Order

1. **Fix 1** (p_hash migration) — independent, foundational for similarity search
2. **Fix 2** (tag propagation) — independent, needed by Fix 5
3. **Fix 3** (file watcher) — independent but largest scope; Fix 4's updated `rebuild_folders` is needed
4. **Fix 4** (folder tree) — independent, involves DB migration; `rebuild_folders` update needed by Fix 3
5. **Fix 5** (tag quick-add) — depends on Fix 2 for `tagsSummary`

**Recommended order**: Fix 2 → Fix 4 → Fix 1 → Fix 3 → Fix 5
(Fix 4's `rebuild_folders` update should land before Fix 3's watcher starts calling it)
