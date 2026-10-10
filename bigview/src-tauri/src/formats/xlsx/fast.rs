//! A fast reader for one worksheet's cells, used for the full read of a sheet.
//!
//! calamine parses sheet XML through a general XML reader, which is most of
//! the time spent reading a big workbook. This reader inflates the sheet on
//! one thread and scans the XML on another with a byte scanner that only
//! knows `<row>`, `<c>`, `<v>`, `<f>` and `<is>`. Values are read exactly as
//! calamine reads them (shared strings, number formats, 1904 dates), and come
//! out as the cache's type-tagged fields.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::mpsc::sync_channel;

use calamine::{DataRef, ExcelDateTime, ExcelDateTimeType};
use memchr::{memchr, memmem};
use zip::ZipArchive;

/// Inflated XML handed from the inflating thread to the scanner at a time.
const CHUNK: usize = 8 << 20;

/// How a number is shown, from its cell style (as calamine decides it).
#[derive(Clone, Copy, PartialEq)]
enum Fmt {
    Other,
    DateTime,
    TimeDelta,
}

pub struct SheetReader {
    zip_path: PathBuf,
    entry: String,
    strings: Vec<String>,
    formats: Vec<Fmt>,
    is_1904: bool,
}

type Zip = ZipArchive<BufReader<File>>;

fn open_zip(path: &Path) -> Result<Zip, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())
}

/// Entry names are matched without case, like calamine does.
fn find_entry(zip: &Zip, name: &str) -> Option<String> {
    let name = name.replace('\\', "/");
    zip.file_names().find(|n| n.replace('\\', "/").eq_ignore_ascii_case(&name)).map(str::to_string)
}

fn read_entry(zip: &mut Zip, name: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(real) = find_entry(zip, name) else { return Ok(None) };
    let mut entry = zip.by_name(&real).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(Some(out))
}

impl SheetReader {
    pub fn open(path: &Path, sheet: &str, is_1904: bool) -> Result<Self, String> {
        let mut zip = open_zip(path)?;
        let root = read_entry(&mut zip, "_rels/.rels")?.ok_or("No _rels/.rels")?;
        let doc = rels(&root)
            .into_iter()
            .find(|(_, typ, _)| typ.ends_with("/relationships/officeDocument"))
            .map(|(_, _, target)| target)
            .ok_or("No workbook in the package")?;
        let xl = doc.rfind('/').map_or("", |i| &doc[..=i]).trim_start_matches('/').to_string();

        let wb_rels = read_entry(&mut zip, &format!("{xl}_rels/workbook.xml.rels"))?.ok_or("No workbook relationships")?;
        let targets: HashMap<String, String> = rels(&wb_rels).into_iter().map(|(id, _, t)| (id, t)).collect();
        let workbook = read_entry(&mut zip, &format!("{xl}workbook.xml"))?.ok_or("No workbook.xml")?;
        let mut entry = None;
        for tag in tags(&workbook, b"sheet") {
            let name = attr(tag, b"name").map(decode).unwrap_or_default();
            if name == sheet {
                let id = attr_local(tag, b"id").map(decode).unwrap_or_default();
                let target = targets.get(&id).ok_or("Sheet relationship not found")?;
                entry = Some(match target.strip_prefix('/') {
                    Some(abs) => abs.to_string(),
                    None => format!("{xl}{target}"),
                });
            }
        }
        let entry = entry.ok_or_else(|| format!("No sheet named {sheet}"))?;
        let entry = find_entry(&zip, &entry).ok_or("Sheet data not found")?;

        let strings = match read_entry(&mut zip, &format!("{xl}sharedStrings.xml"))? {
            Some(xml) => shared_strings(&xml)?,
            None => Vec::new(),
        };
        let formats = match read_entry(&mut zip, &format!("{xl}styles.xml"))? {
            Some(xml) => styles(&xml),
            None => Vec::new(),
        };
        Ok(Self { zip_path: path.to_path_buf(), entry, strings, formats, is_1904 })
    }

