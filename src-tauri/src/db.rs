use rusqlite::{Connection, Result as SqlResult};
use std::path::Path;

pub fn init_library_db(db_path: &Path) -> SqlResult<()> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            asset_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            dominant_color TEXT,
            tags TEXT,
            description TEXT,
            rating INTEGER,
            workspace_ids TEXT,
            created_at INTEGER DEFAULT 0,
            modified_at INTEGER DEFAULT 0,
            p_hash TEXT,
            is_trashed INTEGER DEFAULT 0,
            width INTEGER,
            height INTEGER,
            source_url TEXT,
            duration REAL,
            thumbnail_mtime INTEGER
        );
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS folders (
            path TEXT PRIMARY KEY,
            parent_path TEXT,
            display_name TEXT NOT NULL,
            asset_count INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);
        CREATE INDEX IF NOT EXISTS idx_assets_trashed ON assets(is_trashed);
        CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at);
        CREATE INDEX IF NOT EXISTS idx_assets_modified ON assets(modified_at);
        CREATE INDEX IF NOT EXISTS idx_assets_rating ON assets(rating);
        CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
        CREATE INDEX IF NOT EXISTS idx_assets_relative_path ON assets(relative_path);
        "
    )?;
    Ok(())
}