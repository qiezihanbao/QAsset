use crate::library;
use reqwest::blocking::Client;
use reqwest::header::CONTENT_TYPE;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const WEB_IMPORT_ADDR: &str = "127.0.0.1:27124";
const WEB_IMPORT_PATH: &str = "/api/import-image";
const WEB_IMPORT_BYTES_PATH: &str = "/api/import-image-bytes";
const WEB_IMPORT_HEALTH_PATH: &str = "/health";
const MAX_URL_IMPORT_JSON_BYTES: usize = 16 * 1024;
const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct ImportImageRequest {
    #[serde(rename = "imageUrl", alias = "image_url")]
    image_url: String,
    #[serde(rename = "pageUrl", alias = "page_url")]
    page_url: Option<String>,
    #[serde(rename = "pageTitle", alias = "page_title")]
    page_title: Option<String>,
}

#[derive(Debug, Serialize)]
struct ImportImageResponse {
    ok: bool,
    asset_path: String,
    relative_path: String,
    source_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    ok: bool,
    error: String,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    ok: bool,
    service: String,
    endpoint: String,
    upload_endpoint: String,
}

#[derive(Debug, Serialize, Clone)]
struct WebImportProgress {
    phase: String,
    step: u32,
    total: u32,
    message: String,
}

#[derive(Debug)]
struct HttpError {
    status: StatusCode,
    message: String,
}

impl HttpError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode(400),
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode(401),
            message: message.into(),
        }
    }

    fn payload_too_large(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode(413),
            message: message.into(),
        }
    }

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode(502),
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode(500),
            message: message.into(),
        }
    }
}

fn emit_web_import_progress(
    app_handle: &AppHandle,
    phase: &str,
    step: u32,
    total: u32,
    message: impl Into<String>,
) {
    let _ = app_handle.emit(
        "web-import-progress",
        WebImportProgress {
            phase: phase.to_string(),
            step,
            total,
            message: message.into(),
        },
    );
}

pub fn start_web_import_server(app_handle: AppHandle) {
    std::thread::spawn(move || {
        let server = match Server::http(WEB_IMPORT_ADDR) {
            Ok(server) => server,
            Err(err) => {
                log::warn!(
                    "Web import server failed to bind on {}: {}",
                    WEB_IMPORT_ADDR,
                    err
                );
                return;
            }
        };

        log::info!(
            "Web import server listening at http://{}{}",
            WEB_IMPORT_ADDR,
            WEB_IMPORT_PATH
        );

        for request in server.incoming_requests() {
            handle_request(request, &app_handle);
        }
    });
}

fn handle_request(mut request: Request, app_handle: &AppHandle) {
    let method = request.method().clone();
    let raw_url = request.url().to_string();
    let path = raw_url.split('?').next().unwrap_or(&raw_url);

    if method == Method::Options {
        respond_with_empty(request, StatusCode(204));
        return;
    }

    if method == Method::Get && path == WEB_IMPORT_HEALTH_PATH {
        let health = HealthResponse {
            ok: true,
            service: "quickasset-web-import".to_string(),
            endpoint: format!("http://{}{}", WEB_IMPORT_ADDR, WEB_IMPORT_PATH),
            upload_endpoint: format!("http://{}{}", WEB_IMPORT_ADDR, WEB_IMPORT_BYTES_PATH),
        };
        respond_with_json(request, StatusCode(200), &health);
        return;
    }

    if method != Method::Post {
        let err = ErrorResponse {
            ok: false,
            error: "Not found".to_string(),
        };
        respond_with_json(request, StatusCode(404), &err);
        return;
    }

    if path != WEB_IMPORT_PATH && path != WEB_IMPORT_BYTES_PATH {
        let err = ErrorResponse {
            ok: false,
            error: "Not found".to_string(),
        };
        respond_with_json(request, StatusCode(404), &err);
        return;
    }

    if let Err(err) = enforce_auth(&request) {
        let error = ErrorResponse {
            ok: false,
            error: err.message,
        };
        respond_with_json(request, err.status, &error);
        return;
    }

    let result = if path == WEB_IMPORT_PATH {
        handle_url_import_request(&mut request, app_handle)
    } else {
        handle_bytes_import_request(&mut request, app_handle, &raw_url)
    };

    match result {
        Ok(data) => {
            respond_with_json(request, StatusCode(200), &data);
        }
        Err(http_err) => {
            emit_web_import_progress(
                app_handle,
                "failed",
                0,
                0,
                format!("导入失败: {}", http_err.message),
            );
            let error = ErrorResponse {
                ok: false,
                error: http_err.message,
            };
            respond_with_json(request, http_err.status, &error);
        }
    }
}

