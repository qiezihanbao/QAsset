use rusqlite::{Connection, Result as SqlResult};
use std::path::Path;

fn rebuild_inverted_index_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "DELETE FROM asset_tags;
         DELETE FROM asset_workspaces;

         INSERT OR IGNORE INTO asset_tags(asset_id, tag)
         SELECT
             a.id,
             TRIM(CAST(j.value AS TEXT)) AS tag
         FROM assets AS a
         JOIN json_each(
             CASE
                 WHEN json_valid(a.tags) THEN a.tags
                 ELSE '[]'
             END
         ) AS j
         WHERE TRIM(CAST(j.value AS TEXT)) != '';

         INSERT OR IGNORE INTO asset_workspaces(asset_id, workspace_id)
         SELECT
             a.id,
             TRIM(CAST(j.value AS TEXT)) AS workspace_id
         FROM assets AS a
         JOIN json_each(
             CASE
                 WHEN json_valid(a.workspace_ids) THEN a.workspace_ids
                 ELSE '[]'
             END
         ) AS j
         WHERE TRIM(CAST(j.value AS TEXT)) != '';",
    )?;

    Ok(())
}

fn rebuild_assets_fts_table(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "DELETE FROM assets_fts;
         INSERT INTO assets_fts(rowid, asset_id, name, relative_path)
         SELECT
             rowid,
             id,
             name,
             REPLACE(relative_path, char(92), '/')
         FROM assets;",
    )?;
    Ok(())
}

