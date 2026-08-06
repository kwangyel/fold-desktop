//! Cached resolution of external CLI binaries.
//!
//! Resolving a harness CLI is expensive: it spawns `<bin> --version` (starting
//! a Node CLI costs hundreds of milliseconds) and, when the binary is not on
//! PATH, probes *every* PATH entry the same way. Status checks run on every
//! harness refresh, so without a cache a single refresh pays that cost many
//! times over — which is what made connecting harnesses feel slow.

use std::path::PathBuf;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// How long a resolved path stays valid. Binaries don't move while we run.
const HIT_TTL: Duration = Duration::from_secs(600);
/// Misses expire slowly enough that a refresh storm doesn't re-run the full
/// PATH scan, but soon enough that a CLI installed after launch is picked up
/// without restarting. Explicit rechecks call `clear` and bypass this.
const MISS_TTL: Duration = Duration::from_secs(60);

struct Entry {
    at: Instant,
    value: Option<PathBuf>,
}

pub struct BinCache {
    slot: Mutex<Option<Entry>>,
    /// `true` while one caller is running the probe.
    probing: Mutex<bool>,
    probe_done: Condvar,
}

impl BinCache {
    pub const fn new() -> Self {
        Self {
            slot: Mutex::new(None),
            probing: Mutex::new(false),
            probe_done: Condvar::new(),
        }
    }

    /// Resolved path, running `resolve` only when there is no fresh entry.
    ///
    /// The slot lock is never held across the probe — a slow probe would
    /// otherwise block every concurrent status check, including ones whose
    /// answer is already cached. Concurrent callers still share a single run:
    /// the first claims the probe flag, the rest wait on the condvar and then
    /// read the freshly stored value.
    pub fn get(&self, resolve: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
        if let Some(value) = self.fresh() {
            return value;
        }

        let Ok(mut probing) = self.probing.lock() else {
            return resolve();
        };
        if *probing {
            // Another caller is probing: wait for it, then reuse its result.
            while *probing {
                let Ok(next) = self.probe_done.wait(probing) else {
                    return resolve();
                };
                probing = next;
            }
            drop(probing);
            return self.fresh().unwrap_or(None);
        }
        *probing = true;
        drop(probing);

        let resolved = resolve();
        if let Ok(mut slot) = self.slot.lock() {
            *slot = Some(Entry {
                at: Instant::now(),
                value: resolved.clone(),
            });
        }
        if let Ok(mut probing) = self.probing.lock() {
            *probing = false;
        }
        self.probe_done.notify_all();

        resolved
    }

    /// Drop the cached entry so the next `get` probes again. Used when the user
    /// explicitly rechecks a harness after installing its CLI.
    pub fn clear(&self) {
        if let Ok(mut slot) = self.slot.lock() {
            *slot = None;
        }
    }

    /// `Some(value)` when a non-expired entry exists, else `None`.
    fn fresh(&self) -> Option<Option<PathBuf>> {
        let slot = self.slot.lock().ok()?;
        let entry = slot.as_ref()?;
        let ttl = if entry.value.is_some() {
            HIT_TTL
        } else {
            MISS_TTL
        };
        if entry.at.elapsed() < ttl {
            Some(entry.value.clone())
        } else {
            None
        }
    }
}
