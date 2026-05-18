use crate::png_meta::PngCharaCard;
use rayon::prelude::*;
use serde::Serialize;
use std::path::PathBuf;
use std::fs;

#[derive(Debug, Clone, Serialize, Default)]
pub struct ScanResult {
    /// cards found directly in the scanned folder (non-recursive)
    pub flat_cards: Vec<serde_json::Value>,
    /// cards found in sub-directories, each entry tagged with its subfolder name
    pub subfolder_cards: Vec<SubfolderResult>,
    /// total PNG files encountered (all levels)
    pub total_pngs: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SubfolderResult {
    pub folder_name: String,
    pub cards: Vec<serde_json::Value>,
}

fn parse_png(path: &PathBuf) -> Option<serde_json::Value> {
    match PngCharaCard::from_file(path) {
        Ok(card) => {
            let mut v = serde_json::to_value(&card).ok()?;
            if let Some(obj) = v.as_object_mut() {
                obj.insert("file_path".into(), serde_json::Value::String(path.to_string_lossy().into()));
                obj.insert("file_name".into(), serde_json::Value::String(
                    path.file_name().and_then(|s| s.to_str()).unwrap_or("").into()
                ));
            }
            Some(v)
        }
        Err(_) => None,
    }
}

/// Collect all PNG file paths in `path` up to `depth` levels deep.
fn collect_png_paths(path: &PathBuf, depth: usize) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    let entries = match fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => return paths,
    };

    for entry in entries {
        let entry = match entry { Ok(e) => e, Err(_) => continue };
        let p = entry.path();

        if p.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("png"))
            .unwrap_or(false)
        {
            paths.push(p);
        } else if depth > 0 && p.is_dir() {
            paths.extend(collect_png_paths(&p, depth - 1));
        }
    }

    paths
}

/// Scan a folder (non-recursive by default; pass depth >=1 to recurse).
pub fn scan_folder_command(folder: &str, recursive: bool) -> ScanResult {
    let mut result = ScanResult::default();

    let root = PathBuf::from(folder);
    if !root.is_dir() {
        return result;
    }

    let depth = if recursive { 10 } else { 0 };

    // ── scan root (non-recursive: only direct children) ─────────────────────
    let flat_paths = collect_png_paths(&root, 0);
    result.total_pngs += flat_paths.len();
    result.flat_cards = flat_paths
        .par_iter()
        .filter_map(|p| parse_png(p))
        .collect();

    // ── scan each direct sub-folder ─────────────────────────────────────────
    if depth > 0 {
        let sub_dirs: Vec<PathBuf> = match fs::read_dir(&root) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect(),
            Err(_) => return result,
        };

        let sub_results: Vec<(SubfolderResult, usize)> = sub_dirs
            .par_iter()
            .map(|p| {
                let folder_name = p.file_name().and_then(|s| s.to_str()).unwrap_or("?").to_string();
                let sub_paths = collect_png_paths(p, depth - 1);
                let sub_pngs = sub_paths.len();
                let sub_cards: Vec<serde_json::Value> = sub_paths
                    .par_iter()
                    .filter_map(|pp| parse_png(pp))
                    .collect();
                (
                    SubfolderResult {
                        folder_name,
                        cards: sub_cards,
                    },
                    sub_pngs,
                )
            })
            .collect();

        for (sr, png_count) in sub_results {
            result.total_pngs += png_count;
            if !sr.cards.is_empty() {
                result.subfolder_cards.push(sr);
            }
        }
    }

    result
}
