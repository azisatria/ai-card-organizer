use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::Path,
};

/// The keyword searched inside PNG tEXt / iTXt chunks to identify a character card.
pub const CHARA_KEYWORD: &str = "chara";

/// A PNG chunk header
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
struct ChunkHeader {
    length: u32,
    kind: [u8; 4],
}

// ── Helper types for v2 nested fields ─────────────────────────────────

/// TTV2 data.extensions.depth_prompt block
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[allow(dead_code)]
pub struct DepthPrompt {
    pub prompt: Option<String>,
    pub depth: Option<String>,
}

/// TTV2 data.extensions block
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[allow(dead_code)]
pub struct CardExtensions {
    pub talkativeness: Option<String>,
    pub depth_prompt: Option<DepthPrompt>,
}

/// TTV2 alternative (translated) extensions block
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[allow(dead_code)]
pub struct AltExtensions {
    pub talkativeness_alt: Option<String>,
    pub depth_prompt_alt: Option<DepthPrompt>,
}

/// TTV2 alternative / translated block
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[allow(dead_code)]
pub struct CardAlternative {
    pub name_alt: Option<String>,
    pub description_alt: Option<String>,
    pub first_mes_alt: Option<String>,
    #[serde(default)]
    pub alternate_greetings_alt: Vec<String>,
    pub personality_alt: Option<String>,
    pub scenario_alt: Option<String>,
    pub mes_example_alt: Option<String>,
    pub creator_alt: Option<String>,
    pub creator_notes_alt: Option<String>,
    pub system_prompt_alt: Option<String>,
    pub post_history_instructions_alt: Option<String>,
    pub character_version_alt: Option<String>,
    pub tags_alt: Vec<String>,
    pub extensions_alt: Option<AltExtensions>,
}

/// One card parsed from the `tEXt` / `iTXt` chunk with keyword == "chara"
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PngCharaCard {
    // ── v1 / flat fields ─────────────────────────────────────────────
    /// Alias / name displayed in the library
    pub name: String,
    pub description: Option<String>,
    pub personality: Option<String>,
    pub scenario: Option<String>,
    pub first_mes: Option<String>,
    pub mes_example: Option<String>,
    pub creator_notes: Option<String>,
    pub system_prompt: Option<String>,
    /// Also known as "summary" in the UI
    pub character_summary: Option<String>,
    pub tags: Vec<String>,
    pub creator: Option<String>,
    pub character_version: Option<String>,
    pub chara_source: Option<String>,
    /// Raw value found in the "chara" chunk (after keyword\0)
    pub raw_chunk_value: Option<String>,
    /// Arbitrary extra key/value pairs from the chunk
    pub extras: Vec<(String, String)>,
    /// PNG width × height  (from IHDR)
    pub width: u32,
    pub height: u32,

    // ── v2 extension fields ──────────────────────────────────────────
    pub talkativeness: Option<String>,
    /// Character's note / depth-prompt text
    pub character_note: Option<String>,
    /// Note depth as a string (e.g. "4")
    pub character_note_depth: Option<String>,
    /// Custom jailbreak for this character
    pub post_history_instructions: Option<String>,
    pub char_comment: Option<String>,

    // ── v2 alternate-greetings ──────────────────────────────────────
    #[serde(default)]
    pub alternate_greetings: Vec<String>,

    // ── v2 alternative (translated) block ───────────────────────────
    pub name_alt: Option<String>,
    pub description_alt: Option<String>,
    pub first_mes_alt: Option<String>,
    #[serde(default)]
    pub alternate_greetings_alt: Vec<String>,
    pub personality_alt: Option<String>,
    pub scenario_alt: Option<String>,
    pub mes_example_alt: Option<String>,
    pub creator_alt: Option<String>,
    pub creator_notes_alt: Option<String>,
    pub system_prompt_alt: Option<String>,
    pub post_history_instructions_alt: Option<String>,
    pub character_version_alt: Option<String>,
    pub tags_alt: Vec<String>,
    pub talkativeness_alt: Option<String>,
    pub character_note_alt: Option<String>,
    pub character_note_depth_alt: Option<String>,
}

