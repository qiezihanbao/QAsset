# File Viewers Implementation Plan (PDF, Text, Markdown)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PDF, text/code, and Markdown preview capability to the Lightbox component, refactoring it into a shell + sub-component architecture.

**Architecture:** Refactor the monolithic `Lightbox.tsx` into a shell (overlay, toolbar, navigation, keyboard shortcuts) that delegates rendering to type-specific viewer sub-components. Add a `read_file_text` Tauri command for text/MD loading. PDF loads via pdfjs-dist through `convertFileSrc`.

**Tech Stack:** React, TypeScript, pdfjs-dist, react-markdown, remark-gfm, rehype-highlight, highlight.js, Tauri v2

**Design Spec:** `docs/superpowers/specs/2026-04-04-file-viewers-design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/components/viewers/getViewerType.ts` | File extension → viewer type routing |
| Create | `src/components/viewers/ImageViewer.tsx` | Image zoom/pan (extracted from Lightbox) |
| Create | `src/components/viewers/PdfViewer.tsx` | PDF rendering via pdfjs-dist |
| Create | `src/components/viewers/TextViewer.tsx` | Text/code with line numbers + syntax highlighting |
| Create | `src/components/viewers/MarkdownViewer.tsx` | Markdown rendered to styled HTML |
| Create | `src/components/viewers/UnsupportedViewer.tsx` | Enhanced fallback with "open externally" button |
| Modify | `src/components/Lightbox.tsx` | Refactor to shell, import viewer sub-components |
| Modify | `src-tauri/src/lib.rs:133` | Add `read_file_text` command |
| Modify | `src/index.css` | Add highlight.js theme + markdown prose styles |

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install npm packages**

```bash
cd D:\Git\QuickAsset && npm install pdfjs-dist react-markdown remark-gfm rehype-highlight highlight.js
```

- [ ] **Step 2: Verify installation**

```bash
cd D:\Git\QuickAsset && npm ls pdfjs-dist react-markdown remark-gfm rehype-highlight highlight.js
```

Expected: All packages listed with versions.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add pdfjs-dist, react-markdown, highlight.js deps"
```

---

### Task 2: Add `read_file_text` Backend Command

**Files:**
- Modify: `src-tauri/src/lib.rs` (insert after `open_in_default_app` at line ~136, and add to handler list at line ~588)

- [ ] **Step 1: Add the command function**

Insert after the `open_in_default_app` function (after line 136) in `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
async fn read_file_text(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read file: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}
```

- [ ] **Step 2: Register the command in `invoke_handler`**

In the `run()` function at line ~586, add `read_file_text` to the handler list:

```rust
.invoke_handler(tauri::generate_handler![
    scan_directory, get_all_assets, update_asset,
    find_similar_images, check_health, delete_asset, show_in_folder, start_watcher,
    open_in_default_app, rename_asset, read_file_text
])
```

- [ ] **Step 3: Verify it compiles**

```bash
cd D:\Git\QuickAsset\src-tauri && cargo check
```

Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: add read_file_text backend command"
```

---

### Task 3: Create File Type Router

**Files:**
- Create: `src/components/viewers/getViewerType.ts`

- [ ] **Step 1: Create the viewer type utility**

