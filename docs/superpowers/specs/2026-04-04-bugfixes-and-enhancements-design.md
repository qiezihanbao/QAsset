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

1. **New command `migrate_missing_hashes`**: queries all image-type assets where `p_hash IS NULL`, generates hashes for each, and updates the DB.
2. **Triggered automatically** after `open_library_cmd` succeeds — runs in a `tokio::task::spawn_blocking` so it doesn't block the UI.
3. **Progress events**: emits `hash-migration-progress` events to the frontend (current/total).
4. **Frontend**: shows a small non-blocking toast/indicator while migration runs, dismisses when done.
5. **Idempotent**: only processes assets where `p_hash IS NULL`, safe to run multiple times.

### Files Changed

- `src-tauri/src/commands.rs` — add `migrate_missing_hashes` command
- `src-tauri/src/scanner.rs` — extract `process_image` hash logic into a reusable function callable by the migration
- `src-tauri/src/lib.rs` — register new command
- Frontend store or App.tsx — listen for migration progress, show indicator

---

## Fix 2: Tag Changes Not Propagating in Real-time

### Problem

After adding/removing a tag in the RightSidebar:
- The detail panel updates (via `setAssetDetail`)
- But the asset grid/tags view and tag summary don't refresh
- `TagsView` page tag counts become stale

### Solution

1. **Store-level `tagsSummary` state**: cache the result of `get_tags_summary` in `useAssetStore`.
2. **After any tag mutation** (add/remove in RightSidebar):
   - Call `get_tags_summary` to refresh `tagsSummary`
   - The store exposes a `refreshTagsSummary()` action
3. **TagsView** reads from `tagsSummary` instead of fetching independently.
4. **LeftSidebar tag filter** also reads from `tagsSummary` for consistent data.

### Files Changed

- `src/store/useAssetStore.ts` — add `tagsSummary` state and `refreshTagsSummary()` action
- `src/components/layout/RightSidebar.tsx` — call `refreshTagsSummary()` after tag add/remove
- `src/pages/TagsView.tsx` — use `tagsSummary` from store

---

## Fix 3: File Watcher Implementation

### Problem

`start_watcher` is registered but not implemented. `AppState.watcher_handle` exists but is never populated. New files added to the library directory are not detected.

### Solution

Implement a full file watcher using the `notify` crate (already a dependency):

1. **`start_watcher` command**:
   - Creates a `RecommendedWatcher` monitoring the `library_root` directory
   - Filters out `.quickasset` internal directory and non-indexable file extensions
   - Debounces events (500ms) to avoid processing bursts
   - Emits `fs-event` to frontend with event type and path

2. **Event handling strategy**:
   - **Create**: scan the new file individually (generate thumbnail, extract metadata, compute p_hash, insert into DB)
   - **Remove**: delete the asset from DB (and its thumbnail)
   - **Modify**: re-process the file (update thumbnail, metadata, p_hash)
   - **Rename**: handled as Remove(old) + Create(new); use transaction to batch-update path prefixes when a folder is moved

3. **Auto-start on library open**: `open_library_cmd` automatically calls `start_watcher` after setting the library root.

4. **Stop on library close**: `close_library` already drops the watcher via `*state.watcher_handle.lock()? = None`.

5. **Frontend**: App.tsx already listens for `fs-event` and calls `__loadAssets()`. Enhance to show a brief "syncing..." indicator.

### New backend function: `process_single_file`

Extracted from scanner to handle a single file:
- Takes library_root, db_path, abs_path
- Determines asset type, generates thumbnail/pHash for images
- Inserts or updates the asset in DB

### Files Changed

- `src-tauri/src/commands.rs` — implement `start_watcher`
- `src-tauri/src/scanner.rs` — extract `process_single_file` function
- `src-tauri/src/library.rs` — no change needed (watcher_handle already exists)
- Frontend App.tsx — enhance fs-event handler with sync indicator

---

## Fix 4: Physical Folder Tree Enhancement

### Problem

1. Folder tree is built from asset paths in JS, not using the backend `get_folders` API
2. Tree doesn't use library root as the root node
3. No toggle to show/hide subfolder contents
4. Subfolder contents not properly displayed

### Solution

#### 4a: Use backend `folders` table

- LeftSidebar calls `get_folders` API instead of computing tree from asset paths
- Root node is the library folder name (from `library.json` config)
- Tree is built from `parent_path` relationships

#### 4b: Add `show_subfolders` column to folders table

- Migration: `ALTER TABLE folders ADD COLUMN show_subfolders INTEGER DEFAULT 1`
- `1` = show this folder's direct files AND subfolder files (default, current behavior)
- `0` = only show files directly in this folder, not subfolders
- New command `set_folder_show_subfolders(path: String, value: bool)`
- Right-click context menu on folder nodes to toggle

#### 4c: Enhance `query_assets` folder filtering

When filtering by `folder_path`:
- If the folder's `show_subfolders = 1`: `relative_path LIKE 'folder/%'` (recursive)
- If the folder's `show_subfolders = 0`: `relative_path LIKE 'folder/%' AND relative_path NOT GLOB 'folder/*/*'` (direct children only)

#### 4d: Rebuild folders on watcher events

When files are added/removed by the watcher, also call `rebuild_folders` to keep the folder cache in sync.

### Files Changed

- `src-tauri/src/db.rs` — add `show_subfolders` column migration
- `src-tauri/src/scanner.rs` — update `rebuild_folders` to set `show_subfolders` default
- `src-tauri/src/commands.rs` — add `set_folder_show_subfolders` command, update `query_assets` filtering
- `src-tauri/src/lib.rs` — register new command
- `src/components/layout/LeftSidebar.tsx` — rewrite folder tree to use `get_folders` API, add right-click context menu
- `src/store/useAssetStore.ts` — store folder data and `show_subfolders` state

---

## Fix 5: Tag Quick-Add Dropdown

### Problem

RightSidebar tag input only supports typing new tags. No way to quickly select from existing tags.

### Solution

Add an autocomplete/tag-selector to the tag input area:

1. **Plus button popover**: clicking the `+` icon opens a popover showing all existing tags (from `tagsSummary` in store).
   - Already-applied tags are shown with a checkmark
   - Click an unchecked tag to add it
   - Click a checked tag to remove it

2. **Input autocomplete**: as the user types, a dropdown appears below the input showing matching existing tags.
   - Shows tags that match the input (case-insensitive substring)
   - Clicking a suggestion adds the tag
   - If no match, pressing Enter creates a new tag (current behavior preserved)

3. **UX details**:
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
3. **Fix 3** (file watcher) — independent but larger scope
4. **Fix 4** (folder tree) — independent, involves DB migration
5. **Fix 5** (tag quick-add) — depends on Fix 2 for `tagsSummary`

Fixes 1, 2, and 4 can be developed in parallel. Fix 3 is the largest and can proceed independently. Fix 5 should follow Fix 2.