fn read_u32_be(buf: &[u8], off: usize) -> Result<u32, std::io::Error> {
    if off + 4 > buf.len() {
        return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "truncated PNG chunk"));
    }
    Ok(u32::from_be_bytes(buf[off..off + 4].try_into().unwrap()))
}

fn chunk_kind(buf: &[u8], off: usize) -> Result<[u8; 4], std::io::Error> {
    if off + 4 > buf.len() {
        return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "truncated PNG chunk type"));
    }
    let mut arr = [0u8; 4];
    arr.copy_from_slice(&buf[off..off + 4]);
    Ok(arr)
}

#[allow(dead_code)]
fn is_kind(buf: &[u8], off: usize, kind: &[u8; 4]) -> bool {
    chunk_kind(buf, off).map(|k| k == *kind).unwrap_or(false)
}

fn equal_kind(arr: &[u8; 4], expected: &[u8; 4]) -> bool {
    *arr == *expected
}

const KIND_TEXT: [u8; 4] = *b"tEXt";
const KIND_ITXT: [u8; 4] = *b"iTXt";
const KIND_IHDR: [u8; 4] = *b"IHDR";

// ---------------------------------------------------------------------------
// Primary entry-point: parse a PNG file and return a PngCharaCard.
// Checks PNG signature → walks chunks → captures IHDR → scans tEXt/iTXt.
// ---------------------------------------------------------------------------
impl PngCharaCard {
    /// Parse a PNG file and return a `PngCharaCard`.
    /// Only the *first* `tEXt`/`iTXt` chunk whose keyword == "chara" is used.
    /// Reads only the beginning of the file — stops as soon as the chara chunk is found.
    /// Uses a small buffered reader and skips (seeks over) data for irrelevant chunks.
    pub fn from_file<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let f = File::open(path.as_ref()).map_err(|e| format!("failed to open file: {e}"))?;
        let mut f = BufReader::with_capacity(64 * 1024, f);

        // ── PNG signature (8 bytes) ──────────────────────────────────────
        const SIG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
        let mut sig_buf = [0u8; 8];
        f.read_exact(&mut sig_buf).map_err(|e| format!("failed to read PNG signature: {e}"))?;
        if &sig_buf[..] != &SIG {
            return Err("not a valid PNG file".into());
        }

        let mut card = PngCharaCard::default();
        let mut ihdr_done = false;

        // Read chunks one at a time — stop as soon as we find the chara chunk.
        // Each chunk: [length: u32 BE][type: 4 bytes][data: length bytes][crc: 4 bytes]
        let mut hdr_buf = [0u8; 8]; // length + type
        loop {
            match f.read_exact(&mut hdr_buf) {
                Ok(()) => {}
                Err(_) => break, // EOF or truncated
            }

            let length = u32::from_be_bytes(hdr_buf[0..4].try_into().unwrap()) as usize;
            let kind = [hdr_buf[4], hdr_buf[5], hdr_buf[6], hdr_buf[7]];

            let is_text = equal_kind(&kind, &KIND_TEXT);
            let is_itxt = equal_kind(&kind, &KIND_ITXT);
            let is_ihdr = !ihdr_done && equal_kind(&kind, &KIND_IHDR);

            if is_text || is_itxt {
                // Read the full chunk data to inspect keyword
                let mut data = vec![0u8; length];
                if f.read_exact(&mut data).is_err() { break; }
                // Skip CRC
                f.read_exact(&mut [0u8; 4]).ok();

                if is_text {
                    if let Some(null_idx) = data.iter().position(|&b| b == 0) {
                        let keyword = String::from_utf8_lossy(&data[..null_idx]).to_lowercase();
                        if keyword == CHARA_KEYWORD {
                            let decoded = decode_chara_base64(&data[null_idx + 1..])?;
                            parse_card_value(&mut card, decoded);
                            return Ok(card);
                        }
                    }
                } else {
                    // iTXt
                    if let Some(null_idx) = data.iter().position(|&b| b == 0) {
                        let keyword = String::from_utf8_lossy(&data[..null_idx]).to_lowercase();
                        if keyword == CHARA_KEYWORD {
                            let rest = &data[null_idx + 1..];
                            if let Some(text_start) = read_i_txt_text_offset(rest) {
                                let decoded = decode_chara_base64(&rest[text_start..])?;
                                parse_card_value(&mut card, decoded);
                            } else {
                                card.raw_chunk_value = Some("<iTXt chunk but text body not found>".into());
                            }
                            return Ok(card);
                        }
                    }
                }
            } else if is_ihdr && length >= 13 {
                // Read IHDR data for dimensions, then skip CRC
                let mut ihdr_buf = [0u8; 13];
                f.read_exact(&mut ihdr_buf).map_err(|e| format!("failed to read IHDR: {e}"))?;
                f.read_exact(&mut [0u8; 4]).ok(); // skip CRC
                card.width  = u32::from_be_bytes(ihdr_buf[0..4].try_into().unwrap());
                card.height = u32::from_be_bytes(ihdr_buf[4..8].try_into().unwrap());
                ihdr_done = true;
            } else {
                // Skip data + CRC for any other chunk (IDAT, PLTE, etc.)
                let skip = length as u64 + 4;
                f.seek(SeekFrom::Current(skip as i64)).ok();
            }
        }

