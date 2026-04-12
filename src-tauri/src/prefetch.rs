use crate::library;
use crate::models::{
    PrefetchAssetsWindowRequest, PrefetchCancelResult, PrefetchEnqueueResult, PrefetchTaskStatus,
};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, oneshot, Mutex};
use uuid::Uuid;

#[derive(Clone)]
pub struct PrefetchRuntime {
    tx: mpsc::UnboundedSender<PrefetchCommand>,
    statuses: Arc<Mutex<HashMap<String, PrefetchTaskStatus>>>,
}

#[derive(Clone, Copy)]
enum PrefetchPriority {
    P0,
    P1,
    P2,
}

struct PrefetchJob {
    task_id: String,
    asset_id: String,
    db_path: PathBuf,
    library_root: PathBuf,
}

struct EnqueuePayload {
    task_id: String,
    replace_existing_task: bool,
    p0_ids: Vec<String>,
    p1_ids: Vec<String>,
    p2_ids: Vec<String>,
    db_path: PathBuf,
    library_root: PathBuf,
}

enum PrefetchCommand {
    Enqueue {
        payload: EnqueuePayload,
        respond_to: oneshot::Sender<PrefetchEnqueueResult>,
    },
    CancelTask {
        task_id: String,
        respond_to: oneshot::Sender<PrefetchCancelResult>,
    },
    CancelAll {
        respond_to: oneshot::Sender<()>,
    },
}

#[derive(Default)]
struct WorkerState {
    p0: VecDeque<PrefetchJob>,
    p1: VecDeque<PrefetchJob>,
    p2: VecDeque<PrefetchJob>,
    queued_keys: HashSet<(String, String)>,
    cancelled_tasks: HashSet<String>,
}

impl WorkerState {
    fn pop_next(&mut self) -> Option<PrefetchJob> {
        if let Some(job) = self.p0.pop_front() {
            self.queued_keys
                .remove(&(job.task_id.clone(), job.asset_id.clone()));
            return Some(job);
        }
        if let Some(job) = self.p1.pop_front() {
            self.queued_keys
                .remove(&(job.task_id.clone(), job.asset_id.clone()));
            return Some(job);
        }
        if let Some(job) = self.p2.pop_front() {
            self.queued_keys
                .remove(&(job.task_id.clone(), job.asset_id.clone()));
            return Some(job);
        }
        None
    }

    fn push_job(&mut self, priority: PrefetchPriority, job: PrefetchJob) {
        match priority {
            PrefetchPriority::P0 => self.p0.push_back(job),
            PrefetchPriority::P1 => self.p1.push_back(job),
            PrefetchPriority::P2 => self.p2.push_back(job),
        }
    }

    fn remove_task_jobs(&mut self, task_id: &str) {
        fn compact_queue(
            queue: &mut VecDeque<PrefetchJob>,
            task_id: &str,
            queued_keys: &mut HashSet<(String, String)>,
        ) {
            let mut kept = VecDeque::with_capacity(queue.len());
            while let Some(job) = queue.pop_front() {
                if job.task_id == task_id {
                    queued_keys.remove(&(job.task_id, job.asset_id));
                    continue;
                }
                kept.push_back(job);
            }
            *queue = kept;
        }

        compact_queue(&mut self.p0, task_id, &mut self.queued_keys);
        compact_queue(&mut self.p1, task_id, &mut self.queued_keys);
        compact_queue(&mut self.p2, task_id, &mut self.queued_keys);
    }

    fn clear_all(&mut self) {
        self.p0.clear();
        self.p1.clear();
        self.p2.clear();
        self.queued_keys.clear();
    }
}

impl PrefetchRuntime {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::unbounded_channel::<PrefetchCommand>();
        let statuses = Arc::new(Mutex::new(HashMap::new()));
        let statuses_for_worker = Arc::clone(&statuses);
        tauri::async_runtime::spawn(async move {
            worker_loop(rx, statuses_for_worker).await;
        });
        Self { tx, statuses }
    }

    pub async fn enqueue_window(
        &self,
        request: PrefetchAssetsWindowRequest,
        db_path: PathBuf,
        library_root: PathBuf,
    ) -> Result<PrefetchEnqueueResult, String> {
        let task_id = request
            .task_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("prefetch-{}", Uuid::new_v4()));
        let payload = EnqueuePayload {
            task_id,
            replace_existing_task: request.replace_existing_task.unwrap_or(true),
            p0_ids: request.p0_ids,
            p1_ids: request.p1_ids,
            p2_ids: request.p2_ids,
            db_path,
            library_root,
        };
        let (respond_to, response_rx) = oneshot::channel();
        self.tx
            .send(PrefetchCommand::Enqueue { payload, respond_to })
            .map_err(|_| "Prefetch worker is not available".to_string())?;
        response_rx
            .await
            .map_err(|_| "Prefetch worker response channel closed".to_string())
    }

    pub async fn cancel_task(&self, task_id: String) -> Result<PrefetchCancelResult, String> {
        let (respond_to, response_rx) = oneshot::channel();
        self.tx
            .send(PrefetchCommand::CancelTask { task_id, respond_to })
            .map_err(|_| "Prefetch worker is not available".to_string())?;
        response_rx
            .await
            .map_err(|_| "Prefetch worker response channel closed".to_string())
    }

    pub async fn cancel_all(&self) -> Result<(), String> {
        let (respond_to, response_rx) = oneshot::channel();
        self.tx
            .send(PrefetchCommand::CancelAll { respond_to })
            .map_err(|_| "Prefetch worker is not available".to_string())?;
        response_rx
            .await
            .map_err(|_| "Prefetch worker response channel closed".to_string())
    }

    pub async fn get_status(&self, task_id: String) -> Option<PrefetchTaskStatus> {
        let statuses = self.statuses.lock().await;
        statuses.get(&task_id).cloned()
    }
}

