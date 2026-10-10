//! JSON and JSON Lines as tables.
//!
//! Three shapes become rows:
//! - an array of records, at the root or as the biggest array inside the root object (`$.data`)
//! - JSON Lines: one value per line
//! - any other object: one row per top-level key
//!
//! A structural scan finds where each record starts; records are parsed only
//! when shown. Saving copies untouched records byte for byte, and edited
//! records keep their other fields verbatim through `RawValue`.

mod tree;

pub use tree::{JsonChildren, JsonNode, TreeEdit};

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use indexmap::IndexMap;
use memchr::{memchr2, memchr_iter};
use memmap2::Mmap;
use parking_lot::Mutex;
use serde_json::value::RawValue;

use crate::core::edits::{ColDef, EditLayer, Patch, Region, RowRef, Seg, NEW_COL};
use crate::core::export::{Cell, ExportFormat};
use crate::core::index::RowIndex;
use crate::core::source::{DataSource, Progress};

use super::{text, OpenOptions};

const MAX_ROWS_PER_READ: u64 = 10_000;
/// How far into the file shape detection looks before deciding.
const DETECT_CAP: usize = 64 << 20;
const SAMPLE_ROWS: usize = 1000;
/// Nested values bigger than this are summarised instead of rendered.
const MAX_NESTED_DISPLAY: usize = 1 << 20;
const COPY_CHUNK: usize = 8 << 20;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// Elements of an array; the body sits between `[` and `]`.
    Records,
    /// Members of the root object, shown as key/value rows.
    Members,
    /// One value per line.
    Lines,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Objects,
    Arrays,
    Scalars,
}

pub struct JsonSource {
    map: Option<Mmap>,
    encoding: &'static encoding_rs::Encoding,
    /// UTF-8 copy of a UTF-16 file, deleted on close.
    cache: Option<std::path::PathBuf>,
    mode: Mode,
    kind: Kind,
    columns: Vec<String>,
    label: String,
    body_start: u64,
    /// Closing bracket of the body (or file end for lines); known once indexed.
    body_end: AtomicU64,
    index: RowIndex,
    /// Column name → position, to tell sampled keys from keys the sample missed.
    column_index: HashMap<String, usize>,
    /// Child start offsets of containers expanded in the JSON view, by container offset.
    child_cache: Mutex<HashMap<u64, Arc<Vec<u64>>>>,
    /// Position of the rows array among the root's members (`$.data` files), from the file's head.
    rows_member: std::sync::OnceLock<u64>,
}

