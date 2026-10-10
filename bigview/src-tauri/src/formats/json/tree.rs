//! Lazy, editable JSON tree for the JSON view.
//!
//! Nodes are addressed by path: the position of each child in its container.
//! Paths resolve against the edited document, so the tree shows unsaved
//! edits from both views:
//! - the rows container's children are the edit layer's rows;
//! - a record's text is its replacement, its patched form, or its bytes in the file;
//! - the text before and after the rows (the "head" and "tail", e.g. `"meta"`
//!   around `$.data`) is edited as one small document in which the rows array
//!   reads as `[]`.
//!
//! Edits splice the JSON text, so untouched formatting stays as it was. Edits
//! inside a record replace the record's text; edits around the rows replace
//! the head and tail. Both go through the shared undo stack.

use std::borrow::Cow;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::{compact, scan_container, skip_string, JsonSource, Mode};
use crate::core::edits::{EditLayer, Patch, Region, RowRef};

/// Scalar text longer than this is cut for display.
const MAX_TEXT: usize = 400;
/// Containers up to this size get their child count up front.
const COUNT_LIMIT: usize = 256 << 10;
const MAX_CACHED_CONTAINERS: usize = 256;
/// Biggest value the copy command returns.
const MAX_RAW: usize = 64 << 20;
/// Biggest record, or text around the rows, the JSON view edits.
const MAX_EDIT: usize = 16 << 20;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonNode {
    key: Option<String>,
    /// object, array, string, number, boolean, null, lines (JSON Lines root) or blank.
    kind: &'static str,
    /// Raw token for scalars, cut to `MAX_TEXT`.
    text: String,
    /// Children of a container, when known cheaply.
    count: Option<u64>,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonChildren {
    total: u64,
    /// False while the row index is still growing.
    complete: bool,
    children: Vec<JsonNode>,
}

/// A change made in the JSON view. Values are JSON text; text that isn't
/// valid JSON is stored as a string.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum TreeEdit {
    Set { path: Vec<u64>, text: String },
    Rename { path: Vec<u64>, key: String },
    Delete { path: Vec<u64> },
    /// Adds a child at `index` of the container at `parent` (`key` for objects).
    Insert { parent: Vec<u64>, index: u64, key: Option<String>, text: String },
}

/// A JSON value: its span in some text. `file` marks the file's own bytes,
/// whose container scans are cached by offset.
struct Val<'a> {
    buf: Cow<'a, [u8]>,
    s: usize,
    e: usize,
    file: bool,
    key: Option<String>,
}

/// Where a path points.
enum Place<'p> {
    /// The container whose children are the rows.
    Rows,
    /// The root object around the rows (`$.data` files).
    Root,
    /// A value inside view row `row`, at `inner` within its value.
    Row { row: u64, inner: &'p [u64] },
    /// A value in the root object outside the rows, at `path` from the root.
    Outer { path: &'p [u64] },
}

/// One child of a container: its content span, key span (objects) and value span.
struct Entry {
    s: usize,
    e: usize,
    key: Option<(usize, usize)>,
    vs: usize,
}

fn trim(buf: &[u8], mut s: usize, mut e: usize, comma: bool) -> (usize, usize) {
    while s < e && buf[s].is_ascii_whitespace() {
        s += 1;
    }
    while e > s && buf[e - 1].is_ascii_whitespace() {
        e -= 1;
    }
    if comma && e > s && buf[e - 1] == b',' {
        e -= 1;
        while e > s && buf[e - 1].is_ascii_whitespace() {
            e -= 1;
        }
    }
    (s, e)
}

/// Child boundaries of the container opening at `open`: each child's start,
/// then the closing bracket. Empty containers have no children.
fn scan_starts(buf: &[u8], open: usize) -> Result<Vec<u64>, String> {
    let mut starts = vec![open as u64 + 1];
    let close = scan_container(buf, open + 1, |p| {
        starts.push(p as u64 + 1);
        true
    })
    .map_err(|_| "This value isn't closed; the file may be truncated".to_string())?;
    let (s, e) = trim(buf, *starts.last().unwrap() as usize, close, false);
    if starts.len() == 1 && s == e {
        starts.clear();
    }
    starts.push(close as u64);
    Ok(starts)
}

fn entry(buf: &[u8], starts: &[u64], i: usize, object: bool) -> Entry {
    let (s, e) = trim(buf, starts[i] as usize, starts[i + 1] as usize, true);
    if !object || s >= e || buf[s] != b'"' {
        return Entry { s, e, key: None, vs: s };
    }
    let key_end = skip_string(&buf[..e], s).unwrap_or(e);
    let mut v = key_end;
    while v < e && (buf[v].is_ascii_whitespace() || buf[v] == b':') {
        v += 1;
    }
    Entry { s, e, key: Some((s, key_end)), vs: v }
}

fn key_text(buf: &[u8], (s, e): (usize, usize)) -> String {
    serde_json::from_slice::<String>(&buf[s..e]).unwrap_or_else(|_| String::from_utf8_lossy(&buf[s..e]).into_owned())
}

fn kind_of(b: Option<&u8>) -> &'static str {
    match b {
        Some(b'{') => "object",
        Some(b'[') => "array",
        Some(b'"') => "string",
        Some(b't' | b'f') => "boolean",
        Some(b'n') => "null",
        Some(_) => "number",
        None => "blank",
    }
}

