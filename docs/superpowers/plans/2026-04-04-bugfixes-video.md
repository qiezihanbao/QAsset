# Bug Fixes & Video Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 known issues (pHash, tag/workspace filtering, unorganized view) and add HTML5 video playback.

**Architecture:** Backend changes add `tags`, `unorganized` filters to `query_assets` SQL builder and re-enable pHash via `image_hasher`. Frontend adds `loadFilteredAssets()` in AssetsPage for server-side filtering, a `VideoViewer` component, and wires tag/workspace/unorganized filters to the backend.

**Tech Stack:** Rust (image_hasher 3.1, rusqlite), TypeScript/React (HTML5 `<video>`, Tauri convertFileSrc)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/Cargo.toml` | Modify | Add `image_hasher = "3.1"` |
| `src-tauri/src/models.rs` | Modify | Add `tags`, `unorganized` to `AssetFilters` |
| `src-tauri/src/scanner.rs` | Modify | Compute pHash in `process_image` |
| `src-tauri/src/commands.rs` | Modify | Add tag/unorganized filters to `query_assets`, implement `find_similar_images` |
| `src/store/useAssetStore.ts` | Modify | Add `tags`, `unorganized` to `AssetFilters` interface |
| `src/components/viewers/getViewerType.ts` | Modify | Add `'video'` type via `assetType === 'video'` |
| `src/components/viewers/VideoViewer.tsx` | Create | HTML5 video player with playback controls |
| `src/components/Lightbox.tsx` | Modify | Add `'video'` case to renderViewer |
| `src/pages/AssetsPage.tsx` | Modify | Add `loadFilteredAssets()`, wire server-side filters |

---

### Task 1: Add pHash to scanner via image_hasher

**Files:**
- Modify: `src-tauri/Cargo.toml:36`
- Modify: `src-tauri/src/scanner.rs:1,77-79`

- [ ] **Step 1: Add image_hasher dependency**

In `src-tauri/Cargo.toml`, add after line 36 (`uuid = ...`):
```toml
image_hasher = "3.1"
```

- [ ] **Step 2: Compute pHash in process_image**

In `src-tauri/src/scanner.rs`, replace lines 77-79:
```rust
    // Compute perceptual hash (skip if img_hash doesn't compile with image 0.25)
    // For now we skip pHash as img_hash 3.2 depends on image 0.23
    result.p_hash = None;
```
with:
```rust
    // Compute perceptual hash
    let hasher = image_hasher::HasherConfig::new()
        .hash_alg(image_hasher::HashAlg::Gradient)
        .to_hasher();
    result.p_hash = hasher.hash_image(&img).ok().map(|h| h.to_base64());
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors. May show warnings about unused imports (from old `img_hash` comment removal).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/scanner.rs
git commit -m "feat: enable pHash via image_hasher in scanner"
```

---

### Task 2: Implement find_similar_images

**Files:**
- Modify: `src-tauri/src/commands.rs:584-592`

- [ ] **Step 1: Replace find_similar_images stub**

In `src-tauri/src/commands.rs`, replace lines 584-592:
```rust
#[tauri::command]
pub async fn find_similar_images(
    _target_id: String,
    _threshold: u32,
    _state: State<'_, crate::library::AppState>,
) -> Result<Vec<String>, String> {
    // img_hash dependency removed; return empty results
    Ok(Vec::new())
}
```
with:
```rust
#[tauri::command]
pub async fn find_similar_images(
    target_id: String,
    threshold: u32,
    state: State<'_, crate::library::AppState>,
) -> Result<Vec<String>, String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        // Get target hash
        let target_hash_str: Option<String> = conn.query_row(
            "SELECT p_hash FROM assets WHERE id = ?1",
            rusqlite::params![target_id],
            |row| row.get(0),
        ).map_err(|e| format!("Target asset not found: {}", e))?;

        let target_hash_b64 = target_hash_str
            .ok_or_else(|| "Target asset has no perceptual hash".to_string())?;

        let target_hash = image_hasher::ImageHash::<Vec<u8>>::from_base64(&target_hash_b64)
            .map_err(|e| format!("Failed to decode target hash: {}", e))?;

        let threshold_dist = threshold as usize;

        // Query all assets with non-null p_hash
        let mut stmt = conn.prepare(
            "SELECT id, p_hash FROM assets WHERE p_hash IS NOT NULL AND id != ?1"
        ).map_err(|e| format!("Prepare failed: {}", e))?;

        let rows = stmt.query_map(rusqlite::params![target_id], |row| {
            let id: String = row.get(0)?;
            let hash_b64: String = row.get(1)?;
            Ok((id, hash_b64))
        }).map_err(|e| format!("Query failed: {}", e))?;

        let mut similar_ids = Vec::new();
        for row in rows {
            if let Ok((id, hash_b64)) = row {
                if let Ok(other_hash) = image_hasher::ImageHash::<Vec<u8>>::from_base64(&hash_b64) {
                    if target_hash.dist(&other_hash) <= threshold_dist {
                        similar_ids.push(id);
                    }
                }
            }
        }

        Ok(similar_ids)
    }).await.map_err(|e| e.to_string())?
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: implement find_similar_images with image_hasher"
```

---

### Task 3: Add tags and unorganized filters to backend

**Files:**
- Modify: `src-tauri/src/models.rs:44-57`
- Modify: `src-tauri/src/commands.rs:131-193`

- [ ] **Step 1: Add filter fields to AssetFilters struct**

In `src-tauri/src/models.rs`, add two new fields after `max_size` (line 52) and before `sort_field` (line 53):
```rust
    pub tags: Option<Vec<String>>,
    pub unorganized: Option<bool>,
