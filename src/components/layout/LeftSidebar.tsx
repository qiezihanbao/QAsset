import { useState, useRef, useEffect, useCallback } from "react"
import { createPortal } from "react-dom"
import { Menu, Target, CheckSquare, Tags, Trash2, Box, Folder, Plus, ChevronRight, ChevronDown, Check, X, Sparkles, FolderOpen, Settings2, RefreshCw, SunMoon, Sun, Moon } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { useAssetStore, type ViewType, type Workspace, type RegistryEntry, type ProgressTask } from "@/store/useAssetStore"
import * as ContextMenu from '@radix-ui/react-context-menu'
import { isMobile } from "@/lib/utils"
import { useShallow } from "zustand/react/shallow"
import { useTheme, type ThemeMode } from "@/hooks/useTheme"

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

interface CountQueryResult {
  total_count: number
}

type QuickAssetWindow = Window & {
  __loadAssets?: () => Promise<void> | void
  __openLibrary?: (path: string) => Promise<void>
}

const loadAssetsFromWindow = async () => {
  const quickWindow = window as QuickAssetWindow
  await quickWindow.__loadAssets?.()
}

const themeOptions: Array<{ mode: ThemeMode; label: string; icon: React.ReactNode }> = [
  { mode: "system", label: "跟随系统", icon: <SunMoon className="h-3.5 w-3.5" /> },
  { mode: "light", label: "浅色", icon: <Sun className="h-3.5 w-3.5" /> },
  { mode: "dark", label: "深色", icon: <Moon className="h-3.5 w-3.5" /> },
]

