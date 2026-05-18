use base64::Engine;
use std::fs;
use std::path::Path;

/// Read a local file and return its contents as a base64 data URI.
/// Args: `{ file_path: string }`
/// Returns: `string` — e.g. "data:image/png;base64,iVBOR..."
#[tauri::command]
pub fn read_file_base64(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    if !path.is_file() {
        return Err(format!("Not a file: {}", file_path));
    }

    let bytes = fs::read(path).map_err(|e| format!("failed to read file: {e}"))?;

    // Determine MIME type from extension
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    };

    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}