        Err("not a valid Tavern V2 character card (no 'chara' chunk found in PNG)".into())
    }
}

// ---------------------------------------------------------------------------
// iTxt helper: skip 3 null-delimited header fields after keyword\0,
// returns the byte index where the text body starts (relative to `rest`).
// ---------------------------------------------------------------------------
fn read_i_txt_text_offset(rest: &[u8]) -> Option<usize> {
    let mut i = 0usize;
    for _ in 0..3 {
        i += rest[i..].iter().position(|&b| b == 0)?;
        i += 1;
    }
    Some(i)
}

// ---------------------------------------------------------------------------
// Decode base64-encoded chara chunk payload → UTF-8 JSON string
// ---------------------------------------------------------------------------
fn decode_chara_base64(raw: &[u8]) -> Result<String, String> {
    let b64_str = String::from_utf8_lossy(raw);
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(b64_str.trim())
        .map_err(|e| format!("failed to decode base64 chara chunk: {e}"))?;
    String::from_utf8(decoded)
        .map_err(|e| format!("chara chunk is not valid UTF-8: {e}"))
}

// ---------------------------------------------------------------------------
// Parse the raw value from the "chara" chunk.
// Priority:
//   1. JSON  →  typed fields
//   2. key=value / key: value lines  →  typed fields
fn parse_card_value(card: &mut PngCharaCard, raw: String) {
    card.raw_chunk_value = Some(raw.clone());

    let trimmed = raw.trim();

    // ── Try JSON ──────────────────────────────────────────────────────
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
        apply_json(card, val);
        return;
    }

    // ── Fallback: key = value lines ───────────────────────────────────
    for line in trimmed.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if let Some((k, v)) = line.split_once('=') {
            apply_field(card, k.trim(), v.trim().trim_matches('"'));
        } else if let Some((k, v)) = line.split_once(':') {
            apply_field(card, k.trim(), v.trim().trim_matches('"'));
        }
    }
}

fn apply_json(card: &mut PngCharaCard, val: serde_json::Value) {
    // ── TTV2 wrapper: { spec_version, data: {...}, alternative: {...} } ──────
    if let Some(obj) = val.as_object() {
        // If the top-level JSON has a "data" key, treat it as a TTV2 wrapper
        if obj.contains_key("data") {
            // Log the JSON structure for debugging
            if let Some(data_val) = obj.get("data") {
                apply_v2_data_block(card, data_val, false);
            }
            if let Some(alt_val) = obj.get("alternative") {
                apply_v2_data_block(card, alt_val, true);
            }
            // Also write any unrecognised top-level keys into extras
            for (k, v) in obj.iter() {
                if !matches!(k.as_str(), "data" | "alternative" | "spec_version" | "spec") {
                    card.extras.push((k.clone(), v.to_string()));
                }
            }
            return;
        }
    }

    // ── Flat / v1 JSON (object with key/value pairs) ────────────────────────
    let obj = match val.as_object() {
        Some(o) => o,
        _ => { card.name = val.as_str().unwrap_or_default().to_string(); return; }
    };
    for (k, v) in obj.iter() {
        apply_field(card, k.as_str(), v.as_str().unwrap_or_default());
        if let Some(arr) = v.as_array() {
            let tags: Vec<String> = arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
            if !tags.is_empty() { card.tags = tags; }
        }
    }
}

