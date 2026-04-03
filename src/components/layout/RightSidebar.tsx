import { useState, useEffect } from "react"
import { ExternalLink, Star, Plus, X } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { useAssetStore } from "@/store/useAssetStore"
import { isMobile } from "@/lib/utils"

const hasTauriRuntime = () => Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__)

export function RightSidebar() {
  const { assets, selectedAssets, workspaces, updateAssetProperty, setSimilarAssetIds, toggleRightSidebar } = useAssetStore()
  const selectedAsset = assets.find((asset) => asset.id === selectedAssets[0]) ?? null
  const [descInput, setDescInput] = useState("")
  const [sourceUrlInput, setSourceUrlInput] = useState("")
  const [tagInput, setTagInput] = useState("")
  const [isSearchingSimilar, setIsSearchingSimilar] = useState(false)
  
  useEffect(() => {
    if (selectedAsset) {
      setDescInput(selectedAsset.description || "")
      setSourceUrlInput(selectedAsset.source_url || "")
    }
  }, [selectedAsset])

  if (!selectedAsset) {
    return (
      <aside className={isMobile
        ? "fixed inset-y-0 right-0 z-40 flex h-full w-[min(20rem,calc(100vw-1rem))] shrink-0 flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
        : "flex h-full w-72 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
      }>
        <div className="p-4 flex-1 flex flex-col items-center justify-center text-zinc-500">
          {isMobile && (
            <button
              onClick={toggleRightSidebar}
              className="absolute right-4 top-4 rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <p className="text-sm">Select an asset to view properties</p>
        </div>
      </aside>
    )
  }

  const safeInvoke = async (command: string, args?: Record<string, unknown>) => {
    if (hasTauriRuntime()) {
      return await invoke(command, args)
    } else {
      console.warn(`Tauri environment not detected. Skipped command: ${command}`, args)
    }
  }

  const handleUpdateSourceUrl = async () => {
    if (sourceUrlInput === selectedAsset.source_url) return
    updateAssetProperty(selectedAsset.id, { source_url: sourceUrlInput })
    try {
      await safeInvoke("update_asset", {
        id: selectedAsset.id,
        tags: selectedAsset.tags || null,
        description: selectedAsset.description || null,
        rating: selectedAsset.rating || null,
        workspace_ids: selectedAsset.workspace_ids || null,
        source_url: sourceUrlInput || null
      })
    } catch (err) {
      console.error("Failed to update source URL:", err)
    }
  }

  const handleUpdateDesc = async () => {
    if (descInput === selectedAsset.description) return
    updateAssetProperty(selectedAsset.id, { description: descInput })
    try {
      await safeInvoke("update_asset", {
        id: selectedAsset.id,
        tags: selectedAsset.tags || null,
        description: descInput,
        rating: selectedAsset.rating || null,
        workspace_ids: selectedAsset.workspace_ids || null
      })
    } catch (err) {
      console.error("Failed to update description:", err)
    }
  }

  const handleRating = async (rating: number) => {
    const newRating = selectedAsset.rating === rating ? 0 : rating
    updateAssetProperty(selectedAsset.id, { rating: newRating })
    try {
      await safeInvoke("update_asset", {
        id: selectedAsset.id,
        tags: selectedAsset.tags || null,
        description: selectedAsset.description || null,
        rating: newRating || null,
        workspace_ids: selectedAsset.workspace_ids || null
      })
    } catch (err) {
      console.error("Failed to update rating:", err)
    }
  }

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

  const handleAddTag = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && tagInput.trim()) {
      const currentTags = getSafeArray(selectedAsset.tags)
      if (!currentTags.includes(tagInput.trim())) {
        const newTags = [...currentTags, tagInput.trim()]
        const newTagsStr = JSON.stringify(newTags)
        updateAssetProperty(selectedAsset.id, { tags: newTagsStr })
        setTagInput("")
        try {
          await safeInvoke("update_asset", {
            id: selectedAsset.id,
            tags: newTagsStr,
            description: selectedAsset.description || null,
            rating: selectedAsset.rating || null,
            workspace_ids: selectedAsset.workspace_ids || null
          })
        } catch (err) {
          console.error("Failed to update tags:", err)
        }
      }
    }
  }

  const handleRemoveTag = async (tagToRemove: string) => {
    const currentTags = getSafeArray(selectedAsset.tags)
    const newTags = currentTags.filter((t: string) => t !== tagToRemove)
    const newTagsStr = newTags.length > 0 ? JSON.stringify(newTags) : null
    updateAssetProperty(selectedAsset.id, { tags: newTagsStr || undefined })
    try {
      await safeInvoke("update_asset", {
        id: selectedAsset.id,
        tags: newTagsStr,
        description: selectedAsset.description || null,
        rating: selectedAsset.rating || null,
        workspace_ids: selectedAsset.workspace_ids || null
      })
    } catch (error) {
      console.error("Failed to update tags:", error)
    }
  }

  const handleToggleWorkspace = async (workspaceId: string) => {
    const currentWsIds = getSafeArray(selectedAsset.workspace_ids)
    let newWsIds: string[]
    
    if (currentWsIds.includes(workspaceId)) {
      newWsIds = currentWsIds.filter((id: string) => id !== workspaceId)
    } else {
      newWsIds = [...currentWsIds, workspaceId]
    }
    
    const newWsIdsStr = newWsIds.length > 0 ? JSON.stringify(newWsIds) : undefined
    updateAssetProperty(selectedAsset.id, { workspace_ids: newWsIdsStr })
    
    try {
      await safeInvoke("update_asset", {
        id: selectedAsset.id,
        tags: selectedAsset.tags || null,
        description: selectedAsset.description || null,
        rating: selectedAsset.rating || null,
        workspace_ids: newWsIdsStr || null
      })
    } catch (err) {
      console.error("Failed to update workspaces:", err)
    }
  }

  const handleSearchSimilar = async () => {
    setIsSearchingSimilar(true)
    try {
      const similarIds = await safeInvoke("find_similar_images", {
        targetId: selectedAsset.id,
        threshold: 15 // Adjust perceptual hash distance threshold (0-64)
      })
      if (Array.isArray(similarIds)) {
        // Include the target asset itself in the results
        setSimilarAssetIds([selectedAsset.id, ...similarIds])
      }
    } catch (err) {
      console.error("Failed to search similar images:", err)
    } finally {
      setIsSearchingSimilar(false)
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B"
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB"
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB"
  }

  return (
    <aside className={isMobile
      ? "fixed inset-y-0 right-0 z-40 flex h-full w-[min(20rem,calc(100vw-1rem))] shrink-0 flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
      : "flex h-full w-72 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
    }>
      <div className="p-5 flex-1 overflow-y-auto no-scrollbar">
        {isMobile && (
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">文件信息</h2>
            <button
              onClick={toggleRightSidebar}
              className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {!isMobile && (
          <h2 className="mb-6 text-center text-sm font-semibold text-zinc-900 dark:text-zinc-100">文件信息</h2>
        )}
        
        <div className="space-y-6">
          <div>
            <h3 className="text-[13px] font-bold text-zinc-900 dark:text-zinc-100 mb-4 break-all">
              {selectedAsset.name}
            </h3>
            
            <div className="space-y-4">
              {/* Folder */}
              <div>
                <p className="text-xs text-zinc-500 mb-1.5">文件夹</p>
                <div className="flex items-center gap-1.5 text-[13px] text-zinc-700 dark:text-zinc-300 break-all">
                  <div className="w-4 h-4 shrink-0 border border-zinc-300 dark:border-zinc-700 rounded flex items-center justify-center bg-zinc-50 dark:bg-zinc-900">
                    <div className="w-2 h-1 border-t border-l border-zinc-400"></div>
                  </div>
                  <span>{selectedAsset.path || '需求参考'}</span>
                </div>
              </div>

              {/* Workspaces */}
              <div>
                <p className="text-xs text-zinc-500 mb-1.5">分配工作区</p>
                <div className="flex flex-wrap gap-2">
                  {workspaces.map(ws => {
                    const isAssigned = getSafeArray(selectedAsset.workspace_ids).includes(ws.id)
                    return (
                      <button
                        key={ws.id}
                        onClick={() => handleToggleWorkspace(ws.id)}
                        className={`px-2 py-1 text-xs rounded-md border transition-colors ${
                          isAssigned 
                            ? 'bg-indigo-50 dark:bg-indigo-500/10 border-indigo-200 dark:border-indigo-500/20 text-indigo-600 dark:text-indigo-400' 
                            : 'bg-transparent border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:border-zinc-300 dark:hover:border-zinc-700'
                        }`}
                      >
                        {ws.name}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Tags */}
              <div>
                <p className="text-xs text-zinc-500 mb-1.5">标签</p>
                <div className="flex flex-wrap gap-2 mb-2">
                  {getSafeArray(selectedAsset.tags).map((tag: string) => (
                    <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs rounded-md">
                      {tag}
                      <button onClick={() => handleRemoveTag(tag)} className="hover:text-red-500 transition-colors">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="relative flex items-center">
                  <Plus className="w-3.5 h-3.5 absolute left-2 text-zinc-400" />
                  <input
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={handleAddTag}
                    placeholder="输入标签后按回车"
                    className="w-full pl-7 pr-3 py-1.5 bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-md text-[13px] focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
              </div>

              {/* Description */}
              <div>
                <p className="text-xs text-zinc-500 mb-1.5">描述</p>
                <textarea
                  value={descInput}
                  onChange={(e) => setDescInput(e.target.value)}
                  onBlur={handleUpdateDesc}
                  placeholder="添加描述..."
                  className="w-full min-h-[60px] p-2 bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-md text-[13px] text-zinc-700 dark:text-zinc-300 focus:outline-none focus:border-indigo-500 transition-colors resize-y"
                />
              </div>

              {/* Tools */}
              {selectedAsset.asset_type === 'image' && (
                <div>
                  <p className="text-xs text-zinc-500 mb-1.5">智能工具</p>
                  <button 
                    onClick={handleSearchSimilar}
                    disabled={isSearchingSimilar}
                    className="w-full py-1.5 px-3 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 text-[13px] rounded-md transition-colors flex items-center justify-center gap-2"
                  >
                    {isSearchingSimilar ? "正在检索相似图..." : "查找相似图 (查重)"}
                  </button>
                </div>
              )}

              {/* Source URL */}
              <div>
                <p className="text-xs text-zinc-500 mb-1.5">来源网址</p>
                <div className="flex flex-col gap-2">
                  <input
                    type="text"
                    value={sourceUrlInput}
                    onChange={(e) => setSourceUrlInput(e.target.value)}
                    onBlur={handleUpdateSourceUrl}
                    placeholder="添加来源网址..."
                    className="w-full p-2 bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-md text-[13px] text-zinc-700 dark:text-zinc-300 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                  {selectedAsset.source_url && (
                    <a href={selectedAsset.source_url} target="_blank" rel="noreferrer" className="text-[13px] text-indigo-500 hover:underline flex items-start gap-1 group break-all">
                      <span className="line-clamp-3">
                        {selectedAsset.source_url}
                      </span>
                      <ExternalLink className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Basic Info */}
          <div>
            <h3 className="text-[13px] font-bold text-zinc-900 dark:text-zinc-100 mb-3">基本信息</h3>
            <div className="space-y-2 text-[13px]">
              <div className="flex justify-between">
                <span className="text-zinc-500">评分</span>
                <div className="flex text-zinc-300 dark:text-zinc-700">
          {[1, 2, 3, 4, 5].map((star) => (
            <button key={star} onClick={() => handleRating(star)} className="focus:outline-none transition-colors">
              <Star 
                className={`w-3.5 h-3.5 ${(selectedAsset.rating || 0) >= star ? "fill-yellow-400 text-yellow-400" : "hover:text-yellow-400"}`} 
              />
            </button>
          ))}
        </div>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">尺寸</span>
                <span className="text-zinc-700 dark:text-zinc-300">{selectedAsset.width && selectedAsset.height ? `${selectedAsset.width}x${selectedAsset.height}` : '-'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">文件类型</span>
                <span className="text-zinc-700 dark:text-zinc-300">{selectedAsset.path.split('.').pop()?.toUpperCase() || selectedAsset.asset_type.toUpperCase()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">文件大小</span>
                <span className="text-zinc-700 dark:text-zinc-300">{formatSize(selectedAsset.size)}</span>
              </div>
              {selectedAsset.duration && (
                <div className="flex justify-between">
                  <span className="text-zinc-500">时长</span>
                  <span className="text-zinc-700 dark:text-zinc-300">{Math.round(selectedAsset.duration)}s</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-zinc-500">创建时间</span>
                <span className="text-zinc-700 dark:text-zinc-300">{selectedAsset.created_at ? new Date(selectedAsset.created_at * 1000).toLocaleString() : '-'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">修改时间</span>
                <span className="text-zinc-700 dark:text-zinc-300">{selectedAsset.modified_at ? new Date(selectedAsset.modified_at * 1000).toLocaleString() : '-'}</span>
              </div>
            </div>
          </div>
          
        </div>
      </div>
    </aside>
  )
}
