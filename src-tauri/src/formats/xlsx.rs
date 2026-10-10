//! Excel workbooks (.xlsx).
//!
//! An .xlsx sheet is zipped XML with no random access, so the chosen sheet is
//! streamed once into a cache file of CSV rows (readable while it fills).
//! Every cached field starts with a type tag so saving can restore numbers,
//! booleans and dates: `s` text, `n` number, `b` boolean, `d` date, `e` error;
//! an empty field is an empty cell.
//!
//! Saving rewrites the whole workbook in constant memory: the edited sheet
//! from the cache, every other sheet streamed from the original. Cell values
//! and types survive; formatting, formulas (their last values are kept),
//! charts and macros do not.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions as FileOptions};
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64};

use calamine::{open_workbook, DataRef, Reader, Xlsx};
use chrono::{Datelike, Timelike};
use parking_lot::Mutex;
use rust_xlsxwriter::{ExcelDateTime, Format, Workbook, Worksheet};

mod fast;

use super::csv::parse_record;
use super::OpenOptions;
use crate::core::edits::{EditLayer, RowRef, NEW_COL};
use crate::core::export::{Cell, ExportFormat};
use crate::core::index::RowIndex;
use crate::core::source::{DataSource, Progress};

const MAX_ROWS_PER_READ: u64 = 10_000;
/// Rows are made readable in batches this size while the sheet streams in.
const PUBLISH_ROWS: usize = 8192;
pub(crate) const EXCEL_MAX_ROWS: u32 = 1_048_576;
pub(crate) const EXCEL_MAX_COLS: usize = 16_384;
pub(crate) const EXCEL_MAX_TEXT: usize = 32_767;
/// Compressed size from which a rewrite could pass the 4 GB ZIP entry limit.
const ZIP64_ABOVE: u64 = 128 << 20;

type Book = Xlsx<BufReader<File>>;

pub struct XlsxSource {
    path: PathBuf,
    sheet: String,
    sheets: Vec<String>,
    columns: Vec<String>,
    /// Typed header cells, written back as the sheet's first row.
    header: Vec<String>,
    /// Row holding column names, when the sheet has one.
    header_row: Option<u32>,
    /// First sheet row shown as data.
    first_data_row: u32,
    expected_rows: u64,
    file_size: u64,
    /// Parsed workbook (shared strings loaded), handed to the indexer.
    workbook: Mutex<Option<Book>>,
    has_header: bool,
    cache_path: PathBuf,
    cache: File,
    index: RowIndex,
    error: Mutex<Option<String>>,
}

impl XlsxSource {
    pub fn open(path: &Path, opts: &OpenOptions) -> Result<Self, String> {
        let sheet = opts.sheet.as_deref();
        let has_header = opts.has_header.unwrap_or(true);
        let file_size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
        let mut book: Book = open_workbook(path).map_err(|e| format!("Can't read workbook: {e}"))?;
        let sheets = book.sheet_names();
        let sheet = match sheet {
            Some(s) if sheets.iter().any(|n| n == s) => s.to_string(),
            Some(s) => return Err(format!("No sheet named {s}")),
            None => sheets.first().cloned().ok_or("This workbook has no sheets")?,
        };

        let (header_row, header, width, last_row) = {
            let mut reader = book
                .worksheet_cells_reader(&sheet)
                .map_err(|e| format!("Can't read sheet {sheet}: {e}"))?;
            let dims = reader.dimensions();
            let mut header: Vec<String> = Vec::new();
            let mut header_row = None;
            while let Some(cell) = reader.next_cell().map_err(|e| e.to_string())? {
                if !has_header {
                    // The first used row is data: rows start right above it.
                    header_row = Some(cell.get_position().0);
                    break;
                }
                let value = typed(cell.get_value());
                if value.is_empty() {
                    continue;
                }
                let (row, col) = cell.get_position();
                match header_row {
                    None => header_row = Some(row),
                    Some(h) if row > h => break,
                    _ => {}
                }
                put(&mut header, col as usize, value);
            }
            let first = header_row.unwrap_or(dims.start.0);
            // Without a header, `header_row` is the row before the first data row.
            let header_row = if has_header { Some(first) } else { first.checked_sub(1) };
            (header_row, header, (dims.end.1 as usize + 1).max(1), dims.end.0)
        };
        let width = width.max(header.len());
        let columns = (0..width)
            .map(|i| match header.get(i).map(|h| plain(h)) {
                Some(name) if !name.trim().is_empty() => name.to_string(),
                _ => column_letter(i),
            })
            .collect();

        let cache_path = super::text::cache_path("csv");
        let cache = FileOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&cache_path)
            .map_err(|e| format!("Can't create cache file: {e}"))?;

