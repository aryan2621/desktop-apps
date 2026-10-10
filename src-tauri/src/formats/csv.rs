use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64};

use csv::{ByteRecord, QuoteStyle, ReaderBuilder, Terminator, WriterBuilder};
use encoding_rs::{Encoding, UTF_8};
use memchr::memchr2_iter;
use memmap2::Mmap;

use super::{text, OpenOptions};
use crate::core::edits::{ColumnPlan, EditLayer, Patch, RowRef, Seg};
use crate::core::export::ExportFormat;
use crate::core::index::RowIndex;
use crate::core::source::{DataSource, Progress};

const MAX_ROWS_PER_READ: u64 = 10_000;
const COPY_CHUNK: usize = 8 << 20;

pub struct CsvSource {
    /// `None` for empty files, which can't be memory-mapped.
    map: Option<Mmap>,
    delimiter: u8,
    crlf: bool,
    has_header: bool,
    /// Encoding of the file on disk. UTF-16 files are mapped from a UTF-8 cache.
    encoding: &'static Encoding,
    /// UTF-8 copy of a UTF-16 file, deleted on close.
    cache: Option<PathBuf>,
    columns: Vec<String>,
    /// First byte after the BOM and header line.
    data_start: u64,
    index: RowIndex,
}

impl CsvSource {
    pub fn open(path: &Path, opts: &OpenOptions) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("Can't open file: {e}"))?;
        let probe = map_file(&file)?;
        let detected = text::detect(probe.as_deref().unwrap_or(&[]));
        let encoding = match &opts.encoding {
            Some(name) => text::by_name(name)?,
            None => detected,
        };
        // UTF-16 can't be scanned for ASCII delimiters, so read a UTF-8 copy.
        let (map, cache) = if text::is_utf16(encoding) {
            drop(probe);
            let cache = text::utf16_to_cache(path, encoding)?;
            let file = File::open(&cache).map_err(|e| e.to_string())?;
            (map_file(&file)?, Some(cache))
        } else {
            (probe, None)
        };
        let data: &[u8] = map.as_deref().unwrap_or(&[]);

        let bom = if data.starts_with(b"\xEF\xBB\xBF") { 3 } else { 0 };
        let first_end = next_row_start(data, bom).unwrap_or(data.len());
        let first_line = &data[bom..first_end];
        let crlf = first_line.ends_with(b"\r\n");
        let delimiter = match opts.delimiter.as_deref() {
            Some("\\t") | Some("\t") | Some("tab") => b'\t',
            Some(d) if d.len() == 1 => d.as_bytes()[0],
            Some(d) => return Err(format!("Unsupported delimiter {d:?}")),
            None => sniff_delimiter(first_line),
        };
        let has_header = opts.has_header.unwrap_or(true);
        let header_end = if has_header { first_end } else { bom };

        let header: Vec<String> = if has_header {
            parse_record(first_line, delimiter).iter().map(|f| text::decode(encoding, f)).collect()
        } else {
            Vec::new()
        };
        let sample_width = sample_width(&data[header_end..], delimiter);
        let columns = (0..header.len().max(sample_width).max(1))
            .map(|i| match header.get(i) {
                Some(name) if !name.trim().is_empty() => name.clone(),
                _ => format!("Column {}", i + 1),
            })
            .collect();

        Ok(Self {
            delimiter,
            crlf,
            has_header,
            encoding,
            cache,
            columns,
            data_start: header_end as u64,
            index: RowIndex::new(header_end as u64),
            map,
        })
    }

    fn data(&self) -> &[u8] {
        self.map.as_deref().unwrap_or(&[])
    }

    fn terminator(&self) -> &'static [u8] {
        if self.crlf { b"\r\n" } else { b"\n" }
    }

    fn encode_row(&self, fields: &[Vec<u8>]) -> Result<Vec<u8>, String> {
        let mut w = WriterBuilder::new()
            .delimiter(self.delimiter)
            .terminator(if self.crlf { Terminator::CRLF } else { Terminator::Any(b'\n') })
            .quote_style(QuoteStyle::Necessary)
            .flexible(true)
            .from_writer(Vec::new());
        w.write_record(fields).map_err(|e| e.to_string())?;
        w.into_inner().map_err(|e| e.to_string())
    }

    fn decode_record(&self, raw: &[u8]) -> Vec<String> {
        parse_record(raw, self.delimiter).iter().map(|f| text::decode(self.encoding, f)).collect()
    }

    /// Text cells re-encoded as one CSV line in the file's encoding.
    fn encode_cells(&self, cells: Vec<String>, width: usize) -> Result<Vec<u8>, String> {
        let mut fields = cells
            .iter()
            .map(|c| text::encode(self.encoding, c).map(|b| b.into_owned()))
            .collect::<Result<Vec<_>, _>>()?;
        // A row with no fields would be written as a blank line, which readers skip.
        if fields.len() < width {
            fields.resize(width, Vec::new());
        }
        self.encode_row(&fields)
    }

    /// Row bytes with patches and the column plan applied, re-encoded as CSV.
    fn patched_row(&self, raw: &[u8], patch: Option<&Patch>, plan: &ColumnPlan) -> Result<Vec<u8>, String> {
        let cells = plan.project(&self.decode_record(raw), patch);
        self.encode_cells(cells, plan.keys().len())
    }
}

