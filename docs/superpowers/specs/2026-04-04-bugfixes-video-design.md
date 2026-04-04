# Bug Fixes & Video Playback Design

Date: 2026-04-04

## Overview

Fix 4 known issues in the library system migration and add video playback support. Each fix is independent and touches different parts of the codebase.

## 1. pHash via image_hasher

### Problem

Perceptual hashing was disabled during the library system migration because `img_hash` 3.2 depends on `image` 0.23, conflicting with the project's `image` 0.25 dependency. `find_similar_images` currently returns an empty vector.

### Solution

Use `image_hasher` v3.1.1 which requires `image >=0.25, <0.26`.

### Changes

**Cargo.toml**: Add `image_hasher = "3.1"` dependency.

**src-tauri/src/scanner.rs** (`process_image`):
- Import `image_hasher::{HasherConfig, HashAlg}`
- After loading the image for thumbnails, compute a gradient hash: `let hasher = HasherConfig::new().hash_alg(HashAlg::Gradient).to_hasher();`
- Encode the resulting `ImageHash<Vec<u8>>` to Base64: `hash.to_base64()`
- Store in `result.p_hash = Some(base64_string)`

**src-tauri/src/commands.rs** (`find_similar_images`):
- Accept `target_id` (asset path) and `threshold` (max Hamming distance)
- Open DB, fetch target asset's `p_hash`
- Query all assets with non-null `p_hash`
- For each, decode both hashes from Base64 using `ImageHash::from_base64()`
- Compute Hamming distance via `hash.dist(&other_hash)`
- Collect asset IDs where distance <= threshold
- Return matched IDs

### Constraints

- pHash computation runs in the rayon parallel pipeline (Phase 3 of scanner)
- Base64 encoding matches the existing `p_hash` column type (TEXT)
- `find_similar_images` runs in `spawn_blocking` for DB access

## 2. Tag + Workspace Server-Side Filtering

### Problem

`query_assets` supports `workspace_id` filtering via SQL LIKE but has no tag filter. The frontend skips both tag and workspace filtering because `AssetLite` lacks `tags` and `workspace_ids` fields. Client-side `allTags` is hardcoded to `[]`.

### Solution

Add tag filtering to the backend SQL builder and wire the frontend to pass filters to `query_assets` instead of filtering client-side.

### Changes

**src-tauri/src/models.rs** (`AssetFilters`):
- Add field: `tags: Option<Vec<String>>`

**src-tauri/src/commands.rs** (`query_assets`):
- In the SQL WHERE clause builder, after existing filters, add tag filter logic:
  ```
  if let Some(tags) = &filters.tags {
      for tag in tags {
          conditions.push(format!("tags LIKE '%\"{}\"%'", tag.replace('\'', "''")));
      }
  }
  ```
- Note: tags are stored as JSON arrays (e.g., `["tag1","tag2"]`), so `LIKE '%"tagname"%'` matches correctly. SQL injection is prevented by escaping single quotes in tag names.

**src/store/useAssetStore.ts** (`AssetFilters` interface):
- Add field: `tags?: string[]`

**src/pages/AssetsPage.tsx**:
- When `tagFilter` state is non-empty, pass `tags: tagFilter` in the `query_assets` filters object
- When `workspaceFilter` is set, pass `workspace_id: workspaceFilter` in the filters
- Remove the commented-out client-side tag/workspace filtering blocks
- Re-query from backend when tag or workspace filter changes (add to filter dependency array)

### Constraints

- Tag filtering is AND logic: all requested tags must be present on the asset
- Workspace filtering uses the existing `workspace_id` filter (single workspace)
- No changes to `AssetLite` type — tags remain server-side only for list view

## 3. "Unorganized" View

### Problem

The "unorganized" view (`activeView === 'unorganized'`) is a no-op that shows all non-trashed assets, identical to the "all" view. The sidebar shows a hardcoded count of 0.

### Solution

Add an `unorganized` filter to `query_assets` that selects assets with no tags and no workspace assignment.

### Changes

**src-tauri/src/models.rs** (`AssetFilters`):
- Add field: `unorganized: Option<bool>`

**src-tauri/src/commands.rs** (`query_assets`):
- Add unorganized SQL clause:
  ```rust
  if filters.unorganized == Some(true) {
      conditions.push("(tags IS NULL OR tags = '[]' OR tags = '')".to_string());
      conditions.push("(workspace_ids IS NULL OR workspace_ids = '[]' OR workspace_ids = '')".to_string());
  }
  ```

**src/store/useAssetStore.ts** (`AssetFilters` interface):
- Add field: `unorganized?: boolean`

**src/pages/AssetsPage.tsx**:
- When `activeView === 'unorganized'`, pass `unorganized: true` to `query_assets` filters
- Remove the existing no-op filter block

**src/components/layout/LeftSidebar.tsx**:
- The unorganized count can remain 0 for now (would require a separate count query; not critical for this fix)

### Constraints

- "Unorganized" means: no tags AND no workspace_ids
- Empty JSON array `'[]'` counts as "no tags"/"no workspaces"
- NULL values also count as unorganized

## 4. Video Playback (HTML5 `<video>`)

### Problem

Videos (mp4, avi, mov, mkv, webm, flv, wmv) are mapped to `ViewerType = 'unsupported'` and rendered by `UnsupportedViewer`. No in-app playback exists.

### Solution

Add a `VideoViewer` component using HTML5 `<video>` with Tauri's `convertFileSrc()` for loading files via the asset protocol.

### Changes

**src/components/viewers/getViewerType.ts**:
- Add `'video'` to `ViewerType` union
- Add video extension set: `mp4`, `avi`, `mov`, `mkv`, `webm`, `flv`, `wmv`
- Add detection: if extension is video, return `'video'`
- Place video check before the fallback `'unsupported'` return

**src/components/viewers/VideoViewer.tsx** (new file):
```tsx
interface VideoViewerProps {
  filePath: string
  fileName: string
}
```
- Render `<video>` element with `src={convertFileSrc(filePath)}`
- Attributes: `controls`, `autoPlay`, `className="w-full h-full object-contain"`
- Playback controls: play/pause, seek, volume, fullscreen (native browser controls)
- Playback rate selector (0.5x, 1x, 1.5x, 2x) via custom overlay or native controls
- Handle unsupported format: listen for `<video>` error event, show error message + "open in default app" button
- Loop toggle button

**src/components/Lightbox.tsx**:
- Add `'video'` case to `renderViewer()` switch:
  ```tsx
  case 'video':
    return <VideoViewer filePath={previewAsset.path} fileName={previewAsset.name} />
  ```

### Format Coverage

| Format | Browser Support |
|--------|----------------|
| mp4 (H.264) | Native in all browsers |
| webm (VP8/VP9) | Native in Chromium |
| ogg | Native in Chromium |
| avi, mov, mkv, flv, wmv | May not play — fallback with error + "open in default app" |

### Constraints

- No additional npm dependencies
- Uses Tauri's `convertFileSrc()` for asset protocol (same pattern as ImageViewer)
- Video viewer does NOT support zoom (unlike ImageViewer)
- Keyboard shortcuts from Lightbox (arrow keys, ESC) work as normal for navigation
