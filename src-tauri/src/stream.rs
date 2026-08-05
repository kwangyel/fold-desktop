//! Streaming child output to the frontend without flooding the IPC bridge.

use std::io::Read;
use std::sync::mpsc;
use std::thread;

use tauri::ipc::{Channel, InvokeResponseBody};

/// Read size. Matches the previous per-read chunk size.
const READ_BUF: usize = 8192;
/// Upper bound on a coalesced message so a firehose can't build a huge buffer.
const MAX_BATCH: usize = 256 * 1024;

/// Forward everything `reader` produces to `channel`.
///
/// Reading and sending run on separate threads with a queue between them, and
/// the sender drains whatever is already queued into a single message. A
/// process that dumps output (a build log, `cat` of a big file, a fast agent
/// stream) used to produce one IPC message per 8 KB read — thousands per
/// second, all of which the webview had to process on its main thread. Batching
/// what has *already* arrived adds no latency: when output is sparse each chunk
/// still goes out on its own.
pub fn pipe_to_channel<R: Read + Send + 'static>(mut reader: R, channel: Channel) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();

    thread::spawn(move || {
        let mut buf = [0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = first;
            while batch.len() < MAX_BATCH {
                match rx.try_recv() {
                    Ok(chunk) => batch.extend_from_slice(&chunk),
                    Err(_) => break,
                }
            }
            if channel.send(InvokeResponseBody::Raw(batch)).is_err() {
                break;
            }
        }
    });
}
