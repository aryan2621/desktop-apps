//! Headless check of Save As conversion, view export, sheet splitting, save
//! cancel, editing while a file is still loading, and stale cache cleanup.
//! Usage: cargo run --example export_check -- <scratch dir>
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use bigview_lib::core::edits::ColDef;
use bigview_lib::core::export::ExportFormat;
use bigview_lib::core::filter::{Filter, FilterKind};
use bigview_lib::core::session::{CellChange, Session};
use bigview_lib::core::sort::SortKey;
use bigview_lib::core::view::{Task, ViewSpec};
use bigview_lib::formats;
use calamine::{open_workbook, Data, Reader, Xlsx};
use serde_json::{json, Value};

fn open(path: &Path) -> Session {
    let s = Session::new(path.to_path_buf(), formats::open(path, &Default::default()).unwrap());
    s.source.build_index(&|_| {});
    s.finish_indexing();
    s
}

fn save(s: &Session, dest: &Path, format: ExportFormat, view_only: bool) -> bigview_lib::core::export::SaveSummary {
    s.save_as(dest, Some(format), view_only, &AtomicBool::new(false), &|_, _| {}).unwrap()
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn read_jsonl(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap();
    Value::Array(text.lines().map(|l| serde_json::from_str(l).unwrap()).collect())
}

fn sheet(path: &Path, name: &str) -> Vec<Vec<Data>> {
    let mut book: Xlsx<_> = open_workbook(path).unwrap();
    book.worksheet_range(name).unwrap().rows().map(|r| r.to_vec()).collect()
}

fn csv_to_others(dir: &Path) {
    let src = dir.join("typed.csv");
    std::fs::write(
        &src,
        "id,name,amount,flag,zip,blank,big\n1,Alice,12.5,true,00123,,12345678901234567890\n2,Bob,-3,FALSE,94107,x,2024-01-05\n",
    )
    .unwrap();
    let s = open(&src);
    s.set_cells(vec![CellChange { row: 1, col: 1, value: "Bobby".into() }]).unwrap();
    s.edit(|e| e.insert_rows(2, 1).map(|_| ())).unwrap();
    s.set_cells(vec![CellChange { row: 2, col: 0, value: "3".into() }]).unwrap();
    s.edit_columns(|defs, new_key| {
        defs.insert(2, ColDef { key: new_key(), name: "note".into() });
        Ok(())
    })
    .unwrap();
    s.set_cells(vec![CellChange { row: 0, col: 2, value: "hi".into() }]).unwrap();

    let out = dir.join("typed.json");
    save(&s, &out, ExportFormat::Json, false);
    let got = read_json(&out);
    println!("csv → json: {got}");
    assert_eq!(
        got,
        json!([
            {"id": 1, "name": "Alice", "note": "hi", "amount": 12.5, "flag": true, "zip": "00123", "blank": null, "big": "12345678901234567890"},
            {"id": 2, "name": "Bobby", "note": null, "amount": -3, "flag": false, "zip": 94107, "blank": "x", "big": "2024-01-05"},
            {"id": 3, "name": null, "note": null, "amount": null, "flag": null, "zip": null, "blank": null, "big": null},
        ])
    );
    let out = dir.join("typed.jsonl");
    save(&s, &out, ExportFormat::JsonLines, false);
    assert_eq!(read_jsonl(&out), got, "JSON Lines holds the same records");

    let out = dir.join("typed.xlsx");
    let summary = save(&s, &out, ExportFormat::Xlsx, false);
    let rows = sheet(&out, "Sheet1");
    println!("csv → xlsx: {:?} ({summary:?})", rows[1]);
    assert_eq!(rows[0][2], Data::String("note".into()));
    assert_eq!(rows[1][0], Data::Float(1.0));
    assert_eq!(rows[1][3], Data::Float(12.5));
    assert_eq!(rows[1][4], Data::Bool(true));
    assert_eq!(rows[1][5], Data::String("00123".into()));
    assert_eq!(rows[1][7], Data::String("12345678901234567890".into()));
    assert!(matches!(rows[2][7], Data::DateTime(_)), "dates become Excel dates: {:?}", rows[2][7]);
    assert_eq!(rows.len(), 4);
}

fn json_to_others(dir: &Path) {
    let src = dir.join("nested.json");
    std::fs::write(
        &src,
        r#"{"meta": 1, "data": [
  {"a": 1, "b": "x", "c": {"k": [1, 2]}, "d": null, "e": true},
  {"a": 2.50, "b": "007", "c": [], "e": false}
]}"#,
    )
    .unwrap();
    let s = open(&src);
    // A typed-in value keeps the type of the value it replaces.
    s.set_cells(vec![
        CellChange { row: 1, col: 1, value: "42".into() },
        CellChange { row: 1, col: 3, value: "7".into() },
    ])
    .unwrap();

    let out = dir.join("nested.csv");
    save(&s, &out, ExportFormat::Csv, false);
    let text = std::fs::read_to_string(&out).unwrap();
    println!("json → csv:\n{text}");
    assert_eq!(text, "a,b,c,d,e\n1,x,\"{\"\"k\"\":[1,2]}\",,true\n2.50,42,[],7,false\n");

    let out = dir.join("nested.xlsx");
    save(&s, &out, ExportFormat::Xlsx, false);
    let rows = sheet(&out, "Sheet1");
    println!("json → xlsx: {:?}", &rows[1..]);
    assert_eq!(rows[1][2], Data::String(r#"{"k":[1,2]}"#.into()));
    assert_eq!(rows[2][1], Data::String("42".into()), "a string stays a string");
    assert_eq!(rows[2][3], Data::Float(7.0));
    assert_eq!(rows[1][4], Data::Bool(true));

    let out = dir.join("nested.jsonl");
    save(&s, &out, ExportFormat::JsonLines, false);
    let got = read_jsonl(&out);
    assert_eq!(got[0], json!({"a": 1, "b": "x", "c": {"k": [1, 2]}, "d": null, "e": true}));
    assert_eq!(got[1], json!({"a": 2.50, "b": "42", "c": [], "d": 7, "e": false}));
}

fn xlsx_to_json(dir: &Path) {
    let src = dir.join("types.xlsx");
    let mut wb = rust_xlsxwriter::Workbook::new();
    let ws = wb.add_worksheet();
    for (c, h) in ["n", "s", "b", "d"].iter().enumerate() {
        ws.write_string(0, c as u16, *h).unwrap();
    }
    ws.write_number(1, 0, 3.25).unwrap();
    ws.write_string(1, 1, "007").unwrap();
    ws.write_boolean(1, 2, true).unwrap();
    let date = rust_xlsxwriter::ExcelDateTime::parse_from_str("2024-02-03").unwrap();
    ws.write_datetime_with_format(1, 3, &date, &rust_xlsxwriter::Format::new().set_num_format("yyyy-mm-dd")).unwrap();
    wb.save(&src).unwrap();
    let s = open(&src);
    let out = dir.join("types.json");
    save(&s, &out, ExportFormat::Json, false);
    let got = read_json(&out);
    println!("xlsx → json: {got}");
    assert_eq!(got, json!([{"n": 3.25, "s": "007", "b": true, "d": "2024-02-03"}]));
}

fn view_export(dir: &Path) {
    let src = dir.join("view.csv");
    let mut text = String::from("id,group\n");
    for i in 0..20_000 {
        text += &format!("{i},{}\n", if i % 3 == 0 { "a" } else { "b" });
    }
    std::fs::write(&src, text).unwrap();
    let s = open(&src);
    let spec = ViewSpec {
        sort: vec![SortKey { col: 0, desc: true }],
        filters: vec![Filter {
            col: 1,
            kind: FilterKind::Equals,
            value: "a".into(),
            value2: String::new(),
            values: Vec::new(),
            match_case: true,
        }],
    };
    s.set_view(spec, &Task::default()).unwrap();
    let out = dir.join("view.jsonl");
    let summary = save(&s, &out, ExportFormat::JsonLines, true);
    let got = read_jsonl(&out);
    println!("view export: {} rows, first {}", summary.rows, got[0]);
    assert_eq!(summary.rows, 6667);
    assert_eq!(got[0], json!({"id": 19998, "group": "a"}));
    assert_eq!(got[6666], json!({"id": 0, "group": "a"}));
}

fn split_and_cancel(dir: &Path) {
    let src = dir.join("tall.csv");
    let rows = 1_048_575 + 10;
    let mut text = String::with_capacity(rows * 8);
    text += "n\n";
    for i in 0..rows {
        text += &format!("{i}\n");
    }
    std::fs::write(&src, text).unwrap();
    let s = open(&src);

    // Cancel after the first progress report: no file, no temp file.
    let out = dir.join("tall.xlsx");
    let cancel = Arc::new(AtomicBool::new(false));
    let c = cancel.clone();
    let r = s.save_as(&out, Some(ExportFormat::Xlsx), false, &cancel, &move |_, _| c.store(true, Ordering::Relaxed));
    assert_eq!(r.unwrap_err(), "Cancelled");
    assert!(!out.exists() && !dir.join(".tall.xlsx.bigview-tmp").exists(), "cancel leaves no files");
    println!("cancel: OK");

    let t = Instant::now();
    let summary = save(&s, &out, ExportFormat::Xlsx, false);
    println!("split: {summary:?} in {:?}", t.elapsed());
    assert_eq!(summary.sheets, 2);
    let second = sheet(&out, "Sheet2");
    assert_eq!(second.len(), 11, "header + 10 rows on Sheet2");
    assert_eq!(second[1][0], Data::Float(1_048_575.0));
}

fn edit_while_loading(path: &Path) {
    let s = Arc::new(Session::new(path.to_path_buf(), formats::open(path, &Default::default()).unwrap()));
    let indexer = {
        let s = s.clone();
        std::thread::spawn(move || {
            s.source.build_index(&|_| {});
            s.finish_indexing();
        })
    };
    while s.source.row_count() < 20_000 {
        std::thread::yield_now();
    }
    let v = s.view_state();
    assert!(v.loading && v.structural, "rows can be inserted and deleted while loading");
    s.edit(|e| e.insert_rows(5, 1).map(|_| ())).unwrap();
    s.set_cells(vec![CellChange { row: 5, col: 0, value: "new".into() }]).unwrap();
    s.edit(|e| e.delete_rows(100, 10)).unwrap();
    let mid = s.view_state();
    assert!(mid.loading, "still loading after the edits ({path:?} indexed too fast to test)");
    indexer.join().unwrap();
    let src_rows = s.source.row_count();
    let v = s.view_state();
    println!("edit while loading: {src_rows} source rows, {} shown, savable {}", v.rows, v.savable);
    assert_eq!(v.rows, src_rows + 1 - 10);
    assert_eq!(s.read_rows(5, 1)[0][0], "new");
    assert_eq!(s.read_rows(6, 1), s.source.read_rows(5, 1));
    assert_eq!(s.read_rows(100, 1), s.source.read_rows(109, 1));
    assert_eq!(s.read_rows(v.rows - 1, 1), s.source.read_rows(src_rows - 1, 1), "rows that arrived later are at the end");
    // Undo back past the tail: the whole file again.
    s.edit(|e| Ok(e.undo())).unwrap();
    s.edit(|e| Ok(e.undo())).unwrap();
    s.edit(|e| Ok(e.undo())).unwrap();
    assert_eq!(s.view_state().rows, src_rows);
    assert_eq!(s.read_rows(100, 1), s.source.read_rows(100, 1));
    s.edit(|e| Ok(e.redo())).unwrap();
    s.edit(|e| Ok(e.redo())).unwrap();
    s.edit(|e| Ok(e.redo())).unwrap();
    assert_eq!(s.view_state().rows, src_rows + 1 - 10);
    assert_eq!(s.read_rows(100, 1), s.source.read_rows(109, 1));
}

fn stale_cache() {
    let dir = formats::text::cache_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let stale = dir.join("4000000001-0.csv");
    std::fs::write(&stale, "left behind").unwrap();
    let mine = formats::text::cache_path("csv");
    std::fs::write(&mine, "in use").unwrap();
    let (files, bytes) = formats::text::clean_stale_cache();
    println!("stale cache: removed {files} files, {bytes} bytes");
    assert!(!stale.exists() && mine.exists());
    let _ = std::fs::remove_file(mine);
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("usage: export_check <scratch dir>"));
    std::fs::create_dir_all(&dir).unwrap();
    csv_to_others(&dir);
    json_to_others(&dir);
    xlsx_to_json(&dir);
    view_export(&dir);
    split_and_cancel(&dir);
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/orders_1m_rows.xlsx");
    if fixture.exists() {
        edit_while_loading(&fixture);
    }
    stale_cache();
    println!("OK: export, split, cancel, edit while loading, cache cleanup");
}