impl JsonSource {
    pub fn open(path: &Path, opts: &OpenOptions) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("Can't open file: {e}"))?;
        let probe = super::csv::map_file(&file)?;
        let encoding = match &opts.encoding {
            Some(name) => text::by_name(name)?,
            None => match encoding_rs::Encoding::for_bom(probe.as_deref().unwrap_or(&[])) {
                Some((enc, _)) => enc,
                None => encoding_rs::UTF_8,
            },
        };
        // JSON is UTF-8 or UTF-16; UTF-16 is read through a UTF-8 copy.
        let (map, cache) = if text::is_utf16(encoding) {
            drop(probe);
            let cache = text::utf16_to_cache(path, encoding)?;
            let file = File::open(&cache).map_err(|e| e.to_string())?;
            (super::csv::map_file(&file)?, Some(cache))
        } else if encoding == encoding_rs::UTF_8 {
            (probe, None)
        } else {
            return Err("JSON files must be UTF-8 or UTF-16".into());
        };
        let data: &[u8] = map.as_deref().unwrap_or(&[]);
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        let (mode, body_start, label) = detect(data, &ext)?;

        let mut source = Self {
            map: None,
            encoding,
            cache,
            mode,
            kind: Kind::Objects,
            columns: Vec::new(),
            label,
            body_start: body_start as u64,
            body_end: AtomicU64::new(data.len() as u64),
            index: RowIndex::new(body_start as u64),
            child_cache: Mutex::new(HashMap::new()),
            rows_member: std::sync::OnceLock::new(),
            column_index: HashMap::new(),
        };
        let (kind, columns) = source.sample_columns(data);
        source.kind = kind;
        source.column_index = columns.iter().enumerate().map(|(i, c)| (c.clone(), i)).collect();
        source.columns = columns;
        source.map = map;
        Ok(source)
    }

    fn data(&self) -> &[u8] {
        self.map.as_deref().unwrap_or(&[])
    }

    /// Picks the row kind and columns from the first records.
    fn sample_columns(&self, data: &[u8]) -> (Kind, Vec<String>) {
        if self.mode == Mode::Members {
            return (Kind::Objects, vec!["key".into(), "value".into()]);
        }
        let cap = &data[..data.len().min(self.body_start as usize + DETECT_CAP)];
        let mut starts = vec![self.body_start as usize];
        match self.mode {
            Mode::Lines => {
                for p in memchr_iter(b'\n', &cap[self.body_start as usize..]).take(SAMPLE_ROWS) {
                    starts.push(self.body_start as usize + p + 1);
                }
                if starts.len() <= SAMPLE_ROWS {
                    starts.push(cap.len());
                }
            }
            _ => {
                let end = scan_container(cap, self.body_start as usize, |p| {
                    starts.push(p + 1);
                    starts.len() <= SAMPLE_ROWS
                });
                if let Ok(close) = end {
                    starts.push(close);
                }
            }
        }

        let mut counts = [0usize; 3];
        let mut keys: IndexMap<String, ()> = IndexMap::new();
        let mut width = 0;
        for w in starts.windows(2) {
            let elem = trim_elem(&cap[w[0]..w[1]]);
            match elem.first() {
                Some(b'{') => {
                    counts[0] += 1;
                    if let Ok(obj) = serde_json::from_slice::<IndexMap<String, &RawValue>>(elem) {
                        for k in obj.into_keys() {
                            keys.entry(k).or_default();
                        }
                    }
                }
                Some(b'[') => {
                    counts[1] += 1;
                    if let Ok(arr) = serde_json::from_slice::<Vec<&RawValue>>(elem) {
                        width = width.max(arr.len());
                    }
                }
                Some(_) => counts[2] += 1,
                None => {}
            }
        }
        let kind = match counts.iter().enumerate().max_by_key(|(_, n)| **n) {
            Some((1, n)) if *n > 0 => Kind::Arrays,
            Some((2, n)) if *n > 0 => Kind::Scalars,
            _ => Kind::Objects,
        };
        let columns = match kind {
            Kind::Objects if !keys.is_empty() => keys.into_keys().collect(),
            Kind::Objects | Kind::Scalars => vec!["value".into()],
            Kind::Arrays => (0..width.max(1)).map(|i| format!("[{i}]")).collect(),
        };
        (kind, columns)
    }

    /// Trimmed byte range of the record between two row offsets.
    fn content(&self, from: u64, to: u64) -> (usize, usize) {
        let data = self.data();
        let (mut s, mut e) = (from as usize, to as usize);
        while s < e && data[s].is_ascii_whitespace() {
            s += 1;
        }
        while e > s && data[e - 1].is_ascii_whitespace() {
            e -= 1;
        }
        if self.mode != Mode::Lines && e > s && data[e - 1] == b',' {
            e -= 1;
            while e > s && data[e - 1].is_ascii_whitespace() {
                e -= 1;
            }
        }
        (s, e)
    }

    fn record(&self, row: u64) -> Option<&[u8]> {
        let b = self.index.row_bounds(row, 1);
        let (s, e) = self.content(*b.first()?, *b.get(1)?);
        Some(&self.data()[s..e])
    }

    fn cells(&self, rec: &[u8]) -> Vec<String> {
        self.cells_as(rec)
    }

    /// A record's cells, as display text or as typed export cells.
    fn cells_as<T: CellOut>(&self, rec: &[u8]) -> Vec<T> {
        if rec.is_empty() {
            return Vec::new();
        }
        match (self.mode, self.kind) {
            (Mode::Members, _) => {
                let wrapped = [b"{", rec, b"}"].concat();
                match serde_json::from_slice::<IndexMap<String, &RawValue>>(&wrapped) {
                    Ok(obj) => obj
                        .into_iter()
                        .next()
                        .map(|(k, v)| vec![T::text(k), T::value(v.get())])
                        .unwrap_or_default(),
                    Err(_) => vec![T::text(String::new()), T::text(lossy(rec))],
                }
            }
            (_, Kind::Objects) => match serde_json::from_slice::<IndexMap<String, &RawValue>>(rec) {
                Ok(obj) => self
                    .columns
                    .iter()
                    .map(|c| obj.get(c).map_or_else(T::missing, |v| T::value(v.get())))
                    .collect(),
                // Not an object (or invalid): show it whole in the first column.
                Err(_) => vec![T::invalid(rec)],
            },
            (_, Kind::Arrays) => match serde_json::from_slice::<Vec<&RawValue>>(rec) {
                Ok(arr) => arr.iter().map(|v| T::value(v.get())).collect(),
                Err(_) => vec![T::invalid(rec)],
            },
            (_, Kind::Scalars) => vec![T::invalid(rec)],
        }
    }

    /// Re-encodes a record with cell patches (keyed by column key) and the
    /// column plan applied. Untouched fields keep their exact original text.
    fn patched(&self, rec: Option<&[u8]>, patch: &Patch, defs: Option<&[ColDef]>) -> Result<String, String> {
        let rec = rec.filter(|r| !r.is_empty());
        let text = rec.map(lossy);
        match (self.mode, self.kind) {
            (Mode::Members, _) => {
                let (mut key, mut value) = (String::new(), None::<String>);
                if let Some(t) = &text {
                    let obj: IndexMap<String, Box<RawValue>> =
                        serde_json::from_str(&format!("{{{t}}}")).map_err(|e| e.to_string())?;
                    if let Some((k, v)) = obj.into_iter().next() {
                        key = k;
                        value = Some(v.get().to_string());
                    }
                }
                if let Some(k) = patch.get(&0) {
                    key = k.clone();
                }
                if let Some(v) = patch.get(&1) {
                    value = encode_value(value.as_deref(), v)?;
                }
                let key = serde_json::to_string(&key).map_err(|e| e.to_string())?;
                // Follow the file's style: `"k": v` or compact `"k":v`.
                let colon = if text.as_deref().is_some_and(|t| !t.contains("\": ")) { ":" } else { ": " };
                Ok(format!("{key}{colon}{}", value.unwrap_or_else(|| "null".into())))
            }
            (_, Kind::Objects) => {
                let orig: IndexMap<String, Box<RawValue>> = match &text {
                    Some(t) => serde_json::from_str(t).map_err(|_| NOT_OBJECT.to_string())?,
                    None => IndexMap::new(),
                };
                let Some(defs) = defs else {
                    let mut obj = orig;
                    // Keys with NEW_COL belong to added columns that were removed again.
                    for (&key, v) in patch.range(..NEW_COL) {
                        let name = self.columns.get(key as usize).ok_or("Column out of range")?;
                        let old = obj.get(name).map(|r| r.get().to_string());
                        if let Some(raw) = encode_value(old.as_deref(), v)? {
                            obj.insert(name.clone(), raw_value(raw)?);
                        }
                    }
                    return self.encode(&obj, text.as_deref());
                };
                // Rebuild in view column order: renamed, moved and added keys;
                // removed columns drop their keys.
                let mut obj = IndexMap::with_capacity(defs.len());
                for d in defs {
                    let old = (d.key & NEW_COL == 0)
                        .then(|| self.columns.get(d.key as usize))
                        .flatten()
                        .and_then(|name| orig.get(name));
                    let value = match patch.get(&d.key) {
                        Some(text) => encode_value(old.map(|r| r.get()), text)?.map(raw_value).transpose()?,
                        None => old.cloned(),
                    };
                    if let Some(v) = value {
                        obj.insert(d.name.clone(), v);
                    }
                }
                // Keys the column sample never saw stay as they were.
                for (k, v) in orig {
                    if !self.column_index.contains_key(&k) && !obj.contains_key(&k) {
                        obj.insert(k, v);
                    }
                }
                self.encode(&obj, text.as_deref())
            }
            (_, Kind::Arrays) => {
                let mut arr: Vec<Box<RawValue>> = match &text {
                    Some(t) => serde_json::from_str(t).map_err(|_| "This row isn't an array".to_string())?,
                    None => Vec::new(),
                };
                for (&col, v) in patch {
                    let col = col as usize;
                    while arr.len() <= col {
                        arr.push(raw_value("null".into())?);
                    }
                    let old = arr[col].get().to_string();
                    arr[col] = raw_value(encode_value(Some(&old), v)?.unwrap_or_else(|| "null".into()))?;
                }
                self.encode(&arr, text.as_deref())
            }
            (_, Kind::Scalars) => {
                let v = patch.get(&0).map(String::as_str).unwrap_or("");
                Ok(encode_value(text.as_deref(), v)?.unwrap_or_else(|| "null".into()))
            }
        }
    }

    /// Compact for single-line records, pretty when the original spanned lines.
    fn encode<T: serde::Serialize>(&self, value: &T, original: Option<&str>) -> Result<String, String> {
        let pretty = self.mode != Mode::Lines && original.is_some_and(|o| o.contains('\n'));
        if !pretty {
            return serde_json::to_string(value).map_err(|e| e.to_string());
        }
        let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        // Match the indentation records have in the file.
        let (_, leading, _) = self.layout();
        let indent = leading.rsplit(|&b| b == b'\n').next().unwrap_or(&[]);
        Ok(text.replace('\n', &format!("\n{}", String::from_utf8_lossy(indent))))
    }

    /// Separator, leading and trailing whitespace taken from the original layout.
    fn layout(&self) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let data = self.data();
        let rows = self.index.row_count();
        let body_end = self.body_end.load(Ordering::Acquire) as usize;
        let default_sep: &[u8] = if self.mode == Mode::Lines { b"\n" } else { b"," };
        if rows == 0 {
            let trailing = if self.mode == Mode::Lines { b"\n".to_vec() } else { Vec::new() };
            return (default_sep.to_vec(), Vec::new(), trailing);
        }
        let first = self.index.row_bounds(0, 2);
        let (s0, e0) = self.content(first[0], first[1]);
        let sep = if rows >= 2 {
            let (s1, _) = self.content(first[1], first[2]);
            data[e0..s1].to_vec()
        } else {
            default_sep.to_vec()
        };
        let last = self.index.row_bounds(rows - 1, 1);
        let (_, el) = self.content(last[0], last[1]);
        (sep, data[self.body_start as usize..s0].to_vec(), data[el..body_end].to_vec())
    }
}