    /// Calls `f(row, col, field)` for each cell in order, with the cache's
    /// type-tagged field ("" for an empty cell). `f` returns false to stop.
    pub fn for_each_cell(&self, f: &mut dyn FnMut(u32, u32, &str) -> Result<bool, String>) -> Result<(), String> {
        let (tx, rx) = sync_channel::<Result<Vec<u8>, String>>(4);
        let (zip_path, entry) = (self.zip_path.clone(), self.entry.clone());
        let inflater = std::thread::Builder::new()
            .name("xlsx-inflate".into())
            .spawn(move || {
                let result = inflate(&zip_path, &entry, &mut |chunk| tx.send(Ok(chunk)).is_ok());
                if let Err(e) = result {
                    let _ = tx.send(Err(e));
                }
            })
            .map_err(|e| e.to_string())?;
        let mut scan = Scanner { reader: self, row: 0, col: 0, in_data: false, field: String::new(), text: String::new() };
        let mut result = Ok(());
        for chunk in rx.iter() {
            match chunk.and_then(|c| scan.chunk(&c, f)) {
                Ok(true) => {}
                Ok(false) => break,
                Err(e) => {
                    result = Err(e);
                    break;
                }
            }
        }
        // Dropping the receiver stops the inflater at its next send.
        drop(rx);
        let _ = inflater.join();
        result
    }
}

/// Streams the entry's XML in chunks that end right after a `</row>`, so no
/// cell is ever split. `send` returns false when the reader is gone.
fn inflate(zip_path: &Path, entry: &str, send: &mut dyn FnMut(Vec<u8>) -> bool) -> Result<(), String> {
    let mut zip = open_zip(zip_path)?;
    let mut entry = zip.by_name(entry).map_err(|e| e.to_string())?;
    let mut carry: Vec<u8> = Vec::new();
    loop {
        let mut buf = Vec::with_capacity(CHUNK + carry.len() + (64 << 10));
        buf.append(&mut carry);
        let mut eof = false;
        while buf.len() < CHUNK {
            let len = buf.len();
            buf.resize(len + (1 << 20), 0);
            let n = entry.read(&mut buf[len..]).map_err(|e| e.to_string())?;
            buf.truncate(len + n);
            if n == 0 {
                eof = true;
                break;
            }
        }
        if eof {
            send(buf);
            return Ok(());
        }
        match last_row_end(&buf) {
            Some(cut) => {
                carry.extend_from_slice(&buf[cut..]);
                buf.truncate(cut);
                if !send(buf) {
                    return Ok(());
                }
            }
            // One row longer than a chunk: keep reading.
            None => carry = buf,
        }
    }
}

/// Offset just past the last `</row>` (or `</x:row>`) end tag.
fn last_row_end(buf: &[u8]) -> Option<usize> {
    let mut end = buf.len();
    while let Some(i) = memmem::rfind(&buf[..end], b"row>") {
        // Walk back over an optional prefix to the `</`.
        let mut j = i;
        while j > 0 && buf[j - 1] != b'<' && buf[j - 1] != b'>' && j + 16 > i {
            j -= 1;
        }
        let tag = &buf[j..i];
        if j > 0 && buf[j - 1] == b'<' && tag.first() == Some(&b'/') && (tag.len() == 1 || tag.ends_with(b":")) {
            return Some(i + 4);
        }
        end = i;
    }
    None
}

struct Scanner<'r> {
    reader: &'r SheetReader,
    row: u32,
    col: u32,
    in_data: bool,
    /// Reused for each cell's field and inline text, so cells don't allocate.
    field: String,
    text: String,
}

/// Name without its namespace prefix.
fn local(name: &[u8]) -> &[u8] {
    match memchr(b':', name) {
        Some(i) => &name[i + 1..],
        None => name,
    }
}

/// A tag at `at` (just past `<`): (name, attribute bytes, self-closing, offset past `>`).
fn read_tag(data: &[u8], at: usize) -> Result<(&[u8], &[u8], bool, usize), String> {
    let end = at + memchr(b'>', &data[at..]).ok_or("Unexpected end of sheet XML")?;
    let tag = &data[at..end];
    let name_end = tag.iter().position(|b| b.is_ascii_whitespace() || *b == b'/').unwrap_or(tag.len());
    let closing = tag.last() == Some(&b'/');
    let attrs = &tag[name_end..tag.len() - closing as usize];
    Ok((&tag[..name_end], attrs, closing, end + 1))
}

