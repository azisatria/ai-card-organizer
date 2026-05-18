use base64::Engine;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

const PNG_SIG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const KIND_TEXT: [u8; 4] = *b"tEXt";
const KIND_ITXT: [u8; 4] = *b"iTXt";
const KIND_IEND: [u8; 4] = *b"IEND";
const CHARA_KEYWORD: &str = "chara";

fn read_u32_be(buf: &[u8], off: usize) -> Result<u32, String> {
    if off + 4 > buf.len() {
        return Err("truncated PNG".into());
    }
    Ok(u32::from_be_bytes(buf[off..off + 4].try_into().unwrap()))
}

fn chunk_kind(buf: &[u8], off: usize) -> Result<[u8; 4], String> {
    if off + 4 > buf.len() {
        return Err("truncated PNG".into());
    }
    let mut arr = [0u8; 4];
    arr.copy_from_slice(&buf[off..off + 4]);
    Ok(arr)
}

fn equal_kind(a: &[u8; 4], b: &[u8; 4]) -> bool {
    *a == *b
}

fn crc32(type_bytes: &[u8], data: &[u8]) -> u32 {
    let mut h = crc32fast::Hasher::new();
    h.update(type_bytes);
    h.update(data);
    h.finalize()
}

/// Check whether a tEXt/iTXt chunk has the "chara" keyword.
fn is_chara_chunk(buf: &[u8], off: usize, length: u32) -> bool {
    let data_start = off + 8;
    let data_end = data_start + length as usize;
    if data_end > buf.len() {
        return false;
    }
    let data = &buf[data_start..data_end];
    if let Some(null_idx) = data.iter().position(|&b| b == 0) {
        String::from_utf8_lossy(&data[..null_idx]).to_lowercase() == CHARA_KEYWORD
    } else {
        false
    }
}

