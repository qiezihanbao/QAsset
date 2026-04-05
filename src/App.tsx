import { useEffect, useState, useRef, lazy, Suspense, useCallback } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { MainLayout } from "@/components/layout/MainLayout"
import { WindowTitleBar } from "@/components/layout/WindowTitleBar"
import { AssetsPage } from "@/pages/AssetsPage"
import { useAssetStore, type LibraryConfig, type RegistryEntry } from "@/store/useAssetStore"
import { useTheme } from "@/hooks/useTheme"

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

  const [isInitialized, setIsInitialized] = useState(false)
  const [migrateProgress, setMigrateProgress] = useState<{ migrated: number; total: number } | null>(null)
  const fsEventTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    const handleKeyDown = (e: KeyboardEvent) => {
      // Allow inputs and textareas to receive normal key events
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
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

    // File Drop Handler
    let unlistenDrop: (() => void) | undefined;
    let unlistenFs: (() => void) | undefined;
    let unlistenMigrate: (() => void) | undefined;

    if (hasTauriRuntime()) {
      try {
        listen<string[]>('tauri://file-drop', async (event) => {
          const filePaths = event.payload;
          if (filePaths && filePaths.length > 0) {
            console.log('Files dropped:', filePaths);
            try {
              await invoke("scan_library");
              await loadAssets();
              alert("拖拽导入完成！");
            } catch (err) {
              console.error("Drop import failed:", err);
            }
          }
        }).then(u => unlistenDrop = u);

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
        listen<{ migrated: number; total: number }>('migrate-progress', (event) => {
          const payload = event.payload
          setMigrateProgress(payload)
          // Clear progress when done
          if (payload.migrated >= payload.total) {
            setTimeout(() => setMigrateProgress(null), 2000)
          }
        }).then(u => unlistenMigrate = u);

      } catch (e) {
        console.warn("Tauri listeners failed to attach.", e);
      }
    } else {
      console.warn("Not in Tauri environment, file drop and hot-reload are disabled.");
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (unlistenDrop) unlistenDrop();
      if (unlistenFs) unlistenFs();
      if (unlistenMigrate) unlistenMigrate();
      if (fsEventTimerRef.current) {
        clearTimeout(fsEventTimerRef.current)
      }
    }
  }, [lightweightRefresh, loadAssets]);

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

      {/* Hash Migration Progress Bar */}
      {migrateProgress && migrateProgress.total > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 px-4 pb-4">
          <div className="max-w-md mx-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                正在迁移图片哈希...
              </span>
              <span className="text-xs text-zinc-500">
                {migrateProgress.migrated}/{migrateProgress.total}
              </span>
            </div>
            <div className="w-full bg-zinc-200 dark:bg-zinc-700 rounded-full h-1.5">
              <div
                className="bg-indigo-500 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${(migrateProgress.migrated / migrateProgress.total) * 100}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  )
}

export default App