pub fn init_library_db(db_path: &Path) -> SqlResult<()> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;

    let had_asset_tags: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'asset_tags'",
        [],
        |row| row.get(0),
    )?;
    let had_asset_workspaces: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'asset_workspaces'",
        [],
        |row| row.get(0),
    )?;
    let had_assets_fts: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'assets_fts'",
        [],
        |row| row.get(0),
    )?;

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
            asset_count INTEGER DEFAULT 0,
            show_subfolders INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS asset_tags (
            asset_id TEXT NOT NULL,
            tag TEXT NOT NULL,
            PRIMARY KEY (asset_id, tag)
        );
        CREATE TABLE IF NOT EXISTS asset_workspaces (
            asset_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            PRIMARY KEY (asset_id, workspace_id)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
            asset_id UNINDEXED,
            name,
            relative_path,
            tokenize='unicode61 remove_diacritics 2',
            prefix='2 3'
        );
        CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);
        CREATE INDEX IF NOT EXISTS idx_assets_trashed ON assets(is_trashed);
        CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at);
        CREATE INDEX IF NOT EXISTS idx_assets_modified ON assets(modified_at);
        CREATE INDEX IF NOT EXISTS idx_assets_rating ON assets(rating);
        CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
        CREATE INDEX IF NOT EXISTS idx_assets_relative_path ON assets(relative_path);
        CREATE INDEX IF NOT EXISTS idx_assets_type_modified ON assets(asset_type, modified_at DESC);
        CREATE INDEX IF NOT EXISTS idx_assets_trashed_created ON assets(is_trashed, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_assets_trashed_modified ON assets(is_trashed, modified_at DESC);
        CREATE INDEX IF NOT EXISTS idx_assets_relative_path_norm ON assets(REPLACE(relative_path, char(92), '/'));
        CREATE INDEX IF NOT EXISTS idx_asset_tags_tag_asset ON asset_tags(tag, asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_tags_asset ON asset_tags(asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_workspaces_workspace_asset ON asset_workspaces(workspace_id, asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_workspaces_asset ON asset_workspaces(asset_id);

        DROP TRIGGER IF EXISTS trg_assets_after_insert_fts;
        DROP TRIGGER IF EXISTS trg_assets_after_update_fts;
        DROP TRIGGER IF EXISTS trg_assets_after_delete_fts;

        CREATE TRIGGER IF NOT EXISTS trg_assets_after_insert_tags
        AFTER INSERT ON assets
        BEGIN
            DELETE FROM asset_tags WHERE asset_id = NEW.id;
            INSERT OR IGNORE INTO asset_tags(asset_id, tag)
            SELECT NEW.id, TRIM(CAST(j.value AS TEXT))
            FROM json_each(
                CASE
                    WHEN json_valid(NEW.tags) THEN NEW.tags
                    ELSE '[]'
                END
            ) AS j
            WHERE TRIM(CAST(j.value AS TEXT)) != '';
        END;

        CREATE TRIGGER IF NOT EXISTS trg_assets_after_update_tags
        AFTER UPDATE OF tags ON assets
        BEGIN
            DELETE FROM asset_tags WHERE asset_id = NEW.id;
            INSERT OR IGNORE INTO asset_tags(asset_id, tag)
            SELECT NEW.id, TRIM(CAST(j.value AS TEXT))
            FROM json_each(
                CASE
                    WHEN json_valid(NEW.tags) THEN NEW.tags
                    ELSE '[]'
                END
            ) AS j
            WHERE TRIM(CAST(j.value AS TEXT)) != '';
        END;

        CREATE TRIGGER IF NOT EXISTS trg_assets_after_insert_workspaces
        AFTER INSERT ON assets
        BEGIN
            DELETE FROM asset_workspaces WHERE asset_id = NEW.id;
            INSERT OR IGNORE INTO asset_workspaces(asset_id, workspace_id)
            SELECT NEW.id, TRIM(CAST(j.value AS TEXT))
            FROM json_each(
                CASE
                    WHEN json_valid(NEW.workspace_ids) THEN NEW.workspace_ids
                    ELSE '[]'
                END
            ) AS j
            WHERE TRIM(CAST(j.value AS TEXT)) != '';
        END;

        CREATE TRIGGER IF NOT EXISTS trg_assets_after_update_workspaces
        AFTER UPDATE OF workspace_ids ON assets
        BEGIN
            DELETE FROM asset_workspaces WHERE asset_id = NEW.id;
            INSERT OR IGNORE INTO asset_workspaces(asset_id, workspace_id)
            SELECT NEW.id, TRIM(CAST(j.value AS TEXT))
            FROM json_each(
                CASE
                    WHEN json_valid(NEW.workspace_ids) THEN NEW.workspace_ids
                    ELSE '[]'
                END
            ) AS j
            WHERE TRIM(CAST(j.value AS TEXT)) != '';
        END;

        CREATE TRIGGER IF NOT EXISTS trg_assets_after_update_id
        AFTER UPDATE OF id ON assets
        BEGIN
            UPDATE asset_tags SET asset_id = NEW.id WHERE asset_id = OLD.id;
            UPDATE asset_workspaces SET asset_id = NEW.id WHERE asset_id = OLD.id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_assets_after_delete
        AFTER DELETE ON assets
        BEGIN
            DELETE FROM asset_tags WHERE asset_id = OLD.id;
            DELETE FROM asset_workspaces WHERE asset_id = OLD.id;
        END;

        CREATE TRIGGER trg_assets_after_insert_fts
        AFTER INSERT ON assets
        BEGIN
            INSERT INTO assets_fts(rowid, asset_id, name, relative_path)
            VALUES (
                NEW.rowid,
                NEW.id,
                NEW.name,
                REPLACE(NEW.relative_path, char(92), '/')
            );
        END;

        CREATE TRIGGER trg_assets_after_update_fts
        AFTER UPDATE OF id, name, relative_path ON assets
        BEGIN
            DELETE FROM assets_fts WHERE rowid = OLD.rowid;
            INSERT INTO assets_fts(rowid, asset_id, name, relative_path)
            VALUES (
                NEW.rowid,
                NEW.id,
                NEW.name,
                REPLACE(NEW.relative_path, char(92), '/')
            );
        END;

        CREATE TRIGGER trg_assets_after_delete_fts
        AFTER DELETE ON assets
        BEGIN
            DELETE FROM assets_fts WHERE rowid = OLD.rowid;
        END;
        "
    )?;

    // Migrations
    {
        let _ = conn.execute_batch(
            "ALTER TABLE folders ADD COLUMN show_subfolders INTEGER DEFAULT 1;"
        );
    }

    if had_asset_tags == 0 || had_asset_workspaces == 0 {
        rebuild_inverted_index_tables(&conn)?;
    }
    if had_assets_fts == 0 {
        rebuild_assets_fts_table(&conn)?;
    }

    Ok(())
}
