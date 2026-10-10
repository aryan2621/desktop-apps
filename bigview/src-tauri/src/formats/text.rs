//! Text encodings for CSV and JSON.
//!
//! ASCII-compatible encodings (UTF-8, Windows-125x, Shift_JIS, GBK, EUC-KR)
//! keep delimiters, quotes and newlines as single ASCII bytes, so files are
//! indexed as they are and only cells are decoded. UTF-16 isn't, so it is
//! converted to a UTF-8 cache on open and converted back on save.

use std::borrow::Cow;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use encoding_rs::{CoderResult, Encoding, UTF_16BE, UTF_16LE, UTF_8};

/// Encodings offered in the UI, by their WHATWG names.
pub const OFFERED: &[&str] = &[
    "UTF-8",
    "UTF-16LE",
    "UTF-16BE",
    "windows-1252",
    "windows-1251",
    "windows-1250",
    "ISO-8859-2",
    "Shift_JIS",
    "GBK",
    "Big5",
    "EUC-KR",
];

pub fn by_name(name: &str) -> Result<&'static Encoding, String> {
    Encoding::for_label(name.as_bytes()).ok_or_else(|| format!("Unknown encoding {name}"))
}

/// Encoding from the byte-order mark, else UTF-8 when the start of the file
/// is valid UTF-8, else Windows-1252 (what Excel on Windows writes).
pub fn detect(data: &[u8]) -> &'static Encoding {
    if let Some((enc, _)) = Encoding::for_bom(data) {
        return enc;
    }
    let sample = &data[..data.len().min(1 << 20)];
    match std::str::from_utf8(sample) {
        Ok(_) => UTF_8,
        // A character cut off at the end of the sample is still UTF-8.
        Err(e) if e.error_len().is_none() => UTF_8,
        Err(_) => encoding_rs::WINDOWS_1252,
    }
}

pub fn is_utf16(enc: &'static Encoding) -> bool {
    enc == UTF_16LE || enc == UTF_16BE
}

