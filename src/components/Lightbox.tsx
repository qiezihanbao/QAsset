import { useEffect, useCallback } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize } from "lucide-react"
import { convertFileSrc } from "@tauri-apps/api/core"
import { useAssetStore } from "@/store/useAssetStore"

export function Lightbox() {
  const { previewAsset, setPreviewAsset, isFullscreenPreview, setFullscreenPreview, assets } = useAssetStore()

  const navigate = useCallback((direction: number) => {
    if (!previewAsset) return
    const currentIndex = assets.findIndex(a => a.id === previewAsset.id)
    let newIndex = currentIndex + direction
    if (newIndex >= assets.length) newIndex = 0
    if (newIndex < 0) newIndex = assets.length - 1
    setPreviewAsset(assets[newIndex], true)
  }, [previewAsset, assets, setPreviewAsset])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!previewAsset || !isFullscreenPreview) return
      
      if (e.key === "Escape") {
        setFullscreenPreview(false)
      } else if (e.key === "ArrowRight") {
        navigate(1)
      } else if (e.key === "ArrowLeft") {
        navigate(-1)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [previewAsset, isFullscreenPreview, setFullscreenPreview, navigate])

  if (!previewAsset || !isFullscreenPreview) return null

  const currentIndex = assets.findIndex(a => a.id === previewAsset.id)

  // Prevent closing when clicking on the image itself
  const handleContentClick = (e: React.MouseEvent) => {
    e.stopPropagation()
  }

  return (
    <AnimatePresence>
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-sm"
        onClick={() => setFullscreenPreview(false)}
      >
        {/* Top Bar */}
        <div 
          className="absolute top-0 left-0 right-0 p-4 flex items-center justify-between text-white/70 bg-gradient-to-b from-black/50 to-transparent"
          onClick={handleContentClick}
        >
          <div className="text-sm truncate max-w-md">
            {currentIndex + 1} / {assets.length} - {previewAsset.name}
          </div>
          <div className="flex items-center gap-4">
            <button className="p-2 hover:text-white hover:bg-white/10 rounded-full transition-colors">
              <ZoomOut className="w-5 h-5" />
            </button>
            <button className="p-2 hover:text-white hover:bg-white/10 rounded-full transition-colors">
              <ZoomIn className="w-5 h-5" />
            </button>
            <button className="p-2 hover:text-white hover:bg-white/10 rounded-full transition-colors">
              <Maximize className="w-5 h-5" />
            </button>
            <div className="w-px h-6 bg-white/20 mx-2" />
            <button 
              onClick={() => setFullscreenPreview(false)}
              className="p-2 hover:text-white hover:bg-red-500/80 rounded-full transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Navigation Buttons */}
        <button 
          onClick={(e) => { e.stopPropagation(); navigate(-1) }}
          className="absolute left-4 p-3 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-colors"
        >
          <ChevronLeft className="w-8 h-8" />
        </button>

        <button 
          onClick={(e) => { e.stopPropagation(); navigate(1) }}
          className="absolute right-4 p-3 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-colors"
        >
          <ChevronRight className="w-8 h-8" />
        </button>

        {/* Content */}
        <motion.div 
          key={previewAsset.id}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="w-full h-full p-16 flex items-center justify-center"
          onClick={handleContentClick}
        >
          {previewAsset.asset_type === 'image' && previewAsset.thumbnail_base64 ? (
            <img 
              src={previewAsset.thumbnail_base64} 
              alt={previewAsset.name}
              className="max-w-full max-h-full object-contain drop-shadow-2xl rounded-sm"
            />
          ) : (
            <div className="text-white/50 flex flex-col items-center">
              <span className="text-6xl mb-4">📄</span>
              <p>不支持预览该文件格式</p>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
