import { useEffect, useState, useRef, lazy, Suspense, useCallback } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { MainLayout } from "@/components/layout/MainLayout"
import { WindowTitleBar } from "@/components/layout/WindowTitleBar"
import { AssetsPage } from "@/pages/AssetsPage"
import { useAssetStore, type LibraryConfig, type RegistryEntry, type ProgressTaskKind } from "@/store/useAssetStore"
import { useTheme } from "@/hooks/useTheme"
import {
  extractImageFileImports,
  extractImageImportsFromClipboardData,
  extractImageImportsFromDataTransfer,
  hasExternalImageTransferHint,
  hasUrlTransferData,
  isQuickAssetInternalDrag,
  readNavigatorClipboardImageImports,
  runNativeImageImport,
  type NativeImageImport,
} from "@/lib/nativeImageImport"

const RightSidebar = lazy(() =>
  import("@/components/layout/RightSidebar").then((m) => ({ default: m.RightSidebar }))
)
const Lightbox = lazy(() =>
  import("@/components/Lightbox").then((m) => ({ default: m.Lightbox }))
)
const WelcomePage = lazy(() =>
  import("@/pages/WelcomePage").then((m) => ({ default: m.WelcomePage }))
)
const SimilarDedupePage = lazy(() =>
  import("@/pages/SimilarDedupePage").then((m) => ({ default: m.SimilarDedupePage }))
)

type AppWindow = Window & {
  __TAURI_INTERNALS__?: unknown
  __TAURI__?: unknown
  __openLibrary?: (path: string) => Promise<void>
  __loadAssets?: () => Promise<void> | void
}

const getAppWindow = () => window as AppWindow
const hasTauriRuntime = () => {
  const w = getAppWindow()
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__)
}

interface ScanProgressEvent {
  phase: string
  scanned: number
  total: number
}

interface MigrateProgressEvent {
  migrated: number
  total: number
}

interface WebImportProgressEvent {
  phase: string
  step: number
  total: number
  message?: string
}

function normalizeDroppedPath(raw: string): string {
  let path = raw.trim().replace(/^"+|"+$/g, '')
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path)
      path = decodeURIComponent(url.pathname)
      if (/^\/[a-zA-Z]:/.test(path)) {
        path = path.slice(1)
      }
    } catch {
      // Keep the original path when URL parsing fails.
    }
  }
  return path
}

function extractDroppedPaths(payload: unknown): string[] {
  const collect = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    const out: string[] = []
    for (const item of value) {
      if (typeof item !== 'string') continue
      const normalized = normalizeDroppedPath(item)
      if (normalized) out.push(normalized)
    }
    return out
  }

  if (Array.isArray(payload)) {
    return Array.from(new Set(collect(payload)))
  }
  if (payload && typeof payload === 'object') {
    const maybePaths = (payload as { paths?: unknown }).paths
    return Array.from(new Set(collect(maybePaths)))
  }
  return []
}

