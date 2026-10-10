//! Sorted and filtered views: a display order over the edited rows, plus the
//! cancellable, parallel row scans that build it.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use super::filter::{self, Filter};
use super::session::Session;
use super::sort::{self, SortKey};

/// Rows per parallel read; small enough that wide rows stay cheap to hold.
const CHUNK: usize = 8192;

pub const CANCELLED: &str = "Cancelled";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSpec {
    /// Sort keys, most significant first.
    #[serde(default)]
    pub sort: Vec<SortKey>,
    /// Conditions combined with AND.
    #[serde(default)]
    pub filters: Vec<Filter>,
}

impl ViewSpec {
    pub fn is_empty(&self) -> bool {
        self.sort.is_empty() && self.filters.is_empty()
    }
}

pub struct ViewOrder {
    pub spec: ViewSpec,
    /// Display row → base row.
    pub rows: Vec<u32>,
    /// Cells changed since this order was built.
    pub stale: AtomicBool,
    base_rows: u64,
    inverse: OnceLock<Vec<u32>>,
}

impl ViewOrder {
    /// Where base row `base` is shown, if the filter keeps it.
    pub fn display_of(&self, base: u64) -> Option<u64> {
        let inv = self.inverse.get_or_init(|| {
            let mut inv = vec![u32::MAX; self.base_rows as usize];
            for (d, &b) in self.rows.iter().enumerate() {
                inv[b as usize] = d as u32;
            }
            inv
        });
        inv.get(base as usize).filter(|&&d| d != u32::MAX).map(|&d| d as u64)
    }

    /// The shown base rows in file order (for scans where order doesn't matter).
    pub fn ascending(&self) -> Vec<u32> {
        if self.spec.sort.is_empty() {
            return self.rows.clone();
        }
        let mut rows = self.rows.clone();
        rows.par_sort_unstable();
        rows
    }
}

/// Progress and cancellation for a long sort, filter or stats pass.
#[derive(Default)]
pub struct Task {
    pub cancel: AtomicBool,
    pub done: AtomicU64,
    pub total: AtomicU64,
    pub finished: AtomicBool,
}

impl Task {
    pub fn check(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }
}

/// Which base rows a scan reads.
#[derive(Clone, Copy)]
pub enum RowSet<'a> {
    /// Base rows `0..n`.
    All(u64),
    /// These base rows, ascending.
    Some(&'a [u32]),
}

impl RowSet<'_> {
    pub fn len(&self) -> usize {
        match self {
            RowSet::All(n) => *n as usize,
            RowSet::Some(rows) => rows.len(),
        }
    }
}

impl Session {
    /// Reads one chunk of a row set: its base row ids and their cells.
    fn read_chunk(&self, set: RowSet, from: usize, to: usize) -> (Vec<u32>, Vec<Vec<String>>) {
        match set {
            RowSet::All(_) => {
                let mut cells = self.read_base_rows(from as u64, (to - from) as u64);
                cells.resize(to - from, Vec::new());
                ((from as u32..to as u32).collect(), cells)
            }
            RowSet::Some(rows) => {
                let ids = &rows[from..to];
                let mut cells = Vec::with_capacity(ids.len());
                let mut i = 0;
                while i < ids.len() {
                    let mut n = 1;
                    while i + n < ids.len() && ids[i + n] == ids[i] + n as u32 {
                        n += 1;
                    }
                    let mut run = self.read_base_rows(ids[i] as u64, n as u64);
                    run.resize(n, Vec::new());
                    cells.extend(run);
                    i += n;
                }
                (ids.to_vec(), cells)
            }
        }
    }

    /// Maps every chunk of `set` in parallel; results come back in row order.
    pub fn scan_map<R: Send>(
        &self,
        set: RowSet,
        task: &Task,
        f: impl Fn(&[u32], Vec<Vec<String>>) -> R + Sync,
    ) -> Result<Vec<R>, String> {
        let starts: Vec<usize> = (0..set.len()).step_by(CHUNK).collect();
        let out: Vec<Option<R>> = starts
            .par_iter()
            .map(|&from| {
                if task.cancel.load(Ordering::Relaxed) {
                    return None;
                }
                let to = (from + CHUNK).min(set.len());
                let (ids, cells) = self.read_chunk(set, from, to);
                let r = f(&ids, cells);
                task.done.fetch_add((to - from) as u64, Ordering::Relaxed);
                Some(r)
            })
            .collect();
        task.check()?;
        Ok(out.into_iter().map(Option::unwrap).collect())
    }

    /// Folds every chunk of `set` in parallel into accumulators, then merges them.
    pub fn scan_fold<A: Send>(
        &self,
        set: RowSet,
        task: &Task,
        init: impl Fn() -> A + Sync + Send,
        fold: impl Fn(A, &[u32], Vec<Vec<String>>) -> A + Sync + Send,
        merge: impl Fn(A, A) -> A + Sync + Send,
    ) -> Result<A, String> {
        let starts: Vec<usize> = (0..set.len()).step_by(CHUNK).collect();
        let acc = starts
            .par_iter()
            .fold(&init, |acc, &from| {
                if task.cancel.load(Ordering::Relaxed) {
                    return acc;
                }
                let to = (from + CHUNK).min(set.len());
                let (ids, cells) = self.read_chunk(set, from, to);
                let acc = fold(acc, &ids, cells);
                task.done.fetch_add((to - from) as u64, Ordering::Relaxed);
                acc
            })
            .reduce(&init, &merge);
        task.check()?;
        Ok(acc)
    }

    /// The display order for `spec`, or `None` when it sorts and filters nothing.
    pub fn build_order(&self, spec: ViewSpec, task: &Task) -> Result<Option<ViewOrder>, String> {
        if spec.is_empty() {
            return Ok(None);
        }
        let base_rows = self.base_row_count();
        if base_rows >= u32::MAX as u64 {
            return Err("This file has too many rows to sort or filter".into());
        }
        let columns = self.column_names().len() as u32;
        if spec.sort.iter().map(|k| k.col).chain(spec.filters.iter().map(|f| f.col)).any(|c| c >= columns) {
            return Err("Column out of range".into());
        }
        let passes = !spec.filters.is_empty() as u64 + !spec.sort.is_empty() as u64;
        task.total.store(base_rows * passes, Ordering::Relaxed);

        let mut rows = if spec.filters.is_empty() {
            (0..base_rows as u32).collect()
        } else {
            filter::run(self, &spec.filters, base_rows, task)?
        };
        if !spec.sort.is_empty() {
            // Filtering may have left fewer rows to read.
            task.total.store(base_rows * (passes - 1) + rows.len() as u64, Ordering::Relaxed);
            let all = rows.len() as u64 == base_rows;
            sort::sort_rows(self, &mut rows, all, &spec.sort, task)?;
        }
        Ok(Some(ViewOrder { spec, rows, stale: AtomicBool::new(false), base_rows, inverse: OnceLock::new() }))
    }
}
