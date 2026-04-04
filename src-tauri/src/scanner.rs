use crate::library;
use crate::models::{ScanError, ScanProgress, ScanReport};
use crate::thumbnails;
use flate2::read::ZlibDecoder;
use image::GenericImageView;
use rayon::prelude::*;
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, AppHandle};
use tempfile::NamedTempFile;

/// File extensions grouped by asset type.
fn asset_type_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tiff" | "tif" | "ico" | "psd"
        | "psb" | "clip" => "image",
        "svg" => "vector",
        "mp4" | "avi" | "mov" | "mkv" | "webm" | "flv" | "wmv" => "video",
        "mp3" | "wav" | "ogg" | "flac" | "aac" | "m4a" | "wma" => "audio",
        "obj" | "fbx" | "gltf" | "glb" | "stl" | "3ds" | "blend" => "3d",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx"
        | "txt" | "rtf" | "csv" | "json" | "xml" | "html" | "md" => "document",
        _ => "other",
    }
}

/// Whether a file extension should be indexed at all.
fn is_indexable_ext(ext: &str) -> bool {
    matches!(
        asset_type_for_ext(ext),
        "image" | "vector" | "video" | "audio" | "3d" | "document"
    )
}

/// Metadata extracted from processing an image file.
pub struct ImageProcessResult {
    pub dominant_color: Option<String>,
    pub width: u32,
    pub height: u32,
    pub p_hash: Option<String>,
    pub thumbnail_mtime: Option<u64>,
}

/// Process an image: generate thumbnail, extract color, compute pHash.
pub fn process_image(
    library_root: &Path,
    relative_path: &str,
    abs_path: &Path,
) -> ImageProcessResult {
    let mut result = ImageProcessResult {
        dominant_color: None,
        width: 0,
        height: 0,
        p_hash: None,
        thumbnail_mtime: None,
    };

    // Open image (supports regular raster files + PSD composite + CLIP embedded preview)
    let img = match open_image_for_processing(abs_path) {
        Ok(img) => img,
        Err(_) => return result,
    };

    result.width = img.width();
    result.height = img.height();

    // Generate thumbnail and write to disk
    let thumb_result = generate_thumbnail(library_root, relative_path, &img);
    if let Ok(mtime) = thumb_result {
        result.thumbnail_mtime = Some(mtime);
    }

    // Extract dominant color from a tiny version
    result.dominant_color = extract_dominant_color(&img);

    // Compute perceptual hash
    result.p_hash = compute_image_phash(&img);

    result
}

/// Process a video: extract one frame, generate thumbnail, extract color, compute pHash.
pub fn process_video(
    library_root: &Path,
    relative_path: &str,
    abs_path: &Path,
) -> ImageProcessResult {
    let mut result = ImageProcessResult {
        dominant_color: None,
        width: 0,
        height: 0,
        p_hash: None,
        thumbnail_mtime: None,
    };

    let img = match open_video_frame_for_processing(abs_path) {
        Ok(img) => img,
        Err(_) => return result,
    };

    result.width = img.width();
    result.height = img.height();

    let thumb_result = generate_thumbnail(library_root, relative_path, &img);
    if let Ok(mtime) = thumb_result {
        result.thumbnail_mtime = Some(mtime);
    }

    result.dominant_color = extract_dominant_color(&img);
    result.p_hash = compute_image_phash(&img);

    result
}

fn compute_image_phash(img: &image::DynamicImage) -> Option<String> {
    let hasher = image_hasher::HasherConfig::new()
        .hash_alg(image_hasher::HashAlg::Gradient)
        .to_hasher();
    let hash = hasher.hash_image(img);
    Some(hash.to_base64())
}

fn open_video_frame_for_processing(abs_path: &Path) -> Result<image::DynamicImage, String> {
    let temp_path = tempfile::Builder::new()
        .prefix("quickasset-video-thumb-")
        .suffix(".png")
        .tempfile()
        .map_err(|e| format!("Failed to create temp thumbnail file: {}", e))?
        .into_temp_path();
    let temp_png_path = temp_path.to_path_buf();

    let mut last_error = String::from("ffmpeg failed to extract video frame");
    for seek in ["00:00:01.000", "00:00:00.000"] {
        let status = Command::new("ffmpeg")
            .arg("-y")
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error")
            .arg("-ss")
            .arg(seek)
            .arg("-i")
            .arg(abs_path)
            .arg("-frames:v")
            .arg("1")
            .arg("-an")
            .arg(&temp_png_path)
            .status();

        match status {
            Ok(s) if s.success() => match image::open(&temp_png_path) {
                Ok(img) => return Ok(img),
                Err(e) => {
                    last_error = format!(
                        "ffmpeg extracted frame but image decode failed for '{}': {}",
                        abs_path.display(),
                        e
                    );
                }
            },
            Ok(s) => {
                last_error = format!(
                    "ffmpeg exited with status '{}' for '{}'",
                    s,
                    abs_path.display()
                );
            }
            Err(e) => {
                last_error = format!(
                    "Failed to start ffmpeg for '{}': {}",
                    abs_path.display(),
                    e
                );
            }
        }
    }

    Err(last_error)
}

/// Open an image for preview/thumbnail processing.
///
/// For `psd` we use the composite RGBA image from the PSD container.
/// For `clip` we prioritize fast preview extraction.
/// Other formats fall back to `image::open`.
pub fn open_image_for_processing(abs_path: &Path) -> Result<image::DynamicImage, String> {
    let ext = abs_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "psd" | "psb" => open_psd_composite_image(abs_path),
        "clip" => open_clip_image(abs_path, ClipDecodeMode::PreviewFast),
        _ => image::open(abs_path)
            .map_err(|e| format!("Failed to open image '{}': {}", abs_path.display(), e)),
    }
}

/// Open an image for fullscreen preview rendering.
///
/// For CLIP we try larger embedded previews first; if they are missing or too
/// small, we fallback to external block-data decoding.
pub fn open_image_for_full_preview(abs_path: &Path) -> Result<image::DynamicImage, String> {
    let ext = abs_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "psd" | "psb" => open_psd_composite_image(abs_path),
        "clip" => open_clip_image(abs_path, ClipDecodeMode::BestQuality),
        _ => image::open(abs_path)
            .map_err(|e| format!("Failed to open image '{}': {}", abs_path.display(), e)),
    }
}

fn open_psd_composite_image(abs_path: &Path) -> Result<image::DynamicImage, String> {
    let bytes = fs::read(abs_path)
        .map_err(|e| format!("Failed to read PSD '{}': {}", abs_path.display(), e))?;
    let psd = psd::Psd::from_bytes(&bytes)
        .map_err(|e| format!("Failed to parse PSD '{}': {:?}", abs_path.display(), e))?;

    let width = psd.width();
    let height = psd.height();
    let rgba = psd.rgba();
    let rgba_img = image::RgbaImage::from_raw(width, height, rgba).ok_or_else(|| {
        format!(
            "PSD composite image buffer size mismatch for '{}'",
            abs_path.display()
        )
    })?;

    Ok(image::DynamicImage::ImageRgba8(rgba_img))
}