/// Replace the image data in a Tavern V2 character card PNG while preserving
/// the chara metadata chunk.
///
/// # Arguments
/// - `file_path` — path to the original character card PNG.
/// - `new_image_path` — path to the replacement image (any format the `png` crate can decode).
///
/// # How it works
/// 1. Decode the new image to raw RGBA pixels.
/// 2. Re-encode it as a fresh PNG (IHDR + IDAT + IEND) using the `png` crate.
/// 3. Read the original PNG, extract the chara tEXt/iTXt chunk.
/// 4. Splice the new image chunks in place of the old IHDR/IDAT/IEND chunks,
///    then append the chara chunk + IEND.
/// 5. Write back atomically (tmp → rename).
#[tauri::command]
pub fn replace_card_image(
    file_path: String,
    new_image_path: String,
) -> Result<(), String> {
    let src_path = Path::new(&new_image_path);
    if !src_path.exists() {
        return Err(format!("Image file not found: {}", new_image_path));
    }

    // ── 1. Decode the new image ────────────────────────────────────────────
    let new_img_data = {
        let decoder = png::Decoder::new(
            File::open(src_path).map_err(|e| format!("failed to open new image: {e}"))?,
        );
        let mut reader = decoder.read_info().map_err(|e| format!("failed to decode image: {e}"))?;
        let info = reader.info().clone();
        let mut buf = vec![0u8; reader.output_buffer_size()];
        let frame = reader.next_frame(&mut buf).map_err(|e| format!("failed to read pixels: {e}"))?;
        let (width, height, color_type) = (info.width, info.height, info.color_type);

        // Re-encode as PNG
        let mut out: Vec<u8> = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, width, height);
            encoder.set_color(color_type);
            encoder.set_depth(info.bit_depth);
            if let Some(palette) = info.palette.as_ref() {
                encoder.set_palette(palette.clone());
            }
            if let Some(trns) = info.trns.as_ref() {
                encoder.set_trns(trns.clone());
            }
            let mut writer = encoder.write_header().map_err(|e| format!("failed to encode header: {e}"))?;
            writer.write_image_data(&buf[..frame.buffer_size()])
                .map_err(|e| format!("failed to encode pixels: {e}"))?;
        }
        out
    };

    // ── 2. Parse new image PNG to extract IHDR + IDAT chunks ────────────────
    if new_img_data.len() < 8 || &new_img_data[..8] != &PNG_SIG {
        return Err("New image is not a valid PNG".into());
    }

    let mut new_chunks: Vec<(Vec<u8>, Vec<u8>)> = Vec::new(); // (type, data) pairs
    let mut new_iend: Vec<u8> = Vec::new();
    {
        let mut off: usize = 8;
        while off + 8 <= new_img_data.len() {
            let length = read_u32_be(&new_img_data, off).unwrap_or(0) as usize;
            let kind = chunk_kind(&new_img_data, off + 4).unwrap_or([0; 4]);
            let chunk_end = off + 12 + length;
            if chunk_end > new_img_data.len() {
                break;
            }

            let data = new_img_data[off + 8..off + 8 + length].to_vec();
            let kind_bytes = kind.to_vec();

            if equal_kind(&kind, &KIND_IEND) {
                new_iend = new_img_data[off..chunk_end].to_vec();
            } else {
                new_chunks.push((kind_bytes, data));
            }

            off = chunk_end;
        }
    }

    if new_iend.is_empty() {
        return Err("New image is missing IEND chunk".into());
    }

    // ── 3. Read original PNG ────────────────────────────────────────────────
    let mut orig: Vec<u8> = Vec::new();
    File::open(&file_path)
        .and_then(|mut f| f.read_to_end(&mut orig))
        .map_err(|e| format!("failed to open original file: {e}"))?;

    if orig.len() < 8 || &orig[..8] != &PNG_SIG {
        return Err("Original file is not a valid PNG".into());
    }

    // ── 4. Extract chara chunk from original ────────────────────────────────
    let mut chara_chunk: Option<Vec<u8>> = None;
    {
        let mut off: usize = 8;
        while off + 8 <= orig.len() {
            let length = read_u32_be(&orig, off).unwrap_or(0) as usize;
            let kind = chunk_kind(&orig, off + 4).unwrap_or([0; 4]);
            let chunk_end = off + 12 + length;
            if chunk_end > orig.len() {
                break;
            }

            if (equal_kind(&kind, &KIND_TEXT) || equal_kind(&kind, &KIND_ITXT))
                && is_chara_chunk(&orig, off, length as u32)
            {
                chara_chunk = Some(orig[off..chunk_end].to_vec());
                break;
            }

            off = chunk_end;
        }
    }

    // ── 5. Build output PNG ─────────────────────────────────────────────────
    let mut out: Vec<u8> = PNG_SIG.to_vec();

    // Write new image chunks (IHDR, IDAT, etc.)
    for (kind, data) in &new_chunks {
        let len_be = (data.len() as u32).to_be_bytes();
        out.extend_from_slice(&len_be);
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let crc_val = crc32(kind, data);
        out.extend_from_slice(&crc_val.to_be_bytes());
    }

    // Append chara chunk if it existed
    if let Some(ref chunk) = chara_chunk {
        out.extend_from_slice(chunk);
    }

    // IEND must be last
    out.extend_from_slice(&new_iend);

    // ── 6. Write back atomically ────────────────────────────────────────────
    let tmp_path = Path::new(&file_path).with_extension("tmp.png");
    {
        let mut tmp_file = File::create(&tmp_path)
            .map_err(|e| format!("failed to create temp file: {e}"))?;
        tmp_file.write_all(&out)
            .map_err(|e| format!("failed to write PNG: {e}"))?;
        tmp_file.sync_all()
            .map_err(|e| format!("failed to fsync: {e}"))?;
    }
    std::fs::rename(&tmp_path, &file_path)
        .map_err(|e| format!("failed to rename: {e}"))?;

    Ok(())
}

/// Write a base64 data URI to a temporary PNG file and return the path.
/// Used by the frontend to stage a new image before calling `replace_card_image`.
#[tauri::command]
pub fn write_temp_image(data_uri: String) -> Result<String, String> {
    // Parse data URI: "data:image/png;base64,...."
    let base64_part = data_uri
        .split(',')
        .nth(1)
        .ok_or("Invalid data URI format")?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_part)
        .map_err(|e| format!("base64 decode error: {e}"))?;

    let dir = std::env::temp_dir();
    let path = dir.join(format!("card_edit_{}.png", std::process::id()));

    std::fs::write(&path, &bytes)
        .map_err(|e| format!("failed to write temp image: {e}"))?;

    Ok(path.to_string_lossy().to_string())
}

/// Delete a temporary file.
#[tauri::command]
pub fn delete_temp_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path)
        .map_err(|e| format!("failed to delete temp file: {e}"))
}
