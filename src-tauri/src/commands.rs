use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::core::search::{first_match, Matcher, Query, SearchRun};
use crate::core::edits::ColDef;
use crate::core::export::{ExportFormat, SaveSummary};
use crate::core::session::{CellChange, Session, ViewState, MAX_BATCH_CELLS};
use crate::core::source::Progress;
use crate::core::stats::{self, ColumnStats, SelectionStats};
use crate::core::view::{Task, ViewSpec};
use crate::formats::{self, OpenOptions};
use crate::formats::json::{JsonChildren, JsonNode, JsonSource, TreeEdit};

#[derive(Default)]
pub struct AppState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    next_id: AtomicU32,
}

impl AppState {
    fn get(&self, id: u32) -> Result<Arc<Session>, String> {
        self.sessions.read().get(&id).cloned().ok_or_else(|| "File is not open".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    id: u32,
    path: String,
    name: String,
    format: &'static str,
    detail: Option<String>,
    sheets: Vec<String>,
    sheet: Option<String>,
    /// Options as resolved (detected delimiter, encoding, header).
    options: OpenOptions,
    /// What a plain save writes; Save As in another format converts.
    save_format: ExportFormat,
    columns: Vec<String>,
    file_size: u64,
    view: ViewState,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexEvent {
    id: u32,
    #[serde(flatten)]
    progress: Progress,
    /// Rows shown, counting rows inserted or deleted while loading.
    view_rows: u64,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveEvent {
    id: u32,
    rows_done: u64,
    rows_total: u64,
}

#[tauri::command]
pub async fn open_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    options: Option<OpenOptions>,
) -> Result<OpenedFile, String> {
    let path = PathBuf::from(path);
    let options = options.unwrap_or_default();
    let source = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || formats::open(&path, &options))
            .await
            .map_err(|e| e.to_string())??
    };
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let session = Arc::new(Session::new(path.clone(), source.clone()));
    state.sessions.write().insert(id, session.clone());
    let session_view = session.view_state();

    std::thread::Builder::new()
        .name(format!("index-{id}"))
        .spawn(move || {
            let emit = |progress: Progress| {
                let error = session.source.index_error();
                let view_rows = session.base_row_count();
                let _ = app.emit("index-progress", IndexEvent { id, progress, view_rows, error });
            };
            session.source.build_index(&emit);
            if session.source.progress().done && session.source.index_error().is_none() {
                session.finish_indexing();
                emit(session.source.progress());
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(OpenedFile {
        id,
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        format: source.format(),
        detail: source.detail(),
        sheets: source.sheets().0,
        sheet: source.sheets().1,
        options: source.options(),
        save_format: source.native_format(),
        columns: source.columns(),
        file_size: source.file_size(),
        view: session_view,
    })
}

#[tauri::command]
pub async fn close_file(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    if let Some(session) = state.sessions.write().remove(&id) {
        session.source.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn view_state(state: State<'_, AppState>, id: u32) -> Result<ViewState, String> {
    Ok(state.get(id)?.view_state())
}

#[tauri::command]
pub async fn get_rows(state: State<'_, AppState>, id: u32, start: u64, count: u64) -> Result<Vec<Vec<String>>, String> {
    Ok(state.get(id)?.read_rows(start, count))
}

#[tauri::command]
pub async fn set_cells(state: State<'_, AppState>, id: u32, changes: Vec<CellChange>) -> Result<ViewState, String> {
    state.get(id)?.set_cells(changes)
}

#[tauri::command]
pub async fn insert_rows(state: State<'_, AppState>, id: u32, at: u64, count: u64) -> Result<ViewState, String> {
    let session = state.get(id)?;
    session.require_unordered()?;
    session.edit(|e| e.insert_rows(at, count).map(|_| ()))
}

#[tauri::command]
pub async fn delete_rows(state: State<'_, AppState>, id: u32, start: u64, count: u64) -> Result<ViewState, String> {
    let session = state.get(id)?;
    session.require_unordered()?;
    session.edit(|e| e.delete_rows(start, count))
}

#[tauri::command]
pub async fn undo(state: State<'_, AppState>, id: u32) -> Result<ViewState, String> {
    state.get(id)?.edit(|e| Ok(e.undo()))
}

#[tauri::command]
pub async fn redo(state: State<'_, AppState>, id: u32) -> Result<ViewState, String> {
    state.get(id)?.edit(|e| Ok(e.redo()))
}

/// Saves to `path`, or over the original file when `path` is omitted.
/// `format` converts to another format; `view_only` writes just the sorted /
/// filtered rows. One save runs per file at a time; `save_cancel` stops it.
#[tauri::command]
pub async fn save_file(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u32,
    path: Option<String>,
    format: Option<ExportFormat>,
    view_only: Option<bool>,
) -> Result<SaveSummary, String> {
    let session = state.get(id)?;
    let dest = path.map(PathBuf::from).unwrap_or_else(|| session.path.clone());
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = session.saving.lock();
        if slot.is_some() {
            return Err("Already saving this file".into());
        }
        *slot = Some(cancel.clone());
    }
    let s = session.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        s.save_as(&dest, format, view_only.unwrap_or(false), &cancel, &|rows_done, rows_total| {
            let _ = app.emit("save-progress", SaveEvent { id, rows_done, rows_total });
        })
    })
    .await
    .map_err(|e| e.to_string());
    *session.saving.lock() = None;
    result?
}

/// Stops a running save; its temp file is deleted.
#[tauri::command]
pub async fn save_cancel(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    if let Some(cancel) = state.get(id)?.saving.lock().as_ref() {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn json_source(session: &Session) -> Result<&JsonSource, String> {
    session.source.as_any().downcast_ref::<JsonSource>().ok_or_else(|| "Not a JSON file".into())
}

#[tauri::command]
pub async fn json_root(state: State<'_, AppState>, id: u32) -> Result<JsonNode, String> {
    let session = state.get(id)?;
    session.with_edits(|e| json_source(&session)?.tree_root(e))
}

/// Children of the container at `path` (child positions from the root).
/// The first expand of a big container scans it, so this runs off the async pool.
#[tauri::command]
pub async fn json_children(
    state: State<'_, AppState>,
    id: u32,
    path: Vec<u64>,
    start: u64,
    count: u64,
) -> Result<JsonChildren, String> {
    let session = state.get(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session.with_edits(|e| json_source(&session)?.tree_children(e, &path, start, count.min(5000)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn json_raw(state: State<'_, AppState>, id: u32, path: Vec<u64>) -> Result<String, String> {
    let session = state.get(id)?;
    tauri::async_runtime::spawn_blocking(move || session.with_edits(|e| json_source(&session)?.tree_raw(e, &path)))
        .await
        .map_err(|e| e.to_string())?
}

/// Applies a JSON view edit (set, rename, delete or insert) as one undo step.
#[tauri::command]
pub async fn json_edit(state: State<'_, AppState>, id: u32, edit: TreeEdit) -> Result<ViewState, String> {
    let session = state.get(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let source = session.source.clone();
        let json = source.as_any().downcast_ref::<JsonSource>().ok_or("Not a JSON file")?;
        session.edit(|e| json.tree_edit(e, edit))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchEvent {
    id: u32,
    search_id: u64,
    scanned: u64,
    total: u64,
    /// Known once the search is done.
    count: Option<u64>,
    done: bool,
}

static NEXT_SEARCH: AtomicU64 = AtomicU64::new(1);

/// Starts a search over the whole file (replacing any running one) and
/// reports progress through `search-progress` events.
#[tauri::command]
pub async fn search_start(app: AppHandle, state: State<'_, AppState>, id: u32, query: Query) -> Result<u64, String> {
    let session = state.get(id)?;
    let matcher = Matcher::new(&query)?;
    let run = Arc::new(SearchRun {
        id: NEXT_SEARCH.fetch_add(1, Ordering::Relaxed),
        query,
        matcher,
        hits: Default::default(),
        done: AtomicBool::new(false),
        cancel: AtomicBool::new(false),
        scanned: AtomicU64::new(0),
    });
    if let Some(old) = session.search.lock().replace(run.clone()) {
        old.cancel.store(true, Ordering::Relaxed);
    }
    let search_id = run.id;
    std::thread::spawn(move || {
        let total = session.source.row_count();
        let ticker = {
            let (app, run) = (app.clone(), run.clone());
            std::thread::spawn(move || {
                while !run.done.load(Ordering::Acquire) && !run.cancel.load(Ordering::Relaxed) {
                    let scanned = run.scanned.load(Ordering::Relaxed);
                    let _ = app.emit(
                        "search-progress",
                        SearchEvent { id, search_id: run.id, scanned, total, count: None, done: false },
                    );
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
            })
        };
        session.run_search(&run);
        let _ = ticker.join();
        if !run.cancel.load(Ordering::Relaxed) {
            let count = run.hits.lock().len() as u64;
            let _ = app.emit(
                "search-progress",
                SearchEvent { id, search_id: run.id, scanned: total, total, count: Some(count), done: true },
            );
        }
    });
    Ok(search_id)
}

#[tauri::command]
pub async fn search_stop(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    if let Some(run) = state.get(id)?.search.lock().take() {
        run.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Hit {
    index: u64,
    row: u64,
    /// First matching column in that row.
    col: Option<u32>,
}

fn finished_search(session: &Session) -> Result<Arc<SearchRun>, String> {
    let run = session.search.lock().clone().ok_or("No search")?;
    if !run.done.load(Ordering::Acquire) {
        return Err("Still searching".into());
    }
    Ok(run)
}

/// The hit at `index` (wrapping), or the first hit after / before view row
/// `row` when `index` is absent.
#[tauri::command]
pub async fn search_seek(
    state: State<'_, AppState>,
    id: u32,
    index: Option<i64>,
    row: Option<u64>,
    forward: bool,
) -> Result<Option<Hit>, String> {
    let session = state.get(id)?;
    let run = finished_search(&session)?;
    let hits = run.hits.lock();
    if hits.is_empty() {
        return Ok(None);
    }
    let n = hits.len() as i64;
    let i = match (index, row) {
        (Some(i), _) => i.rem_euclid(n),
        (None, Some(r)) if forward => (hits.partition_point(|&h| h < r) as i64) % n,
        (None, Some(r)) => (hits.partition_point(|&h| h <= r) as i64 - 1).rem_euclid(n),
        (None, None) => 0,
    } as usize;
    let row = hits[i];
    drop(hits);
    let cells = session.read_rows(row, 1).pop().unwrap_or_default();
    let col = first_match(&cells, &run.matcher.text, run.query.column);
    Ok(Some(Hit { index: i as u64, row, col }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replaced {
    view: ViewState,
    cells: u64,
}

/// Replaces matches in `rows` (all hits when absent) as one undo step.
#[tauri::command]
pub async fn search_replace(
    state: State<'_, AppState>,
    id: u32,
    rows: Option<Vec<u64>>,
    replacement: String,
) -> Result<Replaced, String> {
    let session = state.get(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let run = finished_search(&session)?;
        let rows = rows.unwrap_or_else(|| run.hits.lock().clone());
        if rows.len() > MAX_BATCH_CELLS {
            return Err(format!(
                "There are {} matching rows; replace all handles at most {} at a time. Narrow the search first.",
                rows.len(),
                MAX_BATCH_CELLS
            ));
        }
        let re = &run.matcher.text;
        let mut changes = Vec::new();
        for row in rows {
            let cells = session.read_rows(row, 1).pop().unwrap_or_default();
            for (c, value) in cells.iter().enumerate() {
                if run.query.column.is_some_and(|q| q as usize != c) || !re.is_match(value) {
                    continue;
                }
                let new = if run.query.regex {
                    re.replace_all(value, replacement.as_str()).into_owned()
                } else {
                    re.replace_all(value, regex::NoExpand(&replacement)).into_owned()
                };
                changes.push(CellChange { row, col: c as u32, value: new });
            }
        }
        let cells = changes.len() as u64;
        let view = session.set_cells(changes)?;
        Ok(Replaced { view, cells })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Adds an empty column named `name` at view position `at`.
#[tauri::command]
pub async fn insert_column(state: State<'_, AppState>, id: u32, at: u32, name: String) -> Result<ViewState, String> {
    state.get(id)?.edit_columns(|defs, new_key| {
        let at = (at as usize).min(defs.len());
        defs.insert(at, ColDef { key: new_key(), name });
        Ok(())
    })
}

#[tauri::command]
pub async fn delete_columns(state: State<'_, AppState>, id: u32, cols: Vec<u32>) -> Result<ViewState, String> {
    state.get(id)?.edit_columns(|defs, _| {
        let mut cols = cols;
        cols.sort_unstable();
        cols.dedup();
        for &c in cols.iter().rev() {
            if (c as usize) < defs.len() {
                defs.remove(c as usize);
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn rename_column(state: State<'_, AppState>, id: u32, col: u32, name: String) -> Result<ViewState, String> {
    state.get(id)?.edit_columns(|defs, _| {
        let def = defs.get_mut(col as usize).ok_or("Column out of range")?;
        def.name = name.trim().to_string();
        Ok(())
    })
}

#[tauri::command]
pub async fn move_column(state: State<'_, AppState>, id: u32, from: u32, to: u32) -> Result<ViewState, String> {
    state.get(id)?.edit_columns(|defs, _| {
        if from as usize >= defs.len() || to as usize >= defs.len() {
            return Err("Column out of range".into());
        }
        let def = defs.remove(from as usize);
        defs.insert(to as usize, def);
        Ok(())
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskEvent {
    id: u32,
    kind: &'static str,
    done: u64,
    total: u64,
    finished: bool,
}

/// Runs a long pass off the async pool, reporting `task-progress` events
/// until it ends. Starting one cancels the session's previous pass.
async fn run_task<T: Send + 'static>(
    app: AppHandle,
    session: Arc<Session>,
    id: u32,
    kind: &'static str,
    f: impl FnOnce(&Session, &Task) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let task = Arc::new(Task::default());
    if let Some(old) = session.task.lock().replace(task.clone()) {
        old.cancel.store(true, Ordering::Relaxed);
    }
    let ticker = {
        let (app, task) = (app.clone(), task.clone());
        std::thread::spawn(move || {
            // Short passes finish before the first tick and never show progress.
            std::thread::sleep(std::time::Duration::from_millis(120));
            while !task.finished.load(Ordering::Acquire) {
                let (done, total) = (task.done.load(Ordering::Relaxed), task.total.load(Ordering::Relaxed));
                let _ = app.emit("task-progress", TaskEvent { id, kind, done, total, finished: false });
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        })
    };
    let result = {
        let (session, task) = (session.clone(), task.clone());
        tauri::async_runtime::spawn_blocking(move || f(&session, &task)).await.map_err(|e| e.to_string())
    };
    task.finished.store(true, Ordering::Release);
    let _ = tauri::async_runtime::spawn_blocking(move || ticker.join()).await;
    let _ = app.emit("task-progress", TaskEvent { id, kind, done: 0, total: 0, finished: true });
    let mut slot = session.task.lock();
    if slot.as_ref().is_some_and(|t| Arc::ptr_eq(t, &task)) {
        *slot = None;
    }
    result?
}

/// Sorts and filters the table (an empty spec shows the file order again).
#[tauri::command]
pub async fn view_apply(app: AppHandle, state: State<'_, AppState>, id: u32, spec: ViewSpec) -> Result<ViewState, String> {
    let session = state.get(id)?;
    let kind = if spec.sort.is_empty() { "filter" } else { "sort" };
    run_task(app, session, id, kind, move |s, task| s.set_view(spec, task)).await
}

#[tauri::command]
pub async fn view_clear(state: State<'_, AppState>, id: u32) -> Result<ViewState, String> {
    Ok(state.get(id)?.clear_view())
}

#[tauri::command]
pub async fn column_stats(app: AppHandle, state: State<'_, AppState>, id: u32, col: u32) -> Result<ColumnStats, String> {
    let session = state.get(id)?;
    run_task(app, session, id, "stats", move |s, task| stats::column_stats(s, col, task)).await
}

/// Stops the running sort, filter or stats pass.
#[tauri::command]
pub async fn task_cancel(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    if let Some(task) = state.get(id)?.task.lock().as_ref() {
        task.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Count, sum, average, min and max of the selected cells (status bar).
#[tauri::command]
pub async fn selection_stats(
    state: State<'_, AppState>,
    id: u32,
    start: u64,
    count: u64,
    cols: Vec<u32>,
) -> Result<SelectionStats, String> {
    let session = state.get(id)?;
    tauri::async_runtime::spawn_blocking(move || stats::selection_stats(&session, start, count, &cols))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    size: u64,
    /// Last modified, in milliseconds since the Unix epoch.
    modified_ms: Option<u64>,
}

/// Size and modified time for the recent files list; `None` for files that are gone.
#[tauri::command]
pub async fn file_info(paths: Vec<String>) -> Vec<Option<FileInfo>> {
    paths
        .iter()
        .map(|p| {
            let meta = std::fs::metadata(p).ok().filter(|m| m.is_file())?;
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            Some(FileInfo { size: meta.len(), modified_ms })
        })
        .collect()
}
