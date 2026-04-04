// src/components/viewers/ImageViewer.tsx
import { useState, useCallback, useRef, useEffect } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"

const MIN_ZOOM = 0.5
const MAX_ZOOM = 10
const ZOOM_STEP = 0.25
const WHEEL_ZOOM_FACTOR = 0.001

interface ImageViewerProps {
  filePath: string
  fileName?: string
  thumbnailPath?: string
  thumbnailBase64?: string
  preferThumbnail?: boolean
  zoom: number
  onZoomChange: (zoom: number) => void
}

const THUMBNAIL_FIRST_EXTENSIONS = new Set(['psd', 'psb', 'clip'])

function getFileExt(fileNameOrPath: string): string {
  if (!fileNameOrPath.includes('.')) return ''
  return fileNameOrPath.split('.').pop()!.toLowerCase()
}

export function ImageViewer({ filePath, fileName, thumbnailPath, thumbnailBase64, preferThumbnail, zoom, onZoomChange }: ImageViewerProps) {
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [imgError, setImgError] = useState(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const panStart = useRef({ x: 0, y: 0 })

  const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
  const ext = getFileExt(fileName || filePath)
  const shouldPreferThumbnail = preferThumbnail ?? THUMBNAIL_FIRST_EXTENSIONS.has(ext)

  useEffect(() => {
    setImgError(false)
  }, [filePath, thumbnailPath])

  let imageSrc: string | null = null
  if (isTauri) {
    const directSrc = convertFileSrc(filePath)
    const thumbSrc = thumbnailPath ? convertFileSrc(thumbnailPath) : null
    const primarySrc = shouldPreferThumbnail && thumbSrc ? thumbSrc : directSrc
    const secondarySrc = shouldPreferThumbnail && thumbSrc ? directSrc : thumbSrc
    imageSrc = imgError ? secondarySrc : primarySrc
  } else if (thumbnailBase64) {
    imageSrc = thumbnailBase64
  }

  // Reset pan when zoom drops to 1 or below
  // (preserving behavior from original Lightbox)
  const prevZoomRef = useRef(zoom)
  if (prevZoomRef.current > 1 && zoom <= 1) {
    setPan({ x: 0, y: 0 })
  }
  prevZoomRef.current = zoom

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1) return
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current = { ...pan }
  }, [zoom, pan])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    setPan({
      x: panStart.current.x + dx,
      y: panStart.current.y + dy,
    })
  }, [isDragging])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  if (!imageSrc) {
    return (
      <div className="text-white/50 flex flex-col items-center justify-center h-full">
        <span className="text-6xl mb-4">📄</span>
        <p>无法加载图片</p>
      </div>
    )
  }

  return (
    <div
      className="w-full h-full flex items-center justify-center overflow-hidden"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
    >
      <img
        src={imageSrc}
        alt=""
        className="max-w-full max-h-full object-contain drop-shadow-2xl rounded-sm pointer-events-none"
        draggable={false}
        onError={() => setImgError(true)}
        style={{
          transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
          transition: isDragging ? 'none' : 'transform 0.1s ease-out',
        }}
      />
    </div>
  )
}

export { MIN_ZOOM, MAX_ZOOM, ZOOM_STEP, WHEEL_ZOOM_FACTOR }
