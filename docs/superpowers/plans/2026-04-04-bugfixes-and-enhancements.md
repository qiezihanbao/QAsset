# Bugfixes & Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 issues: p_hash migration, tag propagation, file watcher, folder tree, and tag quick-add.

**Architecture:** Backend Rust commands for migration, watcher, and folder operations. Frontend Zustand store for centralized tag state. Custom dropdown component for tag selection. File watcher uses notify crate with mpsc debounce.

**Tech Stack:** Rust/Tauri v2, React/TypeScript, Zustand, SQLite (rusqlite), notify 6.1.1, image 0.25, image_hasher 3.1

---

## File Structure

### Backend (Rust)
| File | Change | Responsibility |
|------|--------|----------------|
| `src-tauri/src/db.rs:4-51` | Modify | Add `show_subfolders` column migration |
| `src-tauri/src/scanner.rs:46` | Modify | Make `process_image` public |
| `src-tauri/src/scanner.rs:544` | Modify | Make `rebuild_folders` public, preserve `show_subfolders` |
| `src-tauri/src/scanner.rs` | Add | New `process_single_file` function |
| `src-tauri/src/commands.rs` | Add | `migrate_missing_hashes`, `start_watcher`, `set_folder_show_subfolders` commands |
| `src-tauri/src/commands.rs:175-178` | Modify | Update folder filtering in `query_assets` |
| `src-tauri/src/commands.rs:439-473` | Modify | Add `show_subfolders` to `get_folders` response |
| `src-tauri/src/lib.rs:15-39` | Modify | Register new commands |

### Frontend (TypeScript/React)
| File | Change | Responsibility |
|------|--------|----------------|
| `src/store/useAssetStore.ts:143,190` | Modify | Add `tagsSummary` state and `refreshTagsSummary` action |
| `src/components/layout/RightSidebar.tsx:118-150,261-285` | Modify | Add tag autocomplete dropdown, call `refreshTagsSummary` |
| `src/pages/TagsView.tsx:9,16-29` | Modify | Read from store instead of independent fetch |
| `src/components/layout/LeftSidebar.tsx:137-249` | Modify | Rewrite folder tree using `get_folders` API, add right-click toggle |
| `src/App.tsx:134-153` | Modify | Update fs-event handler to lightweight refresh |

---

## Task 1: Add `tagsSummary` to Zustand store

**Files:**
- Modify: `src/store/useAssetStore.ts`

- [ ] **Step 1: Add `tagsSummary` state and `refreshTagsSummary` action to store**

In `useAssetStore.ts`, add to the state interface (after `tagFilter` around line 143):

```typescript
tagsSummary: Record<string, number>
```

Add to the initial state (after `tagFilter` around line 248):

```typescript
tagsSummary: {},
```

Add the action (after `setTagFilter` around line 343):

```typescript
refreshTagsSummary: async () => {
  const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__
  if (!isTauri) return
  try {
    const counts = await invoke('get_tags_summary') as Record<string, number>
    set({ tagsSummary: counts })
  } catch (e) {
    console.error('Failed to refresh tags summary:', e)
  }
},
```

Ensure `invoke` is imported at top of file:

```typescript
import { invoke } from "@tauri-apps/api/core"
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npm run check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/store/useAssetStore.ts
git commit -m "feat: add tagsSummary state and refreshTagsSummary action to store"
```

---

## Task 2: Update TagsView to use store cache

**Files:**
- Modify: `src/pages/TagsView.tsx`

- [ ] **Step 1: Replace independent fetch with store data**

Replace the `TagsView` component to use `tagsSummary` from the store:

```typescript
import { useAssetStore } from "@/store/useAssetStore"

export function TagsView() {
  const { setActiveView, setTagFilter, tagsSummary, refreshTagsSummary } = useAssetStore()
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (Object.keys(tagsSummary).length === 0) {
      refreshTagsSummary().finally(() => setIsLoading(false))
    } else {
      setIsLoading(false)
    }
  }, [])

  // Use tagsSummary directly instead of local tagCounts state
  const tagCounts = tagsSummary
  // ... rest of component unchanged, using tagCounts
```

Remove the local `tagCounts` state and `loadTags` function. Keep all rendering logic the same, just change the data source.