/// Extract all card fields from a v2 data/alternative JSON value.
/// `is_alt` = true  → writes to `_alt` / alt-only fields (extensions → extensions_alt)
/// `is_alt` = false → writes to primary fields
fn apply_v2_data_block(card: &mut PngCharaCard, val: &serde_json::Value, is_alt: bool) {
    let obj = match val.as_object() {
        Some(o) => o,
        _ => return,
    };

    let alt_sfx = if is_alt { "_alt" } else { "" };

    // ── Scalar string fields ────────────────────────────────────────────────
    let name_key      = format!("name{alt_sfx}");
    let desc_key      = format!("description{alt_sfx}");
    let greet_key     = format!("first_mes{alt_sfx}");
    let pers_key      = format!("personality{alt_sfx}");
    let scen_key      = format!("scenario{alt_sfx}");
    let ex_key        = format!("mes_example{alt_sfx}");
    let notes_key     = format!("creator_notes{alt_sfx}");
    let sp_key        = format!("system_prompt{alt_sfx}");
    let phi_key       = format!("post_history_instructions{alt_sfx}");
    let ver_key       = format!("character_version{alt_sfx}");

    if let Some(v) = obj.get("name").or_else(|| obj.get(&name_key)) {
        if is_alt { card.name_alt = Some(v.as_str().unwrap_or_default().to_string()); }
        else      { card.name = v.as_str().unwrap_or_default().to_string(); }
    }
    if let Some(v) = obj.get("description").or_else(|| obj.get(&desc_key)) {
        if is_alt { card.description_alt = Some(v.as_str().unwrap_or_default().to_string()); }
        else      { card.description = Some(v.as_str().unwrap_or_default().to_string()); }
    }
    if let Some(v) = obj.get("first_mes").or_else(|| obj.get(&greet_key)) {
        if is_alt { card.first_mes_alt = Some(v.as_str().unwrap_or_default().to_string()); }
        else      { card.first_mes = Some(v.as_str().unwrap_or_default().to_string()); }
    }
    if let Some(v) = obj.get("personality").or_else(|| obj.get(&pers_key)) {
        if is_alt { card.personality_alt = Some(v.as_str().unwrap_or_default().to_string()); }
        else      { card.personality = Some(v.as_str().unwrap_or_default().to_string()); }
    }
    if let Some(v) = obj.get("scenario").or_else(|| obj.get(&scen_key)) {
        if is_alt { card.scenario_alt = Some(v.as_str().unwrap_or_default().to_string()); }
        else      { card.scenario = Some(v.as_str().unwrap_or_default().to_string()); }
    }
    if let Some(v) = obj.get("mes_example").or_else(|| obj.get(&ex_key)) {
        if is_alt { card.mes_example_alt = Some(v.as_str().unwrap_or_default().to_string()); }
        else      { card.mes_example = Some(v.as_str().unwrap_or_default().to_string()); }
    }
    if let Some(v) = obj.get("creator_notes").or_else(|| obj.get(&notes_key)) {
        if is_alt { card.creator_notes_alt = Some(v.as_str().unwrap_or_default().to_string()); }
        else      { card.creator_notes = Some(v.as_str().unwrap_or_default().to_string()); }
    }
    if let Some(v) = obj.get("system_prompt").or_else(|| obj.get(&sp_key)) {
        if is_alt { card.system_prompt_alt = Some(v.as_str().unwrap_or_default().to_string()); }
        else      { card.system_prompt = Some(v.as_str().unwrap_or_default().to_string()); }
    }
    if let Some(v) = obj.get("post_history_instructions").or_else(|| obj.get(&phi_key)) {
        if is_alt { card.post_history_instructions_alt = Some(v.as_str().unwrap_or_default().to_string()); }
        else      { card.post_history_instructions = Some(v.as_str().unwrap_or_default().to_string()); }
    }
    if let Some(v) = obj.get("character_version").or_else(|| obj.get(&ver_key)) {
        if is_alt { card.character_version_alt = Some(v.as_str().unwrap_or_default().to_string()); }
        else      { card.character_version = Some(v.as_str().unwrap_or_default().to_string()); }
    }

    // ── Array fields ────────────────────────────────────────────────────────
    if let Some(v) = obj.get("tags") {
        if is_alt {
            card.tags_alt = v.as_array().unwrap_or(&vec![])
                .iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
        } else {
            card.tags = v.as_array().unwrap_or(&vec![])
                .iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
        }
    }
    if let Some(v) = obj.get("alternate_greetings") {
        if is_alt {
            card.alternate_greetings_alt = v.as_array().unwrap_or(&vec![])
                .iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
        } else {
            card.alternate_greetings = v.as_array().unwrap_or(&vec![])
                .iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
        }
    }

    // ── Nested: extensions ─────────────────────────────────────────────────
    if let Some(ext) = obj.get("extensions") {
        if let Some(ext_obj) = ext.as_object() {
            // talkativeness
            if let Some(v) = ext_obj.get("talkativeness") {
                if is_alt { card.talkativeness_alt = Some(v.as_str().unwrap_or_default().to_string()); }
                else      { card.talkativeness = Some(v.as_str().unwrap_or_default().to_string()); }
            }
            // depth_prompt
            if let Some(dp) = ext_obj.get("depth_prompt") {
                if let Some(dp_obj) = dp.as_object() {
                    let dp_prompt = dp_obj.get("prompt").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let dp_depth  = dp_obj.get("depth").and_then(|v| v.as_str()).map(|s| s.to_string());
                    if is_alt {
                        card.character_note_alt      = dp_prompt;
                        card.character_note_depth_alt        = dp_depth;
                    } else {
                        card.character_note         = dp_prompt;
                        card.character_note_depth   = dp_depth;
                    }
                }
            }
        }
    }
}

