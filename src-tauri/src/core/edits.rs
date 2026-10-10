use std::collections::{BTreeMap, HashMap};

/// Identity of a row that survives inserts and deletes around it.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub enum RowRef {
    /// Row `n` of the source file.
    Src(u64),
    /// The `n`th row created by the user.
    New(u64),
}

/// A run of consecutive rows in view order.
#[derive(Clone, Copy, Debug)]
pub enum Seg {
    Src { start: u64, len: u64 },
    New { start: u64, len: u64 },
    /// Source rows from `start` to however many are indexed so far. Only
    /// exists while the source is still being indexed, and is always last.
    SrcTail { start: u64 },
}

impl Seg {
    /// Rows in this run, given the source rows indexed so far.
    pub fn len(&self, src_rows: u64) -> u64 {
        match *self {
            Seg::Src { len, .. } | Seg::New { len, .. } => len,
            Seg::SrcTail { start } => src_rows.saturating_sub(start),
        }
    }

    fn row(&self, i: u64) -> RowRef {
        match *self {
            Seg::Src { start, .. } | Seg::SrcTail { start } => RowRef::Src(start + i),
            Seg::New { start, .. } => RowRef::New(start + i),
        }
    }

    /// The sub-run `from..to` of this segment.
    fn slice(&self, from: u64, to: u64) -> Seg {
        match *self {
            Seg::Src { start, .. } | Seg::SrcTail { start } => Seg::Src { start: start + from, len: to - from },
            Seg::New { start, .. } => Seg::New { start: start + from, len: to - from },
        }
    }
}

/// Column keys: source column `c` is `c`; user-added columns have this bit set.
/// Cell patches are keyed by column key, so they survive column moves.
pub const NEW_COL: u32 = 1 << 31;

/// A column in view order.
#[derive(Clone, Debug)]
pub struct ColDef {
    pub key: u32,
    pub name: String,
}

pub type Patch = BTreeMap<u32, String>;

/// Which text outside the rows a region edit replaces (JSON only).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Region {
    Head,
    Tail,
}

#[derive(Clone)]
enum Op {
    Cells(Vec<(RowRef, u32, Option<String>, Option<String>)>),
    Rows { before: Vec<Seg>, after: Vec<Seg> },
    Columns { before: Option<Vec<ColDef>>, after: Option<Vec<ColDef>> },
    /// A whole record replaced (JSON view edits); cell patches fold into it.
    Raw { row: RowRef, before: (Option<String>, Option<Patch>), after: (Option<String>, Option<Patch>) },
    Region { region: Region, before: Option<String>, after: Option<String> },
    /// Several ops undone and redone together.
    Batch(Vec<Op>),
}

/// Every user change, layered over a read-only source. The source file is
/// never modified until save.
pub struct EditLayer {
    segs: Vec<Seg>,
    /// View row where each segment starts; parallel to `segs`.
    starts: Vec<u64>,
    /// Rows in fixed-length segments (everything but a `SrcTail`).
    total: u64,
    /// The source is still being indexed: `segs` ends in a `SrcTail` that
    /// grows as rows arrive. Saving and sorting wait until it finishes.
    growing: bool,
    /// Source rows indexed so far (final once not growing). Kept current by
    /// the session before each edit.
    src_rows: u64,
    cells: HashMap<RowRef, Patch>,
    raw: HashMap<RowRef, String>,
    head: Option<String>,
    tail: Option<String>,
    /// `None` while columns match the source one to one.
    columns: Option<Vec<ColDef>>,
    next_new_row: u64,
    next_new_col: u32,
    undo: Vec<Op>,
    redo: Vec<Op>,
    /// Undo depth at the last save, used to derive `dirty`.
    saved_at: Option<usize>,
    /// Bumped whenever rows or columns are added, removed or reordered.
    shape: u64,
}

impl EditLayer {
    /// A layer over a source that is still being indexed.
    pub fn growing() -> Self {
        Self {
            segs: vec![Seg::SrcTail { start: 0 }],
            starts: vec![0],
            total: 0,
            growing: true,
            src_rows: 0,
            cells: HashMap::new(),
            raw: HashMap::new(),
            head: None,
            tail: None,
            columns: None,
            next_new_row: 0,
            next_new_col: 0,
            undo: Vec::new(),
            redo: Vec::new(),
            saved_at: Some(0),
            shape: 0,
        }
    }