#[derive(Clone, Copy)]
enum ClipDecodeMode {
    PreviewFast,
    BestQuality,
}

#[derive(Clone)]
struct ClipExternalCandidate {
    external_id: String,
    width: u32,
    height: u32,
}

const CLIP_FAST_PREVIEW_AREA_THRESHOLD: u32 = 1_800_000;

fn clip_debug_enabled() -> bool {
    matches!(
        std::env::var("QUICKASSET_CLIP_DEBUG").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("on") | Some("ON")
    )
}

macro_rules! clip_debug {
    ($($arg:tt)*) => {
        if clip_debug_enabled() {
            eprintln!($($arg)*);
        }
    };
}

fn open_clip_image(abs_path: &Path, mode: ClipDecodeMode) -> Result<image::DynamicImage, String> {
    match mode {
        ClipDecodeMode::PreviewFast => open_clip_preview_image(abs_path, false),
        ClipDecodeMode::BestQuality => {
            let preview = open_clip_preview_image(abs_path, true).ok();

            // Fast path: when preview is already detailed and visually valid, skip
            // expensive external decode to keep fullscreen opening responsive.
            if let Some(p) = &preview {
                let p_area = p.width().saturating_mul(p.height());
                if clip_image_is_valid(p) && p_area >= CLIP_FAST_PREVIEW_AREA_THRESHOLD {
                    clip_debug!(
                        "[CLIP_DEBUG] fast-path preview for '{}' => {}x{} area={}",
                        abs_path.display(),
                        p.width(),
                        p.height(),
                        p_area
                    );
                    return Ok(p.clone());
                }
            }

            let external = open_clip_external_image(abs_path).ok();

            match (preview, external) {
                (Some(p), Some(e)) => {
                    let (p_ratio, p_contrast) = clip_image_stats(&p);
                    let (e_ratio, e_contrast) = clip_image_stats(&e);
                    let p_valid = clip_image_is_valid(&p);
                    let e_valid = clip_image_is_valid(&e);
                    let p_area = p.width().saturating_mul(p.height());
                    let e_area = e.width().saturating_mul(e.height());
                    clip_debug!(
                        "[CLIP_DEBUG] compare '{}' preview={}x{} area={} valid={} ratio={:.4} contrast={} external={}x{} area={} valid={} ratio={:.4} contrast={}",
                        abs_path.display(),
                        p.width(),
                        p.height(),
                        p_area,
                        p_valid,
                        p_ratio,
                        p_contrast,
                        e.width(),
                        e.height(),
                        e_area,
                        e_valid,
                        e_ratio,
                        e_contrast
                    );

                    if e_valid && (!p_valid || e_area > p_area) {
                        clip_debug!("[CLIP_DEBUG] selected external for '{}'", abs_path.display());
                        Ok(e)
                    } else if p_valid {
                        clip_debug!("[CLIP_DEBUG] selected preview for '{}'", abs_path.display());
                        Ok(p)
                    } else if e_area > p_area {
                        clip_debug!("[CLIP_DEBUG] selected external (fallback by area) for '{}'", abs_path.display());
                        Ok(e)
                    } else {
                        clip_debug!("[CLIP_DEBUG] selected preview (fallback by area) for '{}'", abs_path.display());
                        Ok(p)
                    }
                }
                (Some(p), None) => {
                    clip_debug!(
                        "[CLIP_DEBUG] only preview available for '{}': {}x{}",
                        abs_path.display(),
                        p.width(),
                        p.height()
                    );
                    Ok(p)
                }
                (None, Some(e)) => {
                    clip_debug!(
                        "[CLIP_DEBUG] only external available for '{}': {}x{}",
                        abs_path.display(),
                        e.width(),
                        e.height()
                    );
                    Ok(e)
                }
                (None, None) => Err(format!(
                    "No decodable CLIP image found in '{}'",
                    abs_path.display()
                )),
            }
        }
    }
}

fn clip_image_stats(img: &image::DynamicImage) -> (f32, u8) {
    let tiny = img.thumbnail(64, 64).to_rgba8();
    let total = tiny.width().saturating_mul(tiny.height());
    if total == 0 {
        return (0.0, 0);
    }

    let mut non_transparent: u32 = 0;
    let mut min_luma: u8 = u8::MAX;
    let mut max_luma: u8 = 0;

    for px in tiny.pixels() {
        let [r, g, b, a] = px.0;
        if a <= 8 {
            continue;
        }
        non_transparent = non_transparent.saturating_add(1);
        let luma = ((r as u16 + g as u16 + b as u16) / 3) as u8;
        if luma < min_luma {
            min_luma = luma;
        }
        if luma > max_luma {
            max_luma = luma;
        }
    }

    if non_transparent == 0 {
        return (0.0, 0);
    }

    let ratio = non_transparent as f32 / total as f32;
    let contrast = max_luma.saturating_sub(min_luma);
    (ratio, contrast)
}

fn clip_image_is_valid(img: &image::DynamicImage) -> bool {
    let (ratio, contrast) = clip_image_stats(img);
    ratio >= 0.03 && contrast >= 8
}

fn open_clip_preview_image(
    abs_path: &Path,
    prefer_large_sources: bool,
) -> Result<image::DynamicImage, String> {
    let container = parse_clip_container(abs_path)?;
    let conn_holder = ClipSqliteConnection::open(abs_path, &container)?;
    let conn = &conn_holder.conn;

    let mut tried_sources: Vec<String> = Vec::new();
    let mut best_valid_img: Option<image::DynamicImage> = None;
    let mut best_valid_area: u64 = 0;
    let mut best_any_img: Option<image::DynamicImage> = None;
    let mut best_any_area: u64 = 0;
    let mut candidate_tables: Vec<String> = if prefer_large_sources {
        vec![
            "ExternalThumbnail".to_string(),
            "CanvasPreview".to_string(),
            "Preview".to_string(),
            "Thumbnail".to_string(),
        ]
    } else {
        vec![
            "CanvasPreview".to_string(),
            "ExternalThumbnail".to_string(),
            "Preview".to_string(),
            "Thumbnail".to_string(),
        ]
    };

    // Also try any table whose name hints it may contain preview/thumbnail data.
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .map_err(|e| format!("Failed to inspect CLIP tables '{}': {}", abs_path.display(), e))?;
    let discovered_tables: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to read CLIP tables '{}': {}", abs_path.display(), e))?
        .filter_map(Result::ok)
        .collect();
    for table in discovered_tables {
        let lower = table.to_ascii_lowercase();
        if (lower.contains("preview") || lower.contains("thumb")) && !candidate_tables.contains(&table) {
            candidate_tables.push(table);
        }
    }

    for table in candidate_tables {
        let source = format!("{}:{}", abs_path.display(), table);
        tried_sources.push(source);

        if let Some(img) = read_best_preview_image(conn, &table)? {
            let area = (img.width() as u64).saturating_mul(img.height() as u64);
            let is_valid = clip_image_is_valid(&img);
            let (ratio, contrast) = clip_image_stats(&img);
            clip_debug!(
                "[CLIP_DEBUG] preview table '{}' for '{}' best={}x{} area={} valid={} ratio={:.4} contrast={}",
                table,
                abs_path.display(),
                img.width(),
                img.height(),
                area,
                is_valid,
                ratio,
                contrast
            );

            if area > best_any_area {
                best_any_area = area;
                best_any_img = Some(img.clone());
            }

            if is_valid && area > best_valid_area {
                best_valid_area = area;
                best_valid_img = Some(img);
            }
        }
    }

    if let Some(img) = best_valid_img {
        clip_debug!(
            "[CLIP_DEBUG] selected valid preview for '{}': {}x{}",
            abs_path.display(),
            img.width(),
            img.height()
        );
        return Ok(img);
    }
    if let Some(img) = best_any_img {
        clip_debug!(
            "[CLIP_DEBUG] selected non-valid preview fallback for '{}': {}x{}",
            abs_path.display(),
            img.width(),
            img.height()
        );
        return Ok(img);
    }

    Err(format!(
        "No decodable preview image found in CLIP '{}'. Tried: {}",
        abs_path.display(),
        if tried_sources.is_empty() {
            "none".to_string()
        } else {
            tried_sources.join(", ")
        }
    ))
}

