//! Cached resolution of external CLI binaries.
//!
//! Resolving a harness CLI is expensive: it spawns `<bin> --version` (starting
//! a Node CLI costs hundreds of milliseconds) and, when the binary is not on
//! PATH, probes *every* PATH entry the same way. Status checks run on every
//! harness refresh, so without a cache a single refresh pays that cost many
//! times over — which is what made connecting harnesses feel slow.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a resolved path stays valid. Binaries don't move while we run.
const HIT_TTL: Duration = Duration::from_secs(600);
/// Misses expire quickly so a CLI installed after launch is still picked up.
const MISS_TTL: Duration = Duration::from_secs(15);

pub struct BinCache {
    slot: Mutex<Option<(Instant, Option<PathBuf>)>>,
}

impl BinCache {
    pub const fn new() -> Self {
        Self {
            slot: Mutex::new(None),
        }
    }

    /// Resolved path, running `resolve` only when there is no fresh entry.
    /// The lock is held across the probe so concurrent callers share one run
    /// instead of each spawning their own `--version` processes.
    pub fn get(&self, resolve: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
        let Ok(mut slot) = self.slot.lock() else {
            return resolve();
        };
        if let Some((at, value)) = slot.as_ref() {
            let ttl = if value.is_some() { HIT_TTL } else { MISS_TTL };
            if at.elapsed() < ttl {
                return value.clone();
            }
        }
        let resolved = resolve();
        *slot = Some((Instant::now(), resolved.clone()));
        resolved
    }

    /// Drop the cached entry so the next `get` probes again. Used when the user
    /// explicitly rechecks a harness after installing its CLI.
    pub fn clear(&self) {
        if let Ok(mut slot) = self.slot.lock() {
            *slot = None;
        }
    }
}