    /// Indexing finished with `source_rows` rows: the tail gets its final length.
    pub fn finish_growing(&mut self, source_rows: u64) {
        if !self.growing {
            return;
        }
        self.growing = false;
        self.src_rows = source_rows;
        // Ops on the undo stack may still hold a tail; `set_segs` fixes those up when they run.
        self.set_segs(self.segs.clone());
    }

    /// Records how many source rows are indexed so far (before an edit).
    pub fn set_source_rows(&mut self, source_rows: u64) {
        if self.growing {
            self.src_rows = source_rows;
        }
    }

    /// Changes whenever rows or columns are added, removed or reordered.
    pub fn shape(&self) -> u64 {
        self.shape
    }

    pub fn is_growing(&self) -> bool {
        self.growing
    }

    /// View rows; `source_rows` (indexed so far) sizes the tail while growing.
    pub fn row_count(&self, source_rows: u64) -> u64 {
        match self.segs.last() {
            Some(tail @ Seg::SrcTail { .. }) => self.total + tail.len(source_rows),
            _ => self.total,
        }
    }

    pub fn segments(&self) -> &[Seg] {
        &self.segs
    }

    /// True when no row's content changed (structure may have), so saving can copy bytes.
    pub fn rows_untouched(&self) -> bool {
        self.cells.is_empty() && self.raw.is_empty() && self.columns.is_none()
    }

    /// No change of any kind: the view is exactly the file.
    pub fn is_pristine(&self) -> bool {
        let identity = matches!(self.segs.as_slice(), [] | [Seg::Src { start: 0, .. }] | [Seg::SrcTail { start: 0 }]);
        identity && self.rows_untouched() && self.head.is_none() && self.tail.is_none()
    }

    pub fn cells_for(&self, row: RowRef) -> Option<&Patch> {
        self.cells.get(&row)
    }

    pub fn raw_for(&self, row: RowRef) -> Option<&str> {
        self.raw.get(&row).map(String::as_str)
    }

    pub fn region(&self, region: Region) -> Option<&str> {
        match region {
            Region::Head => self.head.as_deref(),
            Region::Tail => self.tail.as_deref(),
        }
    }

    pub fn column_defs(&self) -> Option<&[ColDef]> {
        self.columns.as_deref()
    }

    /// Column key of view column `col`.
    pub fn col_key(&self, col: u32) -> Option<u32> {
        match &self.columns {
            None => Some(col),
            Some(defs) => defs.get(col as usize).map(|d| d.key),
        }
    }

