//! Edits JSON files through the JSON view's path commands (and the table),
//! saves, and compares the result. Usage: cargo run --example json_edit_check -- <scratch dir>
use std::path::{Path, PathBuf};

use bigview_lib::core::session::{CellChange, Session};
use bigview_lib::formats::{self, json::{JsonSource, TreeEdit}};
use serde_json::{json, Value};

fn open(path: &Path) -> Session {
    let s = Session::new(path.to_path_buf(), formats::open(path, &Default::default()).unwrap());
    s.source.build_index(&|_| {});
    s.finish_indexing();
    s
}

fn edit(s: &Session, e: TreeEdit) {
    let src = s.source.clone();
    let json = src.as_any().downcast_ref::<JsonSource>().unwrap();
    s.edit(|l| json.tree_edit(l, e)).unwrap();
}

fn try_edit(s: &Session, e: TreeEdit) -> Result<(), String> {
    let src = s.source.clone();
    let json = src.as_any().downcast_ref::<JsonSource>().unwrap();
    s.edit(|l| json.tree_edit(l, e)).map(|_| ())
}

fn children(s: &Session, path: &[u64]) -> String {
    let src = s.source.clone();
    let json = src.as_any().downcast_ref::<JsonSource>().unwrap();
    let c = s.with_edits(|e| json.tree_children(e, path, 0, 100)).unwrap();
    serde_json::to_string(&c).unwrap()
}

fn save_and_check(s: &Session, dir: &Path, name: &str, want: Value) -> String {
    let out = dir.join(name);
    s.save(&out, &|_, _| {}).unwrap();
    let text = std::fs::read_to_string(&out).unwrap();
    println!("--- {name}\n{text}");
    let got: Value = if name.ends_with(".jsonl") {
        Value::Array(text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect())
    } else {
        serde_json::from_str(&text).unwrap()
    };
    assert_eq!(got, want, "{name}");
    text
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("usage: json_edit_check <dir>"));
    std::fs::create_dir_all(&dir).unwrap();
    use TreeEdit::*;

    // Wrapped: rows under "data" with members around them.
    let p = dir.join("wrapped.json");
    std::fs::write(&p, "{\n  \"meta\": {\"v\": 1},\n  \"data\": [\n    {\"a\": 1, \"b\": \"x\"},\n    {\"a\": 2, \"b\": \"y\"}\n  ],\n  \"count\": 2\n}\n").unwrap();
    let s = open(&p);
    println!("root children: {}", children(&s, &[]));
    edit(&s, Set { path: vec![1, 0, 0], text: "10".into() });
    edit(&s, Rename { path: vec![1, 1, 1], key: "c".into() });
    edit(&s, Insert { parent: vec![], index: 0, key: Some("first".into()), text: "true".into() });
    edit(&s, Set { path: vec![3], text: "3".into() });
    edit(&s, Set { path: vec![1, 0], text: "hello world".into() }); // not JSON: stored as a string
    edit(&s, Insert { parent: vec![2], index: 2, key: None, text: "{\"a\": 3}".into() });
    edit(&s, Insert { parent: vec![1], index: 1, key: Some("w".into()), text: "[1, 2]".into() });
    edit(&s, Insert { parent: vec![1, 1], index: 2, key: None, text: "3".into() });
    assert!(try_edit(&s, Delete { path: vec![2] }).is_err(), "rows array can't be deleted");
    assert!(try_edit(&s, Rename { path: vec![3], key: "meta".into() }).is_err(), "duplicate key refused");
    // Table edits show in the tree, and tree edits in the table.
    s.set_cells(vec![CellChange { row: 1, col: 0, value: "20".into() }]).unwrap();
    assert_eq!(s.read_rows(0, 1)[0][0], "10");
    println!("rows: {}", children(&s, &[2]));
    let want = json!({"first": true, "meta": {"v": "hello world", "w": [1, 2, 3]}, "data": [{"a": 10, "b": "x"}, {"a": 20, "c": "y"}, {"a": 3}], "count": 3});
    let text = save_and_check(&s, &dir, "wrapped.out.json", want);
    assert!(text.contains("\n    {\"a\": 10, \"b\": \"x\"},\n"), "formatting kept");
    edit(&s, Delete { path: vec![2, 0] });
    edit(&s, Delete { path: vec![0] });
    save_and_check(&s, &dir, "wrapped.out2.json", json!({"meta": {"v": "hello world", "w": [1, 2, 3]}, "data": [{"a": 20, "c": "y"}, {"a": 3}], "count": 3}));
    while s.view_state().can_undo {
        s.edit(|e| Ok(e.undo())).unwrap();
    }
    assert!(s.with_edits(|e| e.is_pristine()), "undo returns to the file");

    // JSON Lines.
    let p = dir.join("lines.jsonl");
    std::fs::write(&p, "{\"id\": 1, \"tags\": [\"a\"]}\n{\"id\": 2, \"tags\": []}\n").unwrap();
    let s = open(&p);
    edit(&s, Insert { parent: vec![1, 1], index: 0, key: None, text: "\"b\"".into() });
    edit(&s, Insert { parent: vec![], index: 0, key: None, text: "{\n  \"id\": 0\n}".into() });
    edit(&s, Insert { parent: vec![1], index: 2, key: Some("x".into()), text: "null".into() });
    edit(&s, Delete { path: vec![2, 0] });
    let text = save_and_check(&s, &dir, "lines.out.jsonl", json!([{"id": 0}, {"id": 1, "tags": ["a"], "x": null}, {"tags": ["b"]}]));
    assert_eq!(text.lines().count(), 3, "records stay on one line");

    // A plain object: key/value rows.
    let p = dir.join("members.json");
    std::fs::write(&p, "{\"x\": 1, \"y\": {\"z\": [1, 2]}}").unwrap();
    let s = open(&p);
    edit(&s, Insert { parent: vec![1, 0], index: 0, key: None, text: "0".into() });
    edit(&s, Rename { path: vec![0], key: "xx".into() });
    edit(&s, Insert { parent: vec![], index: 2, key: Some("n".into()), text: "{}".into() });
    edit(&s, Insert { parent: vec![2], index: 0, key: Some("k".into()), text: "\"v\"".into() });
    save_and_check(&s, &dir, "members.out.json", json!({"xx": 1, "y": {"z": [0, 1, 2]}, "n": {"k": "v"}}));
    println!("OK");
}
