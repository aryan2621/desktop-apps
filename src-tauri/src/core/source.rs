use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::Serialize;

use super::edits::{EditLayer, RowRef};
use super::export::{Cell, ExportFormat};

/// Most column keys stay below this; see `edits::NEW_COL`.
pub use super::edits::NEW_COL;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub rows: u64,
    /// Work units are format-specific (bytes for CSV/JSON, rows for Excel);
    /// only the ratio matters.
    pub work_done: u64,
    pub work_total: u64,
    pub done: bool,
}

/// A tabular view over a file on disk. Implementations must never load the
/// whole file: rows are located through a background-built index and parsed
/// on demand.
pub trait DataSource: Send + Sync + 'static {
    fn format(&self) -> &'static str;

    /// Lets commands reach format-specific features, like the JSON tree.
    fn as_any(&self) -> &dyn std::any::Any;
    fn columns(&self) -> Vec<String>;
    fn file_size(&self) -> u64;

    /// Extra context shown next to the format, e.g. the JSON path of the rows.
    fn detail(&self) -> Option<String> {
        None
    }

    /// Sheet names for workbook formats, and the one shown.
    fn sheets(&self) -> (Vec<String>, Option<String>) {
        (Vec::new(), None)
    }

    /// Rejects an edit the format can't represent faithfully. `raw` is the
    /// row's replaced text, if the JSON view replaced it; `key` is a column key.
    fn check_edit(&self, _row: RowRef, _raw: Option<&str>, _key: u32, _value: &str) -> Result<(), String> {
        Ok(())
    }

    /// Cells for a record whose text was replaced in the JSON view.
    fn render_raw(&self, _text: &str) -> Vec<String> {
        Vec::new()
    }

    /// What a plain save writes; Save As in any other format converts.
    fn native_format(&self) -> ExportFormat;

    /// Rough size of the row text, for free-space estimates.
    fn text_size(&self) -> u64 {
        self.file_size()
    }

    /// Typed cells for export. By default every cell is text, typed on the way out.
    fn read_cells(&self, start: u64, count: u64) -> Vec<Vec<Cell>> {
        self.read_rows(start, count).into_iter().map(|r| r.into_iter().map(Cell::text).collect()).collect()
    }

    /// Typed cells of a record whose text was replaced in the JSON view.
    fn raw_cells(&self, text: &str) -> Vec<Cell> {
        self.render_raw(text).into_iter().map(Cell::text).collect()
    }

    /// A typed-in cell value as an export cell, given the cell it replaces.
    fn patch_cell(&self, _old: &Cell, text: &str) -> Cell {
        Cell::text(text.to_string())
    }

    /// Whether the file itself is memory-mapped (Windows can't replace a mapped file).
    fn maps_file(&self) -> bool {
        false
    }

    /// Source rows whose raw text might match (confirmed on cells afterwards).
    /// The default reads every row; formats with raw bytes scan them instead.
    fn candidate_rows(&self, re: &regex::bytes::Regex, cancel: &AtomicBool, scanned: &AtomicU64) -> Vec<u64> {
        scan_by_reading(self, re, cancel, scanned)
    }

    /// Open options as resolved (detected delimiter, encoding, header).
    fn options(&self) -> crate::formats::OpenOptions {
        Default::default()
    }

    /// Whether columns can be added, removed, renamed or moved.
    fn supports_column_edits(&self) -> bool {
        true
    }

    /// Why indexing stopped early, if it did.
    fn index_error(&self) -> Option<String> {
        None
    }

    /// Rows that can be read right now (grows while indexing).
    fn row_count(&self) -> u64;
    fn progress(&self) -> Progress;

    /// Builds the row index. Blocks until done or cancelled, so it must be
    /// called from a background thread.
    fn build_index(&self, on_progress: &dyn Fn(Progress));
    fn cancel(&self);

    /// Reads `count` rows starting at source row `start`, clamped to what is indexed.
    fn read_rows(&self, start: u64, count: u64) -> Vec<Vec<String>>;

    /// Writes the source with `edits` applied to `dest`. Callers handle the
    /// temp-file + rename dance. An error from `on_progress` (cancel) stops it.
    fn save(
        &self,
        edits: &EditLayer,
        dest: &Path,
        on_progress: &dyn Fn(u64, u64) -> Result<(), String>,
    ) -> Result<(), String>;
}

/// Finds rows by reading and testing every cell. Slower than a raw byte scan,
/// but right for any encoding.
pub fn scan_by_reading<S: DataSource + ?Sized>(
    source: &S,
    re: &regex::bytes::Regex,
    cancel: &AtomicBool,
    scanned: &AtomicU64,
) -> Vec<u64> {
    use rayon::prelude::*;
    const BATCH: u64 = 8192;
    let rows = source.row_count();
    let starts: Vec<u64> = (0..rows).step_by(BATCH as usize).collect();
    let chunks: Vec<Vec<u64>> = starts
        .par_iter()
        .map(|&at| {
            if cancel.load(Ordering::Relaxed) {
                return Vec::new();
            }
            let batch = source.read_rows(at, BATCH);
            scanned.fetch_add(batch.len() as u64, Ordering::Relaxed);
            batch
                .iter()
                .enumerate()
                .filter(|(_, cells)| cells.iter().any(|c| re.is_match(c.as_bytes())))
                .map(|(i, _)| at + i as u64)
                .collect()
        })
        .collect();
    chunks.concat()
}
