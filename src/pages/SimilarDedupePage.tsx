import { invoke, convertFileSrc } from "@tauri-apps/api/core"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Sparkles, RefreshCw, Wand2, Trash2, Eye, FolderOpen } from "lucide-react"
import { useAssetStore, type AssetLite } from "@/store/useAssetStore"

interface SimilarAssetItem {
  id: string
  name: string
  path: string
  relative_path: string
  size: number
  width?: number | null
  height?: number | null
  created_at: number
  modified_at: number
  rating?: number | null
  thumbnail_path?: string | null
}

interface SimilarGroup {
  group_id: string
  members: SimilarAssetItem[]
  suggested_keep_id: string
  suggested_delete_ids: string[]
  reclaimable_size: number
}

interface SimilarGroupsResult {
  threshold: number
  total_images_scanned: number
  groups_count: number
  duplicate_assets_count: number
  reclaimable_size: number
  groups: SimilarGroup[]
}

interface SimilarApplyResult {
  deleted_count: number
  failed_ids: string[]
}

interface ManualGroupSelection {
  keepId: string
  deleteIds: string[]
}

const DEFAULT_THRESHOLD = 10
const MAX_GROUPS = 400

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(2)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(2)} GB`
}

function previewSrc(item: SimilarAssetItem): string | null {
  const source = item.thumbnail_path || item.path
  return source ? convertFileSrc(source) : null
}

function buildInitialSelections(groups: SimilarGroup[]): Record<string, ManualGroupSelection> {
  const next: Record<string, ManualGroupSelection> = {}
  for (const group of groups) {
    next[group.group_id] = {
      keepId: group.suggested_keep_id,
      deleteIds: [...group.suggested_delete_ids],
    }
  }
  return next
}

function uniqueNonEmpty(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

export function SimilarDedupePage() {
  const setPreviewAsset = useAssetStore((s) => s.setPreviewAsset)
  const currentLibraryPath = useAssetStore((s) => s.currentLibraryPath)

  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD)
  const [scanResult, setScanResult] = useState<SimilarGroupsResult | null>(null)
  const [manualSelections, setManualSelections] = useState<Record<string, ManualGroupSelection>>({})
  const [isScanning, setIsScanning] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [lastScanAt, setLastScanAt] = useState<number | null>(null)

  const runScan = useCallback(async () => {
    if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return
    setIsScanning(true)
    try {
      const result = await invoke<SimilarGroupsResult>("find_similar_groups", {
        threshold,
        maxGroups: MAX_GROUPS,
        max_groups: MAX_GROUPS,
      })
      setScanResult(result)
      setManualSelections(buildInitialSelections(result.groups))
      setLastScanAt(Date.now())
    } catch (err) {
      console.error("Failed to scan similar groups:", err)
      alert(`相似图扫描失败: ${err}`)
    } finally {
      setIsScanning(false)
    }
  }, [threshold])

  useEffect(() => {
    if (!currentLibraryPath) {
      setScanResult(null)
      setManualSelections({})
      return
    }
    void runScan()
  }, [currentLibraryPath, runScan])

  const applyDeleteIds = useCallback(async (deleteIds: string[], confirmLabel: string) => {
    const normalized = uniqueNonEmpty(deleteIds)
    if (normalized.length === 0) {
      alert("没有可删除的重复项。")
      return
    }

    const ok = window.confirm(`将永久删除 ${normalized.length} 个重复文件（${confirmLabel}），并同步移除数据库记录。确认继续？`)
    if (!ok) return

    setIsApplying(true)
    try {
      const result = await invoke<SimilarApplyResult>("apply_similar_dedupe", {
        deleteIds: normalized,
        delete_ids: normalized,
        deleteFiles: true,
        delete_files: true,
      })

      if (result.failed_ids.length > 0) {
        alert(`已删除 ${result.deleted_count} 个，失败 ${result.failed_ids.length} 个。`)
      } else {
        alert(`已删除 ${result.deleted_count} 个重复资产。`)
      }

      window.dispatchEvent(new Event("quickasset:refresh-assets"))
      await runScan()
    } catch (err) {
      console.error("Failed to apply similar dedupe:", err)
      alert(`执行去重失败: ${err}`)
    } finally {
      setIsApplying(false)
    }
  }, [runScan])

  const handleSetKeep = useCallback((groupId: string, keepId: string) => {
    setManualSelections((prev) => {
      const current = prev[groupId]
      if (!current) return prev
      return {
        ...prev,
        [groupId]: {
          keepId,
          deleteIds: current.deleteIds.filter((id) => id !== keepId),
        },
      }
    })
  }, [])

  const handleToggleDelete = useCallback((groupId: string, assetId: string) => {
    setManualSelections((prev) => {
      const current = prev[groupId]
      if (!current || current.keepId === assetId) return prev
      const nextSet = new Set(current.deleteIds)
      if (nextSet.has(assetId)) {
        nextSet.delete(assetId)
      } else {
        nextSet.add(assetId)
      }
      return {
        ...prev,
        [groupId]: {
          ...current,
          deleteIds: Array.from(nextSet),
        },
      }
    })
  }, [])

  const resetGroupToSuggested = useCallback((group: SimilarGroup) => {
    setManualSelections((prev) => ({
      ...prev,
      [group.group_id]: {
        keepId: group.suggested_keep_id,
        deleteIds: [...group.suggested_delete_ids],
      },
    }))
  }, [])

  const manualDeleteIdsAll = useMemo(() => {
    if (!scanResult) return []
    const ids: string[] = []
    for (const group of scanResult.groups) {
      const selection = manualSelections[group.group_id]
      if (!selection) continue
      for (const id of selection.deleteIds) {
        if (id !== selection.keepId) ids.push(id)
      }
    }
    return uniqueNonEmpty(ids)
  }, [manualSelections, scanResult])

  const suggestedDeleteIdsAll = useMemo(() => {
    if (!scanResult) return []
    return uniqueNonEmpty(scanResult.groups.flatMap((g) => g.suggested_delete_ids))
  }, [scanResult])

  const openPreview = useCallback((item: SimilarAssetItem) => {
    const previewAsset: AssetLite = {
      id: item.id,
      name: item.name,
      path: item.path,
      asset_type: "image",
      size: item.size,
      thumbnail_path: item.thumbnail_path || undefined,
      width: item.width || undefined,
      height: item.height || undefined,
      created_at: item.created_at,
      modified_at: item.modified_at,
      rating: item.rating || undefined,
      is_trashed: false,
    }
    setPreviewAsset(previewAsset, true)
  }, [setPreviewAsset])

  const openInFolder = useCallback(async (path: string) => {
    try {
      await invoke("show_in_folder", { path })
    } catch (err) {
      console.error("Failed to show in folder:", err)
    }
  }, [])

  return (
    <div className="flex h-full flex-col bg-white dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-500" />
            <h2 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">相似图处理</h2>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            全库扫描后分组，自动给出“建议保留图”，可手动调整再批量去重。
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-zinc-500">
            阈值
            <input
              type="range"
              min={4}
              max={20}
              step={1}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="w-24"
              disabled={isScanning || isApplying}
            />
            <span className="w-6 text-right tabular-nums text-zinc-700 dark:text-zinc-200">{threshold}</span>
          </label>
          <button
            onClick={() => void runScan()}
            disabled={isScanning || isApplying}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isScanning ? "animate-spin" : ""}`} />
            重新扫描
          </button>
          <button
            onClick={() => void applyDeleteIds(suggestedDeleteIdsAll, "智能建议")}
            disabled={isScanning || isApplying || suggestedDeleteIdsAll.length === 0}
            className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
          >
            <Wand2 className="h-3.5 w-3.5" />
            智能一键去重
          </button>
          <button
            onClick={() => void applyDeleteIds(manualDeleteIdsAll, "手动选择")}
            disabled={isScanning || isApplying || manualDeleteIdsAll.length === 0}
            className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1.5 text-xs text-white transition-colors hover:bg-rose-500 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            应用手动选择
          </button>
        </div>
      </div>

      <div className="border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
        {scanResult ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <span>扫描图像: {scanResult.total_images_scanned}</span>
            <span>相似组: {scanResult.groups_count}</span>
            <span>建议去重数: {scanResult.duplicate_assets_count}</span>
            <span>可回收: {formatFileSize(scanResult.reclaimable_size)}</span>
            <span>阈值: {scanResult.threshold}</span>
            {lastScanAt && <span>最近扫描: {new Date(lastScanAt).toLocaleTimeString()}</span>}
          </div>
        ) : (
          <span>尚未扫描相似图。</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {isScanning && (
          <div className="mb-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-300">
            正在扫描相似图，请稍候...
          </div>
        )}

        {!isScanning && scanResult && scanResult.groups.length === 0 && (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-6 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300">
            当前未发现相似图分组。可适当提高阈值后重试。
          </div>
        )}

        {scanResult?.groups.map((group) => {
          const selection = manualSelections[group.group_id] ?? {
            keepId: group.suggested_keep_id,
            deleteIds: group.suggested_delete_ids,
          }
          const deleteSet = new Set(selection.deleteIds.filter((id) => id !== selection.keepId))

          return (
            <section key={group.group_id} className="mb-4 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/30">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    相似组 {group.group_id.replace("group-", "#")}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {group.members.length} 张图 · 预计可回收 {formatFileSize(group.reclaimable_size)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => resetGroupToSuggested(group)}
                    className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    恢复智能建议
                  </button>
                  <button
                    onClick={() => {
                      const ids = selection.deleteIds.filter((id) => id !== selection.keepId)
                      void applyDeleteIds(ids, `${group.group_id} 本组`)
                    }}
                    disabled={isApplying || selection.deleteIds.length === 0}
                    className="rounded-md bg-rose-600 px-2 py-1 text-xs text-white hover:bg-rose-500 disabled:opacity-50"
                  >
                    应用本组
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {group.members.map((member) => {
                  const isKeep = selection.keepId === member.id
                  const markedDelete = deleteSet.has(member.id)
                  const imgSrc = previewSrc(member)
                  return (
                    <article
                      key={member.id}
                      className={`rounded-lg border p-2 ${
                        isKeep
                          ? "border-emerald-400 bg-emerald-50/70 dark:border-emerald-600 dark:bg-emerald-900/20"
                          : markedDelete
                            ? "border-rose-300 bg-rose-50/70 dark:border-rose-700 dark:bg-rose-900/20"
                            : "border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/40"
                      }`}
                    >
                      <div className="mb-2 flex aspect-video items-center justify-center overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-900">
                        {imgSrc ? (
                          <img src={imgSrc} alt={member.name} className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-xs text-zinc-400">无预览</span>
                        )}
                      </div>
                      <div className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100" title={member.name}>
                        {member.name}
                      </div>
                      <div className="mt-1 text-[11px] text-zinc-500">
                        {formatFileSize(member.size)}
                        {member.width && member.height ? ` · ${member.width}×${member.height}` : ""}
                      </div>

                      <div className="mt-2 flex items-center justify-between gap-2">
                        <label className="flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-300">
                          <input
                            type="radio"
                            name={`keep-${group.group_id}`}
                            checked={isKeep}
                            onChange={() => handleSetKeep(group.group_id, member.id)}
                          />
                          保留
                        </label>
                        <label className="flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-300">
                          <input
                            type="checkbox"
                            checked={markedDelete}
                            disabled={isKeep}
                            onChange={() => handleToggleDelete(group.group_id, member.id)}
                          />
                          删除
                        </label>
                        <button
                          onClick={() => openPreview(member)}
                          className="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                          title="预览"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => void openInFolder(member.path)}
                          className="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                          title="定位到文件"
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
