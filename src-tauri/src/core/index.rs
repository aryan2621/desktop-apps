use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use parking_lot::RwLock;

/// Byte offsets of row starts, built incrementally by a background scan.
///
/// `offsets[i]..offsets[i + 1]` is row `i`, so a row only becomes readable
/// once the start of the following row (or the end-of-data sentinel) is known.
pub struct RowIndex {
    offsets: RwLock<Vec<u64>>,
    work_done: AtomicU64,
    done: AtomicBool,
    cancelled: AtomicBool,
}

/// Rows are published to readers in batches of this size to keep lock traffic low.
const PUBLISH_EVERY: usize = 64 * 1024;

impl RowIndex {
    pub fn new(data_start: u64) -> Self {
        Self {
            offsets: RwLock::new(vec![data_start]),
            work_done: AtomicU64::new(data_start),
            done: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
        }
    }

    pub fn row_count(&self) -> u64 {
        (self.offsets.read().len() - 1) as u64
    }

    pub fn work_done(&self) -> u64 {
        self.work_done.load(Ordering::Relaxed)
    }

    pub fn is_done(&self) -> bool {
        self.done.load(Ordering::Acquire)
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// Byte range covering rows `start..start + count`, clamped to indexed rows.
    pub fn span(&self, start: u64, count: u64) -> Option<(u64, u64, u64)> {
        let offsets = self.offsets.read();
        let rows = (offsets.len() - 1) as u64;
        if start >= rows || count == 0 {
            return None;
        }
        let end = (start + count).min(rows);
        Some((offsets[start as usize], offsets[end as usize], end - start))
    }

    /// Copies the offsets for rows `start..start + count` plus the end of the last row.
    pub fn row_bounds(&self, start: u64, count: u64) -> Vec<u64> {
        let offsets = self.offsets.read();
        let rows = (offsets.len() - 1) as u64;
        if start >= rows {
            return Vec::new();
        }
        let end = (start + count).min(rows);
        offsets[start as usize..=end as usize].to_vec()
    }

    pub fn writer(&self) -> IndexWriter<'_> {
        IndexWriter {
            index: self,
            pending: Vec::with_capacity(PUBLISH_EVERY),
        }
    }
}

pub struct IndexWriter<'a> {
    index: &'a RowIndex,
    pending: Vec<u64>,
}

impl IndexWriter<'_> {
    /// Records that a new row starts at `offset`. Returns true when a batch was
    /// published, which is a good moment to report progress and check cancellation.
    #[inline]
    pub fn push(&mut self, offset: u64) -> bool {
        self.pending.push(offset);
        if self.pending.len() >= PUBLISH_EVERY {
            self.publish(offset);
            return true;
        }
        false
    }

    /// Makes pending rows readable; `work_done` feeds progress reporting.
    pub fn publish(&mut self, work_done: u64) {
        if !self.pending.is_empty() {
            self.index.offsets.write().extend_from_slice(&self.pending);
            self.pending.clear();
        }
        self.index.work_done.store(work_done, Ordering::Relaxed);
    }

    /// Start of the row currently being scanned, including unpublished rows.
    pub fn last_start(&self) -> u64 {
        match self.pending.last() {
            Some(&p) => p,
            None => *self.index.offsets.read().last().unwrap(),
        }
    }

    /// Rows recorded but not yet visible to readers.
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Publishes the rest. When `close_last` is set, the bytes between the
    /// last row start and `end` become a final row.
    pub fn finish(mut self, end: u64, close_last: bool) {
        self.publish(end);
        let mut offsets = self.index.offsets.write();
        if close_last && *offsets.last().unwrap() < end {
            offsets.push(end);
        }
        offsets.shrink_to_fit();
        drop(offsets);
        self.index.done.store(true, Ordering::Release);
    }
}
