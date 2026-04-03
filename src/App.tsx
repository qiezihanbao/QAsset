import { useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { MainLayout } from "@/components/layout/MainLayout"
import { RightSidebar } from "@/components/layout/RightSidebar"
import { AssetsPage } from "@/pages/AssetsPage"
import { useAssetStore } from "@/store/useAssetStore"
import { Lightbox } from "@/components/Lightbox"

function App() {
  const { setAssets, isRightSidebarVisible, toggleLeftSidebar, toggleRightSidebar } = useAssetStore()

  useEffect(() => {
    // Try to load existing assets from local database if we are in Tauri environment
    try {
      const loadAssets = async () => {
        try {
          const assets = await invoke("get_all_assets") as any[]
          if (Array.isArray(assets) && assets.length > 0) {
            // Check health
            const missingIds = await invoke("check_health") as string[]
            
            const markedAssets = assets.map(a => ({
              ...a,
              is_missing: missingIds.includes(a.id)
            }))
            
            setAssets(markedAssets)
          }
        } catch (err) {
          console.warn("Could not load assets from DB:", err)
        }
      }
      
      loadAssets()
    } catch (e) {
      console.warn("Tauri invoke not available. Running in Web preview mode.")
    }
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
        const selectedAsset = useAssetStore.getState().selectedAsset;
        if (selectedAsset && useAssetStore.getState().activeView !== 'trash') {
          // Trigger delete on selected asset
          document.getElementById(`delete-asset-${selectedAsset.id}`)?.click();
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
              await invoke("scan_directory", { dirPath: filePaths[0] });
              await invoke("start_watcher", { dirPath: filePaths[0] });
              const allAssets = await invoke("get_all_assets");
              setAssets(allAssets as any[]);
              alert("拖拽导入完成！");
            } catch (err) {
              console.error("Drop import failed:", err);
            }
          }
        }).then(u => unlistenDrop = u);

        // File System Hot Reload Listener
        listen('fs-event', async (event: any) => {
          console.log('Hot reload FS event received:', event.payload);
          // For simplicity in a prototype, we just re-scan the parent directory of the changed file
          // In a production app, we would selectively insert/delete from local state without hitting the DB fully
          const payload = event.payload as { event_type: string, path: string };
          
          // Debounce this in real life to avoid spamming the backend
          if (payload.event_type === 'create' || payload.event_type === 'modify') {
             // We can trigger a partial scan or just re-fetch
             const parentDir = payload.path.substring(0, payload.path.lastIndexOf(/[/\\]/));
             try {
               await invoke("scan_directory", { dirPath: parentDir });
               const allAssets = await invoke("get_all_assets");
               setAssets(allAssets as any[]);
             } catch (e) {
               console.error("Hot reload rescan failed", e);
             }
          } else if (payload.event_type === 'remove') {
             try {
               await invoke("delete_asset", { id: payload.path });
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

  return (
    <MainLayout>
      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-white dark:bg-[#121212]">
          <AssetsPage />
        </main>
        {isRightSidebarVisible && <RightSidebar />}
      </div>
      <Lightbox />
    </MainLayout>
  )
}

export default App
