//! Headless check of column operations and open options on small files.
//! Usage: cargo run --example format_check -- <scratch dir>
use std::path::{Path, PathBuf};

use bigview_lib::core::edits::ColDef;
use bigview_lib::core::session::{CellChange, Session};
use bigview_lib::formats::{self, OpenOptions};

fn open(path: &Path, opts: OpenOptions) -> Session {
    let s = Session::new(path.to_path_buf(), formats::open(path, &opts).unwrap());
    s.source.build_index(&|_| {});
    s.finish_indexing();
    s
}

fn columns_round_trip(path: &Path) {
    let s = open(path, Default::default());
    // Rename "name", add "note" after it, drop "city", move "id" to the end.
    s.edit_columns(|defs, new_key| {
        defs[1].name = "full_name".into();
        defs.insert(2, ColDef { key: new_key(), name: "note".into() });
        let city = defs.iter().position(|d| d.name == "city").unwrap();
        defs.remove(city);
        let id = defs.remove(0);
        defs.push(id);
        Ok(())
    })
    .unwrap();
    s.set_cells(vec![CellChange { row: 0, col: 1, value: "added".into() }]).unwrap();
    let before = s.read_rows(0, 2);
    let out = path.with_file_name(format!("cols-{}", path.file_name().unwrap().to_string_lossy()));
    s.save(&out, &|_, _| {}).unwrap();
    let r = open(&out, Default::default());
    println!("{}: {:?}", out.display(), r.column_names());
    println!("  rows: {:?}", r.read_rows(0, 2));
    assert_eq!(r.column_names(), s.column_names());
    assert_eq!(&r.column_names()[..3], ["full_name", "note", "amount"]);
    assert_eq!(r.read_rows(0, 2), before, "reopened rows match the edited view");
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).unwrap());
    std::fs::create_dir_all(&dir).unwrap();

    // Columns on CSV, JSON and Excel.
    let csv = dir.join("t.csv");
    std::fs::write(&csv, "id,name,city,amount\n1,Asha,Pune,10.5\n2,Ravi,Delhi,7\n").unwrap();
    columns_round_trip(&csv);
    let json = dir.join("t.json");
    std::fs::write(&json, r#"[{"id":1,"name":"Asha","city":"Pune","amount":10.5,"extra":true},{"id":2,"name":"Ravi","city":"Delhi","amount":7}]"#).unwrap();
    columns_round_trip(&json);
    println!("  json bytes: {}", std::fs::read_to_string(dir.join("cols-t.json")).unwrap());
    let xlsx = dir.join("t.xlsx");
    {
        let mut wb = rust_xlsxwriter::Workbook::new();
        let ws = wb.add_worksheet();
        for (c, h) in ["id", "name", "city", "amount"].iter().enumerate() {
            ws.write_string(0, c as u16, *h).unwrap();
        }
        ws.write_number(1, 0, 1.0).unwrap();
        ws.write_string(1, 1, "Asha").unwrap();
        ws.write_string(1, 2, "Pune").unwrap();
        ws.write_number(1, 3, 10.5).unwrap();
        ws.write_number(2, 0, 2.0).unwrap();
        ws.write_string(2, 1, "Ravi").unwrap();
        ws.write_string(2, 2, "Delhi").unwrap();
        ws.write_number(2, 3, 7.0).unwrap();
        wb.save(&xlsx).unwrap();
    }
    columns_round_trip(&xlsx);

    // Windows-1252: detected, decoded, edited with a character it can hold.
    let latin = dir.join("latin.csv");
    std::fs::write(&latin, b"name,city\nJos\xe9,S\xe3o Paulo\n").unwrap();
    let s = open(&latin, Default::default());
    println!("latin: {:?} {:?}", s.source.options().encoding, s.read_rows(0, 1));
    s.set_cells(vec![CellChange { row: 0, col: 0, value: "Zoë".into() }]).unwrap();
    let err = s.set_cells(vec![CellChange { row: 0, col: 0, value: "日本".into() }]).unwrap_err();
    println!("  rejects: {err}");
    let out = dir.join("latin-saved.csv");
    s.save(&out, &|_, _| {}).unwrap();
    assert_eq!(std::fs::read(&out).unwrap(), b"name,city\nZo\xeb,S\xe3o Paulo\n");

    // UTF-16 LE with BOM: read through a UTF-8 copy, saved back as UTF-16.
    let wide = dir.join("wide.csv");
    let mut bytes = vec![0xFF, 0xFE];
    for u in "name;city\r\nAnaïs;Lyon\r\n".encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    std::fs::write(&wide, &bytes).unwrap();
    let s = open(&wide, Default::default());
    println!("utf16: {:?} delimiter {:?} {:?}", s.source.options().encoding, s.source.options().delimiter, s.read_rows(0, 1));
    s.set_cells(vec![CellChange { row: 0, col: 1, value: "Zürich".into() }]).unwrap();
    let out = dir.join("wide-saved.csv");
    s.save(&out, &|_, _| {}).unwrap();
    let saved = std::fs::read(&out).unwrap();
    let units: Vec<u16> = saved[2..].chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    let text = String::from_utf16(&units).unwrap();
    println!("  saved utf16: {text:?}");
    assert_eq!(&saved[..2], &[0xFF, 0xFE]);
    assert_eq!(text, "name;city\r\nAnaïs;Zürich\r\n");

    // No header row: every line is data and stays data after saving.
    let s = open(&csv, OpenOptions { has_header: Some(false), ..Default::default() });
    println!("headerless: {:?} {:?}", s.column_names(), s.read_rows(0, 1));
    assert_eq!(s.view_state().rows, 3);
    println!("OK");
}
