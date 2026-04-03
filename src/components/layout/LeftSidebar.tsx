import { useState, useRef, useEffect } from "react"
import { Menu, Target, CheckSquare, Tags, Trash2, Globe, Box, Folder, Plus, ChevronRight, CheckCircle, ChevronDown } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { useAssetStore } from "@/store/useAssetStore"

export function LeftSidebar() {
  const { assets, setAssets, workspaces, activeWorkspaceId, setActiveWorkspace } = useAssetStore()
  const [isMenuOpen, setIsMenuOpen] = useState(false)
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

  const handleImport = async () => {
    setIsMenuOpen(false)
    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
      })

      if (selectedPath && typeof selectedPath === 'string') {
        // Run the scan, which inserts into the DB
        await invoke("scan_directory", { dirPath: selectedPath })
        // Fetch all assets from DB to update the state
        const allAssets = await invoke("get_all_assets")
        setAssets(allAssets as any[])
      }
    } catch (err) {
      console.error("Failed to import folder:", err)
      const mockData = [
        { id: "1", name: "sebastien-flores-5.jpeg", path: "E:/PixcallLibrary/Pixcall/需求参考/sebastien-flores-5.jpeg", asset_type: "image", size: 377731, dominant_color: "#ffffff", thumbnail_base64: "/mock/sebastien-flores-5.jpeg", workspace_ids: ["2"] },
        { id: "2", name: "图像-(1).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(1).jpg", asset_type: "image", size: 172804, dominant_color: "#888888", thumbnail_base64: "/mock/图像-(1).jpg", workspace_ids: ["2"] },
        { id: "3", name: "图像-(1).png", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(1).png", asset_type: "image", size: 220966, dominant_color: "#cccccc", thumbnail_base64: "/mock/图像-(1).png", workspace_ids: ["2"] },
        { id: "4", name: "图像-(2).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(2).jpg", asset_type: "image", size: 102324, dominant_color: "#ff0000", thumbnail_base64: "/mock/图像-(2).jpg", workspace_ids: ["2"] },
        { id: "5", name: "图像-(2).png", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(2).png", asset_type: "image", size: 248480, dominant_color: "#00ff00", thumbnail_base64: "/mock/图像-(2).png", workspace_ids: ["2"] },
        { id: "6", name: "图像-(3).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(3).jpg", asset_type: "image", size: 117623, dominant_color: "#0000ff", thumbnail_base64: "/mock/图像-(3).jpg", workspace_ids: ["2"] },
        { id: "7", name: "图像-(4).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(4).jpg", asset_type: "image", size: 57073, dominant_color: "#ffff00", thumbnail_base64: "/mock/图像-(4).jpg", workspace_ids: ["2"] },
        { id: "8", name: "图像-(5).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(5).jpg", asset_type: "image", size: 42371, dominant_color: "#00ffff", thumbnail_base64: "/mock/图像-(5).jpg", workspace_ids: ["2"] },
        { id: "9", name: "图像-(6).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(6).jpg", asset_type: "image", size: 72415, dominant_color: "#ff00ff", thumbnail_base64: "/mock/图像-(6).jpg", workspace_ids: ["2"] },
        { id: "10", name: "图像-(7).jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像-(7).jpg", asset_type: "image", size: 37876, dominant_color: "#ffffff", thumbnail_base64: "/mock/图像-(7).jpg", workspace_ids: ["2"] },
        { id: "11", name: "图像.jpg", path: "E:/PixcallLibrary/Pixcall/需求参考/图像.jpg", asset_type: "image", size: 474188, dominant_color: "#ffffff", thumbnail_base64: "/mock/图像.jpg", workspace_ids: ["2"] },
        { id: "12", name: "图像.png", path: "E:/PixcallLibrary/Pixcall/需求参考/图像.png", asset_type: "image", size: 203956, dominant_color: "#ffffff", thumbnail_base64: "/mock/图像.png", workspace_ids: ["2"] },
      ]
      setAssets(mockData)
      alert("已加载 E:\\PixcallLibrary\\Pixcall\\需求参考 的真实本地测试图片！")
    }
  }

  return (
    <aside className="w-64 border-r border-zinc-200 dark:border-zinc-800 bg-[#fafafa] dark:bg-zinc-950 flex flex-col h-full shrink-0">
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
              <button className="w-full text-left px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                文件
              </button>
              <button className="w-full text-left px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                编辑
              </button>
              <button className="w-full text-left px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                窗口
              </button>
              <button className="w-full text-left px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                设置
              </button>
            </div>
          )}
        </div>
        <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-white shadow-sm">
          <Target className="w-5 h-5" />
        </div>
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
          <NavItem icon={<Box />} label="全部文件" count={assets.length > 0 ? assets.length : 13550} active={activeWorkspaceId === null} onClick={() => setActiveWorkspace(null)} />
          <NavItem icon={<CheckSquare />} label="待整理文件" count={76} />
          <NavItem icon={<Tags />} label="全部标签" count={130} />
          <NavItem icon={<Trash2 />} label="废纸篓" count={33} />
          {/* Workspaces are mapped here as well */}
          {workspaces.map(ws => (
            <NavItem 
              key={ws.id}
              icon={<Box />} 
              label={ws.name} 
              count={12} // mock count
              active={activeWorkspaceId === ws.id}
              onClick={() => setActiveWorkspace(ws.id)}
            />
          ))}
        </nav>

        {/* Folders Tree */}
        <div>
          <h3 className="text-[11px] font-semibold text-zinc-400 mb-2 px-2">文件夹</h3>
          <nav className="space-y-0.5">
            <FolderItem label="Pixcall" count={13550} defaultOpen>
              <FolderItem label="neco" count={39} indent />
              <FolderItem label="需求参考" count={12} indent />
            </FolderItem>
            <FolderItem label="Light" count={974}>
              <FolderItem label="Scene" count={47} indent />
            </FolderItem>
            <FolderItem label="参考和其他.library" count={12402} />
          </nav>
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between text-zinc-500">
        <button className="p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md transition-colors">
          <Menu className="w-4 h-4 opacity-0" /> {/* Spacer for symmetry if needed, or actual search icon */}
        </button>
        <button 
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

function NavItem({ icon, label, count, active, onClick }: { icon: React.ReactNode; label: string; count?: number; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-2 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
        active
          ? "bg-zinc-200/60 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50"
          : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-50"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <div className="w-4 h-4 flex items-center justify-center opacity-70">{icon}</div>
        {label}
      </div>
      {count !== undefined && <span className="text-xs text-zinc-400 opacity-80">{count}</span>}
    </button>
  )
}

function FolderItem({ label, count, indent, defaultOpen, children }: { label: string; count?: number; indent?: boolean; defaultOpen?: boolean; children?: React.ReactNode }) {
  return (
    <div>
      <button
        className={`w-full flex items-center justify-between px-2 py-1.5 rounded-md text-[13px] text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-50 transition-colors ${indent ? 'pl-6' : ''}`}
      >
        <div className="flex items-center gap-1.5">
          {children ? (defaultOpen ? <ChevronDown className="w-3.5 h-3.5 opacity-50" /> : <ChevronRight className="w-3.5 h-3.5 opacity-50" />) : <div className="w-3.5 h-3.5" />}
          <Folder className="w-3.5 h-3.5 opacity-70" />
          <span>{label}</span>
        </div>
        {count !== undefined && <span className="text-xs text-zinc-400 opacity-80">{count}</span>}
      </button>
      {defaultOpen && children && (
        <div className="mt-0.5">
          {children}
        </div>
      )}
    </div>
  )
}
