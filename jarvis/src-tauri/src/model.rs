//! One-time downloads of the two models Jarvis runs on this Mac: the Whisper speech model
//! (from the official whisper.cpp Hugging Face repo) and the built-in AI model (a GGUF file).

use anyhow::{anyhow, Context, Result};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const WHISPER_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/// The built-in AI: Qwen3 4B Instruct (2507), 4-bit. A non-thinking model, so answers start at once.
pub const BRAIN_MODEL: &str = "qwen3-4b-instruct-2507-q4_k_m";
pub const BRAIN_LABEL: &str = "Qwen3 4B";
const BRAIN_URL: &str = "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
pub const BRAIN_SIZE_MB: u32 = 2382;

pub fn model_path(dir: &Path, model: &str) -> PathBuf {
    dir.join("models").join(format!("ggml-{model}.bin"))
}

pub fn brain_path(dir: &Path) -> PathBuf {
    dir.join("models").join(format!("{BRAIN_MODEL}.gguf"))
}

/// The Whisper model's local path, downloading it first if needed.
/// `progress(downloaded, total)` is called roughly every megabyte.
pub fn ensure(dir: &Path, model: &str, progress: impl Fn(u64, u64)) -> Result<PathBuf> {
    let path = model_path(dir, model);
    download(&format!("{WHISPER_BASE_URL}/ggml-{model}.bin"), &path, progress).map_err(|e| anyhow!("Model '{model}': {e}"))?;
    Ok(path)
}

/// The AI model's local path, downloading it first if needed.
pub fn ensure_brain(dir: &Path, progress: impl Fn(u64, u64)) -> Result<PathBuf> {
    let path = brain_path(dir);
    download(BRAIN_URL, &path, progress)?;
    Ok(path)
}

/// Downloads `url` to `path` unless it's already there. Writes to a `.part` file first, so an
/// interrupted download never looks finished.
fn download(url: &str, path: &Path, progress: impl Fn(u64, u64)) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(path.parent().unwrap())?;
    let part = path.with_extension("part");

    let client = reqwest::blocking::Client::builder().timeout(None).build()?;
    let mut resp = client.get(url).send().with_context(|| format!("downloading {url}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("download failed ({})", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&part)?;
    let mut buf = vec![0u8; 256 * 1024];
    let (mut done, mut last) = (0u64, 0u64);
    loop {
        let n = resp.read(&mut buf)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        done += n as u64;
        if done - last >= 1 << 20 {
            last = done;
            progress(done, total);
        }
    }
    file.flush()?;
    if total > 0 && done != total {
        return Err(anyhow!("download incomplete ({done} of {total} bytes)"));
    }
    std::fs::rename(&part, path)?;
    progress(done, total.max(done));
    Ok(())
}