impl Drop for JsonSource {
    fn drop(&mut self) {
        if let Some(cache) = &self.cache {
            self.map = None;
            let _ = std::fs::remove_file(cache);
        }
    }
}

const NOT_OBJECT: &str = "This record isn't a JSON object, so its columns can't be edited";

impl DataSource for JsonSource {
    fn format(&self) -> &'static str {
        "json"
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn columns(&self) -> Vec<String> {
        self.columns.clone()
    }

    fn file_size(&self) -> u64 {
        self.data().len() as u64
    }

    fn detail(&self) -> Option<String> {
        Some(self.label.clone())
    }

    fn options(&self) -> OpenOptions {
        OpenOptions { encoding: Some(self.encoding.name().to_string()), ..Default::default() }
    }

    fn check_edit(&self, row: RowRef, raw: Option<&str>, key: u32, value: &str) -> Result<(), String> {
        if key & NEW_COL != 0 {
            // An added column has no earlier value to keep the type of.
            return Ok(());
        }
        let rec = match (raw, row) {
            (Some(text), _) => Some(text.as_bytes()),
            (None, RowRef::Src(r)) => self.record(r),
            (None, RowRef::New(_)) => None,
        };
        self.patched(rec, &BTreeMap::from([(key, value.to_string())]), None).map(|_| ())
    }