impl Scanner<'_> {
    /// Scans one chunk; returns false once the sheet data ends or `f` stops.
    fn chunk(&mut self, data: &[u8], f: &mut dyn FnMut(u32, u32, &str) -> Result<bool, String>) -> Result<bool, String> {
        let mut i = 0;
        while let Some(p) = memchr(b'<', &data[i..]) {
            let at = i + p + 1;
            match data.get(at) {
                Some(b'/') => {
                    let (name, _, _, next) = read_tag(data, at + 1)?;
                    match local(name) {
                        b"row" => {
                            self.row += 1;
                            self.col = 0;
                        }
                        b"sheetData" => return Ok(false),
                        _ => {}
                    }
                    i = next;
                }
                Some(b'?' | b'!') => {
                    i = at + memchr(b'>', &data[at..]).ok_or("Unexpected end of sheet XML")? + 1;
                }
                _ => {
                    let (name, attrs, closing, next) = read_tag(data, at)?;
                    i = next;
                    match local(name) {
                        b"sheetData" if closing => return Ok(false),
                        b"sheetData" => self.in_data = true,
                        b"row" if self.in_data => {
                            if let Some(r) = attr(attrs, b"r") {
                                self.row = parse_u32(r)?.checked_sub(1).ok_or("Invalid row number")?;
                            }
                            if closing {
                                self.row += 1;
                                self.col = 0;
                            }
                        }
                        b"c" if self.in_data => {
                            let (row, col) = match attr(attrs, b"r") {
                                Some(r) => {
                                    let (row, col) = cell_ref(r)?;
                                    self.col = col;
                                    (row.unwrap_or(self.row), col)
                                }
                                None => (self.row, self.col),
                            };
                            self.field.clear();
                            if !closing {
                                i = self.cell(data, i, attr(attrs, b"s"), attr(attrs, b"t"))?;
                            }
                            self.col += 1;
                            if !f(row, col, &self.field)? {
                                return Ok(false);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        Ok(true)
    }

    /// Reads a cell's children up to `</c>` into `self.field`; returns the offset past it.
    fn cell(&mut self, data: &[u8], mut i: usize, style: Option<&[u8]>, typ: Option<&[u8]>) -> Result<usize, String> {
        loop {
            let at = i + memchr(b'<', &data[i..]).ok_or("Unexpected end of sheet XML")? + 1;
            if data.get(at) == Some(&b'/') {
                let (name, _, _, next) = read_tag(data, at + 1)?;
                i = next;
                if local(name) == b"c" {
                    return Ok(i);
                }
                continue;
            }
            let (name, _, closing, next) = read_tag(data, at)?;
            i = next;
            let name = local(name);
            match name {
                b"v" if !closing => {
                    let end = i + memchr(b'<', &data[i..]).ok_or("Unexpected end of sheet XML")?;
                    let v = &data[i..end];
                    if !matches!(typ, Some(b"inlineStr" | b"is")) {
                        self.value(v, style, typ)?;
                    }
                    i = skip_to_end(data, end, b"v")?;
                }
                b"is" if !closing => {
                    self.text.clear();
                    let mut text = std::mem::take(&mut self.text);
                    i = rich_text(data, i, b"is", &mut text)?;
                    self.field.clear();
                    self.field.push('s');
                    self.field.push_str(&text);
                    self.text = text;
                }
                b"is" => {
                    self.field.clear();
                    self.field.push('s');
                }
                _ if closing => {}
                _ => i = skip_to_end(data, i, name)?,
            }
        }
    }

    /// The tagged field for a `<v>` value, the way calamine's `read_v` reads it.
    fn value(&mut self, v: &[u8], style: Option<&[u8]>, typ: Option<&[u8]>) -> Result<(), String> {
        let field = &mut self.field;
        field.clear();
        // calamine reads these types from a single text node: an empty `<v>` is an empty cell.
        if v.is_empty() && matches!(typ, None | Some(b"n" | b"s" | b"b" | b"e")) {
            return Ok(());
        }
        let utf8 = |v: &[u8]| std::str::from_utf8(v).map(str::to_string).map_err(|_| "Invalid UTF-8 in a cell".to_string());
        match typ {
            Some(b"s") => {
                if v.is_empty() {
                    return Ok(());
                }
                let idx = parse_u32(v).unwrap_or(0) as usize;
                let s = self.reader.strings.get(idx).ok_or("Cell string index not found in shared strings table")?;
                field.push('s');
                field.push_str(s);
            }
            Some(b"b") => field.push_str(if v != b"0" { "bTRUE" } else { "bFALSE" }),
            Some(b"d") => {
                field.push('d');
                decode_into(v, field);
            }
            Some(b"e") => {
                field.push('e');
                field.push_str(&utf8(v)?);
            }
            Some(b"str") => {
                field.push('s');
                decode_into(v, field);
            }
            Some(b"n") | None => {
                if v.is_empty() {
                    return Ok(());
                }
                let text = std::str::from_utf8(v).map_err(|_| "Invalid UTF-8 in a cell".to_string())?;
                match text.parse::<f64>() {
                    Ok(n) => {
                        let fmt = match style {
                            Some(s) => self.reader.formats.get(parse_u32(s).unwrap_or(0) as usize).copied().unwrap_or(Fmt::Other),
                            None => Fmt::Other,
                        };
                        match fmt {
                            Fmt::Other => {
                                field.push('n');
                                push_number(n, field);
                            }
                            fmt => {
                                let kind = if fmt == Fmt::DateTime { ExcelDateTimeType::DateTime } else { ExcelDateTimeType::TimeDelta };
                                let value = DataRef::DateTime(ExcelDateTime::new(n, kind, self.reader.is_1904));
                                field.push_str(&super::typed(&value));
                            }
                        }
                    }
                    Err(_) if typ.is_none() => {
                        field.push('s');
                        field.push_str(text);
                    }
                    Err(e) => return Err(e.to_string()),
                }
            }
            Some(t) => return Err(format!("Unknown cell type {}", String::from_utf8_lossy(t))),
        }
        Ok(())
    }
}

/// Same text as `xlsx::number`, written in place.
fn push_number(f: f64, out: &mut String) {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        let _ = write!(out, "{}", f as i64);
    } else {
        let _ = write!(out, "{f}");
    }
}

/// Offset past the end tag of `name` at or after `i` (elements here don't nest).
fn skip_to_end(data: &[u8], mut i: usize, name: &[u8]) -> Result<usize, String> {
    loop {
        let p = i + memmem::find(&data[i..], b"</").ok_or("Unexpected end of sheet XML")?;
        let (tag, _, _, next) = read_tag(data, p + 2)?;
        i = next;
        if local(tag) == name {
            return Ok(i);
        }
    }
}

/// A string element (`<si>`, `<is>`): its `<t>` runs, phonetic runs skipped,
/// trimmed unless `xml:space="preserve"`, like calamine's `read_string`.
fn rich_text(data: &[u8], mut i: usize, closing: &[u8], out: &mut String) -> Result<usize, String> {
    let mut phonetic = false;
    loop {
        let at = i + memchr(b'<', &data[i..]).ok_or("Unexpected end of string")? + 1;
        if data.get(at) == Some(&b'/') {
            let (name, _, _, next) = read_tag(data, at + 1)?;
            i = next;
            match local(name) {
                n if n == closing => return Ok(i),
                b"rPh" => phonetic = false,
                _ => {}
            }
            continue;
        }
        let (name, attrs, self_closing, next) = read_tag(data, at)?;
        i = next;
        match local(name) {
            b"rPh" if !self_closing => phonetic = true,
            b"t" if !self_closing => {
                let end = i + memmem::find(&data[i..], b"</").ok_or("Unexpected end of string")?;
                let preserve = attr(attrs, b"xml:space") == Some(b"preserve");
                if !phonetic {
                    let mut value = String::new();
                    text_content(&data[i..end], &mut value);
                    let value = if preserve { value.as_str() } else { value.trim_matches([' ', '\t', '\r', '\n']) };
                    unescape_x(value, out);
                }
                i = skip_to_end(data, end, b"t")?;
            }
            _ => {}
        }
    }
}

/// Element text with entities decoded; CDATA sections kept as they are.
fn text_content(raw: &[u8], out: &mut String) {
    let mut rest = raw;
    while let Some(i) = memmem::find(rest, b"<![CDATA[") {
        decode_into(&rest[..i], out);
        let body = &rest[i + 9..];
        let end = memmem::find(body, b"]]>").unwrap_or(body.len());
        out.push_str(&String::from_utf8_lossy(&body[..end]));
        rest = &body[(end + 3).min(body.len())..];
    }
    decode_into(rest, out);
}

/// Decodes XML entities (`&amp;`, `&#10;`, …) into `out`.
fn decode_into(raw: &[u8], out: &mut String) {
    let text = String::from_utf8_lossy(raw);
    let mut rest: &str = &text;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let Some(semi) = after.find(';').filter(|&s| s <= 10) else {
            out.push('&');
            rest = after;
            continue;
        };
        let ent = &after[..semi];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if ent.starts_with("#x") || ent.starts_with("#X") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
            _ if ent.starts_with('#') => ent[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
}

fn decode(raw: &[u8]) -> String {
    let mut s = String::new();
    decode_into(raw, &mut s);
    s
}

/// Excel's `_x00HH_` escapes, like calamine's `unescape_xml`.
fn unescape_x(s: &str, out: &mut String) {
    if !s.contains("_x00") {
        out.push_str(s);
        return;
    }
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if i + 7 <= b.len() && &b[i..i + 4] == b"_x00" && b[i + 6] == b'_' {
            if let Some(v) = std::str::from_utf8(&b[i + 4..i + 6]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v as char);
                i += 7;
                continue;
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
}

/// Value of attribute `name` (exact name, e.g. `r` or `xml:space`).
fn attr<'a>(attrs: &'a [u8], name: &[u8]) -> Option<&'a [u8]> {
    find_attr(attrs, |key| key == name)
}

/// Value of an attribute by local name, ignoring its prefix (`r:id`).
fn attr_local<'a>(attrs: &'a [u8], name: &[u8]) -> Option<&'a [u8]> {
    find_attr(attrs, |key| local(key) == name && key != name)
}

fn find_attr<'a>(attrs: &'a [u8], want: impl Fn(&[u8]) -> bool) -> Option<&'a [u8]> {
    let mut i = 0;
    while i < attrs.len() {
        while i < attrs.len() && attrs[i].is_ascii_whitespace() {
            i += 1;
        }
        let eq = i + memchr(b'=', &attrs[i..])?;
        let key = attrs[i..eq].trim_ascii();
        let mut q = eq + 1;
        while q < attrs.len() && attrs[q].is_ascii_whitespace() {
            q += 1;
        }
        let quote = *attrs.get(q)?;
        if quote != b'"' && quote != b'\'' {
            return None;
        }
        let end = q + 1 + memchr(quote, &attrs[q + 1..])?;
        if want(key) {
            return Some(&attrs[q + 1..end]);
        }
        i = end + 1;
    }
    None
}

