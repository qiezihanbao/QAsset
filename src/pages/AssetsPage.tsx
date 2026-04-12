import { Image as ImageIcon, FileText, Video, Box, ChevronLeft, ChevronRight, Filter, Grid, Search, ChevronDown, Columns, FolderOpen, Folder, Trash2, Copy, Edit2, MoveRight, PlusCircle, Tag, Image, Link, Star, HardDrive, Maximize2, Ruler } from "lucide-react"
import { useAssetStore, AssetLite, AssetFilters, type AssetDetail, type Workspace, type ViewType } from "@/store/useAssetStore"
import * as ContextMenu from '@radix-ui/react-context-menu'
import { invoke } from "@tauri-apps/api/core"
import { convertFileSrc } from "@tauri-apps/api/core"
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef, useMemo, useEffect, useState, useCallback, lazy, Suspense, startTransition } from 'react'
import { useShallow } from 'zustand/react/shallow'
import Selecto from "react-selecto"

const TagsView = lazy(() =>
  import("./TagsView").then((m) => ({ default: m.TagsView }))
)
const ColorWheelPicker = lazy(() =>
  import("@/components/ColorWheelPicker").then((m) => ({ default: m.ColorWheelPicker }))
)
const WorkspaceCanvasView = lazy(() =>
  import("@/components/workspace/WorkspaceCanvasView").then((m) => ({ default: m.WorkspaceCanvasView }))
)

type QuickAssetWindow = Window & {
  __TAURI_INTERNALS__?: unknown
  __TAURI__?: unknown
  __loadAssets?: () => Promise<void> | void
}

const getQuickWindow = () => window as QuickAssetWindow

const safeInvoke = async <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T | undefined> => {
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
    return await invoke<T>(command, args)
  }
  console.warn(`Tauri not available, skipped: ${command}`, args)
  return undefined
}

const isTauri = () => {
  const appWindow = getQuickWindow()
  return Boolean(appWindow.__TAURI_INTERNALS__ || appWindow.__TAURI__)
}
const THUMBNAIL_FIRST_EXTENSIONS = new Set(['psd', 'psb', 'clip'])
const SEARCH_DEBOUNCE_MS = 250
const INCREMENTAL_PAGE_SIZE = 120
const FULL_FETCH_PAGE_SIZE = 10000
const LOAD_MORE_THRESHOLD_PX = 900
const CUSTOM_SORT_FALLBACK_RANK = Number.MAX_SAFE_INTEGER
const PAGE_COMMIT_CHUNK_SIZE = 24
const REPLACE_COMMIT_CHUNK_THRESHOLD = 300
const THUMBNAIL_ENSURE_CONCURRENCY = 2
const SCROLL_PREDICT_MS = 500
const FAST_SCROLL_PX_PER_MS = 1.2
const MAX_FAST_PREFETCH_PAGES = 2
const OVERSCAN_RATIO = 0.4
const MIN_PRIORITY_PRELOAD_COUNT = 18
const MAX_PRIORITY_PRELOAD_COUNT = 36
const IDLE_PRELOAD_MULTIPLIER = 2
const IDLE_PRELOAD_BATCH_SIZE = 6
const ACTIVE_SCROLL_IDLE_PRELOAD_THRESHOLD = 0.2
const BACKEND_PREFETCH_MIN_INTERVAL_MS = 80
const BACKEND_PREFETCH_LEAD_MULTIPLIER = 1.25
const BACKEND_PREFETCH_MAX_LEAD_IDS = 96
const QA_DND_ASSET_MIME = "application/x-quickasset-assets"

function readDraggedAssetIds(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer) return []
  const raw = dataTransfer.getData(QA_DND_ASSET_MIME)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as { assetIds?: unknown }
    if (!Array.isArray(parsed.assetIds)) return []
    const unique = new Set<string>()
    for (const item of parsed.assetIds) {
      if (typeof item !== "string") continue
      const trimmed = item.trim()
      if (!trimmed) continue
      unique.add(trimmed)
    }
    return Array.from(unique)
  } catch {
    return []
  }
}

const nextAnimationFrame = () => new Promise<void>((resolve) => {
  window.requestAnimationFrame(() => resolve())
})

let thumbnailEnsureActiveCount = 0
const thumbnailEnsureWaiters: Array<() => void> = []
const thumbnailEnsureInFlight = new Map<string, Promise<string | null | undefined>>()
const resolvedThumbnailPathCache = new Map<string, string>()
const preloadedCardImageSrcCache = new Set<string>()

const scheduleIdleTask = (callback: () => void): number => {
  const idleWindow = window as Window & {
    requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number
  }
  if (typeof idleWindow.requestIdleCallback === 'function') {
    return idleWindow.requestIdleCallback(callback, { timeout: 250 })
  }
  return window.setTimeout(callback, 32)
}

const cancelIdleTask = (taskId: number) => {
  const idleWindow = window as Window & { cancelIdleCallback?: (id: number) => void }
  if (typeof idleWindow.cancelIdleCallback === 'function') {
    idleWindow.cancelIdleCallback(taskId)
    return
  }
  window.clearTimeout(taskId)
}

const preloadCardImageSrc = (src: string) => {
  if (!src || preloadedCardImageSrcCache.has(src)) return
  preloadedCardImageSrcCache.add(src)
  const img = document.createElement('img')
  img.decoding = 'async'
  img.src = src
}

const acquireThumbnailEnsureSlot = async () => {
  if (thumbnailEnsureActiveCount < THUMBNAIL_ENSURE_CONCURRENCY) {
    thumbnailEnsureActiveCount += 1
    return
  }
  await new Promise<void>((resolve) => {
    thumbnailEnsureWaiters.push(resolve)
  })
  thumbnailEnsureActiveCount += 1
}

const releaseThumbnailEnsureSlot = () => {
  thumbnailEnsureActiveCount = Math.max(0, thumbnailEnsureActiveCount - 1)
  const next = thumbnailEnsureWaiters.shift()
  if (next) next()
}

const ensureAssetThumbnailQueued = async (assetId: string) => {
  const inFlightTask = thumbnailEnsureInFlight.get(assetId)
  if (inFlightTask) {
    return inFlightTask
  }

  const task = (async () => {
    await acquireThumbnailEnsureSlot()
    try {
      return await safeInvoke<string | null>("ensure_asset_thumbnail", { id: assetId })
    } finally {
      releaseThumbnailEnsureSlot()
    }
  })()

  thumbnailEnsureInFlight.set(assetId, task)
  task.finally(() => {
    thumbnailEnsureInFlight.delete(assetId)
  })
  return task
}

function hashStringWithSeed(input: string, seed: number): number {
  let hash = seed | 0
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0
  }
  return hash >>> 0
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

interface QueryAssetsResult {
  total_count: number
  items: AssetLite[]
}

interface AssetCardProps {
  asset: AssetLite
  isSelected: boolean
  layoutMode: "grid" | "masonry" | "canvas"
  workspaces: Workspace[]
  dragAssetIds?: string[]
  priority?: boolean
  onSelect: (e: React.MouseEvent) => void
  onContextMenu: () => void
  onPreview: () => void
  onShowInFolder: () => void
  onPreviewFolder: () => void
  onSearchSimilar: () => void
  onDelete: (hardDelete: boolean) => void
  onAssignWorkspace: (workspaceId: string) => Promise<void> | void
  onQuickAddTag?: () => void
  activeView: ViewType
}

function getFileExt(fileNameOrPath: string): string {
  if (!fileNameOrPath.includes('.')) return ''
  return fileNameOrPath.split('.').pop()!.toLowerCase()
}

function getCardImageSrc(asset: AssetLite, overrideThumbnailPath?: string | null): string | null {
  if (!isTauri()) return null
  const thumbnailPath = overrideThumbnailPath ?? asset.thumbnail_path
  if (asset.asset_type === 'video') {
    return thumbnailPath ? convertFileSrc(thumbnailPath) : null
  }
  const ext = getFileExt(asset.name || asset.path)
  if (asset.asset_type === 'image' || THUMBNAIL_FIRST_EXTENSIONS.has(ext)) {
    return (thumbnailPath || asset.path) ? convertFileSrc(thumbnailPath || asset.path) : null
  }
  return asset.path ? convertFileSrc(asset.path) : null
}

function getFolderPreviewSrc(folder: FolderInfo): string | null {
  if (!isTauri()) return null
  const filePath = folder.preview_thumbnail_path || folder.preview_asset_path
  return filePath ? convertFileSrc(filePath) : null
}

// Simple color distance using euclidean distance in RGB space
function hexToRgb(hex: string) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 }
}

function colorDistance(hex1: string, hex2: string) {
  const c1 = hexToRgb(hex1)
  const c2 = hexToRgb(hex2)
  return Math.sqrt(
    Math.pow(c1.r - c2.r, 2) +
    Math.pow(c1.g - c2.g, 2) +
    Math.pow(c1.b - c2.b, 2)
  )
}

const SIZE_FILTER_OPTIONS = [
  { label: '< 100 KB', min: 0, max: 100 * 1024 },
  { label: '100 KB - 1 MB', min: 100 * 1024, max: 1024 * 1024 },
  { label: '1 MB - 10 MB', min: 1024 * 1024, max: 10 * 1024 * 1024 },
  { label: '10 MB - 100 MB', min: 10 * 1024 * 1024, max: 100 * 1024 * 1024 },
  { label: '> 100 MB', min: 100 * 1024 * 1024, max: Infinity },
]

const RATING_FILTER_OPTIONS = [1, 2, 3, 4, 5]

const SHAPE_FILTER_OPTIONS = [
  { label: '方图', shape: 'square' },
  { label: '宽图', shape: 'wide' },
  { label: '竖图', shape: 'tall' },
  { label: '长图', shape: 'panoramic' },
]

interface FolderInfo {
  path: string
  parent_path: string | null
  display_name: string
  asset_count: number
  show_subfolders: boolean
  preview_thumbnail_path?: string | null
  preview_asset_path?: string | null
  preview_asset_type?: string | null
}

function getAssetColor(type: string) {
  switch (type) {
    case 'image': return 'bg-indigo-500 text-indigo-500'
    case 'video': return 'bg-rose-500 text-rose-500'
    case 'document': return 'bg-emerald-500 text-emerald-500'
    default: return 'bg-zinc-500 text-zinc-500'
  }
}

function getAssetIcon(type: string) {
  switch (type) {
    case 'image': return <ImageIcon className="w-8 h-8" />
    case 'video': return <Video className="w-8 h-8" />
    case 'document': return <FileText className="w-8 h-8" />
    default: return <Box className="w-8 h-8" />
  }
}

