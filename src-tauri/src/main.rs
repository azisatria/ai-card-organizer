// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod png_meta;

use commands::{scan_folder_command, ScanResult};

/// Scan a folder and return metadata for every *.png card found.
/// Args: `{ path: string, recursive?: bool }`
/// Returns `ScanResult { flat_cards, subfolder_cards, total_pngs }`.
#[tauri::command]
fn scan_folder(path: String, recursive: Option<bool>) -> ScanResult {
    scan_folder_command(&path, recursive.unwrap_or(false))
}

/// Open native folder-picker dialog and return the chosen path.
#[tauri::command]
fn pick_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Select Character Card Folder")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

/// Read a single PNG file and return its character-card metadata as JSON.
///
/// Errors (returns `Err(msg)`) when:
/// - The file does not exist or is not a regular file.
/// - The file is not a valid PNG (bad signature / truncated).
/// - No `tEXt`/`iTXt` chunk with keyword `"chara"` is found → "not a Tavern V2 character card".
///
/// On success the returned JSON object contains:
/// | field | type | note |
/// |---|---|---|
/// | `name` | string | character name |
/// | `description` | string \| null | |
/// | `personality` | string \| null | |
/// | `scenario` | string \| null | |
/// | `first_mes` | string \| null | first-message |
/// | `mes_example` | string \| null | dialogue examples |
/// | `creator_notes` | string \| null | |
/// | `system_prompt` | string \| null | |
/// | `tags` | string[] | tag list |
/// | `creator` | string \| null | |
/// | `character_version` | string \| null | |
/// | `chara_source` | string \| null | source URL |
/// | `raw_chunk_value` | string \| null | raw chunk body (may be base64 JSON) |
/// | `extras` | [key, value][] | unrecognised key/value pairs |
/// | `width` / `height` | number | IHDR dimensions |
/// | `file_path` / `file_name` | string | source file info |
/// | `is_character_card` | boolean | `true` when chunk was found |
#[tauri::command]
fn get_card_metadata(file_path: String) -> Result<serde_json::Value, String> {
    commands::get_card_metadata::get_card_metadata(file_path)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            pick_folder,
            get_card_metadata,
            commands::update_card_metadata::update_card_metadata,
            commands::read_file_base64::read_file_base64,
            commands::replace_image::replace_card_image,
            commands::replace_image::write_temp_image,
            commands::replace_image::delete_temp_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
