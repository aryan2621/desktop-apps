//! Times sort, filter and column stats on a big file and checks the results.
//! Usage: cargo run --release --example bench_sort -- <file>
use std::path::PathBuf;
use std::time::Instant;

use bigview_lib::core::filter::{Filter, FilterKind};
use bigview_lib::core::session::{CellChange, Session};
use bigview_lib::core::sort::{parse_num, SortKey};
use bigview_lib::core::stats::column_stats;
use bigview_lib::core::view::{Task, ViewSpec};
use bigview_lib::formats;

fn rss_mb() -> u64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().unwrap_or(0) / 1024
}

fn col(s: &Session, name: &str) -> u32 {
    s.column_names().iter().position(|c| c == name).unwrap_or_else(|| panic!("no column {name}")) as u32
}

fn apply(s: &Session, label: &str, spec: ViewSpec) {
    let before = rss_mb();
    let t = Instant::now();
    let v = s.set_view(spec, &Task::default()).unwrap();
    println!("  {label}: {} rows in {:?} (RSS {} → {} MB)", v.rows, t.elapsed(), before, rss_mb());
}

/// Checks that shown rows `0..n` (sampled) are ordered on column `c`.
fn check_sorted(s: &Session, c: u32, desc: bool, numeric: bool) {
    let rows = s.view_state().rows;
    let step = (rows / 2000).max(1);
    let mut prev: Option<String> = None;
    for r in (0..rows).step_by(step as usize) {
        let v = s.read_rows(r, 1)[0][c as usize].clone();
        if let Some(p) = &prev {
            if !v.trim().is_empty() && !p.trim().is_empty() {
                let o = if numeric {
                    parse_num(p).unwrap().partial_cmp(&parse_num(&v).unwrap()).unwrap()
                } else {
                    p.to_ascii_lowercase().cmp(&v.to_ascii_lowercase())
                };
                let ok = if desc { o.is_ge() } else { o.is_le() };
                assert!(ok, "row {r}: {p:?} then {v:?}");
            }
        }
        prev = Some(v);
    }
}

fn main() {
    let path = PathBuf::from(std::env::args().nth(1).expect("usage: bench_sort <file>"));
    let s = Session::new(path.clone(), formats::open(&path, &Default::default()).unwrap());
    let t = Instant::now();
    s.source.build_index(&|_| {});
    s.finish_indexing();
    println!("{} ({} rows, indexed in {:?}, RSS {} MB)", path.display(), s.view_state().rows, t.elapsed(), rss_mb());
    let (amount, name, email, city) = (col(&s, "amount"), col(&s, "name"), col(&s, "email"), col(&s, "city"));

    apply(&s, "sort amount ↓", ViewSpec { sort: vec![SortKey { col: amount, desc: true }], filters: vec![] });
    check_sorted(&s, amount, true, true);
    apply(&s, "sort email ↑ (long text ties)", ViewSpec { sort: vec![SortKey { col: email, desc: false }], filters: vec![] });
    check_sorted(&s, email, false, false);
    apply(
        &s,
        "sort city ↑ then amount ↓",
        ViewSpec { sort: vec![SortKey { col: city, desc: false }, SortKey { col: amount, desc: true }], filters: vec![] },
    );
    check_sorted(&s, city, false, false);
    let f = |kind, value: &str| Filter { col: city, kind, value: value.into(), value2: String::new(), values: vec![], match_case: false };
    apply(&s, "filter city contains \"pun\"", ViewSpec { sort: vec![], filters: vec![f(FilterKind::Contains, "pun")] });
    assert!(s.read_rows(0, 1000).iter().all(|r| r[city as usize].to_lowercase().contains("pun")));
    let between = Filter { col: amount, kind: FilterKind::Between, value: "1000".into(), value2: "2000".into(), values: vec![], match_case: false };
    apply(
        &s,
        "filter city = Pune AND 1000 ≤ amount ≤ 2000, sort name",
        ViewSpec { sort: vec![SortKey { col: name, desc: false }], filters: vec![f(FilterKind::Equals, "pune"), between] },
    );
    check_sorted(&s, name, false, false);

    // Edits go through the order to the right row, and stay put until re-applied.
    let first = s.read_rows(0, 1)[0].clone();
    s.set_cells(vec![CellChange { row: 0, col: city, value: "Zzz".into() }]).unwrap();
    assert_eq!(s.read_rows(0, 1)[0][city as usize], "Zzz");
    assert_eq!(s.read_rows(0, 1)[0][0], first[0], "edited row stays in place");
    assert!(s.view_state().view_stale);
    s.edit(|e| Ok(e.undo())).unwrap();

    let t = Instant::now();
    let st = column_stats(&s, amount, &Task::default()).unwrap();
    println!("  stats amount (filtered): {} rows, sum {:?}, min {:?}, max {:?} in {:?}", st.rows, st.sum, st.min, st.max, t.elapsed());
    s.clear_view();
    for c in [amount, city] {
        let t = Instant::now();
        let st = column_stats(&s, c, &Task::default()).unwrap();
        println!(
            "  stats col {c}: distinct {}{} numeric {} top {:?} in {:?} (RSS {} MB)",
            st.distinct,
            if st.distinct_capped { "+" } else { "" },
            st.numeric,
            &st.top[..3.min(st.top.len())],
            t.elapsed(),
            rss_mb()
        );
    }
    println!("OK");
}