fn apply_field(card: &mut PngCharaCard, key: &str, value: &str) {
    match key.to_lowercase().as_str() {
        "name"              => card.name = value.to_string(),
        "desc" | "description" | "descriptions"
                             => card.description = Some(value.to_string()),
        "personality"        => card.personality = Some(value.to_string()),
        "scenario"           => card.scenario = Some(value.to_string()),
        "first_mes" | "firstmes" | "first message"
                             => card.first_mes = Some(value.to_string()),
        "mes_example" | "mesexample"
                             => card.mes_example = Some(value.to_string()),
        "creator_notes" | "creatornotes"
                             => card.creator_notes = Some(value.to_string()),
        "system_prompt" | "systemprompt"
                             => card.system_prompt = Some(value.to_string()),
        "tags" | "tag"       => parse_tags_field(card, value),
        "creator" | "char_creator"
                             => card.creator = Some(value.to_string()),
        "character_version" | "charaver"
                             => card.character_version = Some(value.to_string()),
        "chara_source" | "source"
                             => card.chara_source = Some(value.to_string()),
        _ => {
            if !key.trim().is_empty() {
                card.extras.push((key.to_string(), value.to_string()));
            }
        }
    }
}

fn parse_tags_field(card: &mut PngCharaCard, raw: &str) {
    let tags: Vec<String> = raw
        .split(',')
        .filter_map(|s| {
            let t = s.trim().trim_matches('"');
            if t.is_empty() { None } else { Some(t.to_string()) }
        })
        .collect();
    if !tags.is_empty() { card.tags = tags; }
}

// ---------------------------------------------------------------------------
// Read ALL raw tEXt / iTXt chunk keyword=value pairs  (for blob-export / raw inspect)
// ---------------------------------------------------------------------------
#[allow(dead_code)]
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct RawChunks {
    pub chunks: Vec<RawChunk>,
}

