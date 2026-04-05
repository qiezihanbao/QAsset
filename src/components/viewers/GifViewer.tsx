import { useState, useCallback, useRef, useEffect, useMemo } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import { decompressFrames, parseGIF } from "gifuct-js"

interface GifViewerProps {
  filePath: string
  zoom: number
  onZoomChange: (zoom: number) => void
  onDisplayScaleChange?: (scale: number) => void
}

type GifPlayMode = "once" | "loop" | "frame"

interface DecodedFrame {
  imageData: ImageData
  delayMs: number
}

function clampDelay(delayCentiseconds?: number): number {
  const value = (delayCentiseconds ?? 10) * 10
  return Math.max(20, value)
}

function decodeGifFrames(arrayBuffer: ArrayBuffer): { width: number; height: number; frames: DecodedFrame[] } {
  const gif = parseGIF(arrayBuffer)
  const width = gif?.lsd?.width || 0
  const height = gif?.lsd?.height || 0
  const decompressed = decompressFrames(gif, true) as Array<{
    patch: Uint8ClampedArray
    delay?: number
    disposalType?: number
    dims: { top: number; left: number; width: number; height: number }
  }>

  if (!width || !height || decompressed.length === 0) {
    return { width, height, frames: [] }
  }

  const workCanvas = document.createElement("canvas")
  workCanvas.width = width
  workCanvas.height = height
  const workCtx = workCanvas.getContext("2d", { willReadFrequently: true })
  if (!workCtx) {
    return { width, height, frames: [] }
  }

  const frames: DecodedFrame[] = []
  workCtx.clearRect(0, 0, width, height)

  for (const frame of decompressed) {
    const { top, left, width: frameWidth, height: frameHeight } = frame.dims
    const restoreArea =
      frame.disposalType === 3 ? workCtx.getImageData(left, top, frameWidth, frameHeight) : null

    const patchData = new ImageData(new Uint8ClampedArray(frame.patch), frameWidth, frameHeight)
    workCtx.putImageData(patchData, left, top)

    frames.push({
      imageData: workCtx.getImageData(0, 0, width, height),
      delayMs: clampDelay(frame.delay),
    })

    if (frame.disposalType === 2) {
      workCtx.clearRect(left, top, frameWidth, frameHeight)
    } else if (frame.disposalType === 3 && restoreArea) {
      workCtx.putImageData(restoreArea, left, top)
    }
  }

  return { width, height, frames }
}

