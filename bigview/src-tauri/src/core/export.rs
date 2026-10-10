//! Save As in another format: rows stream from the session (edits applied)
//! into a writer for CSV, JSON, JSON Lines or Excel.
//!
//! Cells carry a type where the source has one (JSON values, Excel cell
//! types); plain text (CSV cells, typed-in values) is typed on the way out:
//! numbers, booleans, and empty → null.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use rust_xlsxwriter::{Workbook, XlsxError};
use serde::{Deserialize, Serialize};

use super::edits::{Patch, NEW_COL};
use crate::formats::xlsx::{self, Formats};

/// A cell on its way out, typed as far as the source knows.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Cell {
    /// Missing, empty or JSON null.
    #[default]
    Empty,
    /// Untyped text, typed by inference when written.
    Text(String),
    Str(String),
    /// Number as written in the source.
    Num(String),
    Bool(bool),
    /// `YYYY-MM-DD` with optional ` HH:MM:SS`.
    Date(String),
    /// Nested JSON (object or array), compact.
    Json(String),
}

impl Cell {
    pub fn text(s: String) -> Cell {
        if s.is_empty() { Cell::Empty } else { Cell::Text(s) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Csv,
    Tsv,
    Json,
    JsonLines,
    Xlsx,
}

impl ExportFormat {
    pub fn label(self) -> &'static str {
        match self {
            ExportFormat::Csv => "CSV",
            ExportFormat::Tsv => "TSV",
            ExportFormat::Json => "JSON",
            ExportFormat::JsonLines => "JSON Lines",
            ExportFormat::Xlsx => "Excel",
        }
    }
}

/// What a save wrote, for the notice shown afterwards.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSummary {
    pub rows: u64,
    /// Excel sheets written (more than one when rows didn't fit one sheet).
    pub sheets: u32,
    /// Excel cells cut to 32,767 characters.
    pub truncated: u64,
}

/// Excel's row limit, minus the header row.
pub const SHEET_DATA_ROWS: u64 = xlsx::EXCEL_MAX_ROWS as u64 - 1;

pub trait RowWriter {
    fn row(&mut self, cells: &[Cell]) -> Result<(), String>;
    fn finish(self: Box<Self>) -> Result<SaveSummary, String>;
}

/// A writer for `format` at `dest`. `large` turns on ZIP64 for Excel.
pub fn writer(format: ExportFormat, dest: &Path, columns: &[String], large: bool) -> Result<Box<dyn RowWriter>, String> {
    Ok(match format {
        ExportFormat::Csv => Box::new(CsvOut::new(dest, columns, b',')?),
        ExportFormat::Tsv => Box::new(CsvOut::new(dest, columns, b'\t')?),
        ExportFormat::Json => Box::new(JsonOut::new(dest, columns, false)?),
        ExportFormat::JsonLines => Box::new(JsonOut::new(dest, columns, true)?),
        ExportFormat::Xlsx => Box::new(XlsxOut::new(dest, columns, large)?),
    })
}

/// Cells in view column order: source cells by column key, cell patches on
/// top (`typed` turns a patch into a cell, given the value it replaces).
/// `keys` is `None` while columns match the source one to one.
pub fn project(keys: Option<&[u32]>, mut src: Vec<Cell>, patch: Option<&Patch>, typed: &dyn Fn(&Cell, &str) -> Cell) -> Vec<Cell> {
    let take = |src: &mut Vec<Cell>, key: u32| -> Cell {
        let old = if key & NEW_COL == 0 { src.get_mut(key as usize).map(std::mem::take).unwrap_or_default() } else { Cell::Empty };
        match patch.and_then(|p| p.get(&key)) {
            Some(text) => typed(&old, text),
            None => old,
        }
    };
    match keys {
        None => {
            // Patches of since-removed added columns carry NEW_COL keys; skip them.
            let last = patch.and_then(|p| p.range(..NEW_COL).next_back()).map_or(0, |(&k, _)| k as usize + 1);
            let width = src.len().max(last);
            (0..width as u32).map(|k| take(&mut src, k)).collect()
        }
        Some(keys) => keys.iter().map(|&k| take(&mut src, k)).collect(),
    }
}

/// Column names made unique (JSON keys must be), with names for cells past the last column.
fn unique_names(columns: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    columns
        .iter()
        .map(|c| {
            let mut name = c.clone();
            let mut n = 2;
            while !seen.insert(name.clone()) {
                name = format!("{c} ({n})");
                n += 1;
            }
            name
        })
        .collect()
}

/// `true`/`false` in any case.
fn infer_bool(t: &str) -> Option<bool> {
    if t.eq_ignore_ascii_case("true") {
        Some(true)
    } else if t.eq_ignore_ascii_case("false") {
        Some(false)
    } else {
        None
    }
}

