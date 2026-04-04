import { useState, useRef, useEffect, useCallback } from "react"
import { Menu, Target, CheckSquare, Tags, Trash2, Box, Folder, Plus, ChevronRight, ChevronDown, Check, X } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { useAssetStore, type ViewType } from "@/store/useAssetStore"
import * as ContextMenu from '@radix-ui/react-context-menu'
import { isMobile } from "@/lib/utils"

interface FolderInfo {
  path: string
  parent_path: string | null
  display_name: string
  asset_count: number
  show_subfolders: boolean
}

interface LibraryStats {
  active_count: number
  trashed_count: number
  total_size: number
}

type ShortcutKey = 'all' | 'unorganized' | 'tags' | 'trash'

interface ContextCheckboxMenuItemProps {
  checked: boolean
  onToggle: () => void
  children: React.ReactNode
  icon?: React.ReactNode
}

function ContextCheckboxMenuItem({ checked, onToggle, children, icon }: ContextCheckboxMenuItemProps) {
  return (
    <ContextMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onToggle}
      className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 pl-8 pr-2 relative select-none outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
    >
      <ContextMenu.ItemIndicator className="absolute left-2 inline-flex items-center justify-center">
        <Check className="w-4 h-4" />
      </ContextMenu.ItemIndicator>
      <div className="flex items-center gap-2">
        {icon}
        <span>{children}</span>
      </div>
    </ContextMenu.CheckboxItem>
  )
}