#[derive(Clone, Copy)]
struct ClipChunkRange {
    start: usize,
    end: usize,
}

struct ClipContainer {
    raw_bytes: Vec<u8>,
    sqlite_bytes: Option<Vec<u8>>,
    external_chunks: Vec<ClipChunkRange>,
}

struct ClipSqliteConnection {
    conn: Connection,
    _temp_file: Option<NamedTempFile>,
}

impl ClipSqliteConnection {
    fn open(abs_path: &Path, container: &ClipContainer) -> Result<Self, String> {
        let flags =
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;

        if let Some(sqlite_bytes) = &container.sqlite_bytes {
            let mut temp_file = NamedTempFile::new()
                .map_err(|e| format!("Failed to create temporary CLIP sqlite file: {}", e))?;
            temp_file
                .write_all(sqlite_bytes)
                .map_err(|e| format!("Failed to write temporary CLIP sqlite file: {}", e))?;

            let conn = Connection::open_with_flags(temp_file.path(), flags)
                .map_err(|e| format!("Failed to open embedded CLIP sqlite data: {}", e))?;
            Ok(Self {
                conn,
                _temp_file: Some(temp_file),
            })
        } else {
            let conn = Connection::open_with_flags(abs_path, flags)
                .map_err(|e| format!("Failed to open CLIP sqlite '{}': {}", abs_path.display(), e))?;
            Ok(Self {
                conn,
                _temp_file: None,
            })
        }
    }
}

fn parse_clip_container(abs_path: &Path) -> Result<ClipContainer, String> {
    let bytes = fs::read(abs_path)
        .map_err(|e| format!("Failed to read CLIP '{}': {}", abs_path.display(), e))?;

    if bytes.starts_with(b"SQLite format 3\0") {
        return Ok(ClipContainer {
            raw_bytes: bytes,
            sqlite_bytes: None,
            external_chunks: Vec::new(),
        });
    }

    if bytes.len() < 24 {
        return Err(format!(
            "CLIP container too small to parse '{}'",
            abs_path.display()
        ));
    }

    let mut offset: usize = 24;
    let mut sqlite_start: Option<usize> = None;
    let mut external_chunks: Vec<ClipChunkRange> = Vec::new();

    while offset + 16 <= bytes.len() {
        let chunk_type = &bytes[offset..offset + 8];
        let chunk_size = u64::from_be_bytes(
            bytes[offset + 8..offset + 16]
                .try_into()
                .map_err(|_| "Invalid CLIP chunk header".to_string())?,
        );
        let size_usize = usize::try_from(chunk_size)
            .map_err(|_| "CLIP chunk size exceeds usize".to_string())?;
        let payload_start = offset + 16;
        let payload_end = payload_start
            .checked_add(size_usize)
            .ok_or_else(|| "CLIP chunk payload overflow".to_string())?;
        if payload_end > bytes.len() {
            return Err("CLIP chunk payload exceeds file size".to_string());
        }

        if chunk_type == b"CHNKExta" {
            external_chunks.push(ClipChunkRange {
                start: offset,
                end: payload_end,
            });
        } else if chunk_type == b"CHNKSQLi" {
            sqlite_start = Some(payload_start);
        }

        offset = payload_end;
    }

    let sqlite_start = sqlite_start.ok_or_else(|| {
        format!(
            "No embedded SQLite chunk found in CLIP '{}'",
            abs_path.display()
        )
    })?;

    // Follow Clip Studio chunk behavior: sqlite payload starts at CHNKSQLi and extends to EOF.
    let sqlite_bytes = bytes[sqlite_start..].to_vec();
    Ok(ClipContainer {
        raw_bytes: bytes,
        sqlite_bytes: Some(sqlite_bytes),
        external_chunks,
    })
}