/// Text that reads as a number in JSON and Excel without changing: JSON
/// number syntax, no leading zeros (IDs, ZIP codes stay text), and at most 15
/// significant digits, which is what a double (and Excel) keeps exactly.
pub fn is_plain_number(t: &str) -> bool {
    let b = t.as_bytes();
    let mut i = 0;
    if b.first() == Some(&b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_len = i - int_start;
    if int_len == 0 || (int_len > 1 && b[int_start] == b'0') {
        return false;
    }
    let mut frac_len = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            frac_len += 1;
        }
        if frac_len == 0 {
            return false;
        }
    }
    let mut exp = false;
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let s = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == s {
            return false;
        }
        exp = true;
    }
    if i != b.len() {
        return false;
    }
    let digits = b[int_start..int_start + int_len].iter().chain(b.iter().skip(int_start + int_len + 1).take(frac_len));
    let significant = digits.skip_while(|&&d| d == b'0').count();
    (significant <= 15 || exp) && t.parse::<f64>().is_ok_and(f64::is_finite)
}

// ---- CSV ----

struct CsvOut {
    w: csv::Writer<BufWriter<File>>,
    width: usize,
    rows: u64,
    buf: Vec<String>,
}

impl CsvOut {
    fn new(dest: &Path, columns: &[String], delimiter: u8) -> Result<Self, String> {
        let file = File::create(dest).map_err(|e| format!("Can't create file: {e}"))?;
        let mut w = csv::WriterBuilder::new()
            .delimiter(delimiter)
            .flexible(true)
            .terminator(csv::Terminator::Any(b'\n'))
            .from_writer(BufWriter::with_capacity(1 << 20, file));
        w.write_record(columns).map_err(|e| e.to_string())?;
        Ok(Self { w, width: columns.len(), rows: 0, buf: Vec::new() })
    }
}

impl RowWriter for CsvOut {
    fn row(&mut self, cells: &[Cell]) -> Result<(), String> {
        self.buf.clear();
        for c in cells {
            self.buf.push(match c {
                Cell::Empty => String::new(),
                Cell::Bool(b) => b.to_string(),
                Cell::Text(s) | Cell::Str(s) | Cell::Num(s) | Cell::Date(s) | Cell::Json(s) => s.clone(),
            });
        }
        // Short rows are padded so every line has the header's width.
        if self.buf.len() < self.width {
            self.buf.resize(self.width, String::new());
        }
        self.w.write_record(&self.buf).map_err(|e| e.to_string())?;
        self.rows += 1;
        Ok(())
    }

    fn finish(self: Box<Self>) -> Result<SaveSummary, String> {
        let rows = self.rows;
        let out = self.w.into_inner().map_err(|e| e.to_string())?;
        let file = out.into_inner().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(SaveSummary { rows, sheets: 0, truncated: 0 })
    }
}

// ---- JSON / JSON Lines ----

struct JsonOut {
    out: BufWriter<File>,
    /// Each column's key, already quoted with its colon.
    keys: Vec<String>,
    lines: bool,
    rows: u64,
    line: String,
}

impl JsonOut {
    fn new(dest: &Path, columns: &[String], lines: bool) -> Result<Self, String> {
        let file = File::create(dest).map_err(|e| format!("Can't create file: {e}"))?;
        let mut out = BufWriter::with_capacity(1 << 20, file);
        if !lines {
            out.write_all(b"[").map_err(|e| e.to_string())?;
        }
        let keys = unique_names(columns).iter().map(|k| format!("{}:", quote(k))).collect();
        Ok(Self { out, keys, lines, rows: 0, line: String::new() })
    }

    fn key(&mut self, i: usize) -> String {
        while self.keys.len() <= i {
            let name = format!("Column {}", self.keys.len() + 1);
            self.keys.push(format!("{}:", quote(&name)));
        }
        self.keys[i].clone()
    }
}

fn quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// JSON text for a cell.
fn json_value(c: &Cell, out: &mut String) {
    match c {
        Cell::Empty => out.push_str("null"),
        Cell::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Cell::Json(s) => out.push_str(s),
        Cell::Num(s) if is_json_number(s) => out.push_str(s),
        Cell::Text(s) => match infer_bool(s) {
            Some(b) => out.push_str(if b { "true" } else { "false" }),
            None if is_plain_number(s) => out.push_str(s),
            None => out.push_str(&quote(s)),
        },
        Cell::Str(s) | Cell::Num(s) | Cell::Date(s) => out.push_str(&quote(s)),
    }
}

fn is_json_number(s: &str) -> bool {
    serde_json::from_str::<serde_json::Number>(s).is_ok()
}