        Ok(Self {
            path: path.to_path_buf(),
            sheet,
            sheets,
            columns,
            header,
            header_row,
            first_data_row: header_row.map_or(0, |h| h + 1),
            expected_rows: (last_row + 1).saturating_sub(header_row.map_or(0, |h| h + 1)) as u64,
            file_size,
            workbook: Mutex::new(Some(book)),
            has_header,
            cache_path,
            cache,
            index: RowIndex::new(0),
            error: Mutex::new(None),
        })
    }

    /// Cached rows with their type tags.
    fn read_typed(&self, start: u64, count: u64) -> Vec<Vec<String>> {
        let bounds = self.index.row_bounds(start, count.min(MAX_ROWS_PER_READ));
        let (Some(&from), Some(&to)) = (bounds.first(), bounds.last()) else {
            return Vec::new();
        };
        let mut buf = vec![0; (to - from) as usize];
        if read_at(&self.cache, &mut buf, from).is_err() {
            return Vec::new();
        }
        bounds
            .windows(2)
            .map(|w| {
                parse_record(&buf[(w[0] - from) as usize..(w[1] - from) as usize], b',')
                    .into_iter()
                    .map(|f| String::from_utf8_lossy(&f).into_owned())
                    .collect()
            })
            .collect()
    }

    /// Reads the whole sheet into the cache. The fast reader does the work;
    /// calamine takes over for a package it can't read before any row is out.
    fn stream_sheet(&self, book: &mut Book, on_progress: &dyn Fn(Progress)) -> Result<(), String> {
        let calamine_only = std::env::var_os("BIGVIEW_XLSX_CALAMINE").is_some();
        if !calamine_only {
            let fast = fast::SheetReader::open(&self.path, &self.sheet, book.has_1904_epoch());
            let result = fast.and_then(|r| self.write_cache(&mut |f| r.for_each_cell(f), on_progress));
            match result {
                Err(_) if self.index.row_count() == 0 && !self.index.is_cancelled() => {
                    self.cache.set_len(0).map_err(|e| e.to_string())?;
                }
                other => return other,
            }
        }
        let mut reader = book.worksheet_cells_reader(&self.sheet).map_err(|e| e.to_string())?;
        self.write_cache(
            &mut |f| {
                while let Some(cell) = reader.next_cell().map_err(|e| e.to_string())? {
                    let (r, c) = cell.get_position();
                    if !f(r, c, &typed(cell.get_value()))? {
                        break;
                    }
                }
                Ok(())
            },
            on_progress,
        )
    }

    /// Writes cells `(row, col, typed field)` from `cells` to the cache as CSV
    /// lines, making rows readable in batches.
    fn write_cache(
        &self,
        cells: &mut dyn FnMut(&mut dyn FnMut(u32, u32, &str) -> Result<bool, String>) -> Result<(), String>,
        on_progress: &dyn Fn(Progress),
    ) -> Result<(), String> {
        let file = FileOptions::new().append(true).open(&self.cache_path).map_err(|e| e.to_string())?;
        let mut out = BufWriter::with_capacity(1 << 20, file);
        let mut line = Vec::new();
        let mut writer = self.index.writer();
        let mut pos = 0u64;
        let mut row = self.first_data_row;
        // Field buffers are reused row to row; `used` of them belong to the current row.
        let mut fields: Vec<String> = Vec::new();
        let mut used = 0usize;
        let mut rows = 0u64;
        let mut stopped = false;
        let mut seen_data = false;

        let mut emit = |fields: &[String]| -> Result<bool, String> {
            line.clear();
            encode_row(fields, &mut line);
            out.write_all(&line).map_err(|e| e.to_string())?;
            pos += line.len() as u64;
            writer.push(pos);
            rows += 1;
            if writer.pending_len() >= PUBLISH_ROWS {
                // Rows must be on disk before readers learn about them.
                out.flush().map_err(|e| e.to_string())?;
                writer.publish(rows);
                if self.index.is_cancelled() {
                    return Ok(false);
                }
                on_progress(self.progress());
            }
            Ok(true)
        };

        cells(&mut |r, c, value| {
            if r < self.first_data_row || value.is_empty() {
                return Ok(true);
            }
            // Rows with no cells still count, so row numbers match Excel.
            while row < r {
                if !emit(&fields[..used])? {
                    stopped = true;
                    return Ok(false);
                }
                used = 0;
                row += 1;
            }
            seen_data = true;
            let c = c as usize;
            while used <= c {
                match fields.get_mut(used) {
                    Some(f) => f.clear(),
                    None => fields.push(String::new()),
                }
                used += 1;
            }
            fields[c].clear();
            fields[c].push_str(value);
            Ok(true)
        })?;
        if stopped || (seen_data && !emit(&fields[..used])?) {
            return Ok(());
        }
        drop(emit);
        out.flush().map_err(|e| e.to_string())?;
        writer.finish(pos, false);
        Ok(())
    }
}