async fn worker_loop(
    mut rx: mpsc::UnboundedReceiver<PrefetchCommand>,
    statuses: Arc<Mutex<HashMap<String, PrefetchTaskStatus>>>,
) {
    let mut worker = WorkerState::default();
    loop {
        while let Ok(cmd) = rx.try_recv() {
            handle_command(cmd, &mut worker, &statuses).await;
        }

        if let Some(job) = worker.pop_next() {
            process_job(job, &worker.cancelled_tasks, &statuses).await;
            continue;
        }

        match rx.recv().await {
            Some(cmd) => handle_command(cmd, &mut worker, &statuses).await,
            None => break,
        }
    }
}

async fn handle_command(
    cmd: PrefetchCommand,
    worker: &mut WorkerState,
    statuses: &Arc<Mutex<HashMap<String, PrefetchTaskStatus>>>,
) {
    match cmd {
        PrefetchCommand::Enqueue { payload, respond_to } => {
            let result = enqueue_payload(payload, worker, statuses).await;
            let _ = respond_to.send(result);
        }
        PrefetchCommand::CancelTask {
            task_id,
            respond_to,
        } => {
            let cancelled = cancel_task(task_id, worker, statuses).await;
            let _ = respond_to.send(cancelled);
        }
        PrefetchCommand::CancelAll { respond_to } => {
            worker.clear_all();
            worker.cancelled_tasks.clear();
            {
                let mut map = statuses.lock().await;
                for status in map.values_mut() {
                    if status.state != "completed" && status.state != "completed_with_errors" {
                        status.state = "cancelled".to_string();
                        status.updated_at = now_millis();
                    }
                }
            }
            let _ = respond_to.send(());
        }
    }
}

async fn enqueue_payload(
    payload: EnqueuePayload,
    worker: &mut WorkerState,
    statuses: &Arc<Mutex<HashMap<String, PrefetchTaskStatus>>>,
) -> PrefetchEnqueueResult {
    if payload.replace_existing_task {
        worker.cancelled_tasks.insert(payload.task_id.clone());
        worker.remove_task_jobs(&payload.task_id);
    }
    worker.cancelled_tasks.remove(&payload.task_id);

    let mut queued: u32 = 0;
    let mut deduped: u32 = 0;
    let mut local_seen: HashSet<String> = HashSet::new();

    let mut append_ids = |priority: PrefetchPriority, ids: Vec<String>| {
        for raw_id in ids {
            let trimmed = raw_id.trim();
            if trimmed.is_empty() {
                deduped = deduped.saturating_add(1);
                continue;
            }
            let asset_id = trimmed.to_string();
            if !local_seen.insert(asset_id.clone()) {
                deduped = deduped.saturating_add(1);
                continue;
            }
            let key = (payload.task_id.clone(), asset_id.clone());
            if !worker.queued_keys.insert(key) {
                deduped = deduped.saturating_add(1);
                continue;
            }
            worker.push_job(
                priority,
                PrefetchJob {
                    task_id: payload.task_id.clone(),
                    asset_id,
                    db_path: payload.db_path.clone(),
                    library_root: payload.library_root.clone(),
                },
            );
            queued = queued.saturating_add(1);
        }
    };

    append_ids(PrefetchPriority::P0, payload.p0_ids);
    append_ids(PrefetchPriority::P1, payload.p1_ids);
    append_ids(PrefetchPriority::P2, payload.p2_ids);

    {
        let mut map = statuses.lock().await;
        map.insert(
            payload.task_id.clone(),
            PrefetchTaskStatus {
                task_id: payload.task_id.clone(),
                state: if queued == 0 {
                    "completed".to_string()
                } else {
                    "queued".to_string()
                },
                queued,
                processed: 0,
                succeeded: 0,
                skipped: 0,
                failed: 0,
                updated_at: now_millis(),
            },
        );
    }

    PrefetchEnqueueResult {
        task_id: payload.task_id,
        queued,
        deduped,
    }
}

