import { Image as ImageIcon, FileText, Video, Box, ChevronLeft, ChevronRight, Filter, Grid, List, Search, ChevronDown, Columns, FolderOpen, Folder, Trash2, Copy, Edit2, MoveRight, PlusCircle, Tag, Image, Link, Star, HardDrive, Maximize2 } from "lucide-react"
import { useAssetStore, AssetLite, AssetFilters } from "@/store/useAssetStore"
import * as ContextMenu from '@radix-ui/react-context-menu'
import { invoke } from "@tauri-apps/api/core"
import { convertFileSrc } from "@tauri-apps/api/core"
import { TagsView } from "./TagsView"
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef, useMemo, useEffect, useState, useCallback } from 'react'
import Selecto from "react-selecto"
import { ColorWheelPicker } from "@/components/ColorWheelPicker"
import { WorkspaceCanvasView } from "@/components/workspace/WorkspaceCanvasView"

const safeInvoke = async (command: string, args?: any) => {
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
    return await invoke(command, args)
  }
  console.warn(`Tauri not available, skipped: ${command}`, args)
}

const isTauri = () => !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
const THUMBNAIL_FIRST_EXTENSIONS = new Set(['psd', 'psb', 'clip'])

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
  const preferThumbnail = THUMBNAIL_FIRST_EXTENSIONS.has(ext)
  const filePath = preferThumbnail ? (thumbnailPath || asset.path) : asset.path
  return filePath ? convertFileSrc(filePath) : null
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