```typescript
// src/components/viewers/getViewerType.ts

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
  'tif', 'tiff', 'jfif', 'jpe', 'jxl', 'base64', 'heic', 'heif',
  'hif', 'icns', 'eps', 'ttf', 'insp'
])

const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'go', 'sh', 'bat', 'css', 'html', 'sql', 'rb', 'php', 'swift', 'kt',
  'dart', 'lua', 'r', 'vue', 'svelte', 'mdx', 'ps1', 'conf', 'env',
  'gitignore', 'dockerfile', 'makefile', 'cmake', 'gradle', 'properties'
])

const MARKDOWN_EXTENSIONS = new Set(['md'])

const PDF_EXTENSIONS = new Set(['pdf'])

export type ViewerType = 'image' | 'pdf' | 'text' | 'markdown' | 'unsupported'

export function getViewerType(fileName: string, assetType: string): ViewerType {
  const ext = fileName.includes('.')
    ? fileName.split('.').pop()!.toLowerCase()
    : ''

  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (IMAGE_EXTENSIONS.has(ext) || assetType === 'image' || assetType === 'vector') return 'image'
  return 'unsupported'
}

export function getLanguageFromExt(fileName: string): string | undefined {
  const ext = fileName.includes('.')
    ? fileName.split('.').pop()!.toLowerCase()
    : ''

  const extToLang: Record<string, string> = {
    'js': 'javascript', 'jsx': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
    'py': 'python', 'rs': 'rust', 'java': 'java', 'c': 'c', 'cpp': 'cpp',
    'h': 'c', 'hpp': 'cpp', 'go': 'go', 'sh': 'bash', 'bat': 'batch',
    'css': 'css', 'html': 'xml', 'sql': 'sql', 'rb': 'ruby', 'php': 'php',
    'swift': 'swift', 'kt': 'kotlin', 'dart': 'dart', 'lua': 'lua',
    'r': 'r', 'vue': 'xml', 'svelte': 'xml', 'json': 'json',
    'yaml': 'yaml', 'yml': 'yaml', 'xml': 'xml', 'toml': 'ini',
    'ini': 'ini', 'cfg': 'ini', 'csv': 'plaintext', 'log': 'log',
    'md': 'markdown', 'mdx': 'markdown',
  }

  return extToLang[ext]
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/viewers/getViewerType.ts
git commit -m "feat: add file type router for viewer components"
```

---

### Task 4: Create ImageViewer Sub-Component

**Files:**
- Create: `src/components/viewers/ImageViewer.tsx`

This extracts the image rendering + zoom/pan logic from the current Lightbox.

- [ ] **Step 1: Create ImageViewer**

```tsx
// src/components/viewers/ImageViewer.tsx
import { useState, useCallback, useRef } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"

const MIN_ZOOM = 0.5
const MAX_ZOOM = 10
const ZOOM_STEP = 0.25
const WHEEL_ZOOM_FACTOR = 0.001

interface ImageViewerProps {
  filePath: string
  thumbnailBase64?: string
  zoom: number
  onZoomChange: (zoom: number) => void
}

export function ImageViewer({ filePath, thumbnailBase64, zoom, onZoomChange }: ImageViewerProps) {
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [imgError, setImgError] = useState(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const panStart = useRef({ x: 0, y: 0 })

  const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

  let imageSrc: string | null = null
  if (!imgError && isTauri) {
    imageSrc = convertFileSrc(filePath)
  } else if (thumbnailBase64) {
    imageSrc = thumbnailBase64
  }

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1) return
    e.preventDefault()
    setIsDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current = { ...pan }
  }, [zoom, pan])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    setPan({
      x: panStart.current.x + dx,
      y: panStart.current.y + dy,
    })
  }, [isDragging])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  if (!imageSrc) {
    return (
      <div className="text-white/50 flex flex-col items-center">
        <span className="text-6xl mb-4">📄</span>
        <p>无法加载图片</p>
      </div>
    )
  }

  return (
    <div
      className="w-full h-full flex items-center justify-center overflow-hidden"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
    >
      <img
        src={imageSrc}
        alt=""
        className="max-w-full max-h-full object-contain drop-shadow-2xl rounded-sm pointer-events-none"
        draggable={false}
        onError={() => setImgError(true)}
        style={{
          transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
          transition: isDragging ? 'none' : 'transform 0.1s ease-out',
        }}
      />
    </div>
  )
}

// Exported for Lightbox shell to use
export { MIN_ZOOM, MAX_ZOOM, ZOOM_STEP, WHEEL_ZOOM_FACTOR }
```

- [ ] **Step 2: Commit**

```bash
git add src/components/viewers/ImageViewer.tsx
git commit -m "feat: extract ImageViewer sub-component from Lightbox"
```

---

### Task 5: Create UnsupportedViewer Sub-Component

**Files:**
- Create: `src/components/viewers/UnsupportedViewer.tsx`

- [ ] **Step 1: Create UnsupportedViewer**