#[allow(dead_code)]
#[derive(Clone, Serialize, Deserialize)]
pub struct RawChunk {
    pub r#type: String,
    pub keyword: Option<String>,
    pub language: Option<String>,
    pub translated_keyword: Option<String>,
    pub text_preview: Option<String>,
}

#[allow(dead_code)]
impl RawChunks {
    pub fn from_file<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let mut f = File::open(path.as_ref()).map_err(|e| format!("failed to open file: {e}"))?;
        let mut buf: Vec<u8> = Vec::with_capacity(4 * 1024 * 1024);
        f.read_to_end(&mut buf).map_err(|e| format!("failed to read file: {e}"))?;

        const SIG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
        if buf.len() < 8 || &buf[..8] != &SIG {
            return Err("not a PNG file".into());
        }

        let mut out = RawChunks::default();
        let mut off: usize = 8;
        let mut ihdr_done = false;

        while off + 8 <= buf.len() {
            let length = read_u32_be(&buf, off).map_err(|e| format!("chunk header: {e}"))? as usize;
            let kind = chunk_kind(&buf, off + 4).map_err(|e| format!("chunk type: {e}"))?;
            let chunk_end = off + 4 + 4 + length + 4;

            if chunk_end > buf.len() { break; }

            let _kind_str = String::from_utf8_lossy(&kind).to_string();
            let data = &buf[off + 8..off + 8 + length];

            if equal_kind(&kind, &KIND_TEXT) && !ihdr_done {
                // skip IHDR block detection
            }

            if equal_kind(&kind, &KIND_IHDR) && length >= 13 {
                ihdr_done = true;
            }

            if equal_kind(&kind, &KIND_TEXT) {
                if let Some(null_idx) = data.iter().position(|&b| b == 0) {
                    let keyword = Some(String::from_utf8_lossy(&data[..null_idx]).to_string());
                    let text_preview = if null_idx + 1 < data.len() {
                        let t = String::from_utf8_lossy(&data[null_idx + 1..]).to_string();
                        Some(if t.len() > 80 { format!("{}…", &t[..80]) } else { t })
                    } else { None };
                    out.chunks.push(RawChunk {
                        r#type: "tEXt".into(),
                        keyword,
                        language: None,
                        translated_keyword: None,
                        text_preview,
                    });
                }
            } else if equal_kind(&kind, &KIND_ITXT) {
                if let Some(null_idx) = data.iter().position(|&b| b == 0) {
                    let keyword = Some(String::from_utf8_lossy(&data[..null_idx]).to_string());
                    let rest = &data[null_idx + 1..];
                    // comp-flag(1) + lang\0 + translated\0
                    let mut parts = Vec::new();
                    let mut pos = 0usize;
                    for _ in 0..3 {
                        if let Some(n) = rest[pos..].iter().position(|&b| b == 0) {
                            parts.push(String::from_utf8_lossy(&rest[pos..pos + n]).to_string());
                            pos += n + 1;
                        } else { break; }
                    }
                    let (_comp_flag, lang, trans_keyword) = match parts.as_slice() {
                        [a, b, c] => (Some(a.clone()), Some(b.clone()), Some(c.clone())),
                        _ => (None, None, None),
                    };
                    let text_preview = if pos < rest.len() {
                        let t = String::from_utf8_lossy(&rest[pos..]).to_string();
                        Some(if t.len() > 80 { format!("{}…", &t[..80]) } else { t })
                    } else { None };
                    out.chunks.push(RawChunk {
                        r#type: "iTXt".into(),
                        keyword,
                        language: lang,
                        translated_keyword: trans_keyword,
                        text_preview,
                    });
                }
            }

            off = chunk_end;
        }

