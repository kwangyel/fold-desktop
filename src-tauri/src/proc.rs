//! Bounded external-process execution.
//!
//! Harness CLIs are spawned from status / catalog checks that the UI awaits.
//! A CLI that hangs (network stall, interactive prompt on a non-TTY stdin)
//! would otherwise wedge the calling command forever, so every such call goes
//! through `output_with_timeout`, which kills the child once the deadline
//! passes.

use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Completed run of a child process.
pub struct TimedOutput {
    /// Exit code, or -1 when the process was terminated by a signal.
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl TimedOutput {
    pub fn success(&self) -> bool {
        self.code == 0
    }
}

/// How often we re-check whether the child has exited.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Run `cmd` to completion, killing it and returning `Err` if it outlives
/// `timeout`. stdout / stderr are drained on background threads so a chatty
/// child cannot deadlock on a full pipe while we poll.
pub fn output_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<TimedOutput, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_reader = thread::spawn(move || drain(stdout_pipe.as_mut()));
    let stderr_reader = thread::spawn(move || drain(stderr_pipe.as_mut()));

    let deadline = Instant::now() + timeout;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("timed out after {}s", timeout.as_secs()));
                }
                thread::sleep(POLL_INTERVAL);
            }
            Err(e) => return Err(e.to_string()),
        }
    };

    Ok(TimedOutput {
        code,
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    })
}

/// Run `cmd`, discarding output, and report whether it exited successfully
/// within `timeout`. A timeout counts as failure.
pub fn status_ok_with_timeout(cmd: &mut Command, timeout: Duration) -> bool {
    output_with_timeout(cmd, timeout)
        .map(|o| o.success())
        .unwrap_or(false)
}

/// Longest we wait for a `<bin> --version` probe. Node-based CLIs take a few
/// hundred ms; anything past this is hung and not worth blocking a status
/// check on.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// Whether `<bin> <arg>` exits successfully within a short deadline. Used to
/// confirm a candidate path is really the CLI we're looking for.
pub fn probe_ok(bin: impl AsRef<std::ffi::OsStr>, arg: &str) -> bool {
    status_ok_with_timeout(Command::new(bin).arg(arg), VERSION_TIMEOUT)
}

/// Whether `<bin> --version` exits successfully within a short deadline.
pub fn version_ok(bin: impl AsRef<std::ffi::OsStr>) -> bool {
    probe_ok(bin, "--version")
}

/// `which <name>`, bounded. `None` when the lookup fails, times out, or the
/// resolved path is empty.
pub fn which(name: &str) -> Option<std::path::PathBuf> {
    let out = output_with_timeout(Command::new("which").arg(name), Duration::from_secs(3)).ok()?;
    if !out.success() {
        return None;
    }
    let path = out.stdout.trim();
    if path.is_empty() {
        None
    } else {
        Some(std::path::PathBuf::from(path))
    }
}

fn drain<R: Read>(reader: Option<&mut R>) -> String {
    let mut buf = String::new();
    if let Some(reader) = reader {
        let _ = reader.read_to_string(&mut buf);
    }
    buf
}
