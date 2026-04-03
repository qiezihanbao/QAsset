import { create } from "zustand"

export interface Asset {
  id: string
  name: string
  path: string
  asset_type: string
  size: number
  dominant_color?: string
  thumbnail_base64?: string
  workspace_ids?: string[]
  tags?: string // JSON string array
  description?: string
  rating?: number
}

export interface Workspace {
  id: string
  name: string
}

interface AssetStore {
  assets: Asset[]
  workspaces: Workspace[]
  selectedAsset: Asset | null
  searchQuery: string
  currentFilter: string
  colorFilter: string | null
  typeFilter: string | null
  tagFilter: string | null
  activeWorkspaceId: string | null
  thumbnailSize: number
  layoutMode: "grid" | "masonry"
  setAssets: (assets: Asset[]) => void
  addWorkspace: (name: string) => void
  setActiveWorkspace: (id: string | null) => void
  assignAssetToWorkspace: (assetId: string, workspaceId: string) => void
  removeAssetFromWorkspace: (assetId: string, workspaceId: string) => void
  setSelectedAsset: (asset: Asset | null) => void
  setSearchQuery: (query: string) => void
  setCurrentFilter: (filter: string) => void
  setColorFilter: (color: string | null) => void
  setTypeFilter: (type: string | null) => void
  setTagFilter: (tag: string | null) => void
  setThumbnailSize: (size: number) => void
  setLayoutMode: (mode: "grid" | "masonry") => void
  updateAssetProperty: (assetId: string, updates: Partial<Asset>) => void
}

export const useAssetStore = create<AssetStore>((set) => ({
  assets: [],
  workspaces: [
    { id: "1", name: "Project Alpha" },
    { id: "2", name: "需求参考" }
  ],
  selectedAsset: null,
  searchQuery: "",
  currentFilter: "all",
  colorFilter: null,
  typeFilter: null,
  tagFilter: null,
  activeWorkspaceId: "2",
  thumbnailSize: 200,
  layoutMode: "masonry",
  setAssets: (assets) => set({ assets }),
  addWorkspace: (name) => set((state) => ({ 
    workspaces: [...state.workspaces, { id: Date.now().toString(), name }] 
  })),
  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  assignAssetToWorkspace: (assetId, workspaceId) => set((state) => ({
    assets: state.assets.map(a => 
      a.id === assetId 
        ? { ...a, workspace_ids: [...(a.workspace_ids || []), workspaceId] }
        : a
    )
  })),
  removeAssetFromWorkspace: (assetId, workspaceId) => set((state) => ({
    assets: state.assets.map(a => 
      a.id === assetId 
        ? { ...a, workspace_ids: (a.workspace_ids || []).filter(id => id !== workspaceId) }
        : a
    )
  })),
  setSelectedAsset: (asset) => set({ selectedAsset: asset }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setCurrentFilter: (filter) => set({ currentFilter: filter }),
  setColorFilter: (color) => set({ colorFilter: color }),
  setTypeFilter: (type) => set({ typeFilter: type }),
  setTagFilter: (tag) => set({ tagFilter: tag }),
  setThumbnailSize: (size) => set({ thumbnailSize: size }),
  setLayoutMode: (mode) => set({ layoutMode: mode }),
  updateAssetProperty: (assetId, updates) => set((state) => {
    const newAssets = state.assets.map(a => 
      a.id === assetId ? { ...a, ...updates } : a
    )
    
    // Also update selectedAsset if it's the one being modified
    let newSelected = state.selectedAsset
    if (newSelected && newSelected.id === assetId) {
      newSelected = { ...newSelected, ...updates }
    }

    return { assets: newAssets, selectedAsset: newSelected }
  })
}))