```tsx
// src/components/viewers/UnsupportedViewer.tsx
import { invoke } from "@tauri-apps/api/core"
import { FileText, ExternalLink } from "lucide-react"

interface UnsupportedViewerProps {
  fileName: string
  filePath: string
  fileSize: number
  assetType: string
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function UnsupportedViewer({ fileName, filePath, fileSize, assetType }: UnsupportedViewerProps) {
  const handleOpenExternally = async () => {
    try {
      await invoke("open_in_default_app", { path: filePath })
    } catch (e) {
      console.error("Failed to open file:", e)
    }
  }

  return (
    <div className="text-white/60 flex flex-col items-center justify-center h-full gap-3">
      <FileText className="w-16 h-16 text-white/30" />
      <p className="text-lg font-medium">不支持预览该文件格式</p>
      <div className="text-sm text-white/40 text-center space-y-1">
        <p>{fileName}</p>
        <p>{formatFileSize(fileSize)} · {assetType}</p>
      </div>
      <button
        onClick={handleOpenExternally}
        className="mt-2 flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white/70 hover:text-white transition-colors text-sm"
      >
        <ExternalLink className="w-4 h-4" />
        用系统默认程序打开
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/viewers/UnsupportedViewer.tsx
git commit -m "feat: add UnsupportedViewer with open-externally button"
```

---

### Task 6: Create TextViewer Sub-Component

**Files:**
- Create: `src/components/viewers/TextViewer.tsx`
- Modify: `src/index.css` (add highlight.js theme)

- [ ] **Step 1: Create TextViewer**

