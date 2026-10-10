//! Find and replace across the whole file.
//!
//! 1. A parallel regex scan over raw row bytes finds candidate source rows.
//! 2. Candidates are confirmed on their cell text (so delimiters, JSON keys or
//!    Excel type tags never produce false hits) and placed in view order.
//! 3. Rows the user changed are checked separately on their edited cells.

use std::borrow::Cow;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use parking_lot::Mutex;
use rayon::prelude::*;
use serde::Deserialize;

use super::edits::{RowRef, NEW_COL};
use super::index::RowIndex;
use super::session::Session;

/// Rows per parallel scan chunk.
const CHUNK_ROWS: u64 = 64 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub text: String,
    pub match_case: bool,
    pub regex: bool,
    /// View column to search in; all columns when absent.
    pub column: Option<u32>,
}

pub struct Matcher {
    /// Finds rows worth checking in raw bytes, or `None` when every row must be checked.
    pub prefilter: Option<regex::bytes::Regex>,
    /// The real test, run on cell text.
    pub text: regex::Regex,
}

impl Matcher {
    pub fn new(q: &Query) -> Result<Self, String> {
        let pattern = if q.regex { q.text.clone() } else { regex::escape(&q.text) };
        let text = regex::RegexBuilder::new(&pattern)
            .case_insensitive(!q.match_case)
            .build()
            .map_err(|e| format!("Invalid pattern: {e}"))?;
        if text.is_match("") {
            return Err("This pattern matches empty text, so every cell would match".into());
        }
        Ok(Self { prefilter: prefilter(&pattern, q.match_case), text })
    }
}

/// A raw-byte search for literals every match must start with. Anchors and
/// other cell-level syntax can't run on raw bytes (cells sit inside rows, and
/// files escape quotes and backslashes), so only plain literals are used.
fn prefilter(pattern: &str, match_case: bool) -> Option<regex::bytes::Regex> {
    use regex_syntax::hir::literal::{ExtractKind, Extractor};
    let hir = regex_syntax::ParserBuilder::new().case_insensitive(!match_case).build().parse(pattern).ok()?;
    let seq = Extractor::new().kind(ExtractKind::Prefix).limit_total(256).extract(&hir);
    let lits = seq.literals()?;
    // Short literals filter too little to beat checking every row; escaped bytes never appear raw.
    let usable = |l: &[u8]| l.len() >= 2 && !l.iter().any(|b| matches!(b, b'"' | b'\\' | b'\n' | b'\r'));
    if lits.is_empty() || !lits.iter().all(|l| usable(l.as_bytes())) {
        return None;
    }
    let alternation = lits
        .iter()
        .map(|l| regex::escape(&String::from_utf8_lossy(l.as_bytes())))
        .collect::<Vec<_>>()
        .join("|");
    regex::bytes::RegexBuilder::new(&alternation).case_insensitive(!match_case).build().ok()
}

/// A running or finished search. Hits are display rows, ascending.
pub struct SearchRun {
    pub id: u64,
    pub query: Query,
    pub matcher: Matcher,
    pub hits: Mutex<Vec<u64>>,
    pub done: AtomicBool,
    pub cancel: AtomicBool,
    pub scanned: AtomicU64,
}

/// Source rows whose raw bytes match, scanned in parallel chunks. `read`
/// returns the bytes between two offsets of `index`.
pub fn scan_rows<'a>(
    index: &RowIndex,
    read: &(dyn Fn(u64, u64) -> Option<Cow<'a, [u8]>> + Sync),
    re: &regex::bytes::Regex,
    cancel: &AtomicBool,
    scanned: &AtomicU64,
) -> Vec<u64> {
    let rows = index.row_count();
    let starts: Vec<u64> = (0..rows).step_by(CHUNK_ROWS as usize).collect();
    let chunks: Vec<Vec<u64>> = starts
        .par_iter()
        .map(|&start| {
            if cancel.load(Ordering::Relaxed) {
                return Vec::new();
            }
            let bounds = index.row_bounds(start, CHUNK_ROWS);
            let (Some(&from), Some(&to)) = (bounds.first(), bounds.last()) else { return Vec::new() };
            let Some(bytes) = read(from, to) else { return Vec::new() };
            let mut hits = Vec::new();
            let mut pos = 0;
            while let Some(m) = re.find_at(&bytes, pos) {
                let abs = from + m.start() as u64;
                let i = bounds.partition_point(|&o| o <= abs).saturating_sub(1);
                hits.push(start + i as u64);
                // One hit per row is enough: continue at the next row.
                match bounds.get(i + 1) {
                    Some(&next) if next > abs => pos = (next - from) as usize,
                    _ => break,
                }
                if pos >= bytes.len() {
                    break;
                }
            }
            scanned.fetch_add(bounds.len() as u64 - 1, Ordering::Relaxed);
            hits
        })
        .collect();
    chunks.concat()
}

