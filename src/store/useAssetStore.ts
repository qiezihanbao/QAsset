import { create } from "zustand"
import { invoke } from "@tauri-apps/api/core"

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

// ─── New type definitions for library system ─────────────────────────

export interface AssetLite {
  id: string
  name: string
  path: string
  asset_type: string
  size: number
  thumbnail_path?: string
  dominant_color?: string
  width?: number
  height?: number
  created_at: number
  modified_at: number
  rating?: number
  is_trashed: boolean
}

export interface AssetDetail {
  id: string
  name: string
  path: string
  relative_path: string
  asset_type: string
  size: number
  dominant_color?: string
  tags?: string
  description?: string
  rating?: number
  workspace_ids?: string
  created_at: number
  modified_at: number
  p_hash?: string
  is_trashed: boolean
  width?: number
  height?: number
  source_url?: string
  duration?: number
  thumbnail_path?: string
}

export interface LibraryConfig {
  name: string
  version: number
  created_at: number
}

export interface RegistryEntry {
  path: string
  name: string
  last_opened: number
}

export interface PaginationState {
  page: number
  pageSize: number
  totalCount: number
  hasMore: boolean
}

export interface AssetFilters {
  search_query?: string
  asset_types?: string[]
  is_trashed?: boolean
  workspace_id?: string
  folder_path?: string
  min_rating?: number
  min_size?: number
  max_size?: number
  tags?: string[]
  unorganized?: boolean
  sort_field: string
  sort_order: string
  page: number
  page_size: number
  skip_total_count?: boolean
}

// ─── Legacy type alias for backward compatibility ────────────────────
// Existing components that import `Asset` will resolve to AssetLite.
export type Asset = AssetLite

// ─── Existing shared types ───────────────────────────────────────────

export interface Workspace {
  id: string
  name: string
}

export type SortConfig = {
  field: 'name' | 'size' | 'created_at' | 'modified_at' | 'rating' | 'custom' | 'random'
  order: 'asc' | 'desc'
}

export type ViewType = 'all' | 'unorganized' | 'trash' | 'tags' | 'workspace' | 'similar'

export interface ColorFilter {
  hex: string;
  exact: boolean;
}

// ─── Store interface ─────────────────────────────────────────────────

interface AssetStore {
  // Assets (lightweight list for grid/list views)
  assets: AssetLite[]
  // Full detail for the currently-selected asset
  assetDetail: AssetDetail | null

  // Library state
  currentLibrary: LibraryConfig | null
  currentLibraryPath: string | null
  recentLibraries: RegistryEntry[]
  isLoadingLibrary: boolean

  // Pagination
  pagination: PaginationState

  // Workspaces
  workspaces: Workspace[]

  // Selection & preview
  selectedAssets: string[]
  previewAsset: AssetLite | null
  isFullscreenPreview: boolean

  // Search & filters
  searchQuery: string
  keywordFilter: string
  colorFilter: ColorFilter | null
  typeFilter: string[] | null
  tagFilter: string[] | null
  tagsSummary: Record<string, number>
  isLoadingTagsSummary: boolean
  folderFilter: string[] | null
  folderPreviewVisibility: Record<string, boolean>
  shapeFilter: string[] | null // 'horizontal', 'vertical', 'square'
  ratingFilter: number[] | null
  sizeFilter: string[] | null
  durationFilter: string[] | null

  // View & UI preferences
  activeView: ViewType
  activeWorkspaceId: string | null
  isLeftSidebarVisible: boolean
  isRightSidebarVisible: boolean
  thumbnailSize: number
  layoutMode: "grid" | "masonry" | "canvas"
  sortConfig: SortConfig
  similarAssetIds: string[] | null

  // ── Actions: Assets ──────────────────────────────────────────────
  setAssets: (assets: AssetLite[]) => void
  appendAssets: (items: AssetLite[]) => void
  setAssetDetail: (detail: AssetDetail | null) => void
  updateAssetProperty: (assetId: string, updates: Partial<AssetLite>) => void
  removeAsset: (assetId: string) => void

  // ── Actions: Library ─────────────────────────────────────────────
  setCurrentLibrary: (lib: LibraryConfig | null, path: string | null) => void
  setRecentLibraries: (libs: RegistryEntry[]) => void
  setIsLoadingLibrary: (loading: boolean) => void
  setPagination: (p: Partial<PaginationState>) => void
  resetForNewLibrary: () => void

