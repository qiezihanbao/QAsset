use sha2::{Sha256, Digest};
use std::path::{Path, PathBuf};

pub fn thumbnail_relative_path(relative_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(relative_path.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    format!("{}/{}.png", &hash[..2], &hash[2..14])
}

pub fn thumbnail_abs_path(library_root: &Path, relative_path: &str) -> PathBuf {
    crate::library::thumbnails_dir(library_root).join(thumbnail_relative_path(relative_path))
}

pub fn ensure_thumbnail_dir(library_root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let thumb_path = thumbnail_abs_path(library_root, relative_path);
    if let Some(parent) = thumb_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create thumbnail dir: {}", e))?;
    }
    Ok(thumb_path)
}

pub fn preview_relative_path(relative_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(relative_path.as_bytes());
    hasher.update(b":full-preview:v6");
    let hash = format!("{:x}", hasher.finalize());
    format!("{}/{}.png", &hash[..2], &hash[2..14])
}

pub fn preview_abs_path(library_root: &Path, relative_path: &str) -> PathBuf {
    crate::library::previews_dir(library_root).join(preview_relative_path(relative_path))
}

pub fn ensure_preview_dir(library_root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let preview_path = preview_abs_path(library_root, relative_path);
    if let Some(parent) = preview_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create preview dir: {}", e))?;
    }
    Ok(preview_path)
}
