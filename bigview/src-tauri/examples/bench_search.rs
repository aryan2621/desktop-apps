//! Times find over a big file and checks it sees unsaved edits.
//! Usage: cargo run --release --example bench_search -- <file>
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::time::Instant;

use bigview_lib::core::search::{Matcher, Query, SearchRun};
use bigview_lib::core::session::{CellChange, Session};
use bigview_lib::formats;

fn search(s: &Session, text: &str, match_case: bool, regex: bool, column: Option<u32>) -> Vec<u64> {
    let query = Query { text: text.into(), match_case, regex, column };
    let run = SearchRun {
        id: 1,
        matcher: Matcher::new(&query).unwrap(),
        query,
        hits: Default::default(),
        done: AtomicBool::new(false),
        cancel: AtomicBool::new(false),
        scanned: AtomicU64::new(0),
    };
    let t = Instant::now();
    s.run_search(&run);
    let hits = run.hits.lock().clone();
    println!("  {text:?} case={match_case} regex={regex} col={column:?}: {} hits in {:?}", hits.len(), t.elapsed());
    hits
}

fn main() {
    let path = PathBuf::from(std::env::args().nth(1).expect("usage: bench_search <file>"));
    let s = Session::new(path.clone(), formats::open(&path, &Default::default()).unwrap());
    s.source.build_index(&|_| {});
    s.finish_indexing();
    println!("{} ({} rows)", path.display(), s.view_state().rows);

    search(&s, "Kolkata", false, false, None);
    search(&s, "kolkata", true, false, None);
    search(&s, "rohan1234567@example.com", false, false, None);
    search(&s, r"^2026-0[1-3]-1\d$", false, true, Some(5));
    search(&s, "ZZZ-not-there", false, false, None);
    // No safe literal: every row is checked on its cells.
    search(&s, r"\d{5}\.9\d$", false, true, Some(4));
    search(&s, "then\ncall", false, false, None);

    // Unsaved edits: a new token in an edited cell, and rows deleted before it.
    s.set_cells(vec![CellChange { row: 500_000, col: 1, value: "UNIQUE-TOKEN".into() }]).unwrap();
    s.edit(|e| e.delete_rows(10, 100)).unwrap();
    let hits = search(&s, "unique-token", false, false, None);
    assert_eq!(hits, vec![500_000 - 100], "edited cell found at its shifted view row");
    let hits = search(&s, "rohan", false, false, Some(1));
    assert!(hits.iter().all(|&h| s.read_rows(h, 1)[0][1].to_lowercase().contains("rohan")));
    println!("OK: hits reflect unsaved edits and deleted rows");
}