function AssetCard({ asset, isSelected, layoutMode, thumbnailSize, workspaces, onSelect, onContextMenu, onPreview, onShowInFolder, onPreviewFolder, onSearchSimilar, onDelete, onAssignWorkspace, onQuickAddTag, activeView }: any) {
  const [resolvedThumbnailPath, setResolvedThumbnailPath] = useState<string | null>(asset.thumbnail_path || null)

  useEffect(() => {
    setResolvedThumbnailPath(asset.thumbnail_path || null)
  }, [asset.id, asset.thumbnail_path])

  useEffect(() => {
    if (!isTauri()) return
    if (asset.asset_type !== 'video') return
    if (resolvedThumbnailPath) return

    let cancelled = false
    safeInvoke("ensure_asset_thumbnail", { id: asset.id })
      .then((thumbnailPath) => {
        if (cancelled) return
        if (typeof thumbnailPath === 'string' && thumbnailPath.length > 0) {
          setResolvedThumbnailPath(thumbnailPath)
        }
      })
      .catch((err) => {
        console.warn("Failed to generate video thumbnail:", err)
      })

    return () => {
      cancelled = true
    }
  }, [asset.id, asset.asset_type, resolvedThumbnailPath])

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
        await (window as any).__loadAssets?.()
      } catch (err) {
        alert("重命名失败: " + err)
      }
    }
  }

  const ext = getFileExt(asset.name || asset.path)
  const isImageAsset = asset.asset_type === 'image' || THUMBNAIL_FIRST_EXTENSIONS.has(ext)
  const imageSrc = getCardImageSrc(asset, resolvedThumbnailPath)
  const hasVisualPreview = !!imageSrc && (isImageAsset || asset.asset_type === 'video')

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger onContextMenu={onContextMenu}>
        <div
          data-id={asset.id}
          onClick={onSelect}
          onDoubleClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onPreview?.()
          }}
          className={`selectable-asset group flex flex-col items-center cursor-pointer break-inside-avoid ${layoutMode === 'masonry' ? 'mb-8' : ''}`}
        >
          <div className={`relative w-full rounded-xl overflow-hidden transition-all duration-200 ${
            isSelected
              ? "ring-2 ring-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.4)]"
              : "ring-1 ring-zinc-200 dark:ring-zinc-800 hover:ring-zinc-300 dark:hover:ring-zinc-700"
          }`}>
            <div className={`w-full flex items-center justify-center ${!hasVisualPreview ? getAssetColor(asset.asset_type) : ''} bg-zinc-100 dark:bg-zinc-900 bg-opacity-10 dark:bg-opacity-10`}>
              {hasVisualPreview ? (
                <img
                  src={imageSrc}
                  alt={asset.name}
                  loading="lazy"
                  decoding="async"
                  className={`w-full ${layoutMode === 'grid' ? 'aspect-square object-cover' : 'h-auto object-contain'} transition-opacity duration-300`}
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
                {workspaces && workspaces.length > 0 ? workspaces.map((ws: any) => (
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
  const {
    assets, setSelectedAssets, selectedAssets, searchQuery, setSearchQuery,
    colorFilter, setColorFilter, typeFilter, setTypeFilter, tagFilter, setTagFilter,
    folderFilter, folderPreviewVisibility, setFolderFilter,
    sizeFilter, setSizeFilter, ratingFilter, setRatingFilter,
    shapeFilter, setShapeFilter,
    activeView, activeWorkspaceId, setActiveView, workspaces, thumbnailSize, setThumbnailSize, layoutMode, setLayoutMode,
    sortConfig, setSortConfig, similarAssetIds, setSimilarAssetIds, setPreviewAsset,
    removeAsset, updateAssetProperty, assetDetail, setAssets, setAssetDetail, currentLibraryPath,
    tagsSummary, refreshTagsSummary
  } = useAssetStore()

  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false)
  const [isTagFilterOpen, setIsTagFilterOpen] = useState(false)
  const [isTypeFilterOpen, setIsTypeFilterOpen] = useState(false)
  const [isSizeFilterOpen, setIsSizeFilterOpen] = useState(false)
  const [isRatingFilterOpen, setIsRatingFilterOpen] = useState(false)
  const [isShapeFilterOpen, setIsShapeFilterOpen] = useState(false)
  const [isSortOpen, setIsSortOpen] = useState(false)
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [refreshVersion, setRefreshVersion] = useState(0)
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
    if (!isSortOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(event.target as Node)) {
        setIsSortOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isSortOpen])

  // Virtualization Logic for Grid Mode
  const parentRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1000)

  // Track container width reactively with ResizeObserver
  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
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

      if (layoutMode === 'masonry') {
        // Spatial selection for Masonry
        const allElements = document.querySelectorAll('.selectable-asset');
        let lastEl: Element | null = null;
        let currEl: Element | null = null;

        allElements.forEach(el => {
          const id = el.getAttribute('data-id');
          if (id === lastSelectedId) lastEl = el;
          if (id === assetId) currEl = el;
        });

        if (lastEl && currEl) {
          const r1 = lastEl.getBoundingClientRect();
          const r2 = currEl.getBoundingClientRect();

          const minX = Math.min(r1.left, r2.left);
          const maxX = Math.max(r1.right, r2.right);
          const minY = Math.min(r1.top, r2.top);
          const maxY = Math.max(r1.bottom, r2.bottom);

          const rangeIds: string[] = [];
          allElements.forEach(el => {
            const r = el.getBoundingClientRect();
            const centerX = r.left + r.width / 2;
            const centerY = r.top + r.height / 2;

            if (centerX >= minX && centerX <= maxX && centerY >= minY && centerY <= maxY) {
              const id = el.getAttribute('data-id');
              if (id) rangeIds.push(id);
            }
          });

          setSelectedAssets(Array.from(new Set([...selectedAssets, ...rangeIds])));
        } else {
          setSelectedAssets([assetId]);
        }
      } else {
        // Array index selection for Grid (Virtualizer ensures visual order = array order)
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

  const handleRestoreAsset = async (id: string) => {
    try {
      updateAssetProperty(id, { is_trashed: false })
      await safeInvoke("update_asset", {
        id,
        isTrashed: false,
        is_trashed: false,
      })
      triggerRefresh()
    } catch (err) {
      console.error("Failed to restore asset:", err)
    }
  }

  const handleDeleteAsset = async (id: string, hardDelete: boolean = false) => {
    try {
      if (hardDelete) {
        await safeInvoke("delete_assets", { ids: [id] })
        removeAsset(id)
      } else {
        updateAssetProperty(id, { is_trashed: true })
        await safeInvoke("update_asset", {
          id,
          isTrashed: true,
          is_trashed: true,
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
        setSimilarAssetIds([id, ...similarIds])
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
      const detail = await safeInvoke("get_asset_detail", { id }) as any
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

  useEffect(() => {
    if (layoutMode === 'canvas' && !isCanvasEnabled) {
      setLayoutMode('masonry')
    }
  }, [layoutMode, isCanvasEnabled, setLayoutMode])

  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__ && !(window as any).__TAURI__) return
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

  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__ && !(window as any).__TAURI__) return
    if (!currentLibraryPath) {
      setAssets([])
      return
    }

    const hasFolderPreview = !!(folderFilter && folderFilter.length > 0)
    const filters: Partial<AssetFilters> & { page: number; page_size: number } = {
      sort_field: sortConfig.field,
      sort_order: sortConfig.order,
      page: 1,
      page_size: 10000,
      is_trashed: hasFolderPreview ? false : activeView === 'trash' ? true : false,
    }

    if (!hasFolderPreview && activeView === 'unorganized') {
      filters.unorganized = true
    }

    if (tagFilter && tagFilter.length > 0) {
      filters.tags = tagFilter
    }

    if (!hasFolderPreview && activeView === 'workspace' && activeWorkspaceId) {
      filters.workspace_id = activeWorkspaceId
    }

    if (typeFilter && typeFilter.length > 0) {
      filters.asset_types = typeFilter
    }

    if (folderFilter && folderFilter.length > 0) {
      filters.folder_path = folderFilter[0]
    }

    if (searchQuery) {
      filters.search_query = searchQuery
    }

    const loadData = async () => {
      try {
        const result = await invoke('query_assets', { filters }) as any
        setAssets(result.items as AssetLite[])
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (!message.includes("No library is currently open")) {
          console.error('Failed to load filtered assets:', e)
        }
      }
    }

    loadData()
  }, [activeView, tagFilter, activeWorkspaceId, typeFilter, folderFilter, searchQuery, sortConfig, currentLibraryPath, refreshVersion])

  const filteredAssets = assets.filter(asset => {
    // Similar Search filter (highest priority if active)
    if (similarAssetIds) {
      return similarAssetIds.includes(asset.id);
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

    return matchesColor && matchesSize && matchesRating && matchesShape
  }).sort((a, b) => {
    const { field, order } = sortConfig
    let comparison = 0

    switch (field) {
      case 'name':
        comparison = a.name.localeCompare(b.name)
        break
      case 'size':
        comparison = a.size - b.size
        break
      case 'rating':
        comparison = (a.rating || 0) - (b.rating || 0)
        break
      case 'created_at':
        comparison = (a.created_at || 0) - (b.created_at || 0)
        break
      case 'modified_at':
        comparison = (a.modified_at || 0) - (b.modified_at || 0)
        break
    }

    return order === 'asc' ? comparison : -comparison
  })

  // Grid: use CSS flexbox wrap with fixed item width for stable layout
  const gap = 24
  const columnCount = useMemo(() => {
    return Math.max(1, Math.floor((containerWidth + gap) / (thumbnailSize + gap)))
  }, [containerWidth, thumbnailSize])

  const rowCount = useMemo(() => {
    return Math.ceil(filteredAssets.length / columnCount)
  }, [filteredAssets.length, columnCount])

  // Measure actual row height for accurate virtualization
  const measureRowHeight = useCallback((index: number) => {
    const cardHeight = thumbnailSize + 72 // image + label area (name + meta + margins)
    return cardHeight + gap // gap between rows
  }, [thumbnailSize, gap])

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: measureRowHeight,
    overscan: 5,
  })

  // Force virtualizer to recalculate when thumbnail size or column count changes
  useEffect(() => {
    rowVirtualizer.measure()
  }, [thumbnailSize, columnCount, rowVirtualizer])

  // Prevent "Rendered fewer hooks than expected" by ensuring early returns happen AFTER all hooks.
  if (activeView === 'tags') {
    return <TagsView />
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
            {similarAssetIds ? "相似图检索结果" : currentFolderPath ? `文件夹预览: ${currentFolderPath}` : activeWorkspaceName}
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
              <div className="absolute top-full right-0 mt-1 flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg z-20 py-1 min-w-[120px]">
                <button onClick={() => { setSortConfig({ field: 'created_at', order: 'desc' }); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'created_at' && sortConfig.order === 'desc' ? 'text-indigo-500' : ''}`}>最新添加</button>
                <button onClick={() => { setSortConfig({ field: 'created_at', order: 'asc' }); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'created_at' && sortConfig.order === 'asc' ? 'text-indigo-500' : ''}`}>最早添加</button>
                <button onClick={() => { setSortConfig({ field: 'size', order: 'desc' }); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'size' && sortConfig.order === 'desc' ? 'text-indigo-500' : ''}`}>文件最大</button>
                <button onClick={() => { setSortConfig({ field: 'size', order: 'asc' }); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'size' && sortConfig.order === 'asc' ? 'text-indigo-500' : ''}`}>文件最小</button>
                <button onClick={() => { setSortConfig({ field: 'name', order: 'asc' }); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'name' && sortConfig.order === 'asc' ? 'text-indigo-500' : ''}`}>名称 A-Z</button>
                <button onClick={() => { setSortConfig({ field: 'rating', order: 'desc' }); setIsSortOpen(false) }} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'rating' && sortConfig.order === 'desc' ? 'text-indigo-500' : ''}`}>评分最高</button>
              </div>
            )}
          </div>
          <button className="p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded transition-colors shrink-0">
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
      <div className="flex items-center gap-4 px-6 py-2 border-b border-zinc-100 dark:border-zinc-800 shrink-0 overflow-visible relative z-30">
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
                <ColorWheelPicker
                  color={colorFilter?.hex || '#000000'}
                  onChange={(hex) => setColorFilter({ hex, exact: false })}
                />
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
                  {allTags.length > 0 ? allTags.map((tag: any) => {
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
                      return (
                        <button
                          key={folder.path}
                          onClick={() => handleOpenFolderPreview(folder.path)}
                          className="group rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-3 text-left hover:border-indigo-400 dark:hover:border-indigo-500/60 hover:shadow-sm transition-all"
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
              <WorkspaceCanvasView
                assets={filteredAssets}
                selectedAssetIds={selectedAssets}
                onSelectionChange={(ids) => setSelectedAssets(ids)}
                thumbnailSize={thumbnailSize}
                onOpenPreview={(asset) => setPreviewAsset(asset, true)}
                persistenceKey={canvasPersistenceKey}
              />
            ) : filteredAssets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-zinc-500">
                <p>{currentFolderPath ? '当前文件夹没有可显示资源' : '没有找到资产'}</p>
                <p className="text-sm">
                  {currentFolderPath ? '可以通过上方文件夹卡片继续浏览，或调整显示子文件夹设置。' : '请尝试调整筛选条件或导入新的文件夹。'}
                </p>
              </div>
            ) : layoutMode === 'masonry' ? (
              // Non-virtualized Masonry fallback for complex layouts
              <div
                style={{
                  columnWidth: `${thumbnailSize}px`,
                  columnGap: '24px'
                }}
              >
                {filteredAssets.map((asset) => {
                  const isSelected = selectedAssets.includes(asset.id);
                  return (
                    <AssetCard
                      key={asset.id}
                      asset={asset}
                      isSelected={isSelected}
                      layoutMode={layoutMode}
                      thumbnailSize={thumbnailSize}
                      workspaces={workspaces}
                      onSelect={(e: React.MouseEvent) => handleAssetSelect(asset.id, e)}
                      onContextMenu={() => handleAssetContextMenu(asset.id)}
                      onPreview={() => setPreviewAsset(asset, true)}
                      onShowInFolder={() => handleShowInFolder(asset.path)}
                      onPreviewFolder={() => handlePreviewFolderFromAsset(asset.path)}
                      onSearchSimilar={() => handleSearchSimilar(asset.id)}
                      onDelete={(hard: boolean) => handleDeleteAsset(asset.id, hard)}
                      onQuickAddTag={() => handleQuickAddTag(asset.id)}
                      onAssignWorkspace={async (wsId: string) => {
                        // Workspace assignment now requires detail data
                        await safeInvoke("update_asset", {
                          id: asset.id,
                          workspaceIds: JSON.stringify([wsId]),
                          workspace_ids: JSON.stringify([wsId]),
                        });
                        triggerRefresh()
                      }}
                      activeView={activeView}
                    />
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
                          thumbnailSize={thumbnailSize}
                          workspaces={workspaces}
                          onSelect={(e: React.MouseEvent) => handleAssetSelect(asset.id, e)}
                          onContextMenu={() => handleAssetContextMenu(asset.id)}
                          onPreview={() => setPreviewAsset(asset, true)}
                          onShowInFolder={() => handleShowInFolder(asset.path)}
                          onPreviewFolder={() => handlePreviewFolderFromAsset(asset.path)}
                          onSearchSimilar={() => handleSearchSimilar(asset.id)}
                          onDelete={(hard: boolean) => handleDeleteAsset(asset.id, hard)}
                          onQuickAddTag={() => handleQuickAddTag(asset.id)}
                          onAssignWorkspace={async (wsId: string) => {
                            await safeInvoke("update_asset", {
                              id: asset.id,
                              workspaceIds: JSON.stringify([wsId]),
                              workspace_ids: JSON.stringify([wsId]),
                            });
                            triggerRefresh()
                          }}
                          activeView={activeView}
                        />
                      )
                    })}
                  </div>
                ))}
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