```tsx
// src/components/viewers/TextViewer.tsx
import { useEffect, useState, useRef, useCallback } from "react"
import { invoke } from "@tauri-apps/api/core"
import { Loader2 } from "lucide-react"
import { getLanguageFromExt } from "./getViewerType"
import hljs from "highlight.js"

interface TextViewerProps {
  filePath: string
  fileName: string
}

export function TextViewer({ filePath, fileName }: TextViewerProps) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const codeRef = useRef<HTMLElement>(null)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)

    const loadText = async () => {
      try {
        const text = await invoke<string>("read_file_text", { path: filePath })
        if (!cancelled) setContent(text)
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    }

    loadText()
    return () => { cancelled = true }
  }, [filePath])

  // Apply syntax highlighting after content loads
  useEffect(() => {
    if (content && codeRef.current) {
      const lang = getLanguageFromExt(fileName)
      if (lang) {
        try {
          hljs.highlightElement(codeRef.current)
        } catch {
          // Fallback: no highlighting
        }
      }
    }
  }, [content, fileName])

  if (error) {
    return (
      <div className="text-white/50 flex flex-col items-center justify-center h-full gap-2">
        <span className="text-4xl">⚠️</span>
        <p className="text-sm">无法读取文件</p>
        <p className="text-xs text-white/30 max-w-md text-center">{error}</p>
      </div>
    )
  }

  if (content === null) {
    return (
      <div className="text-white/50 flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    )
  }

  const lines = content.split('\n')

  return (
    <div className="w-full h-full overflow-auto p-4">
      <div className="flex text-sm font-mono">
        {/* Line numbers */}
        <div className="flex-shrink-0 pr-4 text-right text-white/20 select-none border-r border-white/10 mr-4">
          {lines.map((_, i) => (
            <div key={i} className="leading-6">{i + 1}</div>
          ))}
        </div>
        {/* Code content */}
        <pre className="flex-1 overflow-x-auto text-white/80 leading-6 m-0">
          <code ref={codeRef} className={`language-${getLanguageFromExt(fileName) || 'plaintext'}`}>
            {content}
          </code>
        </pre>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add highlight.js dark theme CSS to `src/index.css`**

Append at the end of `src/index.css`:

```css
/* Highlight.js GitHub Dark Dimmed theme (inline) */
.hljs{color:#adbac7;background:transparent}.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:#f47067}.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#dcbdfb}.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable{color:#6cb6ff}.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#96d0ff}.hljs-built_in,.hljs-symbol{color:#f69d50}.hljs-code,.hljs-comment,.hljs-formula{color:#768390}.hljs-name,.hljs-quote,.hljs-selector-pseudo,.hljs-selector-tag{color:#8ddb8c}.hljs-subst{color:#adbac7}.hljs-section{color:#316dca;font-weight:700}.hljs-bullet{color:#eac55f}.hljs-emphasis{color:#adbac7;font-style:italic}.hljs-strong{color:#adbac7;font-weight:700}.hljs-addition{color:#b4f1b4;background-color:#1b4721}.hljs-deletion{color:#ffd8d3;background-color:#78191b}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/viewers/TextViewer.tsx src/index.css
git commit -m "feat: add TextViewer with syntax highlighting"
```

---

### Task 7: Create MarkdownViewer Sub-Component

**Files:**
- Create: `src/components/viewers/MarkdownViewer.tsx`
- Modify: `src/index.css` (add markdown prose styles)

- [ ] **Step 1: Create MarkdownViewer**

```tsx
// src/components/viewers/MarkdownViewer.tsx
import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { Loader2 } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"

interface MarkdownViewerProps {
  filePath: string
  fileName: string
}

export function MarkdownViewer({ filePath, fileName: _fileName }: MarkdownViewerProps) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)

    const loadText = async () => {
      try {
        const text = await invoke<string>("read_file_text", { path: filePath })
        if (!cancelled) setContent(text)
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    }

    loadText()
    return () => { cancelled = true }
  }, [filePath])

  if (error) {
    return (
      <div className="text-white/50 flex flex-col items-center justify-center h-full gap-2">
        <span className="text-4xl">⚠️</span>
        <p className="text-sm">无法读取文件</p>
        <p className="text-xs text-white/30 max-w-md text-center">{error}</p>
      </div>
    )
  }

  if (content === null) {
    return (
      <div className="text-white/50 flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    )
  }

  return (
    <div className="w-full h-full overflow-auto p-6 md:p-10">
      <div className="markdown-body max-w-3xl mx-auto">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add markdown prose styles to `src/index.css`**

Append after the highlight.js styles:

```css
/* Markdown prose styles (dark mode) */
.markdown-body{color:#c9d1d9;font-size:14px;line-height:1.7;word-wrap:break-word}
.markdown-body h1{font-size:2em;border-bottom:1px solid #30363d;padding-bottom:.3em;margin:1em 0 .6em}
.markdown-body h2{font-size:1.5em;border-bottom:1px solid #30363d;padding-bottom:.3em;margin:1em 0 .6em}
.markdown-body h3{font-size:1.25em;margin:1em 0 .5em}
.markdown-body h4,.markdown-body h5,.markdown-body h6{font-size:1em;margin:1em 0 .5em}
.markdown-body p{margin:.5em 0 1em}
.markdown-body ul,.markdown-body ol{margin:.5em 0 1em;padding-left:2em}
.markdown-body li{margin:.25em 0}
.markdown-body blockquote{border-left:4px solid #30363d;padding:.5em 1em;color:#8b949e;margin:.5em 0 1em;background:#161b22}
.markdown-body code{background:#1b1f24;padding:.2em .4em;border-radius:4px;font-size:85%;font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace}
.markdown-body pre{background:#0d1117;border-radius:6px;padding:1em;overflow-x:auto;margin:.5em 0 1em}
.markdown-body pre code{background:none;padding:0;font-size:100%}
.markdown-body table{border-collapse:collapse;width:100%;margin:.5em 0 1em}
.markdown-body th,.markdown-body td{border:1px solid #30363d;padding:.5em .75em;text-align:left}
.markdown-body th{background:#161b22;font-weight:600}
.markdown-body tr:nth-child(2n){background:#0d1117}
.markdown-body a{color:#58a6ff;text-decoration:none}
.markdown-body a:hover{text-decoration:underline}
.markdown-body hr{border:none;border-top:1px solid #30363d;margin:1.5em 0}
.markdown-body img{max-width:100%;border-radius:6px}
.markdown-body input[type="checkbox"]{margin-right:.5em}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/viewers/MarkdownViewer.tsx src/index.css
git commit -m "feat: add MarkdownViewer with styled rendering"
```

---

### Task 8: Create PdfViewer Sub-Component

**Files:**
- Create: `src/components/viewers/PdfViewer.tsx`

This is the most complex viewer. Uses pdfjs-dist to render PDF pages onto a canvas.

- [ ] **Step 1: Create PdfViewer**

```tsx
// src/components/viewers/PdfViewer.tsx
import { useEffect, useState, useRef, useCallback } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2 } from "lucide-react"
import * as pdfjsLib from "pdfjs-dist"

// Set worker source - use CDN matching the installed version
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`

interface PdfViewerProps {
  filePath: string
  fileName: string
}

export function PdfViewer({ filePath }: PdfViewerProps) {
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [scale, setScale] = useState(1.2)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Load PDF document
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPdfDoc(null)
    setCurrentPage(1)
    setTotalPages(0)

    const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
    const url = isTauri ? convertFileSrc(filePath) : filePath

    const loadPdf = async () => {
      try {
        const doc = await pdfjsLib.getDocument(url).promise
        if (!cancelled) {
          setPdfDoc(doc)
          setTotalPages(doc.numPages)
          setLoading(false)
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e))
          setLoading(false)
        }
      }
    }

    loadPdf()
    return () => { cancelled = true }
  }, [filePath])

  // Render current page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return

    let cancelled = false
    const renderPage = async () => {
      try {
        const page = await pdfDoc.getPage(currentPage)
        if (cancelled) return

        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current!
        const context = canvas.getContext('2d')!

        canvas.height = viewport.height
        canvas.width = viewport.width

        await page.render({
          canvasContext: context,
          viewport: viewport,
        }).promise
      } catch (e) {
        console.error('Failed to render page:', e)
      }
    }

    renderPage()
    return () => { cancelled = true }
  }, [pdfDoc, currentPage, scale])

  const goToPage = useCallback((page: number) => {
    setCurrentPage(p => Math.max(1, Math.min(page, totalPages)))
  }, [totalPages])

  const handleZoomIn = useCallback(() => {
    setScale(s => Math.min(s + 0.2, 3))
  }, [])

  const handleZoomOut = useCallback(() => {
    setScale(s => Math.max(s - 0.2, 0.5))
  }, [])

  if (loading) {
    return (
      <div className="text-white/50 flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-white/50 flex flex-col items-center justify-center h-full gap-2">
        <span className="text-4xl">⚠️</span>
        <p className="text-sm">无法加载 PDF</p>
        <p className="text-xs text-white/30 max-w-md text-center">{error}</p>
      </div>
    )
  }

  return (
    <div className="w-full h-full flex flex-col items-center">
      {/* PDF content */}
      <div className="flex-1 overflow-auto flex items-start justify-center p-4">
        <canvas ref={canvasRef} className="shadow-2xl" />
      </div>

      {/* Page controls */}
      <div className="flex-shrink-0 flex items-center gap-3 py-3 px-4 text-white/70 text-sm bg-black/30 rounded-t-lg">
        <button
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage <= 1}
          className="p-1 hover:text-white hover:bg-white/10 rounded disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-white/70 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <span className="min-w-[60px] text-center">
          {currentPage} / {totalPages}
        </span>

        <button
          onClick={() => goToPage(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className="p-1 hover:text-white hover:bg-white/10 rounded disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-white/70 transition-colors"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        <div className="w-px h-4 bg-white/20" />

        <button
          onClick={handleZoomOut}
          className="p-1 hover:text-white hover:bg-white/10 rounded transition-colors"
        >
          <ZoomOut className="w-4 h-4" />
        </button>

        <span className="text-xs text-white/50 w-12 text-center">{Math.round(scale * 100)}%</span>

        <button
          onClick={handleZoomIn}
          className="p-1 hover:text-white hover:bg-white/10 rounded transition-colors"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/viewers/PdfViewer.tsx
git commit -m "feat: add PdfViewer with page navigation and zoom"
```

---

### Task 9: Refactor Lightbox into Shell

**Files:**
- Modify: `src/components/Lightbox.tsx`

This is the critical refactoring step. The existing Lightbox becomes a thin shell that delegates to sub-components based on file type.

- [ ] **Step 1: Rewrite Lightbox.tsx as shell**

The new Lightbox keeps: overlay, top toolbar, navigation arrows, keyboard shortcuts, wheel zoom for images. It delegates content rendering to the viewer sub-components.

```tsx
// src/components/Lightbox.tsx
import { useEffect, useCallback, useState, useRef } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCcw } from "lucide-react"
import { useAssetStore } from "@/store/useAssetStore"
import { getViewerType } from "@/components/viewers/getViewerType"
import { ImageViewer, MIN_ZOOM, MAX_ZOOM, ZOOM_STEP, WHEEL_ZOOM_FACTOR } from "@/components/viewers/ImageViewer"
import { PdfViewer } from "@/components/viewers/PdfViewer"
import { TextViewer } from "@/components/viewers/TextViewer"
import { MarkdownViewer } from "@/components/viewers/MarkdownViewer"
import { UnsupportedViewer } from "@/components/viewers/UnsupportedViewer"

export function Lightbox() {
  const { previewAsset, setPreviewAsset, isFullscreenPreview, setFullscreenPreview, assets } = useAssetStore()

  const [zoom, setZoom] = useState(1)
  const containerRef = useRef<HTMLDivElement>(null)

  const resetTransform = useCallback(() => {
    setZoom(1)
  }, [])

  // Reset zoom when switching assets
  useEffect(() => {
    resetTransform()
  }, [previewAsset?.id, resetTransform])

  const navigate = useCallback((direction: number) => {
    if (!previewAsset) return
    const currentIndex = assets.findIndex(a => a.id === previewAsset.id)
    let newIndex = currentIndex + direction
    if (newIndex >= assets.length) newIndex = 0
    if (newIndex < 0) newIndex = assets.length - 1
    setPreviewAsset(assets[newIndex], true)
  }, [previewAsset, assets, setPreviewAsset])

  const handleZoomIn = useCallback(() => {
    setZoom(z => Math.min(z + ZOOM_STEP, MAX_ZOOM))
  }, [])

  const handleZoomOut = useCallback(() => {
    setZoom(z => Math.max(z - ZOOM_STEP, MIN_ZOOM))
  }, [])

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const delta = -e.deltaY * WHEEL_ZOOM_FACTOR
    setZoom(z => {
      const newZoom = Math.min(Math.max(z + z * delta, MIN_ZOOM), MAX_ZOOM)
      return newZoom
    })
  }, [])

  // Mouse wheel zoom (only for image viewer)
  const viewerType = previewAsset ? getViewerType(previewAsset.name, previewAsset.asset_type) : null
  const isImageViewer = viewerType === 'image'

  useEffect(() => {
    if (!previewAsset || !isFullscreenPreview || !isImageViewer) return
    const container = containerRef.current
    if (!container) return
    container.addEventListener("wheel", handleWheel, { passive: false })
    return () => container.removeEventListener("wheel", handleWheel)
  }, [previewAsset, isFullscreenPreview, handleWheel, isImageViewer])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!previewAsset || !isFullscreenPreview) return
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return

      if (e.key === "Escape") {
        e.preventDefault()
        setFullscreenPreview(false)
      } else if (e.key === "ArrowRight") {
        navigate(1)
      } else if (e.key === "ArrowLeft") {
        navigate(-1)
      } else if ((e.key === "+" || e.key === "=") && isImageViewer) {
        handleZoomIn()
      } else if (e.key === "-" && isImageViewer) {
        handleZoomOut()
      } else if (e.key === "0" && isImageViewer) {
        resetTransform()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [previewAsset, isFullscreenPreview, setFullscreenPreview, navigate, handleZoomIn, handleZoomOut, resetTransform, isImageViewer])

  if (!previewAsset || !isFullscreenPreview) return null

  const currentIndex = assets.findIndex(a => a.id === previewAsset.id)
  const zoomPercent = Math.round(zoom * 100)

  const renderViewer = () => {
    switch (viewerType) {
      case 'image':
        return (
          <ImageViewer
            filePath={previewAsset.path}
            thumbnailBase64={previewAsset.thumbnail_base64}
            zoom={zoom}
            onZoomChange={setZoom}
          />
        )
      case 'pdf':
        return <PdfViewer filePath={previewAsset.path} fileName={previewAsset.name} />
      case 'text':
        return <TextViewer filePath={previewAsset.path} fileName={previewAsset.name} />
      case 'markdown':
        return <MarkdownViewer filePath={previewAsset.path} fileName={previewAsset.name} />
      default:
        return (
          <UnsupportedViewer
            fileName={previewAsset.name}
            filePath={previewAsset.path}
            fileSize={previewAsset.size}
            assetType={previewAsset.asset_type}
          />
        )
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        ref={containerRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm select-none"
        onClick={() => setFullscreenPreview(false)}
      >
        {/* Top Bar */}
        <div
          className="absolute top-0 left-0 right-0 z-10 p-3 flex items-center justify-between text-white/70 bg-gradient-to-b from-black/50 to-transparent"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-sm truncate max-w-[50%]">
            {currentIndex + 1} / {assets.length} - {previewAsset.name}
          </div>
          <div className="flex items-center gap-1">
            {isImageViewer && (
              <>
                <span className="text-xs text-white/50 mr-2 w-12 text-center">{zoomPercent}%</span>
                <button
                  onClick={handleZoomOut}
                  className="p-1.5 hover:text-white hover:bg-white/10 rounded-full transition-colors"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                <button
                  onClick={handleZoomIn}
                  className="p-1.5 hover:text-white hover:bg-white/10 rounded-full transition-colors"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
                <button
                  onClick={resetTransform}
                  className="p-1.5 hover:text-white hover:bg-white/10 rounded-full transition-colors"
                  title="重置缩放"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
                <div className="w-px h-5 bg-white/20 mx-1" />
              </>
            )}
            <button
              onClick={() => setFullscreenPreview(false)}
              className="p-1.5 hover:text-white hover:bg-red-500/80 rounded-full transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Navigation Buttons */}
        <button
          onClick={(e) => { e.stopPropagation(); navigate(-1) }}
          className="absolute left-2 z-10 p-2 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-colors"
        >
          <ChevronLeft className="w-7 h-7" />
        </button>

        <button
          onClick={(e) => { e.stopPropagation(); navigate(1) }}
          className="absolute right-2 z-10 p-2 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-colors"
        >
          <ChevronRight className="w-7 h-7" />
        </button>

        {/* Content - Viewer Component */}
        <motion.div
          key={previewAsset.id}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="w-full h-full pt-12 pb-4 px-12 overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {renderViewer()}
        </motion.div>

        {/* Bottom hint */}
        {isImageViewer && zoom <= 1 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/30 text-xs">
            滚轮缩放 · 方向键切换 · ESC 关闭
          </div>
        )}
        {!isImageViewer && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/30 text-xs">
            方向键切换 · ESC 关闭
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Lightbox.tsx
git commit -m "refactor: Lightbox into shell + viewer sub-components"
```

---

### Task 10: Verify Build and Test

**Files:** None (verification only)

- [ ] **Step 1: Run TypeScript check**

```bash
cd D:\Git\QuickAsset && npm run check
```

Expected: No type errors.

- [ ] **Step 2: Run frontend build**

```bash
cd D:\Git\QuickAsset && npm run build
```

Expected: Build completes without errors.

- [ ] **Step 3: Run Rust check**

```bash
cd D:\Git\QuickAsset\src-tauri && cargo check
```

Expected: Compiles without errors.

- [ ] **Step 4: Manual smoke test**

```bash
cd D:\Git\QuickAsset && npm run tauri dev
```

Test the following:
1. Double-click an image → opens in ImageViewer with zoom/pan (existing behavior preserved)
2. Double-click a `.txt` or `.json` file → opens in TextViewer with line numbers
3. Double-click a `.md` file → opens in MarkdownViewer with rendered HTML
4. Double-click a `.pdf` file → opens in PdfViewer with page navigation
5. Double-click an unsupported file (e.g., `.zip`) → shows UnsupportedViewer with "open externally" button
6. Left/Right arrow keys navigate between assets regardless of type
7. ESC closes preview

- [ ] **Step 5: Fix any issues found during testing**

Fix any build errors or runtime issues.

- [ ] **Step 6: Commit fixes if needed**

```bash
git add -A
git commit -m "fix: resolve build/runtime issues from viewer integration"
```

---

## Summary of Commits

1. `chore: add pdfjs-dist, react-markdown, highlight.js deps`
2. `feat: add read_file_text backend command`
3. `feat: add file type router for viewer components`
4. `feat: extract ImageViewer sub-component from Lightbox`
5. `feat: add UnsupportedViewer with open-externally button`
6. `feat: add TextViewer with syntax highlighting`
7. `feat: add MarkdownViewer with styled rendering`
8. `feat: add PdfViewer with page navigation and zoom`
9. `refactor: Lightbox into shell + viewer sub-components`
10. `fix: resolve build/runtime issues from viewer integration` (if needed)