```

The full struct becomes:
```rust
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetFilters {
    pub search_query: Option<String>,
    pub asset_types: Option<Vec<String>>,
    pub is_trashed: Option<bool>,
    pub workspace_id: Option<String>,
    pub folder_path: Option<String>,
    pub min_rating: Option<u8>,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub tags: Option<Vec<String>>,
    pub unorganized: Option<bool>,
    pub sort_field: String,
    pub sort_order: String,
    pub page: u32,
    pub page_size: u32,
}
```

- [ ] **Step 2: Add tag filter to query_assets SQL builder**

In `src-tauri/src/commands.rs`, after the `max_size` filter block (after line 192, before `let where_sql = ...`), add:
```rust
        if let Some(ref tags) = filters.tags {
            if !tags.is_empty() {
                for tag in tags {
                    where_clauses.push("tags LIKE ?".to_string());
                    param_values.push(Box::new(format!("%\"{}\"%", tag)));
                }
            }
        }

        if filters.unorganized == Some(true) {
            where_clauses.push("(tags IS NULL OR tags = '[]' OR tags = '')".to_string());
            where_clauses.push("(workspace_ids IS NULL OR workspace_ids = '[]' OR workspace_ids = '')".to_string());
        }
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/commands.rs
git commit -m "feat: add tags and unorganized filters to query_assets"
```

---

### Task 4: Wire frontend filters to backend

**Files:**
- Modify: `src/store/useAssetStore.ts:73-86`
- Modify: `src/pages/AssetsPage.tsx`

- [ ] **Step 1: Add tags and unorganized to frontend AssetFilters**

In `src/store/useAssetStore.ts`, add two new fields to the `AssetFilters` interface (after `max_size` and before `sort_field`):
```typescript
  tags?: string[]
  unorganized?: boolean
```

- [ ] **Step 2: Add loadFilteredAssets function to AssetsPage**

In `src/pages/AssetsPage.tsx`, add a new function inside the component (before the `filteredAssets` computation around line 494). This function calls `query_assets` directly with the current filters:

```typescript
  async function loadFilteredAssets() {
    if (!(window as any).__TAURI_INTERNALS__ && !(window as any).__TAURI__) return

    const filters: any = {
      sort_field: sortConfig.field,
      sort_order: sortConfig.order,
      page: 1,
      page_size: 10000,
      is_trashed: activeView === 'trash' ? true : false,
    }

    if (activeView === 'unorganized') {
      filters.unorganized = true
    }

    if (tagFilter && tagFilter.length > 0) {
      filters.tags = tagFilter
    }

    if (activeView === 'workspace' && activeWorkspaceId) {
      filters.workspace_id = activeWorkspaceId
    }

    if (typeFilter && typeFilter.length > 0) {
      filters.asset_types = typeFilter
    }

    if (searchQuery) {
      filters.search_query = searchQuery
    }

    try {
      const result = await invoke('query_assets', { filters }) as any
      setAssets(result.items as AssetLite[])
    } catch (e) {
      console.error('Failed to load filtered assets:', e)
    }
  }
```

- [ ] **Step 3: Add useEffect to trigger loadFilteredAssets**

Add a useEffect that calls `loadFilteredAssets` when filters change:
```typescript
  useEffect(() => {
    loadFilteredAssets()
  }, [activeView, tagFilter, activeWorkspaceId, typeFilter, searchQuery, sortConfig])
```

- [ ] **Step 4: Clean up client-side filter comments**

In the `filteredAssets` computation (around line 494-586), remove the no-op blocks and comments:

Replace lines 502-506:
```typescript
    // Note: "unorganized" and "workspace" filters now need server-side support
    // since AssetLite doesn't carry tags/workspace_ids. For now, show all non-trashed assets.
    if (activeView === 'unorganized') {
      // Would need detail data - skip filtering for now
    }