fn read_best_preview_image(
    conn: &rusqlite::Connection,
    table_name: &str,
) -> Result<Option<image::DynamicImage>, String> {
    let escaped_table = escape_sql_ident(table_name);
    let pragma_sql = format!("PRAGMA table_info(\"{}\")", escaped_table);
    let mut info_stmt = match conn.prepare(&pragma_sql) {
        Ok(stmt) => stmt,
        Err(_) => return Ok(None),
    };

    let columns: Vec<(String, String)> = info_stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let typ: String = row.get(2)?;
            Ok((name, typ))
        })
        .map_err(|e| format!("Failed to inspect table '{}': {}", table_name, e))?
        .filter_map(Result::ok)
        .collect();

    if columns.is_empty() {
        return Ok(None);
    }

    let preferred_names = [
        "ImageData",
        "image_data",
        "thumbnail",
        "thumbnail_data",
        "preview",
        "preview_data",
        "data",
    ];

    let mut candidate_cols: Vec<String> = Vec::new();
    for target in preferred_names {
        if let Some((name, _)) = columns
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(target))
        {
            if !candidate_cols.contains(name) {
                candidate_cols.push(name.clone());
            }
        }
    }

    for (name, typ) in &columns {
        if typ.to_ascii_lowercase().contains("blob") && !candidate_cols.contains(name) {
            candidate_cols.push(name.clone());
        }
    }

    for (name, _) in &columns {
        let lower = name.to_ascii_lowercase();
        if (lower.contains("image") || lower.contains("preview") || lower.contains("thumb") || lower.contains("data"))
            && !candidate_cols.contains(name)
        {
            candidate_cols.push(name.clone());
        }
    }

    let mut best_img: Option<image::DynamicImage> = None;
    let mut best_area: u64 = 0;
    let mut decoded_count: u32 = 0;
    let mut blob_count: u32 = 0;
    let mut non_blob_count: u32 = 0;

    for col in candidate_cols {
        let escaped_col = escape_sql_ident(&col);
        let sql = format!(
            "SELECT \"{}\" FROM \"{}\" WHERE \"{}\" IS NOT NULL LIMIT 16",
            escaped_col, escaped_table, escaped_col
        );
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let mut rows = match stmt.query([]) {
            Ok(r) => r,
            Err(_) => continue,
        };

        loop {
            let maybe_row = rows
                .next()
                .map_err(|e| format!("Failed iterating preview rows from '{}.{}': {}", table_name, col, e))?;
            let Some(row) = maybe_row else {
                break;
            };

            let value_ref = match row.get_ref(0) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let bytes: Vec<u8> = match value_ref {
                rusqlite::types::ValueRef::Blob(b) => {
                    blob_count = blob_count.saturating_add(1);
                    b.to_vec()
                }
                _ => {
                    non_blob_count = non_blob_count.saturating_add(1);
                    continue;
                }
            };

            if let Ok(img) = decode_preview_blob(&bytes) {
                decoded_count = decoded_count.saturating_add(1);
                let area = (img.width() as u64).saturating_mul(img.height() as u64);
                if area > best_area {
                    best_area = area;
                    best_img = Some(img);
                }
            }
        }
    }

    if let Some(img) = &best_img {
        clip_debug!(
            "[CLIP_DEBUG] table '{}' blobs={} non_blobs={} decoded={} best={}x{} area={}",
            table_name,
            blob_count,
            non_blob_count,
            decoded_count,
            img.width(),
            img.height(),
            best_area
        );
    } else {
        clip_debug!(
            "[CLIP_DEBUG] table '{}' blobs={} non_blobs={} decoded=0 best=none",
            table_name,
            blob_count,
            non_blob_count
        );
    }

    Ok(best_img)
}

fn decode_preview_blob(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    if let Ok(img) = image::load_from_memory(bytes) {
        return Ok(img);
    }

    if let Some(offset) = find_png_signature(bytes) {
        if let Ok(img) = image::load_from_memory(&bytes[offset..]) {
            return Ok(img);
        }
    }

    if let Some(offset) = find_jpeg_signature(bytes) {
        if let Ok(img) = image::load_from_memory(&bytes[offset..]) {
            return Ok(img);
        }
    }

    Err("Preview blob is not a decodable image".to_string())
}

fn find_png_signature(bytes: &[u8]) -> Option<usize> {
    const PNG_SIG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
    bytes
        .windows(PNG_SIG.len())
        .position(|window| window == PNG_SIG)
}

fn find_jpeg_signature(bytes: &[u8]) -> Option<usize> {
    const JPEG_SIG: [u8; 2] = [0xFF, 0xD8];
    bytes
        .windows(JPEG_SIG.len())
        .position(|window| window == JPEG_SIG)
}

fn escape_sql_ident(ident: &str) -> String {
    ident.replace('\"', "\"\"")
}

fn open_clip_external_image(abs_path: &Path) -> Result<image::DynamicImage, String> {
    let container = parse_clip_container(abs_path)?;
    if container.external_chunks.is_empty() {
        return Err("No CLIP external chunks found".to_string());
    }

    let conn_holder = ClipSqliteConnection::open(abs_path, &container)?;
    let conn = &conn_holder.conn;

    let (canvas_w, canvas_h) = read_clip_canvas_size(conn)?.unwrap_or((0, 0));
    let candidates = collect_clip_external_candidates(conn)?;
    if candidates.is_empty() {
        return Err("No CLIP external block candidates found".to_string());
    }

    for candidate in candidates {
        let width = if candidate.width > 0 {
            candidate.width
        } else {
            canvas_w
        };
        let height = if candidate.height > 0 {
            candidate.height
        } else {
            canvas_h
        };
        if width == 0 || height == 0 {
            continue;
        }

        let Some(external_data) = extract_external_data_by_id(
            &container.raw_bytes,
            &container.external_chunks,
            &candidate.external_id,
        )?
        else {
            clip_debug!(
                "[CLIP_DEBUG] external id '{}' not found for '{}'",
                candidate.external_id,
                abs_path.display()
            );
            continue;
        };

        if let Ok(img) = clip_external_data_to_image(&external_data, width, height) {
            let (ratio, contrast) = clip_image_stats(&img);
            clip_debug!(
                "[CLIP_DEBUG] external decode '{}' id='{}' => {}x{} ratio={:.4} contrast={}",
                abs_path.display(),
                candidate.external_id,
                img.width(),
                img.height(),
                ratio,
                contrast
            );
            return Ok(img);
        }
        clip_debug!(
            "[CLIP_DEBUG] external decode failed '{}' id='{}' expected={}x{} data_len={}",
            abs_path.display(),
            candidate.external_id,
            width,
            height,
            external_data.len()
        );
    }

    Err("Failed to decode CLIP external block data".to_string())
}

fn read_clip_canvas_size(conn: &Connection) -> Result<Option<(u32, u32)>, String> {
    if let Ok(size) = conn.query_row(
        "SELECT CAST(CanvasWidth AS INTEGER), CAST(CanvasHeight AS INTEGER) FROM Canvas ORDER BY MainId LIMIT 1",
        [],
        |row| Ok((row.get::<_, i64>(0)? as u32, row.get::<_, i64>(1)? as u32)),
    ) {
        if size.0 > 0 && size.1 > 0 {
            return Ok(Some(size));
        }
    }

    if let Ok(size) = conn.query_row(
        "SELECT ImageWidth, ImageHeight FROM CanvasPreview ORDER BY MainId LIMIT 1",
        [],
        |row| Ok((row.get::<_, i64>(0)? as u32, row.get::<_, i64>(1)? as u32)),
    ) {
        if size.0 > 0 && size.1 > 0 {
            return Ok(Some(size));
        }
    }

    Ok(None)
}

