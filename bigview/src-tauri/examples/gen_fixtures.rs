//! Generates large test files.
//! Usage: cargo run --release --example gen_fixtures -- <out_dir> [size_mb] [csv|json|jsonl|wrapped|xlsx ...]
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

const CITIES: [&str; 8] = ["Delhi", "Mumbai", "Bengaluru", "Chennai", "Kolkata", "Pune", "Hyderabad", "Jaipur"];
const NAMES: [&str; 8] = ["Aarav", "Diya", "Ishaan", "Meera", "Kabir", "Anaya", "Rohan", "Saanvi"];

struct Order {
    id: u64,
    name: &'static str,
    email: String,
    city: &'static str,
    amount: f64,
    date: String,
    /// Every 1000th row has a comma and a line break, to test quoting.
    notes: &'static str,
}

fn orders() -> impl Iterator<Item = Order> {
    let mut seed = 0x9E3779B97F4A7C15u64;
    (0u64..).map(move |id| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let name = NAMES[(seed % 8) as usize];
        Order {
            id,
            name,
            email: format!("{}{id}@example.com", name.to_lowercase()),
            city: CITIES[(seed >> 8) as usize % 8],
            amount: (seed % 10_000_000) as f64 / 100.0,
            date: format!("2026-{:02}-{:02}", seed % 12 + 1, seed % 28 + 1),
            notes: if id % 1000 == 0 { "follow up, then\ncall back" } else { "ok" },
        }
    })
}

fn json_record(o: &Order) -> String {
    format!(
        r#"{{"id": {}, "name": "{}", "email": "{}", "city": "{}", "amount": {}, "date": "{}", "notes": {}, "tags": ["new", "web"]}}"#,
        o.id, o.name, o.email, o.city, o.amount, o.date, serde_json::to_string(o.notes).unwrap()
    )
}

fn write_text(path: &Path, target: u64, head: &str, sep: &str, tail: &str, line: impl Fn(&Order) -> String) {
    let mut w = BufWriter::with_capacity(1 << 20, File::create(path).unwrap());
    w.write_all(head.as_bytes()).unwrap();
    let mut written = head.len() as u64;
    let mut rows = 0;
    for o in orders() {
        if written >= target {
            break;
        }
        if rows > 0 {
            w.write_all(sep.as_bytes()).unwrap();
        }
        let l = line(&o);
        w.write_all(l.as_bytes()).unwrap();
        written += (l.len() + sep.len()) as u64;
        rows += 1;
    }
    w.write_all(tail.as_bytes()).unwrap();
    w.flush().unwrap();
    println!("{} ({rows} rows)", path.display());
}

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().expect("usage: gen_fixtures <out_dir> [size_mb] [kinds...]"));
    let size_mb: u64 = args.next().map(|s| s.parse().unwrap()).unwrap_or(1024);
    let mut kinds: Vec<String> = args.collect();
    if kinds.is_empty() {
        kinds = ["csv", "json", "jsonl", "wrapped", "xlsx"].map(String::from).to_vec();
    }
    std::fs::create_dir_all(&dir).unwrap();
    let target = size_mb << 20;

    for kind in kinds {
        let path = dir.join(match kind.as_str() {
            "csv" => format!("orders_{size_mb}mb.csv"),
            "json" => format!("orders_{size_mb}mb.json"),
            "jsonl" => format!("orders_{size_mb}mb.jsonl"),
            "wrapped" => format!("orders_wrapped_{size_mb}mb.json"),
            "xlsx" if size_mb == 0 => "orders_1m_rows.xlsx".into(),
            "xlsx" => format!("orders_wide_{size_mb}mb.xlsx"),
            other => panic!("unknown kind {other}"),
        });
        match kind.as_str() {
            "csv" => write_text(&path, target, "id,name,email,city,amount,date,notes\n", "", "", |o| {
                let notes = if o.notes.contains(',') { format!("\"{}\"", o.notes) } else { o.notes.into() };
                format!("{},{},{},{},{:.2},{},{}\n", o.id, o.name, o.email, o.city, o.amount, o.date, notes)
            }),
            "json" => write_text(&path, target, "[\n  ", ",\n  ", "\n]\n", json_record),
            "jsonl" => write_text(&path, target, "", "\n", "\n", json_record),
            "wrapped" => write_text(
                &path,
                target,
                "{\"meta\": {\"source\": \"export\", \"tags\": [\"a\", \"b\"]}, \"data\": [",
                ",",
                "], \"count\": null}",
                json_record,
            ),
            "xlsx" => write_xlsx(&path, size_mb),
            _ => unreachable!(),
        }
    }
}

