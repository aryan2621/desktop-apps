use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

use super::edits::{ColDef, EditLayer, RowRef};
use super::export::{self, Cell, ExportFormat, SaveSummary};
use super::search::SearchRun;
use super::source::DataSource;
use super::view::{Task, ViewOrder, ViewSpec};

/// Most cells one operation (paste, clear, replace all) may change.
pub const MAX_BATCH_CELLS: usize = 100_000;

/// One open file: the read-only source plus the user's edits.
///
/// Rows come in two numberings: *base* rows are the edited file in file
/// order; *display* rows are what the grid shows, which differ from base rows
/// while a sort or filter is active. Lock order: `order` before `edits`.
pub struct Session {
    pub path: PathBuf,
    pub source: Arc<dyn DataSource>,
    edits: RwLock<EditLayer>,
    /// Active sort and filter, if any.
    order: RwLock<Option<Arc<ViewOrder>>>,
    /// The latest find, if any.
    pub search: Mutex<Option<Arc<SearchRun>>>,
    /// The running sort, filter or stats pass, if any (Esc cancels it).
    pub task: Mutex<Option<Arc<Task>>>,
    /// Cancel flag of the running save, if any.
    pub saving: Mutex<Option<Arc<AtomicBool>>>,
    /// Windows only: originals moved aside so a mapped file could be
    /// replaced. Declared after `source` so the map is gone when they're deleted.
    #[cfg_attr(not(windows), allow(dead_code))]
    moved_aside: MovedAside,
}

/// Deletes the files it holds when dropped.
#[derive(Default)]
struct MovedAside(Mutex<Vec<PathBuf>>);

