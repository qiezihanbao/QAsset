import { useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import { MainLayout } from "@/components/layout/MainLayout"
import { AssetsPage } from "@/pages/AssetsPage"
import { useAssetStore } from "@/store/useAssetStore"

function App() {
  const { setAssets } = useAssetStore()

  useEffect(() => {
    // Try to load existing assets from local database
    invoke("get_all_assets")
      .then((assets) => {
        if (Array.isArray(assets) && assets.length > 0) {
          setAssets(assets)
        }
      })
      .catch((err) => {
        console.error("Failed to load assets from DB:", err)
      })
  }, [])

  return (
    <MainLayout>
      <AssetsPage />
    </MainLayout>
  )
}

export default App