impl Drop for XlsxSource {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.cache_path);
    }
}

impl DataSource for XlsxSource {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn format(&self) -> &'static str {
        "xlsx"
    }

    fn columns(&self) -> Vec<String> {
        self.columns.clone()
    }

    fn file_size(&self) -> u64 {
        self.file_size
    }

    fn options(&self) -> OpenOptions {
        OpenOptions { sheet: Some(self.sheet.clone()), has_header: Some(self.has_header), ..Default::default() }
    }

    fn sheets(&self) -> (Vec<String>, Option<String>) {
        (self.sheets.clone(), Some(self.sheet.clone()))
    }

    fn index_error(&self) -> Option<String> {
        self.error.lock().clone()
    }

    fn native_format(&self) -> ExportFormat {
        ExportFormat::Xlsx
    }

    fn text_size(&self) -> u64 {
        self.cache.metadata().map_or(self.file_size, |m| m.len())
    }

    fn read_cells(&self, start: u64, count: u64) -> Vec<Vec<Cell>> {
        self.read_typed(start, count).into_iter().map(|row| row.into_iter().map(typed_cell).collect()).collect()
    }

    fn check_edit(&self, _row: RowRef, _raw: Option<&str>, _key: u32, value: &str) -> Result<(), String> {
        if value.chars().count() > EXCEL_MAX_TEXT {
            return Err(format!("Excel cells hold at most {EXCEL_MAX_TEXT} characters"));
        }
        Ok(())
    }

    fn row_count(&self) -> u64 {
        self.index.row_count()
    }

    fn progress(&self) -> Progress {
        let rows = self.index.row_count();
        Progress {
            rows,
            work_done: self.index.work_done(),
            work_total: self.expected_rows.max(rows),
            done: self.index.is_done(),
        }
    }

    fn build_index(&self, on_progress: &dyn Fn(Progress)) {
        let Some(mut book) = self.workbook.lock().take() else { return };
        if let Err(e) = self.stream_sheet(&mut book, on_progress) {
            *self.error.lock() = Some(format!("Stopped reading the sheet: {e}"));
            // Keep what was read so far viewable.
            self.index.writer().finish(0, false);
        }
        on_progress(self.progress());
    }

    fn candidate_rows(&self, re: &regex::bytes::Regex, cancel: &AtomicBool, scanned: &AtomicU64) -> Vec<u64> {
        crate::core::search::scan_rows(
            &self.index,
            &|from, to| {
                let mut buf = vec![0; (to - from) as usize];
                read_at(&self.cache, &mut buf, from).ok().map(|_| std::borrow::Cow::Owned(buf))
            },
            re,
            cancel,
            scanned,
        )
    }

    fn cancel(&self) {
        self.index.cancel();
    }

    fn read_rows(&self, start: u64, count: u64) -> Vec<Vec<String>> {
        self.read_typed(start, count)
            .into_iter()
            .map(|row| row.iter().map(|f| plain(f).to_string()).collect())
            .collect()
    }

    fn save(&self, edits: &EditLayer, dest: &Path, on_progress: &dyn Fn(u64, u64) -> Result<(), String>) -> Result<(), String> {
        if self.index_error().is_some() {
            return Err("The sheet wasn't fully read, so saving could lose data".into());
        }
        let err = |e: rust_xlsxwriter::XlsxError| e.to_string();
        let formats = Formats::new();
        let mut workbook = Workbook::new();
        // Sheets past 4 GB of uncompressed XML need ZIP64, which Excel reads
        // fine; small files skip it for older tools.
        if self.file_size > ZIP64_ABOVE {
            workbook.use_zip_large_file(true);
        }
        let mut original: Book = open_workbook(&self.path).map_err(|e| format!("Can't read workbook: {e}"))?;

        for name in &self.sheets {
            let ws = workbook.add_worksheet_with_constant_memory();
            ws.set_name(name).map_err(err)?;
            if *name != self.sheet {
                let mut reader = original.worksheet_cells_reader(name).map_err(|e| e.to_string())?;
                while let Some(cell) = reader.next_cell().map_err(|e| e.to_string())? {
                    let (r, c) = cell.get_position();
                    write_typed(ws, r, c, &typed(cell.get_value()), &formats)?;
                }
                continue;
            }
            let defs = edits.column_defs();
            let header: Vec<String> = match defs {
                Some(d) => d.iter().map(|c| format!("s{}", c.name)).collect(),
                None => self.header.clone(),
            };
            // Without a header row, column names are only labels and aren't written.
            if let Some(h) = self.header_row.filter(|_| self.has_header) {
                for (c, field) in header.iter().enumerate() {
                    write_typed(ws, h, c as u32, field, &formats)?;
                }
            }
            let mut r = self.first_data_row;
            edits.for_each_row(
                &|s, n| self.read_typed(s, n),
                &mut |_, raw, patch: Option<&BTreeMap<u32, String>>| {
                    if r >= EXCEL_MAX_ROWS {
                        return Err(format!("Excel sheets hold at most {EXCEL_MAX_ROWS} rows"));
                    }
                    let raw = raw.unwrap_or_default();
                    // Typed field for a column key: a patch (typed the way Excel would), else the cached value.
                    let field = |key: u32| match patch.and_then(|p| p.get(&key)) {
                        Some(text) => infer(text),
                        None if key & NEW_COL == 0 => raw.get(key as usize).cloned().unwrap_or_default(),
                        None => String::new(),
                    };
                    let keys: Vec<u32> = match defs {
                        Some(d) => d.iter().map(|c| c.key).collect(),
                        None => {
                            let last = patch.and_then(|p| p.range(..NEW_COL).next_back()).map_or(0, |(&k, _)| k as usize + 1);
                            (0..raw.len().max(last) as u32).collect()
                        }
                    };
                    for (c, key) in keys.into_iter().enumerate() {
                        write_typed(ws, r, c as u32, &field(key), &formats)?;
                    }
                    r += 1;
                    Ok(())
                },
                on_progress,
            )?;
        }
        workbook.save(dest).map_err(err)
    }
}