        Ok(out)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialize a PngCharaCard as a Character Card v2 JSON string.
// The stored structure is:
//   { "spec":"chara_card_v2","spec_version":"2.0",
//     "data":{ "name","description","first_mes",
//              "alternate_greetings","personality","scenario","mes_example",
//              "creator","extensions","system_prompt","post_history_instructions",
//              "creator_notes","character_version","tags" },
//     "alternative":{ … _alt fields … } }
// ─────────────────────────────────────────────────────────────────────────────
pub fn card_to_chunk_value(card: &PngCharaCard) -> String {
    fn s_opt(opt: &Option<String>) -> Option<&str> { opt.as_deref() }

    let alternate_greetings: Vec<&str> = card.alternate_greetings.iter().map(|s| s.as_str()).collect();
    let alternate_greetings_alt: Vec<&str> = card.alternate_greetings_alt.iter().map(|s| s.as_str()).collect();

    let v2 = serde_json::json!({
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": card.name,
            "description": s_opt(&card.description),
            "first_mes": s_opt(&card.first_mes),
            "alternate_greetings": alternate_greetings,
            "personality": s_opt(&card.personality),
            "scenario": s_opt(&card.scenario),
            "mes_example": s_opt(&card.mes_example),
            "creator": s_opt(&card.creator),
            "extensions": {
                "talkativeness": s_opt(&card.talkativeness),
                "depth_prompt": {
                    "prompt": s_opt(&card.character_note),
                    "depth":  s_opt(&card.character_note_depth),
                }
            },
            "system_prompt": s_opt(&card.system_prompt),
            "post_history_instructions": s_opt(&card.post_history_instructions),
            "creator_notes": s_opt(&card.creator_notes),
            "character_version": s_opt(&card.character_version),
            "tags": card.tags,
        },
        "alternative": {
            "name_alt": s_opt(&card.name_alt),
            "description_alt": s_opt(&card.description_alt),
            "first_mes_alt": s_opt(&card.first_mes_alt),
            "alternate_greetings_alt": alternate_greetings_alt,
            "personality_alt": s_opt(&card.personality_alt),
            "scenario_alt": s_opt(&card.scenario_alt),
            "mes_example_alt": s_opt(&card.mes_example_alt),
            "creator_alt": s_opt(&card.creator_alt),
            "creator_notes_alt": s_opt(&card.creator_notes_alt),
            "system_prompt_alt": s_opt(&card.system_prompt_alt),
            "post_history_instructions_alt": s_opt(&card.post_history_instructions_alt),
            "character_version_alt": s_opt(&card.character_version_alt),
            "tags_alt": card.tags_alt.clone(),
            "extensions_alt": {
                "talkativeness_alt": s_opt(&card.talkativeness_alt),
                "depth_prompt_alt": {
                    "prompt_alt": s_opt(&card.character_note_alt),
                    "depth_alt":  s_opt(&card.character_note_depth_alt),
                }
            },
        },
    });

    serde_json::to_string(&v2).unwrap_or_else(|_| card.name.clone())
}