fn count_children(buf: &[u8], open: usize, end: usize) -> Option<u64> {
    let mut seps = 0u64;
    let close = scan_container(&buf[..end], open + 1, |_| {
        seps += 1;
        true
    })
    .ok()?;
    let empty = buf[open + 1..close].iter().all(u8::is_ascii_whitespace);
    Some(if empty { 0 } else { seps + 1 })
}

fn node(buf: &[u8], v: usize, e: usize, key: Option<String>) -> JsonNode {
    let kind = if v < e { kind_of(buf.get(v)) } else { "blank" };
    let size = e.saturating_sub(v);
    let (text, count) = match kind {
        "object" | "array" => (String::new(), if size <= COUNT_LIMIT { count_children(buf, v, e) } else { None }),
        _ => {
            let mut cut = (v + MAX_TEXT).min(e);
            while cut < e && (buf[cut] & 0xC0) == 0x80 {
                cut += 1;
            }
            let mut text = String::from_utf8_lossy(&buf[v..cut]).into_owned();
            if cut < e {
                text.push('…');
            }
            (text, None)
        }
    };
    JsonNode { key, kind, text, count, size: size as u64 }
}

/// Text the user typed as a value: valid JSON as is, anything else as a string.
fn value_text(input: &str) -> Result<String, String> {
    let t = input.trim();
    if !t.is_empty() && serde_json::from_str::<serde::de::IgnoredAny>(t).is_ok() {
        return Ok(t.to_string());
    }
    serde_json::to_string(input).map_err(|e| e.to_string())
}

fn check_json(text: &str) -> Result<(), String> {
    serde_json::from_str::<serde::de::IgnoredAny>(text).map(|_| ()).map_err(|e| format!("That isn't valid JSON: {e}"))
}

/// A change to one container's children, applied to its text.
enum TextOp {
    Set(u64, String),
    Rename(u64, String),
    Delete(u64),
    Insert(u64, Option<String>, String),
}