type ShortcutKey = 'all' | 'unorganized' | 'tags' | 'similar' | 'trash'

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
  const [
    assets, workspaces, setWorkspaces, activeWorkspaceId, activeView,
    folderFilter, folderPreviewVisibility, setFolderPreviewVisibility,
    addWorkspace, toggleLeftSidebar, currentLibrary, currentLibraryPath,
    recentLibraries, setRecentLibraries, progressTasks,
  ] = useAssetStore(useShallow((s) => ([
    s.assets, s.workspaces, s.setWorkspaces, s.activeWorkspaceId, s.activeView,
    s.folderFilter, s.folderPreviewVisibility, s.setFolderPreviewVisibility,
    s.addWorkspace, s.toggleLeftSidebar, s.currentLibrary, s.currentLibraryPath,
    s.recentLibraries, s.setRecentLibraries, s.progressTasks,
  ])))
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false)
  const [isSettingsBusy, setIsSettingsBusy] = useState(false)
  const [isAddingWorkspace, setIsAddingWorkspace] = useState(false)
  const [newWorkspaceName, setNewWorkspaceName] = useState("")
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false)
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [workspaceCounts, setWorkspaceCounts] = useState<Record<string, number>>({})
  const [unorganizedCount, setUnorganizedCount] = useState(0)
  const [libraryStats, setLibraryStats] = useState<LibraryStats>({
    active_count: 0,
    trashed_count: 0,
    total_size: 0,
  })
  const [visibleShortcuts, setVisibleShortcuts] = useState({
    all: true,
    unorganized: true,
    tags: true,
    similar: true,
    trash: true
  })
  const [isRootTreeExpanded, setIsRootTreeExpanded] = useState(false)
  const { themeMode, setThemeMode } = useTheme()
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
  const activeProgressTasks = (Object.values(progressTasks).filter(Boolean) as ProgressTask[])
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const getProgressPercent = useCallback((task: ProgressTask) => {
    if (task.total <= 0) return task.status === 'success' ? 100 : 12
    return Math.max(0, Math.min(100, (task.current / task.total) * 100))
  }, [])

  const getProgressBarClassName = useCallback((task: ProgressTask) => {
    if (task.status === 'error') return "h-1.5 rounded-full bg-red-500 transition-all duration-300"
    if (task.status === 'success') return "h-1.5 rounded-full bg-emerald-500 transition-all duration-300"
    return "h-1.5 rounded-full bg-indigo-500 transition-all duration-300"
  }, [])

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

  const openRootFolder = useCallback(() => {
    useAssetStore.setState({
      folderFilter: null,
      similarAssetIds: null,
      activeView: 'all',
      activeWorkspaceId: null,
    })
    window.dispatchEvent(new Event('quickasset:refresh-assets'))
  }, [])

  // Load workspaces from backend on mount
  useEffect(() => {
    if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return
    if (!currentLibraryPath) {
      setWorkspaces([])
      return
    }
    invoke<Workspace[]>('get_workspaces').then((ws) => {
      setWorkspaces(ws.map((w) => ({ id: w.id, name: w.name })))
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
          const result = await invoke<CountQueryResult>('query_assets', {
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

  const loadUnorganizedCount = useCallback(async () => {
    if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return
    if (!currentLibraryPath) {
      setUnorganizedCount(0)
      return
    }

    try {
      const result = await invoke<CountQueryResult>('query_assets', {
        filters: {
          unorganized: true,
          is_trashed: false,
          sort_field: 'created_at',
          sort_order: 'desc',
          page: 1,
          page_size: 1,
        }
      })
      setUnorganizedCount(Number(result?.total_count || 0))
    } catch (e) {
      console.warn('Failed to load unorganized count:', e)
    }
  }, [currentLibraryPath])

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
    loadUnorganizedCount()
  }, [loadUnorganizedCount, assets.length])

  useEffect(() => {
    loadLibraryStats()
  }, [loadLibraryStats, assets.length])

  useEffect(() => {
    const onAssetsRefresh = () => {
      loadFolders()
      loadWorkspaceCounts()
      loadUnorganizedCount()
      loadLibraryStats()
    }
    window.addEventListener('quickasset:refresh-assets', onAssetsRefresh)
    return () => window.removeEventListener('quickasset:refresh-assets', onAssetsRefresh)
  }, [loadFolders, loadWorkspaceCounts, loadUnorganizedCount, loadLibraryStats])

  const handleToggleShortcut = (key: ShortcutKey) => {
    setVisibleShortcuts(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleResetShortcuts = () => {
    setVisibleShortcuts({ all: true, unorganized: true, tags: true, similar: true, trash: true })
  }

  const renderNavContextMenu = (children: React.ReactNode, key: ShortcutKey) => {
    const shortcutItems: Array<{ key: ShortcutKey; label: string }> = [
      { key: 'all', label: '全部文件' },
      { key: 'unorganized', label: '待整理文件' },
      { key: 'tags', label: '全部标签' },
      { key: 'similar', label: '相似图处理' },
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

    const rootFolderLabel = currentLibrary?.name
      || (() => {
        const parts = (currentLibraryPath || '').replace(/\\/g, '/').split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : 'root'
      })()
    const isRootSelected = !currentFolderNormalized && activeView === 'all'
    const handleRootFolderClick = () => {
      if (isRootSelected) {
        setIsRootTreeExpanded(prev => !prev)
        return
      }
      openRootFolder()
    }

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
          setIsRootTreeExpanded(true)
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
              <div className="flex min-w-0 items-center" style={{ paddingLeft: `${level * 12}px` }}>
                <button
                  onClick={() => {
                    if (hasChildren) setIsExpanded(!isExpanded)
                  }}
                  className="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                >
                  {hasChildren ? (
                    isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />
                  ) : (
                    <div className="w-3.5 h-3.5" />
                  )}
                </button>
                <button
                  onClick={handleFolderClick}
                  className={`flex min-w-0 flex-1 items-center justify-between px-1 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
                    isSelected
                      ? "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300"
                      : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-50"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                    <Folder className="w-3.5 h-3.5 opacity-70 shrink-0" />
                    <span
                      className="min-w-0 overflow-hidden whitespace-nowrap"
                      style={{
                        WebkitMaskImage: 'linear-gradient(to right, black 84%, transparent)',
                        maskImage: 'linear-gradient(to right, black 84%, transparent)',
                      }}
                    >
                      {node.display_name}
                    </span>
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
        <button
          onClick={handleRootFolderClick}
          className={`w-full flex items-center justify-between px-1 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
            isRootSelected
              ? "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300"
              : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-50"
          }`}
        >
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <Folder className="w-3.5 h-3.5 opacity-70 shrink-0" />
            <span
              className="min-w-0 overflow-hidden whitespace-nowrap"
              style={{
                WebkitMaskImage: 'linear-gradient(to right, black 84%, transparent)',
                maskImage: 'linear-gradient(to right, black 84%, transparent)',
              }}
            >
              {rootFolderLabel}
            </span>
          </div>
          {libraryStats.active_count > 0 && <span className="text-xs opacity-60 shrink-0 px-1">{libraryStats.active_count}</span>}
        </button>
        {isRootTreeExpanded && (
          <div className="pl-3">
            {rootNodes.map(child => (
              <FolderNodeComponent key={child.path} node={child} />
            ))}
          </div>
        )}
      </div>
    )
  }

  const handleImport = async () => {
    setIsMenuOpen(false)
    if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return

    try {
      await invoke("scan_library")
      // Reload assets via the global helper
      await loadAssetsFromWindow()
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
        await loadAssetsFromWindow()
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
        const result = await invoke<Workspace>('create_workspace', { name })
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

  const refreshRecentLibraries = useCallback(async () => {
    if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return
    try {
      const recents = await invoke<RegistryEntry[]>("get_recent_libraries")
      setRecentLibraries(recents)
    } catch (e) {
      console.warn("Failed to refresh recent libraries:", e)
    }
  }, [setRecentLibraries])

  useEffect(() => {
    if (!isSettingsModalOpen) return
    void refreshRecentLibraries()
  }, [isSettingsModalOpen, refreshRecentLibraries])

  const openLibraryByPath = useCallback(async (path: string) => {
    const quickWindow = window as QuickAssetWindow
    if (!quickWindow.__openLibrary) {
      alert("当前无法切换素材库，请稍后重试。")
      return
    }
    setIsSettingsBusy(true)
    try {
      await quickWindow.__openLibrary(path)
      await refreshRecentLibraries()
      setIsSettingsModalOpen(false)
      setIsMenuOpen(false)
    } catch (e) {
      console.error("Failed to open library:", e)
      alert(`打开素材库失败: ${String(e)}`)
    } finally {
      setIsSettingsBusy(false)
    }
  }, [refreshRecentLibraries])

  const handlePickLibrary = async () => {
    if (isSettingsBusy) return
    try {
      const path = await open({ directory: true, title: "选择素材库文件夹" })
      if (!path || typeof path !== "string") return
      await openLibraryByPath(path)
    } catch (e) {
      console.warn("Open library dialog failed:", e)
    }
  }

  const handleCreateLibrary = async () => {
    if (isSettingsBusy) return
    try {
      const path = await open({ directory: true, title: "选择新素材库位置" })
      if (!path || typeof path !== "string") return
      const inputName = window.prompt("请输入素材库名称", "我的素材库")
      if (inputName === null) return
      const name = inputName.trim() || "我的素材库"
      setIsSettingsBusy(true)
      await invoke("create_library", { path, name })
      setIsSettingsBusy(false)
      await openLibraryByPath(path)
    } catch (e) {
      setIsSettingsBusy(false)
      console.error("Failed to create library:", e)
      alert(`创建素材库失败: ${String(e)}`)
    }
  }

  const handleRebuildThumbnails = async () => {
    if (isSettingsBusy) return
    if (!window.confirm("重建缩略图会重新处理当前库中的图片和视频，是否继续？")) return
    setIsSettingsBusy(true)
    try {
      const rebuilt = await invoke<number>("rebuild_all_thumbnails")
      await loadAssetsFromWindow()
      window.dispatchEvent(new Event("quickasset:refresh-assets"))
      alert(`重建完成，共处理 ${rebuilt} 个资源。`)
    } catch (e) {
      console.error("Failed to rebuild thumbnails:", e)
      alert(`重建缩略图失败: ${String(e)}`)
    } finally {
      setIsSettingsBusy(false)
    }
  }

  const handleRebuildIndex = async () => {
    if (isSettingsBusy) return
    if (!window.confirm("重建索引会重新构建搜索与标签索引，是否继续？")) return
    setIsSettingsBusy(true)
    try {
      const indexed = await invoke<number>("rebuild_search_index")
      window.dispatchEvent(new Event("quickasset:refresh-assets"))
      alert(`重建索引完成，已处理 ${indexed} 条资源记录。`)
    } catch (e) {
      console.error("Failed to rebuild index:", e)
      alert(`重建索引失败: ${String(e)}`)
    } finally {
      setIsSettingsBusy(false)
    }
  }

  // Library name display
  const libraryName = currentLibrary?.name || "QuickAsset"
  const settingsModal = isSettingsModalOpen ? (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/45 px-4 py-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isSettingsBusy) {
          setIsSettingsModalOpen(false)
        }
      }}
    >
      <div className="w-full max-w-4xl overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">素材库管理与全局设置</h3>
            <p className="mt-0.5 text-xs text-zinc-500">统一入口：素材库打开/切换、主题模式、重建缩略图与索引</p>
          </div>
          <button
            type="button"
            disabled={isSettingsBusy}
            onClick={() => setIsSettingsModalOpen(false)}
            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-4 p-4 md:grid-cols-2">
          <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <h4 className="text-xs font-semibold text-zinc-500">素材库管理</h4>
            <p className="mt-1 truncate text-xs text-zinc-400">当前库: {currentLibraryPath || "未打开素材库"}</p>

            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={isSettingsBusy}
                onClick={handlePickLibrary}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                打开素材库
              </button>
              <button
                type="button"
                disabled={isSettingsBusy}
                onClick={handleCreateLibrary}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <Plus className="h-3.5 w-3.5" />
                新建素材库
              </button>
            </div>

            <div className="mt-3 rounded-md border border-zinc-200 dark:border-zinc-800">
              <div className="px-2 py-1.5 text-[11px] font-medium text-zinc-500">最近素材库（点击切换）</div>
              {recentLibraries.length === 0 && (
                <div className="px-2 pb-2 text-xs text-zinc-400">暂无最近素材库</div>
              )}
              {recentLibraries.slice(0, 10).map((lib) => {
                const isCurrent = lib.path === currentLibraryPath
                return (
                  <button
                    key={lib.path}
                    type="button"
                    disabled={isSettingsBusy}
                    onClick={() => void openLibraryByPath(lib.path)}
                    className="flex w-full items-center justify-between px-2 py-1.5 text-left text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    title={lib.path}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{lib.name}</div>
                      <div className="truncate text-[11px] text-zinc-400">{lib.path}</div>
                    </div>
                    {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-indigo-500" />}
                  </button>
                )
              })}
            </div>
          </section>

          <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <h4 className="text-xs font-semibold text-zinc-500">全局设置</h4>
            <p className="mt-1 text-xs text-zinc-400">主题模式与库维护工具</p>

            <div className="mt-3 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
              <p className="text-[11px] text-zinc-500">主题模式</p>
              <div className="mt-1 flex gap-1">
                {themeOptions.map((option) => (
                  <button
                    key={option.mode}
                    type="button"
                    onClick={() => setThemeMode(option.mode)}
                    className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                      themeMode === option.mode
                        ? "bg-indigo-500 text-white"
                        : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                    }`}
                  >
                    {option.icon}
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={isSettingsBusy}
                onClick={handleRebuildThumbnails}
                className="flex flex-1 items-center justify-center gap-1 rounded-md border border-zinc-200 px-2 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isSettingsBusy ? "animate-spin" : ""}`} />
                重建缩略图
              </button>
              <button
                type="button"
                disabled={isSettingsBusy}
                onClick={handleRebuildIndex}
                className="flex flex-1 items-center justify-center gap-1 rounded-md border border-zinc-200 px-2 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isSettingsBusy ? "animate-spin" : ""}`} />
                重建索引
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  ) : null

  return (
    <>
      <aside className={isMobile
        ? "fixed inset-y-0 left-0 z-40 flex h-full w-[min(18rem,calc(100vw-1rem))] shrink-0 flex-col border-r border-zinc-200 bg-[#fafafa] shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
        : "static flex h-full w-56 shrink-0 flex-col border-r border-zinc-200 bg-[#fafafa] dark:border-zinc-800 dark:bg-zinc-950"
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
            <div className="absolute top-12 left-4 w-56 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md shadow-lg z-50 py-1">
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
              <button
                onClick={() => {
                  setIsMenuOpen(false)
                  setIsSettingsModalOpen(true)
                }}
                className="w-full text-left px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-2"
              >
                <Settings2 className="w-4 h-4" />
                素材库管理与全局设置
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

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-3">
        {/* Main Navigation */}
        <nav className="space-y-0.5 mb-6">
          {visibleShortcuts.all && renderNavContextMenu(
            <NavItem id="nav-all" icon={<Box />} label="全部文件" count={libraryStats.active_count} active={!isFolderPreviewMode && activeView === 'all'} onClick={() => selectSidebarView('all')} />,
            'all'
          )}
          {visibleShortcuts.unorganized && renderNavContextMenu(
            <NavItem id="nav-unorganized" icon={<CheckSquare />} label="待整理文件" count={unorganizedCount} active={!isFolderPreviewMode && activeView === 'unorganized'} onClick={() => selectSidebarView('unorganized')} />,
            'unorganized'
          )}
          {visibleShortcuts.tags && renderNavContextMenu(
            <NavItem id="nav-tags" icon={<Tags />} label="全部标签" active={!isFolderPreviewMode && activeView === 'tags'} onClick={() => selectSidebarView('tags')} />,
            'tags'
          )}
          {visibleShortcuts.similar && renderNavContextMenu(
            <NavItem id="nav-similar" icon={<Sparkles />} label="相似图处理" active={!isFolderPreviewMode && activeView === 'similar'} onClick={() => selectSidebarView('similar')} />,
            'similar'
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

      {activeProgressTasks.length > 0 && (
        <div className="px-3 pb-2">
          <div className="space-y-2 rounded-lg border border-zinc-200 bg-white/80 p-2 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/70">
            {activeProgressTasks.map((task) => (
              <div key={task.kind} className="rounded-md border border-zinc-200/70 bg-white/80 p-2 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">{task.title}</span>
                  <span className="shrink-0 text-[10px] text-zinc-500">
                    {task.total > 0 ? `${Math.min(task.current, task.total)}/${task.total}` : task.phase}
                  </span>
                </div>
                <div className="mb-1 truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                  {task.message || '处理中...'}
                </div>
                <div className="h-1.5 w-full rounded-full bg-zinc-200 dark:bg-zinc-700">
                  <div
                    className={getProgressBarClassName(task)}
                    style={{ width: `${getProgressPercent(task)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
      {settingsModal ? createPortal(settingsModal, document.body) : null}
    </>
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