- [ ] **Step 2: Verify build**

Run: `npm run check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/pages/TagsView.tsx
git commit -m "fix: TagsView reads tagsSummary from store instead of independent fetch"
```

---

## Task 3: Call `refreshTagsSummary` after tag mutations in RightSidebar

**Files:**
- Modify: `src/components/layout/RightSidebar.tsx`

- [ ] **Step 1: Add `refreshTagsSummary` call after tag add and remove**

In `handleAddTag` (around line 118), after the successful `update_asset` call and `setAssetDetail`, add:

```typescript
useAssetStore.getState().refreshTagsSummary()
```

In `handleRemoveTag` (around line 137), after the successful `update_asset` call and `setAssetDetail`, add:

```typescript
useAssetStore.getState().refreshTagsSummary()
```

- [ ] **Step 2: Verify build**

Run: `npm run check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/RightSidebar.tsx
git commit -m "fix: refresh tagsSummary after tag add/remove in RightSidebar"
```

---

## Task 4: Add `show_subfolders` column to folders table

**Files:**
- Modify: `src-tauri/src/db.rs`

- [ ] **Step 1: Add ALTER TABLE migration**

In `init_library_db` after the existing CREATE TABLE and CREATE INDEX statements (before the closing `"?;`), add:

```rust
let _ = conn.execute_batch(
    "ALTER TABLE folders ADD COLUMN show_subfolders INTEGER DEFAULT 1;"
);
```