  // ── Actions: Workspaces ──────────────────────────────────────────
  setWorkspaces: (workspaces: Workspace[]) => void
  addWorkspace: (name: string) => void
  assignAssetToWorkspace: (assetId: string, workspaceId: string) => void
  removeAssetFromWorkspace: (assetId: string, workspaceId: string) => void

  // ── Actions: Selection & preview ─────────────────────────────────
  setSelectedAssets: (assetIds: string[], append?: boolean) => void
  setPreviewAsset: (asset: AssetLite | null, fullscreen?: boolean) => void
  setFullscreenPreview: (fullscreen: boolean) => void

  // ── Actions: Search & filters ────────────────────────────────────
  setSearchQuery: (query: string) => void
  setKeywordFilter: (query: string) => void
  setColorFilter: (filter: ColorFilter | null) => void
  setTypeFilter: (filter: string[] | null) => void
  setTagFilter: (filter: string[] | null) => void
  refreshTagsSummary: () => Promise<void>
  setFolderFilter: (filter: string[] | null) => void
  setFolderPreviewVisibility: (path: string, visible: boolean) => void
  setShapeFilter: (filter: string[] | null) => void
  setRatingFilter: (filter: number[] | null) => void
  setSizeFilter: (filter: string[] | null) => void
  setDurationFilter: (filter: string[] | null) => void

  // ── Actions: View & UI preferences ───────────────────────────────
  setActiveView: (view: ViewType, workspaceId?: string | null) => void
  setLeftSidebarVisible: (visible: boolean) => void
  setRightSidebarVisible: (visible: boolean) => void
  toggleLeftSidebar: () => void
  toggleRightSidebar: () => void
  setThumbnailSize: (size: number) => void
  setLayoutMode: (mode: "grid" | "masonry" | "canvas") => void
  setSortConfig: (config: SortConfig) => void
  setSimilarAssetIds: (ids: string[] | null) => void
}

// ─── Initial pagination ──────────────────────────────────────────────
const initialPagination: PaginationState = {
  page: 1,
  pageSize: 100,
  totalCount: 0,
  hasMore: false,
}

// ─── Store implementation ────────────────────────────────────────────