pub(crate) struct Formats {
    date: Format,
    datetime: Format,
}

impl Formats {
    pub(crate) fn new() -> Self {
        Self {
            date: Format::new().set_num_format("yyyy-mm-dd"),
            datetime: Format::new().set_num_format("yyyy-mm-dd hh:mm:ss"),
        }
    }
}

fn write_typed(ws: &mut Worksheet, row: u32, col: u32, field: &str, f: &Formats) -> Result<(), String> {
    let Some(tag) = field.chars().next() else { return Ok(()) };
    write_cell(ws, row, col, tag, &field[1..], f)
}

/// Writes `text` as the type `tag` names (see the module docs).
pub(crate) fn write_cell(ws: &mut Worksheet, row: u32, col: u32, tag: char, text: &str, f: &Formats) -> Result<(), String> {
    let col: u16 = col.try_into().map_err(|_| "Excel sheets hold at most 16,384 columns".to_string())?;
    let result = match tag {
        'n' => match text.parse::<f64>() {
            Ok(n) => ws.write_number(row, col, n),
            Err(_) => ws.write_string(row, col, text),
        },
        'b' => ws.write_boolean(row, col, text == "TRUE"),
        'd' => match ExcelDateTime::parse_from_str(text) {
            Ok(dt) => {
                let fmt = if text.len() > 10 { &f.datetime } else { &f.date };
                ws.write_datetime_with_format(row, col, &dt, fmt)
            }
            Err(_) => ws.write_string(row, col, text),
        },
        _ => ws.write_string(row, col, text),
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Tags a cell value with its type (see the module docs).
fn typed(v: &DataRef) -> String {
    match v {
        DataRef::Empty => String::new(),
        DataRef::Int(i) => format!("n{i}"),
        DataRef::Float(f) => format!("n{}", number(*f)),
        DataRef::String(s) => format!("s{s}"),
        DataRef::SharedString(s) => format!("s{s}"),
        DataRef::Bool(b) => format!("b{}", if *b { "TRUE" } else { "FALSE" }),
        DataRef::DateTime(dt) if dt.is_datetime() => match dt.as_datetime() {
            Some(t) => {
                let date = format!("d{:04}-{:02}-{:02}", t.year(), t.month(), t.day());
                match (t.hour(), t.minute(), t.second()) {
                    (0, 0, 0) => date,
                    (h, m, s) => format!("{date} {h:02}:{m:02}:{s:02}"),
                }
            }
            None => format!("n{}", number(dt.as_f64())),
        },
        DataRef::DateTime(dt) => format!("n{}", number(dt.as_f64())),
        DataRef::DateTimeIso(s) => format!("d{s}"),
        DataRef::DurationIso(s) => format!("s{s}"),
        DataRef::Error(e) => format!("e{e}"),
    }
}

/// An export cell for a cached, type-tagged field.
fn typed_cell(mut field: String) -> Cell {
    let Some(tag) = field.chars().next() else { return Cell::Empty };
    field.remove(0);
    match tag {
        'n' => Cell::Num(field),
        'b' => Cell::Bool(field == "TRUE"),
        'd' => Cell::Date(field),
        _ => Cell::Str(field),
    }
}

/// Type for a value the user typed, the way Excel would read it.
fn infer(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let upper = text.to_ascii_uppercase();
    if upper == "TRUE" || upper == "FALSE" {
        return format!("b{upper}");
    }
    // Leading zeros ("007") and padded text stay text, like IDs and ZIP codes.
    let leading_zero = text.len() > 1 && text.starts_with('0') && !text.starts_with("0.");
    if !leading_zero && text.trim() == text && text.parse::<f64>().is_ok_and(f64::is_finite) {
        return format!("n{text}");
    }
    if is_date(text) {
        return format!("d{text}");
    }
    format!("s{text}")
}

/// `YYYY-MM-DD`, optionally followed by ` HH:MM` or ` HH:MM:SS`.
pub(crate) fn is_date(t: &str) -> bool {
    let b = t.as_bytes();
    let digits = |r: std::ops::Range<usize>| r.clone().all(|i| b.get(i).is_some_and(u8::is_ascii_digit));
    let date = b.len() >= 10 && digits(0..4) && b[4] == b'-' && digits(5..7) && b[7] == b'-' && digits(8..10);
    date && match b.len() {
        10 => true,
        16 => b[10] == b' ' && digits(11..13) && b[13] == b':' && digits(14..16),
        19 => b[10] == b' ' && digits(11..13) && b[13] == b':' && digits(14..16) && b[16] == b':' && digits(17..19),
        _ => false,
    }
}

/// Excel-style number text: integers without a trailing `.0`.
fn number(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

/// One CSV line for the cache, quoting only where needed.
fn encode_row(fields: &[String], out: &mut Vec<u8>) {
    for (i, f) in fields.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        if f.bytes().any(|b| matches!(b, b',' | b'"' | b'\n' | b'\r')) {
            out.push(b'"');
            for b in f.bytes() {
                if b == b'"' {
                    out.push(b'"');
                }
                out.push(b);
            }
            out.push(b'"');
        } else {
            out.extend_from_slice(f.as_bytes());
        }
    }
    out.push(b'\n');
}

/// Field text without its type tag.
fn plain(field: &str) -> &str {
    field.get(1..).unwrap_or("")
}

fn put(fields: &mut Vec<String>, col: usize, value: String) {
    if fields.len() <= col {
        fields.resize(col + 1, String::new());
    }
    fields[col] = value;
}

/// A, B, …, Z, AA, AB, …
fn column_letter(mut i: usize) -> String {
    let mut s = Vec::new();
    loop {
        s.push(b'A' + (i % 26) as u8);
        if i < 26 {
            break;
        }
        i = i / 26 - 1;
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}


#[cfg(unix)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(file, buf, offset)
}

#[cfg(windows)]
fn read_at(file: &File, mut buf: &mut [u8], mut offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        let n = file.seek_read(buf, offset)?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        buf = &mut buf[n..];
        offset += n as u64;
    }
    Ok(())
}
