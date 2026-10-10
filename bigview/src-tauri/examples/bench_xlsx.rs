//! Times reading an Excel sheet: calamine's cell iteration alone, then the
//! full read into BigView's cache. Usage: cargo run --release --example bench_xlsx -- <file.xlsx> [--raw]
use std::path::PathBuf;
use std::time::Instant;

use bigview_lib::formats;
use calamine::{open_workbook, DataRef, Reader, Xlsx};

fn main() {
    let path = PathBuf::from(std::env::args().nth(1).expect("usage: bench_xlsx <file.xlsx> [--raw]"));
    if std::env::args().any(|a| a == "--inflate") {
        use std::io::Read;
        let t = Instant::now();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        let mut entry = zip.by_name("xl/worksheets/sheet1.xml").unwrap();
        let mut buf = vec![0u8; 1 << 20];
        let mut total = 0usize;
        loop {
            let n = entry.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            total += n;
        }
        println!("inflate only: {total} bytes in {:?}", t.elapsed());
    }
    if std::env::args().any(|a| a == "--raw") {
        let t = Instant::now();
        let mut book: Xlsx<_> = open_workbook(&path).unwrap();
        let sheet = book.sheet_names()[0].clone();
        let mut reader = book.worksheet_cells_reader(&sheet).unwrap();
        let (mut cells, mut bytes) = (0u64, 0usize);
        while let Some(cell) = reader.next_cell().unwrap() {
            cells += 1;
            match cell.get_value() {
                DataRef::String(s) => bytes += s.len(),
                DataRef::SharedString(s) => bytes += s.len(),
                _ => {}
            }
        }
        println!("calamine only: {cells} cells ({bytes} string bytes) in {:?}", t.elapsed());
    }
    if std::env::args().any(|a| a == "--compare") {
        compare(&path);
        return;
    }
    let t = Instant::now();
    let source = formats::open(&path, &Default::default()).unwrap();
    println!("open: {:?}", t.elapsed());
    source.build_index(&|_| {});
    println!("full read: {} rows in {:?} (error: {:?})", source.row_count(), t.elapsed(), source.index_error());
    println!("row 1: {:?}", &source.read_rows(1, 1)[0][..6]);
}

/// `--compare`: the fast reader and calamine must give the same rows.
#[allow(dead_code)]
fn compare(path: &std::path::Path) {
    let read = |calamine: bool| {
        if calamine { std::env::set_var("BIGVIEW_XLSX_CALAMINE", "1") } else { std::env::remove_var("BIGVIEW_XLSX_CALAMINE") }
        let s = formats::open(path, &Default::default()).unwrap();
        s.build_index(&|_| {});
        let mut all = Vec::new();
        let mut at = 0;
        while at < s.row_count() { all.extend(s.read_rows(at, 10_000)); at += 10_000; }
        all
    };
    let (a, b) = (read(false), read(true));
    assert_eq!(a.len(), b.len(), "row counts");
    for (i, (x, y)) in a.iter().zip(&b).enumerate() { assert_eq!(x, y, "row {i}"); }
    println!("compare: {} rows identical to calamine", a.len());
}
