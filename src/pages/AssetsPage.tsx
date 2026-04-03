import { Image as ImageIcon, FileText, Video, Box, ChevronLeft, ChevronRight, Filter, Grid, List, Search, ChevronDown, Columns, FolderOpen, Trash2, Copy, Edit2, MoveRight, PlusCircle, Tag, Image, Link } from "lucide-react"
import { useAssetStore, getSafeArray } from "@/store/useAssetStore"
import * as ContextMenu from '@radix-ui/react-context-menu'
import { invoke } from "@tauri-apps/api/core"
import { TagsView } from "./TagsView"
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef, useMemo, useEffect, useState } from 'react'
import Selecto from "react-selecto"

const safeInvoke = async (command: string, args?: any) => {
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
    return await invoke(command, args)
  }
  console.warn(`Tauri not available, skipped: ${command}`, args)
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

const PRESET_COLORS = [
  { label: "Red", value: "#ff0000" },
  { label: "Orange", value: "#ffa500" },
  { label: "Yellow", value: "#ffff00" },
  { label: "Green", value: "#008000" },
  { label: "Blue", value: "#0000ff" },
  { label: "Purple", value: "#800080" },
  { label: "Black", value: "#000000" },
  { label: "White", value: "#ffffff" },
]

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

function AssetCard({ asset, isSelected, layoutMode, thumbnailSize, workspaces, onSelect, onContextMenu, onPreview, onShowInFolder, onSearchSimilar, onDelete, onAssignWorkspace, activeView }: any) {
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
      } catch (err) {
        alert("重命名失败: " + err)
      }
    }
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger onContextMenu={onContextMenu}>
        <div
          data-id={asset.id}
          onClick={onSelect}
          onDoubleClick={onPreview}
          className={`selectable-asset group flex flex-col items-center cursor-pointer break-inside-avoid ${layoutMode === 'masonry' ? 'mb-8' : ''}`}
        >
          <div className={`relative w-full rounded-xl overflow-hidden transition-all duration-200 ${
            isSelected 
              ? "ring-2 ring-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.4)]" 
              : "ring-1 ring-zinc-200 dark:ring-zinc-800 hover:ring-zinc-300 dark:hover:ring-zinc-700"
          }`}>
            {asset.is_missing && (
              <div className="absolute inset-0 bg-red-500/20 backdrop-blur-[2px] z-10 flex flex-col items-center justify-center text-white">
                <span className="font-bold drop-shadow-md text-red-500">文件已丢失</span>
                <span className="text-xs opacity-90 mt-1">请检查本地磁盘</span>
              </div>
            )}
            <div className={`w-full flex items-center justify-center ${!asset.thumbnail_base64 ? getAssetColor(asset.asset_type) : ''} bg-opacity-10 dark:bg-opacity-10`}>
              {asset.thumbnail_base64 ? (
                <img 
                  src={asset.thumbnail_base64} 
                  alt={asset.name} 
                  loading="lazy"
                  decoding="async"
                  className={`w-full ${layoutMode === 'grid' ? 'aspect-square object-cover' : 'h-auto object-contain'} transition-opacity duration-300`} 
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
              {asset.asset_type === 'image' ? '1011x1400' : asset.asset_type.toUpperCase()}  {(asset.size / 1024).toFixed(1)} KB
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
                onClick={() => onDelete(false)} // Technically restore
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
    keywordFilter, setKeywordFilter,
    colorFilter, setColorFilter, typeFilter, setTypeFilter, tagFilter, setTagFilter,
    folderFilter, setFolderFilter, shapeFilter, setShapeFilter,
    activeView, activeWorkspaceId, workspaces, thumbnailSize, setThumbnailSize, layoutMode, setLayoutMode,
    sortConfig, setSortConfig, similarAssetIds, setSimilarAssetIds, setPreviewAsset,
    removeAsset, updateAssetProperty, assignAssetToWorkspace
  } = useAssetStore()

  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false)
  const [exactColorMatch, setExactColorMatch] = useState(false)

  // Virtualization Logic for Grid Mode
  const parentRef = useRef<HTMLDivElement>(null)
  const containerWidth = parentRef.current?.clientWidth || 1000 // Fallback width

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
        const lastEl = document.querySelector(`[data-id="${lastSelectedId}"]`);
        const currEl = document.querySelector(`[data-id="${assetId}"]`);

        if (lastEl && currEl) {
          const r1 = lastEl.getBoundingClientRect();
          const r2 = currEl.getBoundingClientRect();

          const minX = Math.min(r1.left, r2.left);
          const maxX = Math.max(r1.right, r2.right);
          const minY = Math.min(r1.top, r2.top);
          const maxY = Math.max(r1.bottom, r2.bottom);

          const rangeIds: string[] = [];
          document.querySelectorAll('.selectable-asset').forEach(el => {
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
        is_trashed: false,
        tags: assets.find(a => a.id === id)?.tags || null,
        description: assets.find(a => a.id === id)?.description || null,
        rating: assets.find(a => a.id === id)?.rating || null,
        workspace_ids: assets.find(a => a.id === id)?.workspace_ids || null
      })
    } catch (err) {
      console.error("Failed to restore asset:", err)
    }
  }
  const handleDeleteAsset = async (id: string, hardDelete: boolean = false) => {
    try {
      if (hardDelete) {
        await safeInvoke("delete_asset", { id })
        removeAsset(id)
      } else {
        updateAssetProperty(id, { is_trashed: true })
        await safeInvoke("update_asset", { 
          id, 
          is_trashed: true,
          tags: assets.find(a => a.id === id)?.tags || null,
          description: assets.find(a => a.id === id)?.description || null,
          rating: assets.find(a => a.id === id)?.rating || null,
          workspace_ids: assets.find(a => a.id === id)?.workspace_ids || null
        })
      }
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

  // Get all unique tags from all assets safely
  const allTags = Array.from(new Set(
    assets.flatMap(a => {
      if (!a.tags) return []
      try {
        const parsed = JSON.parse(a.tags)
        return Array.isArray(parsed) ? parsed : []
      } catch (e) {
        return Array.isArray(a.tags) ? a.tags : []
      }
    })
  ))

  const activeWorkspaceName = activeView === 'workspace' && activeWorkspaceId 
    ? workspaces.find(w => w.id === activeWorkspaceId)?.name 
    : activeView === 'trash' ? "废纸篓"
    : activeView === 'unorganized' ? "待整理文件"
    : "全部文件"

  const filteredAssets = assets.filter(asset => {
    // Basic View Filters
    if (activeView === 'trash') {
      if (!asset.is_trashed) return false;
    } else {
      if (asset.is_trashed) return false;
    }

    if (activeView === 'unorganized') {
      const tags = getSafeArray(asset.tags);
      const workspaces = getSafeArray(asset.workspace_ids);
      if (tags.length > 0 || workspaces.length > 0) return false;
    }

    // Similar Search filter (highest priority if active)
    if (similarAssetIds) {
      return similarAssetIds.includes(asset.id);
    }
    
    // Workspace filter
    let matchesWorkspace = activeView !== 'workspace';
    if (!matchesWorkspace && asset.workspace_ids) {
      try {
        const parsedWs = JSON.parse(asset.workspace_ids as any as string);
        matchesWorkspace = Array.isArray(parsedWs) && parsedWs.includes(activeWorkspaceId);
      } catch (e) {
        if (Array.isArray(asset.workspace_ids)) {
          matchesWorkspace = (asset.workspace_ids as unknown as string[]).includes(activeWorkspaceId!);
        }
      }
    }

    // Search filter (name, desc, tags)
    let matchesSearch = true;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchName = asset.name.toLowerCase().includes(q);
      const matchDesc = asset.description?.toLowerCase().includes(q) || false;
      const matchTags = asset.tags?.toLowerCase().includes(q) || false;
      matchesSearch = matchName || matchDesc || matchTags;
    }
    
    // Type filter
    let matchesType = true;
    if (typeFilter && typeFilter.length > 0) {
      matchesType = typeFilter.includes(asset.asset_type);
    }

    // Tag filter
    let matchesTag = true;
    if (tagFilter && tagFilter.length > 0) {
      try {
        const parsedTags = getSafeArray(asset.tags);
        matchesTag = tagFilter.some(t => parsedTags.includes(t));
      } catch (e) {
        matchesTag = false;
      }
    }
    
    // Folder filter
    let matchesFolder = true;
    if (folderFilter && folderFilter.length > 0) {
      matchesFolder = folderFilter.some(folder => asset.path.includes(folder));
    }

    // Color filter
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
    
    return matchesWorkspace && matchesSearch && matchesType && matchesTag && matchesColor && matchesFolder
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

  // Determine number of columns based on container width and thumbnail size
  const gap = 24
  const columnCount = useMemo(() => {
    return Math.max(1, Math.floor((containerWidth + gap) / (thumbnailSize + gap)))
  }, [containerWidth, thumbnailSize])

  const rowCount = useMemo(() => {
    return Math.ceil(filteredAssets.length / columnCount)
  }, [filteredAssets.length, columnCount])

  // Virtualizer for the grid rows
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => thumbnailSize + 90, // image height + label area (name ~26px + size ~20px + margins ~16px + row gap ~12px + safety)
    overscan: 5,
  })

  // Prevent "Rendered fewer hooks than expected" by ensuring early returns happen AFTER all hooks.
  if (activeView === 'tags') {
    return <TagsView />
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-zinc-950">
      {/* Top Breadcrumb & Controls */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-2">
          <button className="p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded transition-colors text-zinc-500">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button className="p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded transition-colors text-zinc-300 dark:text-zinc-700">
            <ChevronRight className="w-5 h-5" />
          </button>
          <span className="ml-2 font-bold text-zinc-900 dark:text-zinc-100">
            {similarAssetIds ? "相似图检索结果" : activeWorkspaceName}
          </span>
          {similarAssetIds && (
            <button 
              onClick={() => setSimilarAssetIds(null)}
              className="ml-3 text-xs px-2 py-1 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 rounded-md hover:bg-indigo-100 transition-colors"
            >
              退出检索
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 text-zinc-500">
          <div className="flex items-center mr-4">
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
          <div className="relative group mr-2">
            <button className="flex items-center gap-1 px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded transition-colors text-sm">
              排序 <ChevronDown className="w-3 h-3" />
            </button>
            <div className="absolute top-full right-0 mt-1 hidden group-hover:flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg z-20 py-1 min-w-[120px]">
              <button onClick={() => setSortConfig({ field: 'created_at', order: 'desc' })} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'created_at' && sortConfig.order === 'desc' ? 'text-indigo-500' : ''}`}>最新添加</button>
              <button onClick={() => setSortConfig({ field: 'created_at', order: 'asc' })} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'created_at' && sortConfig.order === 'asc' ? 'text-indigo-500' : ''}`}>最早添加</button>
              <button onClick={() => setSortConfig({ field: 'size', order: 'desc' })} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'size' && sortConfig.order === 'desc' ? 'text-indigo-500' : ''}`}>文件最大</button>
              <button onClick={() => setSortConfig({ field: 'size', order: 'asc' })} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'size' && sortConfig.order === 'asc' ? 'text-indigo-500' : ''}`}>文件最小</button>
              <button onClick={() => setSortConfig({ field: 'name', order: 'asc' })} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'name' && sortConfig.order === 'asc' ? 'text-indigo-500' : ''}`}>名称 A-Z</button>
              <button onClick={() => setSortConfig({ field: 'rating', order: 'desc' })} className={`px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${sortConfig.field === 'rating' && sortConfig.order === 'desc' ? 'text-indigo-500' : ''}`}>评分最高</button>
            </div>
          </div>
          <button className="p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded transition-colors">
            <Filter className="w-4 h-4" />
          </button>
          <div className="flex items-center bg-zinc-100 dark:bg-zinc-800 rounded p-0.5 mx-1">
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
          </div>
          <div className="relative flex items-center ml-2">
            <Search className="w-4 h-4 absolute left-2 text-zinc-400" />
            <input 
              type="text" 
              placeholder="搜索资产..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-1.5 bg-zinc-100 dark:bg-zinc-800 border-none rounded-md text-sm w-48 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
            />
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex items-center gap-4 px-6 py-2 border-b border-zinc-100 dark:border-zinc-800 shrink-0 overflow-visible relative z-30">
        {/* Color Filter */}
        <div className="relative group">
          <button 
            onClick={() => setIsColorPickerOpen(!isColorPickerOpen)}
            className="w-5 h-5 rounded-full bg-gradient-to-br from-red-500 via-green-500 to-blue-500 flex-shrink-0 ring-1 ring-zinc-200 dark:ring-zinc-700" 
          />
          {isColorPickerOpen && (
            <div className="absolute top-full left-0 mt-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-3 rounded-xl shadow-xl z-[100] w-64">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium text-zinc-500">颜色筛选</span>
                <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                  <input 
                    type="checkbox" 
                    id="exactMatch" 
                    checked={exactColorMatch} 
                    onChange={(e) => setExactColorMatch(e.target.checked)} 
                    className="rounded border-zinc-300 text-indigo-500 focus:ring-indigo-500"
                  />
                  <label htmlFor="exactMatch">精确匹配</label>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2 mb-3">
                {PRESET_COLORS.map(color => (
                  <button
                    key={color.label}
                    title={color.label}
                    onClick={() => {
                      if (colorFilter?.hex === color.value) {
                        setColorFilter(null)
                      } else {
                        setColorFilter({ hex: color.value, exact: exactColorMatch })
                      }
                      setIsColorPickerOpen(false)
                    }}
                    className={`w-full aspect-square rounded-md border shadow-sm transition-transform hover:scale-105 ${
                      colorFilter?.hex === color.value 
                        ? "border-blue-500 ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-zinc-900" 
                        : "border-zinc-200 dark:border-zinc-700"
                    }`}
                    style={{ backgroundColor: color.value }}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input 
                  type="color" 
                  value={colorFilter?.hex || "#000000"} 
                  onChange={(e) => setColorFilter({ hex: e.target.value, exact: exactColorMatch })}
                  className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent"
                />
                <span className="text-xs text-zinc-500 uppercase">{colorFilter?.hex || "自定义"}</span>
                {colorFilter && (
                  <button 
                    onClick={() => setColorFilter(null)}
                    className="ml-auto text-xs text-zinc-400 hover:text-red-500"
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-800" />

        {/* Filter Chips */}
        <div className="flex items-center gap-3 text-sm text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
          <button 
            className="flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
            onClick={() => document.querySelector<HTMLInputElement>('input[placeholder="搜索资产..."]')?.focus()}
          >
            关键字
          </button>
          <button className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">文件名</button>
          <button className="flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">
            文件夹 <ChevronDown className="w-3 h-3" />
          </button>
          <div className="relative group">
            <button className={`flex items-center gap-1 transition-colors ${tagFilter && tagFilter.length > 0 ? 'text-indigo-500 font-medium' : 'hover:text-zinc-900 dark:hover:text-zinc-100'}`}>
              {tagFilter && tagFilter.length > 0 ? `标签: ${tagFilter.length}项` : '标签'} <ChevronDown className="w-3 h-3" />
            </button>
            <div className="absolute top-full left-0 mt-1 hidden group-hover:flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg z-10 py-1 min-w-[120px] max-h-48 overflow-y-auto no-scrollbar">
              <button onClick={() => setTagFilter(null)} className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">清除筛选</button>
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
          </div>
          <div className="relative group">
            <button className={`flex items-center gap-1 transition-colors ${typeFilter && typeFilter.length > 0 ? 'text-indigo-500 font-medium' : 'hover:text-zinc-900 dark:hover:text-zinc-100'}`}>
              {typeFilter && typeFilter.length > 0 ? `类型: ${typeFilter.length}项` : '类型'} <ChevronDown className="w-3 h-3" />
            </button>
            <div className="absolute top-full left-0 mt-1 hidden group-hover:flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg z-10 py-1 min-w-[100px]">
              <button onClick={() => setTypeFilter(null)} className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">全部</button>
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
          </div>
          <button className="flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">
            形状 <ChevronDown className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Grid Area */}
      <ContextMenu.Root>
        <ContextMenu.Trigger className="flex-1 flex flex-col h-full overflow-hidden relative selecto-area">
          <Selecto
            dragContainer={".selecto-area"}
            selectableTargets={[".selectable-asset"]}
            selectByClick={false}
            selectFromInside={false}
            toggleContinueSelect={["shift"]}
            hitRate={10}
            onSelectEnd={e => {
              if (e.isDragStart) return;
              const ids = e.selected.map(el => el.getAttribute("data-id")).filter(Boolean) as string[];
              if (e.inputEvent.ctrlKey || e.inputEvent.metaKey) {
                setSelectedAssets(Array.from(new Set([...selectedAssets, ...ids])));
              } else {
                setSelectedAssets(ids);
              }
            }}
          />
          <div 
            ref={parentRef}
            className="flex-1 overflow-y-auto p-6 bg-white dark:bg-[#121212]"
          >
            {filteredAssets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-zinc-500">
                <p>没有找到资产</p>
                <p className="text-sm">请尝试调整筛选条件或导入新的文件夹。</p>
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
                      onPreview={() => setPreviewAsset(asset)}
                      onShowInFolder={() => handleShowInFolder(asset.path)}
                      onSearchSimilar={() => handleSearchSimilar(asset.id)}
                      onDelete={(hard: boolean) => handleDeleteAsset(asset.id, hard)}
                      onAssignWorkspace={(wsId: string) => {
                        assignAssetToWorkspace(asset.id, wsId);
                        safeInvoke("update_asset", { 
                          id: asset.id, 
                          workspace_ids: JSON.stringify([...getSafeArray(asset.workspace_ids), wsId])
                        });
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
                      left: 0,
                      width: '100%',
                      minHeight: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                      display: 'grid',
                      gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
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
                          onPreview={() => setPreviewAsset(asset)}
                          onShowInFolder={() => handleShowInFolder(asset.path)}
                          onSearchSimilar={() => handleSearchSimilar(asset.id)}
                          onDelete={(hard: boolean) => handleDeleteAsset(asset.id, hard)}
                          onAssignWorkspace={(wsId: string) => {
                            assignAssetToWorkspace(asset.id, wsId);
                            safeInvoke("update_asset", { 
                              id: asset.id, 
                              workspace_ids: JSON.stringify([...getSafeArray(asset.workspace_ids), wsId])
                            });
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