export function LeftSidebar() {
  const {
    assets, workspaces, setWorkspaces, activeWorkspaceId, activeView,
    folderFilter, folderPreviewVisibility, setFolderPreviewVisibility,
    addWorkspace, toggleLeftSidebar, currentLibrary, currentLibraryPath
  } = useAssetStore()
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isAddingWorkspace, setIsAddingWorkspace] = useState(false)
  const [newWorkspaceName, setNewWorkspaceName] = useState("")
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false)
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [workspaceCounts, setWorkspaceCounts] = useState<Record<string, number>>({})
  const [libraryStats, setLibraryStats] = useState<LibraryStats>({
    active_count: 0,
    trashed_count: 0,
    total_size: 0,
  })
  const [visibleShortcuts, setVisibleShortcuts] = useState({
    all: true,
    unorganized: true,
    tags: true,
    trash: true
  })
  const lastNonFolderSelectionRef = useRef<{ view: ViewType; workspaceId: string | null }>({
    view: activeView,
    workspaceId: activeWorkspaceId ?? null,
  })
  const normalizeFolderPath = useCallback((value: string | null | undefined) => {
    return (value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  }, [])
  const currentFolderNormalized = folderFilter && folderFilter.length > 0
    ? normalizeFolderPath(folderFilter[0])
    : null
  const isFolderPreviewMode = !!currentFolderNormalized

  useEffect(() => {
    if (!currentFolderNormalized) {
      lastNonFolderSelectionRef.current = {
        view: activeView,
        workspaceId: activeWorkspaceId ?? null,
      }
    }
  }, [activeView, activeWorkspaceId, currentFolderNormalized])

  const selectSidebarView = useCallback((view: ViewType, workspaceId: string | null = null) => {
    useAssetStore.setState({
      folderFilter: null,
      similarAssetIds: null,
      activeView: view,
      activeWorkspaceId: workspaceId,
    })
  }, [])

  const openFolderPreview = useCallback((folderPath: string) => {
    const normalizedPath = normalizeFolderPath(folderPath)
    if (!normalizedPath) return

    const state = useAssetStore.getState()
    const hasFolderPreview = !!(state.folderFilter && state.folderFilter.length > 0)
    if (!hasFolderPreview) {
      lastNonFolderSelectionRef.current = {
        view: state.activeView,
        workspaceId: state.activeWorkspaceId ?? null,
      }
    }

    useAssetStore.setState({
      folderFilter: [normalizedPath],
      similarAssetIds: null,
      activeView: 'all',
      activeWorkspaceId: null,
    })
    window.dispatchEvent(new Event('quickasset:refresh-assets'))
  }, [normalizeFolderPath])

  const closeFolderPreviewToParent = useCallback((parentPath: string | null | undefined) => {
    const normalizedParentPath = normalizeFolderPath(parentPath)
    if (normalizedParentPath) {
      useAssetStore.setState({
        folderFilter: [normalizedParentPath],
        similarAssetIds: null,
        activeView: 'all',
        activeWorkspaceId: null,
      })
      window.dispatchEvent(new Event('quickasset:refresh-assets'))
      return
    }

    const { view, workspaceId } = lastNonFolderSelectionRef.current
    useAssetStore.setState({
      folderFilter: null,
      similarAssetIds: null,
      activeView: view,
      activeWorkspaceId: view === 'workspace' ? workspaceId : null,
    })
    window.dispatchEvent(new Event('quickasset:refresh-assets'))
  }, [normalizeFolderPath])

  // Load workspaces from backend on mount
  useEffect(() => {
    if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return
    if (!currentLibraryPath) {
      setWorkspaces([])
      return
    }
    invoke('get_workspaces').then((ws: any) => {
      setWorkspaces(ws.map((w: any) => ({ id: w.id, name: w.name })))
    }).catch((e) => console.warn('Failed to load workspaces:', e))
  }, [currentLibraryPath, setWorkspaces])

  // Load folders from backend via get_folders API
  const loadFolders = useCallback(() => {
    if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return
    if (!currentLibraryPath) {
      setFolders([])
      return
    }
    invoke<FolderInfo[]>('get_folders').then((f) => {
      setFolders(f)
    }).catch((e) => console.warn('Failed to load folders:', e))
  }, [currentLibraryPath])

  const loadWorkspaceCounts = useCallback(async () => {
    if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return
    if (!currentLibraryPath || workspaces.length === 0) {
      setWorkspaceCounts({})
      return
    }

    try {
      const countPairs = await Promise.all(
        workspaces.map(async (ws) => {
          const result = await invoke<any>('query_assets', {
            filters: {
              workspace_id: ws.id,
              is_trashed: false,
              sort_field: 'created_at',
              sort_order: 'desc',
              page: 1,
              page_size: 1,
            }
          })
          return [ws.id, Number(result?.total_count || 0)] as const
        })
      )
      setWorkspaceCounts(Object.fromEntries(countPairs))
    } catch (e) {
      console.warn('Failed to load workspace counts:', e)
    }
  }, [currentLibraryPath, workspaces])

  const loadLibraryStats = useCallback(async () => {
    if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return
    if (!currentLibraryPath) {
      setLibraryStats({ active_count: 0, trashed_count: 0, total_size: 0 })
      return
    }

    try {
      const stats = await invoke<LibraryStats>('get_library_stats')
      setLibraryStats({
        active_count: Number(stats?.active_count || 0),
        trashed_count: Number(stats?.trashed_count || 0),
        total_size: Number(stats?.total_size || 0),
      })
    } catch (e) {
      console.warn('Failed to load library stats:', e)
    }
  }, [currentLibraryPath])

  useEffect(() => {
    loadFolders()
  }, [loadFolders, currentLibrary])

  // Reload folders when assets change (e.g. after scan)
  useEffect(() => {
    if (!currentLibraryPath) return
    loadFolders()
  }, [assets.length, loadFolders, currentLibraryPath])

  useEffect(() => {
    loadWorkspaceCounts()
  }, [loadWorkspaceCounts, assets.length])

  useEffect(() => {
    loadLibraryStats()
  }, [loadLibraryStats, assets.length])

  useEffect(() => {
    const onAssetsRefresh = () => {
      loadFolders()
      loadWorkspaceCounts()
      loadLibraryStats()
    }
    window.addEventListener('quickasset:refresh-assets', onAssetsRefresh)
    return () => window.removeEventListener('quickasset:refresh-assets', onAssetsRefresh)
  }, [loadFolders, loadWorkspaceCounts, loadLibraryStats])

  const handleToggleShortcut = (key: ShortcutKey) => {
    setVisibleShortcuts(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleResetShortcuts = () => {
    setVisibleShortcuts({ all: true, unorganized: true, tags: true, trash: true })
  }

  const renderNavContextMenu = (children: React.ReactNode, key: ShortcutKey) => {
    const shortcutItems: Array<{ key: ShortcutKey; label: string }> = [
      { key: 'all', label: '全部文件' },
      { key: 'unorganized', label: '待整理文件' },
      { key: 'tags', label: '全部标签' },
      { key: 'trash', label: '废纸篓' },
    ]

    return (
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          <div className="w-full">{children}</div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className="min-w-[180px] bg-white dark:bg-zinc-900 rounded-md overflow-hidden p-1 shadow-[0px_10px_38px_-10px_rgba(22,_23,_24,_0.35),_0px_10px_20px_-15px_rgba(22,_23,_24,_0.2)] border border-zinc-200 dark:border-zinc-800 animate-in fade-in-80 z-50"
          >
            <ContextMenu.Item
              onClick={() => handleToggleShortcut(key)}
              className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
            >
              从快捷项移除
            </ContextMenu.Item>
            <ContextMenu.Separator className="h-px bg-zinc-200 dark:bg-zinc-800 m-1" />
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer justify-between">
                显示/隐藏快捷项
                <ChevronRight className="w-3.5 h-3.5" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent
                  className="min-w-[160px] bg-white dark:bg-zinc-900 rounded-md overflow-hidden p-1 shadow-lg border border-zinc-200 dark:border-zinc-800 animate-in fade-in-80 z-50"
                  sideOffset={2}
                  alignOffset={-5}
                >
                  {shortcutItems.map(item => (
                    <ContextCheckboxMenuItem
                      key={item.key}
                      checked={visibleShortcuts[item.key]}
                      onToggle={() => handleToggleShortcut(item.key)}
                    >
                      {item.label}
                    </ContextCheckboxMenuItem>
                  ))}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
            <ContextMenu.Item
              onClick={handleResetShortcuts}
              className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
            >
              恢复默认快捷项
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    )
  }

  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  // Generate Folder Tree from get_folders API
  const renderFolderTree = () => {
    // Build hierarchical tree from flat folder list
    type TreeNode = {
      path: string
      parent_path: string | null
      display_name: string
      asset_count: number
      show_subfolders: boolean
      children: TreeNode[]
    }
    const nodeMap = new Map<string, TreeNode>()
    const rootNodes: TreeNode[] = []

    // Create nodes
    for (const f of folders) {
      nodeMap.set(f.path, {
        path: f.path,
        parent_path: f.parent_path,
        display_name: f.display_name,
        asset_count: f.asset_count,
        show_subfolders: f.show_subfolders,
        children: [],
      })
    }

    // Build parent-child relationships
    for (const f of folders) {
      const node = nodeMap.get(f.path)!
      const parentPath = f.parent_path
      if (parentPath !== null && parentPath !== f.path && nodeMap.has(parentPath)) {
        nodeMap.get(parentPath)!.children.push(node)
      } else {
        rootNodes.push(node)
      }
    }

    const sortTree = (nodes: TreeNode[]) => {
      nodes.sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' }))
      for (const n of nodes) {
        if (n.children.length > 0) {
          sortTree(n.children)
        }
      }
    }
    sortTree(rootNodes)

    // Recursive component to render tree
    const FolderNodeComponent = ({ node, level = 0 }: { node: TreeNode; level?: number }) => {
      const [isExpanded, setIsExpanded] = useState(true)
      const hasChildren = node.children.length > 0

      const normalizedNodePath = normalizeFolderPath(node.path)
      const isSelected = currentFolderNormalized === normalizedNodePath
      const isFolderCardsVisible = folderPreviewVisibility[normalizedNodePath] ?? true

      const handleFolderClick = (e: React.MouseEvent) => {
        e.stopPropagation()
        if (isSelected) {
          closeFolderPreviewToParent(node.parent_path)
        } else {
          openFolderPreview(node.path)
        }
      }

      const handleToggleShowSubfolders = async (newVal: boolean) => {
        if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return
        try {
          await invoke('update_folder_show_subfolders', {
            folderPath: node.path,
            showSubfolders: newVal,
            folder_path: node.path,
            show_subfolders: newVal,
          })
          // Update local state
          setFolders(prev => prev.map(f =>
            f.path === node.path ? { ...f, show_subfolders: newVal } : f
          ))
          window.dispatchEvent(new Event('quickasset:refresh-assets'))
        } catch (e) {
          console.error('Failed to toggle show_subfolders:', e)
        }
      }

      return (
        <div className="w-full">
          <ContextMenu.Root>
            <ContextMenu.Trigger>
              <div className="flex items-center">
                <button
                  onClick={() => {
                    if (hasChildren) setIsExpanded(!isExpanded)
                  }}
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
                  onClick={handleFolderClick}
                  className={`flex-1 flex items-center justify-between px-1 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
                    isSelected
                      ? "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300"
                      : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-50"
                  }`}
                >
                  <div className="flex items-center gap-1.5 overflow-hidden">
                    <Folder className="w-3.5 h-3.5 opacity-70 shrink-0" />
                    <span className="truncate">{node.display_name}</span>
                  </div>
                  {node.asset_count > 0 && <span className="text-xs opacity-60 shrink-0 px-1">{node.asset_count}</span>}
                </button>
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content
                className="min-w-[180px] bg-white dark:bg-zinc-900 rounded-md overflow-hidden p-1 shadow-[0px_10px_38px_-10px_rgba(22,_23,_24,_0.35),_0px_10px_20px_-15px_rgba(22,_23,_24,_0.2)] border border-zinc-200 dark:border-zinc-800 animate-in fade-in-80 z-50"
              >
                <ContextCheckboxMenuItem
                  checked={isFolderCardsVisible}
                  onToggle={() => setFolderPreviewVisibility(normalizedNodePath, !isFolderCardsVisible)}
                  icon={<Folder className="w-3.5 h-3.5 opacity-70" />}
                >
                  显示文件夹预览
                </ContextCheckboxMenuItem>
                <ContextMenu.Separator className="h-px bg-zinc-200 dark:bg-zinc-800 m-1" />
                <ContextCheckboxMenuItem
                  checked={node.show_subfolders}
                  onToggle={() => handleToggleShowSubfolders(!node.show_subfolders)}
                  icon={<Folder className="w-3.5 h-3.5 opacity-70" />}
                >
                  显示子文件夹内容
                </ContextCheckboxMenuItem>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>

          {isExpanded && hasChildren && (
            <div className="flex flex-col w-full">
              {node.children.map(child => (
                <FolderNodeComponent key={child.path} node={child} level={level + 1} />
              ))}
            </div>
          )}
        </div>
      )
    }

    return (
      <div className="space-y-0.5">
        {rootNodes.map(child => (
          <FolderNodeComponent key={child.path} node={child} />
        ))}
      </div>
    )
  }

  const handleImport = async () => {
    setIsMenuOpen(false)
    if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return

    try {
      await invoke("scan_library")
      // Reload assets via the global helper
      await (window as any).__loadAssets?.()
    } catch (err) {
      console.warn("Import failed.", err)
      alert("扫描失败: " + err)
    }
  }

  const handleCleanupMissing = async () => {
    setIsMenuOpen(false)
    try {
      const missingIds = await invoke<string[]>("check_health")
      if (missingIds.length === 0) {
        alert("所有资产均完好无损，无需清理！")
        return
      }

      const confirmMsg = `发现 ${missingIds.length} 个失效文件记录，是否立即清理数据库？`
      if (window.confirm(confirmMsg)) {
        await invoke("delete_assets", { ids: missingIds })
        // Reload assets
        await (window as any).__loadAssets?.()
        alert("清理完成！")
      }
    } catch (err) {
      console.error("Failed to cleanup missing assets:", err)
      alert("清理失败: " + err)
    }
  }

  const handleAddWorkspace = async (name: string) => {
    if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
      try {
        const result = await invoke('create_workspace', { name }) as any
        setWorkspaces([...workspaces, { id: result.id, name: result.name }])
        setWorkspaceCounts(prev => ({ ...prev, [result.id]: 0 }))
      } catch (e) {
        console.error('Failed to create workspace:', e)
      }
    } else {
      addWorkspace(name)
    }
  }

  const handleDeleteWorkspace = async (wsId: string) => {
    if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
      try {
        await invoke('delete_workspace', { id: wsId })
        setWorkspaces(workspaces.filter(w => w.id !== wsId))
        setWorkspaceCounts(prev => {
          const next = { ...prev }
          delete next[wsId]
          return next
        })
        if (activeWorkspaceId === wsId) {
          selectSidebarView('all')
        }
      } catch (e) {
        console.error('Failed to delete workspace:', e)
      }
    } else {
      const newWorkspaces = workspaces.filter(w => w.id !== wsId)
      useAssetStore.setState({ workspaces: newWorkspaces })
      if (activeWorkspaceId === wsId) {
        selectSidebarView('all')
      }
    }
  }

  // Library name display
  const libraryName = currentLibrary?.name || "QuickAsset"

  return (
    <aside className={isMobile
      ? "fixed inset-y-0 left-0 z-40 flex h-full w-[min(18rem,calc(100vw-1rem))] shrink-0 flex-col border-r border-zinc-200 bg-[#fafafa] shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
      : "static z-0 flex h-full w-56 shrink-0 flex-col border-r border-zinc-200 bg-[#fafafa] dark:border-zinc-800 dark:bg-zinc-950"
    }>
      {/* Top Header */}
      <div className="flex items-center gap-4 px-4 py-4 relative">
        <div ref={menuRef}>
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md transition-colors"
          >
            <Menu className="w-5 h-5 text-zinc-600 dark:text-zinc-400" />
          </button>

          {isMenuOpen && (
            <div className="absolute top-12 left-4 w-48 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md shadow-lg z-50 py-1">
              <button
                onClick={handleImport}
                className="w-full text-left px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                扫描素材库
              </button>
              <button
                onClick={handleCleanupMissing}
                className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 flex items-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                清理失效资产
              </button>
              <div className="h-px bg-zinc-200 dark:bg-zinc-800 my-1" />
              <button className="w-full text-left px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                全局设置
              </button>
            </div>
          )}
        </div>
        <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-white shadow-sm">
          <Target className="w-5 h-5" />
        </div>
        <button
          onClick={toggleLeftSidebar}
          className="ml-auto rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-800 lg:hidden"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Account Info */}
      <div className="px-5 mb-4">
        <h2 className="font-bold text-zinc-900 dark:text-zinc-100 text-lg mb-1">{libraryName}</h2>
        <div className="flex flex-col text-xs text-zinc-500 gap-1 mt-2">
          <div className="flex items-center justify-between">
            <span>本地资产总计</span>
            <span className="font-medium">{libraryStats.active_count} 项</span>
          </div>
          <div className="flex items-center justify-between">
            <span>占用空间</span>
            <span className="font-medium">
              {libraryStats.total_size > 0
                ? (libraryStats.total_size / (1024 * 1024)).toFixed(2) + " MB"
                : "0 MB"}
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3">
        {/* Main Navigation */}
        <nav className="space-y-0.5 mb-6">
          {visibleShortcuts.all && renderNavContextMenu(
            <NavItem id="nav-all" icon={<Box />} label="全部文件" count={libraryStats.active_count} active={!isFolderPreviewMode && activeView === 'all'} onClick={() => selectSidebarView('all')} />,
            'all'
          )}
          {visibleShortcuts.unorganized && renderNavContextMenu(
            <NavItem id="nav-unorganized" icon={<CheckSquare />} label="待整理文件" count={0} active={!isFolderPreviewMode && activeView === 'unorganized'} onClick={() => selectSidebarView('unorganized')} />,
            'unorganized'
          )}
          {visibleShortcuts.tags && renderNavContextMenu(
            <NavItem id="nav-tags" icon={<Tags />} label="全部标签" active={!isFolderPreviewMode && activeView === 'tags'} onClick={() => selectSidebarView('tags')} />,
            'tags'
          )}
          {visibleShortcuts.trash && renderNavContextMenu(
            <NavItem id="nav-trash" icon={<Trash2 />} label="废纸篓" count={libraryStats.trashed_count} active={!isFolderPreviewMode && activeView === 'trash'} onClick={() => selectSidebarView('trash')} />,
            'trash'
          )}

          {/* Workspaces Header */}
          <div className="pt-4 pb-1 px-2 flex items-center justify-between group">
            <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">工作区</span>
            <button
              onClick={() => setIsAddingWorkspace(true)}
              className="opacity-0 group-hover:opacity-100 p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-all rounded"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {isAddingWorkspace && (
            <div className="px-2 py-1.5 mb-1">
              <input
                autoFocus
                type="text"
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value)}
                onBlur={() => {
                  setIsAddingWorkspace(false)
                  setNewWorkspaceName("")
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newWorkspaceName.trim()) {
                    handleAddWorkspace(newWorkspaceName.trim())
                    setIsAddingWorkspace(false)
                    setNewWorkspaceName("")
                  } else if (e.key === 'Escape') {
                    setIsAddingWorkspace(false)
                    setNewWorkspaceName("")
                  }
                }}
                placeholder="新工作区名称..."
                className="w-full px-2 py-1 text-sm bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded outline-none focus:border-indigo-500"
              />
            </div>
          )}

          {/* Workspaces List */}
          {(showAllWorkspaces ? workspaces : workspaces.slice(0, 5)).map(ws => {
            return (
              <ContextMenu.Root key={ws.id}>
                <ContextMenu.Trigger>
                  <div className="w-full">
                    <NavItem
                      icon={<Box />}
                      label={ws.name}
                      count={workspaceCounts[ws.id] ?? 0}
                      active={!isFolderPreviewMode && activeView === 'workspace' && activeWorkspaceId === ws.id}
                      onClick={() => selectSidebarView('workspace', ws.id)}
                    />
                  </div>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content
                    className="min-w-[160px] bg-white dark:bg-zinc-900 rounded-md overflow-hidden p-1 shadow-[0px_10px_38px_-10px_rgba(22,_23,_24,_0.35),_0px_10px_20px_-15px_rgba(22,_23,_24,_0.2)] border border-zinc-200 dark:border-zinc-800 animate-in fade-in-80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 z-50"
                  >
                    <ContextMenu.Item
                      onClick={(e) => {
                        e.stopPropagation()
                        const confirmDelete = window.confirm('确定要删除此工作区吗？这不会删除其中的文件。')
                        if (confirmDelete) {
                          handleDeleteWorkspace(ws.id)
                        }
                      }}
                      className="group text-[13px] leading-none text-red-600 dark:text-red-400 rounded-[3px] flex items-center h-8 px-2 relative select-none outline-none data-[disabled]:text-zinc-400 data-[disabled]:pointer-events-none data-[highlighted]:bg-red-500 data-[highlighted]:text-white cursor-pointer"
                    >
                      删除工作区
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            )
          })}

          {workspaces.length > 5 && (
            <button
              onClick={() => setShowAllWorkspaces(!showAllWorkspaces)}
              className="w-full text-left px-2 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
            >
              {showAllWorkspaces ? "收起工作区" : `显示全部工作区 (${workspaces.length})`}
            </button>
          )}
        </nav>

        {/* Folders Tree */}
        <div className="pb-6">
          <h3 className="text-[11px] font-semibold text-zinc-400 mb-2 px-2">物理文件夹</h3>
          <nav className="space-y-0.5">
            {folders.length > 0 ? (
              renderFolderTree()
            ) : (
              <div className="px-2 text-xs text-zinc-500 italic">暂无本地文件夹</div>
            )}
          </nav>
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between text-zinc-500">
        <button className="p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md transition-colors">
          <Menu className="w-4 h-4 opacity-0" /> {/* Spacer for symmetry if needed, or actual search icon */}
        </button>
        <button
          id="global-import-btn"
          onClick={handleImport}
          className="p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md transition-colors"
          title="扫描素材库"
        >
          <Plus className="w-5 h-5" />
        </button>
      </div>
    </aside>
  )
}

function NavItem({ icon, label, count, active, onClick, id }: { icon: React.ReactNode; label: string; count?: number; active?: boolean; onClick?: () => void; id?: string }) {
  return (
    <button
      id={id}
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
        active
          ? "bg-zinc-200/60 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50"
          : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-50"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="w-4 h-4 flex items-center justify-center opacity-70">{icon}</div>
        <span className="truncate">{label}</span>
      </div>
      {count !== undefined && <span className="shrink-0 text-xs text-zinc-400 opacity-80">{count}</span>}
    </button>
  )
}
