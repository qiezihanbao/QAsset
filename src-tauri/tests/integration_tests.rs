use tempfile::tempdir;
use std::fs;
use app_lib::{init_db};

// Since tauri::State requires a running tauri app context which is hard to mock in unit tests,
// we will test the database initialization logic and basic struct types. 
// 
// For command tests, we normally need a tauri mock context.
// Here we will test the core database queries directly using rusqlite to verify our schema works.

#[test]
fn test_database_initialization() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test_assets.db");
    
    // Test initialization
    assert!(init_db(&db_path).is_ok());
    
    // Verify file created
    assert!(db_path.exists());
    
    // Verify we can open it and tables exist
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assets'").unwrap();
    let table_exists = stmt.exists([]).unwrap();
    assert!(table_exists);
    
    // Verify all columns exist
    let mut stmt = conn.prepare("PRAGMA table_info(assets)").unwrap();
    let columns: Vec<String> = stmt.query_map([], |row| row.get(1)).unwrap().filter_map(Result::ok).collect();
    
    assert!(columns.contains(&"id".to_string()));
    assert!(columns.contains(&"tags".to_string()));
    assert!(columns.contains(&"p_hash".to_string()));
    assert!(columns.contains(&"created_at".to_string()));
}

#[test]
fn test_asset_info_serialization() {
    let asset = app_lib::AssetInfo {
        id: "1".to_string(),
        name: "test.png".to_string(),
        path: "/path/to/test.png".to_string(),
        asset_type: "image".to_string(),
        size: 1024,
        dominant_color: Some("#ffffff".to_string()),
        thumbnail_base64: None,
        tags: Some("[\"tag1\"]".to_string()),
        description: Some("Test desc".to_string()),
        rating: Some(5),
        workspace_ids: None,
        created_at: 1234567890,
        modified_at: 1234567890,
        p_hash: None,
    };
    
    let json = serde_json::to_string(&asset).unwrap();
    assert!(json.contains("test.png"));
    assert!(json.contains("image"));
    assert!(json.contains("1234567890"));
}

#[test]
fn test_database_insert_and_query() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test_assets.db");
    init_db(&db_path).unwrap();
    
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    
    // Insert a mock asset
    conn.execute(
        "INSERT INTO assets (id, name, path, asset_type, size, dominant_color, tags, rating, p_hash) 
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params!["123", "test.png", "/fake/path/test.png", "image", 1024, "#ffffff", "[\"tag1\"]", 5, "base64hash"],
    ).unwrap();
    
    // Query it back
    let mut stmt = conn.prepare("SELECT name, size, rating, p_hash FROM assets WHERE id = '123'").unwrap();
    let (name, size, rating, p_hash): (String, u64, u8, String) = stmt.query_row([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    }).unwrap();
    
    assert_eq!(name, "test.png");
    assert_eq!(size, 1024);
    assert_eq!(rating, 5);
    assert_eq!(p_hash, "base64hash");
}

#[test]
fn test_database_update() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test_assets.db");
    init_db(&db_path).unwrap();
    
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    
    conn.execute(
        "INSERT INTO assets (id, name, path, asset_type, size) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params!["456", "update.png", "/fake/path", "image", 2048],
    ).unwrap();
    
    // Test the logic used in update_asset command
    conn.execute(
        "UPDATE assets SET tags = ?1, description = ?2, rating = ?3 WHERE id = ?4",
        rusqlite::params![Some("[\"new\"]"), Some("updated desc"), Some(4), "456"],
    ).unwrap();
    
    let mut stmt = conn.prepare("SELECT tags, description, rating FROM assets WHERE id = '456'").unwrap();
    let (tags, desc, rating): (Option<String>, Option<String>, Option<u8>) = stmt.query_row([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    }).unwrap();
    
    assert_eq!(tags.unwrap(), "[\"new\"]");
    assert_eq!(desc.unwrap(), "updated desc");
    assert_eq!(rating.unwrap(), 4);
}

#[test]
fn test_health_check_logic() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test_assets.db");
    init_db(&db_path).unwrap();
    
    // Create a real file
    let real_file_path = dir.path().join("real.png");
    fs::write(&real_file_path, "dummy data").unwrap();
    
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    
    // Insert one real and one missing
    conn.execute(
        "INSERT INTO assets (id, name, path, asset_type, size) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params!["real1", "real.png", real_file_path.to_string_lossy().into_owned(), "image", 10],
    ).unwrap();
    
    conn.execute(
        "INSERT INTO assets (id, name, path, asset_type, size) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params!["missing1", "missing.png", "/completely/fake/path/missing.png", "image", 20],
    ).unwrap();
    
    // Simulate check_health logic
    let mut stmt = conn.prepare("SELECT id, path FROM assets").unwrap();
    let mut missing_ids = Vec::new();
    
    let iter = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let path: String = row.get(1)?;
        Ok((id, path))
    }).unwrap();

    for item in iter {
        if let Ok((id, path)) = item {
            if !std::path::Path::new(&path).exists() {
                missing_ids.push(id);
            }
        }
    }
    
    assert_eq!(missing_ids.len(), 1);
    assert_eq!(missing_ids[0], "missing1");
}