fn enforce_auth(request: &Request) -> Result<(), HttpError> {
    let expected_token = std::env::var("QUICKASSET_WEB_IMPORT_TOKEN")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if let Some(token) = expected_token {
        let provided = read_bearer_token(request).unwrap_or_default();
        if provided != token {
            return Err(HttpError::unauthorized("Unauthorized"));
        }
    }
    Ok(())
}

fn handle_url_import_request(
    request: &mut Request,
    app_handle: &AppHandle,
) -> Result<ImportImageResponse, HttpError> {
    let body_len = request.body_length().unwrap_or(0);
    if body_len > MAX_URL_IMPORT_JSON_BYTES {
        return Err(HttpError::payload_too_large("Request body too large"));
    }

    let mut body_bytes = Vec::with_capacity(body_len.min(MAX_URL_IMPORT_JSON_BYTES));
    request
        .as_reader()
        .read_to_end(&mut body_bytes)
        .map_err(|e| HttpError::bad_request(format!("Failed to read request body: {}", e)))?;

    if body_bytes.len() > MAX_URL_IMPORT_JSON_BYTES {
        return Err(HttpError::payload_too_large("Request body too large"));
    }

    let payload: ImportImageRequest = serde_json::from_slice(&body_bytes)
        .map_err(|e| HttpError::bad_request(format!("Invalid JSON payload: {}", e)))?;

    import_image_from_web(app_handle, payload)
}

fn handle_bytes_import_request(
    request: &mut Request,
    app_handle: &AppHandle,
    raw_url: &str,
) -> Result<ImportImageResponse, HttpError> {
    let body_len = request.body_length().unwrap_or(0);
    if body_len > MAX_IMAGE_BYTES {
        return Err(HttpError::payload_too_large("Request body too large"));
    }

    let mut body_bytes = Vec::with_capacity(body_len.min(MAX_IMAGE_BYTES));
    request
        .as_reader()
        .read_to_end(&mut body_bytes)
        .map_err(|e| HttpError::bad_request(format!("Failed to read request body: {}", e)))?;
    if body_bytes.is_empty() {
        return Err(HttpError::bad_request("Uploaded image is empty"));
    }
    if body_bytes.len() > MAX_IMAGE_BYTES {
        return Err(HttpError::payload_too_large("Uploaded image is too large"));
    }

    let source_url = query_param(raw_url, "sourceUrl");
    let page_url = query_param(raw_url, "pageUrl");
    let page_title = query_param(raw_url, "pageTitle");
    let file_name = query_param(raw_url, "fileName");
    let content_type = query_param(raw_url, "contentType").or_else(|| {
        read_header_value(request, "Content-Type")
            .map(|v| v.split(';').next().unwrap_or("").trim().to_string())
    });

    import_image_from_bytes(
        app_handle,
        &body_bytes,
        source_url.as_deref(),
        page_url.as_deref(),
        page_title.as_deref(),
        file_name.as_deref(),
        content_type.as_deref(),
    )
}

fn query_param(raw_url: &str, key: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(&format!("http://localhost{}", raw_url)).ok()?;
    parsed
        .query_pairs()
        .find_map(|(k, v)| (k == key).then(|| v.trim().to_string()))
        .filter(|v| !v.is_empty())
}

fn read_header_value(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().trim().to_string())
        .filter(|v| !v.is_empty())
}

fn resolve_library_state(app_handle: &AppHandle) -> Result<(PathBuf, PathBuf), HttpError> {
    let state = app_handle.state::<crate::library::AppState>();
    let library_root = state
        .library_root
        .read()
        .map_err(|e| HttpError::internal(format!("State lock failed: {}", e)))?
        .clone()
        .ok_or_else(|| HttpError::bad_request("No library is currently open"))?;
    let db_path = state
        .db_path
        .read()
        .map_err(|e| HttpError::internal(format!("State lock failed: {}", e)))?
        .clone()
        .ok_or_else(|| HttpError::bad_request("No library is currently open"))?;
    Ok((library_root, db_path))
}