    fn render_raw(&self, text: &str) -> Vec<String> {
        self.cells(text.as_bytes())
    }

    fn native_format(&self) -> ExportFormat {
        if self.mode == Mode::Lines { ExportFormat::JsonLines } else { ExportFormat::Json }
    }

    fn read_cells(&self, start: u64, count: u64) -> Vec<Vec<Cell>> {
        let bounds = self.index.row_bounds(start, count.min(MAX_ROWS_PER_READ));
        bounds
            .windows(2)
            .map(|w| {
                let (s, e) = self.content(w[0], w[1]);
                self.cells_as(&self.data()[s..e])
            })
            .collect()
    }

    fn raw_cells(&self, text: &str) -> Vec<Cell> {
        self.cells_as(text.as_bytes())
    }

    /// Keeps the replaced value's type where it can, like saving does (`encode_value`).
    fn patch_cell(&self, old: &Cell, text: &str) -> Cell {
        let trimmed = text.trim();
        match old {
            Cell::Str(_) => Cell::Str(text.to_string()),
            Cell::Json(_) | Cell::Empty | Cell::Num(_) | Cell::Bool(_)
                if matches!(trimmed.as_bytes().first(), Some(b'{' | b'['))
                    && serde_json::from_str::<serde::de::IgnoredAny>(trimmed).is_ok() =>
            {
                Cell::Json(compact(trimmed))
            }
            Cell::Json(_) => Cell::Str(text.to_string()),
            _ if trimmed.is_empty() => Cell::Empty,
            _ => match serde_json::from_str::<serde_json::Value>(trimmed) {
                Ok(v) if v.is_number() || v.is_boolean() || v.is_null() => Cell::value(trimmed),
                _ => Cell::Str(text.to_string()),
            },
        }
    }