impl RowWriter for JsonOut {
    fn row(&mut self, cells: &[Cell]) -> Result<(), String> {
        let mut line = std::mem::take(&mut self.line);
        line.clear();
        if !self.lines {
            line.push_str(if self.rows == 0 { "\n" } else { ",\n" });
        }
        line.push('{');
        for (i, c) in cells.iter().enumerate() {
            if i > 0 {
                line.push(',');
            }
            line.push_str(&self.key(i));
            json_value(c, &mut line);
        }
        // Short rows still list every column, as null.
        for i in cells.len()..self.keys.len() {
            if i > 0 {
                line.push(',');
            }
            line.push_str(&self.keys[i]);
            line.push_str("null");
        }
        line.push('}');
        if self.lines {
            line.push('\n');
        }
        self.out.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        self.line = line;
        self.rows += 1;
        Ok(())
    }

    fn finish(mut self: Box<Self>) -> Result<SaveSummary, String> {
        if !self.lines {
            self.out.write_all(if self.rows == 0 { b"]\n" } else { b"\n]\n" }).map_err(|e| e.to_string())?;
        }
        let file = self.out.into_inner().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(SaveSummary { rows: self.rows, sheets: 0, truncated: 0 })
    }
}

// ---- Excel ----

struct XlsxOut {
    workbook: Workbook,
    dest: std::path::PathBuf,
    header: Vec<String>,
    formats: Formats,
    sheets: u32,
    /// Next row on the current sheet.
    row: u32,
    rows: u64,
    truncated: u64,
}

impl XlsxOut {
    fn new(dest: &Path, columns: &[String], large: bool) -> Result<Self, String> {
        if columns.len() > xlsx::EXCEL_MAX_COLS {
            return Err(format!("Excel sheets hold at most {} columns; this table has {}", xlsx::EXCEL_MAX_COLS, columns.len()));
        }
        let mut workbook = Workbook::new();
        if large {
            workbook.use_zip_large_file(true);
        }
        let mut out = Self {
            workbook,
            dest: dest.to_path_buf(),
            header: columns.to_vec(),
            formats: Formats::new(),
            sheets: 0,
            row: 0,
            rows: 0,
            truncated: 0,
        };
        out.add_sheet()?;
        Ok(out)
    }

    fn add_sheet(&mut self) -> Result<(), String> {
        self.sheets += 1;
        let ws = self.workbook.add_worksheet_with_constant_memory();
        ws.set_name(format!("Sheet{}", self.sheets)).map_err(err)?;
        for (c, name) in self.header.iter().enumerate() {
            ws.write_string(0, c as u16, name).map_err(err)?;
        }
        self.row = 1;
        Ok(())
    }
}

fn err(e: XlsxError) -> String {
    e.to_string()
}

impl RowWriter for XlsxOut {
    fn row(&mut self, cells: &[Cell]) -> Result<(), String> {
        if self.row as u64 > SHEET_DATA_ROWS {
            self.add_sheet()?;
        }
        let ws = self.workbook.worksheet_from_index(self.sheets as usize - 1).map_err(err)?;
        for (c, cell) in cells.iter().enumerate() {
            let (tag, text) = match cell {
                Cell::Empty => continue,
                Cell::Text(s) => match infer_bool(s) {
                    Some(true) => ('b', "TRUE"),
                    Some(false) => ('b', "FALSE"),
                    None if is_plain_number(s) => ('n', s.as_str()),
                    None if xlsx::is_date(s) => ('d', s.as_str()),
                    None => ('s', s.as_str()),
                },
                Cell::Str(s) | Cell::Json(s) => ('s', s.as_str()),
                Cell::Num(s) => ('n', s.as_str()),
                Cell::Bool(b) => ('b', if *b { "TRUE" } else { "FALSE" }),
                Cell::Date(s) => ('d', s.as_str()),
            };
            let text = if tag == 's' && text.len() > xlsx::EXCEL_MAX_TEXT && text.chars().count() > xlsx::EXCEL_MAX_TEXT {
                self.truncated += 1;
                let cut = text.char_indices().nth(xlsx::EXCEL_MAX_TEXT).map_or(text.len(), |(i, _)| i);
                &text[..cut]
            } else {
                text
            };
            xlsx::write_cell(ws, self.row, c as u32, tag, text, &self.formats)?;
        }
        self.row += 1;
        self.rows += 1;
        Ok(())
    }

    fn finish(mut self: Box<Self>) -> Result<SaveSummary, String> {
        self.workbook.save(&self.dest).map_err(err)?;
        Ok(SaveSummary { rows: self.rows, sheets: self.sheets, truncated: self.truncated })
    }
}