fn store_image_and_index(
    app_handle: &AppHandle,
    library_root: &Path,
    db_path: &Path,
    bytes: &[u8],
    base_name: &str,
    ext: &str,
    source_url: Option<String>,
) -> Result<ImportImageResponse, HttpError> {
    let import_dir = library_root.join("_web_clip");
    fs::create_dir_all(&import_dir).map_err(|e| {
        HttpError::internal(format!(
            "Failed to create import folder '{}': {}",
            import_dir.display(),
            e
        ))
    })?;

    let target_path = unique_target_path(&import_dir, base_name, ext);
    fs::write(&target_path, bytes).map_err(|e| {
        HttpError::internal(format!(
            "Failed to save downloaded image '{}': {}",
            target_path.display(),
            e
        ))
    })?;

    let conn = library::get_db_connection(db_path)
        .map_err(|e| HttpError::internal(format!("Open DB failed: {}", e)))?;

    crate::scanner::process_single_file(&conn, library_root, &target_path)
        .map_err(|e| HttpError::internal(format!("Index asset failed: {}", e)))?;

    let asset_id = target_path.to_string_lossy().to_string();
    let existing_tags = conn
        .query_row(
            "SELECT tags FROM assets WHERE id = ?1",
            rusqlite::params![asset_id.clone()],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap_or(None);
    let merged_tags = merge_tags_json(existing_tags.as_deref(), &["web", "clip"]);

    conn.execute(
        "UPDATE assets SET source_url = ?1, tags = ?2 WHERE id = ?3",
        rusqlite::params![source_url.clone(), merged_tags, asset_id],
    )
    .map_err(|e| HttpError::internal(format!("Update metadata failed: {}", e)))?;

    let relative_path = target_path
        .strip_prefix(library_root)
        .unwrap_or(&target_path)
        .to_string_lossy()
        .to_string()
        .replace('\\', "/");

    let _ = app_handle.emit("fs-event", serde_json::json!({ "event_type": "sync" }));

    Ok(ImportImageResponse {
        ok: true,
        asset_path: target_path.to_string_lossy().to_string(),
        relative_path,
        source_url,
    })
}

fn import_image_from_bytes(
    app_handle: &AppHandle,
    bytes: &[u8],
    source_url: Option<&str>,
    page_url: Option<&str>,
    page_title: Option<&str>,
    file_name: Option<&str>,
    content_type: Option<&str>,
) -> Result<ImportImageResponse, HttpError> {
    if bytes.is_empty() {
        return Err(HttpError::bad_request("Uploaded image is empty"));
    }

    emit_web_import_progress(
        app_handle,
        "downloading",
        1,
        4,
        "已接收浏览器图片数据",
    );

    let (library_root, db_path) = resolve_library_state(app_handle)?;

    emit_web_import_progress(
        app_handle,
        "processing",
        2,
        4,
        "正在处理图片与重建哈希",
    );
    let ext = infer_extension_for_upload(source_url, file_name, content_type, bytes);
    let base_name = infer_base_name_for_upload(page_title, file_name, source_url);
    let source = page_url
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .or_else(|| {
            source_url
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string())
        });

    emit_web_import_progress(
        app_handle,
        "indexing",
        3,
        4,
        "正在写入素材库并更新索引",
    );
    let result = store_image_and_index(
        app_handle,
        &library_root,
        &db_path,
        bytes,
        &base_name,
        &ext,
        source,
    )?;
    emit_web_import_progress(app_handle, "done", 4, 4, "导入完成");
    Ok(result)
}

fn infer_extension_for_upload(
    source_url: Option<&str>,
    file_name: Option<&str>,
    content_type: Option<&str>,
    bytes: &[u8],
) -> String {
    if let Some(file_name) = file_name {
        if let Some(ext) = ext_from_file_name(file_name) {
            return ext;
        }
    }
    if let Some(url) = source_url {
        if let Some(ext) = ext_from_url(url) {
            return ext;
        }
    }
    if let Some(ext) = ext_from_content_type(content_type) {
        return ext;
    }
    if let Ok(format) = image::guess_format(bytes) {
        return match format {
            image::ImageFormat::Png => "png",
            image::ImageFormat::Jpeg => "jpg",
            image::ImageFormat::Gif => "gif",
            image::ImageFormat::WebP => "webp",
            image::ImageFormat::Bmp => "bmp",
            image::ImageFormat::Tiff => "tiff",
            image::ImageFormat::Ico => "ico",
            _ => "jpg",
        }
        .to_string();
    }
    "jpg".to_string()
}