function App() {
  useTheme()

  const currentLibrary = useAssetStore((s) => s.currentLibrary)
  const isLoadingLibrary = useAssetStore((s) => s.isLoadingLibrary)
  const setCurrentLibrary = useAssetStore((s) => s.setCurrentLibrary)
  const setRecentLibraries = useAssetStore((s) => s.setRecentLibraries)
  const setIsLoadingLibrary = useAssetStore((s) => s.setIsLoadingLibrary)
  const resetForNewLibrary = useAssetStore((s) => s.resetForNewLibrary)
  const isRightSidebarVisible = useAssetStore((s) => s.isRightSidebarVisible)
  const activeView = useAssetStore((s) => s.activeView)
  const upsertProgressTask = useAssetStore((s) => s.upsertProgressTask)
  const clearProgressTask = useAssetStore((s) => s.clearProgressTask)

  const [isInitialized, setIsInitialized] = useState(false)
  const fsEventTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const progressClearTimersRef = useRef<Partial<Record<ProgressTaskKind, ReturnType<typeof setTimeout>>>>({})

  const loadAssets = useCallback(async () => {
    window.dispatchEvent(new Event('quickasset:refresh-assets'))
  }, [])

  const runHashMigrationIfNeeded = useCallback(async () => {
    if (!hasTauriRuntime()) return
    try {
      const count = await invoke<number>('migrate_hashed')
      if (count > 0) {
        console.log(`Hash migration completed: ${count} images processed`)
        // Reload assets to pick up new hashes/width/height/dominant_color
        await loadAssets()
      }
    } catch (e) {
      console.warn('Hash migration failed or was not needed:', e)
    }
  }, [loadAssets])

  const runThumbnailRepairIfNeeded = useCallback(async () => {
    if (!hasTauriRuntime()) return
    try {
      const repaired = await invoke<number>('repair_missing_thumbnails', { limit: 1200 })
      if (repaired > 0) {
        console.log(`Thumbnail repair completed: ${repaired} assets repaired`)
        await loadAssets()
      }
    } catch (e) {
      console.warn('Thumbnail repair failed or not needed:', e)
    }
  }, [loadAssets])

  const openLibrary = useCallback(async (path: string) => {
    setIsLoadingLibrary(true)
    resetForNewLibrary()
    try {
      const config = await invoke<LibraryConfig>('open_library_cmd', { path })
      setCurrentLibrary(config, path)
      try {
        const recents = await invoke<RegistryEntry[]>('get_recent_libraries')
        setRecentLibraries(recents)
      } catch (e) {
        console.warn('Failed to refresh recent libraries:', e)
      }

      // Start file watcher for this library
      try {
        await invoke('start_watcher')
      } catch (e) {
        console.warn('Failed to start file watcher:', e)
      }

      // Check for images that need hash migration and run in background
      runHashMigrationIfNeeded()
      runThumbnailRepairIfNeeded()
    } catch (e) {
      console.error('Failed to open library:', e)
    }
    setIsLoadingLibrary(false)
  }, [resetForNewLibrary, runHashMigrationIfNeeded, runThumbnailRepairIfNeeded, setCurrentLibrary, setIsLoadingLibrary, setRecentLibraries])

  const initApp = useCallback(async () => {
    if (!hasTauriRuntime()) {
      setIsInitialized(true)
      return
    }

    try {
      const recents = await invoke<RegistryEntry[]>('get_recent_libraries')
      setRecentLibraries(recents)

      if (recents.length > 0) {
        const lastLib = recents[0]
        await openLibrary(lastLib.path)
      }
    } catch (e) {
      console.error('Failed to init:', e)
    }
    setIsInitialized(true)
  }, [openLibrary, setRecentLibraries])

  useEffect(() => {
    initApp()
  }, [initApp])

  // Lightweight refresh: only reload the asset list (no full scan)
  const lightweightRefresh = useCallback(async () => {
    try {
      await loadAssets()
    } catch (e) {
      console.error('Lightweight refresh failed:', e)
    }
  }, [loadAssets])

  // Expose openLibrary and loadAssets for child components
  useEffect(() => {
    const appWindow = getAppWindow()
    appWindow.__openLibrary = openLibrary
    appWindow.__loadAssets = loadAssets
  }, [loadAssets, openLibrary])

  useEffect(() => {
    let lastNativeImportSignature = ''
    let lastNativeImportAt = 0
    let lastPathDropAt = 0
    let pendingFileDropTimer: ReturnType<typeof setTimeout> | null = null

    const isEditableTarget = (target: EventTarget | null) => {
      const element = target instanceof HTMLElement ? target : null
      if (!element) return false
      return Boolean(
        element.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"]')
      )
    }

    const nativeImportSignature = (imports: NativeImageImport[]) => imports
      .map((item) => item.kind === 'url'
        ? `url:${item.url}`
        : `blob:${item.fileName || ''}:${item.contentType || item.blob.type || ''}:${item.blob.size}`
      )
      .join('\n')

    const importNativeImages = async (imports: NativeImageImport[], sourceLabel: string) => {
      const uniqueImports = Array.from(new Map(
        imports.map((item) => [
          item.kind === 'url'
            ? `url:${item.url}`
            : `blob:${item.fileName || ''}:${item.contentType || item.blob.type || ''}:${item.blob.size}`,
          item,
        ])
      ).values())
      if (uniqueImports.length === 0) return

      if (!useAssetStore.getState().currentLibrary) {
        alert("请先打开或创建素材库")
        return
      }

      const signature = nativeImportSignature(uniqueImports)
      const now = Date.now()
      if (signature === lastNativeImportSignature && now - lastNativeImportAt < 1500) {
        return
      }
      lastNativeImportSignature = signature
      lastNativeImportAt = now

      let imported = 0
      const errors: string[] = []
      for (const item of uniqueImports) {
        try {
          await runNativeImageImport(item)
          imported += 1
        } catch (error) {
          console.error(`${sourceLabel} image import failed:`, error)
          errors.push(String(error))
        }
      }

      if (imported > 0) {
        await loadAssets()
      }

      if (errors.length > 0) {
        if (imported > 0) {
          alert(`${sourceLabel}部分导入完成（新增 ${imported} 张图片，失败 ${errors.length} 项）`)
        } else {
          alert(`${sourceLabel}导入失败: ${errors[0]}`)
        }
        return
      }

      if (imported > 0) {
        alert(`${sourceLabel}导入完成（新增 ${imported} 张图片）`)
      }
    }

    const tryNavigatorClipboardFallback = async () => {
      try {
        const imports = await readNavigatorClipboardImageImports()
        if (imports.length > 0) {
          await importNativeImages(imports, '粘贴')
        }
      } catch (error) {
        console.debug('Navigator clipboard image read failed:', error)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Allow inputs and textareas to receive normal key events
      if (isEditableTarget(e.target)) {
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          document.getElementById('global-left-sidebar-btn')?.click()
        } else {
          document.getElementById('global-right-sidebar-btn')?.click()
        }
      }
      if (e.key === 'Delete') {
        // Find if an asset is selected
        const selectedAssetId = useAssetStore.getState().selectedAssets[0];
        if (selectedAssetId && useAssetStore.getState().activeView !== 'trash') {
          // Trigger delete on selected asset
          document.getElementById(`delete-asset-${selectedAssetId}`)?.click();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    const handleNativePaste = async (event: ClipboardEvent) => {
      if (!hasTauriRuntime() || isEditableTarget(event.target)) return

      const imports = await extractImageImportsFromClipboardData(event.clipboardData)
      if (imports.length === 0) {
        void tryNavigatorClipboardFallback()
        return
      }

      event.preventDefault()
      await importNativeImages(imports, '粘贴')
    }

    const handleNativeDragOver = (event: DragEvent) => {
      if (!hasTauriRuntime() || !hasExternalImageTransferHint(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer && !isQuickAssetInternalDrag(event.dataTransfer)) {
        event.dataTransfer.dropEffect = 'copy'
      }
    }

    const handleNativeDrop = async (event: DragEvent) => {
      if (!hasTauriRuntime() || isQuickAssetInternalDrag(event.dataTransfer)) return

      const hasUrlData = hasUrlTransferData(event.dataTransfer)
      const fileImports = extractImageFileImports(event.dataTransfer)
      if (!hasUrlData && fileImports.length === 0) return

      event.preventDefault()
      event.stopPropagation()

      if (hasUrlData) {
        const imports = await extractImageImportsFromDataTransfer(event.dataTransfer)
        if (imports.length > 0) {
          await importNativeImages(imports, '拖拽')
        }
        return
      }

      if (pendingFileDropTimer) {
        clearTimeout(pendingFileDropTimer)
      }
      pendingFileDropTimer = setTimeout(() => {
        pendingFileDropTimer = null
        if (Date.now() - lastPathDropAt < 1200) return
        void importNativeImages(fileImports, '拖拽')
      }, 650)
    }

    window.addEventListener('paste', handleNativePaste)
    window.addEventListener('dragover', handleNativeDragOver)
    window.addEventListener('drop', handleNativeDrop)

    // File Drop Handler
    const clearProgressTimer = (kind: ProgressTaskKind) => {
      const existing = progressClearTimersRef.current[kind]
      if (existing) {
        clearTimeout(existing)
        delete progressClearTimersRef.current[kind]
      }
    }
    const scheduleProgressClear = (kind: ProgressTaskKind, delayMs: number) => {
      clearProgressTimer(kind)
      progressClearTimersRef.current[kind] = setTimeout(() => {
        clearProgressTask(kind)
        delete progressClearTimersRef.current[kind]
      }, delayMs)
    }

    let unlistenDrop: (() => void) | undefined;
    let unlistenDragDrop: (() => void) | undefined;
    let unlistenFs: (() => void) | undefined;
    let unlistenMigrate: (() => void) | undefined;
    let unlistenScan: (() => void) | undefined;
    let unlistenWebImport: (() => void) | undefined;
    let lastDropSignature = ''
    let lastDropAt = 0

    const handleDroppedPayload = async (payload: unknown) => {
      const filePaths = extractDroppedPaths(payload)
      if (filePaths.length === 0) {
        console.warn('Drop payload did not include valid paths:', payload)
        return
      }

      const signature = filePaths.join('\n')
      const now = Date.now()
      if (signature === lastDropSignature && now - lastDropAt < 1500) {
        return
      }
      lastDropSignature = signature
      lastDropAt = now
      lastPathDropAt = now

      console.log('Files dropped:', filePaths);
      try {
        const importedCount = await invoke<number>("import_external_paths", { paths: filePaths });
        await loadAssets();
        if (importedCount > 0) {
          alert(`拖拽导入完成（新增/更新 ${importedCount} 项）`);
        } else {
          alert("未导入任何资源：请确认拖入的是本地文件/文件夹，且文件类型受支持。");
        }
      } catch (err) {
        console.error("Drop import failed:", err);
        alert(`拖拽导入失败: ${String(err)}`);
      }
    }

    if (hasTauriRuntime()) {
      try {
        // Tauri v1 legacy drop event
        listen<unknown>('tauri://file-drop', async (event) => {
          await handleDroppedPayload(event.payload)
        }).then(u => unlistenDrop = u);

        // Tauri v2 drag-drop event
        listen<unknown>('tauri://drag-drop', async (event) => {
          const payload = event.payload as { type?: string; paths?: string[] } | unknown
          const eventType = typeof payload === 'object' && payload && 'type' in payload
            ? String((payload as { type?: unknown }).type || '')
            : 'drop'
          if (eventType && eventType !== 'drop') return
          await handleDroppedPayload(payload)
        }).then(u => unlistenDragDrop = u);

        // File System watcher events: backend already updates DB, frontend just refreshes
        listen('fs-event', async () => {
          if (fsEventTimerRef.current) {
            clearTimeout(fsEventTimerRef.current)
          }
          fsEventTimerRef.current = setTimeout(async () => {
            fsEventTimerRef.current = null
            try {
              await lightweightRefresh()
            } catch (e) {
              console.error("Lightweight refresh failed", e)
            }
          }, 500)
        }).then(u => unlistenFs = u);

        // Hash migration progress listener
        listen<MigrateProgressEvent>('migrate-progress', (event) => {
          const payload = event.payload
          const current = Math.max(0, Number(payload?.migrated || 0))
          const total = Math.max(0, Number(payload?.total || 0))
          upsertProgressTask('hash_migrate', {
            title: '重建图片哈希',
            phase: current >= total && total > 0 ? 'done' : 'processing',
            current,
            total,
            message: total > 0 ? `已处理 ${Math.min(current, total)} / ${total}` : '准备中...',
            status: current >= total && total > 0 ? 'success' : 'running',
          })
          if (total > 0 && current >= total) {
            scheduleProgressClear('hash_migrate', 2200)
          }
        }).then(u => unlistenMigrate = u);

        // Library scan progress listener
        listen<ScanProgressEvent>('scan-progress', (event) => {
          const payload = event.payload
          const phase = String(payload?.phase || '')
          const current = Math.max(0, Number(payload?.scanned || 0))
          const total = Math.max(0, Number(payload?.total || 0))
          const phaseLabelMap: Record<string, string> = {
            discovering: '扫描文件',
            diffing: '比对变更',
            processing: '重建图片哈希与缩略图',
            writing: '写入数据库与索引',
            done: '扫描完成',
          }
          const message = phaseLabelMap[phase] || '处理中'
          const done = phase === 'done'
          upsertProgressTask('scan', {
            title: '素材库扫描',
            phase,
            current,
            total,
            message,
            status: done ? 'success' : 'running',
          })
          if (done) {
            scheduleProgressClear('scan', 2200)
          }
        }).then(u => unlistenScan = u)

        // Browser web-import progress listener
        listen<WebImportProgressEvent>('web-import-progress', (event) => {
          const payload = event.payload
          const phase = String(payload?.phase || '')
          const current = Math.max(0, Number(payload?.step || 0))
          const total = Math.max(0, Number(payload?.total || 0))
          const phaseLabelMap: Record<string, string> = {
            downloading: '下载图片',
            processing: '处理图片哈希',
            indexing: '写入素材库',
            done: '导入完成',
            failed: '导入失败',
          }
          const status: 'running' | 'success' | 'error' =
            phase === 'done' ? 'success' : phase === 'failed' ? 'error' : 'running'
          upsertProgressTask('web_import', {
            title: '图片导入',
            phase,
            current,
            total,
            message: payload?.message || phaseLabelMap[phase] || '处理中',
            status,
          })
          if (phase === 'done') {
            scheduleProgressClear('web_import', 2200)
          } else if (phase === 'failed') {
            scheduleProgressClear('web_import', 4500)
          }
        }).then(u => unlistenWebImport = u)

      } catch (e) {
        console.warn("Tauri listeners failed to attach.", e);
      }
    } else {
      console.warn("Not in Tauri environment, file drop and hot-reload are disabled.");
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('paste', handleNativePaste)
      window.removeEventListener('dragover', handleNativeDragOver)
      window.removeEventListener('drop', handleNativeDrop)
      if (unlistenDrop) unlistenDrop();
      if (unlistenDragDrop) unlistenDragDrop();
      if (unlistenFs) unlistenFs();
      if (unlistenMigrate) unlistenMigrate();
      if (unlistenScan) unlistenScan();
      if (unlistenWebImport) unlistenWebImport();
      if (fsEventTimerRef.current) {
        clearTimeout(fsEventTimerRef.current)
      }
      if (pendingFileDropTimer) {
        clearTimeout(pendingFileDropTimer)
      }
      clearProgressTimer('scan')
      clearProgressTimer('hash_migrate')
      clearProgressTimer('web_import')
    }
  }, [clearProgressTask, lightweightRefresh, loadAssets, upsertProgressTask]);

  // Loading state
  if (isLoadingLibrary) {
    return (
      <div className="flex h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
        <WindowTitleBar />
        <div className="flex flex-1 items-center justify-center">
          <div className="text-zinc-500">正在加载素材库...</div>
        </div>
      </div>
    )
  }

  // If no library and initialized, show welcome
  if (isInitialized && !currentLibrary && hasTauriRuntime()) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-950">
        <WindowTitleBar />
        <div className="flex-1 overflow-hidden">
          <Suspense fallback={<div className="flex h-full items-center justify-center text-zinc-500">正在加载...</div>}>
            <WelcomePage onOpenLibrary={openLibrary} />
          </Suspense>
        </div>
      </div>
    )
  }

  // Not yet initialized (non-Tauri) or library is open
  return (
    <MainLayout>
      <div className="flex flex-1 overflow-hidden">
        <main className="relative flex-1 flex flex-col min-w-0 overflow-hidden bg-white dark:bg-[#121212]">
          <Suspense fallback={<div className="flex h-full items-center justify-center text-zinc-500">正在加载...</div>}>
            {activeView === 'similar' ? <SimilarDedupePage /> : <AssetsPage />}
          </Suspense>
          <Suspense fallback={null}>
            <Lightbox />
          </Suspense>
        </main>
        {isRightSidebarVisible && activeView !== 'similar' && (
          <Suspense fallback={null}>
            <RightSidebar />
          </Suspense>
        )}
      </div>
    </MainLayout>
  )
}

export default App
