import { useState, useRef, useEffect } from "react"
import { Menu, Target, CheckSquare, Tags, Trash2, Box, Folder, Plus, ChevronRight, ChevronDown, Check, X } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { useAssetStore, type Asset } from "@/store/useAssetStore"
import * as ContextMenu from '@radix-ui/react-context-menu'
import { isMobile } from "@/lib/utils"

export function LeftSidebar() {
  const { assets, setAssets, workspaces, activeWorkspaceId, activeView, setActiveView, addWorkspace, toggleLeftSidebar } = useAssetStore()
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isAddingWorkspace, setIsAddingWorkspace] = useState(false)
  const [newWorkspaceName, setNewWorkspaceName] = useState("")
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false)
  const [visibleShortcuts, setVisibleShortcuts] = useState({
    all: true,
    unorganized: true,
    tags: true,
    trash: true
  })

  const handleToggleShortcut = (key: keyof typeof visibleShortcuts) => {
    setVisibleShortcuts(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleResetShortcuts = () => {
    setVisibleShortcuts({ all: true, unorganized: true, tags: true, trash: true })
  }

  const renderNavContextMenu = (children: React.ReactNode, key: keyof typeof visibleShortcuts) => {
    return (
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {children}
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
                  <ContextMenu.CheckboxItem 
                    checked={visibleShortcuts.all}
                    onCheckedChange={() => handleToggleShortcut('all')}
                    className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 pl-8 pr-2 relative select-none outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    <ContextMenu.ItemIndicator className="absolute left-2 inline-flex items-center justify-center">
                      <Check className="w-4 h-4" />
                    </ContextMenu.ItemIndicator>
                    全部文件
                  </ContextMenu.CheckboxItem>
                  <ContextMenu.CheckboxItem 
                    checked={visibleShortcuts.unorganized}
                    onCheckedChange={() => handleToggleShortcut('unorganized')}
                    className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 pl-8 pr-2 relative select-none outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    <ContextMenu.ItemIndicator className="absolute left-2 inline-flex items-center justify-center">
                      <Check className="w-4 h-4" />
                    </ContextMenu.ItemIndicator>
                    待整理文件
                  </ContextMenu.CheckboxItem>
                  <ContextMenu.CheckboxItem 
                    checked={visibleShortcuts.tags}
                    onCheckedChange={() => handleToggleShortcut('tags')}
                    className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 pl-8 pr-2 relative select-none outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    <ContextMenu.ItemIndicator className="absolute left-2 inline-flex items-center justify-center">
                      <Check className="w-4 h-4" />
                    </ContextMenu.ItemIndicator>
                    全部标签
                  </ContextMenu.CheckboxItem>
                  <ContextMenu.CheckboxItem 
                    checked={visibleShortcuts.trash}
                    onCheckedChange={() => handleToggleShortcut('trash')}
                    className="group text-[13px] leading-none text-zinc-700 dark:text-zinc-300 rounded-[3px] flex items-center h-8 pl-8 pr-2 relative select-none outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    <ContextMenu.ItemIndicator className="absolute left-2 inline-flex items-center justify-center">
                      <Check className="w-4 h-4" />
                    </ContextMenu.ItemIndicator>
                    废纸篓
                  </ContextMenu.CheckboxItem>
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

  const getSafeArray = (jsonStr: string | string[] | null | undefined): string[] => {
    if (!jsonStr) return []
    if (Array.isArray(jsonStr)) return jsonStr
    try {
      const parsed = JSON.parse(jsonStr)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  // Generate Folder Tree from assets paths
  const renderFolderTree = () => {
    // 1. Extract unique parent directories from all assets
    const folderPaths = Array.from(new Set(assets.filter(a => !a.is_trashed).map(a => {
      const parts = a.path.split(/[\\/]/)
      parts.pop() // remove file name
      return parts.join('/')
    })))

    // 2. Build hierarchical tree
    type TreeNode = { name: string; path: string; children: Record<string, TreeNode>; count: number }
    const root: TreeNode = { name: 'root', path: '', children: {}, count: 0 }

    folderPaths.forEach(folderPath => {
      const parts = folderPath.split('/')
      let current = root
      let currentPath = ''

      parts.forEach((part) => {
        if (!part) return
        currentPath = currentPath ? `${currentPath}/${part}` : part
        if (!current.children[part]) {
          current.children[part] = { name: part, path: currentPath, children: {}, count: 0 }
        }
        current = current.children[part]
      })
    })

    // 3. Count assets for each node
    assets.filter(a => !a.is_trashed).forEach(a => {
      const parts = a.path.split(/[\\/]/)
      parts.pop()
      const folderPath = parts.join('/')
      
      const folderParts = folderPath.split('/')
      let current = root
      folderParts.forEach(part => {
        if (!part) return
        if (current.children[part]) {
          current.children[part].count++
          current = current.children[part]
        }
      })
    })

    // Recursive component to render tree
    const FolderNode = ({ node, level = 0 }: { node: TreeNode, level?: number }) => {
      const [isExpanded, setIsExpanded] = useState(true)
      const { folderFilter, setFolderFilter } = useAssetStore()
      const hasChildren = Object.keys(node.children).length > 0
      
      const isSelected = folderFilter?.includes(node.path)

      const handleFolderClick = (e: React.MouseEvent) => {
        e.stopPropagation()
        if (isSelected) {
          setFolderFilter(null)
        } else {
          setFolderFilter([node.path])
          useAssetStore.getState().setActiveView('all') // Switch to all view to see folder results
        }
      }

      return (
        <div className="w-full">
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
                <div className="w-3.5 h-3.5" /> // spacer
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
                <span className="truncate">{node.name}</span>
              </div>
              {node.count > 0 && <span className="text-xs opacity-60 shrink-0 px-1">{node.count}</span>}
            </button>
          </div>
          
          {isExpanded && hasChildren && (
            <div className="flex flex-col w-full">
              {Object.values(node.children).map(child => (
                <FolderNode key={child.path} node={child} level={level + 1} />
              ))}
            </div>
          )}
        </div>
      )
    }

    return (
      <div className="space-y-0.5">
        {Object.values(root.children).map(child => (
          <FolderNode key={child.path} node={child} />
        ))}
      </div>
    )
  }

  const folderTree: Record<string, boolean> = assets.filter(a => !a.is_trashed).length > 0 ? { hasFolders: true } : {}

  const handleImport = async () => {
    setIsMenuOpen(false)
    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: "选择包含图片、视频或模型文件的文件夹",
      })

      if (selectedPath && typeof selectedPath === 'string') {
        try {
          // Run the scan, which inserts into the DB
          await invoke("scan_directory", { dirPath: selectedPath })
          // Start watching the directory for hot-reloading
          await invoke("start_watcher", { dirPath: selectedPath })
          // Fetch all assets from DB to update the state
          const allAssets = await invoke<Asset[]>("get_all_assets")
          setAssets(allAssets)
        } catch (err) {
          console.warn("Import failed.", err)
        }
      }
    } catch (err) {
      console.warn("Tauri environment not detected or import failed. Using mock data.", err)
      const mockData = [
        { id: "1", name: "sebastien-flores-5.jpeg", path: "E:/PixcallLibrary/Pixcall/需求参考/sebastien-flores-5.jpeg", asset_type: "image", size: 377731, dominant_color: "#ffffff", thumbnail_base64: "/mock/sebastien-flores-5.jpeg", workspace_ids: '["2"]' },
        { id: "2", name: "图像-(1).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(1).jpg", asset_type: "image", size: 172804, dominant_color: "#888888", thumbnail_base64: "/mock/图像-(1).jpg", workspace_ids: '["2"]' },
        { id: "3", name: "图像-(1).png", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(1).png", asset_type: "image", size: 220966, dominant_color: "#cccccc", thumbnail_base64: "/mock/图像-(1).png", workspace_ids: '["2"]' },
        { id: "4", name: "图像-(2).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(2).jpg", asset_type: "image", size: 102324, dominant_color: "#ff0000", thumbnail_base64: "/mock/图像-(2).jpg", workspace_ids: '["2"]' },
        { id: "5", name: "图像-(2).png", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(2).png", asset_type: "image", size: 248480, dominant_color: "#00ff00", thumbnail_base64: "/mock/图像-(2).png", workspace_ids: '["2"]' },
        { id: "6", name: "图像-(3).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(3).jpg", asset_type: "image", size: 117623, dominant_color: "#0000ff", thumbnail_base64: "/mock/图像-(3).jpg", workspace_ids: '["2"]' },
        { id: "7", name: "图像-(4).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(4).jpg", asset_type: "image", size: 57073, dominant_color: "#ffff00", thumbnail_base64: "/mock/图像-(4).jpg", workspace_ids: '["2"]' },
        { id: "8", name: "图像-(5).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(5).jpg", asset_type: "image", size: 42371, dominant_color: "#00ffff", thumbnail_base64: "/mock/图像-(5).jpg", workspace_ids: '["2"]' },
        { id: "9", name: "图像-(6).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(6).jpg", asset_type: "image", size: 72415, dominant_color: "#ff00ff", thumbnail_base64: "/mock/图像-(6).jpg", workspace_ids: '["2"]' },
        { id: "10", name: "图像-(7).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(7).jpg", asset_type: "image", size: 37876, dominant_color: "#ffffff", thumbnail_base64: "/mock/图像-(7).jpg", workspace_ids: '["2"]' },
        { id: "11", name: "图像.jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像.jpg", asset_type: "image", size: 474188, dominant_color: "#ffffff", thumbnail_base64: "/mock/图像.jpg", workspace_ids: '["2"]' },
        { id: "12", name: "图像.png", path: "E:/PixcallLibrary/Pixcall/需求参考/图像.png", asset_type: "image", size: 203956, dominant_color: "#ffffff", thumbnail_base64: "/mock/图像.png", workspace_ids: '["2"]' },
      ]
      setAssets(mockData)
      alert("已加载 E:\\PixcallLibrary\\Pixcall\\需求参考 的真实本地测试图片！")
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
        for (const id of missingIds) {
          await invoke("delete_asset", { id })
        }
        // Fetch all assets from DB to update the state
        const allAssets = await invoke<Asset[]>("get_all_assets")
        setAssets(allAssets)
        alert("清理完成！")
      }
    } catch (err) {
      console.error("Failed to cleanup missing assets:", err)
      alert("清理失败: " + err)
    }
  }

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
                导入文件夹
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
        <h2 className="font-bold text-zinc-900 dark:text-zinc-100 text-lg mb-1">qiezihanbao</h2>
        <div className="flex flex-col text-xs text-zinc-500 gap-1 mt-2">
          <div className="flex items-center justify-between">
            <span>本地资产总计</span>
            <span className="font-medium">{assets.length} 项</span>
          </div>
          <div className="flex items-center justify-between">
            <span>占用空间</span>
            <span className="font-medium">
              {assets.length > 0 
                ? (assets.reduce((sum, asset) => sum + asset.size, 0) / (1024 * 1024)).toFixed(2) + " MB" 
                : "0 MB"}
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3">
        {/* Main Navigation */}
        <nav className="space-y-0.5 mb-6">
          {visibleShortcuts.all && renderNavContextMenu(
            <NavItem id="nav-all" icon={<Box />} label="全部文件" count={assets.filter(a => !a.is_trashed).length} active={activeView === 'all'} onClick={() => setActiveView('all')} />,
            'all'
          )}
          {visibleShortcuts.unorganized && renderNavContextMenu(
            <NavItem id="nav-unorganized" icon={<CheckSquare />} label="待整理文件" count={assets.filter(a => !a.is_trashed && getSafeArray(a.workspace_ids).length === 0 && getSafeArray(a.tags).length === 0).length} active={activeView === 'unorganized'} onClick={() => setActiveView('unorganized')} />,
            'unorganized'
          )}
          {visibleShortcuts.tags && renderNavContextMenu(
            <NavItem id="nav-tags" icon={<Tags />} label="全部标签" count={Array.from(new Set(assets.flatMap(a => getSafeArray(a.tags)))).length} active={activeView === 'tags'} onClick={() => setActiveView('tags')} />,
            'tags'
          )}
          {visibleShortcuts.trash && renderNavContextMenu(
            <NavItem id="nav-trash" icon={<Trash2 />} label="废纸篓" count={assets.filter(a => a.is_trashed).length} active={activeView === 'trash'} onClick={() => setActiveView('trash')} />,
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
                    addWorkspace(newWorkspaceName.trim())
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
            // Calculate count for this workspace safely
            const count = assets.filter(a => {
              if (!a.workspace_ids) return false;
              try {
                const currentWs = typeof a.workspace_ids === 'string' ? JSON.parse(a.workspace_ids) : []
                return Array.isArray(currentWs) && currentWs.includes(ws.id);
              } catch {
                // If it's already an array or parsing fails
                if (Array.isArray(a.workspace_ids)) {
                  return (a.workspace_ids as string[]).includes(ws.id)
                }
                return false;
              }
            }).length;
            
            return (
              <ContextMenu.Root key={ws.id}>
                <ContextMenu.Trigger>
                  <NavItem 
                    icon={<Box />} 
                    label={ws.name} 
                    count={count}
                    active={activeView === 'workspace' && activeWorkspaceId === ws.id}
                    onClick={() => setActiveView('workspace', ws.id)}
                  />
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content 
                    className="min-w-[160px] bg-white dark:bg-zinc-900 rounded-md overflow-hidden p-1 shadow-[0px_10px_38px_-10px_rgba(22,_23,_24,_0.35),_0px_10px_20px_-15px_rgba(22,_23,_24,_0.2)] border border-zinc-200 dark:border-zinc-800 animate-in fade-in-80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 z-50"
                  >
                    <ContextMenu.Item 
                      onClick={(e) => {
                        e.stopPropagation()
                        // Handle delete workspace
                        const confirmDelete = window.confirm('确定要删除此工作区吗？这不会删除其中的文件。')
                        if (confirmDelete) {
                          const newWorkspaces = workspaces.filter(w => w.id !== ws.id)
                          useAssetStore.setState({ workspaces: newWorkspaces })
                          if (activeWorkspaceId === ws.id) {
                            setActiveView('all')
                          }
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
            {Object.keys(folderTree).length > 0 ? (
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
          title="导入文件夹"
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