/// Applies `op` to the container at `path` below the value starting at `root`
/// in `text`. Untouched text keeps its formatting.
fn apply_op(text: &str, root: usize, path: &[u64], op: TextOp) -> Result<String, String> {
    let b = text.as_bytes();
    let mut open = root;
    for &i in path {
        let object = b.get(open) == Some(&b'{');
        if !matches!(b.get(open), Some(b'{' | b'[')) {
            return Err("That value has no children".into());
        }
        let starts = scan_starts(b, open)?;
        if i as usize + 1 >= starts.len() {
            return Err("That item no longer exists".into());
        }
        open = entry(b, &starts, i as usize, object).vs;
    }
    let object = match b.get(open) {
        Some(b'{') => true,
        Some(b'[') => false,
        _ => return Err("That value has no children".into()),
    };
    let starts = scan_starts(b, open)?;
    let n = starts.len() - 1;
    let entries: Vec<Entry> = (0..n).map(|i| entry(b, &starts, i, object)).collect();
    let keys = || entries.iter().filter_map(|en| en.key.map(|k| key_text(b, k))).collect::<Vec<_>>();
    let quoted = |k: &str| serde_json::to_string(k).map_err(|e| e.to_string());
    let get = |i: u64| entries.get(i as usize).ok_or_else(|| "That item no longer exists".to_string());
    let splice = |from: usize, to: usize, with: &str| format!("{}{}{}", &text[..from], with, &text[to..]);
    Ok(match op {
        TextOp::Set(i, v) => {
            let en = get(i)?;
            splice(en.vs, en.e, &v)
        }
        TextOp::Rename(i, k) => {
            let en = get(i)?;
            let span = en.key.ok_or("Only object members have keys")?;
            if keys().iter().enumerate().any(|(j, x)| j != i as usize && *x == k) {
                return Err(format!("This object already has a key \"{k}\""));
            }
            splice(span.0, span.1, &quoted(&k)?)
        }
        TextOp::Delete(i) => {
            get(i)?;
            let i = i as usize;
            if n == 1 {
                splice(entries[0].s, entries[0].e, "")
            } else if i + 1 < n {
                splice(entries[i].s, entries[i + 1].s, "")
            } else {
                splice(entries[i - 1].e, entries[i].e, "")
            }
        }
        TextOp::Insert(i, key, v) => {
            let i = (i as usize).min(n);
            let item = if object {
                let k = key.ok_or("A new member needs a key")?;
                if keys().contains(&k) {
                    return Err(format!("This object already has a key \"{k}\""));
                }
                // Follow the object's style: `"k": v` or compact `"k":v`.
                let spaced = entries.first().is_none_or(|en| b.get(en.key.map_or(en.vs, |k| k.1) + 1) == Some(&b' '));
                format!("{}{}{}", quoted(&k)?, if spaced { ": " } else { ":" }, v)
            } else {
                v
            };
            if n == 0 {
                let close = starts[0] as usize;
                return Ok(splice(open + 1, close, &item));
            }
            let sep = if n >= 2 {
                text[entries[0].e..entries[1].s].to_string()
            } else {
                let lead = &text[open + 1..entries[0].s];
                if lead.contains('\n') { format!(",{lead}") } else { ", ".into() }
            };
            if i < n {
                splice(entries[i].s, entries[i].s, &format!("{item}{sep}"))
            } else {
                splice(entries[n - 1].e, entries[n - 1].e, &format!("{sep}{item}"))
            }
        }
    })
}

impl JsonSource {
    /// The rows sit inside a root object (`$.data`) rather than being the root.
    fn wrapped(&self) -> bool {
        self.mode == Mode::Records && self.data().get(self.root_start()) == Some(&b'{')
    }

    fn root_start(&self) -> usize {
        let data = self.data();
        let mut i = if data.starts_with(b"\xEF\xBB\xBF") { 3 } else { 0 };
        while i < data.len() && data[i].is_ascii_whitespace() {
            i += 1;
        }
        i
    }

    fn rows_total(&self, edits: &EditLayer) -> u64 {
        edits.row_count(self.index.row_count())
    }

    /// Head and tail as they are now (edited or from the file).
    fn head_tail(&self, edits: &EditLayer) -> Result<(String, String), String> {
        if !self.index.is_done() {
            return Err("Still loading the file; this unlocks when it finishes".into());
        }
        let data = self.data();
        let body_end = self.body_end.load(std::sync::atomic::Ordering::Acquire) as usize;
        let head = edits.region(Region::Head).map_or_else(|| super::lossy(&data[..self.body_start as usize]), str::to_string);
        let tail = edits.region(Region::Tail).map_or_else(|| super::lossy(&data[body_end..]), str::to_string);
        Ok((head, tail))
    }