fn collect_clip_external_candidates(conn: &Connection) -> Result<Vec<ClipExternalCandidate>, String> {
    let mut out: Vec<ClipExternalCandidate> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let joined_sql = "\
        SELECT \
            o.BlockData, \
            COALESCE(lt.ThumbnailCanvasWidth, CAST(c.CanvasWidth AS INTEGER), 0), \
            COALESCE(lt.ThumbnailCanvasHeight, CAST(c.CanvasHeight AS INTEGER), 0) \
        FROM Layer l \
        JOIN Mipmap m ON m.MainId = l.LayerRenderMipmap \
        JOIN MipmapInfo mi ON mi.MainId = m.BaseMipmapInfo \
        JOIN Offscreen o ON o.MainId = mi.Offscreen \
        LEFT JOIN LayerThumbnail lt ON lt.LayerId = l.MainId AND lt.CanvasId = l.CanvasId \
        LEFT JOIN Canvas c ON c.MainId = l.CanvasId \
        WHERE mi.ThisScale >= 99.0 \
        ORDER BY (l.LayerName = '') DESC, \
                 (COALESCE(lt.ThumbnailCanvasWidth, CAST(c.CanvasWidth AS INTEGER), 0) * \
                  COALESCE(lt.ThumbnailCanvasHeight, CAST(c.CanvasHeight AS INTEGER), 0)) DESC \
        LIMIT 24";

    if let Ok(mut stmt) = conn.prepare(joined_sql) {
        let rows = stmt
            .query_map([], |row| {
                let block_data: Vec<u8> = row.get(0)?;
                let width: i64 = row.get(1)?;
                let height: i64 = row.get(2)?;
                Ok((block_data, width.max(0) as u32, height.max(0) as u32))
            })
            .map_err(|e| format!("Failed reading CLIP external candidates: {}", e))?;

        for row in rows {
            let (block_data, width, height) = row.map_err(|e| e.to_string())?;
            let external_id = String::from_utf8_lossy(&block_data).trim().to_string();
            if external_id.is_empty() || seen.contains(&external_id) {
                continue;
            }
            seen.insert(external_id.clone());
            out.push(ClipExternalCandidate {
                external_id,
                width,
                height,
            });
        }
    }

    if out.is_empty() {
        let mut stmt = conn
            .prepare("SELECT BlockData FROM Offscreen LIMIT 24")
            .map_err(|e| format!("Failed reading CLIP Offscreen rows: {}", e))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, Vec<u8>>(0))
            .map_err(|e| format!("Failed iterating CLIP Offscreen rows: {}", e))?;

        for row in rows {
            let block_data = row.map_err(|e| e.to_string())?;
            let external_id = String::from_utf8_lossy(&block_data).trim().to_string();
            if external_id.is_empty() || seen.contains(&external_id) {
                continue;
            }
            seen.insert(external_id.clone());
            out.push(ClipExternalCandidate {
                external_id,
                width: 0,
                height: 0,
            });
        }
    }

    Ok(out)
}

fn extract_external_data_by_id(
    file_bytes: &[u8],
    external_chunks: &[ClipChunkRange],
    target_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    for chunk in external_chunks {
        let Some(external_id) = read_external_id_from_chunk(file_bytes, *chunk)? else {
            continue;
        };
        if external_id != target_id {
            continue;
        }
        let data = read_external_data_from_chunk(file_bytes, *chunk)?;
        return Ok(Some(data));
    }
    Ok(None)
}

fn read_external_id_from_chunk(
    file_bytes: &[u8],
    chunk: ClipChunkRange,
) -> Result<Option<String>, String> {
    if chunk.end <= chunk.start || chunk.end > file_bytes.len() {
        return Ok(None);
    }

    let mut offset = chunk.start + 16;
    if offset + 8 > chunk.end {
        return Ok(None);
    }

    let external_id_len = u64::from_be_bytes(
        file_bytes[offset..offset + 8]
            .try_into()
            .map_err(|_| "Invalid CHNKExta external-id length".to_string())?,
    ) as usize;
    offset += 8;
    if offset + external_id_len > chunk.end {
        return Ok(None);
    }

    let external_id = String::from_utf8_lossy(&file_bytes[offset..offset + external_id_len]).to_string();
    Ok(Some(external_id))
}

fn read_external_data_from_chunk(file_bytes: &[u8], chunk: ClipChunkRange) -> Result<Vec<u8>, String> {
    if chunk.end <= chunk.start || chunk.end > file_bytes.len() {
        return Err("Invalid CHNKExta chunk range".to_string());
    }

    let mut offset = chunk.start + 16;
    if offset + 8 > chunk.end {
        return Err("Invalid CHNKExta header".to_string());
    }

    let external_id_len = u64::from_be_bytes(
        file_bytes[offset..offset + 8]
            .try_into()
            .map_err(|_| "Invalid CHNKExta external-id length".to_string())?,
    ) as usize;
    offset += 8;
    if offset + external_id_len > chunk.end {
        return Err("CHNKExta external-id exceeds chunk".to_string());
    }
    offset += external_id_len;

    // External size field (unused by the reference parser).
    if offset + 8 > chunk.end {
        return Err("Invalid CHNKExta external-size field".to_string());
    }
    offset += 8;

    let mut external_data = Vec::<u8>::new();
    while offset < chunk.end {
        if offset + 8 > chunk.end {
            break;
        }

        let block_start = offset;
        let size_01 = u32::from_be_bytes(
            file_bytes[offset..offset + 4]
                .try_into()
                .map_err(|_| "Invalid external block size_01".to_string())?,
        ) as usize;
        offset += 4;
        let size_02 = u32::from_be_bytes(
            file_bytes[offset..offset + 4]
                .try_into()
                .map_err(|_| "Invalid external block size_02".to_string())?,
        ) as usize;
        offset += 4;

        let (block_name_len, block_data_len) = if size_02 == 0x0042_006C {
            offset = block_start + 4;
            (size_01, 0usize)
        } else {
            (size_02, size_01)
        };

        if block_name_len == 0 {
            break;
        }

        let name_bytes_len = block_name_len.saturating_mul(2);
        if offset + name_bytes_len > chunk.end {
            break;
        }
        let block_name = if block_name_len < 256 {
            decode_utf16be(&file_bytes[offset..offset + name_bytes_len])
        } else {
            String::new()
        };
        offset += name_bytes_len;

        let payload_start = offset;
        let mut block_end = payload_start.saturating_add(block_data_len).min(chunk.end);

        if block_name == "BlockDataBeginChunk" {
            if offset + 20 > chunk.end {
                break;
            }

            // block index (unused)
            offset += 4;
            let block_uncompressed_size = u32::from_be_bytes(
                file_bytes[offset..offset + 4]
                    .try_into()
                    .map_err(|_| "Invalid block uncompressed size".to_string())?,
            ) as usize;
            offset += 4;

            // block width + block height (unused)
            offset += 8;

            let exist_flag = u32::from_be_bytes(
                file_bytes[offset..offset + 4]
                    .try_into()
                    .map_err(|_| "Invalid block exist flag".to_string())?,
            );
            offset += 4;

            if exist_flag > 0 {
                if offset + 8 > chunk.end {
                    break;
                }
                let block_len = u32::from_be_bytes(
                    file_bytes[offset..offset + 4]
                        .try_into()
                        .map_err(|_| "Invalid compressed block length".to_string())?,
                ) as usize;
                offset += 4;
                let block_len_2 = u32::from_le_bytes(
                    file_bytes[offset..offset + 4]
                        .try_into()
                        .map_err(|_| "Invalid compressed block length(LE)".to_string())?,
                ) as usize;
                offset += 4;

                if offset + block_len_2 > chunk.end {
                    break;
                }
                let block_zlib_data = &file_bytes[offset..offset + block_len_2];

                let mut decoder = ZlibDecoder::new(block_zlib_data);
                let mut block = Vec::with_capacity(block_uncompressed_size);
                decoder
                    .read_to_end(&mut block)
                    .map_err(|e| format!("Failed to decompress CLIP block: {}", e))?;
                external_data.extend_from_slice(&block);

                block_end = payload_start.saturating_add(24 + block_len).min(chunk.end);
            } else {
                external_data.extend(std::iter::repeat_n(0u8, block_uncompressed_size));
                block_end = payload_start.saturating_add(20).min(chunk.end);
            }
        }

        if block_end <= block_start {
            break;
        }
        offset = block_end;
    }

    Ok(external_data)
}