#[allow(dead_code)]
/// Rewrite `path` in-place:
///  1. Reads full  PNG bytes
///  2. Strips every  tEXt/iTXt chunk whose keyword == "chara"
///  3. Appends one fresh tEXt("chara", json_value) at the end of the data
///  4. Writes back atomically (tmp→rename)
///
/// Image chunks (IHDR, IDAT, IEND, …) are never modified; image data is 100 % unaffected.
pub fn update_png_metadata<P: AsRef<Path>>(
    path: P,
    card: &PngCharaCard,
) -> Result<(), String> {
    use std::io::{Read, Write};
    let path = path.as_ref();

    // ── 1. Read original file ──────────────────────────────────────────────
    let mut raw: Vec<u8> = Vec::new();
    File::open(path).and_then(|mut f| f.read_to_end(&mut raw))
        .map_err(|e| format!("failed to read file for writing: {e}"))?;

    // ── 2. Validate PNG signature ──────────────────────────────────────────
    const SIG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
    if raw.len() < 8 || &raw[..8] != &SIG {
        return Err("not a valid PNG file".into());
    }

    // ── 3. Pass-1: scan & strip chara chunks, build buf_without_chara ──────
    let mut off: usize = 8;            // byte offset of length(u32) of current chunk
    let mut buf_no_chara: Vec<u8> = raw[..8].to_vec(); // PNG sig
    let mut iend_bytes: Vec<u8> = Vec::new();

    while off + 8 <= raw.len() {
        let length = read_u32_be(&raw, off)
            .map_err(|e| format!("chunk header while scanning: {e}"))? as usize;
        let kind = chunk_kind(&raw, off + 4)
            .map_err(|e| format!("chunk type while scanning: {e}"))?;
        let chunk_end = off + 4 + 4 + length + 4; // length + type + data + crc
        if chunk_end > raw.len() { break; }

        let data_start = off + 4 + 4;
        let data_end = data_start + length;

        // Determine if this is a chara chunk we want to strip
        let is_target = if equal_kind(&kind, &KIND_TEXT) ||
                            equal_kind(&kind, &KIND_ITXT) {
            let chunk_data = &raw[data_start..data_end];
            chunk_data
                .iter()
                .position(|&b| b == 0)
                .map(|null_idx| {
                    String::from_utf8_lossy(&chunk_data[..null_idx])
                        .to_lowercase() == CHARA_KEYWORD
                })
                .unwrap_or(false)
        } else {
            false
        };

        let is_iend = equal_kind(&kind, &[b'I', b'E', b'N', b'D']);

        if is_iend {
            iend_bytes = raw[off..chunk_end].to_vec();
        } else if !is_target {
            // Keep this chunk — copy header, data, and CRC
            buf_no_chara.extend_from_slice(&raw[off..chunk_end]);
        }

        off = chunk_end;
    }

    // ── 4. Build new tEXt("chara", json_value) chunk ───────────────────────
    let json_val = card_to_chunk_value(card);
    let encoded = base64::engine::general_purpose::STANDARD.encode(json_val.as_bytes());
    let chunk_body: Vec<u8> = {
        let mut b: Vec<u8> = Vec::with_capacity(CHARA_KEYWORD.len() + 1 + encoded.len());
        b.extend_from_slice(CHARA_KEYWORD.as_bytes()); // "chara"
        b.push(0);                                       // null separator
        b.extend_from_slice(encoded.as_bytes());         // base64-encoded JSON
        b
    };
    let chunk_len_be = (chunk_body.len() as u32).to_be_bytes();

    // ── 5. Append new chunk to the stripped buffer ──────────────────────────
    // N_buf = 8 (sig) + Σ (4+4+data_i+4) for all preserved chunks
    // Appending: off=last_off, total=n+4+data+4, new_buf[new_off..new_off+4]=len_be, [new_off+4..new_off+8]=b"tEXt", [new_off+12..]=body+crc
    let new_off = buf_no_chara.len();          // start of new chunk (after last preserved chunk)
    let total   = new_off + 4 + 4 + chunk_body.len() + 4;
    buf_no_chara.reserve_exact(total - new_off);

    let crc_val = {
        let mut h = crc32fast::Hasher::new();
        h.update(b"tEXt");
        h.update(&chunk_body);
        h.finalize()
    };

    buf_no_chara.extend_from_slice(&chunk_len_be);   // 4B: length
    buf_no_chara.extend_from_slice(b"tEXt");         // 4B: chunk type
    buf_no_chara.extend_from_slice(&chunk_body);     // data
    buf_no_chara.extend_from_slice(&crc_val.to_be_bytes()); // CRC32(type + data)

    // IEND must always be the very last chunk
    buf_no_chara.extend_from_slice(&iend_bytes);

    // ── 6. Write back: temp file → fsync → rename (atomic on Windows) ──────
    let tmp_path = path.with_extension("tmp.png");
    let mut tmp_file = File::create(&tmp_path)
        .map_err(|e| format!("failed to create temp file: {e}"))?;
    tmp_file.write_all(&buf_no_chara)
        .map_err(|e| format!("failed to write new PNG: {e}"))?;
    tmp_file.sync_all()
        .map_err(|e| format!("failed to fsync temp: {e}"))?;
    drop(tmp_file);

    std::fs::rename(&tmp_path, path)
        .map_err(|e| format!("failed to rename temp → original: {e}"))?;

    Ok(())
}