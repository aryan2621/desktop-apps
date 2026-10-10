//! Row filters: per-column conditions combined with AND, evaluated in parallel.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::session::Session;
use super::sort::parse_num;
use super::view::{RowSet, Task};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterKind {
    Contains,
    NotContains,
    Equals,
    StartsWith,
    Regex,
    /// Number comparisons; cells that aren't numbers never match.
    Eq,
    Ne,
    Gt,
    Lt,
    Between,
    Empty,
    NotEmpty,
    /// The cell is exactly one of `values`.
    OneOf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    /// View column.
    pub col: u32,
    pub kind: FilterKind,
    #[serde(default)]
    pub value: String,
    /// Upper bound for `between`.
    #[serde(default)]
    pub value2: String,
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub match_case: bool,
}

enum Test {
    Text(regex::Regex, bool),
    Num(Box<dyn Fn(f64) -> bool + Send + Sync>),
    Empty(bool),
    OneOf(HashSet<String>),
}

impl Test {
    fn matches(&self, v: &str) -> bool {
        match self {
            Test::Text(re, negate) => re.is_match(v) != *negate,
            Test::Num(f) => parse_num(v).is_some_and(f),
            Test::Empty(want) => v.trim().is_empty() == *want,
            Test::OneOf(set) => set.contains(v),
        }
    }
}

fn number(s: &str) -> Result<f64, String> {
    parse_num(s).ok_or_else(|| format!("\"{s}\" isn't a number"))
}

fn compile(f: &Filter) -> Result<Test, String> {
    use FilterKind::*;
    let text = |pattern: String, negate: bool| {
        regex::RegexBuilder::new(&pattern)
            .case_insensitive(!f.match_case)
            .build()
            .map(|re| Test::Text(re, negate))
            .map_err(|e| format!("Invalid pattern: {e}"))
    };
    let lit = regex::escape(&f.value);
    Ok(match f.kind {
        Contains => text(lit, false)?,
        NotContains => text(lit, true)?,
        Equals => text(format!("^{lit}$"), false)?,
        StartsWith => text(format!("^{lit}"), false)?,
        Regex => text(f.value.clone(), false)?,
        Eq | Ne | Gt | Lt => {
            let x = number(&f.value)?;
            Test::Num(match f.kind {
                Eq => Box::new(move |v| v == x),
                Ne => Box::new(move |v| v != x),
                Gt => Box::new(move |v| v > x),
                _ => Box::new(move |v| v < x),
            })
        }
        Between => {
            let (a, b) = (number(&f.value)?, number(&f.value2)?);
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            Test::Num(Box::new(move |v| v >= lo && v <= hi))
        }
        Empty => Test::Empty(true),
        NotEmpty => Test::Empty(false),
        OneOf => Test::OneOf(f.values.iter().cloned().collect()),
    })
}

/// Base rows (ascending) that pass every filter.
pub fn run(session: &Session, filters: &[Filter], base_rows: u64, task: &Task) -> Result<Vec<u32>, String> {
    let tests: Vec<(usize, Test)> = filters.iter().map(|f| Ok((f.col as usize, compile(f)?))).collect::<Result<_, String>>()?;
    let chunks = session.scan_map(RowSet::All(base_rows), task, |ids, cells| {
        ids.iter()
            .zip(&cells)
            .filter(|(_, row)| tests.iter().all(|(c, t)| t.matches(row.get(*c).map_or("", String::as_str))))
            .map(|(&id, _)| id)
            .collect::<Vec<u32>>()
    })?;
    Ok(chunks.concat())
}
