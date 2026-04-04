import { convertFileSrc } from "@tauri-apps/api/core"
import { useEffect, useMemo, useRef, useState } from "react"
import type { AssetLite } from "@/store/useAssetStore"

type CanvasItemState = {
  x: number
  y: number
  scale: number
  flipX: 1 | -1
  flipY: 1 | -1
  groupId?: string
  zIndex: number
}

type ViewState = {
  panX: number
  panY: number
  zoom: number
}

type BoxSelectionState = {
  active: boolean
  startX: number
  startY: number
  currentX: number
  currentY: number
}

type PersistedCanvasState = {
  version: number
  view: ViewState
  layout: Record<string, CanvasItemState>
}

const THUMBNAIL_FIRST_EXTENSIONS = new Set(["psd", "psb", "clip"])
const CANVAS_STATE_VERSION = 1
const CANVAS_STORAGE_PREFIX = "quickasset.workspace-canvas"

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const isTauri = () => !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

function getFileExt(fileNameOrPath: string): string {
  if (!fileNameOrPath.includes(".")) return ""
  return fileNameOrPath.split(".").pop()!.toLowerCase()
}

function getCardImageSrc(asset: AssetLite): string | null {
  if (!isTauri()) return null
  if (asset.asset_type === "video") {
    return asset.thumbnail_path ? convertFileSrc(asset.thumbnail_path) : null
  }
  const ext = getFileExt(asset.name || asset.path)
  const preferThumbnail = THUMBNAIL_FIRST_EXTENSIONS.has(ext)
  const filePath = preferThumbnail ? (asset.thumbnail_path || asset.path) : asset.path
  return filePath ? convertFileSrc(filePath) : null
}

function getInitialPosition(index: number, baseSize: number) {
  const columns = 8
  const gapX = baseSize + 80
  const gapY = baseSize + 80
  const col = index % columns
  const row = Math.floor(index / columns)
  return {
    x: col * gapX,
    y: row * gapY,
  }
}

function getAssetDisplaySize(asset: AssetLite, baseSize: number) {
  if (asset.width && asset.height && asset.width > 0 && asset.height > 0) {
    const maxSide = Math.max(asset.width, asset.height)
    const factor = baseSize / maxSide
    return {
      width: Math.max(36, asset.width * factor),
      height: Math.max(36, asset.height * factor),
    }
  }
  return {
    width: baseSize,
    height: baseSize,
  }
}

type WorkspaceCanvasViewProps = {
  assets: AssetLite[]
  selectedAssetIds: string[]
  onSelectionChange: (ids: string[]) => void
  thumbnailSize: number
  onOpenPreview: (asset: AssetLite) => void
  persistenceKey: string
}