- [ ] **Step 2: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "feat: add show_subfolders column to folders table"
```

---

## Task 5: Update `rebuild_folders` to preserve `show_subfolders`

**Files:**
- Modify: `src-tauri/src/scanner.rs`

- [ ] **Step 1: Change `rebuild_folders` to public and preserve settings**

Change signature from `fn rebuild_folders` to `pub fn rebuild_folders` (line 544).

Inside the function, before `DELETE FROM folders`, save existing settings:

```rust
// Save existing show_subfolders preferences before clearing
let mut saved_settings: HashMap<String, bool> = HashMap::new();
{
    let mut prefs_stmt = conn
        .prepare("SELECT path, show_subfolders FROM folders WHERE show_subfolders IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let prefs_rows = prefs_stmt
        .query_map([], |row| {
            let path: String = row.get(0)?;
            let val: i32 = row.get(1)?;
            Ok((path, val != 0))
        })
        .map_err(|e| e.to_string())?;
    for row in prefs_rows {
        if let Ok((path, val)) = row {
            saved_settings.insert(path, val);
        }
    }
}
```

In the INSERT statement (around line 596), change to include `show_subfolders`:

```rust
"INSERT OR REPLACE INTO folders (path, parent_path, display_name, asset_count, show_subfolders) VALUES (?1, ?2, ?3, ?4, ?5)"
```

And the execute call:

```rust
let show_sub = saved_settings.get(folder).copied().unwrap_or(true);
insert_stmt
    .execute(rusqlite::params![folder, parent_path, display_name, count, show_sub as i32])
    .map_err(|e| format!("Failed to insert folder: {}", e))?;
```

- [ ] **Step 2: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/scanner.rs
git commit -m "fix: rebuild_folders preserves show_subfolders settings via upsert"
```

---

## Task 6: Add `set_folder_show_subfolders` command and update `get_folders`

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `set_folder_show_subfolders` command**

Add to `commands.rs`:

```rust
#[tauri::command]
pub async fn set_folder_show_subfolders(
    path: String,
    value: bool,
    state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;
        conn.execute(
            "UPDATE folders SET show_subfolders = ?1 WHERE path = ?2",
            rusqlite::params![value as i32, path],
        ).map_err(|e| format!("Failed to update show_subfolders: {}", e))?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
```

- [ ] **Step 2: Update `get_folders` response to include `show_subfolders`**

In `get_folders` (around line 439), update the query:

```rust
let mut stmt = conn
    .prepare("SELECT path, parent_path, display_name, asset_count, show_subfolders FROM folders ORDER BY path")
    .map_err(|e| e.to_string())?;
```

Update the row mapping:

```rust
let rows = stmt
    .query_map([], |row| {
        let path: String = row.get(0)?;
        let parent_path: Option<String> = row.get(1)?;
        let display_name: String = row.get(2)?;
        let asset_count: i32 = row.get(3)?;
        let show_subfolders: Option<i32> = row.get(4)?;
        Ok(serde_json::json!({
            "path": path,
            "parent_path": parent_path,
            "display_name": display_name,
            "asset_count": asset_count,
            "show_subfolders": show_subfolders.unwrap_or(1) != 0,
        }))
    })
```

- [ ] **Step 3: Update `query_assets` folder filtering**

Replace the folder filtering section (around line 175-178):

```rust
if let Some(ref folder) = filters.folder_path {
    // Check show_subfolders setting
    let show_subs: bool = conn.query_row(
        "SELECT COALESCE(show_subfolders, 1) FROM folders WHERE path = ?1",
        rusqlite::params![folder],
        |row| row.get::<_, i32>(0),
    ).unwrap_or(1) != 0;

    if show_subs {
        // Show all descendants
        where_clauses.push("relative_path LIKE ? || '%'".to_string());
        param_values.push(Box::new(format!("{}/", folder.trim_end_matches('/'))));
    } else {
        // Direct children only: match one level deep
        where_clauses.push("(relative_path GLOB ? || '/*' AND relative_path NOT GLOB ? || '/*/*')".to_string());
        let folder_prefix = folder.trim_end_matches('/').to_string();
        param_values.push(Box::new(folder_prefix.clone()));
        param_values.push(Box::new(folder_prefix));
    }
}
```

- [ ] **Step 4: Register new command in `lib.rs`**

Add `commands::set_folder_show_subfolders` to the `invoke_handler` macro (around line 35).

- [ ] **Step 5: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: add set_folder_show_subfolders command and update folder query filtering"
```

---

## Task 7: Rewrite LeftSidebar folder tree to use `get_folders` API

**Files:**
- Modify: `src/components/layout/LeftSidebar.tsx`

- [ ] **Step 1: Add folder state and fetch logic**

Add a `folders` state and a function to fetch folders from backend:

```typescript
const [folders, setFolders] = useState<any[]>([])

const loadFolders = async () => {
  try {
    const result = await invoke("get_folders") as any[]
    setFolders(result)
  } catch (e) {
    console.error("Failed to load folders:", e)
  }
}
```

Call `loadFolders` on mount and after library changes.

- [ ] **Step 2: Replace `renderFolderTree` with backend-driven tree**

Replace the entire `renderFolderTree` function (lines 137-249) with a new implementation that:

1. Uses the `folders` state (from `get_folders` API) instead of computing from asset paths
2. Builds tree from `parent_path` relationships
3. Root node is the library name (empty path `""`)
4. Uses relative paths for filtering (matching the backend)
5. Adds right-click context menu for toggling `show_subfolders`

Key implementation:

```typescript
const renderFolderTree = () => {
  if (folders.length === 0) return null

  type TreeNode = {
    path: string
    parent_path: string
    display_name: string
    asset_count: number
    show_subfolders: boolean
    children: TreeNode[]
  }

  // Build tree
  const nodeMap = new Map<string, TreeNode>()
  const rootNodes: TreeNode[] = []

  folders.forEach((f: any) => {
    nodeMap.set(f.path, {
      path: f.path,
      parent_path: f.parent_path || "",
      display_name: f.display_name,
      asset_count: f.asset_count,
      show_subfolders: f.show_subfolders,
      children: [],
    })
  })

  nodeMap.forEach((node) => {
    if (!node.parent_path || node.parent_path === "") {
      if (node.path !== "") {
        rootNodes.push(node)
      }
    } else {
      const parent = nodeMap.get(node.parent_path)
      if (parent) {
        parent.children.push(node)
      } else {
        rootNodes.push(node)
      }
    }
  })

  const FolderNode = ({ node, level = 0 }: { node: TreeNode; level?: number }) => {
    const [isExpanded, setIsExpanded] = useState(true)
    const { folderFilter, setFolderFilter } = useAssetStore()
    const hasChildren = node.children.length > 0
    const isSelected = folderFilter?.includes(node.path)
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

    const handleClick = (e: React.MouseEvent) => {
      e.stopPropagation()
      if (isSelected) {
        setFolderFilter(null)
      } else {
        setFolderFilter([node.path])
        useAssetStore.getState().setActiveView('all')
      }
    }

    const handleContextMenu = async (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      try {
        await invoke("set_folder_show_subfolders", {
          path: node.path,
          value: !node.show_subfolders,
        })
        loadFolders() // Refresh folder data
      } catch (err) {
        console.error("Failed to toggle show_subfolders:", err)
      }
    }

    return (
      <div className="w-full">
        <div className="flex items-center">
          <button
            onClick={() => hasChildren && setIsExpanded(!isExpanded)}
            className="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            style={{ marginLeft: `${level * 12}px` }}
          >
            {hasChildren ? (
              isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />
            ) : (
              <div className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={handleClick}
            onContextMenu={handleContextMenu}
            className={`flex-1 flex items-center justify-between px-1 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
              isSelected
                ? "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300"
                : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-50"
            }`}
          >
            <div className="flex items-center gap-1.5 overflow-hidden">
              <Folder className="w-3.5 h-3.5 opacity-70 shrink-0" />
              <span className="truncate">{node.display_name}</span>
              {!node.show_subfolders && (
                <span className="text-[10px] bg-zinc-200 dark:bg-zinc-700 px-1 rounded">仅直接</span>
              )}
            </div>
            {node.asset_count > 0 && <span className="text-xs opacity-60 shrink-0 px-1">{node.asset_count}</span>}
          </button>
        </div>
        {isExpanded && hasChildren && (
          <div className="flex flex-col w-full">
            {node.children.map(child => (
              <FolderNode key={child.path} node={child} level={level + 1} />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      {rootNodes.map(node => (
        <FolderNode key={node.path} node={node} />
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Verify build**

Run: `npm run check`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/LeftSidebar.tsx
git commit -m "feat: rewrite folder tree to use get_folders API with show_subfolders toggle"
```

---

## Task 8: Make `process_image` public

**Files:**
- Modify: `src-tauri/src/scanner.rs`

- [ ] **Step 1: Change visibility**

Change `fn process_image(` to `pub fn process_image(` at line 46.

- [ ] **Step 2: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/scanner.rs
git commit -m "refactor: make process_image public for reuse by migration and watcher"
```

---

## Task 9: Add `migrate_missing_hashes` command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add command to `commands.rs`**

```rust
#[tauri::command]
pub async fn migrate_missing_hashes(
    state: State<'_, crate::library::AppState>,
    app_handle: tauri::AppHandle,
) -> Result<u32, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        // Find all image assets missing p_hash
        let mut stmt = conn
            .prepare("SELECT id, path, relative_path FROM assets WHERE p_hash IS NULL AND asset_type = 'image'")
            .map_err(|e| format!("Prepare failed: {}", e))?;

        let rows: Vec<(String, String, String)> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })
            .map_err(|e| format!("Query failed: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        let total = rows.len() as u32;
        let mut migrated = 0u32;

        for (i, (_id, abs_path_str, relative_path)) in rows.iter().enumerate() {
            let abs_path = std::path::Path::new(abs_path_str);
            if !abs_path.exists() {
                continue;
            }

            let result = crate::scanner::process_image(&library_root, relative_path, abs_path);

            conn.execute(
                "UPDATE assets SET p_hash = ?1, dominant_color = ?2, width = ?3, height = ?4, thumbnail_mtime = ?5 WHERE id = ?6",
                rusqlite::params![
                    result.p_hash,
                    result.dominant_color,
                    result.width,
                    result.height,
                    result.thumbnail_mtime,
                    _id,
                ],
            ).map_err(|e| format!("Update failed: {}", e))?;

            migrated += 1;

            if i % 50 == 0 || i as u32 + 1 == total {
                let _ = app_handle.emit("hash-migration-progress", serde_json::json!({
                    "scanned": i as u32 + 1,
                    "total": total,
                }));
            }
        }

        let _ = app_handle.emit("hash-migration-progress", serde_json::json!({
            "scanned": total,
            "total": total,
            "done": true,
        }));

        Ok(migrated)
    }).await.map_err(|e| e.to_string())?
}
```

- [ ] **Step 2: Register command in `lib.rs`**

Add `commands::migrate_missing_hashes` to the `invoke_handler` macro.

- [ ] **Step 3: Add frontend listener in `App.tsx`**

After the existing `fs-event` listener (around line 153), add a migration progress indicator and auto-trigger:

```typescript
// Auto-run hash migration when library opens
const [migrationProgress, setMigrationProgress] = useState<{ scanned: number; total: number } | null>(null)

useEffect(() => {
  if (!currentLibrary || !isTauri()) return

  invoke("migrate_missing_hashes").catch((err) => {
    console.warn("Hash migration failed:", err)
  })

  const unlisten = listen("hash-migration-progress", (event: any) => {
    const { scanned, total, done } = event.payload
    if (done || scanned === total) {
      setMigrationProgress(null)
      // Migration complete, reload assets
      ;(window as any).__loadAssets?.()
    } else {
      setMigrationProgress({ scanned, total })
    }
  })

  return () => { unlisten.then(fn => fn()) }
}, [currentLibrary])
```

Add a small progress bar indicator in the render (above the main layout):

```tsx
{migrationProgress && (
  <div className="fixed top-0 left-0 right-0 z-50 h-1 bg-zinc-200 dark:bg-zinc-800">
    <div
      className="h-full bg-indigo-500 transition-all duration-300"
      style={{ width: `${(migrationProgress.scanned / migrationProgress.total) * 100}%` }}
    />
  </div>
)}
```

- [ ] **Step 4: Verify everything compiles**

Run: `cd src-tauri && cargo check && cd .. && npm run check`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/App.tsx
git commit -m "feat: add migrate_missing_hashes command with background migration"
```

---

## Task 10: Add `process_single_file` function

**Files:**
- Modify: `src-tauri/src/scanner.rs`

- [ ] **Step 1: Add the function after `process_image`**

```rust
/// Process a single file: determine type, extract metadata, generate thumbnail/pHash for images.
/// Used by the file watcher for incremental updates.
pub fn process_single_file(
    library_root: &Path,
    db_path: &Path,
    abs_path: &Path,
) -> Result<(), String> {
    let ext = match abs_path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_lowercase(),
        None => return Err("No file extension".into()),
    };

    if !is_indexable_ext(&ext) {
        return Ok(()); // Skip non-indexable files
    }

    let metadata = std::fs::metadata(abs_path)
        .map_err(|e| format!("Cannot read file metadata: {}", e))?;
    let asset_type = asset_type_for_ext(&ext).to_string();
    let name = abs_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let modified = metadata.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let relative_path = abs_path.strip_prefix(library_root)
        .unwrap_or(abs_path)
        .to_string_lossy()
        .to_string();

    let abs_path_str = abs_path.to_string_lossy().to_string();
    let id = abs_path_str.clone();

    let img_result = if asset_type == "image" {
        Some(process_image(library_root, &relative_path, abs_path))
    } else {
        None
    };

    let conn = library::get_db_connection(db_path)?;

    // Check if asset exists
    let exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM assets WHERE id = ?1",
        rusqlite::params![id],
        |row| row.get::<_, i32>(0).map(|c| c > 0),
    ).unwrap_or(false);

    let now = library::now_secs();

    if exists {
        let (dominant_color, width, height, p_hash, thumbnail_mtime) = match &img_result {
            Some(r) => (r.dominant_color.clone(), Some(r.width), Some(r.height), r.p_hash.clone(), r.thumbnail_mtime),
            None => (None, None, None, None, None),
        };
        conn.execute(
            "UPDATE assets SET name = ?1, size = ?2, modified_at = ?3, asset_type = ?4,
             dominant_color = ?5, width = ?6, height = ?7, p_hash = ?8, thumbnail_mtime = ?9
             WHERE id = ?10",
            rusqlite::params![name, metadata.len() as i64, modified, asset_type,
                dominant_color, width, height, p_hash, thumbnail_mtime, id],
        ).map_err(|e| format!("Update failed: {}", e))?;
    } else {
        let (dominant_color, width, height, p_hash, thumbnail_mtime) = match &img_result {
            Some(r) => (r.dominant_color.clone(), Some(r.width), Some(r.height), r.p_hash.clone(), r.thumbnail_mtime),
            None => (None, None, None, None, None),
        };
        conn.execute(
            "INSERT INTO assets (id, name, path, relative_path, asset_type, size,
             dominant_color, tags, description, rating, workspace_ids,
             created_at, modified_at, p_hash, is_trashed, width, height,
             source_url, duration, thumbnail_mtime)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', '', NULL, '[]',
             ?8, ?9, ?10, 0, ?11, ?12, NULL, NULL, ?13)",
            rusqlite::params![
                id, name, abs_path_str, relative_path, asset_type, metadata.len() as i64,
                dominant_color, now, modified, p_hash, width, height, thumbnail_mtime,
            ],
        ).map_err(|e| format!("Insert failed: {}", e))?;
    }

    Ok(())
}
```

- [ ] **Step 2: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/scanner.rs
git commit -m "feat: add process_single_file for incremental watcher updates"
```

---

## Task 11: Implement `start_watcher` command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

This is the largest task. The watcher needs careful implementation with debounce.

- [ ] **Step 1: Add watcher module**

Add to `commands.rs`:

```rust
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::mpsc;
use std::time::Duration;

#[tauri::command]
pub async fn start_watcher(
    state: State<'_, crate::library::AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // Stop existing watcher
    *state.watcher_handle.lock().map_err(|e| e.to_string())? = None;

    let library_root = get_library_root(&state)?;
    let db_path = get_db_path(&state)?;

    let (tx, rx) = mpsc::channel::<Event>();

    // Create watcher
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        },
        Config::default(),
    ).map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher.watch(&library_root, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to start watching: {}", e))?;

    // Spawn background thread for debounced event processing
    let root = library_root.clone();
    let db = db_path.clone();
    let handle = app_handle.clone();

    std::thread::spawn(move || {
        loop {
            // Wait for first event
            let first = match rx.recv() {
                Ok(e) => e,
                Err(_) => break, // Channel closed, watcher dropped
            };

            // Collect more events within debounce window
            let mut batch = vec![first];
            while let Ok(e) = rx.recv_timeout(Duration::from_millis(500)) {
                batch.push(e);
            }

            // Process batch
            process_watcher_batch(&batch, &root, &db, &handle);
        }
    });

    // Store watcher
    *state.watcher_handle.lock().map_err(|e| e.to_string())? = watcher;

    Ok(())
}
```

- [ ] **Step 2: Add `process_watcher_batch` function**

```rust
fn process_watcher_batch(
    events: &[Event],
    library_root: &std::path::Path,
    db_path: &std::path::Path,
    app_handle: &tauri::AppHandle,
) {
    let mut created: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();
    let mut removed: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();
    let mut modified: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();

    for event in events {
        // Skip .quickasset directory
        for path in &event.paths {
            if path.to_string_lossy().contains(".quickasset") {
                continue;
            }
        }

        match &event.kind {
            EventKind::Create(_) => {
                for path in &event.paths {
                    if path.is_file() || !path.exists() {
                        // might be a file that was just created
                        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                            if is_indexable_ext_watch(&ext.to_lowercase()) {
                                created.insert(path.clone());
                            }
                        }
                    }
                }
            }
            EventKind::Remove(_) => {
                for path in &event.paths {
                    let abs_str = path.to_string_lossy().to_string();
                    removed.insert(path.clone());
                }
            }
            EventKind::Modify(notify::event::ModifyKind::Data(_)) => {
                for path in &event.paths {
                    if path.is_file() {
                        modified.insert(path.clone());
                    }
                }
            }
            EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::Both
            )) => {
                // Rename: paths[0] = old, paths[1] = new
                if event.paths.len() == 2 {
                    let old = &event.paths[0];
                    let new = &event.paths[1];
                    removed.insert(old.clone());
                    created.insert(new.clone());
                }
            }
            _ => {}
        }
    }

    let conn = match crate::library::get_db_connection(db_path) {
        Ok(c) => c,
        Err(_) => return,
    };

    // Process creates
    for path in &created {
        if !removed.contains(path) {
            if let Err(e) = crate::scanner::process_single_file(library_root, db_path, path) {
                eprintln!("Watcher: failed to process new file {:?}: {}", path, e);
            }
        }
    }

    // Process removes
    for path in &removed {
        if !created.contains(path) {
            let id = path.to_string_lossy().to_string();
            // Try to remove thumbnail
            let _ = conn.execute("DELETE FROM assets WHERE id = ?1", rusqlite::params![id]);
        }
    }

    // Process modifications
    for path in &modified {
        if let Err(e) = crate::scanner::process_single_file(library_root, db_path, path) {
            eprintln!("Watcher: failed to process modified file {:?}: {}", path, e);
        }
    }

    // Rebuild folder cache
    let _ = crate::scanner::rebuild_folders(&conn, library_root);

    // Notify frontend
    let _ = app_handle.emit("fs-event", serde_json::json!({
        "event_type": "sync",
    }));
}

fn is_indexable_ext_watch(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tiff" | "tif" | "ico"
        | "svg"
        | "mp4" | "avi" | "mov" | "mkv" | "webm" | "flv" | "wmv"
        | "mp3" | "wav" | "ogg" | "flac" | "aac" | "m4a" | "wma"
        | "obj" | "fbx" | "gltf" | "glb" | "stl" | "3ds" | "blend"
        | "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx"
        | "txt" | "rtf" | "csv" | "json" | "xml" | "html" | "md"
    )
}
```

- [ ] **Step 3: Register command in `lib.rs`**

Add `commands::start_watcher` to the `invoke_handler` macro.

- [ ] **Step 4: Auto-start watcher on library open**

In `open_library_cmd`, after setting library_root and db_path, add:

```rust
// Start watcher for the new library
let _ = crate::commands::start_watcher::force_start_watcher(&state, &app_handle).await;
```

Actually, since `start_watcher` is a tauri command that takes State, it's easier to call it from the frontend. In `App.tsx`, after opening a library, invoke `start_watcher`:

```typescript
// After successful open_library_cmd
await invoke("start_watcher").catch(err => console.warn("Watcher start failed:", err))
```

- [ ] **Step 5: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/App.tsx
git commit -m "feat: implement start_watcher with debounced file monitoring"
```

---

## Task 12: Update frontend fs-event handler

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Replace full rescan with lightweight refresh**

Replace the `fs-event` listener section (around lines 134-153) with:

```typescript
// File system watcher events (from backend watcher)
const unlistenFs = await listen("fs-event", async (event: any) => {
  // Backend watcher already processed the file changes in DB
  // Just refresh the frontend query
  await (window as any).__loadAssets?.()
})
```

Remove the old logic that called `scan_library()` on create/modify events.

- [ ] **Step 2: Add watcher start after library open**

Find where `open_library_cmd` is called and add watcher start after it:

```typescript
await invoke("start_watcher").catch(err => console.warn("Watcher start failed:", err))
```

- [ ] **Step 3: Verify build**

Run: `npm run check`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "fix: replace full rescan with lightweight refresh on fs-event"
```

---

## Task 13: Add tag quick-add dropdown in RightSidebar

**Files:**
- Modify: `src/components/layout/RightSidebar.tsx`

- [ ] **Step 1: Add autocomplete state and filtering logic**

Add state variables:

```typescript
const [showTagPopover, setShowTagPopover] = useState(false)
const [tagSuggestions, setTagSuggestions] = useState<string[]>([])
```

Add suggestion filtering:

```typescript
const allTags = useAssetStore(state => {
  const summary = state.tagsSummary
  return Object.entries(summary)
    .sort(([, a], [, b]) => b - a)
    .map(([name]) => name)
})

useEffect(() => {
  if (tagInput.trim()) {
    const filtered = allTags.filter(
      t => t.toLowerCase().includes(tagInput.toLowerCase()) && !detailTags.includes(t)
    )
    setTagSuggestions(filtered)
  } else {
    setTagSuggestions([])
  }
}, [tagInput, allTags, detailTags])
```

- [ ] **Step 2: Replace tag input UI**

Replace the tag input section (lines ~273-285) with:

```tsx
{/* Tags */}
<div>
  <p className="text-xs text-zinc-500 mb-1.5">标签</p>
  <div className="flex flex-wrap gap-2 mb-2">
    {detailTags.map((tag: string) => (
      <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs rounded-md">
        {tag}
        <button onClick={() => handleRemoveTag(tag)} className="hover:text-red-500 transition-colors">
          <X className="w-3 h-3" />
        </button>
      </span>
    ))}
  </div>
  <div className="relative">
    <div className="flex items-center">
      <button
        onClick={() => setShowTagPopover(!showTagPopover)}
        className="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 mr-1"
        title="选择已有标签"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
      <input
        type="text"
        value={tagInput}
        onChange={(e) => setTagInput(e.target.value)}
        onKeyDown={handleAddTag}
        placeholder="输入标签后按回车"
        className="flex-1 px-2 py-1.5 bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-md text-[13px] focus:outline-none focus:border-indigo-500 transition-colors"
      />
    </div>
    {/* Autocomplete suggestions */}
    {tagSuggestions.length > 0 && tagInput.trim() && (
      <div className="absolute z-20 left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-lg">
        {tagSuggestions.map(tag => (
          <button
            key={tag}
            className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-indigo-50 dark:hover:bg-indigo-500/10 text-zinc-700 dark:text-zinc-300 transition-colors"
            onClick={() => {
              handleAddTagDirect(tag)
              setTagInput("")
            }}
          >
            {tag}
          </button>
        ))}
      </div>
    )}
    {/* Full tag popover */}
    {showTagPopover && (
      <>
        <div className="fixed inset-0 z-10" onClick={() => setShowTagPopover(false)} />
        <div className="absolute z-20 left-0 right-0 mt-1 max-h-60 overflow-y-auto bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-lg">
          <div className="p-2 text-xs text-zinc-500 border-b border-zinc-200 dark:border-zinc-700">
            全部标签（点击添加）
          </div>
          {allTags.length === 0 ? (
            <div className="p-3 text-xs text-zinc-500 text-center">暂无标签</div>
          ) : (
            allTags.map(tag => {
              const isApplied = detailTags.includes(tag)
              return (
                <button
                  key={tag}
                  className={`w-full text-left px-3 py-1.5 text-[13px] flex items-center justify-between transition-colors ${
                    isApplied
                      ? "bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
                      : "hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300"
                  }`}
                  onClick={() => {
                    if (isApplied) {
                      handleRemoveTag(tag)
                    } else {
                      handleAddTagDirect(tag)
                    }
                  }}
                >
                  <span>{tag}</span>
                  {isApplied && <Check className="w-3 h-3" />}
                </button>
              )
            })
          )}
        </div>
      </>
    )}
  </div>
</div>
```

- [ ] **Step 3: Add `handleAddTagDirect` function**

```typescript
const handleAddTagDirect = async (tag: string) => {
  if (!detail || detailTags.includes(tag)) return
  const newTags = [...detailTags, tag]
  const newTagsStr = JSON.stringify(newTags)
  try {
    await safeInvoke("update_asset", {
      id: selectedAsset.id,
      tags: newTagsStr,
    })
    setAssetDetail({ ...detail, tags: newTagsStr })
    useAssetStore.getState().refreshTagsSummary()
  } catch (err) {
    console.error("Failed to add tag:", err)
  }
}
```

- [ ] **Step 4: Add `Check` icon import**

Add `Check` to the lucide-react imports.

- [ ] **Step 5: Verify build**

Run: `npm run check`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/RightSidebar.tsx
git commit -m "feat: add tag quick-add popover and autocomplete dropdown"
```

---

## Task 14: Integration test and final verification

- [ ] **Step 1: Run full Rust check**

Run: `cd src-tauri && cargo check`
Expected: No errors

- [ ] **Step 2: Run frontend check**

Run: `npm run check`
Expected: No errors

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Run Rust tests**

Run: `cd src-tauri && cargo test`
Expected: All tests pass

- [ ] **Step 5: Manual test with `npm run tauri dev`**

Verify:
1. Open a library → hash migration runs in background
2. Add/remove tags → TagsView and tag summary update immediately
3. Copy a new file into library folder → appears automatically
4. Delete a file from library folder → removed from list
5. Folder tree shows library root, right-click toggles show_subfolders
6. Tag input shows autocomplete suggestions and full tag popover

- [ ] **Step 6: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: integration fixes from testing"
```