impl Drop for MovedAside {
    fn drop(&mut self) {
        for path in self.0.get_mut().drain(..) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewState {
    /// Rows shown (after filtering).
    pub rows: u64,
    /// Rows of the edited file, before filtering.
    pub base_rows: u64,
    /// The file is still being indexed (rows keep arriving).
    pub loading: bool,
    /// Cells can be edited (also while the file is still loading).
    pub editable: bool,
    /// Rows can be inserted or deleted.
    pub structural: bool,
    /// Columns can be added, removed, renamed or moved.
    pub column_edits: bool,
    pub savable: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub dirty: bool,
    pub columns: Vec<String>,
    /// Active sort and filters.
    pub view: Option<ViewSpec>,
    /// Cells changed since the sort or filter was applied (rows don't move until re-applied).
    pub view_stale: bool,
}

#[derive(Deserialize)]
pub struct CellChange {
    pub row: u64,
    pub col: u32,
    pub value: String,
}

impl Session {
    pub fn new(path: PathBuf, source: Arc<dyn DataSource>) -> Self {
        Self {
            path,
            source,
            edits: RwLock::new(EditLayer::growing()),
            order: RwLock::new(None),
            search: Mutex::new(None),
            task: Mutex::new(None),
            saving: Mutex::new(None),
            moved_aside: MovedAside::default(),
        }
    }

    /// Called once the background index is complete.
    pub fn finish_indexing(&self) {
        self.edits.write().finish_growing(self.source.row_count());
    }

    fn rows(&self, edits: &EditLayer) -> u64 {
        edits.row_count(self.source.row_count())
    }

    pub fn view_state(&self) -> ViewState {
        let order = self.order.read().clone();
        let e = self.edits.read();
        let ok = self.source.index_error().is_none();
        let settled = !e.is_growing() && ok;
        let base_rows = self.rows(&e);
        // Rows and columns can be reshaped while loading; rows still arriving join the end.
        let reshape = ok && order.is_none();
        ViewState {
            rows: order.as_ref().map_or(base_rows, |o| o.rows.len() as u64),
            base_rows,
            loading: e.is_growing(),
            editable: ok,
            structural: reshape,
            column_edits: reshape && self.source.supports_column_edits(),
            savable: settled,
            can_undo: e.can_undo(),
            can_redo: e.can_redo(),
            dirty: e.is_dirty(),
            columns: e.column_names(&self.source.columns()),
            view: order.as_ref().map(|o| o.spec.clone()),
            view_stale: order.as_ref().is_some_and(|o| o.stale.load(std::sync::atomic::Ordering::Relaxed)),
        }
    }

    /// Rows of the edited file, ignoring any sort or filter.
    pub fn base_row_count(&self) -> u64 {
        self.rows(&self.edits.read())
    }

    pub fn order(&self) -> Option<Arc<ViewOrder>> {
        self.order.read().clone()
    }

    /// Display row → base row.
    fn to_base(order: &Option<Arc<ViewOrder>>, row: u64) -> Option<u64> {
        match order {
            None => Some(row),
            Some(o) => o.rows.get(row as usize).map(|&b| b as u64),
        }
    }

    /// Inserting or deleting rows or columns needs the plain file order.
    pub fn require_unordered(&self) -> Result<(), String> {
        if self.order.read().is_some() {
            Err("Clear sort and filter to insert or delete".into())
        } else {
            Ok(())
        }
    }

    /// Computes and installs a sort / filter (or clears it when `spec` is empty).
    pub fn set_view(&self, spec: ViewSpec, task: &Task) -> Result<ViewState, String> {
        let shape = {
            let e = self.edits.read();
            if e.is_growing() {
                return Err("Still loading the file; sorting and filtering unlock when it finishes".into());
            }
            e.shape()
        };
        let order = self.build_order(spec, task)?;
        let mut slot = self.order.write();
        if self.edits.read().shape() != shape {
            return Err("Rows changed while this was running; try again".into());
        }
        *slot = order.map(Arc::new);
        drop(slot);
        Ok(self.view_state())
    }

    pub fn clear_view(&self) -> ViewState {
        *self.order.write() = None;
        self.view_state()
    }

    pub fn column_names(&self) -> Vec<String> {
        self.edits.read().column_names(&self.source.columns())
    }

    /// Reads display rows (sorted / filtered when a view is active).
    pub fn read_rows(&self, start: u64, count: u64) -> Vec<Vec<String>> {
        let order = self.order.read().clone();
        let Some(o) = order else { return self.read_base_rows(start, count) };
        let end = (start + count).min(o.rows.len() as u64);
        let mut out = Vec::with_capacity(end.saturating_sub(start) as usize);
        let mut i = start;
        while i < end {
            // Batch runs of consecutive base rows (common when only filtering).
            let first = o.rows[i as usize] as u64;
            let mut n = 1;
            while i + n < end && o.rows[(i + n) as usize] as u64 == first + n {
                n += 1;
            }
            let mut rows = self.read_base_rows(first, n);
            rows.resize(n as usize, Vec::new());
            out.extend(rows);
            i += n;
        }
        out
    }

    /// Reads base rows (file order) with edits applied, in view column order.
    pub fn read_base_rows(&self, start: u64, count: u64) -> Vec<Vec<String>> {
        let edits = self.edits.read();
        let source_rows = self.source.row_count();
        let refs = edits.resolve(start, count, source_rows);
        let mut out: Vec<Vec<String>> = Vec::with_capacity(refs.len());
        let mut i = 0;
        while i < refs.len() {
            match refs[i] {
                RowRef::Src(first) => {
                    // Batch contiguous source rows into one read.
                    let mut n = 1;
                    while i + n < refs.len() && refs[i + n] == RowRef::Src(first + n as u64) {
                        n += 1;
                    }
                    out.extend(self.source.read_rows(first, n as u64));
                    out.resize(i + n, Vec::new());
                    i += n;
                }
                RowRef::New(_) => {
                    out.push(Vec::new());
                    i += 1;
                }
            }
        }
        let source_columns = self.source.columns();
        let plan = edits.plan(&source_columns);
        for (row, cells) in refs.iter().zip(out.iter_mut()) {
            if let Some(raw) = edits.raw_for(*row) {
                *cells = self.source.render_raw(raw);
            }
            let patch = edits.cells_for(*row);
            if patch.is_some() || plan.defs.is_some() {
                *cells = plan.project(cells, patch);
            }
        }
        out
    }

    /// Sets cells `(view row, view column, value)` as one undo step, after the
    /// format confirms it can store each value.
    pub fn set_cells(&self, changes: Vec<CellChange>) -> Result<ViewState, String> {
        if changes.len() > MAX_BATCH_CELLS {
            return Err(format!(
                "That changes {} cells; one operation can change at most {}",
                changes.len(),
                MAX_BATCH_CELLS
            ));
        }
        {
            let order = self.order.read().clone();
            let mut e = self.edits.write();
            let source_rows = self.source.row_count();
            let rows = e.row_count(source_rows);
            let mut resolved = Vec::with_capacity(changes.len());
            for c in changes {
                let base = Self::to_base(&order, c.row).filter(|&b| b < rows).ok_or("Row out of range")?;
                let row = e.resolve(base, 1, source_rows)[0];
                let key = e.col_key(c.col).ok_or("Column out of range")?;
                self.source.check_edit(row, e.raw_for(row), key, &c.value)?;
                resolved.push((row, key, c.value));
            }
            e.set_cells(resolved);
            if let Some(o) = &order {
                o.stale.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
        Ok(self.view_state())
    }

    /// Runs an edit. One that reshapes rows or columns (e.g. undoing an
    /// insert) drops the sort / filter, whose rows would no longer line up.
    pub fn edit<T>(&self, f: impl FnOnce(&mut EditLayer) -> Result<T, String>) -> Result<ViewState, String> {
        {
            let mut order = self.order.write();
            let mut e = self.edits.write();
            e.set_source_rows(self.source.row_count());
            let shape = e.shape();
            f(&mut e)?;
            if e.shape() != shape {
                *order = None;
            }
        }
        Ok(self.view_state())
    }

    /// Changes the column plan, checking names stay unique. `f` gets the
    /// columns and a generator for new column keys.
    pub fn edit_columns(
        &self,
        f: impl FnOnce(&mut Vec<ColDef>, &mut dyn FnMut() -> u32) -> Result<(), String>,
    ) -> Result<ViewState, String> {
        if !self.source.supports_column_edits() {
            return Err("Columns of this file can't be changed".into());
        }
        self.require_unordered()?;
        let source = self.source.columns();
        self.edits.write().set_columns(&source, |defs, new_key| {
            f(defs, new_key)?;
            if defs.is_empty() {
                return Err("A table needs at least one column".into());
            }
            let mut seen = std::collections::HashSet::new();
            for d in defs.iter() {
                if d.name.trim().is_empty() {
                    return Err("Column names can't be empty".into());
                }
                if !seen.insert(d.name.as_str()) {
                    return Err(format!("A column named \"{}\" already exists", d.name));
                }
            }
            Ok(())
        })?;
        Ok(self.view_state())
    }

    /// Saves in the file's own format (see `save_as`).
    pub fn save(&self, dest: &Path, on_progress: &dyn Fn(u64, u64)) -> Result<(), String> {
        self.save_as(dest, None, false, &AtomicBool::new(false), on_progress).map(|_| ())
    }

    /// Streams the edited data to a temp file next to `dest`, then renames it
    /// into place. `format` converts (`None` keeps the file's own format);
    /// `view_only` writes just the sorted / filtered rows, in display order.
    /// Setting `cancel` stops the save and deletes the temp file.
    pub fn save_as(
        &self,
        dest: &Path,
        format: Option<ExportFormat>,
        view_only: bool,
        cancel: &AtomicBool,
        on_progress: &dyn Fn(u64, u64),
    ) -> Result<SaveSummary, String> {
        let order = if view_only { self.order() } else { None };
        let native = self.source.native_format();
        let format = format.unwrap_or(native);
        let convert = format != native || order.is_some();
        let edits = self.edits.read();
        if edits.is_growing() {
            return Err("Still loading the file; saving unlocks when it finishes".into());
        }
        let base_rows = edits.row_count(self.source.row_count());
        let rows = order.as_ref().map_or(base_rows, |o| o.rows.len() as u64);
        let columns = edits.column_names(&self.source.columns());
        self.check_space(dest, format, convert, rows as f64 / base_rows.max(1) as f64, rows, &columns)?;

        let file_name = dest.file_name().ok_or("Invalid save path")?.to_string_lossy();
        let tmp = dest.with_file_name(format!(".{file_name}.bigview-tmp"));
        let progress = |done: u64, total: u64| -> Result<(), String> {
            if cancel.load(Ordering::Relaxed) {
                return Err(super::view::CANCELLED.into());
            }
            on_progress(done, total);
            Ok(())
        };
        let result = if convert {
            self.export(&edits, order.as_deref(), &tmp, format, &progress)
        } else {
            self.source.save(&edits, &tmp, &progress).map(|_| SaveSummary { rows, ..Default::default() })
        };
        // A cancel that lands during the last step (e.g. zipping a workbook) still wins.
        let result = result.and_then(|summary| {
            if cancel.load(Ordering::Relaxed) {
                return Err(super::view::CANCELLED.into());
            }
            self.replace(&tmp, dest)?;
            Ok(summary)
        });
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        drop(edits);
        if result.is_ok() && order.is_none() {
            self.edits.write().mark_saved();
        }
        result
    }

    /// Writes rows (all, or the display order of a sort / filter) through a format writer.
    fn export(
        &self,
        edits: &EditLayer,
        order: Option<&super::view::ViewOrder>,
        dest: &Path,
        format: ExportFormat,
        progress: &dyn Fn(u64, u64) -> Result<(), String>,
    ) -> Result<SaveSummary, String> {
        let source_columns = self.source.columns();
        let columns = edits.column_names(&source_columns);
        let keys = edits.column_defs().map(|d| d.iter().map(|c| c.key).collect::<Vec<_>>());
        let large = self.source.text_size() > 128 << 20;
        let mut out = export::writer(format, dest, &columns, large)?;
        let typed = |old: &Cell, text: &str| self.source.patch_cell(old, text);
        let mut write = |row: RowRef, cells: Option<Vec<Cell>>| -> Result<(), String> {
            let cells = match edits.raw_for(row) {
                Some(raw) => self.source.raw_cells(raw),
                None => cells.unwrap_or_default(),
            };
            out.row(&export::project(keys.as_deref(), cells, edits.cells_for(row), &typed))
        };
        match order {
            None => edits.for_each_row(
                &|start, n| self.source.read_cells(start, n),
                &mut |row, cells, _| write(row, cells),
                progress,
            )?,
            Some(order) => {
                const BATCH: usize = 4096;
                let source_rows = self.source.row_count();
                let total = order.rows.len() as u64;
                for (b, chunk) in order.rows.chunks(BATCH).enumerate() {
                    let mut i = 0;
                    while i < chunk.len() {
                        // Runs of consecutive base rows read together (common when only filtering).
                        let first = chunk[i] as u64;
                        let mut n = 1;
                        while i + n < chunk.len() && chunk[i + n] as u64 == first + n as u64 {
                            n += 1;
                        }
                        let refs = edits.resolve(first, n as u64, source_rows);
                        let mut k = 0;
                        while k < refs.len() {
                            match refs[k] {
                                RowRef::Src(s) => {
                                    let mut m = 1;
                                    while k + m < refs.len() && refs[k + m] == RowRef::Src(s + m as u64) {
                                        m += 1;
                                    }
                                    let mut cells = self.source.read_cells(s, m as u64);
                                    cells.resize(m, Vec::new());
                                    for (j, c) in cells.into_iter().enumerate() {
                                        write(refs[k + j], Some(c))?;
                                    }
                                    k += m;
                                }
                                row @ RowRef::New(_) => {
                                    write(row, None)?;
                                    k += 1;
                                }
                            }
                        }
                        i += n;
                    }
                    progress((b * BATCH + chunk.len()) as u64, total)?;
                }
            }
        }
        out.finish()
    }

    /// Refuses to start a save that would run out of disk space part way.
    /// Sizes are estimates; when free space can't be read, the save goes ahead.
    fn check_space(&self, dest: &Path, format: ExportFormat, convert: bool, share: f64, rows: u64, columns: &[String]) -> Result<(), String> {
        let text = self.source.text_size() as f64 * share;
        // Bytes the file takes, and scratch space in the temp dir (Excel writes sheets there first).
        let (out, scratch) = match format {
            _ if !convert && format != ExportFormat::Xlsx => (self.source.file_size() as f64, 0.0),
            // Sheet XML runs about 4x the cell text; the zipped workbook about a third of it.
            ExportFormat::Xlsx => (text * 0.4, text * 4.0),
            ExportFormat::Json | ExportFormat::JsonLines if !matches!(self.source.native_format(), ExportFormat::Json | ExportFormat::JsonLines) => {
                // Every record repeats the column names.
                let per_row: usize = columns.iter().map(|c| c.len() + 4).sum::<usize>() + 4;
                (text + rows as f64 * per_row as f64, 0.0)
            }
            _ => (text, 0.0),
        };
        let need = |bytes: f64| (bytes * 1.05) as u64 + (64 << 20);
        let dir = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let temp = std::env::temp_dir();
        let checks: Vec<(&Path, u64)> = if scratch == 0.0 {
            vec![(dir, need(out))]
        } else if same_volume(dir, &temp) {
            vec![(dir, need(out + scratch))]
        } else {
            vec![(dir, need(out)), (&temp, need(scratch))]
        };
        for (path, need) in checks {
            let Ok(free) = fs4::available_space(path) else { continue };
            if free < need {
                return Err(format!(
                    "Not enough disk space: this save needs about {} free on the drive holding {}, and only {} is free",
                    human_bytes(need),
                    path.display(),
                    human_bytes(free)
                ));
            }
        }
        Ok(())
    }

    /// Moves the finished temp file into place.
    fn replace(&self, tmp: &Path, dest: &Path) -> Result<(), String> {
        // Windows can't replace a file that is memory-mapped (this session's
        // own file). The map is released by moving the original aside under a
        // new name (allowed while mapped), then the session remaps nothing: it
        // keeps reading the moved file, which is deleted once the file closes.
        #[cfg(windows)]
        if self.source.maps_file() && same_file(dest, &self.path) {
            let aside = moved_aside_path(dest);
            std::fs::rename(dest, &aside).map_err(|e| format!("Can't replace the open file: {e}"))?;
            if let Err(e) = std::fs::rename(tmp, dest) {
                let _ = std::fs::rename(&aside, dest);
                return Err(e.to_string());
            }
            self.moved_aside.0.lock().push(aside);
            return Ok(());
        }
        std::fs::rename(tmp, dest).map_err(|e| e.to_string())
    }

    /// Runs `f` with read access to the edits (for searches and exports).
    pub fn with_edits<T>(&self, f: impl FnOnce(&EditLayer) -> T) -> T {
        f(&self.edits.read())
    }
}

#[cfg(windows)]
fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

#[cfg(windows)]
fn moved_aside_path(dest: &Path) -> PathBuf {
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    dest.with_file_name(format!(".{name}.bigview-old-{stamp}"))
}

#[cfg(unix)]
fn same_volume(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_volume(a: &Path, b: &Path) -> bool {
    let root = |p: &Path| std::fs::canonicalize(p).ok().and_then(|p| p.components().next().map(|c| c.as_os_str().to_owned()));
    root(a).is_some() && root(a) == root(b)
}

fn human_bytes(n: u64) -> String {
    let gb = n as f64 / (1u64 << 30) as f64;
    if gb >= 1.0 { format!("{gb:.1} GB") } else { format!("{} MB", n >> 20) }
}
