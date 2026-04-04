import { useEffect, useState } from "react"
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

    if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
      try {
        listen('tauri://file-drop', async (event: any) => {
          const filePaths = event.payload as string[];
          if (filePaths && filePaths.length > 0) {
            console.log('Files dropped:', filePaths);
            try {
              await invoke("scan_library");
              await (window as any).__loadAssets?.();
              alert("拖拽导入完成！");
            } catch (err) {
              console.error("Drop import failed:", err);
            }
          }
        }).then(u => unlistenDrop = u);

        // File System Hot Reload Listener
        listen('fs-event', async (event: any) => {
          console.log('Hot reload FS event received:', event.payload);
          const payload = event.payload as { event_type: string, path: string };

          if (payload.event_type === 'create' || payload.event_type === 'modify') {
             try {
               await invoke("scan_library");
               await (window as any).__loadAssets?.();
             } catch (e) {
               console.error("Hot reload rescan failed", e);
             }
          } else if (payload.event_type === 'remove') {
             try {
               await invoke("delete_assets", { ids: [payload.path] });
               useAssetStore.getState().removeAsset(payload.path);
             } catch (e) {
               console.error("Hot reload delete failed", e);
             }
          }
        }).then(u => unlistenFs = u);

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
    </MainLayout>
  )
}

export default App
