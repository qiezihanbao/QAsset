import { useState, useEffect } from "react"
import { ExternalLink, Star, Plus, X } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { useAssetStore, getSafeArray } from "@/store/useAssetStore"
import { isMobile } from "@/lib/utils"
import type { AssetDetail } from "@/store/useAssetStore"
import { useShallow } from "zustand/react/shallow"

const hasTauriRuntime = () => Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__)
const notifyAssetsRefresh = () => window.dispatchEvent(new Event('quickasset:refresh-assets'))

export function RightSidebar() {
  const [
    assets, selectedAssets, workspaces, assetDetail, setAssetDetail,
    updateAssetProperty, setSimilarAssetIds, toggleRightSidebar, tagsSummary,
  ] = useAssetStore(useShallow((s) => ([
    s.assets, s.selectedAssets, s.workspaces, s.assetDetail, s.setAssetDetail,
    s.updateAssetProperty, s.setSimilarAssetIds, s.toggleRightSidebar, s.tagsSummary,
  ])))
  const isBatchSelection = selectedAssets.length > 1
  const selectedAsset = !isBatchSelection
    ? assets.find((asset) => asset.id === selectedAssets[0]) ?? null
    : null
  const [descInput, setDescInput] = useState("")
  const [sourceUrlInput, setSourceUrlInput] = useState("")
  const [tagInput, setTagInput] = useState("")
  const [showTagPopover, setShowTagPopover] = useState(false)
  const [isSearchingSimilar, setIsSearchingSimilar] = useState(false)
  const [batchTagInput, setBatchTagInput] = useState("")
  const [isBatchMutating, setIsBatchMutating] = useState(false)

  const safeInvoke = async (command: string, args?: Record<string, unknown>) => {
    if (hasTauriRuntime()) {
      return await invoke(command, args)
    } else {
      console.warn(`Tauri environment not detected. Skipped command: ${command}`, args)
    }
  }

  // Fetch asset detail from backend when selection changes
  useEffect(() => {
    if (isBatchSelection) {
      setAssetDetail(null)
      return
    }
    if (selectedAsset && hasTauriRuntime()) {
      invoke<AssetDetail>('get_asset_detail', { id: selectedAsset.id })
        .then((detail) => {
          setAssetDetail(detail)
          setDescInput(detail.description || "")
          setSourceUrlInput(detail.source_url || "")
        })
        .catch((e) => console.error('Failed to load asset detail:', e))
    } else if (selectedAsset) {
      // Non-Tauri fallback - no detail available
      setDescInput("")
      setSourceUrlInput("")
      setAssetDetail(null)
    } else {
      setAssetDetail(null)
    }
  }, [isBatchSelection, selectedAsset, setAssetDetail])

  if (selectedAssets.length === 0) {
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
          <p className="text-sm">请选择一个资产查看属性</p>
        </div>
      </aside>
    )
  }

  const parseBatchTags = (raw: string) => {
    return Array.from(
      new Set(
        raw
          .split(/[,\uFF0C]/)
          .map((v) => v.trim())
          .filter(Boolean)
      )
    )
  }

  const runBatchTagUpdate = async (mode: 'add' | 'remove') => {
    const tags = parseBatchTags(batchTagInput)
    if (tags.length === 0 || isBatchMutating) return
    setIsBatchMutating(true)
    try {
      await safeInvoke("batch_update_asset_tags", {
        ids: selectedAssets,
        addTags: mode === 'add' ? tags : [],
        add_tags: mode === 'add' ? tags : [],
        removeTags: mode === 'remove' ? tags : [],
        remove_tags: mode === 'remove' ? tags : [],
      })
      setBatchTagInput("")
      await useAssetStore.getState().refreshTagsSummary()
      notifyAssetsRefresh()
    } catch (err) {
      console.error("Failed to batch update tags:", err)
    } finally {
      setIsBatchMutating(false)
    }
  }

  const runBatchWorkspaceUpdate = async (workspaceId: string, mode: 'add' | 'remove') => {
    if (!workspaceId || isBatchMutating) return
    setIsBatchMutating(true)
    try {
      await safeInvoke("batch_update_asset_workspaces", {
        ids: selectedAssets,
        addWorkspaceIds: mode === 'add' ? [workspaceId] : [],
        add_workspace_ids: mode === 'add' ? [workspaceId] : [],
        removeWorkspaceIds: mode === 'remove' ? [workspaceId] : [],
        remove_workspace_ids: mode === 'remove' ? [workspaceId] : [],
      })
      notifyAssetsRefresh()
    } catch (err) {
      console.error("Failed to batch update workspaces:", err)
    } finally {
      setIsBatchMutating(false)
    }
  }

  if (isBatchSelection) {
    const hotTags = Object.keys(tagsSummary)
      .sort((a, b) => (tagsSummary[b] || 0) - (tagsSummary[a] || 0))
      .slice(0, 10)

    return (
      <aside className={isMobile
        ? "fixed inset-y-0 right-0 z-40 flex h-full w-[min(20rem,calc(100vw-1rem))] shrink-0 flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
        : "flex h-full w-72 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
      }>
        <div className="p-5 flex-1 overflow-y-auto no-scrollbar space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">批量编辑</h2>
            {isMobile && (
              <button
                onClick={toggleRightSidebar}
                className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/40 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-300">
            已选择 <span className="font-semibold text-zinc-900 dark:text-zinc-100">{selectedAssets.length}</span> 个资源
          </div>

          <div>
            <p className="text-xs text-zinc-500 mb-2">批量标签（逗号分隔）</p>
            <input
              type="text"
              value={batchTagInput}
              onChange={(e) => setBatchTagInput(e.target.value)}
              placeholder="例如：封面,已审核"
              className="w-full px-3 py-1.5 bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-md text-[13px] focus:outline-none focus:border-indigo-500 transition-colors"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => runBatchTagUpdate('add')}
                disabled={isBatchMutating}
                className="px-2.5 py-1 text-xs rounded-md bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 transition-colors"
              >
                统一添加标签
              </button>
              <button
                onClick={() => runBatchTagUpdate('remove')}
                disabled={isBatchMutating}
                className="px-2.5 py-1 text-xs rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors"
              >
                统一移除标签
              </button>
            </div>
            {hotTags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {hotTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setBatchTagInput((prev) => (prev ? `${prev},${tag}` : tag))}
                    className="px-2 py-0.5 text-[11px] rounded-md border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:border-indigo-400 dark:hover:border-indigo-500/60 transition-colors"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="text-xs text-zinc-500 mb-2">批量工作区</p>
            <div className="space-y-2">
              {workspaces.map((ws) => (
                <div key={ws.id} className="flex items-center justify-between rounded-md border border-zinc-200 dark:border-zinc-800 px-2 py-1.5">
                  <span className="text-xs text-zinc-700 dark:text-zinc-300 truncate mr-2">{ws.name}</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => runBatchWorkspaceUpdate(ws.id, 'add')}
                      disabled={isBatchMutating}
                      className="px-2 py-0.5 text-[11px] rounded bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 transition-colors"
                    >
                      加入
                    </button>
                    <button
                      onClick={() => runBatchWorkspaceUpdate(ws.id, 'remove')}
                      disabled={isBatchMutating}
                      className="px-2 py-0.5 text-[11px] rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors"
                    >
                      移出
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>
    )
  }

  if (!selectedAsset) return null

  // Helper to get detail field with fallback
  const detail = assetDetail
  const detailTags = detail ? getSafeArray(detail.tags) : []
  const detailWorkspaceIds = detail ? getSafeArray(detail.workspace_ids) : []

  // Tag suggestions: all known tags filtered by current input, excluding already-assigned tags
  const tagSuggestions = Object.keys(tagsSummary)
    .filter((t) => !detailTags.includes(t))
    .filter((t) => !tagInput.trim() || t.toLowerCase().includes(tagInput.trim().toLowerCase()))
    .sort((a, b) => (tagsSummary[b] || 0) - (tagsSummary[a] || 0))

  const handleUpdateSourceUrl = async () => {
    if (!detail || sourceUrlInput === (detail.source_url || '')) return
    try {
      await safeInvoke("update_asset", {
        id: selectedAsset.id,
        sourceUrl: sourceUrlInput || null,
        source_url: sourceUrlInput || null,
      })
      // Refresh detail
      setAssetDetail({ ...detail, source_url: sourceUrlInput || undefined })
    } catch (err) {
      console.error("Failed to update source URL:", err)
    }
  }

  const handleUpdateDesc = async () => {
    if (!detail || descInput === (detail.description || '')) return
    try {
      await safeInvoke("update_asset", {
        id: selectedAsset.id,
        description: descInput || null,
      })
      setAssetDetail({ ...detail, description: descInput || undefined })
    } catch (err) {
      console.error("Failed to update description:", err)
    }
  }

  const handleRating = async (rating: number) => {
    const newRating = (detail?.rating || 0) === rating ? 0 : rating
    updateAssetProperty(selectedAsset.id, { rating: newRating })
    try {
      await safeInvoke("update_asset", {
        id: selectedAsset.id,
        rating: newRating || null,
      })
      if (detail) {
        setAssetDetail({ ...detail, rating: newRating || undefined })
      }
    } catch (err) {
      console.error("Failed to update rating:", err)
    }
  }

  const handleAddTag = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && tagInput.trim() && detail) {
      if (!detailTags.includes(tagInput.trim())) {
        const newTags = [...detailTags, tagInput.trim()]
        const newTagsStr = JSON.stringify(newTags)
        setTagInput("")
        setShowTagPopover(false)
        try {
          await safeInvoke("update_asset", {
            id: selectedAsset.id,
            tags: newTagsStr,
          })
          setAssetDetail({ ...detail, tags: newTagsStr })
          useAssetStore.getState().refreshTagsSummary()
          notifyAssetsRefresh()
        } catch (err) {
          console.error("Failed to update tags:", err)
        }
      }
    }
  }

  const handleAddTagDirect = async (tag: string) => {
    if (!detail || detailTags.includes(tag)) return
    const newTags = [...detailTags, tag]
    const newTagsStr = JSON.stringify(newTags)
    setTagInput("")
    setShowTagPopover(false)
    try {
      await safeInvoke("update_asset", {
        id: selectedAsset.id,
        tags: newTagsStr,
      })
      setAssetDetail({ ...detail, tags: newTagsStr })
      useAssetStore.getState().refreshTagsSummary()
      notifyAssetsRefresh()
    } catch (err) {
      console.error("Failed to update tags:", err)
    }
  }

  const handleRemoveTag = async (tagToRemove: string) => {
    if (!detail) return
    const newTags = detailTags.filter((t: string) => t !== tagToRemove)
    const newTagsStr = JSON.stringify(newTags)
    try {
      await safeInvoke("update_asset", {
        id: selectedAsset.id,
        tags: newTagsStr,
      })
      setAssetDetail({ ...detail, tags: newTagsStr })
      useAssetStore.getState().refreshTagsSummary()
      notifyAssetsRefresh()
    } catch (error) {
      console.error("Failed to update tags:", error)
    }
  }

  const handleToggleWorkspace = async (workspaceId: string) => {
    if (!detail) return
    let newWsIds: string[]

    if (detailWorkspaceIds.includes(workspaceId)) {
      newWsIds = detailWorkspaceIds.filter((id: string) => id !== workspaceId)
    } else {
      newWsIds = [...detailWorkspaceIds, workspaceId]
    }

    const newWsIdsStr = JSON.stringify(newWsIds)

    try {
      await safeInvoke("update_asset", {
        id: selectedAsset.id,
        workspaceIds: newWsIdsStr,
        workspace_ids: newWsIdsStr,
      })
      setAssetDetail({ ...detail, workspace_ids: newWsIdsStr })
      notifyAssetsRefresh()
    } catch (err) {
      console.error("Failed to update workspaces:", err)
    }
  }

  const handleSearchSimilar = async () => {
    setIsSearchingSimilar(true)
    try {
      const similarIds = await safeInvoke("find_similar_images", {
        targetId: selectedAsset.id,
        threshold: 15
      })
      if (Array.isArray(similarIds)) {
        setSimilarAssetIds(Array.from(new Set([selectedAsset.id, ...similarIds])))
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
                    const isAssigned = detailWorkspaceIds.includes(ws.id)
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
                  {detailTags.map((tag: string) => (
                    <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs rounded-md">
                      {tag}
                      <button onClick={() => handleRemoveTag(tag)} className="hover:text-red-500 transition-colors">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="relative">
                  <div className="flex items-center">
                    <Plus className="w-3.5 h-3.5 absolute left-2 text-zinc-400" />
                    <input
                      type="text"
                      value={tagInput}
                      onChange={(e) => {
                        setTagInput(e.target.value)
                        setShowTagPopover(true)
                      }}
                      onFocus={() => setShowTagPopover(true)}
                      onBlur={() => {
                        // Delay to allow click on suggestion items
                        setTimeout(() => setShowTagPopover(false), 150)
                      }}
                      onKeyDown={handleAddTag}
                      placeholder="输入标签后按回车"
                      className="w-full pl-7 pr-3 py-1.5 bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-md text-[13px] focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                  </div>
                  {showTagPopover && tagSuggestions.length > 0 && (
                    <div className="absolute z-50 left-0 right-0 mt-1 max-h-40 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg">
                      {tagSuggestions.slice(0, 8).map((suggestion) => (
                        <button
                          key={suggestion}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            handleAddTagDirect(suggestion)
                          }}
                          className="w-full flex items-center justify-between px-3 py-1.5 text-[13px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        >
                          <span>{suggestion}</span>
                          <span className="text-[11px] text-zinc-400">{tagsSummary[suggestion]}</span>
                        </button>
                      ))}
                    </div>
                  )}
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
                  {detail?.source_url && (
                    <a href={detail.source_url} target="_blank" rel="noreferrer" className="text-[13px] text-indigo-500 hover:underline flex items-start gap-1 group break-all">
                      <span className="line-clamp-3">
                        {detail.source_url}
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
                className={`w-3.5 h-3.5 ${(detail?.rating || selectedAsset.rating || 0) >= star ? "fill-yellow-400 text-yellow-400" : "hover:text-yellow-400"}`}
              />
            </button>
          ))}
        </div>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">尺寸</span>
                <span className="text-zinc-700 dark:text-zinc-300">
                  {(detail?.width && detail?.height)
                    ? `${detail.width}x${detail.height}`
                    : (selectedAsset.width && selectedAsset.height ? `${selectedAsset.width}x${selectedAsset.height}` : '-')}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">文件类型</span>
                <span className="text-zinc-700 dark:text-zinc-300">{selectedAsset.path.split('.').pop()?.toUpperCase() || selectedAsset.asset_type.toUpperCase()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">文件大小</span>
                <span className="text-zinc-700 dark:text-zinc-300">{formatSize(selectedAsset.size)}</span>
              </div>
              {detail?.duration && (
                <div className="flex justify-between">
                  <span className="text-zinc-500">时长</span>
                  <span className="text-zinc-700 dark:text-zinc-300">{Math.round(detail.duration)}s</span>
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