fn parse_u32(b: &[u8]) -> Result<u32, String> {
    if b.is_empty() || b.len() > 10 {
        return Err("Invalid number".into());
    }
    let mut n: u64 = 0;
    for &d in b {
        if !d.is_ascii_digit() {
            return Err("Invalid number".into());
        }
        n = n * 10 + (d - b'0') as u64;
    }
    u32::try_from(n).map_err(|_| "Invalid number".into())
}

/// `B12` → (row 11, col 1); a reference without a row (`B`) has no row.
fn cell_ref(r: &[u8]) -> Result<(Option<u32>, u32), String> {
    let letters = r.iter().take_while(|b| b.is_ascii_alphabetic()).count();
    if letters == 0 {
        return Err("Invalid cell reference".into());
    }
    let mut col: u32 = 0;
    for &c in &r[..letters] {
        col = col * 26 + (c.to_ascii_uppercase() - b'A' + 1) as u32;
    }
    let row = if letters == r.len() { None } else { Some(parse_u32(&r[letters..])?.checked_sub(1).ok_or("Invalid row number")?) };
    Ok((row, col - 1))
}

/// Start tags named `name` (any prefix): their attribute bytes.
fn tags<'a>(xml: &'a [u8], name: &'a [u8]) -> impl Iterator<Item = &'a [u8]> + 'a {
    let mut i = 0;
    std::iter::from_fn(move || {
        while let Some(p) = memchr(b'<', &xml[i..]) {
            let at = i + p + 1;
            i = at;
            if matches!(xml.get(at), Some(b'/' | b'?' | b'!')) {
                continue;
            }
            let Ok((tag, attrs, _, next)) = read_tag(xml, at) else { return None };
            i = next;
            if local(tag) == name {
                return Some(attrs);
            }
        }
        None
    })
}

