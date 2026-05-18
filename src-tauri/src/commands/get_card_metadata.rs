use crate::png_meta::PngCharaCard;
use serde_json::Value;

/// Read a single PNG file and return its character-card metadata as a JSON value.
///
/// Looks for a `tEXt`/`iTXt` chunk whose keyword equals `"chara"` (case-insensitive).
/// The chunk body is parsed as **JSON** first, then as `key=value` lines as fallback.
///
/// # Errors
/// - `"File not found: <path>"`  — file absent or path wrong.  
/// - `"Not a file: <path>"`       — path points to a directory.  
/// - `"failed to open file: …"`   — OS could not open the file.  
/// - `"failed to read file: …"`   — read error mid-stream.  
/// - `"not a valid PNG file"`     — missing PNG magic bytes.  
/// - `"not a character card …"`   — no `chara` chunk found (not a Tavern V2 card).  
/// - `"Failed to serialize metadata: …"` — internal serialisation error.
///
/// # Returned JSON object
/// | field | type |
/// |---|---|
/// | `name` | string |
/// | `description` / `personality` / `scenario` / … | string \| null |
/// | `tags` | string\[\] |
/// | `creator` / `character_version` / `chara_source` | string \| null |
/// | `raw_chunk_value` | string \| null | raw chunk body (may be base64 JSON) |
/// | `extras` | \[key, value][\] |
/// | `width` / `height` | number |
/// | `file_path` / `file_name` | string |
/// | `is_character_card` | boolean |
pub fn get_card_metadata(file_path: String) -> Result<Value, String> {
    let path = std::path::PathBuf::from(&file_path);

    // ── Pre-flight checks ──────────────────────────────────────────────
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    if !path.is_file() {
        return Err(format!("Not a file: {}", file_path));
    }

    // ── Parse the PNG ──────────────────────────────────────────────────
    let card = PngCharaCard::from_file(&path)?;

    // ── Serialize to JSON value ────────────────────────────────────────
    let mut val = serde_json::to_value(&card)
        .map_err(|e| format!("Failed to serialize metadata: {e}"))?;

    // Enrich with file-level fields
    if let Some(obj) = val.as_object_mut() {
        obj.insert("file_path".into(), Value::String(file_path));
        obj.insert("file_name".into(), Value::String(
            path.file_name().and_then(|s| s.to_str()).unwrap_or("").into()
        ));
        // `chara` chunk found → confirmed character card
        if card.raw_chunk_value.is_some() {
            obj.insert("is_character_card".into(), Value::Bool(true));
        }
    }

    Ok(val)
}