    /// Position of the rows array among the root object's members.
    fn rows_member(&self, edits: &EditLayer) -> u64 {
        let count = |head: &[u8]| {
            let mut i = 0;
            while i < head.len() && head[i] != b'{' {
                i += 1;
            }
            let mut n = 0;
            let _ = scan_container(head, i + 1, |_| {
                n += 1;
                true
            });
            n
        };
        match edits.region(Region::Head) {
            Some(head) => count(head.as_bytes()),
            None => *self.rows_member.get_or_init(|| count(&self.data()[..self.body_start as usize])),
        }
    }

    fn place<'p>(&self, edits: &EditLayer, path: &'p [u64]) -> Place<'p> {
        if !self.wrapped() {
            return match path.split_first() {
                None => Place::Rows,
                Some((&row, inner)) => Place::Row { row, inner },
            };
        }
        let Some((&first, rest)) = path.split_first() else { return Place::Root };
        if first != self.rows_member(edits) {
            return Place::Outer { path };
        }
        match rest.split_first() {
            None => Place::Rows,
            Some((&row, inner)) => Place::Row { row, inner },
        }
    }

    /// The root object around the rows: the file's bytes, or head + tail once edited.
    fn outer(&self, edits: &EditLayer) -> Result<Val<'_>, String> {
        if edits.region(Region::Head).is_none() && edits.region(Region::Tail).is_none() {
            let s = self.root_start();
            let data = self.data();
            let (_, e) = trim(data, s, data.len(), false);
            return Ok(Val { buf: Cow::Borrowed(data), s, e, file: true, key: None });
        }
        let (head, tail) = self.head_tail(edits)?;
        let text = head + &tail;
        let (_, e) = trim(text.as_bytes(), 0, text.len(), false);
        let s = text.find('{').ok_or("The root isn't an object")?;
        Ok(Val { buf: Cow::Owned(text.into_bytes()), s, e, file: false, key: None })
    }

    /// A record's text as it is now; `None` when it is the file's bytes.
    fn edited_record(&self, edits: &EditLayer, row: RowRef) -> Result<Option<String>, String> {
        let raw = edits.raw_for(row);
        let patch = edits.cells_for(row);
        let defs = edits.column_defs();
        if patch.is_none() && defs.is_none() {
            return Ok(match (raw, row) {
                (Some(r), _) => Some(r.to_string()),
                (None, RowRef::Src(_)) => None,
                (None, RowRef::New(_)) => Some(self.patched(None, &Patch::new(), None)?),
            });
        }
        let original = match row {
            RowRef::Src(r) => self.record(r),
            RowRef::New(_) => None,
        };
        let rec = raw.map(str::as_bytes).or(original);
        self.patched(rec, patch.unwrap_or(&Patch::new()), defs).map(Some)
    }

    /// The value of view row `row` (for key/value files, the member's value).
    fn row_val(&self, edits: &EditLayer, row: u64) -> Result<(RowRef, Val<'_>), String> {
        if row >= self.rows_total(edits) {
            return Err("That row no longer exists".into());
        }
        let r = edits.resolve(row, 1, self.index.row_count())[0];
        let mut val = match (self.edited_record(edits, r)?, r) {
            (Some(text), _) => {
                let len = text.len();
                Val { buf: Cow::Owned(text.into_bytes()), s: 0, e: len, file: false, key: None }
            }
            (None, RowRef::Src(src)) => {
                let b = self.index.row_bounds(src, 1);
                let (s, e) = self.content(b[0], b[1]);
                Val { buf: Cow::Borrowed(self.data()), s, e, file: true, key: None }
            }
            (None, RowRef::New(_)) => unreachable!("new rows always have text"),
        };
        let (s, e) = trim(&val.buf, val.s, val.e, false);
        (val.s, val.e) = (s, e);
        if self.mode == Mode::Members && s < e {
            let en = entry(&val.buf, &[s as u64, e as u64], 0, true);
            val.key = en.key.map(|k| key_text(&val.buf, k));
            val.s = en.vs;
        }
        Ok((r, val))
    }

    /// Child boundaries of a container, cached for containers in the file.
    fn starts(&self, val: &Val, open: usize) -> Result<Arc<Vec<u64>>, String> {
        if !val.file {
            return scan_starts(&val.buf, open).map(Arc::new);
        }
        if let Some(hit) = self.child_cache.lock().get(&(open as u64)) {
            return Ok(hit.clone());
        }
        let starts = Arc::new(scan_starts(&val.buf, open)?);
        let mut cache = self.child_cache.lock();
        if cache.len() >= MAX_CACHED_CONTAINERS {
            cache.clear();
        }
        cache.insert(open as u64, starts.clone());
        Ok(starts)
    }

    /// Follows `path` down from `val`.
    fn descend<'a>(&self, mut val: Val<'a>, path: &[u64]) -> Result<Val<'a>, String> {
        for &i in path {
            let object = match val.buf.get(val.s) {
                Some(b'{') => true,
                Some(b'[') => false,
                _ => return Err("That value has no children".into()),
            };
            let starts = self.starts(&val, val.s)?;
            if i as usize + 1 >= starts.len() {
                return Err("That item no longer exists".into());
            }
            let en = entry(&val.buf, &starts, i as usize, object);
            val.key = en.key.map(|k| key_text(&val.buf, k));
            (val.s, val.e) = (en.vs, en.e);
        }
        Ok(val)
    }

    fn val_node(&self, val: &Val) -> JsonNode {
        node(&val.buf, val.s, val.e, val.key.clone())
    }

    /// The top-level value, or a virtual root whose children are the lines.
    pub fn tree_root(&self, edits: &EditLayer) -> Result<JsonNode, String> {
        let rows = Some(self.rows_total(edits));
        if self.mode == Mode::Lines {
            return Ok(JsonNode { key: None, kind: "lines", text: String::new(), count: rows, size: self.data().len() as u64 });
        }
        if self.wrapped() {
            let outer = self.outer(edits)?;
            let mut n = self.val_node(&outer);
            if outer.file {
                n.count = None;
            }
            return Ok(n);
        }
        let s = self.root_start();
        let data = self.data();
        Ok(JsonNode { key: None, kind: kind_of(data.get(s)), text: String::new(), count: rows, size: data.len() as u64 })
    }

    /// Children `start..start + count` of the container at `path`.
    pub fn tree_children(&self, edits: &EditLayer, path: &[u64], start: u64, count: u64) -> Result<JsonChildren, String> {
        match self.place(edits, path) {
            Place::Rows => {
                let total = self.rows_total(edits);
                let end = (start + count).min(total);
                let mut children = Vec::with_capacity(end.saturating_sub(start) as usize);
                for row in start..end {
                    let (_, val) = self.row_val(edits, row)?;
                    children.push(self.val_node(&val));
                }
                Ok(JsonChildren { total, complete: self.index.is_done(), children })
            }
            Place::Root => {
                let outer = self.outer(edits)?;
                let mut out = self.children_of(&outer, start, count)?;
                let h = self.rows_member(edits);
                if let Some(rows) = h.checked_sub(start).and_then(|i| out.children.get_mut(i as usize)) {
                    rows.count = Some(self.rows_total(edits));
                    rows.size = rows.size.max(self.body_end.load(std::sync::atomic::Ordering::Acquire) - self.body_start);
                }
                Ok(out)
            }
            Place::Row { row, inner } => {
                let (_, val) = self.row_val(edits, row)?;
                self.children_of(&self.descend(val, inner)?, start, count)
            }
            Place::Outer { path } => {
                let outer = self.outer(edits)?;
                self.children_of(&self.descend(outer, path)?, start, count)
            }
        }
    }

    fn children_of(&self, val: &Val, start: u64, count: u64) -> Result<JsonChildren, String> {
        let object = match val.buf.get(val.s) {
            Some(b'{') => true,
            Some(b'[') => false,
            _ => return Err("That value has no children".into()),
        };
        let starts = self.starts(val, val.s)?;
        let total = starts.len() as u64 - 1;
        let end = (start + count).min(total);
        let children = (start..end)
            .map(|i| {
                let en = entry(&val.buf, &starts, i as usize, object);
                node(&val.buf, en.vs, en.e, en.key.map(|k| key_text(&val.buf, k)))
            })
            .collect();
        Ok(JsonChildren { total, complete: true, children })
    }

    /// The exact text of the value at `path`, for copying and editing.
    pub fn tree_raw(&self, edits: &EditLayer, path: &[u64]) -> Result<String, String> {
        let val = match self.place(edits, path) {
            Place::Rows | Place::Root => {
                if !edits.is_pristine() {
                    return Err("Save first to copy the whole document".into());
                }
                let data = self.data();
                let (s, e) = trim(data, self.root_start(), data.len(), false);
                Val { buf: Cow::Borrowed(data), s, e, file: true, key: None }
            }
            Place::Row { row, inner } => self.descend(self.row_val(edits, row)?.1, inner)?,
            Place::Outer { path } => self.descend(self.outer(edits)?, path)?,
        };
        if val.e - val.s > MAX_RAW {
            return Err(format!("That value is {} MB, too large to copy", (val.e - val.s) >> 20));
        }
        Ok(String::from_utf8_lossy(&val.buf[val.s..val.e]).into_owned())
    }

    /// Applies a JSON view edit as one undo step.
    pub fn tree_edit(&self, edits: &mut EditLayer, op: TreeEdit) -> Result<(), String> {
        let (path, text_op): (Vec<u64>, Option<TextOp>) = match op {
            TreeEdit::Set { path, text } => {
                let v = value_text(&text)?;
                let Some((&last, parent)) = path.split_last() else { return Err("Edit the items inside instead".into()) };
                // Setting a whole row replaces its record.
                if let (Place::Row { row, inner: [] }, false) = (self.place(edits, &path), self.mode == Mode::Members) {
                    return self.set_row(edits, row, v);
                }
                (parent.to_vec(), Some(TextOp::Set(last, v)))
            }
            TreeEdit::Rename { path, key } => {
                let Some((&last, parent)) = path.split_last() else { return Err("The root has no key".into()) };
                (parent.to_vec(), Some(TextOp::Rename(last, key)))
            }
            TreeEdit::Delete { path } => {
                let Some((&last, parent)) = path.split_last() else { return Err("The root can't be deleted".into()) };
                match self.place(edits, &path) {
                    Place::Row { row, inner: [] } => return edits.delete_rows(row, 1),
                    Place::Rows => return Err("This array holds the table rows and can't be deleted".into()),
                    _ => (parent.to_vec(), Some(TextOp::Delete(last))),
                }
            }
            TreeEdit::Insert { parent, index, key, text } => {
                let v = value_text(&text)?;
                if let Place::Rows = self.place(edits, &parent) {
                    let item = match self.mode {
                        Mode::Members => {
                            let k = key.ok_or("A new member needs a key")?;
                            format!("{}: {v}", serde_json::to_string(&k).map_err(|e| e.to_string())?)
                        }
                        _ => v,
                    };
                    let item = self.check_record(item)?;
                    return edits.batch(|e| {
                        let row = e.insert_rows(index.min(self.rows_total(e)), 1)?[0];
                        e.set_raw(row, item);
                        Ok(())
                    });
                }
                (parent, Some(TextOp::Insert(index, key, v)))
            }
        };
        let op = text_op.expect("set above");
        match self.place(edits, &path) {
            Place::Rows => match op {
                // Rows container's own members are the rows: edit them as records.
                TextOp::Set(row, v) => self.set_row(edits, row, v),
                TextOp::Delete(row) => edits.delete_rows(row, 1),
                TextOp::Rename(row, key) if self.mode == Mode::Members => {
                    let text = self.record_text(edits, row)?;
                    let text = apply_op(&format!("{{{text}}}"), 0, &[], TextOp::Rename(0, key))?;
                    self.set_row(edits, row, text[1..text.len() - 1].to_string())
                }
                _ => Err("Array items have no key".into()),
            },
            Place::Row { row, inner } => {
                let text = self.record_text(edits, row)?;
                let new = if self.mode == Mode::Members {
                    // Edit `"k": v` as the object `{"k": v}`, then unwrap it.
                    let path: Vec<u64> = std::iter::once(0).chain(inner.iter().copied()).collect();
                    let t = apply_op(&format!("{{{text}}}"), 0, &path, op)?;
                    t[1..t.len() - 1].to_string()
                } else {
                    let s = text.len() - text.trim_start().len();
                    apply_op(&text, s, inner, op)?
                };
                self.set_row(edits, row, new)
            }
            Place::Root | Place::Outer { .. } => self.edit_outer(edits, &path, op),
        }
    }

    /// A record's current text, for editing.
    fn record_text(&self, edits: &EditLayer, row: u64) -> Result<String, String> {
        if edits.column_defs().is_some() {
            return Err("Columns were changed in the table; save before editing records here".into());
        }
        let r = edits.resolve(row, 1, self.index.row_count()).first().copied().ok_or("That row no longer exists")?;
        let text = match self.edited_record(edits, r)? {
            Some(t) => t,
            None => {
                let RowRef::Src(src) = r else { unreachable!() };
                super::lossy(self.record(src).unwrap_or_default())
            }
        };
        if text.len() > MAX_EDIT {
            return Err("This record is too large to edit here".into());
        }
        Ok(text)
    }

    /// Checks a record's new text; JSON Lines records stay on one line.
    fn check_record(&self, text: String) -> Result<String, String> {
        match self.mode {
            Mode::Members => check_json(&format!("{{{text}}}"))?,
            _ => check_json(&text)?,
        }
        Ok(if self.mode == Mode::Lines && text.contains(['\n', '\r']) { compact(&text) } else { text })
    }

    fn set_row(&self, edits: &mut EditLayer, row: u64, text: String) -> Result<(), String> {
        if edits.column_defs().is_some() {
            return Err("Columns were changed in the table; save before editing records here".into());
        }
        let text = self.check_record(text)?;
        if row >= self.rows_total(edits) {
            return Err("That row no longer exists".into());
        }
        let r = edits.resolve(row, 1, self.index.row_count())[0];
        edits.set_raw(r, text);
        Ok(())
    }

    /// Edits the root object around the rows, through its head and tail.
    fn edit_outer(&self, edits: &mut EditLayer, path: &[u64], op: TextOp) -> Result<(), String> {
        let (head, tail) = self.head_tail(edits)?;
        if head.len() + tail.len() > MAX_EDIT {
            return Err("The data around the rows is too large to edit here".into());
        }
        let h = self.rows_member(edits);
        let mut new_h = h;
        if path.is_empty() {
            match &op {
                TextOp::Set(i, _) | TextOp::Delete(i) if *i == h => {
                    return Err("This array holds the table rows; edit its items instead".into());
                }
                TextOp::Delete(i) if *i < h => new_h -= 1,
                TextOp::Insert(i, ..) if *i <= h => new_h += 1,
                _ => {}
            }
        }
        let text = head + &tail;
        let root = text.find('{').ok_or("The root isn't an object")?;
        let new = apply_op(&text, root, path, op)?;
        check_json(new.trim_start_matches('\u{feff}'))?;
        // Split again just inside the rows array, which reads as `[]`.
        let b = new.as_bytes();
        let starts = scan_starts(b, root)?;
        let en = entry(b, &starts, new_h as usize, true);
        if b.get(en.vs) != Some(&b'[') {
            return Err("The rows array moved; undo and try again".into());
        }
        let (head, tail) = (new[..en.vs + 1].to_string(), new[en.vs + 1..].to_string());
        edits.batch(|e| {
            e.set_region(Region::Head, head);
            e.set_region(Region::Tail, tail);
            Ok(())
        })
    }
}