fn decode_utf16be(bytes: &[u8]) -> String {
    let mut units = Vec::<u16>::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        units.push(u16::from_be_bytes([chunk[0], chunk[1]]));
    }
    String::from_utf16_lossy(&units)
}

fn clip_external_data_to_image(
    external_data: &[u8],
    image_width: u32,
    image_height: u32,
) -> Result<image::DynamicImage, String> {
    if image_width == 0 || image_height == 0 {
        return Err("Invalid CLIP external image size".to_string());
    }

    let block_size: usize = 256 * 256;
    let block_payload_size: usize = 256 * 320 * 4;
    let blocks_per_row = ((image_height + 255) / 256) as usize;
    let blocks_per_col = ((image_width + 255) / 256) as usize;
    let total_blocks = blocks_per_row.saturating_mul(blocks_per_col);
    let expected_size = total_blocks.saturating_mul(block_payload_size);
    if external_data.len() < expected_size {
        return Err(format!(
            "CLIP external data too small (expected at least {}, got {})",
            expected_size,
            external_data.len()
        ));
    }

    // Parallelize per-block conversion before stitching to the final image.
    let tiles: Vec<(usize, Vec<u8>)> = (0..total_blocks)
        .into_par_iter()
        .map(|block_index| {
            let block_address = block_index * block_payload_size;
            let block = &external_data[block_address..block_address + block_payload_size];
            let alpha_block = &block[0..block_size];
            let bgra_block = &block[block_size..];

            let mut rgba_tile = vec![0u8; block_size * 4];
            for i in 0..block_size {
                let src = i * 4;
                let dst = i * 4;
                rgba_tile[dst] = bgra_block[src + 2];
                rgba_tile[dst + 1] = bgra_block[src + 1];
                rgba_tile[dst + 2] = bgra_block[src];
                rgba_tile[dst + 3] = alpha_block[i];
            }
            (block_index, rgba_tile)
        })
        .collect();

    let width = image_width as usize;
    let height = image_height as usize;
    let mut rgba = vec![0u8; width.saturating_mul(height).saturating_mul(4)];

    for (block_index, tile) in tiles {
        let block_x = block_index % blocks_per_col;
        let block_y = block_index / blocks_per_col;
        let dst_x = block_x * 256;
        let dst_y = block_y * 256;

        if dst_x >= width || dst_y >= height {
            continue;
        }

        let copy_w = (width - dst_x).min(256);
        let copy_h = (height - dst_y).min(256);
        for row in 0..copy_h {
            let src_row_start = row * 256 * 4;
            let src_row_end = src_row_start + copy_w * 4;
            let dst_row_start = ((dst_y + row) * width + dst_x) * 4;
            let dst_row_end = dst_row_start + copy_w * 4;
            rgba[dst_row_start..dst_row_end].copy_from_slice(&tile[src_row_start..src_row_end]);
        }
    }

    let img = image::RgbaImage::from_raw(image_width, image_height, rgba)
        .ok_or_else(|| "Failed to build CLIP image buffer".to_string())?;
    Ok(image::DynamicImage::ImageRgba8(img))
}