/// Relationships as (Id, Type, Target).
fn rels(xml: &[u8]) -> Vec<(String, String, String)> {
    tags(xml, b"Relationship")
        .map(|a| {
            let get = |k: &[u8]| attr(a, k).map(decode).unwrap_or_default();
            (get(b"Id"), get(b"Type"), get(b"Target"))
        })
        .collect()
}

fn shared_strings(xml: &[u8]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(p) = memchr(b'<', &xml[i..]) {
        let at = i + p + 1;
        i = at;
        if matches!(xml.get(at), Some(b'/' | b'?' | b'!')) {
            continue;
        }
        let (tag, _, closing, next) = read_tag(xml, at)?;
        i = next;
        if local(tag) == b"si" {
            let mut s = String::new();
            if !closing {
                i = rich_text(xml, i, b"si", &mut s)?;
            }
            out.push(s);
        }
    }
    Ok(out)
}

/// Number format of each cell style (`cellXfs`), as calamine's `read_styles` decides it.
fn styles(xml: &[u8]) -> Vec<Fmt> {
    let mut custom: HashMap<Vec<u8>, String> = HashMap::new();
    // Only the `numFmts` list counts (differential formats have their own `numFmt`s).
    let fmts = memmem::find(xml, b"numFmts").map_or(&xml[..0], |s| {
        let e = memmem::find(&xml[s + 7..], b"numFmts").map_or(xml.len(), |e| s + 7 + e);
        &xml[s..e]
    });
    for a in tags(fmts, b"numFmt") {
        if let (Some(id), Some(code)) = (attr(a, b"numFmtId"), attr(a, b"formatCode")) {
            custom.insert(id.to_vec(), decode(code));
        }
    }
    let Some(start) = memmem::find(xml, b"<cellXfs").or_else(|| memmem::find(xml, b":cellXfs")) else { return Vec::new() };
    let end = memmem::find(&xml[start..], b"/cellXfs").map_or(xml.len(), |e| start + e);
    tags(&xml[start..end], b"xf")
        .map(|a| match attr(a, b"numFmtId") {
            None => Fmt::Other,
            Some(id) => match custom.get(id) {
                Some(code) => custom_format(code),
                None => builtin_format(id),
            },
        })
        .collect()
}

