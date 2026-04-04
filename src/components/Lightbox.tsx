import { useEffect, useCallback, useState, useRef } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCcw } from "lucide-react"
import { useAssetStore } from "@/store/useAssetStore"
import { getViewerType } from "@/components/viewers/getViewerType"
import { ImageViewer, MIN_ZOOM, MAX_ZOOM, ZOOM_STEP, WHEEL_ZOOM_FACTOR } from "@/components/viewers/ImageViewer"
import { PdfViewer } from "@/components/viewers/PdfViewer"
import { TextViewer } from "@/components/viewers/TextViewer"
import { MarkdownViewer } from "@/components/viewers/MarkdownViewer"
import { UnsupportedViewer } from "@/components/viewers/UnsupportedViewer"

export function Lightbox() {
  const { previewAsset, setPreviewAsset, isFullscreenPreview, setFullscreenPreview, assets } = useAssetStore()

  const [zoom, setZoom] = useState(1)
  const containerRef = useRef<HTMLDivElement>(null)

  const resetTransform = useCallback(() => {
    setZoom(1)
  }, [])

  // Reset zoom when switching assets
  useEffect(() => {
    resetTransform()
  }, [previewAsset?.id, resetTransform])

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
  const zoomPercent = Math.round(zoom * 100)

  const renderViewer = () => {
    switch (viewerType) {
      case 'image':
        return (
          <ImageViewer
            filePath={previewAsset.path}
            thumbnailBase64={previewAsset.thumbnail_base64}
            zoom={zoom}
            onZoomChange={setZoom}
          />
        )
      case 'pdf':
        return <PdfViewer filePath={previewAsset.path} fileName={previewAsset.name} />
      case 'text':
        return <TextViewer filePath={previewAsset.path} fileName={previewAsset.name} />
      case 'markdown':
        return <MarkdownViewer filePath={previewAsset.path} fileName={previewAsset.name} />
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
    <AnimatePresence>
      <motion.div
        ref={containerRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm select-none"
        onClick={() => setFullscreenPreview(false)}
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
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="w-full h-full pt-12 pb-4 px-12 overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {renderViewer()}
        </motion.div>

        {/* Bottom hint */}
        {isImageViewer && zoom <= 1 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/30 text-xs">
            滚轮缩放 · 方向键切换 · ESC 关闭
          </div>
        )}
        {!isImageViewer && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/30 text-xs">
            方向键切换 · ESC 关闭
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  )
}