    /// Current column list, given the source's names.
    pub fn column_names(&self, source: &[String]) -> Vec<String> {
        match &self.columns {
            None => source.to_vec(),
            Some(defs) => defs.iter().map(|d| d.name.clone()).collect(),
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn is_dirty(&self) -> bool {
        self.saved_at != Some(self.undo.len())
    }

    /// Maps view rows `start..start + count` to row identities; `source_rows`
    /// is how many source rows are indexed (it sizes the tail while growing).
    pub fn resolve(&self, start: u64, count: u64, source_rows: u64) -> Vec<RowRef> {
        let end = (start + count).min(self.row_count(source_rows));
        let mut out = Vec::with_capacity(end.saturating_sub(start) as usize);
        if start >= end {
            return out;
        }
        let mut si = self.seg_at(start);
        let mut row = start;
        while row < end {
            let seg = &self.segs[si];
            let seg_end = (self.starts[si] + seg.len(source_rows)).min(end);
            for r in row..seg_end {
                out.push(seg.row(r - self.starts[si]));
            }
            row = seg_end;
            si += 1;
        }
        out
    }

    /// Current value of a cell patch (`None` when the cell is unchanged).
    pub fn patch_value(&self, row: RowRef, key: u32) -> Option<&str> {
        self.cells.get(&row).and_then(|m| m.get(&key)).map(String::as_str)
    }

    /// Applies cell changes `(row, column key, value)` as one undo step.
    pub fn set_cells(&mut self, changes: Vec<(RowRef, u32, String)>) {
        if changes.is_empty() {
            return;
        }
        let mut op = Vec::with_capacity(changes.len());
        for (row, key, value) in changes {
            let old = self.patch_value(row, key).map(str::to_string);
            self.apply_cell(row, key, Some(value.clone()));
            op.push((row, key, old, Some(value)));
        }
        self.push(Op::Cells(op));
    }

    pub fn insert_rows(&mut self, at: u64, count: u64) -> Result<Vec<RowRef>, String> {
        if at > self.row_count(self.src_rows) || count == 0 {
            return Err("Insert position out of range".into());
        }
        let first = self.next_new_row;
        let new = Seg::New { start: first, len: count };
        self.next_new_row += count;
        self.splice(at, 0, Some(new));
        Ok((first..first + count).map(RowRef::New).collect())
    }

    pub fn delete_rows(&mut self, start: u64, count: u64) -> Result<(), String> {
        let rows = self.row_count(self.src_rows);
        if start >= rows || count == 0 {
            return Err("Delete range out of range".into());
        }
        let count = count.min(rows - start);
        self.splice(start, count, None);
        Ok(())
    }

    /// Edits the column plan. `source` names the source columns when the plan
    /// is still implicit; `f` gets the columns and a generator for new keys.
    pub fn set_columns(
        &mut self,
        source: &[String],
        f: impl FnOnce(&mut Vec<ColDef>, &mut dyn FnMut() -> u32) -> Result<(), String>,
    ) -> Result<(), String> {
        let before = self.columns.clone();
        let mut defs = before.clone().unwrap_or_else(|| {
            source.iter().enumerate().map(|(i, n)| ColDef { key: i as u32, name: n.clone() }).collect()
        });
        let mut next = self.next_new_col;
        f(&mut defs, &mut || {
            next += 1;
            NEW_COL | (next - 1)
        })?;
        self.next_new_col = next;
        let identity = defs.len() == source.len()
            && defs.iter().enumerate().all(|(i, d)| d.key == i as u32 && d.name == source[i]);
        let after = if identity { None } else { Some(defs) };
        self.columns = after.clone();
        self.shape += 1;
        self.push(Op::Columns { before, after });
        Ok(())
    }

    /// Replaces a whole record's text (JSON view edits), folding its cell patches in.
    pub fn set_raw(&mut self, row: RowRef, text: String) {
        let before = (self.raw.get(&row).cloned(), self.cells.get(&row).cloned());
        self.raw.insert(row, text.clone());
        self.cells.remove(&row);
        self.push(Op::Raw { row, before, after: (Some(text), None) });
    }

    pub fn set_region(&mut self, region: Region, text: String) {
        let before = self.region(region).map(str::to_string);
        self.put_region(region, Some(text.clone()));
        self.push(Op::Region { region, before, after: Some(text) });
    }

    /// Runs several edits as one undo step.
    pub fn batch<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T, String>) -> Result<T, String> {
        let depth = self.undo.len();
        let result = f(self);
        let ops: Vec<Op> = self.undo.drain(depth..).collect();
        if result.is_err() {
            // Roll back whatever part of the batch ran.
            for op in ops.iter().rev() {
                self.revert(op);
            }
            return result;
        }
        if !ops.is_empty() {
            self.undo.push(Op::Batch(ops));
        }
        result
    }

    pub fn undo(&mut self) -> bool {
        let Some(op) = self.undo.pop() else { return false };
        self.revert(&op);
        self.redo.push(op);
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(op) = self.redo.pop() else { return false };
        self.reapply(&op);
        self.undo.push(op);
        true
    }

    fn revert(&mut self, op: &Op) {
        match op {
            Op::Cells(changes) => {
                for (row, key, old, _) in changes.iter().rev() {
                    self.apply_cell(*row, *key, old.clone());
                }
            }
            Op::Rows { before, .. } => self.set_segs(before.clone()),
            Op::Columns { before, .. } => {
                self.columns = before.clone();
                self.shape += 1;
            }
            Op::Raw { row, before, .. } => self.put_raw(*row, before.clone()),
            Op::Region { region, before, .. } => self.put_region(*region, before.clone()),
            Op::Batch(ops) => {
                for op in ops.iter().rev() {
                    self.revert(op);
                }
            }
        }
    }

    fn reapply(&mut self, op: &Op) {
        match op {
            Op::Cells(changes) => {
                for (row, key, _, new) in changes {
                    self.apply_cell(*row, *key, new.clone());
                }
            }
            Op::Rows { after, .. } => self.set_segs(after.clone()),
            Op::Columns { after, .. } => {
                self.columns = after.clone();
                self.shape += 1;
            }
            Op::Raw { row, after, .. } => self.put_raw(*row, after.clone()),
            Op::Region { region, after, .. } => self.put_region(*region, after.clone()),
            Op::Batch(ops) => {
                for op in ops {
                    self.reapply(op);
                }
            }
        }
    }

    fn push(&mut self, op: Op) {
        // A new edit invalidates the redo branch, including the saved state if it lived there.
        if self.saved_at.is_some_and(|s| s > self.undo.len()) {
            self.saved_at = None;
        }
        self.redo.clear();
        self.undo.push(op);
    }

    fn apply_cell(&mut self, row: RowRef, key: u32, value: Option<String>) {
        match value {
            Some(v) => {
                self.cells.entry(row).or_default().insert(key, v);
            }
            None => {
                if let Some(m) = self.cells.get_mut(&row) {
                    m.remove(&key);
                    if m.is_empty() {
                        self.cells.remove(&row);
                    }
                }
            }
        }
    }

    fn put_raw(&mut self, row: RowRef, (raw, cells): (Option<String>, Option<Patch>)) {
        match raw {
            Some(r) => self.raw.insert(row, r),
            None => self.raw.remove(&row),
        };
        match cells {
            Some(c) => self.cells.insert(row, c),
            None => self.cells.remove(&row),
        };
    }

    fn put_region(&mut self, region: Region, text: Option<String>) {
        match region {
            Region::Head => self.head = text,
            Region::Tail => self.tail = text,
        }
    }

    /// Removes `delete` view rows at `at` and optionally inserts `insert` there.
    fn splice(&mut self, at: u64, delete: u64, insert: Option<Seg>) {
        let before = self.segs.clone();
        // A growing tail is cut as the rows indexed so far; whatever arrives
        // later goes after them, as a new tail.
        let segs: Vec<Seg> = self
            .segs
            .iter()
            .map(|s| match *s {
                Seg::SrcTail { start } => Seg::Src { start, len: s.len(self.src_rows) },
                s => s,
            })
            .collect();
        let cut_end = at + delete;
        let mut out = Vec::with_capacity(segs.len() + 3);
        let mut inserted = false;
        for (seg, &s) in segs.iter().zip(&self.starts) {
            let e = s + seg.len(self.src_rows);
            if e <= at || s >= cut_end && (inserted || insert.is_none()) {
                // Entirely before the cut, or after it once the insert is placed.
                if s >= cut_end && !inserted {
                    out.extend(insert);
                    inserted = true;
                }
                out.push(*seg);
                continue;
            }
            if s < at {
                out.push(seg.slice(0, at - s));
            }
            if !inserted {
                out.extend(insert);
                inserted = true;
            }
            if e > cut_end {
                out.push(seg.slice(cut_end.max(s) - s, e - s));
            }
        }
        if !inserted {
            out.extend(insert);
        }
        if self.growing {
            out.push(Seg::SrcTail { start: self.src_rows });
        }
        self.set_segs(out);
        self.push(Op::Rows { before, after: self.segs.clone() });
    }

    fn set_segs(&mut self, segs: Vec<Seg>) {
        let src_rows = self.src_rows;
        // Merge adjacent runs so repeated edits don't fragment the list.
        let mut merged: Vec<Seg> = Vec::with_capacity(segs.len());
        for seg in segs {
            let seg = match seg {
                // Once indexing is done a tail (e.g. from an undo) is just the rest of the file.
                Seg::SrcTail { start } if !self.growing => Seg::Src { start, len: src_rows.saturating_sub(start) },
                s => s,
            };
            if !matches!(seg, Seg::SrcTail { .. }) && seg.len(src_rows) == 0 {
                continue;
            }
            match (merged.last_mut(), seg) {
                (Some(Seg::Src { start, len }), Seg::Src { start: s2, len: l2 }) if *start + *len == s2 => *len += l2,
                (Some(Seg::New { start, len }), Seg::New { start: s2, len: l2 }) if *start + *len == s2 => *len += l2,
                (Some(last), Seg::SrcTail { start: s2 }) if matches!(*last, Seg::Src { start, len } if start + len == s2) => {
                    if let Seg::Src { start, .. } = *last {
                        *last = Seg::SrcTail { start };
                    }
                }
                _ => merged.push(seg),
            }
        }
        let mut starts = Vec::with_capacity(merged.len());
        let mut total = 0;
        for seg in &merged {
            starts.push(total);
            if !matches!(seg, Seg::SrcTail { .. }) {
                total += seg.len(src_rows);
            }
        }
        self.segs = merged;
        self.starts = starts;
        self.total = total;
        self.shape += 1;
    }

    fn seg_at(&self, view_row: u64) -> usize {
        self.starts.partition_point(|&s| s <= view_row) - 1
    }

    /// Source row → view row for every surviving source row, as sorted runs
    /// `(src_start, view_start, len)`. Used to place search hits.
    pub fn src_runs(&self, source_rows: u64) -> Vec<(u64, u64, u64)> {
        let mut runs: Vec<(u64, u64, u64)> = self
            .segs
            .iter()
            .zip(&self.starts)
            .filter_map(|(seg, &v)| match *seg {
                Seg::Src { start, len } => Some((start, v, len)),
                Seg::SrcTail { start } => Some((start, v, seg.len(source_rows))).filter(|r| r.2 > 0),
                Seg::New { .. } => None,
            })
            .collect();
        runs.sort_unstable();
        runs
    }

    /// View rows of user-created rows (searched separately, since they have no source bytes).
    pub fn new_rows(&self) -> Vec<(u64, RowRef)> {
        let mut out = Vec::new();
        for (seg, &v) in self.segs.iter().zip(&self.starts) {
            if let Seg::New { start, len } = *seg {
                out.extend((0..len).map(|i| (v + i, RowRef::New(start + i))));
            }
        }
        out
    }

    /// Rows whose content differs from the source bytes.
    pub fn touched_rows(&self) -> impl Iterator<Item = RowRef> + '_ {
        self.cells.keys().chain(self.raw.keys()).copied()
    }