/// calamine's `builtin_format_by_id`.
fn builtin_format(id: &[u8]) -> Fmt {
    match id {
        b"14" | b"15" | b"16" | b"17" | b"18" | b"19" | b"20" | b"21" | b"22" | b"45" | b"47" => Fmt::DateTime,
        b"46" => Fmt::TimeDelta,
        _ => Fmt::Other,
    }
}

/// calamine's `detect_custom_number_format` (MIT, Johann Tuffe), ported as is.
fn custom_format(format: &str) -> Fmt {
    let mut escaped = false;
    let mut is_quote = false;
    let mut brackets = 0u8;
    let mut prev = ' ';
    let mut hms = false;
    let mut ap = false;
    for s in format.chars() {
        match (s, escaped, is_quote, ap, brackets) {
            (_, true, ..) => escaped = false,
            ('_' | '\\' | '*', ..) => escaped = true,
            ('"', _, true, _, _) => is_quote = false,
            (_, _, true, _, _) => (),
            ('"', _, _, _, _) => is_quote = true,
            (';', ..) => return Fmt::Other,
            ('[', ..) => brackets += 1,
            (']', .., 1) if hms => return Fmt::TimeDelta,
            (']', ..) => brackets = brackets.saturating_sub(1),
            ('a' | 'A', _, _, false, 0) => ap = true,
            ('p' | 'm' | '/' | 'P' | 'M', _, _, true, 0) => return Fmt::DateTime,
            ('d' | 'm' | 'h' | 'y' | 's' | 'D' | 'M' | 'H' | 'Y' | 'S', _, _, false, 0) => return Fmt::DateTime,
            _ => {
                if !(hms && s.eq_ignore_ascii_case(&prev)) {
                    hms = prev == '[' && matches!(s, 'm' | 'h' | 's' | 'M' | 'H' | 'S');
                }
            }
        }
        prev = s;
    }
    Fmt::Other
}