/// One million rows (Excel's limit is 1,048,576) plus a small second sheet.
/// With `size_mb > 0`, extra columns of hard-to-compress values are added
/// until the file is about that size, since rows can't grow past the limit.
fn write_xlsx(path: &Path, size_mb: u64) {
    let extra = if size_mb == 0 {
        0
    } else {
        // Calibrate: bytes per extra cell from a small sample.
        let sample = path.with_extension("calibrate.xlsx");
        build_xlsx(&sample, 20_000, 40);
        let base = std::fs::metadata(&sample).unwrap().len() as f64;
        build_xlsx(&sample, 20_000, 0);
        let plain = std::fs::metadata(&sample).unwrap().len() as f64;
        std::fs::remove_file(&sample).unwrap();
        let per_cell = (base - plain) / (20_000.0 * 40.0);
        let per_row_plain = plain / 20_000.0;
        let target_per_row = (size_mb << 20) as f64 / 1_000_000.0;
        ((target_per_row - per_row_plain) / per_cell).max(0.0) as u16
    };
    build_xlsx(path, 1_000_000, extra);
    println!("{} (1000000 rows, {} columns)", path.display(), 7 + extra as u32);
}

fn build_xlsx(path: &Path, rows: usize, extra: u16) {
    use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};
    let mut wb = Workbook::new();
    wb.use_zip_large_file(true);
    let date = Format::new().set_num_format("yyyy-mm-dd");
    let ws = wb.add_worksheet_with_constant_memory();
    ws.set_name("Orders").unwrap();
    for (c, h) in ["id", "name", "email", "city", "amount", "date", "paid"].iter().enumerate() {
        ws.write_string(0, c as u16, *h).unwrap();
    }
    for c in 0..extra {
        ws.write_string(0, 7 + c, format!("field_{}", c + 1)).unwrap();
    }
    let mut seed = 0x2545F4914F6CDD1Du64;
    for o in orders().take(rows) {
        let r = o.id as u32 + 1;
        ws.write_number(r, 0, o.id as f64).unwrap();
        ws.write_string(r, 1, o.name).unwrap();
        ws.write_string(r, 2, &o.email).unwrap();
        ws.write_string(r, 3, o.city).unwrap();
        ws.write_number(r, 4, o.amount).unwrap();
        ws.write_datetime_with_format(r, 5, ExcelDateTime::parse_from_str(&o.date).unwrap(), &date).unwrap();
        ws.write_boolean(r, 6, o.id % 3 == 0).unwrap();
        for c in 0..extra {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            // Alternate random codes and numbers, which compress poorly, like real exports.
            if c % 2 == 0 {
                ws.write_string(r, 7 + c, format!("{:012x}", seed >> 16)).unwrap();
            } else {
                ws.write_number(r, 7 + c, (seed % 100_000_000) as f64 / 100.0).unwrap();
            }
        }
    }
    let summary = wb.add_worksheet_with_constant_memory();
    summary.set_name("Summary").unwrap();
    summary.write_string(0, 0, "rows").unwrap();
    summary.write_number(0, 1, rows as f64).unwrap();
    wb.save(path).unwrap();
}
