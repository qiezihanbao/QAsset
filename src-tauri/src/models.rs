use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetInfoLite {
    pub id: String,
    pub name: String,
    pub path: String,
    pub asset_type: String,
    pub size: u64,
    pub dominant_color: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub created_at: u64,
    pub modified_at: u64,
    pub rating: Option<u8>,
    pub is_trashed: bool,
    pub thumbnail_path: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetDetail {
    pub id: String,
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub asset_type: String,
    pub size: u64,
    pub dominant_color: Option<String>,
    pub tags: Option<String>,
    pub description: Option<String>,
    pub rating: Option<u8>,
    pub workspace_ids: Option<String>,
    pub created_at: u64,
    pub modified_at: u64,
    pub p_hash: Option<String>,
    pub is_trashed: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub source_url: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail_path: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetFilters {
    pub search_query: Option<String>,
    pub asset_types: Option<Vec<String>>,
    pub is_trashed: Option<bool>,
    pub workspace_id: Option<String>,
    pub folder_path: Option<String>,
    pub min_rating: Option<u8>,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub tags: Option<Vec<String>>,
    pub unorganized: Option<bool>,
    pub sort_field: String,
    pub sort_order: String,
    pub page: u32,
    pub page_size: u32,
    pub skip_total_count: Option<bool>,
}

#[derive(Serialize, Deserialize)]
pub struct QueryResult {
    pub total_count: u32,
    pub items: Vec<AssetInfoLite>,
}

#[derive(Serialize, Deserialize)]
pub struct LibraryConfig {
    pub name: String,
    pub version: u32,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize)]
pub struct RegistryEntry {
    pub path: String,
    pub name: String,
    pub last_opened: u64,
}

#[derive(Serialize, Deserialize)]
pub struct Registry {
    pub recent_libraries: Vec<RegistryEntry>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ScanProgress {
    pub phase: String,
    pub scanned: u32,
    pub total: u32,
}

#[derive(Serialize, Deserialize)]
pub struct ScanReport {
    pub added: u32,
    pub updated: u32,
    pub deleted: u32,
    pub errors: Vec<ScanError>,
}

#[derive(Serialize, Deserialize)]
pub struct ScanError {
    pub path: String,
    pub message: String,
}