    fn maps_file(&self) -> bool {
        self.cache.is_none() && self.map.is_some()
    }

    fn supports_column_edits(&self) -> bool {
        self.mode != Mode::Members && self.kind == Kind::Objects
    }

    fn row_count(&self) -> u64 {
        self.index.row_count()
    }

    fn progress(&self) -> Progress {
        Progress {
            rows: self.index.row_count(),
            work_done: self.index.work_done(),
            work_total: self.file_size(),
            done: self.index.is_done(),
        }
    }

    fn build_index(&self, on_progress: &dyn Fn(Progress)) {
        let data = self.data();
        let from = self.body_start as usize;
        let mut writer = self.index.writer();
        let end = match self.mode {
            Mode::Lines => {
                for p in memchr_iter(b'\n', &data[from..]) {
                    if writer.push((from + p + 1) as u64) {
                        if self.index.is_cancelled() {
                            return;
                        }
                        on_progress(self.progress());
                    }
                }
                data.len()
            }
            Mode::Records | Mode::Members => {
                let mut cancelled = false;
                let result = scan_container(data, from, |p| {
                    if writer.push(p as u64 + 1) {
                        if self.index.is_cancelled() {
                            cancelled = true;
                            return false;
                        }
                        on_progress(self.progress());
                    }
                    true
                });
                if cancelled {
                    return;
                }
                // An unterminated body still shows what was found.
                result.unwrap_or_else(|e| e)
            }
        };
        self.body_end.store(end as u64, Ordering::Release);
        // `[ ]` has no elements, and a trailing newline in JSON Lines isn't a row.
        let tail = &data[(writer.last_start() as usize).min(end)..end];
        writer.finish(end as u64, tail.iter().any(|b| !b.is_ascii_whitespace()));
        on_progress(self.progress());
    }

    fn candidate_rows(&self, re: &regex::bytes::Regex, cancel: &AtomicBool, scanned: &AtomicU64) -> Vec<u64> {
        let data = self.data();
        crate::core::search::scan_rows(
            &self.index,
            &|from, to| Some(std::borrow::Cow::Borrowed(&data[from as usize..to as usize])),
            re,
            cancel,
            scanned,
        )
    }

    fn cancel(&self) {
        self.index.cancel();
    }

    fn read_rows(&self, start: u64, count: u64) -> Vec<Vec<String>> {
        let bounds = self.index.row_bounds(start, count.min(MAX_ROWS_PER_READ));
        bounds
            .windows(2)
            .map(|w| {
                let (s, e) = self.content(w[0], w[1]);
                self.cells(&self.data()[s..e])
            })
            .collect()
    }