async fn cancel_task(
    task_id: String,
    worker: &mut WorkerState,
    statuses: &Arc<Mutex<HashMap<String, PrefetchTaskStatus>>>,
) -> PrefetchCancelResult {
    let cancelled = worker.cancelled_tasks.insert(task_id.clone());
    worker.remove_task_jobs(&task_id);
    {
        let mut map = statuses.lock().await;
        if let Some(status) = map.get_mut(&task_id) {
            status.state = "cancelled".to_string();
            status.updated_at = now_millis();
        } else {
            map.insert(
                task_id.clone(),
                PrefetchTaskStatus {
                    task_id: task_id.clone(),
                    state: "cancelled".to_string(),
                    queued: 0,
                    processed: 0,
                    succeeded: 0,
                    skipped: 0,
                    failed: 0,
                    updated_at: now_millis(),
                },
            );
        }
    }
    PrefetchCancelResult { task_id, cancelled }
}

async fn process_job(
    job: PrefetchJob,
    cancelled_tasks: &HashSet<String>,
    statuses: &Arc<Mutex<HashMap<String, PrefetchTaskStatus>>>,
) {
    if cancelled_tasks.contains(&job.task_id) {
        update_status(statuses, &job.task_id, |status| {
            status.processed = status.processed.saturating_add(1);
            status.skipped = status.skipped.saturating_add(1);
            status.updated_at = now_millis();
        })
        .await;
        return;
    }

    update_status(statuses, &job.task_id, |status| {
        status.state = "running".to_string();
        status.updated_at = now_millis();
    })
    .await;

    let task_id = job.task_id.clone();
    let work = tokio::task::spawn_blocking(move || {
        ensure_asset_thumbnail_by_id(&job.db_path, &job.library_root, &job.asset_id)
    })
    .await;

    match work {
        Ok(Ok(Some(_))) => {
            update_status(statuses, &task_id, |status| {
                status.processed = status.processed.saturating_add(1);
                status.succeeded = status.succeeded.saturating_add(1);
                status.updated_at = now_millis();
                finalize_status_if_needed(status);
            })
            .await;
        }
        Ok(Ok(None)) => {
            update_status(statuses, &task_id, |status| {
                status.processed = status.processed.saturating_add(1);
                status.skipped = status.skipped.saturating_add(1);
                status.updated_at = now_millis();
                finalize_status_if_needed(status);
            })
            .await;
        }
        Ok(Err(_)) | Err(_) => {
            update_status(statuses, &task_id, |status| {
                status.processed = status.processed.saturating_add(1);
                status.failed = status.failed.saturating_add(1);
                status.updated_at = now_millis();
                finalize_status_if_needed(status);
            })
            .await;
        }
    }
}

async fn update_status<F>(
    statuses: &Arc<Mutex<HashMap<String, PrefetchTaskStatus>>>,
    task_id: &str,
    mut updater: F,
) where
    F: FnMut(&mut PrefetchTaskStatus),
{
    let mut map = statuses.lock().await;
    if let Some(status) = map.get_mut(task_id) {
        updater(status);
    }
}

fn finalize_status_if_needed(status: &mut PrefetchTaskStatus) {
    if status.processed < status.queued {
        return;
    }
    if status.state == "cancelled" {
        return;
    }
    if status.failed > 0 {
        status.state = "completed_with_errors".to_string();
    } else {
        status.state = "completed".to_string();
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn ensure_asset_thumbnail_by_id(
    db_path: &Path,
    library_root: &Path,
    id: &str,
) -> Result<Option<String>, String> {
    let conn = library::get_db_connection(db_path)?;
    let mut stmt = conn
        .prepare("SELECT path, relative_path, asset_type FROM assets WHERE id = ?1")
        .map_err(|e| format!("Prepare failed: {}", e))?;

    let (path, relative_path, asset_type): (String, String, String) = stmt
        .query_row(rusqlite::params![id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| format!("Asset not found: {}", e))?;

    if asset_type != "image" && asset_type != "video" {
        return Ok(None);
    }

    let thumb_path = crate::thumbnails::thumbnail_abs_path(library_root, &relative_path);
    if thumb_path.exists() {
        return Ok(Some(thumb_path.to_string_lossy().to_string()));
    }

    let abs_path = Path::new(&path);
    if !abs_path.exists() {
        return Ok(None);
    }

    let processed = if asset_type == "video" {
        crate::scanner::process_video(library_root, &relative_path, abs_path)
    } else {
        crate::scanner::process_image(library_root, &relative_path, abs_path)
    };
    if processed.thumbnail_mtime.is_none() {
        return Ok(None);
    }

    let width = if processed.width > 0 {
        Some(processed.width)
    } else {
        None
    };
    let height = if processed.height > 0 {
        Some(processed.height)
    } else {
        None
    };

    conn.execute(
        "UPDATE assets SET dominant_color = ?1, width = ?2, height = ?3, p_hash = ?4, thumbnail_mtime = ?5 WHERE path = ?6",
        rusqlite::params![
            processed.dominant_color,
            width,
            height,
            processed.p_hash,
            processed.thumbnail_mtime,
            path,
        ],
    ).map_err(|e| format!("Failed to update asset thumbnail metadata: {}", e))?;

    if thumb_path.exists() {
        Ok(Some(thumb_path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}