fn infer_base_name_for_upload(
    page_title: Option<&str>,
    file_name: Option<&str>,
    source_url: Option<&str>,
) -> String {
    if let Some(title) = page_title.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return sanitize_file_stem(title);
    }

    if let Some(file_name) = file_name {
        if let Some(stem) = Path::new(file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            return sanitize_file_stem(stem);
        }
    }

    if let Some(url_str) = source_url {
        if let Ok(url) = reqwest::Url::parse(url_str) {
            let candidate = Path::new(url.path())
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("web-image-{}", library::now_secs()));
            return sanitize_file_stem(&candidate);
        }
    }

    format!("web-image-{}", library::now_secs())
}

fn import_image_from_web(
    app_handle: &AppHandle,
    payload: ImportImageRequest,
) -> Result<ImportImageResponse, HttpError> {
    let image_url = payload.image_url.trim().to_string();
    if image_url.is_empty() {
        return Err(HttpError::bad_request("imageUrl is required"));
    }

    let parsed = reqwest::Url::parse(&image_url)
        .map_err(|e| HttpError::bad_request(format!("Invalid imageUrl: {}", e)))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(HttpError::bad_request("Only http/https imageUrl is supported"));
    }

    let (library_root, db_path) = resolve_library_state(app_handle)?;
    emit_web_import_progress(app_handle, "downloading", 1, 4, "正在下载网络图片");

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .user_agent("QuickAsset-WebImporter/0.1")
        .build()
        .map_err(|e| HttpError::internal(format!("HTTP client build failed: {}", e)))?;

    let mut request_builder = client.get(parsed.clone());
    if let Some(referer) = payload
        .page_url
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        request_builder = request_builder.header("Referer", referer);
    }
    let response = request_builder
        .send()
        .map_err(|e| HttpError::bad_gateway(format!("Failed to download image: {}", e)))?;

    if !response.status().is_success() {
        return Err(HttpError::bad_gateway(format!(
            "Image download failed with status {}",
            response.status()
        )));
    }

    if let Some(content_len) = response.content_length() {
        if content_len as usize > MAX_IMAGE_BYTES {
            return Err(HttpError::payload_too_large(format!(
                "Image too large: {} bytes",
                content_len
            )));
        }
    }

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());

    let bytes = response
        .bytes()
        .map_err(|e| HttpError::bad_gateway(format!("Failed to read image bytes: {}", e)))?;
    if bytes.is_empty() {
        return Err(HttpError::bad_gateway("Downloaded image is empty"));
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(HttpError::payload_too_large(format!(
            "Image too large: {} bytes",
            bytes.len()
        )));
    }

    emit_web_import_progress(
        app_handle,
        "processing",
        2,
        4,
        "正在处理图片与重建哈希",
    );
    let ext = infer_extension(image_url.as_str(), content_type.as_deref(), &bytes);
    let base_name = infer_base_name(&payload, &parsed);
    let source_url = payload
        .page_url
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .or_else(|| Some(image_url.clone()));

    emit_web_import_progress(
        app_handle,
        "indexing",
        3,
        4,
        "正在写入素材库并更新索引",
    );
    let result = store_image_and_index(
        app_handle,
        &library_root,
        &db_path,
        bytes.as_ref(),
        &base_name,
        &ext,
        source_url,
    )?;
    emit_web_import_progress(app_handle, "done", 4, 4, "导入完成");
    Ok(result)
}

fn infer_extension(image_url: &str, content_type: Option<&str>, bytes: &[u8]) -> String {
    if let Some(ext) = ext_from_url(image_url) {
        return ext;
    }
    if let Some(ext) = ext_from_content_type(content_type) {
        return ext;
    }
    if let Ok(format) = image::guess_format(bytes) {
        return match format {
            image::ImageFormat::Png => "png",
            image::ImageFormat::Jpeg => "jpg",
            image::ImageFormat::Gif => "gif",
            image::ImageFormat::WebP => "webp",
            image::ImageFormat::Bmp => "bmp",
            image::ImageFormat::Tiff => "tiff",
            image::ImageFormat::Ico => "ico",
            _ => "jpg",
        }
        .to_string();
    }
    "jpg".to_string()
}

fn ext_from_url(image_url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(image_url).ok()?;
    let ext = Path::new(parsed.path())
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    normalize_ext(&ext)
}

fn ext_from_file_name(file_name: &str) -> Option<String> {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    normalize_ext(&ext)
}

fn ext_from_content_type(content_type: Option<&str>) -> Option<String> {
    let ct = content_type?;
    let main = ct.split(';').next().map(|s| s.trim().to_ascii_lowercase())?;
    match main.as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg".to_string()),
        "image/png" => Some("png".to_string()),
        "image/webp" => Some("webp".to_string()),
        "image/gif" => Some("gif".to_string()),
        "image/bmp" => Some("bmp".to_string()),
        "image/tiff" => Some("tiff".to_string()),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("ico".to_string()),
        "image/svg+xml" => Some("svg".to_string()),
        _ => None,
    }
}