/// Generate thumbnail: resize to 256px max dimension, save as PNG.
pub fn generate_thumbnail(
    library_root: &Path,
    relative_path: &str,
    img: &image::DynamicImage,
) -> Result<u64, String> {
    let thumb_path = thumbnails::ensure_thumbnail_dir(library_root, relative_path)?;

    // Resize to max 256px on the longest side
    let thumb_img = img.thumbnail(256, 256);

    // Save as PNG (WebP encoding may not be available in image 0.25 by default)
    let file = std::fs::File::create(&thumb_path)
        .map_err(|e| format!("Failed to create thumbnail file: {}", e))?;
    let mut writer = std::io::BufWriter::new(file);
    thumb_img
        .write_to(&mut writer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to write thumbnail: {}", e))?;

    // Return mtime of the written thumbnail
    let metadata = fs::metadata(&thumb_path)
        .map_err(|e| format!("Failed to read thumbnail metadata: {}", e))?;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(mtime)
}

/// Extract the dominant color from an image by resizing to 16x16 and averaging pixels.
fn extract_dominant_color(img: &image::DynamicImage) -> Option<String> {
    let tiny = img.thumbnail(16, 16);
    let mut r_sum: u64 = 0;
    let mut g_sum: u64 = 0;
    let mut b_sum: u64 = 0;
    let mut count: u64 = 0;

    for pixel in tiny.pixels() {
        let rgba = pixel.2;
        // Skip mostly-transparent pixels
        if rgba[3] < 128 {
            continue;
        }
        r_sum += rgba[0] as u64;
        g_sum += rgba[1] as u64;
        b_sum += rgba[2] as u64;
        count += 1;
    }

    if count == 0 {
        return None;
    }

    let r = (r_sum / count) as u8;
    let g = (g_sum / count) as u8;
    let b = (b_sum / count) as u8;

    Some(format!("#{:02x}{:02x}{:02x}", r, g, b))
}

/// Represents a file discovered on disk.
#[derive(Clone)]
struct DiscoveredFile {
    relative_path: String,
    abs_path: PathBuf,
    size: u64,
    modified: u64,
    asset_type: String,
    name: String,
}

/// Represents an existing asset in the DB.
struct DbAsset {
    id: String,
    relative_path: String,
    modified_at: u64,
    size: u64,
}

/// The main 4-phase scan orchestrator.
pub fn scan_library(
    library_root: &Path,
    db_path: &Path,
    app_handle: &AppHandle,
) -> Result<ScanReport, String> {
    let mut report = ScanReport {
        added: 0,
        updated: 0,
        deleted: 0,
        errors: Vec::new(),
    };

    let _ = app_handle.emit(
        "scan-progress",
        ScanProgress {
            phase: "discovering".to_string(),
            scanned: 0,
            total: 0,
        },
    );

    // ── Phase 1: Walk directory tree ──────────────────────────────────
    let discovered = phase1_discover(library_root, app_handle);

    let _ = app_handle.emit(
        "scan-progress",
        ScanProgress {
            phase: "diffing".to_string(),
            scanned: 0,
            total: discovered.len() as u32,
        },
    );

    // ── Phase 2: Diff against DB ──────────────────────────────────────
    let conn = library::get_db_connection(db_path)?;
    let db_assets = load_db_assets(&conn)?;
    let (new_files, changed_files, deleted_ids) =
        phase2_diff(&discovered, &db_assets);

    report.deleted = deleted_ids.len() as u32;

    // Delete removed assets from DB
    for id in &deleted_ids {
        let _ = conn.execute("DELETE FROM assets WHERE id = ?1", rusqlite::params![id]);
        // Also remove orphaned thumbnail
        if let Some(rel) = db_assets.get(id) {
            let thumb_path = thumbnails::thumbnail_abs_path(library_root, &rel.relative_path);
            let _ = fs::remove_file(&thumb_path);
        }
    }

    let files_to_process: Vec<&DiscoveredFile> = new_files.iter().copied().chain(changed_files.iter().copied()).collect();
    let total_to_process = files_to_process.len() as u32;

    let _ = app_handle.emit(
        "scan-progress",
        ScanProgress {
            phase: "processing".to_string(),
            scanned: 0,
            total: total_to_process,
        },
    );

    // ── Phase 3: Parallel processing (thumbnails, color, pHash) ──────
    let scanned_counter = AtomicU32::new(0);
    let errors_mutex: Mutex<Vec<ScanError>> = Mutex::new(Vec::new());

    let results: Vec<(String, DiscoveredFile, Option<ImageProcessResult>)> = files_to_process
        .par_iter()
        .map(|file| {
            let scanned = scanned_counter.fetch_add(1, Ordering::Relaxed) + 1;
            if scanned % 100 == 0 || scanned == total_to_process {
                let _ = app_handle.emit(
                    "scan-progress",
                    ScanProgress {
                        phase: "processing".to_string(),
                        scanned,
                        total: total_to_process,
                    },
                );
            }

            let img_result = match file.asset_type.as_str() {
                "image" => Some(process_image(library_root, &file.relative_path, &file.abs_path)),
                "video" => Some(process_video(library_root, &file.relative_path, &file.abs_path)),
                _ => None,
            };

            (file.relative_path.clone(), (*file).clone(), img_result)
        })
        .collect();

    // Collect errors from parallel phase
    if let Ok(mut errs) = errors_mutex.lock() {
        report.errors.append(&mut errs);
    }

    // ── Phase 4: Batch DB write ───────────────────────────────────────
    let _ = app_handle.emit(
        "scan-progress",
        ScanProgress {
            phase: "writing".to_string(),
            scanned: 0,
            total: results.len() as u32,
        },
    );

    let is_new_set: std::collections::HashSet<String> = new_files
        .iter()
        .map(|f| f.relative_path.clone())
        .collect();

    let now = library::now_secs();

    for (i, (_rel, file, img_result)) in results.iter().enumerate() {
        let abs_path_str = file.abs_path.to_string_lossy().to_string();
        let id = abs_path_str.clone();

        if i % 100 == 0 {
            let _ = app_handle.emit(
                "scan-progress",
                ScanProgress {
                    phase: "writing".to_string(),
                    scanned: i as u32,
                    total: results.len() as u32,
                },
            );
        }

        let is_new = is_new_set.contains(&file.relative_path);

        if is_new {
            // INSERT new asset
            let (dominant_color, width, height, p_hash, thumbnail_mtime) = match img_result {
                Some(r) => (
                    r.dominant_color.clone(),
                    Some(r.width),
                    Some(r.height),
                    r.p_hash.clone(),
                    r.thumbnail_mtime,
                ),
                None => (None, None, None, None, None),
            };

            let result = conn.execute(
                "INSERT INTO assets (id, name, path, relative_path, asset_type, size,
                    dominant_color, tags, description, rating, workspace_ids,
                    created_at, modified_at, p_hash, is_trashed, width, height,
                    source_url, duration, thumbnail_mtime)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', '', NULL, '[]',
                    ?8, ?9, ?10, 0, ?11, ?12, NULL, NULL, ?13)",
                rusqlite::params![
                    id,
                    file.name,
                    abs_path_str,
                    file.relative_path,
                    file.asset_type,
                    file.size as i64,
                    dominant_color,
                    now,
                    file.modified,
                    p_hash,
                    width,
                    height,
                    thumbnail_mtime,
                ],
            );

            match result {
                Ok(_) => report.added += 1,
                Err(e) => report.errors.push(ScanError {
                    path: abs_path_str,
                    message: format!("DB insert failed: {}", e),
                }),
            }
        } else {
            // UPDATE changed asset
            let (dominant_color, width, height, p_hash, thumbnail_mtime) = match img_result {
                Some(r) => (
                    r.dominant_color.clone(),
                    Some(r.width),
                    Some(r.height),
                    r.p_hash.clone(),
                    r.thumbnail_mtime,
                ),
                None => (None, None, None, None, None),
            };

            let result = conn.execute(
                "UPDATE assets SET name = ?1, path = ?2, size = ?3, modified_at = ?4,
                    asset_type = ?5, dominant_color = ?6, width = ?7, height = ?8,
                    p_hash = ?9, thumbnail_mtime = ?10
                 WHERE id = ?11",
                rusqlite::params![
                    file.name,
                    abs_path_str,
                    file.size as i64,
                    file.modified,
                    file.asset_type,
                    dominant_color,
                    width,
                    height,
                    p_hash,
                    thumbnail_mtime,
                    id,
                ],
            );

            match result {
                Ok(_) => report.updated += 1,
                Err(e) => report.errors.push(ScanError {
                    path: abs_path_str,
                    message: format!("DB update failed: {}", e),
                }),
            }
        }
    }

    // Rebuild folder cache
    rebuild_folders(&conn, library_root)?;

    let _ = app_handle.emit(
        "scan-progress",
        ScanProgress {
            phase: "done".to_string(),
            scanned: results.len() as u32,
            total: results.len() as u32,
        },
    );

    Ok(report)
}

