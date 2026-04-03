import { create } from "zustand"

export const getSafeArray = (jsonStr: string | string[] | null | undefined): string[] => {
  if (!jsonStr) return []
  if (Array.isArray(jsonStr)) return jsonStr
  try {
    const parsed = JSON.parse(jsonStr)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export interface Asset {
  id: string
  name: string
  path: string
  asset_type: string
  size: number
  dominant_color?: string
  thumbnail_base64?: string
  workspace_ids?: string // JSON string array from backend
  tags?: string // JSON string array
  description?: string
  rating?: number
  created_at?: number
  modified_at?: number
  is_missing?: boolean
  is_trashed?: boolean
  width?: number
  height?: number
  source_url?: string
  duration?: number
}

export interface Workspace {
  id: string
  name: string
}

export type SortConfig = {
  field: 'name' | 'size' | 'created_at' | 'modified_at' | 'rating'
  order: 'asc' | 'desc'
}

export type ViewType = 'all' | 'unorganized' | 'trash' | 'tags' | 'workspace'

export interface ColorFilter {
  hex: string;
  exact: boolean;
}

interface AssetStore {
  assets: Asset[]
  workspaces: Workspace[]
  selectedAssets: string[]
  searchQuery: string
  
  // Advanced Filters
  keywordFilter: string
  colorFilter: ColorFilter | null
  typeFilter: string[] | null
  tagFilter: string[] | null
  folderFilter: string[] | null
  shapeFilter: string[] | null // 'horizontal', 'vertical', 'square'
  ratingFilter: number[] | null
  sizeFilter: string[] | null
  durationFilter: string[] | null
  
  activeView: ViewType
  activeWorkspaceId: string | null
  isLeftSidebarVisible: boolean
  isRightSidebarVisible: boolean
  thumbnailSize: number
  layoutMode: "grid" | "masonry"
  sortConfig: SortConfig
  similarAssetIds: string[] | null
  previewAsset: Asset | null
  isFullscreenPreview: boolean
  setAssets: (assets: Asset[]) => void
  addWorkspace: (name: string) => void
  setActiveView: (view: ViewType, workspaceId?: string | null) => void
  setLeftSidebarVisible: (visible: boolean) => void
  setRightSidebarVisible: (visible: boolean) => void
  toggleLeftSidebar: () => void
  toggleRightSidebar: () => void
  assignAssetToWorkspace: (assetId: string, workspaceId: string) => void
  removeAssetFromWorkspace: (assetId: string, workspaceId: string) => void
  setSelectedAssets: (assetIds: string[], append?: boolean) => void
  setPreviewAsset: (asset: Asset | null, fullscreen?: boolean) => void
  setFullscreenPreview: (fullscreen: boolean) => void
  setSearchQuery: (query: string) => void
  setKeywordFilter: (query: string) => void
  setColorFilter: (filter: ColorFilter | null) => void
  setTypeFilter: (filter: string[] | null) => void
  setTagFilter: (filter: string[] | null) => void
  setFolderFilter: (filter: string[] | null) => void
  setShapeFilter: (filter: string[] | null) => void
  setRatingFilter: (filter: number[] | null) => void
  setSizeFilter: (filter: string[] | null) => void
  setDurationFilter: (filter: string[] | null) => void
  setThumbnailSize: (size: number) => void
  setLayoutMode: (mode: "grid" | "masonry") => void
  setSortConfig: (config: SortConfig) => void
  setSimilarAssetIds: (ids: string[] | null) => void
  updateAssetProperty: (assetId: string, updates: Partial<Asset>) => void
  removeAsset: (assetId: string) => void
}

export const useAssetStore = create<AssetStore>((set) => ({
  assets: [],
  workspaces: [
    { id: "1", name: "Project Alpha" },
    { id: "2", name: "需求参考" }
  ],
  selectedAssets: [],
  searchQuery: "",
  keywordFilter: "",
  colorFilter: null,
  typeFilter: null,
  tagFilter: null,
  folderFilter: null,
  shapeFilter: null,
  ratingFilter: null,
  sizeFilter: null,
  durationFilter: null,
  activeView: "all",
  activeWorkspaceId: null,
  isLeftSidebarVisible: true,
  isRightSidebarVisible: true,
  thumbnailSize: 200,
  layoutMode: "masonry",
  sortConfig: { field: 'created_at', order: 'desc' },
  similarAssetIds: null,
  previewAsset: null,
  isFullscreenPreview: false,
  setAssets: (assets) => set({ assets }),
  addWorkspace: (name) => set((state) => ({
    workspaces: [...state.workspaces, { id: Math.random().toString(36).substr(2, 9), name }]
  })),
  setActiveView: (view, workspaceId = null) => set({ activeView: view, activeWorkspaceId: workspaceId }),
  setLeftSidebarVisible: (visible) => set({ isLeftSidebarVisible: visible }),
  setRightSidebarVisible: (visible) => set({ isRightSidebarVisible: visible }),
  toggleLeftSidebar: () => set((state) => ({ isLeftSidebarVisible: !state.isLeftSidebarVisible })),
  toggleRightSidebar: () => set((state) => ({ isRightSidebarVisible: !state.isRightSidebarVisible })),
  assignAssetToWorkspace: (assetId, workspaceId) => set((state) => ({
    assets: state.assets.map(a => {
      if (a.id === assetId) {
        const currentWs = typeof a.workspace_ids === 'string' ? JSON.parse(a.workspace_ids) : []
        if (Array.isArray(currentWs) && !currentWs.includes(workspaceId)) {
          return { ...a, workspace_ids: JSON.stringify([...currentWs, workspaceId]) }
        }
      }
      return a
    })
  })),
  removeAssetFromWorkspace: (assetId, workspaceId) => set((state) => ({
    assets: state.assets.map(a => {
      if (a.id === assetId && a.workspace_ids) {
        const currentWs = typeof a.workspace_ids === 'string' ? JSON.parse(a.workspace_ids) : []
        if (Array.isArray(currentWs)) {
          return { ...a, workspace_ids: JSON.stringify(currentWs.filter((id: string) => id !== workspaceId)) }
        }
      }
      return a
    })
  })),
  setSelectedAssets: (assetIds, append = false) => set((state) => ({
    selectedAssets: append 
      ? Array.from(new Set([...state.selectedAssets, ...assetIds]))
      : assetIds
  })),
  setPreviewAsset: (asset, fullscreen = false) => set({ previewAsset: asset, isFullscreenPreview: fullscreen }),
  setFullscreenPreview: (fullscreen) => set({ isFullscreenPreview: fullscreen }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setKeywordFilter: (query) => set({ keywordFilter: query }),
  setColorFilter: (filter) => set({ colorFilter: filter }),
  setTypeFilter: (filter) => set({ typeFilter: filter }),
  setTagFilter: (filter) => set({ tagFilter: filter }),
  setFolderFilter: (filter) => set({ folderFilter: filter }),
  setShapeFilter: (filter) => set({ shapeFilter: filter }),
  setRatingFilter: (filter) => set({ ratingFilter: filter }),
  setSizeFilter: (filter) => set({ sizeFilter: filter }),
  setDurationFilter: (filter) => set({ durationFilter: filter }),
  setThumbnailSize: (size) => set({ thumbnailSize: size }),
  setLayoutMode: (mode) => set({ layoutMode: mode }),
  setSortConfig: (config) => set({ sortConfig: config }),
  setSimilarAssetIds: (ids) => set({ similarAssetIds: ids }),
  updateAssetProperty: (assetId, updates) => set((state) => {
    const newAssets = state.assets.map(a => 
      a.id === assetId ? { ...a, ...updates } : a
    )
    
    return { assets: newAssets }
  }),
  removeAsset: (assetId) => set((state) => ({
    assets: state.assets.filter(a => a.id !== assetId),
    selectedAssets: state.selectedAssets.filter(id => id !== assetId),
    previewAsset: state.previewAsset?.id === assetId ? null : state.previewAsset
  }))
}))
