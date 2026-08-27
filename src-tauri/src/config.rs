use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::AppError;

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub path: String,
    pub icon: Option<String>,
    /// App Store category identifier (LSApplicationCategoryType), if declared
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderInfo {
    pub name: String,
    pub path: String,
    pub apps: Vec<AppInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppsResponse {
    pub apps: Vec<AppInfo>,
    pub folders: Vec<FolderInfo>,
    /// Directories that exist but failed to read in this scan (see
    /// app_discovery::Discovery)
    #[serde(rename = "unreadableDirs")]
    pub unreadable_dirs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderMetadata {
    pub id: String,
    pub name: String,
    #[serde(rename = "appPaths")]
    pub app_paths: Vec<String>,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OrderConfig {
    /// Main grid as explicit pages (the Launchpad model): each inner list
    /// is one page's items in order
    pub pages: Vec<Vec<String>>,
    pub folders: Vec<FolderMetadata>,
}

/// How the main grid presents apps
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LayoutMode {
    Scroll,
    #[default]
    Paged,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppSettings {
    pub layout: LayoutMode,
}

/// Format of the config file this build reads and writes. The file must
/// match exactly — load_config refuses any other version, and a refused
/// file is never overwritten. When the shape changes, bump this and
/// migrate the versions before it there; this one is the first.
pub(crate) const CONFIG_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub version: u32,
    pub order: OrderConfig,
    pub settings: AppSettings,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            order: OrderConfig::default(),
            settings: AppSettings::default(),
        }
    }
}

/// In-memory config snapshot: seeded by load_config, mutated by
/// update_order/set_layout, written by save_config_to_disk. Holding the
/// whole parsed config means saves never re-read the file.
pub(crate) static CONFIG_STATE: Mutex<Option<AppConfig>> = Mutex::new(None);

/// Serializes disk writes so concurrent save_order_to_disk() calls don't interleave
pub(crate) static SAVE_LOCK: Mutex<()> = Mutex::new(());

/// Get config directory: ~/Library/Application Support/com.helpermedia.wafflepad/
pub(crate) fn get_config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("com.helpermedia.wafflepad"))
}

/// Get config file path: ~/Library/Application Support/com.helpermedia.wafflepad/config.json
pub(crate) fn get_config_path() -> Option<PathBuf> {
    get_config_dir().map(|p| p.join("config.json"))
}

/// Save the in-memory config snapshot to disk (order changes ride the
/// exit-time call; settings changes save immediately). A no-op until
/// load_config has seeded the snapshot — a save can never invent a config
/// or clobber a file it hasn't read.
pub(crate) fn save_config_to_disk() -> Result<(), AppError> {
    let _save_guard = SAVE_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    // Clone and release the state lock quickly to avoid blocking updates
    let Some(config) = CONFIG_STATE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
    else {
        return Ok(()); // Nothing loaded, nothing to save
    };

    let config_dir = get_config_dir()
        .ok_or_else(|| AppError::Validation("Could not determine config directory".into()))?;

    fs::create_dir_all(&config_dir)?;

    let config_path = get_config_path()
        .ok_or_else(|| AppError::Validation("Could not determine config path".into()))?;
    let json = serde_json::to_string_pretty(&config)?;

    let tmp_path = config_path.with_extension("json.tmp");
    fs::write(&tmp_path, json)?;
    fs::rename(&tmp_path, &config_path)?;

    Ok(())
}