    fn save(&self, edits: &EditLayer, dest: &Path, on_progress: &dyn Fn(u64, u64) -> Result<(), String>) -> Result<(), String> {
        let data = self.data();
        let file = File::create(dest).map_err(|e| format!("Can't create file: {e}"))?;
        let mut out = BufWriter::with_capacity(1 << 20, file);
        let mut w = |b: &[u8]| out.write_all(b).map_err(|e| e.to_string());
        let (sep, leading, trailing) = self.layout();
        let body_end = self.body_end.load(Ordering::Acquire) as usize;
        let total = edits.row_count(0);
        let defs = edits.column_defs();
        let empty = Patch::new();
        // A record as it should be written: replaced text, patches and the column plan applied.
        let render = |row: RowRef, original: Option<&[u8]>| -> Result<Option<String>, String> {
            let raw = edits.raw_for(row);
            let patch = edits.cells_for(row);
            if patch.is_none() && defs.is_none() {
                return Ok(raw.map(str::to_string));
            }
            let rec = raw.map(str::as_bytes).or(original);
            self.patched(rec, patch.unwrap_or(&empty), defs).map(Some)
        };

        match edits.region(Region::Head) {
            Some(head) => w(head.as_bytes())?,
            None => w(&data[..self.body_start as usize])?,
        }
        if total > 0 {
            w(&leading)?;
        }
        let mut first = true;
        let mut written = 0;
        for seg in edits.segments() {
            match *seg {
                Seg::Src { start, len } if edits.rows_untouched() => {
                    // Untouched run: copy it whole, original separators included.
                    let b = self.index.row_bounds(start, len);
                    let (s, _) = self.content(b[0], b[1]);
                    let (_, e) = self.content(b[b.len() - 2], b[b.len() - 1]);
                    if !first {
                        w(&sep)?;
                    }
                    let mut copied = 0u64;
                    for chunk in data[s..e].chunks(COPY_CHUNK) {
                        w(chunk)?;
                        copied += chunk.len() as u64;
                        on_progress(written + len * copied / (e - s) as u64, total)?;
                    }
                    first = false;
                }
                Seg::Src { start, len } => {
                    let b = self.index.row_bounds(start, len);
                    for (i, pair) in b.windows(2).enumerate() {
                        let (s, e) = self.content(pair[0], pair[1]);
                        if !first {
                            w(&sep)?;
                        }
                        match render(RowRef::Src(start + i as u64), Some(&data[s..e]))? {
                            Some(text) => w(text.as_bytes())?,
                            None => w(&data[s..e])?,
                        }
                        first = false;
                        if i % 65536 == 65535 {
                            on_progress(written + i as u64, total)?;
                        }
                    }
                }
                // Saving waits for indexing, which turns the tail into a plain run.
                Seg::SrcTail { .. } => return Err("Still loading the file; saving unlocks when it finishes".into()),
                Seg::New { start, len } => {
                    for r in start..start + len {
                        if !first {
                            w(&sep)?;
                        }
                        let row = RowRef::New(r);
                        let text = match render(row, None)? {
                            Some(text) => text,
                            None => self.patched(None, &empty, defs)?,
                        };
                        w(text.as_bytes())?;
                        first = false;
                    }
                }
            }
            written += seg.len(0);
            on_progress(written, total)?;
        }
        if total > 0 {
            w(&trailing)?;
        }
        match edits.region(Region::Tail) {
            Some(tail) => w(tail.as_bytes())?,
            None => w(&data[body_end..])?,
        }
        let file = out.into_inner().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        if text::is_utf16(self.encoding) {
            text::utf8_file_to_utf16(dest, self.encoding)?;
        }
        Ok(())
    }
}

/// Finds which part of the file holds the rows.
fn detect(data: &[u8], ext: &str) -> Result<(Mode, usize, String), String> {
    let mut i = if data.starts_with(b"\xEF\xBB\xBF") { 3 } else { 0 };
    skip_ws(data, &mut i);
    if matches!(ext, "jsonl" | "ndjson") || i >= data.len() {
        return Ok((Mode::Lines, i, "JSON Lines".into()));
    }
    match data[i] {
        b'[' => Ok((Mode::Records, i + 1, "$".into())),
        b'{' => {
            let cap = &data[..data.len().min(i + DETECT_CAP)];
            // Several values in a row means JSON Lines saved as .json.
            if let Some(end) = skip_value(cap, i) {
                let mut j = end;
                skip_ws(cap, &mut j);
                if j < cap.len() && matches!(cap[j], b'{' | b'[') {
                    return Ok((Mode::Lines, i, "JSON Lines".into()));
                }
            }
            find_records(cap, i)
        }
        _ => Err("This JSON file holds a single value, so there are no rows to show".into()),
    }
}