export const useAssetStore = create<AssetStore>((set) => ({
  assets: [],
  assetDetail: null,

  // Library state
  currentLibrary: null,
  currentLibraryPath: null,
  recentLibraries: [],
  isLoadingLibrary: false,

  // Pagination
  pagination: initialPagination,

  // Workspaces
  workspaces: [
    { id: "1", name: "Project Alpha" },
    { id: "2", name: "需求参考" }
  ],

  // Selection & preview
  selectedAssets: [],
  previewAsset: null,
  isFullscreenPreview: false,

  // Search & filters
  searchQuery: "",
  keywordFilter: "",
  colorFilter: null,
  typeFilter: null,
  tagFilter: null,
  tagsSummary: {},
  isLoadingTagsSummary: false,
  folderFilter: null,
  folderPreviewVisibility: {},
  shapeFilter: null,
  ratingFilter: null,
  sizeFilter: null,
  durationFilter: null,

  // View & UI preferences
  activeView: "all",
  activeWorkspaceId: null,
  isLeftSidebarVisible: true,
  isRightSidebarVisible: true,
  thumbnailSize: 200,
  layoutMode: "masonry",
  sortConfig: { field: 'created_at', order: 'desc' },
  similarAssetIds: null,

  // ── Actions: Assets ──────────────────────────────────────────────
  setAssets: (assets) => set({ assets }),
  appendAssets: (items) => set((state) => ({
    assets: [...state.assets, ...items]
  })),
  setAssetDetail: (detail) => set({ assetDetail: detail }),
  updateAssetProperty: (assetId, updates) => set((state) => ({
    assets: state.assets.map(a =>
      a.id === assetId ? { ...a, ...updates } as AssetLite : a
    )
  })),
  removeAsset: (assetId) => set((state) => ({
    assets: state.assets.filter(a => a.id !== assetId),
    selectedAssets: state.selectedAssets.filter(id => id !== assetId),
    previewAsset: state.previewAsset?.id === assetId ? null : state.previewAsset,
    assetDetail: state.assetDetail?.id === assetId ? null : state.assetDetail,
  })),

  // ── Actions: Library ─────────────────────────────────────────────
  setCurrentLibrary: (lib, path) => set({
    currentLibrary: lib,
    currentLibraryPath: path,
  }),
  setRecentLibraries: (libs) => set({ recentLibraries: libs }),
  setIsLoadingLibrary: (loading) => set({ isLoadingLibrary: loading }),
  setPagination: (p) => set((state) => ({
    pagination: { ...state.pagination, ...p }
  })),
  resetForNewLibrary: () => set({
    assets: [],
    assetDetail: null,
    selectedAssets: [],
    previewAsset: null,
    isFullscreenPreview: false,
    searchQuery: "",
    keywordFilter: "",
    colorFilter: null,
    typeFilter: null,
    tagFilter: null,
    folderFilter: null,
    folderPreviewVisibility: {},
    shapeFilter: null,
    ratingFilter: null,
    sizeFilter: null,
    durationFilter: null,
    similarAssetIds: null,
    activeView: "all",
    activeWorkspaceId: null,
    pagination: initialPagination,
  }),

  // ── Actions: Workspaces ──────────────────────────────────────────
  setWorkspaces: (workspaces) => set({ workspaces }),
  addWorkspace: (name) => set((state) => ({
    workspaces: [...state.workspaces, { id: Math.random().toString(36).substr(2, 9), name }]
  })),
  assignAssetToWorkspace: () => {
    // Workspace assignment now goes through the backend (update_asset).
    // The lightweight AssetLite items don't carry workspace_ids, so we
    // no longer update them in-place here. Kept for API compatibility.
  },
  removeAssetFromWorkspace: () => {
    // Same as above — delegated to the backend.
  },

  // ── Actions: Selection & preview ─────────────────────────────────
  setSelectedAssets: (assetIds, append = false) => set((state) => ({
    selectedAssets: append
      ? Array.from(new Set([...state.selectedAssets, ...assetIds]))
      : assetIds
  })),
  setPreviewAsset: (asset, fullscreen = false) => set({ previewAsset: asset, isFullscreenPreview: fullscreen }),
  setFullscreenPreview: (fullscreen) => set({ isFullscreenPreview: fullscreen }),

  // ── Actions: Search & filters ────────────────────────────────────
  setSearchQuery: (query) => set({ searchQuery: query }),
  setKeywordFilter: (query) => set({ keywordFilter: query }),
  setColorFilter: (filter) => set({ colorFilter: filter }),
  setTypeFilter: (filter) => set({ typeFilter: filter }),
  setTagFilter: (filter) => set({ tagFilter: filter }),
  refreshTagsSummary: async () => {
    const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
    if (!isTauri) return
    set({ isLoadingTagsSummary: true })
    try {
      const counts = await invoke('get_tags_summary') as Record<string, number>
      set({ tagsSummary: counts, isLoadingTagsSummary: false })
    } catch (e) {
      console.error('Failed to refresh tags summary:', e)
      set({ isLoadingTagsSummary: false })
    }
  },
  setFolderFilter: (filter) => set({ folderFilter: filter }),
  setFolderPreviewVisibility: (path, visible) =>
    set((state) => ({
      folderPreviewVisibility: {
        ...state.folderPreviewVisibility,
        [path]: visible,
      },
    })),
  setShapeFilter: (filter) => set({ shapeFilter: filter }),
  setRatingFilter: (filter) => set({ ratingFilter: filter }),
  setSizeFilter: (filter) => set({ sizeFilter: filter }),
  setDurationFilter: (filter) => set({ durationFilter: filter }),

  // ── Actions: View & UI preferences ───────────────────────────────
  setActiveView: (view, workspaceId = null) => set({ activeView: view, activeWorkspaceId: workspaceId }),
  setLeftSidebarVisible: (visible) => set({ isLeftSidebarVisible: visible }),
  setRightSidebarVisible: (visible) => set({ isRightSidebarVisible: visible }),
  toggleLeftSidebar: () => set((state) => ({ isLeftSidebarVisible: !state.isLeftSidebarVisible })),
  toggleRightSidebar: () => set((state) => ({ isRightSidebarVisible: !state.isRightSidebarVisible })),
  setThumbnailSize: (size) => set({ thumbnailSize: size }),
  setLayoutMode: (mode) => set({ layoutMode: mode }),
  setSortConfig: (config) => set({ sortConfig: config }),
  setSimilarAssetIds: (ids) => set({ similarAssetIds: ids }),
}))
