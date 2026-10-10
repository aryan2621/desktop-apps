//! Column statistics and selection totals, in one parallel pass.

use std::collections::HashMap;

use rayon::prelude::*;
use serde::Serialize;

use super::session::Session;
use super::sort::parse_num;
use super::view::{RowSet, Task};

/// Distinct values tracked exactly up to this many; beyond it counts are approximate.
const MAX_DISTINCT: usize = 250_000;
const TOP: usize = 100;
/// Most cells the status bar totals read at once.
pub const MAX_SELECTION_CELLS: u64 = 20_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnStats {
    pub rows: u64,
    pub empty: u64,
    pub distinct: u64,
    /// More distinct values than tracked; `distinct` is a lower bound and `top` approximate.
    pub distinct_capped: bool,
    /// Most non-empty cells are numbers.
    pub numeric: bool,
    pub numbers: u64,
    pub min: Option<String>,
    pub max: Option<String>,
    pub sum: Option<f64>,
    pub avg: Option<f64>,
    /// Most common values with their counts.
    pub top: Vec<(String, u64)>,
}

#[derive(Default)]
struct Acc {
    rows: u64,
    empty: u64,
    numbers: u64,
    sum: f64,
    min_n: Option<f64>,
    max_n: Option<f64>,
    min_t: Option<String>,
    max_t: Option<String>,
    counts: HashMap<String, u64>,
    capped: bool,
}

impl Acc {
    fn add(&mut self, v: &str) {
        self.rows += 1;
        if v.trim().is_empty() {
            self.empty += 1;
            return;
        }
        if let Some(n) = parse_num(v) {
            self.numbers += 1;
            self.sum += n;
            self.min_n = Some(self.min_n.map_or(n, |m| m.min(n)));
            self.max_n = Some(self.max_n.map_or(n, |m| m.max(n)));
        }
        if self.min_t.as_deref().is_none_or(|m| v < m) {
            self.min_t = Some(v.to_string());
        }
        if self.max_t.as_deref().is_none_or(|m| v > m) {
            self.max_t = Some(v.to_string());
        }
        self.count(v, 1);
    }

    fn count(&mut self, v: &str, n: u64) {
        if let Some(c) = self.counts.get_mut(v) {
            *c += n;
        } else if self.counts.len() < MAX_DISTINCT {
            self.counts.insert(v.to_string(), n);
        } else {
            self.capped = true;
        }
    }

    fn merge(mut self, mut other: Acc) -> Acc {
        if other.counts.len() > self.counts.len() {
            std::mem::swap(&mut self.counts, &mut other.counts);
        }
        for (v, n) in other.counts {
            self.count(&v, n);
        }
        let pick = |a: Option<f64>, b: Option<f64>, f: fn(f64, f64) -> f64| match (a, b) {
            (Some(x), Some(y)) => Some(f(x, y)),
            (x, y) => x.or(y),
        };
        self.rows += other.rows;
        self.empty += other.empty;
        self.numbers += other.numbers;
        self.sum += other.sum;
        self.min_n = pick(self.min_n, other.min_n, f64::min);
        self.max_n = pick(self.max_n, other.max_n, f64::max);
        self.min_t = match (self.min_t, other.min_t) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        self.max_t = match (self.max_t, other.max_t) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
        self.capped |= other.capped;
        self
    }
}

fn fmt_num(v: f64) -> String {
    // Display prints integers without ".0" and keeps full precision otherwise.
    format!("{v}")
}

/// Stats of view column `col` over the shown rows (after filtering).
pub fn column_stats(session: &Session, col: u32, task: &Task) -> Result<ColumnStats, String> {
    let order = session.order();
    let shown = order.as_ref().map(|o| o.ascending());
    let set = match &shown {
        Some(rows) => RowSet::Some(rows),
        None => RowSet::All(session.base_row_count()),
    };
    task.total.store(set.len() as u64, std::sync::atomic::Ordering::Relaxed);
    let c = col as usize;
    let acc = session.scan_fold(
        set,
        task,
        Acc::default,
        |mut acc, _, cells| {
            for row in &cells {
                acc.add(row.get(c).map_or("", String::as_str));
            }
            acc
        },
        Acc::merge,
    )?;
    let filled = acc.rows - acc.empty;
    let numeric = acc.numbers > 0 && acc.numbers as f64 >= filled as f64 * 0.95;
    let mut top: Vec<(String, u64)> = acc.counts.iter().map(|(v, &n)| (v.clone(), n)).collect();
    top.par_sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    top.truncate(TOP);
    Ok(ColumnStats {
        rows: acc.rows,
        empty: acc.empty,
        distinct: acc.counts.len() as u64,
        distinct_capped: acc.capped,
        numeric,
        numbers: acc.numbers,
        min: if numeric { acc.min_n.map(fmt_num) } else { acc.min_t },
        max: if numeric { acc.max_n.map(fmt_num) } else { acc.max_t },
        sum: numeric.then_some(acc.sum),
        avg: (numeric && acc.numbers > 0).then(|| acc.sum / acc.numbers as f64),
        top,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionStats {
    /// Non-empty cells.
    pub count: u64,
    pub numbers: u64,
    pub sum: f64,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

/// Totals over display rows `start..start + count` in view columns `cols`.
pub fn selection_stats(session: &Session, start: u64, count: u64, cols: &[u32]) -> Result<SelectionStats, String> {
    if count.saturating_mul(cols.len() as u64) > MAX_SELECTION_CELLS {
        return Err("Selection too large to total".into());
    }
    const BATCH: u64 = 8192;
    let starts: Vec<u64> = (start..start + count).step_by(BATCH as usize).collect();
    let parts: Vec<SelectionStats> = starts
        .par_iter()
        .map(|&at| {
            let mut s = SelectionStats { count: 0, numbers: 0, sum: 0.0, min: None, max: None };
            for row in session.read_rows(at, BATCH.min(start + count - at)) {
                for &c in cols {
                    let v = row.get(c as usize).map_or("", String::as_str);
                    if v.trim().is_empty() {
                        continue;
                    }
                    s.count += 1;
                    if let Some(n) = parse_num(v) {
                        s.numbers += 1;
                        s.sum += n;
                        s.min = Some(s.min.map_or(n, |m| m.min(n)));
                        s.max = Some(s.max.map_or(n, |m| m.max(n)));
                    }
                }
            }
            s
        })
        .collect();
    Ok(parts.into_iter().fold(SelectionStats { count: 0, numbers: 0, sum: 0.0, min: None, max: None }, |a, b| {
        SelectionStats {
            count: a.count + b.count,
            numbers: a.numbers + b.numbers,
            sum: a.sum + b.sum,
            min: [a.min, b.min].into_iter().flatten().reduce(f64::min),
            max: [a.max, b.max].into_iter().flatten().reduce(f64::max),
        }
    }))
}