export function GifViewer({ filePath, zoom, onZoomChange, onDisplayScaleChange }: GifViewerProps) {
  void onZoomChange
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [hasDecodeError, setHasDecodeError] = useState(false)
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 })
  const [frames, setFrames] = useState<DecodedFrame[]>([])
  const [currentFrame, setCurrentFrame] = useState(0)
  const [playMode, setPlayMode] = useState<GifPlayMode>("loop")
  const [isPlaying, setIsPlaying] = useState(true)
  const dragStart = useRef({ x: 0, y: 0 })
  const panStart = useRef({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const prevZoomRef = useRef(zoom)
  const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

  const imageSrc = useMemo(() => {
    if (!filePath) return null
    return isTauri ? convertFileSrc(filePath) : filePath
  }, [filePath, isTauri])

  useEffect(() => {
    if (!imageSrc) return
    let cancelled = false

    const load = async () => {
      setIsLoading(true)
      setHasDecodeError(false)
      setFrames([])
      setCurrentFrame(0)
      setIsPlaying(true)
      setPlayMode("loop")
      setPan({ x: 0, y: 0 })

      try {
        const response = await fetch(imageSrc)
        const buffer = await response.arrayBuffer()
        if (cancelled) return
        const decoded = decodeGifFrames(buffer)
        if (cancelled) return
        setFrameSize({ width: decoded.width, height: decoded.height })
        setFrames(decoded.frames)
        if (decoded.frames.length === 0) {
          setHasDecodeError(true)
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("GIF decode failed:", error)
          setHasDecodeError(true)
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [imageSrc])

  useEffect(() => {
    if (prevZoomRef.current > 1 && zoom <= 1) {
      setPan({ x: 0, y: 0 })
    }
    prevZoomRef.current = zoom
  }, [zoom])

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

  const reportDisplayScale = useCallback(() => {
    if (!onDisplayScaleChange) return
    const container = containerRef.current
    if (!container || frameSize.width <= 0 || frameSize.height <= 0) return

    const fitScale = Math.min(
      1,
      container.clientWidth / frameSize.width,
      container.clientHeight / frameSize.height
    )
    onDisplayScaleChange(fitScale * zoom)
  }, [frameSize.height, frameSize.width, onDisplayScaleChange, zoom])

  useEffect(() => {
    reportDisplayScale()
  }, [reportDisplayScale, frames.length, currentFrame])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (typeof ResizeObserver === "undefined") {
      const onResize = () => reportDisplayScale()
      window.addEventListener("resize", onResize)
      return () => window.removeEventListener("resize", onResize)
    }

    const observer = new ResizeObserver(() => {
      reportDisplayScale()
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [reportDisplayScale])

  useEffect(() => {
    const canvas = canvasRef.current
    const frame = frames[currentFrame]
    if (!canvas || !frame || frameSize.width <= 0 || frameSize.height <= 0) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.putImageData(frame.imageData, 0, 0)
  }, [currentFrame, frameSize.height, frameSize.width, frames])

  useEffect(() => {
    if (frames.length === 0) return
    if (playMode === "frame" || !isPlaying) return

    const frame = frames[currentFrame]
    if (!frame) return

    const timer = window.setTimeout(() => {
      const atLastFrame = currentFrame >= frames.length - 1
      if (atLastFrame) {
        if (playMode === "once") {
          setIsPlaying(false)
          return
        }
        setCurrentFrame(0)
        return
      }
      setCurrentFrame((prev) => Math.min(prev + 1, frames.length - 1))
    }, frame.delayMs)

    return () => window.clearTimeout(timer)
  }, [currentFrame, frames, isPlaying, playMode])

  useEffect(() => {
    if (currentFrame <= frames.length - 1) return
    setCurrentFrame(Math.max(0, frames.length - 1))
  }, [currentFrame, frames.length])

  const handleModeChange = useCallback((nextMode: GifPlayMode) => {
    setPlayMode(nextMode)
    if (nextMode === "frame") {
      setIsPlaying(false)
      return
    }
    setIsPlaying(true)
    if (nextMode === "once" && currentFrame >= frames.length - 1) {
      setCurrentFrame(0)
    }
  }, [currentFrame, frames.length])

  const stepFrame = useCallback((direction: 1 | -1) => {
    if (frames.length === 0) return
    setIsPlaying(false)
    setCurrentFrame((prev) => {
      const next = prev + direction
      if (next < 0) return frames.length - 1
      if (next >= frames.length) return 0
      return next
    })
  }, [frames.length])

  if (!imageSrc) {
    return <div className="text-white/50 flex h-full items-center justify-center">无法加载 GIF</div>
  }

  if (isLoading) {
    return <div className="text-white/60 flex h-full items-center justify-center">正在解析 GIF...</div>
  }

  if (hasDecodeError || frames.length === 0 || frameSize.width <= 0 || frameSize.height <= 0) {
    return (
      <div className="w-full h-full flex items-center justify-center overflow-hidden">
        <img
          src={imageSrc}
          alt=""
          className="max-w-full max-h-full object-contain drop-shadow-2xl rounded-sm"
          draggable={false}
          style={{
            transform: `scale(${zoom})`,
            transition: "transform 0.1s ease-out",
          }}
        />
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full flex items-center justify-center overflow-hidden"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: zoom > 1 ? (isDragging ? "grabbing" : "grab") : "default" }}
    >
      <canvas
        ref={canvasRef}
        width={frameSize.width}
        height={frameSize.height}
        className="max-w-full max-h-full object-contain drop-shadow-2xl rounded-sm pointer-events-none"
        style={{
          transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
          transition: isDragging ? "none" : "transform 0.1s ease-out",
        }}
      />

      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-lg bg-black/55 border border-white/20 px-2 py-1 text-[11px] text-white/90">
        <button
          onClick={() => handleModeChange("once")}
          className={`px-2 py-0.5 rounded ${playMode === "once" ? "bg-white/20" : "hover:bg-white/10"}`}
        >
          正常播放
        </button>
        <button
          onClick={() => handleModeChange("loop")}
          className={`px-2 py-0.5 rounded ${playMode === "loop" ? "bg-white/20" : "hover:bg-white/10"}`}
        >
          重复播放
        </button>
        <button
          onClick={() => handleModeChange("frame")}
          className={`px-2 py-0.5 rounded ${playMode === "frame" ? "bg-white/20" : "hover:bg-white/10"}`}
        >
          逐帧
        </button>
        <div className="w-px h-3 bg-white/20 mx-0.5" />
        <button onClick={() => stepFrame(-1)} className="px-2 py-0.5 rounded hover:bg-white/10">
          上一帧
        </button>
        <button
          onClick={() => {
            if (playMode === "frame") {
              setPlayMode("once")
            }
            setIsPlaying((prev) => {
              const next = !prev
              if (next && playMode !== "loop" && currentFrame >= frames.length - 1) {
                setCurrentFrame(0)
              }
              return next
            })
          }}
          className="px-2 py-0.5 rounded hover:bg-white/10"
        >
          {isPlaying ? "暂停" : "播放"}
        </button>
        <button onClick={() => stepFrame(1)} className="px-2 py-0.5 rounded hover:bg-white/10">
          下一帧
        </button>
        <span className="text-white/60 ml-1">{currentFrame + 1}/{frames.length}</span>
      </div>
    </div>
  )
}