impl Drop for CsvSource {
    fn drop(&mut self) {
        if let Some(cache) = &self.cache {
            self.map = None;
            let _ = std::fs::remove_file(cache);
        }
    }
}

/// Read-only map of a file; `None` for empty files, which can't be mapped.
pub(crate) fn map_file(file: &File) -> Result<Option<Mmap>, String> {
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len == 0 {
        return Ok(None);
    }
    // SAFETY: the map is read-only; if another process truncates the file
    // while it's open, reads may fault. Every large-file editor shares this risk.
    unsafe { Mmap::map(file) }.map(Some).map_err(|e| format!("Can't map file: {e}"))
}

impl DataSource for CsvSource {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn format(&self) -> &'static str {
        "csv"
    }

    fn columns(&self) -> Vec<String> {
        self.columns.clone()
    }

    fn file_size(&self) -> u64 {
        self.data().len() as u64
    }

    fn options(&self) -> OpenOptions {
        OpenOptions {
            sheet: None,
            has_header: Some(self.has_header),
            delimiter: Some(if self.delimiter == b'\t' { "\\t".into() } else { (self.delimiter as char).to_string() }),
            encoding: Some(self.encoding.name().to_string()),
        }
    }

    fn check_edit(&self, _row: RowRef, _raw: Option<&str>, _key: u32, value: &str) -> Result<(), String> {
        text::encode(self.encoding, value).map(|_| ())
    }

    fn native_format(&self) -> ExportFormat {
        if self.delimiter == b'\t' { ExportFormat::Tsv } else { ExportFormat::Csv }
    }

    fn maps_file(&self) -> bool {
        self.cache.is_none() && self.map.is_some()
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
        let from = self.data_start as usize;
        let mut writer = self.index.writer();
        let mut in_quotes = false;
        for pos in memchr2_iter(b'"', b'\n', &data[from..]) {
            let p = from + pos;
            if data[p] == b'"' {
                in_quotes = !in_quotes;
            } else if !in_quotes && writer.push(p as u64 + 1) {
                if self.index.is_cancelled() {
                    return;
                }
                on_progress(self.progress());
            }
        }
        writer.finish(data.len() as u64, true);
        on_progress(self.progress());
    }

    fn candidate_rows(&self, re: &regex::bytes::Regex, cancel: &AtomicBool, scanned: &AtomicU64) -> Vec<u64> {
        if self.encoding != UTF_8 && !text::is_utf16(self.encoding) {
            // Non-ASCII text is encoded differently on disk, so read cells instead.
            return crate::core::source::scan_by_reading(self, re, cancel, scanned);
        }
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
        let data = self.data();
        bounds
            .windows(2)
            .map(|w| self.decode_record(&data[w[0] as usize..w[1] as usize]))
            .collect()
    }

    fn save(&self, edits: &EditLayer, dest: &Path, on_progress: &dyn Fn(u64, u64) -> Result<(), String>) -> Result<(), String> {
        let data = self.data();
        let file = File::create(dest).map_err(|e| format!("Can't create file: {e}"))?;
        let mut out = Writer::new(BufWriter::with_capacity(1 << 20, file), self.terminator());
        let total = edits.row_count(0);
        let mut written = 0u64;
        let plan = edits.plan(&self.columns);

        match plan.defs {
            // Without a header row, column names are only labels and aren't written.
            Some(_) if self.has_header => {
                // Renamed, added or moved columns: write a new header line.
                let bom: &[u8] = if data.starts_with(b"\xEF\xBB\xBF") { b"\xEF\xBB\xBF" } else { b"" };
                out.copy(bom)?;
                let names = plan.names();
                let width = names.len();
                out.copy(&self.encode_cells(names, width)?)?;
            }
            _ => out.copy(&data[..self.data_start as usize])?,
        }
        if total > 0 {
            out.end_row()?;
        }
        let untouched = edits.rows_untouched();
        for seg in edits.segments() {
            match *seg {
                Seg::Src { start, len } if untouched => {
                    // Fast path: untouched rows are copied byte for byte.
                    if let Some((from, to, _)) = self.index.span(start, len) {
                        let mut copied = 0u64;
                        for chunk in data[from as usize..to as usize].chunks(COPY_CHUNK) {
                            out.copy(chunk)?;
                            // Rows are spread evenly enough over bytes for a progress bar.
                            copied += chunk.len() as u64;
                            on_progress(written + len * copied / (to - from), total)?;
                        }
                        out.end_row()?;
                    }
                }
                Seg::Src { start, len } => {
                    let bounds = self.index.row_bounds(start, len);
                    for (i, w) in bounds.windows(2).enumerate() {
                        let raw = &data[w[0] as usize..w[1] as usize];
                        let patch = edits.cells_for(RowRef::Src(start + i as u64));
                        match (patch, plan.defs) {
                            (None, None) => {
                                out.copy(raw)?;
                                out.end_row()?;
                            }
                            _ => out.copy(&self.patched_row(raw, patch, &plan)?)?,
                        }
                        if i % 65536 == 65535 {
                            on_progress(written + i as u64, total)?;
                        }
                    }
                }
                // Saving waits for indexing, which turns the tail into a plain run.
                Seg::SrcTail { .. } => return Err("Still loading the file; saving unlocks when it finishes".into()),
                Seg::New { start, len } => {
                    for r in start..start + len {
                        out.copy(&self.patched_row(b"", edits.cells_for(RowRef::New(r)), &plan)?)?;
                    }
                }
            }
            written += seg.len(0);
            on_progress(written, total)?;
        }
        let file = out.inner.into_inner().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        if text::is_utf16(self.encoding) {
            text::utf8_file_to_utf16(dest, self.encoding)?;
        }
        Ok(())
    }
}