/// Cell text from file bytes. UTF-16 files are read from their UTF-8 copy.
pub fn decode(enc: &'static Encoding, bytes: &[u8]) -> String {
    if enc == UTF_8 || is_utf16(enc) {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    enc.decode_without_bom_handling(bytes).0.into_owned()
}

/// Bytes for `text` in `enc`, or an error naming a character it can't hold.
pub fn encode<'a>(enc: &'static Encoding, text: &'a str) -> Result<Cow<'a, [u8]>, String> {
    if enc == UTF_8 || is_utf16(enc) {
        // UTF-16 files are edited as UTF-8 and converted on save.
        return Ok(Cow::Borrowed(text.as_bytes()));
    }
    let (bytes, _, had_errors) = enc.encode(text);
    if had_errors {
        let bad = text.chars().find(|c| enc.encode(&c.to_string()).2).unwrap_or('?');
        return Err(format!("“{bad}” can't be stored in {} text; change the file's encoding to UTF-8 first", enc.name()));
    }
    Ok(bytes)
}

/// Converts a UTF-16 file to a UTF-8 cache file (without BOM) and returns its path.
pub fn utf16_to_cache(path: &Path, enc: &'static Encoding) -> Result<PathBuf, String> {
    let cache = cache_path("utf8");
    let mut input = BufReader::with_capacity(1 << 20, File::open(path).map_err(|e| e.to_string())?);
    let mut out = BufWriter::with_capacity(1 << 20, File::create(&cache).map_err(|e| e.to_string())?);
    let mut decoder = enc.new_decoder_with_bom_removal();
    let mut src = vec![0u8; 1 << 20];
    let mut dst = vec![0u8; (3 << 20) + 16];
    loop {
        let n = input.read(&mut src).map_err(|e| e.to_string())?;
        let last = n == 0;
        let mut read = 0;
        loop {
            let (result, r, w, _) = decoder.decode_to_utf8(&src[read..n], &mut dst, last);
            out.write_all(&dst[..w]).map_err(|e| e.to_string())?;
            read += r;
            if result == CoderResult::InputEmpty {
                break;
            }
        }
        if last {
            break;
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    Ok(cache)
}

/// Rewrites the UTF-8 file at `path` as UTF-16 (with BOM) in place.
pub fn utf8_file_to_utf16(path: &Path, enc: &'static Encoding) -> Result<(), String> {
    let tmp = path.with_extension("utf16-tmp");
    {
        let mut text = String::new();
        let mut input = BufReader::with_capacity(1 << 20, File::open(path).map_err(|e| e.to_string())?);
        let mut out = BufWriter::with_capacity(1 << 20, File::create(&tmp).map_err(|e| e.to_string())?);
        let big_endian = enc == UTF_16BE;
        out.write_all(if big_endian { &[0xFE, 0xFF] } else { &[0xFF, 0xFE] }).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 1 << 20];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            let n = input.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            carry.extend_from_slice(&buf[..n]);
            // Convert whole characters only; keep a split one for the next chunk.
            let valid = match std::str::from_utf8(&carry) {
                Ok(_) => carry.len(),
                Err(e) => e.valid_up_to(),
            };
            text.clear();
            text.push_str(std::str::from_utf8(&carry[..valid]).unwrap());
            let mut bytes = Vec::with_capacity(text.len() * 2);
            for unit in text.encode_utf16() {
                bytes.extend_from_slice(&if big_endian { unit.to_be_bytes() } else { unit.to_le_bytes() });
            }
            out.write_all(&bytes).map_err(|e| e.to_string())?;
            carry.drain(..valid);
        }
        out.flush().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Cache files are named `<pid>-<n>.<ext>`. Each process holds a lock on
/// `<pid>.lock` while it runs, so files whose owner's lock is free were left
/// behind by a crash or force quit.
pub fn cache_path(ext: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = cache_dir();
    claim_cache_dir();
    dir.join(format!("{}-{}.{ext}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)))
}

/// Creates and locks this process's `<pid>.lock` (once).
fn claim_cache_dir() {
    static CLAIM: OnceLock<Option<File>> = OnceLock::new();
    CLAIM.get_or_init(|| {
        let dir = cache_dir();
        std::fs::create_dir_all(&dir).ok()?;
        let lock = File::create(dir.join(format!("{}.lock", std::process::id()))).ok()?;
        lock.try_lock().ok()?;
        Some(lock)
    });
}

/// Deletes cache files of BigView processes that are no longer running.
/// Returns how many files and bytes were removed.
pub fn clean_stale_cache() -> (usize, u64) {
    claim_cache_dir();
    let dir = cache_dir();
    let me = std::process::id().to_string();
    let Ok(entries) = std::fs::read_dir(&dir) else { return (0, 0) };
    let mut live: HashMap<String, bool> = HashMap::new();
    let mut stale: Vec<(PathBuf, String)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let owner = name.split(['-', '.']).next().unwrap_or_default().to_string();
        if owner == me {
            continue;
        }
        let alive = *live.entry(owner.clone()).or_insert_with(|| owner_running(&dir, &owner));
        if !alive {
            stale.push((entry.path(), name));
        }
    }
    // Lock files go last, after the data files they vouched for.
    stale.sort_by_key(|(_, name)| name.ends_with(".lock"));
    let (mut files, mut bytes) = (0, 0);
    for (path, _) in stale {
        let size = std::fs::metadata(&path).map_or(0, |m| m.len());
        if std::fs::remove_file(&path).is_ok() {
            files += 1;
            bytes += size;
        }
    }
    (files, bytes)
}

/// Whether the process that owns `<owner>.lock` still holds it.
fn owner_running(dir: &Path, owner: &str) -> bool {
    match File::open(dir.join(format!("{owner}.lock"))) {
        Ok(f) => match f.try_lock() {
            Ok(()) => false,
            Err(std::fs::TryLockError::WouldBlock) => true,
            // Can't tell: keep the files.
            Err(_) => true,
        },
        // No lock file: left by an older version, or long gone.
        Err(_) => false,
    }
}

pub fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("bigview-cache")
}