function AssetCard({ asset, isSelected, layoutMode, workspaces, dragAssetIds, priority = false, onSelect, onContextMenu, onPreview, onShowInFolder, onPreviewFolder, onSearchSimilar, onDelete, onAssignWorkspace, onQuickAddTag, activeView }: AssetCardProps) {
  const [resolvedThumbnailPath, setResolvedThumbnailPath] = useState<string | null>(() => (
    asset.thumbnail_path || resolvedThumbnailPathCache.get(asset.id) || null
  ))

  useEffect(() => {
    setResolvedThumbnailPath(asset.thumbnail_path || resolvedThumbnailPathCache.get(asset.id) || null)
  }, [asset.id, asset.thumbnail_path])

  useEffect(() => {
    if (!isTauri()) return
    const ext = getFileExt(asset.name || asset.path)
    const requiresThumbnail = asset.asset_type === 'video' || THUMBNAIL_FIRST_EXTENSIONS.has(ext)
    if (!requiresThumbnail) return
    if (resolvedThumbnailPath) return

    let cancelled = false
    ensureAssetThumbnailQueued(asset.id)
      .then((thumbnailPath) => {
        if (cancelled) return
        if (typeof thumbnailPath === 'string' && thumbnailPath.length > 0) {
          resolvedThumbnailPathCache.set(asset.id, thumbnailPath)
          setResolvedThumbnailPath(thumbnailPath)
        }
      })
      .catch((err) => {
        console.warn("Failed to generate video thumbnail:", err)
      })

    return () => {
      cancelled = true
    }
  }, [asset.id, asset.asset_type, asset.name, asset.path, resolvedThumbnailPath])

  const handleCopyPath = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(asset.path)
      alert("路径已复制到剪贴板")
    } catch (err) {
      console.error("Failed to copy path:", err)
    }
  }

  const handleOpenDefaultApp = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await safeInvoke("open_in_default_app", { path: asset.path })
    } catch (err) {
      console.error("Failed to open file:", err)
    }
  }

  const handleRename = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const newName = window.prompt("输入新的文件名 (包含扩展名):", asset.name)
    if (newName && newName !== asset.name) {
      try {
        await safeInvoke("rename_asset", { id: asset.id, newName })
        // Reload assets to reflect the rename
        await getQuickWindow().__loadAssets?.()
      } catch (err) {
        alert("重命名失败: " + err)
      }
    }
  }

  const ext = getFileExt(asset.name || asset.path)
  const isImageAsset = asset.asset_type === 'image' || THUMBNAIL_FIRST_EXTENSIONS.has(ext)
  const imageSrc = getCardImageSrc(asset, resolvedThumbnailPath)
  const hasVisualPreview = !!imageSrc && (isImageAsset || asset.asset_type === 'video')
  const previewAspectRatio = (() => {
    if (layoutMode === 'grid') return 1
    const safeWidth = Math.max(1, asset.width || 1)
    const safeHeight = Math.max(1, asset.height || 1)
    const ratio = safeWidth / safeHeight
    return Math.min(4, Math.max(0.25, ratio))
  })()

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    const ids = dragAssetIds && dragAssetIds.length > 0 ? Array.from(new Set(dragAssetIds)) : [asset.id]
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(QA_DND_ASSET_MIME, JSON.stringify({ assetIds: ids }))
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger onContextMenu={onContextMenu}>
        <div
          data-id={asset.id}
          draggable
          onClick={onSelect}
          onDragStart={handleDragStart}
          onDoubleClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onPreview?.()
          }}
          className="selectable-asset group flex flex-col items-center cursor-pointer break-inside-avoid"
        >
          <div className={`relative w-full rounded-xl overflow-hidden transition-all duration-200 ${
            isSelected
              ? "ring-2 ring-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.4)]"
              : "ring-1 ring-zinc-200 dark:ring-zinc-800 hover:ring-zinc-300 dark:hover:ring-zinc-700"
          }`}>
            <div className={`w-full flex items-center justify-center ${!hasVisualPreview ? getAssetColor(asset.asset_type) : ''} bg-zinc-100 dark:bg-zinc-900 bg-opacity-10 dark:bg-opacity-10`}>
              {hasVisualPreview ? (
                <div className="w-full overflow-hidden" style={{ aspectRatio: previewAspectRatio }}>
                  <img
                  src={imageSrc}
                  alt={asset.name}
                  loading={priority ? 'eager' : 'lazy'}
                  decoding="async"
                    className={`h-full w-full ${layoutMode === 'grid' ? 'object-cover' : 'object-contain'} transition-opacity duration-300`}
                    onError={(e) => {
                      // Hide broken images and show fallback
                      (e.target as HTMLImageElement).style.display = 'none'
                      const parent = (e.target as HTMLImageElement).parentElement
                      if (parent) {
                        parent.classList.add(getAssetColor(asset.asset_type).split(' ')[0])
                        const fallback = document.createElement('div')
                        fallback.className = 'py-12'
                        fallback.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`
                        parent.appendChild(fallback)
                      }
                    }}
                  />
                </div>
              ) : (
                <div className="py-12">{getAssetIcon(asset.asset_type)}</div>
              )}
            </div>
          </div>
          <div className="mt-3 text-center w-full">
            <p
              className={`text-[13px] font-medium truncate px-2 py-0.5 rounded-md inline-block max-w-full ${
                isSelected
                  ? 'bg-indigo-500 text-white'
                  : 'text-zinc-800 dark:text-zinc-200 hover:text-indigo-500'
              }`}
              title={asset.name}
            >
              {asset.name}
            </p>
            <p className="text-[11px] text-zinc-400 mt-1">
              {asset.width && asset.height ? `${asset.width}x${asset.height}` : asset.asset_type.toUpperCase()}  {(asset.size / 1024).toFixed(1)} KB
            </p>
          </div>
        </div>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content
          className="min-w-[180px] bg-white dark:bg-zinc-900 rounded-md overflow-hidden p-1 shadow-[0px_10px_38px_-10px_rgba(22,_23,_24,_0.35),_0px_10px_20px_-15px_rgba(22,_23,_24,_0.2)] border border-zinc-200 dark:border-zinc-800 animate-in fade-in-80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 z-50"
        >
          <ContextMenu.Item
            onClick={handleOpenDefaultApp}
            className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer justify-between"
          >
            <div className="flex items-center">
              <Box className="w-4 h-4 mr-2 opacity-70" />
              <span>在默认应用中打开</span>
            </div>
            <span className="text-xs text-zinc-400 group-data-[highlighted]:text-white/70">Ctrl+O</span>
          </ContextMenu.Item>
          <ContextMenu.Item
            onClick={onShowInFolder}
            className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer"
          >
            <FolderOpen className="w-4 h-4 mr-2 opacity-70" />
            在文件夹中显示
          </ContextMenu.Item>
          <ContextMenu.Item
            onClick={onPreviewFolder}
            className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer"
          >
            <FolderOpen className="w-4 h-4 mr-2 opacity-70" />
            显示所在文件夹预览
          </ContextMenu.Item>

          <ContextMenu.Separator className="h-[1px] bg-zinc-200 dark:bg-zinc-800 m-1" />

          <ContextMenu.Item
            className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer justify-between"
          >
            <div className="flex items-center">
              <MoveRight className="w-4 h-4 mr-2 opacity-70" />
              <span>移动到文件夹...</span>
            </div>
            <span className="text-xs text-zinc-400 group-data-[highlighted]:text-white/70">F</span>
          </ContextMenu.Item>

          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[state=open]:bg-indigo-500 data-[state=open]:text-white data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer justify-between">
              <div className="flex items-center">
                <PlusCircle className="w-4 h-4 mr-2 opacity-70" />
                <span>添加到工作区</span>
              </div>
              <ChevronRight className="w-3.5 h-3.5" />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent
                className="min-w-[120px] bg-white dark:bg-zinc-900 rounded-md overflow-hidden p-1 shadow-lg border border-zinc-200 dark:border-zinc-800 animate-in fade-in-80 z-50"
                sideOffset={2}
                alignOffset={-5}
              >
                {workspaces && workspaces.length > 0 ? workspaces.map((ws) => (
                  <ContextMenu.Item
                    key={ws.id}
                    onClick={() => onAssignWorkspace(ws.id)}
                    className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    {ws.name}
                  </ContextMenu.Item>
                )) : (
                  <div className="px-2 py-1.5 text-[13px] text-zinc-500 italic">暂无工作区</div>
                )}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>

          <ContextMenu.Separator className="h-[1px] bg-zinc-200 dark:bg-zinc-800 m-1" />

          <ContextMenu.Item
            onClick={handleRename}
            className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer justify-between"
          >
            <div className="flex items-center">
              <Edit2 className="w-4 h-4 mr-2 opacity-70" />
              <span>重命名</span>
            </div>
            <span className="text-xs text-zinc-400 group-data-[highlighted]:text-white/70">F2</span>
          </ContextMenu.Item>
          <ContextMenu.Item
            onClick={handleCopyPath}
            className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer"
          >
            <Copy className="w-4 h-4 mr-2 opacity-70" />
            复制文件路径
          </ContextMenu.Item>

          <ContextMenu.Separator className="h-[1px] bg-zinc-200 dark:bg-zinc-800 m-1" />

          <ContextMenu.Item
            onClick={onSearchSimilar}
            className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer"
          >
            <Search className="w-4 h-4 mr-2 opacity-70" />
            查找相似图片
          </ContextMenu.Item>

          <ContextMenu.Separator className="h-[1px] bg-zinc-200 dark:bg-zinc-800 m-1" />
          <ContextMenu.Item
            onClick={() => onQuickAddTag?.()}
            className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer justify-between"
          >
            <div className="flex items-center">
              <Tag className="w-4 h-4 mr-2 opacity-70" />
              <span>添加标签</span>
            </div>
            <span className="text-xs text-zinc-400 group-data-[highlighted]:text-white/70">T</span>
          </ContextMenu.Item>
          <ContextMenu.Item
            className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer"
          >
            <Image className="w-4 h-4 mr-2 opacity-70" />
            缩略图设置
          </ContextMenu.Item>
          <ContextMenu.Item
            className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer"
          >
            <Link className="w-4 h-4 mr-2 opacity-70" />
            同步关联
          </ContextMenu.Item>

          <ContextMenu.Separator className="h-[1px] bg-zinc-200 dark:bg-zinc-800 m-1" />

          {activeView === 'trash' ? (
            <>
              <ContextMenu.Item
                onClick={() => onDelete(false)}
                className="group text-[13px] leading-none text-green-600 dark:text-green-400 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-green-500 data-[highlighted]:text-white cursor-pointer"
              >
                <Box className="w-4 h-4 mr-2" />
                还原
              </ContextMenu.Item>
              <ContextMenu.Item
                onClick={() => onDelete(true)}
                className="group text-[13px] leading-none text-red-600 dark:text-red-400 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-red-500 data-[highlighted]:text-white cursor-pointer"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                彻底删除
              </ContextMenu.Item>
            </>
          ) : (
            <ContextMenu.Item
              onClick={() => onDelete(false)}
              className="group text-[13px] leading-none text-red-600 dark:text-red-400 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-red-500 data-[highlighted]:text-white cursor-pointer"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              移动到废纸篓
              <button id={`delete-asset-${asset.id}`} onClick={(e) => { e.stopPropagation(); onDelete(false) }} className="hidden" />
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

export function AssetsPage() {
  const [
    assets, setSelectedAssets, selectedAssets, searchQuery, setSearchQuery,
    colorFilter, setColorFilter, typeFilter, setTypeFilter, tagFilter, setTagFilter,
    folderFilter, folderPreviewVisibility, setFolderFilter,
    sizeFilter, setSizeFilter, ratingFilter, setRatingFilter,
    shapeFilter, setShapeFilter,
    activeView, activeWorkspaceId, setActiveView, workspaces, thumbnailSize, setThumbnailSize, layoutMode, setLayoutMode,
    sortConfig, setSortConfig, similarAssetIds, setSimilarAssetIds, setPreviewAsset,
    removeAsset, updateAssetProperty, assetDetail, setAssets, appendAssets, setAssetDetail, currentLibraryPath,
    pagination, setPagination, tagsSummary, refreshTagsSummary, isLeftSidebarVisible, isRightSidebarVisible,
  ] = useAssetStore(useShallow((s) => ([
    s.assets, s.setSelectedAssets, s.selectedAssets, s.searchQuery, s.setSearchQuery,
    s.colorFilter, s.setColorFilter, s.typeFilter, s.setTypeFilter, s.tagFilter, s.setTagFilter,
    s.folderFilter, s.folderPreviewVisibility, s.setFolderFilter,
    s.sizeFilter, s.setSizeFilter, s.ratingFilter, s.setRatingFilter,
    s.shapeFilter, s.setShapeFilter,
    s.activeView, s.activeWorkspaceId, s.setActiveView, s.workspaces, s.thumbnailSize, s.setThumbnailSize, s.layoutMode, s.setLayoutMode,
    s.sortConfig, s.setSortConfig, s.similarAssetIds, s.setSimilarAssetIds, s.setPreviewAsset,
    s.removeAsset, s.updateAssetProperty, s.assetDetail, s.setAssets, s.appendAssets, s.setAssetDetail, s.currentLibraryPath,
    s.pagination, s.setPagination, s.tagsSummary, s.refreshTagsSummary, s.isLeftSidebarVisible, s.isRightSidebarVisible,
  ])))

  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false)
  const [isTagFilterOpen, setIsTagFilterOpen] = useState(false)
  const [isTypeFilterOpen, setIsTypeFilterOpen] = useState(false)
  const [isSizeFilterOpen, setIsSizeFilterOpen] = useState(false)
  const [isDimensionFilterOpen, setIsDimensionFilterOpen] = useState(false)
  const [isRatingFilterOpen, setIsRatingFilterOpen] = useState(false)
  const [isShapeFilterOpen, setIsShapeFilterOpen] = useState(false)
  const [isSortOpen, setIsSortOpen] = useState(false)
  const [isFilterBarVisible, setIsFilterBarVisible] = useState(true)
  const [randomSortSeed, setRandomSortSeed] = useState(() => Date.now())
  const [customSortOrderMap, setCustomSortOrderMap] = useState<Record<string, number>>({})
  const [dimensionFilter, setDimensionFilter] = useState({
    widthMin: '',
    widthMax: '',
    heightMin: '',
    heightMax: '',
  })
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [folderDropHighlightPath, setFolderDropHighlightPath] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(searchQuery)
  const [isLoadingPage, setIsLoadingPage] = useState(false)
  const queryTokenRef = useRef(0)
  const loadingPageRef = useRef(false)
  const pendingLoadAheadRef = useRef(0)
  const lastScrollTopRef = useRef(0)
  const lastScrollTimeRef = useRef(0)
  const scrollVelocityRef = useRef(0)
  const warmPrefetchTokenRef = useRef(0)
  const idlePreloadTokenRef = useRef(0)
  const backendPrefetchTaskIdRef = useRef('assets-window-prefetch')
  const backendPrefetchRafRef = useRef<number | null>(null)
  const backendPrefetchSignatureRef = useRef('')
  const backendPrefetchLastRunRef = useRef(0)
  const sortMenuRef = useRef<HTMLDivElement>(null)

  const triggerRefresh = useCallback(() => {
    setRefreshVersion(v => v + 1)
  }, [])

  useEffect(() => {
    const onExternalRefresh = () => triggerRefresh()
    window.addEventListener('quickasset:refresh-assets', onExternalRefresh)
    return () => window.removeEventListener('quickasset:refresh-assets', onExternalRefresh)
  }, [triggerRefresh])

  useEffect(() => {
    return () => {
      if (backendPrefetchRafRef.current !== null) {
        window.cancelAnimationFrame(backendPrefetchRafRef.current)
        backendPrefetchRafRef.current = null
      }
      void safeInvoke('cancel_prefetch_task', {
        taskId: backendPrefetchTaskIdRef.current,
        task_id: backendPrefetchTaskIdRef.current,
      })
    }
  }, [])

  useEffect(() => {
    if (!isSortOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(event.target as Node)) {
        setIsSortOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isSortOpen])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim())
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchQuery])

  // Virtualization Logic for Grid Mode
  const parentRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1000)
  const [containerHeight, setContainerHeight] = useState(900)

  // Track container width reactively with ResizeObserver
  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const nextWidth = Math.round(entry.contentRect.width)
        const nextHeight = Math.round(entry.contentRect.height)
        if (nextWidth > 1) {
          setContainerWidth(nextWidth)
        } else {
          // Guard against transient zero-width reports (can happen after blocking dialogs
          // or heavy UI updates) which would force the grid into a single-column layout.
          const fallback = parentRef.current?.clientWidth ?? 0
          if (fallback > 1) {
            setContainerWidth(fallback)
          }
        }

        if (nextHeight > 1) {
          setContainerHeight(nextHeight)
        } else {
          const fallbackHeight = parentRef.current?.clientHeight ?? 0
          if (fallbackHeight > 1) {
            setContainerHeight(fallbackHeight)
          }
        }
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleAssetSelect = (assetId: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Toggle selection
      if (selectedAssets.includes(assetId)) {
        setSelectedAssets(selectedAssets.filter(id => id !== assetId));
      } else {
        setSelectedAssets([assetId], true);
      }
    } else if (e.shiftKey && selectedAssets.length > 0) {
      // Range selection
      const lastSelectedId = selectedAssets[selectedAssets.length - 1];

      const lastIndex = filteredAssets.findIndex(a => a.id === lastSelectedId);
      const currentIndex = filteredAssets.findIndex(a => a.id === assetId);

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        const rangeIds = filteredAssets.slice(start, end + 1).map(a => a.id);
        setSelectedAssets(Array.from(new Set([...selectedAssets, ...rangeIds])));
      } else {
        setSelectedAssets([assetId]);
      }
    } else {
      // Single select
      setSelectedAssets([assetId]);
    }
  };

  const handleAssetContextMenu = (assetId: string) => {
    if (!selectedAssets.includes(assetId)) {
      setSelectedAssets([assetId]);
    }
  };

  const handleDeleteAsset = async (id: string, hardDelete: boolean = false) => {
    try {
      if (hardDelete) {
        await safeInvoke("delete_assets", { ids: [id] })
        removeAsset(id)
      } else {
        const nextIsTrashed = activeView !== 'trash'
        updateAssetProperty(id, { is_trashed: nextIsTrashed })
        await safeInvoke("update_asset", {
          id,
          isTrashed: nextIsTrashed,
          is_trashed: nextIsTrashed,
        })
      }
      triggerRefresh()
    } catch (err) {
      console.error("Failed to delete asset:", err)
    }
  }

  const handleShowInFolder = async (path: string) => {
    try {
      await safeInvoke("show_in_folder", { path })
    } catch (err) {
      console.error("Failed to show in folder:", err)
    }
  }

  const handleSearchSimilar = async (id: string) => {
    try {
      const similarIds = await safeInvoke("find_similar_images", {
        targetId: id,
        threshold: 15
      })
      if (Array.isArray(similarIds)) {
        const deduped = Array.from(new Set([id, ...similarIds]))
        setSimilarAssetIds(deduped)
      }
    } catch (err) {
      console.error("Failed to search similar images:", err)
    }
  }

  const handlePreviewFolderFromAsset = (path: string) => {
    if (!currentLibraryPath) return
    const normalizedPath = path.replace(/\\/g, '/')
    const normalizedRoot = currentLibraryPath.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return

    const relativePath = normalizedPath.slice(normalizedRoot.length + 1)
    const lastSlash = relativePath.lastIndexOf('/')
    if (lastSlash <= 0) return

    const folder = relativePath.slice(0, lastSlash).replace(/^\/+|\/+$/g, '')
    if (!folder) return
    setFolderFilter([folder])
    setActiveView('all')
    setSimilarAssetIds(null)
    triggerRefresh()
  }

  const handleQuickAddTag = async (id: string) => {
    const input = window.prompt("输入标签（多个用逗号分隔）:")
    if (!input) return

    const newTags = Array.from(new Set(
      input
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    ))
    if (newTags.length === 0) return

    try {
      const targetIds = (selectedAssets.length > 1 && selectedAssets.includes(id)) ? selectedAssets : [id]
      if (targetIds.length > 1) {
        await safeInvoke("batch_update_asset_tags", {
          ids: targetIds,
          addTags: newTags,
          add_tags: newTags,
          removeTags: [],
          remove_tags: [],
        })
        useAssetStore.getState().refreshTagsSummary()
        triggerRefresh()
        return
      }

      const detail = await safeInvoke<AssetDetail>("get_asset_detail", { id })
      const existingTags = detail?.tags
        ? (() => {
            try {
              const parsed = JSON.parse(detail.tags)
              return Array.isArray(parsed) ? parsed.filter((t: unknown) => typeof t === "string") : []
            } catch {
              return []
            }
          })()
        : []
      const merged = Array.from(new Set([...existingTags, ...newTags]))
      const mergedTagsStr = JSON.stringify(merged)

      await safeInvoke("update_asset", {
        id,
        tags: mergedTagsStr,
      })

      if (assetDetail?.id === id) {
        setAssetDetail({ ...assetDetail, tags: mergedTagsStr })
      }
      useAssetStore.getState().refreshTagsSummary()
      triggerRefresh()
    } catch (err) {
      console.error("Failed to quick add tags:", err)
    }
  }

  const handleAssignWorkspace = async (assetId: string, workspaceId: string) => {
    const targetIds = (selectedAssets.length > 1 && selectedAssets.includes(assetId)) ? selectedAssets : [assetId]
    if (targetIds.length > 1) {
      await safeInvoke("batch_update_asset_workspaces", {
        ids: targetIds,
        addWorkspaceIds: [workspaceId],
        add_workspace_ids: [workspaceId],
        removeWorkspaceIds: [],
        remove_workspace_ids: [],
      })
      triggerRefresh()
      return
    }

    await safeInvoke("update_asset", {
      id: assetId,
      workspaceIds: JSON.stringify([workspaceId]),
      workspace_ids: JSON.stringify([workspaceId]),
    })
    triggerRefresh()
  }

  const allTags = useMemo(
    () => Object.keys(tagsSummary).sort((a, b) => (tagsSummary[b] || 0) - (tagsSummary[a] || 0)),
    [tagsSummary]
  )

  useEffect(() => {
    if (!currentLibraryPath) return
    refreshTagsSummary()
  }, [currentLibraryPath, refreshTagsSummary])

  const activeWorkspaceName = activeView === 'workspace' && activeWorkspaceId
    ? workspaces.find(w => w.id === activeWorkspaceId)?.name
    : activeView === 'trash' ? "废纸篓"
    : activeView === 'unorganized' ? "待整理文件"
    : "全部文件"
  const isCanvasEnabled = activeView === 'workspace'
  const currentFolderPath = folderFilter && folderFilter.length > 0 ? folderFilter[0] : null
  const parseDimensionInput = (value: string): number | null => {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || parsed < 0) return null
    return parsed
  }
  const dimensionBounds = {
    widthMin: parseDimensionInput(dimensionFilter.widthMin),
    widthMax: parseDimensionInput(dimensionFilter.widthMax),
    heightMin: parseDimensionInput(dimensionFilter.heightMin),
    heightMax: parseDimensionInput(dimensionFilter.heightMax),
  }
  const hasDimensionFilter =
    dimensionBounds.widthMin !== null ||
    dimensionBounds.widthMax !== null ||
    dimensionBounds.heightMin !== null ||
    dimensionBounds.heightMax !== null
  const isSimilarSearchActive = !!similarAssetIds
  const hasClientOnlyFilters =
    isSimilarSearchActive ||
    !!colorFilter ||
    !!(sizeFilter && sizeFilter.length > 0) ||
    !!(ratingFilter && ratingFilter.length > 0) ||
    !!(shapeFilter && shapeFilter.length > 0) ||
    hasDimensionFilter ||
    sortConfig.field === 'random' ||
    sortConfig.field === 'custom'
  const similarAssetIdSet = useMemo(
    () => (similarAssetIds ? new Set(similarAssetIds) : null),
    [similarAssetIds]
  )
  const effectivePageSize = hasClientOnlyFilters
    ? (
        isSimilarSearchActive
          ? Math.max(FULL_FETCH_PAGE_SIZE, pagination.totalCount || 0)
          : FULL_FETCH_PAGE_SIZE
      )
    : INCREMENTAL_PAGE_SIZE
  const normalizedLibraryPath = (currentLibraryPath || 'no-library').replace(/\\/g, '/')
  const canvasScope = currentFolderPath
    ? `folder:${currentFolderPath}`
    : activeView === 'workspace'
      ? `workspace:${activeWorkspaceId || 'none'}`
      : `view:${activeView}`
  const canvasPersistenceKey = `${normalizedLibraryPath}::${canvasScope}`
  const normalizeFolderPath = (value: string | null | undefined) =>
    (value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

  const currentFolderNormalized = currentFolderPath ? normalizeFolderPath(currentFolderPath) : null
  const isCurrentFolderCardPreviewVisible = currentFolderNormalized
    ? (folderPreviewVisibility[currentFolderNormalized] ?? true)
    : false
  const currentFolderInfo = useMemo(() => {
    if (!currentFolderNormalized) return null
    return folders.find((f) => normalizeFolderPath(f.path) === currentFolderNormalized) || null
  }, [folders, currentFolderNormalized])

  const childFolders = useMemo(() => {
    if (!currentFolderNormalized) return []
    return folders
      .filter((f) => normalizeFolderPath(f.parent_path) === currentFolderNormalized)
      .sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' }))
  }, [folders, currentFolderNormalized])

  const handleOpenFolderPreview = (folderPath: string) => {
    const normalized = normalizeFolderPath(folderPath)
    if (!normalized) return
    setFolderFilter([normalized])
    setActiveView('all')
    setSimilarAssetIds(null)
    triggerRefresh()
  }

  const handleOpenParentFolder = () => {
    if (!currentFolderInfo) return
    const parent = normalizeFolderPath(currentFolderInfo.parent_path)
    if (!parent) {
      setFolderFilter(null)
    } else {
      setFolderFilter([parent])
    }
    setActiveView('all')
    setSimilarAssetIds(null)
    triggerRefresh()
  }

  const moveDraggedAssetsToFolder = useCallback(async (assetIds: string[], targetFolderPath: string) => {
    if (assetIds.length === 0) return
    const normalizedTarget = normalizeFolderPath(targetFolderPath)
    try {
      await safeInvoke("move_assets_to_folder", {
        assetIds,
        targetFolder: normalizedTarget,
        asset_ids: assetIds,
        target_folder: normalizedTarget,
      })
      window.dispatchEvent(new Event('quickasset:refresh-assets'))
    } catch (error) {
      console.error("Failed to move dragged assets:", error)
      alert(`移动文件失败: ${String(error)}`)
    }
  }, [normalizeFolderPath])

  const handleFolderCardDragOver = useCallback((event: React.DragEvent<HTMLButtonElement>, folderPath: string) => {
    const assetIds = readDraggedAssetIds(event.dataTransfer)
    if (assetIds.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setFolderDropHighlightPath(normalizeFolderPath(folderPath))
  }, [normalizeFolderPath])

  const handleFolderCardDragLeave = useCallback((event: React.DragEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setFolderDropHighlightPath(null)
  }, [])

  const handleFolderCardDrop = useCallback(async (event: React.DragEvent<HTMLButtonElement>, folderPath: string) => {
    event.preventDefault()
    event.stopPropagation()
    setFolderDropHighlightPath(null)
    const assetIds = readDraggedAssetIds(event.dataTransfer)
    if (assetIds.length === 0) return
    await moveDraggedAssetsToFolder(assetIds, folderPath)
  }, [moveDraggedAssetsToFolder])

  useEffect(() => {
    if (layoutMode === 'canvas' && !isCanvasEnabled) {
      setLayoutMode('masonry')
    }
  }, [layoutMode, isCanvasEnabled, setLayoutMode])

  const queryFilters = useMemo((): Partial<AssetFilters> => {
    const isSimilarScope = !!similarAssetIds
    const hasFolderPreview = !!(folderFilter && folderFilter.length > 0)
    const backendSortField = (sortConfig.field === 'random' || sortConfig.field === 'custom')
      ? 'created_at'
      : sortConfig.field
    const filters: Partial<AssetFilters> = {
      sort_field: backendSortField,
      sort_order: sortConfig.order,
      is_trashed: isSimilarScope ? undefined : (hasFolderPreview ? false : activeView === 'trash' ? true : false),
    }

    if (!isSimilarScope && !hasFolderPreview && activeView === 'unorganized') {
      filters.unorganized = true
    }

    if (!isSimilarScope && tagFilter && tagFilter.length > 0) {
      filters.tags = tagFilter
    }

    if (!isSimilarScope && !hasFolderPreview && activeView === 'workspace' && activeWorkspaceId) {
      filters.workspace_id = activeWorkspaceId
    }

    if (!isSimilarScope && typeFilter && typeFilter.length > 0) {
      filters.asset_types = typeFilter
    }

    if (!isSimilarScope && folderFilter && folderFilter.length > 0) {
      filters.folder_path = folderFilter[0]
    }

    if (!isSimilarScope && debouncedSearchQuery) {
      filters.search_query = debouncedSearchQuery
    }

    return filters
  }, [activeView, activeWorkspaceId, debouncedSearchQuery, folderFilter, similarAssetIds, sortConfig, tagFilter, typeFilter])

  useEffect(() => {
    if (!isTauri()) return
    if (!currentLibraryPath) {
      setFolders([])
      return
    }
    const loadFolders = async () => {
      try {
        const folderRows = await invoke<FolderInfo[]>('get_folders')
        setFolders(folderRows)
      } catch (e) {
        console.error('Failed to load folders for preview:', e)
      }
    }
    loadFolders()
  }, [currentLibraryPath, refreshVersion])

  const commitPageItems = useCallback(async (
    items: AssetLite[],
    mode: 'replace' | 'append',
    token: number,
  ) => {
    if (token !== queryTokenRef.current) return
    if (items.length === 0) {
      if (mode === 'replace') {
        setAssets([])
      }
      return
    }

    if (mode === 'replace' && items.length <= REPLACE_COMMIT_CHUNK_THRESHOLD) {
      startTransition(() => {
        setAssets(items)
      })
      return
    }

    const firstChunk = items.slice(0, PAGE_COMMIT_CHUNK_SIZE)
    if (mode === 'replace') {
      startTransition(() => {
        setAssets(firstChunk)
      })
    } else {
      startTransition(() => {
        appendAssets(firstChunk)
      })
    }

    for (let index = PAGE_COMMIT_CHUNK_SIZE; index < items.length; index += PAGE_COMMIT_CHUNK_SIZE) {
      await nextAnimationFrame()
      if (token !== queryTokenRef.current) return
      startTransition(() => {
        appendAssets(items.slice(index, index + PAGE_COMMIT_CHUNK_SIZE))
      })
    }
  }, [appendAssets, setAssets])

  const loadPage = useCallback(async (page: number, mode: 'replace' | 'append', token: number) => {
    if (!isTauri()) return
    if (loadingPageRef.current) return
    loadingPageRef.current = true
    setIsLoadingPage(true)
    const previousCount = mode === 'append' ? useAssetStore.getState().assets.length : 0
    try {
      const result = await invoke<QueryAssetsResult>('query_assets', {
        filters: {
          ...queryFilters,
          page,
          page_size: effectivePageSize,
          skip_total_count: mode === 'append',
        },
      })

      if (token !== queryTokenRef.current) return

      await commitPageItems(result.items, mode, token)
      if (token !== queryTokenRef.current) return

      const loadedCount = previousCount + result.items.length
      const previousPagination = useAssetStore.getState().pagination
      const knownTotalCount = result.total_count > 0 ? result.total_count : previousPagination.totalCount
      const hasMore = knownTotalCount > 0
        ? loadedCount < knownTotalCount
        : result.items.length === effectivePageSize
      setPagination({
        page,
        pageSize: effectivePageSize,
        totalCount: knownTotalCount > 0 ? knownTotalCount : loadedCount,
        hasMore,
      })
    } catch (e) {
      if (token !== queryTokenRef.current) return
      const message = e instanceof Error ? e.message : String(e)
      if (!message.includes("No library is currently open")) {
        console.error('Failed to load paged assets:', e)
      }
    } finally {
      if (token === queryTokenRef.current) {
        setIsLoadingPage(false)
        loadingPageRef.current = false
      }
    }
  }, [commitPageItems, effectivePageSize, queryFilters, setPagination])

  useEffect(() => {
    if (!isTauri()) return
    if (!currentLibraryPath) {
      if (backendPrefetchRafRef.current !== null) {
        window.cancelAnimationFrame(backendPrefetchRafRef.current)
        backendPrefetchRafRef.current = null
      }
      backendPrefetchSignatureRef.current = ''
      void safeInvoke('cancel_prefetch_task', {
        taskId: backendPrefetchTaskIdRef.current,
        task_id: backendPrefetchTaskIdRef.current,
      })
      pendingLoadAheadRef.current = 0
      lastScrollTopRef.current = 0
      lastScrollTimeRef.current = 0
      scrollVelocityRef.current = 0
      warmPrefetchTokenRef.current = 0
      idlePreloadTokenRef.current = 0
      backendPrefetchLastRunRef.current = 0
      setAssets([])
      setPagination({
        page: 1,
        pageSize: effectivePageSize,
        totalCount: 0,
        hasMore: false,
      })
      return
    }

    const token = queryTokenRef.current + 1
    queryTokenRef.current = token
    if (backendPrefetchRafRef.current !== null) {
      window.cancelAnimationFrame(backendPrefetchRafRef.current)
      backendPrefetchRafRef.current = null
    }
    backendPrefetchSignatureRef.current = ''
    void safeInvoke('cancel_prefetch_task', {
      taskId: backendPrefetchTaskIdRef.current,
      task_id: backendPrefetchTaskIdRef.current,
    })
    loadingPageRef.current = false
    pendingLoadAheadRef.current = 0
    lastScrollTopRef.current = 0
    lastScrollTimeRef.current = 0
    scrollVelocityRef.current = 0
    warmPrefetchTokenRef.current = 0
    idlePreloadTokenRef.current = 0
    backendPrefetchLastRunRef.current = 0
    setPagination({
      page: 1,
      pageSize: effectivePageSize,
      totalCount: 0,
      hasMore: true,
    })
    parentRef.current?.scrollTo({ top: 0 })
    void loadPage(1, 'replace', token)
  }, [currentLibraryPath, effectivePageSize, loadPage, queryFilters, refreshVersion, setAssets, setPagination])

  const loadNextPage = useCallback(() => {
    if (!isTauri()) return
    if (!pagination.hasMore || isLoadingPage) return
    const token = queryTokenRef.current
    void loadPage(pagination.page + 1, 'append', token)
  }, [isLoadingPage, loadPage, pagination.hasMore, pagination.page])

  const dynamicLoadMoreThreshold = useMemo(() => {
    return Math.max(LOAD_MORE_THRESHOLD_PX, Math.round(containerHeight * 1.5))
  }, [containerHeight])

  useEffect(() => {
    if (!isTauri()) return
    if (!currentLibraryPath) return
    if (isLoadingPage) return
    if (!pagination.hasMore) return
    if (pagination.page !== 1) return
    if (assets.length === 0) return
    const token = queryTokenRef.current
    if (warmPrefetchTokenRef.current === token) return
    warmPrefetchTokenRef.current = token
    let cancelled = false
    let taskId = 0

    const warmPrefetch = () => {
      if (cancelled) return
      if (queryTokenRef.current !== token) return
      if (Math.abs(scrollVelocityRef.current) > ACTIVE_SCROLL_IDLE_PRELOAD_THRESHOLD) {
        taskId = scheduleIdleTask(warmPrefetch)
        return
      }
      void loadPage(2, 'append', token)
    }

    taskId = scheduleIdleTask(warmPrefetch)
    return () => {
      cancelled = true
      cancelIdleTask(taskId)
    }
  }, [assets.length, currentLibraryPath, isLoadingPage, loadPage, pagination.hasMore, pagination.page])

  useEffect(() => {
    if (!isTauri()) return
    if (!pagination.hasMore || isLoadingPage) return
    if (pendingLoadAheadRef.current <= 0) return
    pendingLoadAheadRef.current -= 1
    const token = queryTokenRef.current
    void loadPage(pagination.page + 1, 'append', token)
  }, [isLoadingPage, loadPage, pagination.hasMore, pagination.page])

  useEffect(() => {
    if (!isTauri()) return
    if (!similarAssetIdSet || similarAssetIdSet.size === 0) return
    if (isLoadingPage) return

    const loadedIdSet = new Set(assets.map((asset) => asset.id))
    let hasMissingSimilar = false
    for (const id of similarAssetIdSet) {
      if (!loadedIdSet.has(id)) {
        hasMissingSimilar = true
        break
      }
    }

    if (!hasMissingSimilar) return
    if (!pagination.hasMore) return

    const token = queryTokenRef.current
    void loadPage(pagination.page + 1, 'append', token)
  }, [assets, isLoadingPage, loadPage, pagination.hasMore, pagination.page, similarAssetIdSet])

  useEffect(() => {
    if (layoutMode === 'canvas') return
    const el = parentRef.current
    if (!el) return
    lastScrollTopRef.current = el.scrollTop
    lastScrollTimeRef.current = performance.now()

    const onScroll = () => {
      const now = performance.now()
      const currentTop = el.scrollTop
      const delta = currentTop - lastScrollTopRef.current
      const dt = Math.max(1, now - lastScrollTimeRef.current)
      const velocity = delta / dt
      scrollVelocityRef.current = velocity
      lastScrollTopRef.current = currentTop
      lastScrollTimeRef.current = now

      const remaining = el.scrollHeight - currentTop - el.clientHeight
      const predictedRemaining = remaining - Math.max(0, velocity) * SCROLL_PREDICT_MS
      if (predictedRemaining <= dynamicLoadMoreThreshold) {
        loadNextPage()
      }

      if (velocity > FAST_SCROLL_PX_PER_MS && pagination.hasMore) {
        pendingLoadAheadRef.current = Math.max(pendingLoadAheadRef.current, MAX_FAST_PREFETCH_PAGES)
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [assets.length, dynamicLoadMoreThreshold, layoutMode, loadNextPage, pagination.hasMore])

  const filteredAssets = useMemo(() => {
    if (!hasClientOnlyFilters) {
      // Backend already applied sorting/filtering for this path.
      return assets
    }

    const baseFiltered = assets.filter(asset => {
      // Similar Search filter (highest priority if active)
      if (similarAssetIdSet) {
        return similarAssetIdSet.has(asset.id);
      }

      // Color filter (not handled by backend)
      let matchesColor = true
      if (colorFilter) {
        if (!asset.dominant_color) {
          matchesColor = false
        } else {
          if (colorFilter.exact) {
            matchesColor = asset.dominant_color.toLowerCase() === colorFilter.hex.toLowerCase()
          } else {
            const distance = colorDistance(colorFilter.hex, asset.dominant_color)
            matchesColor = distance < 150 // approximate match threshold
          }
        }
      }

      // Size filter (not handled by backend)
      let matchesSize = true
      if (sizeFilter && sizeFilter.length > 0) {
        matchesSize = sizeFilter.some(key => {
          const opt = SIZE_FILTER_OPTIONS.find(o => o.label === key)
          if (!opt) return false
          return asset.size >= opt.min && asset.size < opt.max
        })
      }

      // Rating filter (not handled by backend)
      let matchesRating = true
      if (ratingFilter && ratingFilter.length > 0) {
        matchesRating = ratingFilter.includes(asset.rating || 0)
      }

      // Shape filter (not handled by backend)
      let matchesShape = true
      if (shapeFilter && shapeFilter.length > 0) {
        if (!asset.width || !asset.height) {
          matchesShape = false
        } else {
          const ratio = asset.width / asset.height
          const shapes: string[] = []
          if (ratio >= 0.8 && ratio <= 1.25) shapes.push('square')
          if (ratio > 1.25) shapes.push('wide')
          if (ratio < 0.8) shapes.push('tall')
          if (ratio > 2.5) shapes.push('panoramic')
          matchesShape = shapeFilter.some(s => shapes.includes(s))
        }
      }

      // Dimension axis filter (not handled by backend)
      let matchesDimensions = true
      if (hasDimensionFilter) {
        if (!asset.width || !asset.height) {
          matchesDimensions = false
        } else {
          if (dimensionBounds.widthMin !== null && asset.width < dimensionBounds.widthMin) matchesDimensions = false
          if (dimensionBounds.widthMax !== null && asset.width > dimensionBounds.widthMax) matchesDimensions = false
          if (dimensionBounds.heightMin !== null && asset.height < dimensionBounds.heightMin) matchesDimensions = false
          if (dimensionBounds.heightMax !== null && asset.height > dimensionBounds.heightMax) matchesDimensions = false
        }
      }

      return matchesColor && matchesSize && matchesRating && matchesShape && matchesDimensions
    })
    if (sortConfig.field === 'random') {
      return [...baseFiltered].sort((a, b) => {
        const ha = hashStringWithSeed(a.id, randomSortSeed)
        const hb = hashStringWithSeed(b.id, randomSortSeed)
        if (ha !== hb) return ha - hb
        return a.id.localeCompare(b.id)
      })
    }
    if (sortConfig.field === 'custom') {
      return [...baseFiltered].sort((a, b) => {
        const rankA = customSortOrderMap[a.id] ?? CUSTOM_SORT_FALLBACK_RANK
        const rankB = customSortOrderMap[b.id] ?? CUSTOM_SORT_FALLBACK_RANK
        if (rankA !== rankB) return rankA - rankB
        return b.created_at - a.created_at
      })
    }

    return baseFiltered
  }, [
    assets,
    hasClientOnlyFilters,
    similarAssetIdSet,
    colorFilter,
    sizeFilter,
    ratingFilter,
    shapeFilter,
    hasDimensionFilter,
    dimensionBounds.widthMin,
    dimensionBounds.widthMax,
    dimensionBounds.heightMin,
    dimensionBounds.heightMax,
    sortConfig.field,
    randomSortSeed,
    customSortOrderMap,
  ])

  const applyCustomSort = useCallback(() => {
    const source = filteredAssets.length > 0 ? filteredAssets : assets
    const nextOrder: Record<string, number> = {}
    source.forEach((asset, index) => {
      nextOrder[asset.id] = index
    })
    setCustomSortOrderMap(nextOrder)
    setSortConfig({ field: 'custom', order: 'asc' })
  }, [assets, filteredAssets, setSortConfig])

  const applyRandomSort = useCallback(() => {
    setRandomSortSeed(Date.now())
    setSortConfig({ field: 'random', order: 'asc' })
  }, [setSortConfig])

  // Grid: use CSS flexbox wrap with fixed item width for stable layout
  const gap = 24
  const columnCount = useMemo(() => {
    const safeWidth = containerWidth > 1 ? containerWidth : (parentRef.current?.clientWidth || 1000)
    return Math.max(1, Math.floor((safeWidth + gap) / (thumbnailSize + gap)))
  }, [containerWidth, thumbnailSize])

  const rowCount = useMemo(() => {
    return Math.ceil(filteredAssets.length / columnCount)
  }, [filteredAssets.length, columnCount])

  // Measure actual row height for accurate virtualization
  const measureRowHeight = useCallback(() => {
    const cardHeight = thumbnailSize + 72 // image + label area (name + meta + margins)
    return cardHeight + gap // gap between rows
  }, [thumbnailSize, gap])
  const estimatedRowHeight = measureRowHeight()
  const visibleRowCount = useMemo(() => {
    const safeHeight = containerHeight > 1 ? containerHeight : (parentRef.current?.clientHeight || 900)
    return Math.max(1, Math.ceil(safeHeight / Math.max(1, estimatedRowHeight)))
  }, [containerHeight, estimatedRowHeight])
  const rowOverscan = useMemo(
    () => Math.max(10, Math.ceil(visibleRowCount * OVERSCAN_RATIO)),
    [visibleRowCount]
  )
  const masonryOverscan = useMemo(
    () => Math.max(32, Math.ceil(visibleRowCount * columnCount * OVERSCAN_RATIO)),
    [visibleRowCount, columnCount]
  )
  const priorityPreloadCount = useMemo(
    () => clampNumber(columnCount * (visibleRowCount + 1), MIN_PRIORITY_PRELOAD_COUNT, MAX_PRIORITY_PRELOAD_COUNT),
    [columnCount, visibleRowCount]
  )

  useEffect(() => {
    if (!isTauri()) return
    if (layoutMode === 'canvas') return
    if (filteredAssets.length === 0) return

    const token = queryTokenRef.current
    if (idlePreloadTokenRef.current === token) return
    idlePreloadTokenRef.current = token

    const preloadLimit = Math.min(filteredAssets.length, priorityPreloadCount * IDLE_PRELOAD_MULTIPLIER)
    const preloadCandidates = filteredAssets.slice(0, preloadLimit)
    let cancelled = false
    let nextIndex = 0
    let taskId = 0

    const pump = () => {
      if (cancelled) return
      if (Math.abs(scrollVelocityRef.current) > ACTIVE_SCROLL_IDLE_PRELOAD_THRESHOLD) {
        taskId = scheduleIdleTask(pump)
        return
      }
      const upper = Math.min(preloadCandidates.length, nextIndex + IDLE_PRELOAD_BATCH_SIZE)
      while (nextIndex < upper) {
        const asset = preloadCandidates[nextIndex]
        const src = getCardImageSrc(
          asset,
          resolvedThumbnailPathCache.get(asset.id) || asset.thumbnail_path || null
        )
        if (src) preloadCardImageSrc(src)
        nextIndex += 1
      }
      if (nextIndex < preloadCandidates.length) {
        taskId = scheduleIdleTask(pump)
      }
    }

    taskId = scheduleIdleTask(pump)
    return () => {
      cancelled = true
      cancelIdleTask(taskId)
    }
  }, [filteredAssets, layoutMode, priorityPreloadCount])

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: measureRowHeight,
    overscan: rowOverscan,
  })

  const virtualizedGridWidth = useMemo(() => {
    if (columnCount <= 0) return 0
    return columnCount * thumbnailSize + Math.max(0, columnCount - 1) * gap
  }, [columnCount, thumbnailSize, gap])

  const estimateMasonryItemHeight = useCallback((index: number) => {
    const asset = filteredAssets[index]
    if (!asset) {
      return thumbnailSize + 88
    }

    const width = asset.width || thumbnailSize
    const height = asset.height || thumbnailSize
    const safeWidth = Math.max(1, width)
    const safeHeight = Math.max(1, height)
    const scaledPreviewHeight = Math.round((thumbnailSize * safeHeight) / safeWidth)
    return scaledPreviewHeight + 88
  }, [filteredAssets, thumbnailSize])

  const masonryVirtualizer = useVirtualizer({
    count: filteredAssets.length,
    getScrollElement: () => parentRef.current,
    estimateSize: estimateMasonryItemHeight,
    overscan: masonryOverscan,
    gap,
    lanes: columnCount,
  })

  const scheduleBackendPrefetch = useCallback(() => {
    if (!isTauri()) return
    if (layoutMode === 'canvas') return
    if (filteredAssets.length === 0) return

    if (backendPrefetchRafRef.current !== null) {
      window.cancelAnimationFrame(backendPrefetchRafRef.current)
    }

    backendPrefetchRafRef.current = window.requestAnimationFrame(() => {
      backendPrefetchRafRef.current = null
      const now = performance.now()
      if (now - backendPrefetchLastRunRef.current < BACKEND_PREFETCH_MIN_INTERVAL_MS) {
        return
      }
      backendPrefetchLastRunRef.current = now
      const scrollEl = parentRef.current
      const viewportTop = scrollEl?.scrollTop ?? 0
      const viewportBottom = viewportTop + (scrollEl?.clientHeight ?? 0)

      const sliceIds = (startIndex: number, endIndex: number) => {
        const safeStart = Math.max(0, startIndex)
        const safeEnd = Math.min(filteredAssets.length - 1, endIndex)
        if (safeEnd < safeStart) return [] as string[]
        return filteredAssets.slice(safeStart, safeEnd + 1).map(a => a.id)
      }

      let visibleStart = 0
      let visibleEnd = -1

      if (layoutMode === 'masonry') {
        const virtualItems = masonryVirtualizer.getVirtualItems()
        if (virtualItems.length === 0) return
        const visibleItems = virtualItems.filter((item) => item.end > viewportTop && item.start < viewportBottom)
        const sourceItems = visibleItems.length > 0 ? visibleItems : virtualItems
        visibleStart = sourceItems.reduce((min, item) => Math.min(min, item.index), Number.MAX_SAFE_INTEGER)
        visibleEnd = sourceItems.reduce((max, item) => Math.max(max, item.index), -1)
      } else {
        const virtualRows = rowVirtualizer.getVirtualItems()
        if (virtualRows.length === 0) return
        const visibleRows = virtualRows.filter((row) => row.end > viewportTop && row.start < viewportBottom)
        const sourceRows = visibleRows.length > 0 ? visibleRows : virtualRows
        const minRow = sourceRows.reduce((min, row) => Math.min(min, row.index), Number.MAX_SAFE_INTEGER)
        const maxRow = sourceRows.reduce((max, row) => Math.max(max, row.index), -1)
        visibleStart = minRow * columnCount
        visibleEnd = Math.min(filteredAssets.length - 1, ((maxRow + 1) * columnCount) - 1)
      }

      if (visibleEnd < visibleStart) return

      const visibleCount = visibleEnd - visibleStart + 1
      const leadCount = Math.min(
        BACKEND_PREFETCH_MAX_LEAD_IDS,
        Math.max(visibleCount, Math.ceil(visibleCount * BACKEND_PREFETCH_LEAD_MULTIPLIER))
      )
      const movingDown = scrollVelocityRef.current >= 0
      const p0Ids = sliceIds(visibleStart, visibleEnd)
      const p1Ids = movingDown
        ? sliceIds(visibleEnd + 1, visibleEnd + leadCount)
        : sliceIds(visibleStart - leadCount, visibleStart - 1)
      const p2Ids = movingDown
        ? sliceIds(visibleStart - leadCount, visibleStart - 1)
        : sliceIds(visibleEnd + 1, visibleEnd + leadCount)

      const signature = [
        p0Ids[0] || '',
        p0Ids[p0Ids.length - 1] || '',
        p1Ids[0] || '',
        p1Ids[p1Ids.length - 1] || '',
        p2Ids[0] || '',
        p2Ids[p2Ids.length - 1] || '',
        p0Ids.length,
        p1Ids.length,
        p2Ids.length,
      ].join('|')
      if (signature === backendPrefetchSignatureRef.current) return
      backendPrefetchSignatureRef.current = signature

      void safeInvoke('prefetch_assets_window', {
        request: {
          task_id: backendPrefetchTaskIdRef.current,
          replace_existing_task: true,
          p0_ids: p0Ids,
          p1_ids: p1Ids,
          p2_ids: p2Ids,
        },
      })
    })
  }, [columnCount, filteredAssets, layoutMode, masonryVirtualizer, rowVirtualizer])

  useEffect(() => {
    if (layoutMode === 'canvas') return
    const el = parentRef.current
    if (!el) return
    const onScroll = () => {
      scheduleBackendPrefetch()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [layoutMode, pagination.page, scheduleBackendPrefetch])

  useEffect(() => {
    const el = parentRef.current
    if (!el) return

    let raf2 = 0
    const syncLayout = () => {
      const nextWidth = Math.round(el.clientWidth)
      const nextHeight = Math.round(el.clientHeight)
      if (nextWidth > 1) setContainerWidth(nextWidth)
      if (nextHeight > 1) setContainerHeight(nextHeight)
      rowVirtualizer.measure()
      masonryVirtualizer.measure()
      scheduleBackendPrefetch()
    }

    const raf1 = window.requestAnimationFrame(() => {
      syncLayout()
      raf2 = window.requestAnimationFrame(syncLayout)
    })

    return () => {
      window.cancelAnimationFrame(raf1)
      if (raf2) window.cancelAnimationFrame(raf2)
    }
  }, [
    isLeftSidebarVisible,
    isRightSidebarVisible,
    layoutMode,
    masonryVirtualizer,
    rowVirtualizer,
    scheduleBackendPrefetch,
  ])

  // Force virtualizer to recalculate when thumbnail size or column count changes
  useEffect(() => {
    rowVirtualizer.measure()
    masonryVirtualizer.measure()
  }, [thumbnailSize, columnCount, rowVirtualizer, masonryVirtualizer])

  // Prevent "Rendered fewer hooks than expected" by ensuring early returns happen AFTER all hooks.
  if (activeView === 'tags') {
    return (
      <Suspense fallback={<div className="flex h-full items-center justify-center text-zinc-500">正在加载标签...</div>}>
        <TagsView />
      </Suspense>
    )
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-zinc-950">
      {/* Top Breadcrumb & Controls */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          <button className="p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded transition-colors text-zinc-500 shrink-0">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button className="p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded transition-colors text-zinc-300 dark:text-zinc-700 shrink-0">
            <ChevronRight className="w-5 h-5" />
          </button>
          <span className="ml-2 font-bold text-zinc-900 dark:text-zinc-100 truncate">
            {similarAssetIds ? "相似图检索结果" : currentFolderPath ? currentFolderPath : activeWorkspaceName}
          </span>
          {similarAssetIds && (
            <button
              onClick={() => setSimilarAssetIds(null)}
              className="ml-3 text-xs px-2 py-1 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 rounded-md hover:bg-indigo-100 transition-colors shrink-0"
            >
              退出检索
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 text-zinc-500 min-w-0">
          <div className="flex items-center mr-4 shrink">
            <input
              type="range"
              min="100"
              max="400"
              value={thumbnailSize}
              onChange={(e) => setThumbnailSize(Number(e.target.value))}
              className="w-24 h-1 bg-zinc-200 dark:bg-zinc-800 rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Sort Dropdown */}
          <div ref={sortMenuRef} className="relative mr-2 shrink-0">
            <button
              onClick={() => setIsSortOpen(v => !v)}
              className="flex items-center gap-1 px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded transition-colors text-sm whitespace-nowrap"
            >
              排序 <ChevronDown className="w-3 h-3" />
            </button>
            {isSortOpen && (
              <div className="absolute top-full right-0 mt-1 flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg z-[80] py-1 min-w-[140px]">
                <button onClick={() => { setSortConfig({ field: 'created_at', order: 'desc' }); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'created_at' && sortConfig.order === 'desc' ? 'text-indigo-500' : ''}`}>最新添加</button>
                <button onClick={() => { setSortConfig({ field: 'created_at', order: 'asc' }); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'created_at' && sortConfig.order === 'asc' ? 'text-indigo-500' : ''}`}>最早添加</button>
                <button onClick={() => { setSortConfig({ field: 'size', order: 'desc' }); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'size' && sortConfig.order === 'desc' ? 'text-indigo-500' : ''}`}>文件最大</button>
                <button onClick={() => { setSortConfig({ field: 'size', order: 'asc' }); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'size' && sortConfig.order === 'asc' ? 'text-indigo-500' : ''}`}>文件最小</button>
                <button onClick={() => { setSortConfig({ field: 'name', order: 'asc' }); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'name' && sortConfig.order === 'asc' ? 'text-indigo-500' : ''}`}>名称 A-Z</button>
                <button onClick={() => { setSortConfig({ field: 'rating', order: 'desc' }); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'rating' && sortConfig.order === 'desc' ? 'text-indigo-500' : ''}`}>评分最高</button>
                <div className="h-px bg-zinc-200 dark:bg-zinc-800 my-1" />
                <button onClick={() => { applyCustomSort(); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'custom' ? 'text-indigo-500' : ''}`}>自定义排序</button>
                <button onClick={() => { applyRandomSort(); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'random' ? 'text-indigo-500' : ''}`}>随机排序</button>
              </div>
            )}
          </div>
          <button
            onClick={() => setIsFilterBarVisible(v => !v)}
            className={`p-1.5 rounded transition-colors shrink-0 ${isFilterBarVisible ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500'}`}
            title={isFilterBarVisible ? "隐藏筛选栏" : "显示筛选栏"}
          >
            <Filter className="w-4 h-4" />
          </button>
          <div className="flex items-center bg-zinc-100 dark:bg-zinc-800 rounded p-0.5 mx-1 shrink-0">
            <button
              onClick={() => setLayoutMode('grid')}
              className={`p-1 rounded transition-colors ${layoutMode === 'grid' ? 'bg-white dark:bg-zinc-700 shadow-sm text-zinc-900 dark:text-zinc-100' : 'hover:text-zinc-900 dark:hover:text-zinc-100'}`}
              title="网格视图"
            >
              <Grid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setLayoutMode('masonry')}
              className={`p-1 rounded transition-colors ${layoutMode === 'masonry' ? 'bg-white dark:bg-zinc-700 shadow-sm text-zinc-900 dark:text-zinc-100' : 'hover:text-zinc-900 dark:hover:text-zinc-100'}`}
              title="瀑布流视图"
            >
              <Columns className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                if (!isCanvasEnabled) return
                setLayoutMode('canvas')
              }}
              disabled={!isCanvasEnabled}
              className={`p-1 rounded transition-colors ${
                !isCanvasEnabled
                  ? 'bg-red-50 text-red-500/90 cursor-not-allowed dark:bg-red-950/30 dark:text-red-400/80'
                  : layoutMode === 'canvas'
                    ? 'bg-white dark:bg-zinc-700 shadow-sm text-zinc-900 dark:text-zinc-100'
                    : 'hover:text-zinc-900 dark:hover:text-zinc-100'
              }`}
              title={isCanvasEnabled ? "无限画布" : "仅工作区可用"}
            >
              <Box className="w-4 h-4" />
            </button>
          </div>
          <div className="relative flex items-center ml-2 min-w-0 flex-1 max-w-[12rem]">
            <Search className="w-4 h-4 absolute left-2 text-zinc-400 shrink-0" />
            <input
              type="text"
              placeholder="搜索资产..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-1.5 bg-zinc-100 dark:bg-zinc-800 border-none rounded-md text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
            />
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      {isFilterBarVisible && (
      <div className="flex items-center gap-4 px-6 py-2 border-b border-zinc-100 dark:border-zinc-800 shrink-0 overflow-visible relative z-30 select-none">
        {/* Color Filter */}
        <div className="relative shrink-0 flex items-center gap-1">
          <button
            onClick={() => setIsColorPickerOpen(!isColorPickerOpen)}
            className="w-5 h-5 rounded-full bg-gradient-to-br from-red-500 via-green-500 to-blue-500 flex-shrink-0 ring-1 ring-zinc-200 dark:ring-zinc-700"
          />
          {colorFilter && (
            <button
              onClick={() => setColorFilter(null)}
              className="w-3.5 h-3.5 rounded-full flex items-center justify-center text-[10px] text-zinc-400 hover:text-red-500 transition-colors"
              title="清除颜色筛选"
            >
              ✕
            </button>
          )}
          {isColorPickerOpen && (
            <>
              <div className="fixed inset-0 z-[99]" onClick={() => setIsColorPickerOpen(false)} />
              <div className="absolute top-full left-0 mt-2 z-[100]">
                <Suspense fallback={<div className="w-[280px] h-[280px] rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800" />}>
                  <ColorWheelPicker
                    color={colorFilter?.hex || '#000000'}
                    onChange={(hex) => setColorFilter({ hex, exact: false })}
                  />
                </Suspense>
              </div>
            </>
          )}
        </div>

        <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-800 shrink-0" />

        {/* Filter Chips */}
        <div className="flex items-center gap-3 text-sm text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
          {/* Tags */}
          <div className="relative">
            <button
              onClick={() => setIsTagFilterOpen(!isTagFilterOpen)}
              className={`flex items-center gap-1 transition-colors ${tagFilter && tagFilter.length > 0 ? 'text-indigo-500 font-medium' : 'hover:text-zinc-900 dark:hover:text-zinc-100'}`}
            >
              <Tag className="w-3 h-3" />
              {tagFilter && tagFilter.length > 0 ? `标签: ${tagFilter.length}项` : '标签'} <ChevronDown className="w-3 h-3" />
            </button>
            {isTagFilterOpen && (
              <>
                <div className="fixed inset-0 z-[9]" onClick={() => setIsTagFilterOpen(false)} />
                <div className="absolute top-full left-0 mt-1 flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg z-10 py-1 min-w-[120px] max-h-48 overflow-y-auto no-scrollbar">
                  <button onClick={() => { setTagFilter(null); setIsTagFilterOpen(false) }} className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">清除筛选</button>
                  {allTags.length > 0 ? allTags.map((tag: string) => {
                    const isSelected = tagFilter?.includes(tag)
                    return (
                      <button
                        key={tag}
                        onClick={() => {
                          const current = tagFilter || []
                          if (isSelected) {
                            setTagFilter(current.filter(t => t !== tag))
                          } else {
                            setTagFilter([...current, tag])
                          }
                        }}
                        className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between"
                      >
                        <span>{tag}</span>
                        {isSelected && <span className="w-2 h-2 rounded-full bg-indigo-500" />}
                      </button>
                    )
                  }) : (
                    <div className="px-3 py-1.5 text-xs text-zinc-500 italic">暂无标签</div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Type */}
          <div className="relative">
            <button
              onClick={() => setIsTypeFilterOpen(!isTypeFilterOpen)}
              className={`flex items-center gap-1 transition-colors ${typeFilter && typeFilter.length > 0 ? 'text-indigo-500 font-medium' : 'hover:text-zinc-900 dark:hover:text-zinc-100'}`}
            >
              <Image className="w-3 h-3" />
              {typeFilter && typeFilter.length > 0 ? `类型: ${typeFilter.length}项` : '类型'} <ChevronDown className="w-3 h-3" />
            </button>
            {isTypeFilterOpen && (
              <>
                <div className="fixed inset-0 z-[9]" onClick={() => setIsTypeFilterOpen(false)} />
                <div className="absolute top-full left-0 mt-1 flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg z-10 py-1 min-w-[100px]">
                  <button onClick={() => { setTypeFilter(null); setIsTypeFilterOpen(false) }} className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">全部</button>
                  {['image', 'video', 'document'].map(t => {
                    const isSelected = typeFilter?.includes(t)
                    return (
                      <button
                        key={t}
                        onClick={() => {
                          const current = typeFilter || []
                          if (isSelected) {
                            setTypeFilter(current.filter(x => x !== t))
                          } else {
                            setTypeFilter([...current, t])
                          }
                        }}
                        className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between"
                      >
                        <span>{t === 'image' ? '图片' : t === 'video' ? '视频' : '文档'}</span>
                        {isSelected && <span className="w-2 h-2 rounded-full bg-indigo-500" />}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>

          {/* Size Filter */}
          <div className="relative">
            <button
              onClick={() => setIsSizeFilterOpen(!isSizeFilterOpen)}
              className={`flex items-center gap-1 transition-colors ${sizeFilter && sizeFilter.length > 0 ? 'text-indigo-500 font-medium' : 'hover:text-zinc-900 dark:hover:text-zinc-100'}`}
            >
              <HardDrive className="w-3 h-3" />
              {sizeFilter && sizeFilter.length > 0 ? `大小: ${sizeFilter.length}项` : '大小'} <ChevronDown className="w-3 h-3" />
            </button>
            {isSizeFilterOpen && (
              <>
                <div className="fixed inset-0 z-[9]" onClick={() => setIsSizeFilterOpen(false)} />
                <div className="absolute top-full left-0 mt-1 flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg z-10 py-1 min-w-[140px]">
                  <button onClick={() => { setSizeFilter(null); setIsSizeFilterOpen(false) }} className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">清除筛选</button>
                  {SIZE_FILTER_OPTIONS.map(opt => {
                    const isSelected = sizeFilter?.includes(opt.label)
                    return (
                      <button
                        key={opt.label}
                        onClick={() => {
                          const current = sizeFilter || []
                          if (isSelected) {
                            setSizeFilter(current.filter(s => s !== opt.label))
                          } else {
                            setSizeFilter([...current, opt.label])
                          }
                        }}
                        className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between"
                      >
                        <span>{opt.label}</span>
                        {isSelected && <span className="w-2 h-2 rounded-full bg-indigo-500" />}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>

          {/* Dimension Axis Filter */}
          <div className="relative">
            <button
              onClick={() => setIsDimensionFilterOpen(!isDimensionFilterOpen)}
              className={`flex items-center gap-1 transition-colors ${hasDimensionFilter ? 'text-indigo-500 font-medium' : 'hover:text-zinc-900 dark:hover:text-zinc-100'}`}
            >
              <Ruler className="w-3 h-3" />
              {hasDimensionFilter ? '尺寸轴: 已设置' : '尺寸轴'} <ChevronDown className="w-3 h-3" />
            </button>
            {isDimensionFilterOpen && (
              <>
                <div className="fixed inset-0 z-[9]" onClick={() => setIsDimensionFilterOpen(false)} />
                <div className="absolute top-full left-0 mt-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg z-10 p-3 min-w-[240px]">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <label className="flex flex-col gap-1 text-zinc-500">
                      横轴最小
                      <input
                        type="number"
                        min="0"
                        inputMode="numeric"
                        value={dimensionFilter.widthMin}
                        onChange={(e) => setDimensionFilter(prev => ({ ...prev, widthMin: e.target.value.replace(/[^\d]/g, '') }))}
                        className="w-full rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-zinc-700 dark:text-zinc-200 outline-none focus:border-indigo-500"
                        placeholder="例如 1920"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-zinc-500">
                      横轴最大
                      <input
                        type="number"
                        min="0"
                        inputMode="numeric"
                        value={dimensionFilter.widthMax}
                        onChange={(e) => setDimensionFilter(prev => ({ ...prev, widthMax: e.target.value.replace(/[^\d]/g, '') }))}
                        className="w-full rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-zinc-700 dark:text-zinc-200 outline-none focus:border-indigo-500"
                        placeholder="例如 3840"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-zinc-500">
                      纵轴最小
                      <input
                        type="number"
                        min="0"
                        inputMode="numeric"
                        value={dimensionFilter.heightMin}
                        onChange={(e) => setDimensionFilter(prev => ({ ...prev, heightMin: e.target.value.replace(/[^\d]/g, '') }))}
                        className="w-full rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-zinc-700 dark:text-zinc-200 outline-none focus:border-indigo-500"
                        placeholder="例如 1080"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-zinc-500">
                      纵轴最大
                      <input
                        type="number"
                        min="0"
                        inputMode="numeric"
                        value={dimensionFilter.heightMax}
                        onChange={(e) => setDimensionFilter(prev => ({ ...prev, heightMax: e.target.value.replace(/[^\d]/g, '') }))}
                        className="w-full rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-zinc-700 dark:text-zinc-200 outline-none focus:border-indigo-500"
                        placeholder="例如 2160"
                      />
                    </label>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <button
                      onClick={() => setDimensionFilter({ widthMin: '', widthMax: '', heightMin: '', heightMax: '' })}
                      className="text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                    >
                      清空尺寸轴
                    </button>
                    <button
                      onClick={() => setIsDimensionFilterOpen(false)}
                      className="text-xs px-2 py-1 rounded bg-indigo-500 text-white hover:bg-indigo-600 transition-colors"
                    >
                      完成
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Shape Filter */}
          <div className="relative">
            <button
              onClick={() => setIsShapeFilterOpen(!isShapeFilterOpen)}
              className={`flex items-center gap-1 transition-colors ${shapeFilter && shapeFilter.length > 0 ? 'text-indigo-500 font-medium' : 'hover:text-zinc-900 dark:hover:text-zinc-100'}`}
            >
              <Maximize2 className="w-3 h-3" />
              {shapeFilter && shapeFilter.length > 0 ? `形状: ${shapeFilter.length}项` : '形状'} <ChevronDown className="w-3 h-3" />
            </button>
            {isShapeFilterOpen && (
              <>
                <div className="fixed inset-0 z-[9]" onClick={() => setIsShapeFilterOpen(false)} />
                <div className="absolute top-full left-0 mt-1 flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg z-10 py-1 min-w-[100px]">
                  <button onClick={() => { setShapeFilter(null); setIsShapeFilterOpen(false) }} className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">清除筛选</button>
                  {SHAPE_FILTER_OPTIONS.map(opt => {
                    const isSelected = shapeFilter?.includes(opt.shape)
                    return (
                      <button
                        key={opt.shape}
                        onClick={() => {
                          const current = shapeFilter || []
                          if (isSelected) {
                            setShapeFilter(current.filter(s => s !== opt.shape))
                          } else {
                            setShapeFilter([...current, opt.shape])
                          }
                        }}
                        className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between"
                      >
                        <span>{opt.label}</span>
                        {isSelected && <span className="w-2 h-2 rounded-full bg-indigo-500" />}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>

          {/* Rating Filter */}
          <div className="relative">
            <button
              onClick={() => setIsRatingFilterOpen(!isRatingFilterOpen)}
              className={`flex items-center gap-1 transition-colors ${ratingFilter && ratingFilter.length > 0 ? 'text-indigo-500 font-medium' : 'hover:text-zinc-900 dark:hover:text-zinc-100'}`}
            >
              <Star className="w-3 h-3" />
              {ratingFilter && ratingFilter.length > 0 ? `评分: ${ratingFilter.join(', ')}` : '评分'} <ChevronDown className="w-3 h-3" />
            </button>
            {isRatingFilterOpen && (
              <>
                <div className="fixed inset-0 z-[9]" onClick={() => setIsRatingFilterOpen(false)} />
                <div className="absolute top-full left-0 mt-1 flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg z-10 py-1 min-w-[120px]">
                  <button onClick={() => { setRatingFilter(null); setIsRatingFilterOpen(false) }} className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">清除筛选</button>
                  {RATING_FILTER_OPTIONS.map(r => {
                    const isSelected = ratingFilter?.includes(r)
                    return (
                      <button
                        key={r}
                        onClick={() => {
                          const current = ratingFilter || []
                          if (isSelected) {
                            setRatingFilter(current.filter(x => x !== r))
                          } else {
                            setRatingFilter([...current, r])
                          }
                        }}
                        className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between"
                      >
                        <span className="flex items-center gap-0.5">
                          {Array.from({ length: r }).map((_, i) => (
                            <Star key={i} className="w-3 h-3 fill-yellow-400 text-yellow-400" />
                          ))}
                        </span>
                        {isSelected && <span className="w-2 h-2 rounded-full bg-indigo-500" />}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Grid Area */}
      <ContextMenu.Root>
        <ContextMenu.Trigger className="flex-1 flex flex-col h-full overflow-hidden relative selecto-area">
          {layoutMode !== 'canvas' && (
            <Selecto
              dragContainer={".selecto-area"}
              selectableTargets={[".selectable-asset"]}
              selectByClick={false}
              selectFromInside={false}
              hitRate={10}
              onSelectEnd={e => {
                if (e.isDragStart) return;
                const ids = e.selected.map(el => el.getAttribute("data-id")).filter(Boolean) as string[];
                if (e.inputEvent.ctrlKey || e.inputEvent.metaKey || e.inputEvent.shiftKey) {
                  setSelectedAssets(Array.from(new Set([...selectedAssets, ...ids])));
                } else {
                  setSelectedAssets(ids);
                }
              }}
            />
          )}
          <div
            ref={parentRef}
            className={`flex-1 bg-white dark:bg-[#121212] ${layoutMode === 'canvas' ? 'overflow-hidden p-0' : 'overflow-y-auto p-6'}`}
          >
            {layoutMode !== 'canvas' && currentFolderPath && isCurrentFolderCardPreviewVisible && (
              <div className="mb-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">文件夹卡片视图</h3>
                  {currentFolderInfo && (
                    <button
                      onClick={handleOpenParentFolder}
                      className="text-xs px-2 py-1 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                    >
                      返回上级
                    </button>
                  )}
                </div>
                {childFolders.length > 0 ? (
                  <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                    {childFolders.map((folder) => {
                      const folderPreviewSrc = getFolderPreviewSrc(folder)
                      const normalizedFolderPath = normalizeFolderPath(folder.path)
                      const isDropHighlighted = folderDropHighlightPath === normalizedFolderPath
                      return (
                        <button
                          key={folder.path}
                          onClick={() => handleOpenFolderPreview(folder.path)}
                          onDragOver={(event) => handleFolderCardDragOver(event, folder.path)}
                          onDragLeave={handleFolderCardDragLeave}
                          onDrop={(event) => void handleFolderCardDrop(event, folder.path)}
                          className={`group rounded-xl border px-3 py-3 text-left transition-all ${
                            isDropHighlighted
                              ? 'border-indigo-500 ring-2 ring-indigo-400/60 bg-indigo-50/70 dark:bg-indigo-500/10 dark:border-indigo-400'
                              : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-indigo-400 dark:hover:border-indigo-500/60 hover:shadow-sm'
                          }`}
                          title={folder.path}
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <Folder className="w-4 h-4 text-indigo-500" />
                            <span className="text-[11px] text-zinc-500">{folder.asset_count}</span>
                          </div>
                          {folderPreviewSrc ? (
                            <div className="mb-2 rounded-lg overflow-hidden border border-zinc-200/70 dark:border-zinc-800/70 bg-zinc-100 dark:bg-zinc-950">
                              <img
                                src={folderPreviewSrc}
                                alt={folder.display_name}
                                loading="lazy"
                                decoding="async"
                                className="w-full h-24 object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                              />
                            </div>
                          ) : null}
                          <p className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200 truncate">
                            {folder.display_name}
                          </p>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <div className="text-xs text-zinc-500 px-1">当前目录没有子文件夹</div>
                )}
              </div>
            )}

            {layoutMode === 'canvas' && isCanvasEnabled ? (
              <Suspense fallback={<div className="flex h-full items-center justify-center text-zinc-500">正在加载画布...</div>}>
                <WorkspaceCanvasView
                  assets={filteredAssets}
                  selectedAssetIds={selectedAssets}
                  onSelectionChange={(ids) => setSelectedAssets(ids)}
                  thumbnailSize={thumbnailSize}
                  onOpenPreview={(asset) => setPreviewAsset(asset, true)}
                  persistenceKey={canvasPersistenceKey}
                />
              </Suspense>
            ) : filteredAssets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-zinc-500">
                <p>{currentFolderPath ? '当前文件夹没有可显示资源' : '没有找到资产'}</p>
                <p className="text-sm">
                  {currentFolderPath ? '可以通过上方文件夹卡片继续浏览，或调整显示子文件夹设置。' : '请尝试调整筛选条件或导入新的文件夹。'}
                </p>
              </div>
            ) : layoutMode === 'masonry' ? (
              // Virtualized Masonry
              <div
                style={{
                  height: `${masonryVirtualizer.getTotalSize()}px`,
                  width: `${virtualizedGridWidth}px`,
                  maxWidth: '100%',
                  margin: '0 auto',
                  position: 'relative',
                }}
              >
                {masonryVirtualizer.getVirtualItems().map((virtualItem) => {
                  const asset = filteredAssets[virtualItem.index]
                  if (!asset) return null
                  const isSelected = selectedAssets.includes(asset.id);
                  return (
                    <div
                      key={asset.id}
                      data-index={virtualItem.index}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: `${virtualItem.lane * (thumbnailSize + gap)}px`,
                        width: `${thumbnailSize}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <AssetCard
                        asset={asset}
                        isSelected={isSelected}
                        layoutMode={layoutMode}
                        workspaces={workspaces}
                        dragAssetIds={isSelected && selectedAssets.length > 0 ? selectedAssets : [asset.id]}
                        priority={virtualItem.index < priorityPreloadCount}
                        onSelect={(e: React.MouseEvent) => handleAssetSelect(asset.id, e)}
                        onContextMenu={() => handleAssetContextMenu(asset.id)}
                        onPreview={() => setPreviewAsset(asset, true)}
                        onShowInFolder={() => handleShowInFolder(asset.path)}
                        onPreviewFolder={() => handlePreviewFolderFromAsset(asset.path)}
                        onSearchSimilar={() => handleSearchSimilar(asset.id)}
                        onDelete={(hard: boolean) => handleDeleteAsset(asset.id, hard)}
                        onQuickAddTag={() => handleQuickAddTag(asset.id)}
                        onAssignWorkspace={async (wsId: string) => {
                          await handleAssignWorkspace(asset.id, wsId)
                        }}
                        activeView={activeView}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              // Virtualized Grid
              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => (
                  <div
                    key={virtualRow.index}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: '50%',
                      minHeight: `${virtualRow.size}px`,
                      transform: `translate(-50%, ${virtualRow.start}px)`,
                      display: 'grid',
                      gridTemplateColumns: `repeat(${columnCount}, ${thumbnailSize}px)`,
                      gap: `${gap}px`,
                      paddingBottom: `${gap / 2}px`,
                      overflow: 'visible',
                    }}
                  >
                    {Array.from({ length: columnCount }).map((_, columnIndex) => {
                      const assetIndex = virtualRow.index * columnCount + columnIndex
                      const asset = filteredAssets[assetIndex]

                      if (!asset) return <div key={columnIndex} />

                      const isSelected = selectedAssets.includes(asset.id);
                      return (
                        <AssetCard
                          key={asset.id}
                          asset={asset}
                          isSelected={isSelected}
                          layoutMode={layoutMode}
                          workspaces={workspaces}
                          dragAssetIds={isSelected && selectedAssets.length > 0 ? selectedAssets : [asset.id]}
                          priority={assetIndex < priorityPreloadCount}
                          onSelect={(e: React.MouseEvent) => handleAssetSelect(asset.id, e)}
                          onContextMenu={() => handleAssetContextMenu(asset.id)}
                          onPreview={() => setPreviewAsset(asset, true)}
                          onShowInFolder={() => handleShowInFolder(asset.path)}
                          onPreviewFolder={() => handlePreviewFolderFromAsset(asset.path)}
                          onSearchSimilar={() => handleSearchSimilar(asset.id)}
                          onDelete={(hard: boolean) => handleDeleteAsset(asset.id, hard)}
                          onQuickAddTag={() => handleQuickAddTag(asset.id)}
                          onAssignWorkspace={async (wsId: string) => {
                            await handleAssignWorkspace(asset.id, wsId)
                          }}
                          activeView={activeView}
                        />
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
            {layoutMode !== 'canvas' && pagination.totalCount > 0 && (
              <div className="py-3 text-center text-xs text-zinc-500">
                {isLoadingPage ? "正在加载更多..." : pagination.hasMore ? "滚动以加载更多" : `已加载全部 ${pagination.totalCount} 项`}
              </div>
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className="min-w-[200px] bg-white dark:bg-zinc-900 rounded-md overflow-hidden p-1 shadow-[0px_10px_38px_-10px_rgba(22,_23,_24,_0.35),_0px_10px_20px_-15px_rgba(22,_23,_24,_0.2)] border border-zinc-200 dark:border-zinc-800 animate-in fade-in-80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 z-40"
          >
            <ContextMenu.Item
              className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer justify-between"
            >
              <span>在文件资源管理器中打开</span>
              <span className="text-xs text-zinc-400 group-data-[highlighted]:text-white/70">Ctrl+Enter</span>
            </ContextMenu.Item>
            <ContextMenu.Separator className="h-[1px] bg-zinc-200 dark:bg-zinc-800 m-1" />
            <ContextMenu.Item
              onClick={() => document.getElementById('global-import-btn')?.click()}
              className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer"
            >
              导入文件
            </ContextMenu.Item>
            <ContextMenu.Separator className="h-[1px] bg-zinc-200 dark:bg-zinc-800 m-1" />
            <ContextMenu.Item
              onClick={() => document.getElementById('global-left-sidebar-btn')?.click()}
              className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer justify-between"
            >
              <span>隐藏左侧栏</span>
              <span className="text-xs text-zinc-400 group-data-[highlighted]:text-white/70">Shift+Tab</span>
            </ContextMenu.Item>
            <ContextMenu.Item
              onClick={() => document.getElementById('global-right-sidebar-btn')?.click()}
              className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-indigo-500 data-[highlighted]:text-white cursor-pointer justify-between"
            >
              <span>隐藏右侧栏</span>
              <span className="text-xs text-zinc-400 group-data-[highlighted]:text-white/70">Tab</span>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  )
}
