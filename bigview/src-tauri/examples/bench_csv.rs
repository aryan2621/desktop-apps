//! Headless check of the engine on a big file (any supported format): index, random reads, edits, save, reopen.
//! Usage: cargo run --release --example bench_csv -- <file>
use std::path::PathBuf;
use std::time::Instant;

use bigview_lib::core::session::{CellChange, Session};
use bigview_lib::formats;

/// Physical footprint (what Activity Monitor shows), excluding clean file-backed mmap pages.
fn footprint() -> String {
    let out = std::process::Command::new("footprint")
        .args(["-p", &std::process::id().to_string()])
        .output();
    out.ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .find(|l| l.contains("Footprint:"))
                .map(|l| l.trim().to_string())
        })
        .unwrap_or_else(|| "n/a".into())
}

fn rss_mb() -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().unwrap_or(0) / 1024
}

fn open(path: &PathBuf) -> Session {
    let t = Instant::now();
    let source = formats::open(path, &Default::default()).unwrap();
    let session = Session::new(path.clone(), source);
    let first_rows = std::sync::atomic::AtomicBool::new(false);
    session.source.build_index(&|p| {
        if !first_rows.swap(true, std::sync::atomic::Ordering::Relaxed) {
            println!("  first {} rows readable after {:?}", p.rows, t.elapsed());
        }
    });
    session.finish_indexing();
    let p = session.source.progress();
    println!("  indexed {} rows / {} MB in {:?}, RSS {} MB, {}", p.rows, session.source.file_size() >> 20, t.elapsed(), rss_mb(), footprint());
    session
}

fn main() {
    let path = PathBuf::from(std::env::args().nth(1).expect("usage: bench_csv <file.csv>"));
    println!("open {}", path.display());
    let s = open(&path);
    let rows = s.view_state().rows;

    let t = Instant::now();
    let mut seed = 12345u64;
    for _ in 0..1000 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let start = seed % rows.saturating_sub(100).max(1);
        assert_eq!(s.read_rows(start, 100).len() as u64, 100.min(rows - start));
    }
    println!("  1000 random 100-row reads: {:?} avg", t.elapsed() / 1000);
    println!("  row 0: {:?}", s.read_rows(0, 1)[0]);

    // Edits: change a cell, delete rows in the middle, insert a row at the top.
    let last_before = s.read_rows(rows - 1, 1)[0].clone();
    s.set_cells(vec![CellChange { row: 5, col: 1, value: "EDITED, with comma".into() }]).unwrap();
    s.edit(|e| e.delete_rows(10, 1000)).unwrap();
    s.edit(|e| e.insert_rows(0, 1).map(|_| ())).unwrap();
    s.set_cells(vec![CellChange { row: 0, col: 0, value: "new-row".into() }]).unwrap();
    let v = s.view_state();
    assert_eq!(v.rows, rows - 1000 + 1);
    // Undo/redo round trip.
    s.edit(|e| Ok(e.undo())).unwrap();
    s.edit(|e| Ok(e.redo())).unwrap();
    assert_eq!(s.read_rows(0, 1)[0][0], "new-row");
    assert_eq!(s.read_rows(6, 1)[0][1], "EDITED, with comma");

    let ext = path.extension().unwrap().to_string_lossy();
    let out = path.with_file_name(format!("{}.saved.{ext}", path.file_stem().unwrap().to_string_lossy()));
    let t = Instant::now();
    s.save(&out, &|_, _| {}).unwrap();
    println!("  saved to {} in {:?}", out.display(), t.elapsed());
    assert!(!s.view_state().dirty);

    println!("reopen saved file");
    let r = open(&out);
    let rv = r.view_state();
    assert_eq!(rv.rows, v.rows, "row count after save");
    assert_eq!(r.read_rows(0, 1)[0][0], "new-row");
    assert_eq!(r.read_rows(6, 1)[0][1], "EDITED, with comma");
    assert_eq!(r.read_rows(rv.rows - 1, 1)[0], last_before, "last row preserved");
    println!("  saved row 6: {:?}", r.read_rows(6, 1)[0]);
    println!("OK: edits survived the save round trip");
    if std::env::var_os("KEEP").is_none() {
        std::fs::remove_file(out).unwrap();
    }
}