```
with nothing (delete these lines).

Replace lines 513-514:
```typescript
    // Workspace filter - needs server-side support
    // For now, skip workspace filtering on client side
```
with nothing.

Replace lines 529-530:
```typescript
    // Tag filter - would need server-side support
    // For now, skip tag filtering
```
with nothing.

The `filteredAssets` should now only do client-side filtering for things that can't be server-side: color, size, shape, rating, folder, similar search.

- [ ] **Step 5: Verify frontend compiles**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add src/store/useAssetStore.ts src/pages/AssetsPage.tsx
git commit -m "feat: wire tag/workspace/unorganized filters to server-side query"
```

---

### Task 5: Add VideoViewer component

**Files:**
- Modify: `src/components/viewers/getViewerType.ts:21,31-32`
- Create: `src/components/viewers/VideoViewer.tsx`
- Modify: `src/components/Lightbox.tsx:96-122`

- [ ] **Step 1: Add 'video' to ViewerType and getViewerType**

In `src/components/viewers/getViewerType.ts`:

Change line 21:
```typescript
export type ViewerType = 'image' | 'pdf' | 'text' | 'markdown' | 'unsupported'
```
to:
```typescript
export type ViewerType = 'image' | 'pdf' | 'text' | 'markdown' | 'video' | 'unsupported'
```

Add a video check between the image check (line 31) and the fallback return (line 32). The end of the function becomes:
```typescript
  if (IMAGE_EXTENSIONS.has(ext) || assetType === 'image' || assetType === 'vector') return 'image'
  if (assetType === 'video') return 'video'
  return 'unsupported'
```

- [ ] **Step 2: Create VideoViewer component**

Create `src/components/viewers/VideoViewer.tsx`:
```tsx
import { useState, useRef } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import { RotateCcw } from "lucide-react"

interface VideoViewerProps {
  filePath: string
  fileName: string
}

const PLAYBACK_RATES = [0.5, 1, 1.5, 2]

export function VideoViewer({ filePath, fileName }: VideoViewerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [hasError, setHasError] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [isLooping, setIsLooping] = useState(false)

  const src = convertFileSrc(filePath)

  const handleError = () => {
    setHasError(true)
  }

  const handleRateChange = (rate: number) => {
    setPlaybackRate(rate)
    if (videoRef.current) {
      videoRef.current.playbackRate = rate
    }
  }

  const toggleLoop = () => {
    const newLoop = !isLooping
    setIsLooping(newLoop)
    if (videoRef.current) {
      videoRef.current.loop = newLoop
    }
  }

  const handleOpenDefault = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("open_in_default_app", { path: filePath })
    } catch (e) {
      console.error("Failed to open in default app:", e)
    }
  }

  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-white/70 gap-4">
        <p className="text-lg">无法播放此视频格式</p>
        <p className="text-sm text-white/40">{fileName}</p>
        <button
          onClick={handleOpenDefault}
          className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
        >
          用系统默认程序打开
        </button>
      </div>
    )
  }

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <video
        ref={videoRef}
        src={src}
        controls
        className="max-w-full max-h-full object-contain"
        onError={handleError}
      />

      {/* Playback rate & loop overlay */}
      <div className="absolute top-3 right-3 flex items-center gap-2 z-10">
        <button
          onClick={toggleLoop}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            isLooping ? 'bg-white/30 text-white' : 'bg-black/30 text-white/60 hover:text-white'
          }`}
          title={isLooping ? '关闭循环' : '开启循环'}
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
        <select
          value={playbackRate}
          onChange={(e) => handleRateChange(Number(e.target.value))}
          className="bg-black/30 text-white/80 text-xs rounded px-1.5 py-1 border-none outline-none cursor-pointer"
        >
          {PLAYBACK_RATES.map(r => (
            <option key={r} value={r} className="bg-zinc-900">
              {r}x
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Add video case to Lightbox renderViewer**

In `src/components/Lightbox.tsx`:

Add the import at the top (after existing viewer imports around line 10):
```typescript
import { VideoViewer } from "@/components/viewers/VideoViewer"
```

Add a `'video'` case in the `renderViewer()` switch (before the `default` case around line 112):
```typescript
      case 'video':
        return <VideoViewer filePath={previewAsset.path} fileName={previewAsset.name} />
```

- [ ] **Step 4: Verify frontend compiles**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/viewers/getViewerType.ts src/components/viewers/VideoViewer.tsx src/components/Lightbox.tsx
git commit -m "feat: add HTML5 video playback viewer"
```

---

### Task 6: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run Rust tests**

Run: `cd src-tauri && cargo test`
Expected: All tests pass.

- [ ] **Step 2: Run frontend build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Run dev app for smoke test**

Run: `npx tauri dev`
Expected: App launches, library can be opened, assets display.
