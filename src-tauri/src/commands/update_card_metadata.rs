use crate::png_meta::update_png_metadata;
use crate::png_meta::{PngCharaCard};
use serde_json::Value;

// ─────────────────────────────────────────────────────────────────────────────
//  Tauri Command: update_card_metadata
// ─────────────────────────────────────────────────────────────────────────────

/// Merge flat key→value updates into an existing `PngCharaCard` loaded from disk.
///
/// # Arguments
/// - `file_path` — absolute/relative path to the target PNG.
/// - `updates`   — a JSON object whose keys match field names of `PngCharaCard`
///                 plus the extras array in `[[key, value], …]` form.
///
/// Supported field mapping
/// | Frontend key                    | PngCharaCard field          |
/// |---------------------------------|-----------------------------|
/// | `name`                          | `name`                      |
/// | `description`                   | `description`               |
/// | `personality`                   | `personality`               |
/// | `scenario`                      | `scenario`                  |
/// | `first_mes`                     | `first_mes`                 |
/// | `mes_example`                   | `mes_example`               |
/// | `creator_notes`                 | `creator_notes`             |
/// | `system_prompt`                 | `system_prompt`             |
/// | `tags` (string[])               | `tags`                      |
/// | `creator`                       | `creator`                   |
/// | `character_version`             | `character_version`         |
/// | `chara_source`                  | `chara_source`              |
/// | `extras` (obj)                  | `extras`                    |
/// | `post_history_instructions`     | `post_history_instructions` |
/// | `character_note`                | `character_note`            |
/// | `character_note_depth`          | `character_note_depth`      |
/// | `talkativeness`                 | `talkativeness`             |
/// | `alternate_greetings`           | `alternate_greetings`       |
/// | `name_alt`                      | `name_alt`                  |
/// | `description_alt`               | `description_alt`           |
/// | `first_mes_alt`                 | `first_mes_alt`             |
/// | `personality_alt`               | `personality_alt`           |
/// | `scenario_alt`                  | `scenario_alt`              |
/// | `mes_example_alt`               | `mes_example_alt`           |
/// | `creator_alt`                   | `creator_alt`               |
/// | `creator_notes_alt`             | `creator_notes_alt`         |
/// | `system_prompt_alt`             | `system_prompt_alt`         |
/// | `post_history_instructions_alt` | `post_history_instructions_alt` |
/// | `character_version_alt`         | `character_version_alt`     |
/// | `tags_alt`                      | `tags_alt`                  |
/// | `alternate_greetings_alt`       | `alternate_greetings_alt`   |
/// | `talkativeness_alt`             | `talkativeness_alt`         |
/// | `character_note_alt`            | `character_note_alt`        |
/// | `character_note_depth_alt`      | `character_note_depth_alt`  |
/// All fields not listed above are silently ignored.
///
/// # Errors
/// - `"File not found…"`       — path does not exist.
/// - `"Not a file…"`           — path points to a directory.
/// - `"failed to read metadata…"` — card could not be read from the file.
/// - `"failed to write PNG: …"` — write-back error.
#[tauri::command]
pub fn update_card_metadata(
    file_path: String,
    updates:   Value,
) -> Result<Value, String> {
    use std::path::PathBuf;

    let path = PathBuf::from(&file_path);

    // ── Pre-flight ─────────────────────────────────────────────────
    if !path.exists()    { return Err(format!("File not found: {}", file_path)); }
    if !path.is_file()   { return Err(format!("Not a file: {}", file_path)); }

    // ── Load current card from disk ─────────────────────────────────
    let mut card = PngCharaCard::from_file(&path).map_err(|e| format!("failed to read metadata: {e}"))?;

    // ── Merge updates ───────────────────────────────────────────────
    apply_updates(&mut card, updates);

    // ── Write back to PNG ───────────────────────────────────────────
    update_png_metadata(&path, &card).map_err(|e| format!("failed to write PNG: {e}"))?;

    // ── Re-serialise returned object ────────────────────────────────
    let mut val = serde_json::to_value(&card)
        .map_err(|e| format!("failed to serialize result: {e}"))?;
    if let Some(obj) = val.as_object_mut() {
        obj.insert("file_path".into(), Value::String(file_path));
        obj.insert("file_name".into(), Value::String(
            path.file_name().and_then(|s| s.to_str()).unwrap_or("").into()
        ));
        if card.raw_chunk_value.is_some() {
            obj.insert("is_character_card".into(), Value::Bool(true));
        }
    }
    Ok(val)
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn apply_updates(card: &mut PngCharaCard, upd: Value) {
    let obj = match upd.as_object() {
        Some(o) => o,
        None    => return,
    };

    for (k, v) in obj.iter() {
        let str_val = v.as_str().unwrap_or_default();
        match k.as_str() {
            // ── Primary fields ───────────────────────────────────────────────
            "name"             => card.name                = str_val.to_string(),
            "description"      => card.description         = Some(str_val.to_string()),
            "personality"      => card.personality         = Some(str_val.to_string()),
            "scenario"         => card.scenario            = Some(str_val.to_string()),
            "first_mes"        => card.first_mes            = Some(str_val.to_string()),
            "mes_example"      => card.mes_example          = Some(str_val.to_string()),
            "creator_notes"    => card.creator_notes        = Some(str_val.to_string()),
            "system_prompt"    => card.system_prompt        = Some(str_val.to_string()),
            "creator"          => card.creator              = Some(str_val.to_string()),
            "character_version"=> card.character_version    = Some(str_val.to_string()),
            "chara_source"     => card.chara_source         = Some(str_val.to_string()),
            "comment"          => card.char_comment          = Some(str_val.to_string()),

            // ── v2 extension fields ──────────────────────────────────────────
            "talkativeness"          => card.talkativeness            = Some(str_val.to_string()),
            "character_note"         => card.character_note           = Some(str_val.to_string()),
            "character_note_depth"   => card.character_note_depth     = Some(str_val.to_string()),
            "post_history_instructions"
                                     => card.post_history_instructions
                                        = Some(str_val.to_string()),

            // ── v2 alternate-greetings ───────────────────────────────────────
            "alternate_greetings" => {
                if let Some(arr) = v.as_array() {
                    card.alternate_greetings = arr
                        .iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
                }
            }

            // ── v2 alternative / translated block ───────────────────────────
            "name_alt"                   => card.name_alt                    = Some(str_val.to_string()),
            "description_alt"            => card.description_alt             = Some(str_val.to_string()),
            "first_mes_alt"              => card.first_mes_alt               = Some(str_val.to_string()),
            "personality_alt"            => card.personality_alt             = Some(str_val.to_string()),
            "scenario_alt"               => card.scenario_alt                = Some(str_val.to_string()),
            "mes_example_alt"            => card.mes_example_alt             = Some(str_val.to_string()),
            "creator_alt"                => card.creator_alt                 = Some(str_val.to_string()),
            "creator_notes_alt"          => card.creator_notes_alt           = Some(str_val.to_string()),
            "system_prompt_alt"          => card.system_prompt_alt           = Some(str_val.to_string()),
            "post_history_instructions_alt"
                                          => card.post_history_instructions_alt
                                             = Some(str_val.to_string()),
            "character_version_alt"      => card.character_version_alt       = Some(str_val.to_string()),
            "comment_alt"                => card.char_comment                = Some(str_val.to_string()),
            "tags_alt" => {
                if let Some(arr) = v.as_array() {
                    card.tags_alt = arr
                        .iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
                }
            }
            "alternate_greetings_alt" => {
                if let Some(arr) = v.as_array() {
                    card.alternate_greetings_alt = arr
                        .iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
                }
            }
            "talkativeness_alt"       => card.talkativeness_alt      = Some(str_val.to_string()),
            "character_note_alt"      => card.character_note_alt     = Some(str_val.to_string()),
            "character_note_depth_alt"
                                      => card.character_note_depth_alt = Some(str_val.to_string()),

            // ── Tags ─────────────────────────────────────────────────────────
            "tags" => {
                if let Some(arr) = v.as_array() {
                    card.tags = arr
                        .iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
                }
            }

            // ── Extras array ────────────────────────────────────────────────
            "extras" => {
                if let Some(arr) = v.as_array() {
                    card.extras = arr.iter().filter_map(|entry| {
                        entry.as_array().and_then(|a| match a.as_slice() {
                            [k, v] if k.is_string() && v.is_string() => {
                                Some((k.as_str().unwrap().to_string(), v.as_str().unwrap().to_string()))
                            }
                            _ => None,
                        })
                    }).collect();
                }
            }

            // Skip unknown top-level / flat keys (they show up as extras)
            _ => {}
        }
    }
}