export function WorkspaceCanvasView({
  assets,
  selectedAssetIds,
  onSelectionChange,
  thumbnailSize,
  onOpenPreview,
  persistenceKey,
}: WorkspaceCanvasViewProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef<Record<string, CanvasItemState>>({})
  const loadedPersistenceKeyRef = useRef<string | null>(null)
  const zIndexCounterRef = useRef(10)
  const [view, setView] = useState<ViewState>({ panX: 0, panY: 0, zoom: 1 })
  const [layoutVersion, setLayoutVersion] = useState(0)
  const [initializedView, setInitializedView] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [isSpacePressed, setIsSpacePressed] = useState(false)
  const [boxSelection, setBoxSelection] = useState<BoxSelectionState | null>(null)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return
      }
      e.preventDefault()
      setIsSpacePressed(true)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return
      setIsSpacePressed(false)
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
    }
  }, [])

  useEffect(() => {
    if (!persistenceKey) return
    if (loadedPersistenceKeyRef.current === persistenceKey) return
    loadedPersistenceKeyRef.current = persistenceKey

    const storageKey = `${CANVAS_STORAGE_PREFIX}:${persistenceKey}`
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) {
        layoutRef.current = {}
        setInitializedView(false)
        setLayoutVersion((v) => v + 1)
        return
      }
      const parsed = JSON.parse(raw) as PersistedCanvasState
      if (parsed.version !== CANVAS_STATE_VERSION || !parsed.layout || !parsed.view) {
        layoutRef.current = {}
        setInitializedView(false)
        setLayoutVersion((v) => v + 1)
        return
      }
      layoutRef.current = parsed.layout
      const maxZ = Object.values(parsed.layout).reduce((m, item) => Math.max(m, item.zIndex || 0), 10)
      zIndexCounterRef.current = maxZ + 1
      setView(parsed.view)
      setInitializedView(true)
      setLayoutVersion((v) => v + 1)
    } catch {
      layoutRef.current = {}
      setInitializedView(false)
      setLayoutVersion((v) => v + 1)
    }
  }, [persistenceKey])

  useEffect(() => {
    let changed = false

    assets.forEach((asset, index) => {
      if (!layoutRef.current[asset.id]) {
        const pos = getInitialPosition(index, thumbnailSize)
        layoutRef.current[asset.id] = {
          x: pos.x,
          y: pos.y,
          scale: 1,
          flipX: 1,
          flipY: 1,
          zIndex: zIndexCounterRef.current++,
        }
        changed = true
      }
    })

    if (changed) {
      setLayoutVersion((v) => v + 1)
    }
  }, [assets, thumbnailSize])

  useEffect(() => {
    if (initializedView) return
    const viewport = viewportRef.current
    if (!viewport) return

    const rect = viewport.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    setView({
      panX: rect.width * 0.5 - thumbnailSize * 0.5,
      panY: rect.height * 0.5 - thumbnailSize * 0.5,
      zoom: 1,
    })
    setInitializedView(true)
  }, [initializedView, thumbnailSize])

  useEffect(() => {
    if (!persistenceKey) return
    const storageKey = `${CANVAS_STORAGE_PREFIX}:${persistenceKey}`
    const timer = window.setTimeout(() => {
      const payload: PersistedCanvasState = {
        version: CANVAS_STATE_VERSION,
        view,
        layout: layoutRef.current,
      }
      try {
        localStorage.setItem(storageKey, JSON.stringify(payload))
      } catch {
        // no-op
      }
    }, 120)

    return () => window.clearTimeout(timer)
  }, [persistenceKey, layoutVersion, view])

  const selectedSet = useMemo(() => new Set(selectedAssetIds), [selectedAssetIds])

  const gridStyle = useMemo(() => {
    const minor = clamp(36 * view.zoom, 14, 90)
    const major = minor * 5
    return {
      backgroundImage: `
        linear-gradient(to right, rgba(113,113,122,0.10) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(113,113,122,0.10) 1px, transparent 1px),
        linear-gradient(to right, rgba(99,102,241,0.16) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(99,102,241,0.16) 1px, transparent 1px)
      `,
      backgroundSize: `${minor}px ${minor}px, ${minor}px ${minor}px, ${major}px ${major}px, ${major}px ${major}px`,
      backgroundPosition: `${view.panX}px ${view.panY}px, ${view.panX}px ${view.panY}px, ${view.panX}px ${view.panY}px, ${view.panX}px ${view.panY}px`,
    }
  }, [view.panX, view.panY, view.zoom])

  const patchItems = (ids: string[], updater: (item: CanvasItemState) => CanvasItemState) => {
    let changed = false
    ids.forEach((id) => {
      const current = layoutRef.current[id]
      if (!current) return
      layoutRef.current[id] = updater(current)
      changed = true
    })
    if (changed) {
      setLayoutVersion((v) => v + 1)
    }
  }

  const liftItems = (ids: string[]) => {
    ids.forEach((id) => {
      const item = layoutRef.current[id]
      if (!item) return
      item.zIndex = zIndexCounterRef.current++
    })
    setLayoutVersion((v) => v + 1)
  }

  const beginPanDrag = (startEvent: React.PointerEvent<HTMLDivElement>) => {
    startEvent.preventDefault()
    const start = { x: startEvent.clientX, y: startEvent.clientY, panX: view.panX, panY: view.panY }
    setIsPanning(true)

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      setView((prev) => ({
        ...prev,
        panX: start.panX + dx,
        panY: start.panY + dy,
      }))
    }

    const onUp = () => {
      setIsPanning(false)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  const beginBoxSelection = (startEvent: React.PointerEvent<HTMLDivElement>) => {
    startEvent.preventDefault()
    const viewport = viewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const startX = startEvent.clientX - rect.left
    const startY = startEvent.clientY - rect.top
    setBoxSelection({
      active: true,
      startX,
      startY,
      currentX: startX,
      currentY: startY,
    })

    const onMove = (e: PointerEvent) => {
      setBoxSelection((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          currentX: e.clientX - rect.left,
          currentY: e.clientY - rect.top,
        }
      })
    }

    const onUp = (e: PointerEvent) => {
      setBoxSelection((prev) => {
        if (!prev) return null

        const x1 = Math.min(prev.startX, prev.currentX)
        const x2 = Math.max(prev.startX, prev.currentX)
        const y1 = Math.min(prev.startY, prev.currentY)
        const y2 = Math.max(prev.startY, prev.currentY)
        const moved = Math.abs(prev.currentX - prev.startX) + Math.abs(prev.currentY - prev.startY) > 4

        if (!moved) {
          if (!(e.shiftKey || e.ctrlKey || e.metaKey)) {
            onSelectionChange([])
          }
          return null
        }

        const selectedByBox = assets
          .filter((asset) => {
            const item = layoutRef.current[asset.id]
            if (!item) return false
            const size = getAssetDisplaySize(asset, thumbnailSize)
            const halfW = (size.width * Math.abs(item.scale) * view.zoom) / 2
            const halfH = (size.height * Math.abs(item.scale) * view.zoom) / 2
            const centerX = view.panX + item.x * view.zoom
            const centerY = view.panY + item.y * view.zoom
            const left = centerX - halfW
            const right = centerX + halfW
            const top = centerY - halfH
            const bottom = centerY + halfH
            return right >= x1 && left <= x2 && bottom >= y1 && top <= y2
          })
          .map((asset) => asset.id)

        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          onSelectionChange(Array.from(new Set([...selectedAssetIds, ...selectedByBox])))
        } else {
          onSelectionChange(selectedByBox)
        }
        return null
      })

      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  const beginItemDrag = (dragIds: string[], startEvent: React.PointerEvent<HTMLButtonElement>) => {
    liftItems(dragIds)
    const startPoint = { x: startEvent.clientX, y: startEvent.clientY }
    const startZoom = view.zoom
    const startPositions = new Map<string, { x: number; y: number }>()

    dragIds.forEach((id) => {
      const item = layoutRef.current[id]
      if (!item) return
      startPositions.set(id, { x: item.x, y: item.y })
    })

    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startPoint.x) / startZoom
      const dy = (e.clientY - startPoint.y) / startZoom
      dragIds.forEach((id) => {
        const startPos = startPositions.get(id)
        const current = layoutRef.current[id]
        if (!startPos || !current) return
        current.x = startPos.x + dx
        current.y = startPos.y + dy
      })
      setLayoutVersion((v) => v + 1)
    }

    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    if (e.target !== e.currentTarget) return
    if (e.button === 1 || isSpacePressed) {
      beginPanDrag(e)
      return
    }
    beginBoxSelection(e)
  }

  const handleCanvasWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const viewport = viewportRef.current
    if (!viewport) return

    const rect = viewport.getBoundingClientRect()
    const pointerX = e.clientX - rect.left
    const pointerY = e.clientY - rect.top
    const zoomFactor = Math.exp(-e.deltaY * 0.0015)

    setView((prev) => {
      const nextZoom = clamp(prev.zoom * zoomFactor, 0.2, 4)
      const worldX = (pointerX - prev.panX) / prev.zoom
      const worldY = (pointerY - prev.panY) / prev.zoom
      return {
        panX: pointerX - worldX * nextZoom,
        panY: pointerY - worldY * nextZoom,
        zoom: nextZoom,
      }
    })
  }

  const applyScaleToSelection = (delta: number) => {
    if (selectedAssetIds.length === 0) return
    patchItems(selectedAssetIds, (item) => ({
      ...item,
      scale: clamp(item.scale + delta, 0.2, 4),
    }))
  }

  const applyFlip = (axis: "x" | "y") => {
    if (selectedAssetIds.length === 0) return
    patchItems(selectedAssetIds, (item) => ({
      ...item,
      flipX: axis === "x" ? (item.flipX === 1 ? -1 : 1) : item.flipX,
      flipY: axis === "y" ? (item.flipY === 1 ? -1 : 1) : item.flipY,
    }))
  }

  const groupSelection = () => {
    if (selectedAssetIds.length < 2) return
    const groupId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    patchItems(selectedAssetIds, (item) => ({
      ...item,
      groupId,
    }))
  }

  const ungroupSelection = () => {
    if (selectedAssetIds.length === 0) return
    patchItems(selectedAssetIds, (item) => ({
      ...item,
      groupId: undefined,
    }))
  }

  const autoLayout = () => {
    assets.forEach((asset, index) => {
      const pos = getInitialPosition(index, thumbnailSize)
      const current = layoutRef.current[asset.id]
      if (!current) return
      current.x = pos.x
      current.y = pos.y
    })
    setLayoutVersion((v) => v + 1)
  }

  const resetView = () => {
    const viewport = viewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    setView({
      panX: rect.width * 0.5 - thumbnailSize * 0.5,
      panY: rect.height * 0.5 - thumbnailSize * 0.5,
      zoom: 1,
    })
  }

  if (assets.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center text-zinc-500">
        当前筛选条件下没有可显示资源
      </div>
    )
  }

  return (
    <div
      ref={viewportRef}
      className={`relative h-full w-full overflow-hidden ${
        isPanning ? "cursor-grabbing" : isSpacePressed ? "cursor-grab" : "cursor-crosshair"
      }`}
      onPointerDown={handleCanvasPointerDown}
      onWheel={handleCanvasWheel}
    >
      <div className="absolute inset-0 pointer-events-none" style={gridStyle} />

      <div className="absolute left-3 top-3 z-30 flex flex-wrap items-center gap-1 rounded-lg border border-zinc-200/80 bg-white/90 px-2 py-1 text-xs text-zinc-700 shadow-sm backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-200">
        <button
          onClick={() => applyScaleToSelection(0.1)}
          disabled={selectedAssetIds.length === 0}
          className="rounded px-2 py-1 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          放大
        </button>
        <button
          onClick={() => applyScaleToSelection(-0.1)}
          disabled={selectedAssetIds.length === 0}
          className="rounded px-2 py-1 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          缩小
        </button>
        <button
          onClick={() => applyFlip("x")}
          disabled={selectedAssetIds.length === 0}
          className="rounded px-2 py-1 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          左右翻转
        </button>
        <button
          onClick={() => applyFlip("y")}
          disabled={selectedAssetIds.length === 0}
          className="rounded px-2 py-1 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          上下翻转
        </button>
        <button
          onClick={groupSelection}
          disabled={selectedAssetIds.length < 2}
          className="rounded px-2 py-1 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          打组
        </button>
        <button
          onClick={ungroupSelection}
          disabled={selectedAssetIds.length === 0}
          className="rounded px-2 py-1 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          解组
        </button>
        <button
          onClick={autoLayout}
          className="rounded px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          平铺整理
        </button>
        <button
          onClick={resetView}
          className="rounded px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          视图复位
        </button>
      </div>

      <div
        className="absolute inset-0 will-change-transform"
        style={{
          transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
          transformOrigin: "0 0",
        }}
      >
        {assets.map((asset) => {
          const item = layoutRef.current[asset.id]
          if (!item) return null
          const isSelected = selectedSet.has(asset.id)
          const imageSrc = getCardImageSrc(asset)
          const hasVisualPreview = !!imageSrc
          const groupBadge = item.groupId ? item.groupId.slice(-4) : null
          const size = getAssetDisplaySize(asset, thumbnailSize)

          return (
            <button
              key={asset.id}
              type="button"
              className={`absolute select-none ${
                isSelected
                  ? "ring-2 ring-indigo-500/70"
                  : "hover:drop-shadow-[0_6px_20px_rgba(0,0,0,0.25)]"
              }`}
              style={{
                left: item.x,
                top: item.y,
                width: size.width,
                height: size.height,
                zIndex: item.zIndex,
                transform: `translate(-50%, -50%) scale(${item.scale * item.flipX}, ${item.scale * item.flipY})`,
                transformOrigin: "center center",
              }}
              onDoubleClick={() => onOpenPreview(asset)}
              onWheel={(e) => {
                if (!e.altKey) return
                e.preventDefault()
                e.stopPropagation()
                const ids = selectedSet.has(asset.id) ? selectedAssetIds : [asset.id]
                const delta = e.deltaY < 0 ? 0.1 : -0.1
                patchItems(ids, (current) => ({
                  ...current,
                  scale: clamp(current.scale + delta, 0.2, 4),
                }))
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                if (isSpacePressed) return
                e.preventDefault()
                e.stopPropagation()

                let nextSelection = selectedAssetIds
                if (e.ctrlKey || e.metaKey) {
                  if (selectedSet.has(asset.id)) {
                    nextSelection = selectedAssetIds.filter((id) => id !== asset.id)
                  } else {
                    nextSelection = [...selectedAssetIds, asset.id]
                  }
                  onSelectionChange(nextSelection)
                  return
                }

                if (e.shiftKey) {
                  if (!selectedSet.has(asset.id)) {
                    nextSelection = [...selectedAssetIds, asset.id]
                    onSelectionChange(nextSelection)
                  }
                } else if (!selectedSet.has(asset.id) || selectedAssetIds.length > 1) {
                  nextSelection = [asset.id]
                  onSelectionChange(nextSelection)
                }

                const groupId = layoutRef.current[asset.id]?.groupId
                const dragIds = groupId
                  ? Array.from(
                      new Set([
                        ...nextSelection,
                        ...assets
                          .filter((a) => layoutRef.current[a.id]?.groupId === groupId)
                          .map((a) => a.id),
                      ])
                    )
                  : nextSelection

                beginItemDrag(dragIds, e)
              }}
            >
              {hasVisualPreview ? (
                <img
                  src={imageSrc}
                  alt={asset.name}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center rounded bg-zinc-100 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                  {asset.asset_type.toUpperCase()}
                </div>
              )}
              {groupBadge && (
                <span className="pointer-events-none absolute right-1 top-1 rounded bg-indigo-500/90 px-1 py-0.5 text-[10px] text-white">
                  G-{groupBadge}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {boxSelection?.active && (
        <div
          className="pointer-events-none absolute z-40 border border-indigo-500/90 bg-indigo-400/15"
          style={{
            left: Math.min(boxSelection.startX, boxSelection.currentX),
            top: Math.min(boxSelection.startY, boxSelection.currentY),
            width: Math.abs(boxSelection.currentX - boxSelection.startX),
            height: Math.abs(boxSelection.currentY - boxSelection.startY),
          }}
        />
      )}

      <div className="absolute bottom-3 right-3 rounded-md bg-zinc-900/80 px-2 py-1 text-[11px] text-zinc-100">
        画布缩放 {Math.round(view.zoom * 100)}% | 空格+拖拽平移 | 拖拽框选 | Alt+滚轮缩放选中项
      </div>
    </div>
  )
}