/// Tracks whether output sits at a row boundary, so a source whose last line
/// has no terminator still produces well-formed rows when more follow.
struct Writer<W: Write> {
    inner: W,
    terminator: &'static [u8],
    at_line_start: bool,
}

impl<W: Write> Writer<W> {
    fn new(inner: W, terminator: &'static [u8]) -> Self {
        Self { inner, terminator, at_line_start: true }
    }

    fn copy(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.inner.write_all(bytes).map_err(|e| e.to_string())?;
        self.at_line_start = bytes.ends_with(b"\n");
        Ok(())
    }

    fn end_row(&mut self) -> Result<(), String> {
        if !self.at_line_start {
            self.copy(self.terminator)?;
        }
        Ok(())
    }
}

/// Offset just past the first newline at or after `from` that isn't inside quotes.
fn next_row_start(data: &[u8], from: usize) -> Option<usize> {
    let mut in_quotes = false;
    for pos in memchr2_iter(b'"', b'\n', &data[from..]) {
        let p = from + pos;
        if data[p] == b'"' {
            in_quotes = !in_quotes;
        } else if !in_quotes {
            return Some(p + 1);
        }
    }
    None
}

fn sniff_delimiter(line: &[u8]) -> u8 {
    let mut in_quotes = false;
    let mut counts = [0usize; 4];
    const CANDIDATES: [u8; 4] = [b',', b'\t', b';', b'|'];
    for &b in line {
        if b == b'"' {
            in_quotes = !in_quotes;
        } else if !in_quotes {
            if let Some(i) = CANDIDATES.iter().position(|&c| c == b) {
                counts[i] += 1;
            }
        }
    }
    let (best, &n) = counts.iter().enumerate().max_by_key(|(_, n)| **n).unwrap();
    if n == 0 { b',' } else { CANDIDATES[best] }
}

/// Widest record in roughly the first megabyte, so ragged files get enough columns.
fn sample_width(data: &[u8], delimiter: u8) -> usize {
    let sample = &data[..data.len().min(1 << 20)];
    ReaderBuilder::new()
        .has_headers(false)
        .delimiter(delimiter)
        .flexible(true)
        .from_reader(sample)
        .byte_records()
        .take(1000)
        .filter_map(Result::ok)
        .map(|r| r.len())
        .max()
        .unwrap_or(0)
}

/// Parses one CSV record. A blank line yields no fields.
pub(crate) fn parse_record(line: &[u8], delimiter: u8) -> Vec<Vec<u8>> {
    // Fast path: without quotes a record is a plain split, which avoids
    // setting up a reader (and its 8 KB buffer) for every row.
    if memchr::memchr(b'"', line).is_none() {
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            return Vec::new();
        }
        return line.split(|&b| b == delimiter).map(<[u8]>::to_vec).collect();
    }
    let mut reader = ReaderBuilder::new()
        .has_headers(false)
        .delimiter(delimiter)
        .flexible(true)
        .from_reader(line);
    let mut record = ByteRecord::new();
    match reader.read_byte_record(&mut record) {
        Ok(true) => record.iter().map(<[u8]>::to_vec).collect(),
        _ => Vec::new(),
    }
}
