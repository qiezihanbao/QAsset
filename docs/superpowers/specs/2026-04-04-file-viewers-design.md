# File Viewers Design - PDF, Text, Markdown Previewers

## Summary

Extend the existing Lightbox component to support previewing PDF, text/code, and Markdown files. Refactor Lightbox into a shell + sub-components architecture, adding three new viewer components while keeping the existing image preview intact.

## Architecture

### Component Structure

Refactor `Lightbox.tsx` into a shell that delegates rendering to type-specific viewer components:

```
Lightbox.tsx (shell - overlays, toolbar, navigation, keyboard shortcuts)
├── ImageViewer      → existing zoom/pan image logic (extracted)
├── PdfViewer        → pdfjs-dist, page navigation, zoom
├── TextViewer       → monospace text with line numbers + syntax highlighting
├── MarkdownViewer   → react-markdown rendered HTML with code highlighting
└── UnsupportedViewer → file icon + "open in default app" button
```

### File Type Routing

Determine viewer by `asset_type` + file extension:

```typescript
function getViewerType(asset: AssetInfo): 'image' | 'pdf' | 'text' | 'markdown' | 'unsupported'
```

| Category | Extensions | Viewer |
|----------|-----------|--------|
| Image | png, jpg, jpeg, gif, webp, svg, bmp, ico, avif, tif, tiff, jfif, jpe, jxl, base64, heic, heif, eps, ttf | ImageViewer |
| PDF | pdf | PdfViewer |
| Text | txt, log, csv, json, xml, yaml, yml, toml, ini, cfg, js, ts, tsx, jsx, py, rs, java, c, cpp, h, go, sh, bat, css, html, sql, rb, php, swift, kt, dart, lua, r, vue, svelte | TextViewer |
| Markdown | md, mdx | MarkdownViewer |
| Unsupported | everything else (dds, exr, doc, docx, etc.) | UnsupportedViewer |

Image formats that fail to load fall back to UnsupportedViewer (existing behavior).

## New Dependencies

```json
{
  "pdfjs-dist": "^4.x",
  "react-markdown": "^9.x",
  "remark-gfm": "^4.x",
  "rehype-highlight": "^7.x",
  "highlight.js": "^11.x"
}
```

- `pdfjs-dist`: PDF rendering on canvas
- `react-markdown`: Markdown to React elements
- `remark-gfm`: GitHub Flavored Markdown support (tables, strikethrough, task lists)
- `rehype-highlight`: Code block syntax highlighting via highlight.js
- `highlight.js`: Syntax highlighting engine with language detection

## Backend Changes

### New Tauri Command: `read_file_text`

Reads a file as UTF-8 text and returns the content string. Used by TextViewer and MarkdownViewer.

```rust
#[tauri::command]
async fn read_file_text(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read file: {}", e))
    }).await
    .map_err(|e| format!("Task error: {}", e))?
}
```

No changes needed for PDF (pdfjs-dist loads via `convertFileSrc` URL directly).

## Component Designs

### 1. Lightbox Shell (refactored from existing)

**What changes**: Extract the image-specific rendering logic into `ImageViewer`. The shell retains:
- Full-screen overlay with dark background
- Top toolbar: file counter, filename, zoom controls (image only), close button
- Left/right navigation arrows + keyboard shortcuts (ArrowLeft/Right)
- Escape to close, Enter to toggle fullscreen
- Type routing: determines which viewer component to render

**What stays the same**: All event handling, animation (framer-motion), navigation logic, keyboard shortcuts remain in the shell.

### 2. PdfViewer Component

**Responsibilities**:
- Load PDF via `pdfjs-dist` using `convertFileSrc(asset.path)` as the URL
- Render current page to a `<canvas>` element
- Page navigation: prev/next buttons + page number display (e.g., "3/12")
- Zoom: fit-to-width by default, manual zoom in/out via buttons
- Keyboard: ArrowUp/ArrowDown or PageUp/PageDown for page navigation

**Props**:
```typescript
interface PdfViewerProps {
  filePath: string    // asset.path for convertFileSrc
  fileName: string    // for display
}
```

**State**: `currentPage`, `totalPages`, `scale`

### 3. TextViewer Component

**Responsibilities**:
- Fetch file content via `invoke("read_file_text", { path })` on mount
- Display in monospace font with line numbers
- Syntax highlighting via highlight.js (auto-detect language from extension)
- Scrollable content area
- Show loading spinner while fetching, error message on failure

**Props**:
```typescript
interface TextViewerProps {
  filePath: string
  fileName: string   // used to detect language for highlighting
}
```

**State**: `content`, `loading`, `error`

**Styling**: Dark theme code block style matching the app's dark mode. Line numbers as a gutter on the left. Wrap long lines (no horizontal scroll needed for most files).

### 4. MarkdownViewer Component

**Responsibilities**:
- Fetch file content via `invoke("read_file_text", { path })` on mount
- Render using `react-markdown` with `remark-gfm` plugin
- Code blocks get syntax highlighting via `rehype-highlight`
- Scrollable rendered HTML area
- Styled prose: headings, lists, links, tables, images, blockquotes

**Props**:
```typescript
interface MarkdownViewerProps {
  filePath: string
  fileName: string
}
```

**State**: `content`, `loading`, `error`

**Styling**: Tailwind Typography-like prose styling. Match app dark mode. Links open in external browser.

### 5. UnsupportedViewer (enhanced)

**Current**: Shows "不支持预览该文件格式" with a file emoji.

**Enhanced**: Keep the message, add:
- File name display
- File size display
- File type label (from `asset_type`)
- "Open in default app" button that calls existing `invoke("open_in_default_app", { path })`

## Error Handling

- PDF load failure → show error message with "open externally" option
- Text read failure → show error message
- Large files (>1MB text) → show warning, option to load anyway
- Missing `read_file_text` command (web preview mode) → graceful fallback message

## Scope (Phase 1)

This phase implements:
- Lightbox refactoring into shell + sub-components
- PdfViewer (pdfjs-dist)
- TextViewer (monospace + syntax highlighting)
- MarkdownViewer (react-markdown + remark-gfm + rehype-highlight)
- UnsupportedViewer enhancement (open in default app button)
- Backend `read_file_text` command

Future phases:
- Phase 2: VideoPlayer (`<video>` tag)
- Phase 3: AudioPlayer (`<audio>` tag)
- Phase 4: HEIC/HEIF image support
- Phase 5: Office document preview (docx, xlsx, pptx)
