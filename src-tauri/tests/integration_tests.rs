use tempfile::tempdir;
use std::fs;
use app_lib::db;

#[test]
fn test_database_initialization() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test_library.db");

    assert!(db::init_library_db(&db_path).is_ok());
    assert!(db_path.exists());

    let conn = rusqlite::Connection::open(&db_path).unwrap();

    // Verify all 3 tables exist
    let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").unwrap();
    let tables: Vec<String> = stmt.query_map([], |row| row.get(0)).unwrap().filter_map(Result::ok).collect();
    assert!(tables.contains(&"assets".to_string()));
    assert!(tables.contains(&"workspaces".to_string()));
    assert!(tables.contains(&"folders".to_string()));

    // Verify key columns exist on assets table
    let mut stmt = conn.prepare("PRAGMA table_info(assets)").unwrap();
    let columns: Vec<String> = stmt.query_map([], |row| row.get(1)).unwrap().filter_map(Result::ok).collect();
    assert!(columns.contains(&"id".to_string()));
    assert!(columns.contains(&"relative_path".to_string()));
    assert!(columns.contains(&"thumbnail_mtime".to_string()));
    assert!(columns.contains(&"p_hash".to_string()));
    assert!(columns.contains(&"created_at".to_string()));
}

#[test]
fn test_database_insert_and_query() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test_library.db");
    db::init_library_db(&db_path).unwrap();

    let conn = rusqlite::Connection::open(&db_path).unwrap();

    conn.execute(
        "INSERT INTO assets (id, name, path, relative_path, asset_type, size, dominant_color, tags, rating, p_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params!["123", "test.png", "/fake/path/test.png", "test.png", "image", 1024, "#ffffff", "[\"tag1\"]", 5, "base64hash"],
    ).unwrap();

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
    let db_path = dir.path().join("test_library.db");
    db::init_library_db(&db_path).unwrap();

    let conn = rusqlite::Connection::open(&db_path).unwrap();

    conn.execute(
        "INSERT INTO assets (id, name, path, relative_path, asset_type, size) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params!["456", "update.png", "/fake/path", "update.png", "image", 2048],
    ).unwrap();

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
    let db_path = dir.path().join("test_library.db");
    db::init_library_db(&db_path).unwrap();

    let real_file_path = dir.path().join("real.png");
    fs::write(&real_file_path, "dummy data").unwrap();

    let conn = rusqlite::Connection::open(&db_path).unwrap();

    conn.execute(
        "INSERT INTO assets (id, name, path, relative_path, asset_type, size) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params!["real1", "real.png", real_file_path.to_string_lossy().into_owned(), "real.png", "image", 10],
    ).unwrap();

    conn.execute(
        "INSERT INTO assets (id, name, path, relative_path, asset_type, size) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params!["missing1", "missing.png", "/completely/fake/path/missing.png", "missing.png", "image", 20],
    ).unwrap();

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