/// Looks through the root object's members for the array that holds the data.
fn find_records(cap: &[u8], root: usize) -> Result<(Mode, usize, String), String> {
    let members = || Ok((Mode::Members, root + 1, "$ (keys)".into()));
    let mut best: Option<(usize, usize, String)> = None; // (size, body start, key)
    let mut j = root + 1;
    loop {
        skip_ws(cap, &mut j);
        if j >= cap.len() {
            break;
        }
        if cap[j] == b'}' {
            // The whole root fits in the window: use the biggest array if it dominates.
            return match best {
                Some((size, start, key)) if size * 2 > j - root => Ok((Mode::Records, start, path(&key))),
                _ => members(),
            };
        }
        if cap[j] != b'"' {
            return Err(format!("Invalid JSON near byte {j}"));
        }
        let Some(key_end) = skip_string(cap, j) else { break };
        let key: String = serde_json::from_slice(&cap[j..key_end]).map_err(|e| e.to_string())?;
        j = key_end;
        skip_ws(cap, &mut j);
        if cap.get(j) != Some(&b':') {
            break;
        }
        j += 1;
        skip_ws(cap, &mut j);
        if j >= cap.len() {
            break;
        }
        if cap[j] == b'[' {
            match scan_container(cap, j + 1, |_| true) {
                Ok(close) => {
                    if best.as_ref().is_none_or(|b| close - j > b.0) {
                        best = Some((close - j, j + 1, key));
                    }
                    j = close + 1;
                }
                // Still open past the window: this is the big one.
                Err(_) => return Ok((Mode::Records, j + 1, path(&key))),
            }
        } else {
            match skip_value(cap, j) {
                Some(end) => j = end,
                None => break,
            }
        }
        skip_ws(cap, &mut j);
        if cap.get(j) == Some(&b',') {
            j += 1;
        }
    }
    members()
}

fn path(key: &str) -> String {
    if key.chars().all(|c| c.is_alphanumeric() || c == '_') && !key.is_empty() {
        format!("$.{key}")
    } else {
        format!("$[{}]", serde_json::to_string(key).unwrap_or_default())
    }
}

/// Bytes that matter to the structural scan outside strings.
static STRUCTURAL: [bool; 256] = {
    let mut t = [false; 256];
    t[b'"' as usize] = true;
    t[b'{' as usize] = true;
    t[b'}' as usize] = true;
    t[b'[' as usize] = true;
    t[b']' as usize] = true;
    t[b',' as usize] = true;
    t
};

