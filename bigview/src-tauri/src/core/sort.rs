//! Multi-column sort of millions of rows in bounded memory.
//!
//! Each row gets a 16-byte key per sort column: a number's order-preserving
//! bits, or the first 15 case-folded bytes of its text plus a "longer" flag.
//! Rows are sorted on those keys in parallel; only runs whose texts tie on all
//! 15 bytes are re-read and compared in full.

use std::cmp::Ordering;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use super::session::Session;
use super::view::{RowSet, Task};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    /// View column.
    pub col: u32,
    #[serde(default)]
    pub desc: bool,
}

/// Empty cells (and non-numbers in a number column) sort last in both directions.
const EMPTY: u128 = u128::MAX;
const PREFIX: usize = 15;
/// A column sorts as numbers when this share of its non-empty sampled cells parse.
const NUMERIC_SHARE: f64 = 0.95;

/// Parses a number cell, allowing spaces and thousands separators ("1,234.5").
pub fn parse_num(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let v = match t.parse::<f64>() {
        Ok(v) => v,
        Err(_) if t.contains(',') => t.replace(',', "").parse::<f64>().ok()?,
        Err(_) => return None,
    };
    // "inf" and "NaN" parse in Rust but aren't numbers to a user.
    v.is_finite().then_some(v)
}

fn num_key(v: f64) -> u128 {
    let b = v.to_bits();
    (if b >> 63 == 1 { !b } else { b | 1 << 63 }) as u128
}

fn text_key(s: &str) -> u128 {
    let b = s.as_bytes();
    let mut k: u128 = 0;
    for i in 0..PREFIX {
        k = k << 8 | b.get(i).map_or(0, |c| c.to_ascii_lowercase()) as u128;
    }
    k << 8 | (b.len() > PREFIX) as u128
}

fn is_long(k: u128) -> bool {
    k != EMPTY && k & 1 == 1
}

fn cell_key(v: &str, numeric: bool) -> u128 {
    if v.trim().is_empty() {
        EMPTY
    } else if numeric {
        parse_num(v).map_or(EMPTY, num_key)
    } else {
        text_key(v)
    }
}

fn cmp_key(a: u128, b: u128, desc: bool) -> Ordering {
    match (a == EMPTY, b == EMPTY) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        _ if desc => b.cmp(&a),
        _ => a.cmp(&b),
    }
}

/// Which sort columns hold numbers, judged on samples spread over the file.
fn numeric_columns(session: &Session, keys: &[SortKey]) -> Vec<bool> {
    let rows = session.base_row_count();
    let windows = 16u64;
    let mut seen = vec![(0u64, 0u64); keys.len()];
    for w in 0..windows {
        for cells in session.read_base_rows(rows * w / windows, 512) {
            for (k, key) in keys.iter().enumerate() {
                let v = cells.get(key.col as usize).map_or("", String::as_str);
                if !v.trim().is_empty() {
                    seen[k].0 += 1;
                    seen[k].1 += parse_num(v).is_some() as u64;
                }
            }
        }
    }
    seen.iter().map(|&(filled, nums)| filled > 0 && nums as f64 >= filled as f64 * NUMERIC_SHARE).collect()
}

struct Keys<'a> {
    keys: &'a [SortKey],
    numeric: Vec<bool>,
    /// `compact[pos * keys.len() + k]`: key `k` of row position `pos`.
    compact: Vec<u128>,
}

impl Keys<'_> {
    fn at(&self, pos: u32, k: usize) -> u128 {
        self.compact[pos as usize * self.keys.len() + k]
    }

    /// Compares two row positions on keys `from..`, then on position (stable).
    fn cmp_from(&self, a: u32, b: u32, from: usize) -> Ordering {
        for k in from..self.keys.len() {
            let o = cmp_key(self.at(a, k), self.at(b, k), self.keys[k].desc);
            if o != Ordering::Equal {
                return o;
            }
        }
        a.cmp(&b)
    }
}

/// Sorts `rows` (base rows, ascending; `all` when they are every row) by `keys`.
pub fn sort_rows(session: &Session, rows: &mut Vec<u32>, all: bool, keys: &[SortKey], task: &Task) -> Result<(), String> {
    let numeric = numeric_columns(session, keys);
    let set = if all { RowSet::All(rows.len() as u64) } else { RowSet::Some(rows) };
    let chunks = session.scan_map(set, task, |_, cells| {
        let mut out = Vec::with_capacity(cells.len() * keys.len());
        for row in &cells {
            for (k, key) in keys.iter().enumerate() {
                out.push(cell_key(row.get(key.col as usize).map_or("", String::as_str), numeric[k]));
            }
        }
        out
    })?;
    // Move chunks over one by one so the keys are never held twice.
    let mut compact = Vec::with_capacity(rows.len() * keys.len());
    for chunk in chunks {
        compact.extend(chunk);
    }
    let keyed = Keys { keys, numeric, compact };
    let mut perm: Vec<u32> = (0..rows.len() as u32).collect();
    perm.par_sort_unstable_by(|&a, &b| keyed.cmp_from(a, b, 0));
    refine(session, rows, &keyed, &mut perm, 0, task)?;
    *rows = perm.iter().map(|&p| rows[p as usize]).collect();
    Ok(())
}

/// `perm` is sorted on compact keys and its rows tie on every key before
/// `level`. Re-sorts runs whose texts tie only on their first 15 bytes.
fn refine(session: &Session, rows: &[u32], keyed: &Keys, perm: &mut [u32], level: usize, task: &Task) -> Result<(), String> {
    if level >= keyed.keys.len() || perm.len() < 2 {
        return Ok(());
    }
    let mut i = 0;
    while i < perm.len() {
        let k = keyed.at(perm[i], level);
        let mut j = i + 1;
        while j < perm.len() && keyed.at(perm[j], level) == k {
            j += 1;
        }
        let group = &mut perm[i..j];
        if group.len() > 1 {
            if is_long(k) && !keyed.numeric[level] {
                task.check()?;
                let col = keyed.keys[level].col as usize;
                let desc = keyed.keys[level].desc;
                let mut full: Vec<(String, u32)> = group
                    .par_iter()
                    .map(|&p| {
                        let cells = session.read_base_rows(rows[p as usize] as u64, 1).pop().unwrap_or_default();
                        (cells.get(col).map_or(String::new(), |v| v.to_ascii_lowercase()), p)
                    })
                    .collect();
                full.par_sort_unstable_by(|(ta, a), (tb, b)| {
                    let o = if desc { tb.cmp(ta) } else { ta.cmp(tb) };
                    o.then_with(|| keyed.cmp_from(*a, *b, level + 1))
                });
                for (slot, (_, p)) in group.iter_mut().zip(&full) {
                    *slot = *p;
                }
                let mut s = 0;
                while s < full.len() {
                    let mut e = s + 1;
                    while e < full.len() && full[e].0 == full[s].0 {
                        e += 1;
                    }
                    refine(session, rows, keyed, &mut group[s..e], level + 1, task)?;
                    s = e;
                }
            } else {
                refine(session, rows, keyed, group, level + 1, task)?;
            }
        }
        i = j;
    }
    Ok(())
}