    /// Visits every view row in order with its source cells (`None` for new
    /// rows) and cell patches. `read` fetches source rows in batches.
    pub fn for_each_row<T: Clone + Default>(
        &self,
        read: &dyn Fn(u64, u64) -> Vec<T>,
        f: &mut dyn FnMut(RowRef, Option<T>, Option<&Patch>) -> Result<(), String>,
        on_progress: &dyn Fn(u64, u64) -> Result<(), String>,
    ) -> Result<(), String> {
        const BATCH: u64 = 4096;
        let mut done = 0;
        let total = self.row_count(self.src_rows);
        for seg in &self.segs {
            match *seg {
                Seg::Src { start, .. } | Seg::SrcTail { start } => {
                    let len = seg.len(self.src_rows);
                    let mut at = start;
                    while at < start + len {
                        let n = BATCH.min(start + len - at);
                        let mut rows = read(at, n);
                        rows.resize(n as usize, T::default());
                        for (i, row) in rows.into_iter().enumerate() {
                            let r = RowRef::Src(at + i as u64);
                            f(r, Some(row), self.cells.get(&r))?;
                        }
                        at += n;
                        done += n;
                        on_progress(done, total)?;
                    }
                }
                Seg::New { start, len } => {
                    for r in start..start + len {
                        let r = RowRef::New(r);
                        f(r, None, self.cells.get(&r))?;
                    }
                    done += len;
                    on_progress(done, total)?;
                }
            }
        }
        Ok(())
    }

