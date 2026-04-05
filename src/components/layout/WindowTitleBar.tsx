import { useCallback, useEffect, useState, type MouseEvent } from "react"
import { Copy, Minus, Square, X } from "lucide-react"
import { getCurrentWindow } from "@tauri-apps/api/window"

type TauriLikeWindow = Window & {
  __TAURI_INTERNALS__?: unknown
  __TAURI__?: unknown
}

const hasTauriRuntime = () => {
  const w = window as TauriLikeWindow
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__)
}

export function WindowTitleBar() {
  const [isTauri, setIsTauri] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)

  const syncMaximized = useCallback(async () => {
    if (!hasTauriRuntime()) return
    try {
      const appWindow = getCurrentWindow()
      setIsMaximized(await appWindow.isMaximized())
    } catch {
      // noop
    }
  }, [])

  useEffect(() => {
    if (!hasTauriRuntime()) return
    setIsTauri(true)
    void syncMaximized()
  }, [syncMaximized])

  if (!isTauri) return null

  const handleMinimize = async () => {
    try {
      await getCurrentWindow().minimize()
    } catch (e) {
      console.warn("window.minimize failed:", e)
    }
  }

  const handleToggleMaximize = async () => {
    try {
      const appWindow = getCurrentWindow()
      const maximized = await appWindow.isMaximized()
      if (maximized) {
        await appWindow.unmaximize()
      } else {
        await appWindow.maximize()
      }
      setIsMaximized(!maximized)
    } catch (e) {
      console.warn("window.maximize toggle failed:", e)
    }
  }

  const handleClose = async () => {
    try {
      await getCurrentWindow().close()
    } catch (e) {
      console.warn("window.close failed:", e)
    }
  }

  const handleDragPointerDown = async (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    try {
      await getCurrentWindow().startDragging()
    } catch (err) {
      console.warn("window.startDragging failed:", err)
    }
  }

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-zinc-200/80 bg-zinc-50/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
      <div
        data-tauri-drag-region
        className="flex flex-1 cursor-move items-center px-3 text-xs font-medium text-zinc-500 dark:text-zinc-400"
        onMouseDown={(e) => {
          void handleDragPointerDown(e)
        }}
        onDoubleClick={() => {
          void handleToggleMaximize()
        }}
      >
        QuickAsset
      </div>
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={handleMinimize}
          className="flex h-full w-11 items-center justify-center text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          title="最小化"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleToggleMaximize}
          className="flex h-full w-11 items-center justify-center text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          title={isMaximized ? "还原" : "最大化"}
        >
          {isMaximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={handleClose}
          className="flex h-full w-11 items-center justify-center text-zinc-500 transition-colors hover:bg-red-500 hover:text-white dark:text-zinc-400 dark:hover:bg-red-500 dark:hover:text-white"
          title="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