/// Walks a container body from `from` (just past its opening bracket),
/// calling `on_sep` for each top-level comma until it returns false.
/// Returns the closing bracket's offset, or `Err(stop)` when the data ran out
/// or the callback stopped the scan.
pub(super) fn scan_container(data: &[u8], from: usize, mut on_sep: impl FnMut(usize) -> bool) -> Result<usize, usize> {
    let mut depth = 0usize;
    let mut i = from;
    while i < data.len() {
        let b = data[i];
        if !STRUCTURAL[b as usize] {
            i += 1;
            continue;
        }
        match b {
            b'"' => {
                i = skip_string(data, i).ok_or(data.len())?;
                continue;
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                if depth == 0 {
                    return Ok(i);
                }
                depth -= 1;
            }
            b',' if depth == 0 => {
                if !on_sep(i) {
                    return Err(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    Err(data.len())
}

/// Offset just past the string starting at `at` (which must be a quote).
pub(super) fn skip_string(data: &[u8], at: usize) -> Option<usize> {
    let mut i = at + 1;
    loop {
        let k = memchr2(b'"', b'\\', &data[i.min(data.len())..])?;
        let j = i + k;
        if data[j] == b'\\' {
            i = j + 2;
        } else {
            return Some(j + 1);
        }
    }
}

/// Offset just past the value starting at `at`, if it ends within `data`.
pub(super) fn skip_value(data: &[u8], at: usize) -> Option<usize> {
    match data[at] {
        b'"' => skip_string(data, at),
        b'{' | b'[' => scan_container(data, at + 1, |_| true).ok().map(|c| c + 1),
        _ => {
            let n = data[at..]
                .iter()
                .position(|b| matches!(b, b',' | b'}' | b']') || b.is_ascii_whitespace())
                .unwrap_or(data.len() - at);
            Some(at + n)
        }
    }
}

fn skip_ws(data: &[u8], i: &mut usize) {
    while *i < data.len() && data[*i].is_ascii_whitespace() {
        *i += 1;
    }
}

fn trim_elem(b: &[u8]) -> &[u8] {
    let s = b.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(b.len());
    let mut e = b.len();
    while e > s && (b[e - 1].is_ascii_whitespace() || b[e - 1] == b',') {
        e -= 1;
    }
    &b[s..e]
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn raw_value(text: String) -> Result<Box<RawValue>, String> {
    RawValue::from_string(text).map_err(|e| e.to_string())
}

/// What a record's values become: display text, or typed export cells.
trait CellOut: Sized {
    /// A JSON value's raw text.
    fn value(raw: &str) -> Self;
    /// Plain text (e.g. a member's key).
    fn text(s: String) -> Self;
    fn missing() -> Self;
    /// A record that isn't valid JSON of the expected kind.
    fn invalid(rec: &[u8]) -> Self;
}

impl CellOut for String {
    fn value(raw: &str) -> Self {
        display(raw)
    }
    fn text(s: String) -> Self {
        s
    }
    fn missing() -> Self {
        String::new()
    }
    fn invalid(rec: &[u8]) -> Self {
        display(&lossy(rec))
    }
}

impl CellOut for Cell {
    fn value(raw: &str) -> Self {
        match raw.as_bytes().first() {
            Some(b'"') => Cell::Str(serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_string())),
            Some(b'{' | b'[') => Cell::Json(compact(raw)),
            Some(b't') if raw == "true" => Cell::Bool(true),
            Some(b'f') if raw == "false" => Cell::Bool(false),
            Some(b'n') if raw == "null" => Cell::Empty,
            Some(_) => Cell::Num(raw.to_string()),
            None => Cell::Empty,
        }
    }
    fn text(s: String) -> Self {
        Cell::Str(s)
    }
    fn missing() -> Self {
        Cell::Empty
    }
    fn invalid(rec: &[u8]) -> Self {
        let text = lossy(rec);
        // A bare scalar (`Kind::Scalars` rows, or a stray value) still has a type.
        match serde_json::from_str::<&RawValue>(text.trim()) {
            Ok(v) => Cell::value(v.get()),
            Err(_) => Cell::text(text),
        }
    }
}

/// Cell text for a JSON value: strings unquoted, nested values compacted.
fn display(raw: &str) -> String {
    match raw.as_bytes().first() {
        Some(b'"') => serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_string()),
        Some(b'{' | b'[') if raw.len() > MAX_NESTED_DISPLAY => {
            format!("{}… ({} KB)", &raw[..1], raw.len() >> 10)
        }
        Some(b'{' | b'[') => compact(raw),
        _ => raw.to_string(),
    }
}

/// Removes whitespace outside strings without re-parsing numbers.
fn compact(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let (mut in_str, mut escaped) = (false, false);
    for c in raw.chars() {
        if in_str {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
        } else if !c.is_whitespace() {
            if c == '"' {
                in_str = true;
            }
            out.push(c);
        }
    }
    out
}

/// JSON text for an edited cell, keeping the original value's type where it can.
/// Returns `None` to leave a missing field missing.
fn encode_value(original: Option<&str>, text: &str) -> Result<Option<String>, String> {
    let quoted = || serde_json::to_string(text).map_err(|e| e.to_string());
    let trimmed = text.trim();
    let literal = || {
        serde_json::from_str::<serde_json::Value>(trimmed)
            .ok()
            .filter(|v| v.is_number() || v.is_boolean() || v.is_null())
            .map(|_| trimmed.to_string())
    };
    Ok(Some(match original.and_then(|o| o.as_bytes().first().copied()) {
        Some(b'"') => quoted()?,
        Some(b'{' | b'[') => {
            serde_json::from_str::<serde::de::IgnoredAny>(trimmed)
                .map_err(|e| format!("This cell holds nested JSON, and the new value isn't valid JSON: {e}"))?;
            trimmed.to_string()
        }
        Some(_) if trimmed.is_empty() => "null".into(),
        Some(_) => literal().map_or_else(quoted, Ok)?,
        None if text.is_empty() => return Ok(None),
        None => match literal() {
            Some(l) => l,
            None if matches!(trimmed.as_bytes().first(), Some(b'{' | b'['))
                && serde_json::from_str::<serde::de::IgnoredAny>(trimmed).is_ok() =>
            {
                trimmed.to_string()
            }
            None => quoted()?,
        },
    }))
}