    pub fn mark_saved(&mut self) {
        self.saved_at = Some(self.undo.len());
    }
}

/// Maps view columns to keys and names, for formats writing edited columns.
pub struct ColumnPlan<'a> {
    pub source: &'a [String],
    pub defs: Option<&'a [ColDef]>,
}

impl ColumnPlan<'_> {
    pub fn keys(&self) -> Vec<u32> {
        match self.defs {
            None => (0..self.source.len() as u32).collect(),
            Some(d) => d.iter().map(|c| c.key).collect(),
        }
    }

    pub fn names(&self) -> Vec<String> {
        match self.defs {
            None => self.source.to_vec(),
            Some(d) => d.iter().map(|c| c.name.clone()).collect(),
        }
    }

    /// Cells in view column order: source cells by key, patches on top.
    pub fn project(&self, source_cells: &[String], patch: Option<&Patch>) -> Vec<String> {
        let value = |key: u32| -> String {
            if let Some(v) = patch.and_then(|p| p.get(&key)) {
                return v.clone();
            }
            if key & NEW_COL == 0 {
                source_cells.get(key as usize).cloned().unwrap_or_default()
            } else {
                String::new()
            }
        };
        match self.defs {
            None => {
                // Patches of since-removed added columns carry NEW_COL keys; skip them.
                let last_patch = patch.and_then(|p| p.range(..NEW_COL).next_back());
                let width = source_cells.len().max(last_patch.map_or(0, |(&k, _)| k as usize + 1));
                (0..width as u32).map(value).collect()
            }
            Some(d) => d.iter().map(|c| value(c.key)).collect(),
        }
    }
}

impl EditLayer {
    pub fn plan<'a>(&'a self, source: &'a [String]) -> ColumnPlan<'a> {
        ColumnPlan { source, defs: self.columns.as_deref() }
    }
}