fn normalize_ext(ext: &str) -> Option<String> {
    match ext.to_ascii_lowercase().as_str() {
        "jpeg" | "jpg" => Some("jpg".to_string()),
        "png" => Some("png".to_string()),
        "webp" => Some("webp".to_string()),
        "gif" => Some("gif".to_string()),
        "bmp" => Some("bmp".to_string()),
        "tif" | "tiff" => Some("tiff".to_string()),
        "ico" => Some("ico".to_string()),
        "svg" => Some("svg".to_string()),
        _ => None,
    }
}

fn infer_base_name(payload: &ImportImageRequest, url: &reqwest::Url) -> String {
    let mut candidate = payload
        .page_title
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
        .to_string();

    if candidate.is_empty() {
        candidate = Path::new(url.path())
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("web-image-{}", library::now_secs()));
    }

    sanitize_file_stem(&candidate)
}

fn sanitize_file_stem(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut previous_dash = false;
    for ch in raw.chars() {
        let keep = ch.is_ascii_alphanumeric() || ch == '_' || ch == '-';
        if keep {
            out.push(ch);
            previous_dash = false;
            continue;
        }
        if ch.is_whitespace() || ch == '.' {
            if !previous_dash {
                out.push('-');
                previous_dash = true;
            }
        }
    }

    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        return format!("web-image-{}", library::now_secs());
    }

    let max_len = 80;
    if trimmed.len() > max_len {
        trimmed[..max_len].trim_matches('-').to_string()
    } else {
        trimmed.to_string()
    }
}

fn unique_target_path(dir: &Path, base_name: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{}.{}", base_name, ext));
    if !candidate.exists() {
        return candidate;
    }

    let stamp = library::now_secs();
    candidate = dir.join(format!("{}-{}.{}", base_name, stamp, ext));
    if !candidate.exists() {
        return candidate;
    }

    for index in 2..=9999 {
        let path = dir.join(format!("{}-{}-{}.{}", base_name, stamp, index, ext));
        if !path.exists() {
            return path;
        }
    }

    dir.join(format!(
        "web-image-{}.{}",
        uuid::Uuid::new_v4().simple(),
        ext
    ))
}

fn merge_tags_json(existing: Option<&str>, additions: &[&str]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::new();

    if let Some(raw) = existing {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
            if let Some(arr) = value.as_array() {
                for item in arr {
                    let Some(tag) = item.as_str().map(|s| s.trim()).filter(|s| !s.is_empty()) else {
                        continue;
                    };
                    let tag_string = tag.to_string();
                    if seen.insert(tag_string.clone()) {
                        out.push(tag_string);
                    }
                }
            }
        }
    }

    for tag in additions {
        let t = tag.trim();
        if t.is_empty() {
            continue;
        }
        let tag_string = t.to_string();
        if seen.insert(tag_string.clone()) {
            out.push(tag_string);
        }
    }

    serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
}

fn read_bearer_token(request: &Request) -> Option<String> {
    for header in request.headers() {
        if !header.field.equiv("Authorization") {
            continue;
        }

        let value = header.value.as_str().trim();
        if let Some(stripped) = value.strip_prefix("Bearer ") {
            return Some(stripped.trim().to_string());
        }
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn respond_with_empty(request: Request, status: StatusCode) {
    let response = Response::empty(status)
        .with_header(header("Access-Control-Allow-Origin", "*"))
        .with_header(header(
            "Access-Control-Allow-Methods",
            "POST, GET, OPTIONS",
        ))
        .with_header(header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization",
        ));
    let _ = request.respond(response);
}

fn respond_with_json<T: Serialize>(request: Request, status: StatusCode, payload: &T) {
    let body = serde_json::to_vec(payload).unwrap_or_else(|_| {
        br#"{"ok":false,"error":"Failed to serialize response"}"#.to_vec()
    });

    let response = Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json; charset=utf-8"))
        .with_header(header("Access-Control-Allow-Origin", "*"))
        .with_header(header(
            "Access-Control-Allow-Methods",
            "POST, GET, OPTIONS",
        ))
        .with_header(header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization",
        ));
    let _ = request.respond(response);
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes())
        .expect("Invalid static HTTP header")
}
