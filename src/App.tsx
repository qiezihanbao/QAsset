import { useEffect, useState, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { MainLayout } from "@/components/layout/MainLayout"
import { RightSidebar } from "@/components/layout/RightSidebar"
import { AssetsPage } from "@/pages/AssetsPage"
import { useAssetStore, type AssetLite, type LibraryConfig } from "@/store/useAssetStore"
import { Lightbox } from "@/components/Lightbox"
import { WelcomePage } from "@/pages/WelcomePage"

const LARGE_PAGE_SIZE = 10000

function App() {
  const {
    currentLibrary, isLoadingLibrary, setCurrentLibrary, setRecentLibraries,
    setIsLoadingLibrary, setAssets, setPagination, resetForNewLibrary,
    isRightSidebarVisible, toggleLeftSidebar, toggleRightSidebar
  } = useAssetStore()

  const [isInitialized, setIsInitialized] = useState(false)
  const [migrateProgress, setMigrateProgress] = useState<{ migrated: number; total: number } | null>(null)
  const fsEventTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    initApp()
  }, [])

  async function initApp() {
    if (!window.__TAURI_INTERNALS__ && !window.__TAURI__) {
      setIsInitialized(true)
      return
    }

    try {
      const recents = await invoke('get_recent_libraries') as any[]
      setRecentLibraries(recents)

      if (recents.length > 0) {
        const lastLib = recents[0]
        await openLibrary(lastLib.path)
      }
    } catch (e) {
      console.error('Failed to init:', e)
    }
    setIsInitialized(true)
  }

  async function openLibrary(path: string) {
    setIsLoadingLibrary(true)
    resetForNewLibrary()
    try {
      const config = await invoke<LibraryConfig>('open_library_cmd', { path })
      setCurrentLibrary(config, path)
      await loadAssets()

      // Start file watcher for this library
      try {
        await invoke('start_watcher')
      } catch (e) {
        console.warn('Failed to start file watcher:', e)
      }

      // Check for images that need hash migration and run in background
      runHashMigrationIfNeeded()
    } catch (e) {
      console.error('Failed to open library:', e)
    }
    setIsLoadingLibrary(false)
  }

  async function loadAssets() {
    try {
      const result = await invoke('query_assets', {
        filters: {
          sort_field: 'created_at',
          sort_order: 'desc',
          page: 1,
          page_size: LARGE_PAGE_SIZE,
        }
      }) as any
      setAssets(result.items as AssetLite[])
      setPagination({
        totalCount: result.total_count,
        page: 1,
        hasMore: (result.items as any[]).length < result.total_count,
      })
    } catch (e) {
      console.error('Failed to load assets:', e)
    }
  }

  async function runHashMigrationIfNeeded() {
    if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return
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
  }

  // Lightweight refresh: only reload the asset list (no full scan)
  async function lightweightRefresh() {
    try {
      await loadAssets()
    } catch (e) {
      console.error('Lightweight refresh failed:', e)
    }
  }

  // Expose openLibrary and loadAssets for child components
  useEffect(() => {
    ;(window as any).__openLibrary = openLibrary
    ;(window as any).__loadAssets = loadAssets
  }, [])

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

    if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
      try {
        listen('tauri://file-drop', async (event: any) => {
          const filePaths = event.payload as string[];
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
        listen('migrate-progress', (event: any) => {
          const payload = event.payload as { migrated: number; total: number }
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
  }, []);

  // Loading state
  if (isLoadingLibrary) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <div className="text-zinc-500">Loading library...</div>
      </div>
    )
  }

  // If no library and initialized, show welcome
  if (isInitialized && !currentLibrary && (window.__TAURI_INTERNALS__ || window.__TAURI__)) {
    return <WelcomePage onOpenLibrary={openLibrary} />
  }

  // Not yet initialized (non-Tauri) or library is open
  return (
    <MainLayout>
      <div className="flex flex-1 overflow-hidden">
        <main className="relative flex-1 flex flex-col min-w-0 overflow-hidden bg-white dark:bg-[#121212]">
          <AssetsPage />
          <Lightbox />
        </main>
        {isRightSidebarVisible && <RightSidebar />}
      </div>

      {/* Hash Migration Progress Bar */}
      {migrateProgress && migrateProgress.total > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 px-4 pb-4">
          <div className="max-w-md mx-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Migrating image hashes...
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