/// Phase 1: Walk the directory tree and discover all indexable files.
fn phase1_discover(library_root: &Path, app_handle: &AppHandle) -> Vec<DiscoveredFile> {
    let mut files = Vec::new();

    for entry in walkdir::WalkDir::new(library_root)
        .into_iter()
        .filter_entry(|e| {
            // Skip .quickasset internal directory
            e.file_name() != ".quickasset"
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();

        // Get extension
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_lowercase(),
            None => continue,
        };

        if !is_indexable_ext(&ext) {
            continue;
        }

        let metadata = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let relative_path = path
            .strip_prefix(library_root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string()
            .replace('\\', "/");

        let abs_path = path.to_path_buf();
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        files.push(DiscoveredFile {
            relative_path,
            abs_path,
            size: metadata.len(),
            modified,
            asset_type: asset_type_for_ext(&ext).to_string(),
            name,
        });
    }

    let _ = app_handle.emit(
        "scan-progress",
        ScanProgress {
            phase: "discovering".to_string(),
            scanned: files.len() as u32,
            total: files.len() as u32,
        },
    );

    files
}

/// Load existing assets from DB for diff comparison.
fn load_db_assets(conn: &Connection) -> Result<HashMap<String, DbAsset>, String> {
    let mut stmt = conn
        .prepare("SELECT id, relative_path, modified_at, size FROM assets")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(DbAsset {
                id: row.get::<_, String>(0)?,
                relative_path: row.get::<_, String>(1)?,
                modified_at: row.get::<_, u64>(2)?,
                size: row.get::<_, i64>(3)? as u64,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut map = HashMap::new();
    for row in rows {
        let asset = row.map_err(|e: rusqlite::Error| e.to_string())?;
        map.insert(asset.id.clone(), asset);
    }

    Ok(map)
}

/// Phase 2: Compare discovered files against DB to find new, changed, and deleted.
fn phase2_diff<'a>(
    discovered: &'a [DiscoveredFile],
    db_assets: &HashMap<String, DbAsset>,
) -> (Vec<&'a DiscoveredFile>, Vec<&'a DiscoveredFile>, Vec<String>) {
    let mut new_files = Vec::new();
    let mut changed_files = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    for file in discovered {
        let id = file.abs_path.to_string_lossy().to_string();
        seen_ids.insert(id.clone());

        match db_assets.get(&id) {
            None => {
                new_files.push(file);
            }
            Some(db_asset) => {
                // Check if file has changed (size or modification time differs)
                if file.size != db_asset.size || file.modified != db_asset.modified_at {
                    changed_files.push(file);
                }
            }
        }
    }

    // Find deleted: in DB but not on disk
    let deleted_ids: Vec<String> = db_assets
        .keys()
        .filter(|id| !seen_ids.contains(*id))
        .cloned()
        .collect();

    (new_files, changed_files, deleted_ids)
}

/// Rebuild the folder cache table from the assets in the DB.
/// Preserves existing `show_subfolders` values for folders that already exist.
pub fn rebuild_folders(conn: &Connection, library_root: &Path) -> Result<(), String> {
    // Read existing show_subfolders values before clearing
    let mut existing_subfolders: HashMap<String, bool> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT path, show_subfolders FROM folders")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let path: String = row.get(0)?;
                let show: i64 = row.get(1).unwrap_or(1);
                Ok((path, show != 0))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            if let Ok((path, show)) = row {
                existing_subfolders.insert(path, show);
            }
        }
    }

    // Clear existing folder cache
    conn.execute("DELETE FROM folders", [])
        .map_err(|e| format!("Failed to clear folders: {}", e))?;

    // Collect all unique folders from assets
    let mut stmt = conn
        .prepare("SELECT relative_path FROM assets WHERE is_trashed = 0")
        .map_err(|e| e.to_string())?;

    let paths: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // Count assets per folder using normalized "/" separators.
    let mut folder_counts: HashMap<String, u32> = HashMap::new();
    for rel_path in &paths {
        let normalized = rel_path.replace('\\', "/");
        if let Some(idx) = normalized.rfind('/') {
            let mut current = normalized[..idx].to_string();
            while !current.is_empty() {
                *folder_counts.entry(current.clone()).or_insert(0) += 1;
                if let Some(parent_idx) = current.rfind('/') {
                    current.truncate(parent_idx);
                } else {
                    break;
                }
            }
        }
    }

    // Insert into folders table, preserving show_subfolders
    let mut insert_stmt = conn
        .prepare(
            "INSERT OR REPLACE INTO folders (path, parent_path, display_name, asset_count, show_subfolders) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(|e| e.to_string())?;

    for (folder, count) in &folder_counts {
        let display_name = folder
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string();
        let parent_path = folder
            .rsplit_once('/')
            .map(|(p, _)| p.to_string())
            .unwrap_or_default();

        // Preserve existing show_subfolders value, default to true (1)
        let show_subfolders: bool = existing_subfolders.get(folder).copied().unwrap_or(true);

        insert_stmt
            .execute(rusqlite::params![folder, parent_path, display_name, count, show_subfolders])
            .map_err(|e| format!("Failed to insert folder: {}", e))?;
    }

    let _ = library_root;

    Ok(())
}

/// Process a single file: index it into the database (insert new or update existing).
/// This is used for file-watcher events where a single file has been added or modified.
pub fn process_single_file(
    conn: &Connection,
    library_root: &Path,
    abs_path: &Path,
) -> Result<(), String> {
    // Get extension and check indexable
    let ext = match abs_path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_lowercase(),
        None => return Ok(()), // Skip files without extension
    };

    if !is_indexable_ext(&ext) {
        return Ok(());
    }

    let metadata = match fs::metadata(abs_path) {
        Ok(m) => m,
        Err(e) => return Err(format!("Failed to read file metadata: {}", e)),
    };

    let relative_path = abs_path
        .strip_prefix(library_root)
        .unwrap_or(abs_path)
        .to_string_lossy()
        .to_string()
        .replace('\\', "/");

    let abs_path_str = abs_path.to_string_lossy().to_string();
    let id = abs_path_str.clone();
    let name = abs_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let asset_type = asset_type_for_ext(&ext).to_string();
    let size = metadata.len();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Process image-specific metadata
    let img_result = match asset_type.as_str() {
        "image" => Some(process_image(library_root, &relative_path, abs_path)),
        "video" => Some(process_video(library_root, &relative_path, abs_path)),
        _ => None,
    };

    let (dominant_color, width, height, p_hash, thumbnail_mtime) = match img_result {
        Some(r) => (
            r.dominant_color,
            Some(r.width),
            Some(r.height),
            r.p_hash,
            r.thumbnail_mtime,
        ),
        None => (None, None, None, None, None),
    };

    let now = library::now_secs();

    // Check if asset already exists
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM assets WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false);

    if exists {
        // Update existing asset
        conn.execute(
            "UPDATE assets SET name = ?1, path = ?2, size = ?3, modified_at = ?4,
                asset_type = ?5, dominant_color = ?6, width = ?7, height = ?8,
                p_hash = ?9, thumbnail_mtime = ?10
             WHERE id = ?11",
            rusqlite::params![
                name,
                abs_path_str,
                size as i64,
                modified,
                asset_type,
                dominant_color,
                width,
                height,
                p_hash,
                thumbnail_mtime,
                id,
            ],
        )
        .map_err(|e| format!("DB update failed: {}", e))?;
    } else {
        // Insert new asset
        conn.execute(
            "INSERT INTO assets (id, name, path, relative_path, asset_type, size,
                dominant_color, tags, description, rating, workspace_ids,
                created_at, modified_at, p_hash, is_trashed, width, height,
                source_url, duration, thumbnail_mtime)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', '', NULL, '[]',
                ?8, ?9, ?10, 0, ?11, ?12, NULL, NULL, ?13)",
            rusqlite::params![
                id,
                name,
                abs_path_str,
                relative_path,
                asset_type,
                size as i64,
                dominant_color,
                now,
                modified,
                p_hash,
                width,
                height,
                thumbnail_mtime,
            ],
        )
        .map_err(|e| format!("DB insert failed: {}", e))?;
    }

    // Rebuild folder cache to reflect the new/updated asset
    rebuild_folders(conn, library_root)?;

    Ok(())
}
