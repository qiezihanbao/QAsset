import { useEffect, useCallback, useState, useRef, lazy, Suspense } from "react"
import { motion } from "framer-motion"
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCcw } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { useAssetStore } from "@/store/useAssetStore"
import { useShallow } from "zustand/react/shallow"
import { getViewerType } from "@/components/viewers/getViewerType"

const ImageViewer = lazy(() =>
  import("@/components/viewers/ImageViewer").then((m) => ({ default: m.ImageViewer }))
)
const GifViewer = lazy(() =>
  import("@/components/viewers/GifViewer").then((m) => ({ default: m.GifViewer }))
)
const PdfViewer = lazy(() =>
  import("@/components/viewers/PdfViewer").then((m) => ({ default: m.PdfViewer }))
)
const TextViewer = lazy(() =>
  import("@/components/viewers/TextViewer").then((m) => ({ default: m.TextViewer }))
)
const MarkdownViewer = lazy(() =>
  import("@/components/viewers/MarkdownViewer").then((m) => ({ default: m.MarkdownViewer }))
)
const VideoViewer = lazy(() =>
  import("@/components/viewers/VideoViewer").then((m) => ({ default: m.VideoViewer }))
)
const UnsupportedViewer = lazy(() =>
  import("@/components/viewers/UnsupportedViewer").then((m) => ({ default: m.UnsupportedViewer }))
)

const THUMBNAIL_FIRST_EXTENSIONS = new Set(['psd', 'psb', 'clip'])
const MIN_ZOOM = 0.5
const MAX_ZOOM = 10
const ZOOM_STEP = 0.25
const WHEEL_ZOOM_FACTOR = 0.001

function getFileExt(fileName: string): string {
  if (!fileName.includes('.')) return ''
  return fileName.split('.').pop()!.toLowerCase()
}

