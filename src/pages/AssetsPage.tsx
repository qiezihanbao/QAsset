import { Image as ImageIcon, FileText, Video, Box, ChevronLeft, ChevronRight, Filter, Grid, List, Search, ChevronDown, Columns } from "lucide-react"
import { useAssetStore } from "@/store/useAssetStore"

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

export function AssetsPage() {
  const { 
    assets, setSelectedAsset, selectedAsset, searchQuery, setSearchQuery, 
    colorFilter, setColorFilter, typeFilter, setTypeFilter, tagFilter, setTagFilter,
    activeWorkspaceId, workspaces, thumbnailSize, setThumbnailSize, layoutMode, setLayoutMode 
  } = useAssetStore()

  // Get all unique tags from all assets
  const allTags = Array.from(new Set(
    assets.flatMap(a => a.tags ? JSON.parse(a.tags) : [])
  ))

  const activeWorkspaceName = activeWorkspaceId 
    ? workspaces.find(w => w.id === activeWorkspaceId)?.name 
    : "全部文件"

  const filteredAssets = assets.filter(asset => {
    // Workspace filter
    const matchesWorkspace = activeWorkspaceId === null || (asset.workspace_ids && asset.workspace_ids.includes(activeWorkspaceId))

    // Search filter
    const matchesSearch = asset.name.toLowerCase().includes(searchQuery.toLowerCase())
    
    // Type filter
    const matchesType = typeFilter === null || asset.asset_type === typeFilter

    // Tag filter
    const matchesTag = tagFilter === null || (asset.tags && JSON.parse(asset.tags).includes(tagFilter))
    
    // Color filter (threshold 150 for Euclidean distance in RGB space out of ~441 max)
    let matchesColor = true
    if (colorFilter) {
      if (!asset.dominant_color) {
        matchesColor = false
      } else {
        const distance = colorDistance(colorFilter, asset.dominant_color)
        matchesColor = distance < 150 // Adjust threshold as needed
      }
    }
    
    return matchesWorkspace && matchesSearch && matchesType && matchesTag && matchesColor
  })

  const getAssetIcon = (type: string) => {
    switch (type) {
      case "image": return <ImageIcon className="w-10 h-10 text-zinc-400 dark:text-zinc-600 group-hover:scale-110 transition-transform" />
      case "video": return <Video className="w-10 h-10 text-zinc-400 dark:text-zinc-600 group-hover:scale-110 transition-transform" />
      case "3d": return <Box className="w-10 h-10 text-zinc-400 dark:text-zinc-600 group-hover:scale-110 transition-transform" />
      default: return <FileText className="w-10 h-10 text-zinc-400 dark:text-zinc-600 group-hover:scale-110 transition-transform" />
    }
  }

  const getAssetColor = (type: string) => {
    switch (type) {
      case "image": return "bg-blue-500"
      case "video": return "bg-red-500"
      case "3d": return "bg-purple-500"
      default: return "bg-zinc-500"
    }
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
          <span className="ml-2 font-bold text-zinc-900 dark:text-zinc-100">{activeWorkspaceName}</span>
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
      <div className="flex items-center gap-4 px-6 py-2 border-b border-zinc-100 dark:border-zinc-800 shrink-0 overflow-x-auto no-scrollbar">
        {/* Color Filter */}
        <div className="relative group">
          <button className="w-5 h-5 rounded-full bg-gradient-to-br from-red-500 via-green-500 to-blue-500 flex-shrink-0 ring-1 ring-zinc-200 dark:ring-zinc-700" />
          <div className="absolute top-full left-0 mt-1 hidden group-hover:flex bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 rounded-lg shadow-lg z-10 gap-1 w-max">
            {PRESET_COLORS.map(color => (
              <button
                key={color.label}
                title={color.label}
                onClick={() => setColorFilter(colorFilter === color.value ? null : color.value)}
                className={`w-5 h-5 rounded-full border shadow-sm transition-transform hover:scale-110 ${
                  colorFilter === color.value 
                    ? "border-blue-500 ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-zinc-900" 
                    : "border-zinc-200 dark:border-zinc-700"
                }`}
                style={{ backgroundColor: color.value }}
              />
            ))}
          </div>
        </div>

        <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-800" />

        {/* Filter Chips */}
        <div className="flex items-center gap-3 text-sm text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
          <button className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">关键字</button>
          <button className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">文件名</button>
          <button className="flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">
            文件夹 <ChevronDown className="w-3 h-3" />
          </button>
          <div className="relative group">
            <button className={`flex items-center gap-1 transition-colors ${tagFilter ? 'text-indigo-500 font-medium' : 'hover:text-zinc-900 dark:hover:text-zinc-100'}`}>
              {tagFilter ? `标签: ${tagFilter}` : '标签'} <ChevronDown className="w-3 h-3" />
            </button>
            <div className="absolute top-full left-0 mt-1 hidden group-hover:flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg z-10 py-1 min-w-[120px] max-h-48 overflow-y-auto no-scrollbar">
              <button onClick={() => setTagFilter(null)} className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">全部标签</button>
              {allTags.length > 0 ? allTags.map((tag: any) => (
                <button key={tag} onClick={() => setTagFilter(tag)} className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  {tag}
                </button>
              )) : (
                <div className="px-3 py-1.5 text-xs text-zinc-500 italic">暂无标签</div>
              )}
            </div>
          </div>
          <div className="relative group">
            <button className={`flex items-center gap-1 transition-colors ${typeFilter ? 'text-indigo-500 font-medium' : 'hover:text-zinc-900 dark:hover:text-zinc-100'}`}>
              {typeFilter ? `类型: ${typeFilter}` : '类型'} <ChevronDown className="w-3 h-3" />
            </button>
            <div className="absolute top-full left-0 mt-1 hidden group-hover:flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg z-10 py-1 min-w-[100px]">
              <button onClick={() => setTypeFilter(null)} className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">全部</button>
              <button onClick={() => setTypeFilter('image')} className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">图片</button>
              <button onClick={() => setTypeFilter('video')} className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">视频</button>
              <button onClick={() => setTypeFilter('3d')} className="px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">3D 模型</button>
            </div>
          </div>
          <button className="flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors">
            形状 <ChevronDown className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Grid Area */}
      <div className="flex-1 overflow-y-auto p-6 bg-white dark:bg-[#121212]">
        {filteredAssets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500">
            <p>没有找到资产</p>
            <p className="text-sm">请尝试调整筛选条件或导入新的文件夹。</p>
          </div>
        ) : (
          <div 
            style={layoutMode === 'masonry' ? { 
              columnWidth: `${thumbnailSize}px`, 
              columnGap: '24px' 
            } : {
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(${thumbnailSize}px, 1fr))`,
              gap: '24px'
            }}
          >
            {filteredAssets.map((asset) => {
              const isSelected = selectedAsset?.id === asset.id;
              return (
                <div
                  key={asset.id}
                  onClick={() => setSelectedAsset(asset)}
                  className={`group flex flex-col items-center cursor-pointer break-inside-avoid ${layoutMode === 'masonry' ? 'mb-8' : ''}`}
                >
                  <div 
                    className={`w-full rounded-xl overflow-hidden transition-all duration-200 ${
                      isSelected ? "ring-2 ring-indigo-500 ring-offset-2 dark:ring-offset-[#121212]" : ""
                    } bg-zinc-100 dark:bg-zinc-900`}
                  >
                    <div className={`w-full flex items-center justify-center ${!asset.thumbnail_base64 ? getAssetColor(asset.asset_type) : ''} bg-opacity-10 dark:bg-opacity-10`}>
                      {asset.thumbnail_base64 ? (
                        <img 
                          src={asset.thumbnail_base64} 
                          alt={asset.name} 
                          className={`w-full ${layoutMode === 'grid' ? 'aspect-square object-cover' : 'h-auto object-contain'}`} 
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
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