/// Whether a row's cells match, in one view column (by key) or any.
fn cells_match(cells: &[String], re: &regex::Regex, col: Option<usize>) -> bool {
    match col {
        Some(c) => cells.get(c).is_some_and(|v| re.is_match(v)),
        None => cells.iter().any(|v| re.is_match(v)),
    }
}

/// First view column of `cells` that matches.
pub fn first_match(cells: &[String], re: &regex::Regex, col: Option<u32>) -> Option<u32> {
    match col {
        Some(c) => cells.get(c as usize).is_some_and(|v| re.is_match(v)).then_some(c),
        None => cells.iter().position(|v| re.is_match(v)).map(|i| i as u32),
    }
}

impl Session {
    /// Runs a search to completion (or cancellation), storing hits in `run`.
    pub fn run_search(&self, run: &SearchRun) {
        let source_rows = self.source.row_count();
        let candidates = match &run.matcher.prefilter {
            Some(re) => self.source.candidate_rows(re, &run.cancel, &run.scanned),
            None => {
                run.scanned.store(source_rows, Ordering::Relaxed);
                (0..source_rows).collect()
            }
        };
        if run.cancel.load(Ordering::Relaxed) {
            return;
        }

        let (runs, touched, new_rows, key, visible) = self.with_edits(|e| {
            let key = run.query.column.and_then(|c| e.col_key(c));
            let touched: std::collections::HashSet<RowRef> = e.touched_rows().collect();
            // With an edited column plan, only source columns still shown count.
            let visible: Option<Vec<usize>> = e
                .column_defs()
                .map(|d| d.iter().filter(|c| c.key & NEW_COL == 0).map(|c| c.key as usize).collect());
            (e.src_runs(source_rows), touched, e.new_rows(), key, visible)
        });
        let col_filter = run.query.column.is_some();

        // Untouched source rows: confirm on source cells, then place in view order.
        let mut hits: Vec<u64> = candidates
            .par_iter()
            .filter(|&&r| !touched.contains(&RowRef::Src(r)))
            .filter_map(|&r| {
                let cells = self.source.read_rows(r, 1).pop().unwrap_or_default();
                let ok = match (col_filter, key) {
                    (true, Some(k)) if k & NEW_COL == 0 => cells_match(&cells, &run.matcher.text, Some(k as usize)),
                    // A search in an added column only finds edited cells.
                    (true, _) => false,
                    (false, _) => match &visible {
                        None => cells_match(&cells, &run.matcher.text, None),
                        Some(keys) => keys.iter().any(|&k| cells.get(k).is_some_and(|v| run.matcher.text.is_match(v))),
                    },
                };
                if !ok {
                    return None;
                }
                let i = runs.partition_point(|&(s, _, _)| s <= r).checked_sub(1)?;
                let (s, v, len) = runs[i];
                (r < s + len).then_some(v + (r - s))
            })
            .collect();

        // Edited and added rows: check what the user sees.
        let mut view_rows: Vec<u64> = touched
            .iter()
            .filter_map(|row| match *row {
                RowRef::Src(r) => {
                    let i = runs.partition_point(|&(s, _, _)| s <= r).checked_sub(1)?;
                    let (s, v, len) = runs[i];
                    (r < s + len).then_some(v + (r - s))
                }
                RowRef::New(_) => None,
            })
            .collect();
        view_rows.extend(new_rows.iter().map(|&(v, _)| v));
        for v in view_rows {
            if run.cancel.load(Ordering::Relaxed) {
                return;
            }
            let cells = self.read_base_rows(v, 1).pop().unwrap_or_default();
            if cells_match(&cells, &run.matcher.text, run.query.column.map(|c| c as usize)) {
                hits.push(v);
            }
        }
        // Hits so far are base rows; a sort or filter moves or hides them.
        if let Some(order) = self.order() {
            hits = hits.into_iter().filter_map(|b| order.display_of(b)).collect();
        }
        hits.sort_unstable();
        hits.dedup();
        *run.hits.lock() = hits;
        run.done.store(true, Ordering::Release);
    }
}