export function Lightbox() {
  const [
    previewAsset,
    setPreviewAsset,
    isFullscreenPreview,
    setFullscreenPreview,
    assets,
    updateAssetProperty,
    assetDetail,
    setAssetDetail,
  ] = useAssetStore(useShallow((s) => ([
    s.previewAsset,
    s.setPreviewAsset,
    s.isFullscreenPreview,
    s.setFullscreenPreview,
    s.assets,
    s.updateAssetProperty,
    s.assetDetail,
    s.setAssetDetail,
  ])))

  const [zoom, setZoom] = useState(1)
  const [displayScale, setDisplayScale] = useState(1)
  const [fullPreviewPath, setFullPreviewPath] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const previewFetchInFlightRef = useRef<string | null>(null)
  const openedAtRef = useRef(0)

  const resetTransform = useCallback(() => {
    setZoom(1)
  }, [])

  // Reset zoom when switching assets
  useEffect(() => {
    resetTransform()
    setDisplayScale(1)
  }, [previewAsset?.id, resetTransform])

  useEffect(() => {
    if (!isFullscreenPreview) {
      setFullPreviewPath(null)
      previewFetchInFlightRef.current = null
      return
    }
    openedAtRef.current = Date.now()
    setFullPreviewPath(null)
    previewFetchInFlightRef.current = null
  }, [previewAsset?.id, isFullscreenPreview])

  const handleBackdropClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Close only when clicking directly on backdrop, and ignore the first
    // short window after opening to avoid double-click open->immediate-close.
    if (e.target !== e.currentTarget) return
    if (Date.now() - openedAtRef.current < 220) return
    setFullscreenPreview(false)
  }, [setFullscreenPreview])

  // For PSD/CLIP: ensure we have thumbnail_path in fullscreen preview.
  useEffect(() => {
    if (!previewAsset || !isFullscreenPreview) return
    const ext = getFileExt(previewAsset.name)
    const needsTranscodedPreview = THUMBNAIL_FIRST_EXTENSIONS.has(ext)
    if (!needsTranscodedPreview) return
    if (fullPreviewPath) return
    if (previewFetchInFlightRef.current === previewAsset.id) return

    previewFetchInFlightRef.current = previewAsset.id
    invoke<string | null>('ensure_asset_full_preview', { id: previewAsset.id })
      .then((previewPath) => {
        if (previewPath) {
          setFullPreviewPath(previewPath)
          // Sync up-to-date dimensions after backend preview generation/cache hit.
          void invoke<{ width?: number; height?: number; thumbnail_path?: string }>('get_asset_detail', { id: previewAsset.id })
            .then((detail) => {
              const nextWidth = detail?.width
              const nextHeight = detail?.height
              if (nextWidth && nextHeight) {
                updateAssetProperty(previewAsset.id, { width: nextWidth, height: nextHeight })
                if (assetDetail?.id === previewAsset.id) {
                  setAssetDetail({ ...assetDetail, width: nextWidth, height: nextHeight })
                }
              }
            })
            .catch(() => {})
          return
        }

        // Fallback chain: try thumbnail, then detail.
        return invoke<string | null>('ensure_asset_thumbnail', { id: previewAsset.id })
          .then((thumbnailPath) => {
            if (thumbnailPath) {
              setPreviewAsset({ ...previewAsset, thumbnail_path: thumbnailPath }, true)
              return
            }
            return invoke<{ thumbnail_path?: string }>('get_asset_detail', { id: previewAsset.id })
          })
          .then((detail) => {
            if (detail?.thumbnail_path) {
              setPreviewAsset({ ...previewAsset, thumbnail_path: detail.thumbnail_path }, true)
            }
          })
      })
      .catch((err) => {
        console.warn('Failed to fetch thumbnail path for preview:', err)
      })
      .finally(() => {
        if (previewFetchInFlightRef.current === previewAsset.id) {
          previewFetchInFlightRef.current = null
        }
      })
  }, [previewAsset, isFullscreenPreview, setPreviewAsset, fullPreviewPath, updateAssetProperty, assetDetail, setAssetDetail])

  const navigate = useCallback((direction: number) => {
    if (!previewAsset) return
    const currentIndex = assets.findIndex(a => a.id === previewAsset.id)
    let newIndex = currentIndex + direction
    if (newIndex >= assets.length) newIndex = 0
    if (newIndex < 0) newIndex = assets.length - 1
    setPreviewAsset(assets[newIndex], true)
  }, [previewAsset, assets, setPreviewAsset])

  const handleZoomIn = useCallback(() => {
    setZoom(z => Math.min(z + ZOOM_STEP, MAX_ZOOM))
  }, [])

  const handleZoomOut = useCallback(() => {
    setZoom(z => Math.max(z - ZOOM_STEP, MIN_ZOOM))
  }, [])

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const delta = -e.deltaY * WHEEL_ZOOM_FACTOR
    setZoom(z => {
      const newZoom = Math.min(Math.max(z + z * delta, MIN_ZOOM), MAX_ZOOM)
      return newZoom
    })
  }, [])

  const viewerType = previewAsset ? getViewerType(previewAsset.name, previewAsset.asset_type) : null
  const isImageViewer = viewerType === 'image'

  // Mouse wheel zoom (only for image viewer)
  useEffect(() => {
    if (!previewAsset || !isFullscreenPreview || !isImageViewer) return
    const container = containerRef.current
    if (!container) return
    container.addEventListener("wheel", handleWheel, { passive: false })
    return () => container.removeEventListener("wheel", handleWheel)
  }, [previewAsset, isFullscreenPreview, handleWheel, isImageViewer])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!previewAsset || !isFullscreenPreview) return
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return

      if (e.key === "Escape") {
        e.preventDefault()
        setFullscreenPreview(false)
      } else if (e.key === "ArrowRight") {
        navigate(1)
      } else if (e.key === "ArrowLeft") {
        navigate(-1)
      } else if ((e.key === "+" || e.key === "=") && isImageViewer) {
        handleZoomIn()
      } else if (e.key === "-" && isImageViewer) {
        handleZoomOut()
      } else if (e.key === "0" && isImageViewer) {
        resetTransform()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [previewAsset, isFullscreenPreview, setFullscreenPreview, navigate, handleZoomIn, handleZoomOut, resetTransform, isImageViewer])

  if (!previewAsset || !isFullscreenPreview) return null

  const currentIndex = assets.findIndex(a => a.id === previewAsset.id)
  const zoomPercent = Math.round(displayScale * 100)
  const previewExt = getFileExt(previewAsset.name)
  const isGifViewer = viewerType === 'image' && previewExt === 'gif'
  const shouldPreferThumbnail = THUMBNAIL_FIRST_EXTENSIONS.has(previewExt) && !fullPreviewPath

  const renderViewer = () => {
    switch (viewerType) {
      case 'image':
        if (isGifViewer) {
          return (
            <GifViewer
              filePath={previewAsset.path}
              zoom={zoom}
              onZoomChange={setZoom}
              onDisplayScaleChange={(scale) => {
                setDisplayScale(prev => (Math.abs(prev - scale) < 0.001 ? prev : scale))
              }}
            />
          )
        }
        return (
          <ImageViewer
            filePath={fullPreviewPath || previewAsset.path}
            fileName={previewAsset.name}
            thumbnailPath={previewAsset.thumbnail_path}
            preferThumbnail={shouldPreferThumbnail}
            zoom={zoom}
            onZoomChange={setZoom}
            onDisplayScaleChange={(scale) => {
              setDisplayScale(prev => (Math.abs(prev - scale) < 0.001 ? prev : scale))
            }}
          />
        )
      case 'pdf':
        return <PdfViewer filePath={previewAsset.path} fileName={previewAsset.name} />
      case 'text':
        return <TextViewer filePath={previewAsset.path} fileName={previewAsset.name} />
      case 'markdown':
        return <MarkdownViewer filePath={previewAsset.path} fileName={previewAsset.name} />
      case 'video':
        return <VideoViewer filePath={previewAsset.path} fileName={previewAsset.name} />
      default:
        return (
          <UnsupportedViewer
            fileName={previewAsset.name}
            filePath={previewAsset.path}
            fileSize={previewAsset.size}
            assetType={previewAsset.asset_type}
          />
        )
    }
  }

  return (
    <motion.div
      ref={containerRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm select-none"
      onClick={handleBackdropClick}
    >
        {/* Top Bar */}
        <div
          className="absolute top-0 left-0 right-0 z-10 p-3 flex items-center justify-between text-white/70 bg-gradient-to-b from-black/50 to-transparent"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-sm truncate max-w-[50%]">
            {currentIndex + 1} / {assets.length} - {previewAsset.name}
          </div>
          <div className="flex items-center gap-1">
            {isImageViewer && (
              <>
                <span className="text-xs text-white/50 mr-2 w-12 text-center">{zoomPercent}%</span>
                <button
                  onClick={handleZoomOut}
                  className="p-1.5 hover:text-white hover:bg-white/10 rounded-full transition-colors"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                <button
                  onClick={handleZoomIn}
                  className="p-1.5 hover:text-white hover:bg-white/10 rounded-full transition-colors"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
                <button
                  onClick={resetTransform}
                  className="p-1.5 hover:text-white hover:bg-white/10 rounded-full transition-colors"
                  title="重置缩放"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
                <div className="w-px h-5 bg-white/20 mx-1" />
              </>
            )}
            <button
              onClick={() => setFullscreenPreview(false)}
              className="p-1.5 hover:text-white hover:bg-red-500/80 rounded-full transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Navigation Buttons */}
        <button
          onClick={(e) => { e.stopPropagation(); navigate(-1) }}
          className="absolute left-2 z-10 p-2 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-colors"
        >
          <ChevronLeft className="w-7 h-7" />
        </button>

        <button
          onClick={(e) => { e.stopPropagation(); navigate(1) }}
          className="absolute right-2 z-10 p-2 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-colors"
        >
          <ChevronRight className="w-7 h-7" />
        </button>

        {/* Content - Viewer Component */}
      <motion.div
        key={previewAsset.id}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="w-full h-full pt-12 pb-4 px-12 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
          <Suspense fallback={<div className="flex h-full items-center justify-center text-white/60">正在加载预览...</div>}>
            {renderViewer()}
          </Suspense>
      </motion.div>

        {/* Bottom hint */}
        {isImageViewer && zoom <= 1 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/30 text-xs">
            {isGifViewer ? "滚轮缩放 · 底部可切换 GIF 播放模式 · ESC 关闭" : "滚轮缩放 · 方向键切换 · ESC 关闭"}
          </div>
        )}
        {!isImageViewer && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/30 text-xs">
            方向键切换 · ESC 关闭
          </div>
        )}
    </motion.div>
  )
}
