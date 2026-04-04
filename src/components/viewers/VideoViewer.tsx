import { useState, useRef } from "react"
import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import { RotateCcw } from "lucide-react"

interface VideoViewerProps {
  filePath: string
  fileName: string
}

const PLAYBACK_RATES = [0.5, 1, 1.5, 2]

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: unknown
  __TAURI__?: unknown
}

export function VideoViewer({ filePath, fileName }: VideoViewerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [hasError, setHasError] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [isLooping, setIsLooping] = useState(false)

  const runtimeWindow = window as TauriWindow
  const isTauri = Boolean(runtimeWindow.__TAURI_INTERNALS__ || runtimeWindow.__TAURI__)
  const src = isTauri ? convertFileSrc(filePath) : filePath

  const handleError = () => {
    setHasError(true)
  }

  const handleRateChange = (rate: number) => {
    setPlaybackRate(rate)
    if (videoRef.current) {
      videoRef.current.playbackRate = rate
    }
  }

  const toggleLoop = () => {
    const newLoop = !isLooping
    setIsLooping(newLoop)
    if (videoRef.current) {
      videoRef.current.loop = newLoop
    }
  }

  const handleOpenDefault = async () => {
    try {
      await invoke("open_in_default_app", { path: filePath })
    } catch (e) {
      console.error("Failed to open in default app:", e)
    }
  }

  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-white/70 gap-4">
        <p className="text-lg">无法播放此视频格式</p>
        <p className="text-sm text-white/40">{fileName}</p>
        <button
          onClick={handleOpenDefault}
          className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
        >
          用系统默认程序打开
        </button>
      </div>
    )
  }

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <video
        ref={videoRef}
        src={src}
        controls
        className="max-w-full max-h-full object-contain"
        onError={handleError}
      />

      {/* Playback rate & loop overlay */}
      <div className="absolute top-3 right-3 flex items-center gap-2 z-10">
        <button
          onClick={toggleLoop}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            isLooping ? 'bg-white/30 text-white' : 'bg-black/30 text-white/60 hover:text-white'
          }`}
          title={isLooping ? '关闭循环' : '开启循环'}
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
        <select
          value={playbackRate}
          onChange={(e) => handleRateChange(Number(e.target.value))}
          className="bg-black/30 text-white/80 text-xs rounded px-1.5 py-1 border-none outline-none cursor-pointer"
        >
          {PLAYBACK_RATES.map(r => (
            <option key={r} value={r} className="bg-zinc-900">
              {r}x
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
