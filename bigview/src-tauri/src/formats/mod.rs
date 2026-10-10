pub mod csv;
pub mod json;
pub mod text;
pub mod xlsx;

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::core::source::DataSource;

/// How to read a file. Unset fields are detected.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOptions {
    /// Workbook sheet to show.
    pub sheet: Option<String>,
    /// Whether the first row holds column names (CSV, Excel).
    pub has_header: Option<bool>,
    /// CSV delimiter: `,`, `;`, `|` or `\t`.
    pub delimiter: Option<String>,
    /// Text encoding by WHATWG name (CSV, JSON).
    pub encoding: Option<String>,
}

/// Picks a format adapter from the file extension.
pub fn open(path: &Path, opts: &OpenOptions) -> Result<Arc<dyn DataSource>, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "csv" | "tsv" | "txt" | "" => Ok(Arc::new(csv::CsvSource::open(path, opts)?)),
        "json" | "jsonl" | "ndjson" => Ok(Arc::new(json::JsonSource::open(path, opts)?)),
        "xlsx" | "xlsm" => Ok(Arc::new(xlsx::XlsxSource::open(path, opts)?)),
        "xls" | "xlsb" | "ods" => Err("Only .xlsx workbooks are supported; save this file as .xlsx in Excel first".into()),
        other => Err(format!("Unsupported file type: .{other}")),
    }
}
