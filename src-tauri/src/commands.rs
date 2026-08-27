use rayon::prelude::*;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::app_discovery::{
    app_category, discover_apps_and_folders, get_applications_dirs, Discovery,
};
use crate::config::{
    get_config_path, AppConfig, AppInfo, AppsResponse, FolderInfo, FolderMetadata, LayoutMode,
    OrderConfig, CONFIG_STATE, CONFIG_VERSION,
};
use crate::icon_cache::{cleanup_orphaned_icons, get_icon_if_cached};
use crate::AppError;

/// Load app config from disk and seed the in-memory snapshot that all
/// later mutations and saves go through. On parse failure, or a file of
/// another format version, the snapshot stays empty, so exit-time saves
/// leave that file untouched.
#[tauri::command]
pub(crate) async fn load_config() -> Result<AppConfig, AppError> {
    let config_path = get_config_path()
        .ok_or_else(|| AppError::Validation("Could not determine config directory".into()))?;

    let config: AppConfig = if config_path.exists() {
        let contents = std::fs::read_to_string(&config_path)?;
        serde_json::from_str(&contents)?
    } else {
        AppConfig::default()
    };
    if config.version != CONFIG_VERSION {
        return Err(AppError::Validation(format!(
            "Unsupported config version {} (this build reads version {})",
            config.version, CONFIG_VERSION
        )));
    }

    *CONFIG_STATE.lock().unwrap_or_else(|p| p.into_inner()) = Some(config.clone());
    Ok(config)
}

/// Persist the layout choice immediately — unlike order (saved on exit),
/// settings changes are rare and must survive an unclean exit. A field-
/// level setter, so no other setting can be reset by a partial payload.
#[tauri::command]
pub(crate) async fn set_layout(layout: LayoutMode) -> Result<(), AppError> {
    {
        let mut state = CONFIG_STATE.lock().unwrap_or_else(|p| p.into_inner());
        let Some(config) = state.as_mut() else {
            return Err(AppError::Validation("Config not loaded".into()));
        };
        config.settings.layout = layout;
    }
    crate::config::save_config_to_disk()
}

/// Update order in memory (called on every change from frontend)
/// Disk write happens only on window close for safety
#[tauri::command]
pub(crate) fn update_order(
    pages: Vec<Vec<String>>,
    folders: Vec<FolderMetadata>,
) -> Result<(), AppError> {
    const MAX_PAGES: usize = 200;
    const MAX_MAIN_ENTRIES: usize = 1000;
    const MAX_FOLDERS: usize = 200;
    const MAX_FOLDER_APPS: usize = 500;
    const MAX_STRING_LEN: usize = 1024;

    if pages.len() > MAX_PAGES {
        return Err(AppError::Validation("Too many pages".into()));
    }
    if pages.iter().map(Vec::len).sum::<usize>() > MAX_MAIN_ENTRIES {
        return Err(AppError::Validation("Too many main entries".into()));
    }
    if folders.len() > MAX_FOLDERS {
        return Err(AppError::Validation("Too many folders".into()));
    }
    if pages.iter().flatten().any(|s| s.len() > MAX_STRING_LEN) {
        return Err(AppError::Validation("Main entry too long".into()));
    }
    for folder in &folders {
        if folder.id.len() > MAX_STRING_LEN || folder.name.len() > MAX_STRING_LEN {
            return Err(AppError::Validation("Folder field too long".into()));
        }
        if folder.app_paths.len() > MAX_FOLDER_APPS {
            return Err(AppError::Validation("Too many apps in folder".into()));
        }
        if folder.app_paths.iter().any(|s| s.len() > MAX_STRING_LEN) {
            return Err(AppError::Validation("Folder app path too long".into()));
        }
    }

    let mut state = CONFIG_STATE.lock().unwrap_or_else(|p| p.into_inner());
    let Some(config) = state.as_mut() else {
        return Err(AppError::Validation("Config not loaded".into()));
    };
    config.order = OrderConfig { pages, folders };
    Ok(())
}

/// Generate icon for a single app (called from frontend for progressive loading)
#[tauri::command]
pub(crate) async fn get_app_icon(path: String) -> Option<String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_absolute() || path_buf.extension().is_none_or(|ext| ext != "app") {
        return None;
    }

    // Check cache first
    if let Some(cached) = get_icon_if_cached(&path) {
        return Some(cached);
    }
    // Generate if not cached
    #[cfg(target_os = "macos")]
    return crate::icon_cache::generate_and_cache_icon(&path);
    #[cfg(not(target_os = "macos"))]
    None
}

/// Build the AppInfo for an .app path. Category stays None here — it only
/// feeds folder-name suggestions, so callers add it where that applies.
fn app_info_from_path(path: &std::path::Path) -> Option<AppInfo> {
    let name = path.file_stem()?.to_string_lossy().to_string();
    let path_str = path.to_string_lossy().to_string();
    let icon = get_icon_if_cached(&path_str);
    Some(AppInfo {
        name,
        path: path_str,
        category: None,
        icon,
    })
}

/// Get all apps and folders - loads icons in parallel for speed
#[tauri::command]
pub(crate) async fn get_apps(app: tauri::AppHandle) -> Result<AppsResponse, AppError> {
    let Discovery {
        apps: app_paths,
        folders: folder_data,
        unreadable,
    } = discover_apps_and_folders(&app.config().identifier);

    // Load app icons in parallel
    let mut apps: Vec<AppInfo> = app_paths
        .into_par_iter()
        .filter_map(|path| {
            let mut info = app_info_from_path(&path)?;
            // Only main-grid apps participate in folder creation
            info.category = app_category(&info.path);
            Some(info)
        })
        .collect();

    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    // Load folder icons in parallel
    let folders: Vec<FolderInfo> = folder_data
        .into_par_iter()
        .filter_map(|(folder_path, sub_app_paths)| {
            let raw_name = folder_path.file_name()?.to_string_lossy().to_string();
            let name = raw_name
                .strip_suffix(".localized")
                .unwrap_or(&raw_name)
                .to_string();
            let path_str = folder_path.to_string_lossy().to_string();

            let folder_apps: Vec<AppInfo> = sub_app_paths
                .into_par_iter()
                .filter_map(|app_path| app_info_from_path(&app_path))
                .collect();

            Some(FolderInfo {
                name,
                path: path_str,
                apps: folder_apps,
            })
        })
        .collect();

    // Clean up orphaned icon cache entries in the background
    let all_app_paths: Vec<String> = apps
        .iter()
        .map(|a| a.path.clone())
        .chain(
            folders
                .iter()
                .flat_map(|f| f.apps.iter().map(|a| a.path.clone())),
        )
        .collect();
    std::thread::spawn(move || cleanup_orphaned_icons(&all_app_paths));

    Ok(AppsResponse {
        apps,
        folders,
        unreadable_dirs: unreadable
            .iter()
            .map(|dir| dir.to_string_lossy().to_string())
            .collect(),
    })
}

/// Validate that a path is an .app bundle inside an allowed applications
/// directory — shared by all per-app actions. Deliberately does NOT
/// canonicalize: system apps like Safari are cryptex symlinks in
/// /Applications whose resolved target (/System/Volumes/Preboot/…) is
/// outside every allowed directory. Traversal is rejected lexically
/// instead, and the bundle must exist.
pub(crate) fn validated_app_path(path: &str) -> Result<PathBuf, AppError> {
    let path_buf = PathBuf::from(path);

    let lexically_clean = path_buf.is_absolute()
        && path_buf.components().all(|component| {
            matches!(
                component,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )
        });
    if !lexically_clean || path_buf.extension().is_none_or(|ext| ext != "app") {
        return Err(AppError::Validation("Invalid app path".into()));
    }

    let allowed = get_applications_dirs();
    if !allowed.iter().any(|dir| path_buf.starts_with(dir)) {
        return Err(AppError::Validation("App not in allowed directory".into()));
    }

    if !path_buf.exists() {
        return Err(AppError::Validation("App does not exist".into()));
    }

    Ok(path_buf)
}

#[tauri::command]
pub(crate) async fn launch_app(path: String) -> Result<(), AppError> {
    let validated = validated_app_path(&path)?;
    Command::new("open").arg(validated).spawn()?;
    Ok(())
}

/// Reveal the app bundle in Finder (context menu "Show in Finder").
/// Calls NSWorkspace directly: `open -R` reaches Finder via Apple Events
/// (Automation consent prompt), and the opener plugin canonicalizes first,
/// which would reveal cryptex-symlinked apps like Safari in the cryptex
/// directory instead of /Applications. Sync command: runs on the main
/// thread, which AppKit requires.
#[tauri::command]
pub(crate) fn reveal_app(path: String) -> Result<(), AppError> {
    let validated = validated_app_path(&path)?;

    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::{NSArray, NSString, NSURL};

        let url = NSURL::fileURLWithPath(&NSString::from_str(&validated.to_string_lossy()));
        let urls = NSArray::from_retained_slice(&[url]);
        NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&urls);
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = validated;
        Err(AppError::Validation("Reveal is only available on macOS".into()))
    }
}

/// Open Finder's Get Info panel for the app (context menu "Get Info").
/// Finder exposes no CLI/API for this, so it goes through AppleScript;
/// the path travels as argv rather than being spliced into the script.
/// First use triggers the macOS Automation consent prompt (→ Finder).
#[tauri::command]
pub(crate) async fn show_get_info(path: String) -> Result<(), AppError> {
    let validated = validated_app_path(&path)?;
    Command::new("osascript")
        .args([
            "-e", "on run argv",
            "-e", "tell application \"Finder\"",
            "-e", "activate",
            "-e", "open information window of (POSIX file (item 1 of argv) as alias)",
            "-e", "end tell",
            "-e", "end run",
        ])
        .arg(validated)
        .spawn()?;
    Ok(())
}

/// Show a Quick Look preview of the app bundle (context menu "Quick Look").
/// A helper process (helpers/quick-look.swift, compiled by build.rs and
/// bundled beside the app binary) presents a real QLPreviewPanel; the path
/// travels as argv.
///
/// The launcher stays open beneath the panel (PREVIEW_COUNT suppresses the
/// focus-loss quit; the panel floats at level 20, one above the launcher).
/// The helper exits when its panel closes or another app takes focus; the
/// watcher thread then quits the launcher unless focus returned to it.
#[tauri::command]
pub(crate) async fn quick_look(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), AppError> {
    let validated = validated_app_path(&path)?;

    let mut child = Command::new(quick_look_helper_path()?)
        .arg(validated)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    crate::PREVIEW_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

    std::thread::spawn(move || {
        let _ = child.wait();
        crate::PREVIEW_COUNT.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        // Give macOS a moment to hand focus back after the helper exits;
        // if it went elsewhere instead, close like any other focus loss.
        // Skipped while another preview is still up, or when a click into
        // the launcher already owns the quit (launching a clicked app, or
        // closing via background click set IS_LAUNCHING) — deferring keeps
        // the launch animation from being cut short.
        std::thread::sleep(std::time::Duration::from_millis(400));
        if crate::PREVIEW_COUNT.load(std::sync::atomic::Ordering::SeqCst) == 0
            && !window.is_focused().unwrap_or(false)
            && !crate::IS_LAUNCHING.swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            crate::graceful_exit(&app);
        }
    });

    Ok(())
}

/// Resolve the bundled Quick Look helper binary. The tauri CLI copies
/// externalBin beside the app binary for both `tauri dev` and bundled
/// builds; the triple-suffixed build output in src-tauri/binaries is the
/// fallback for bare `cargo run`-style dev launches.
fn quick_look_helper_path() -> Result<PathBuf, AppError> {
    let exe = std::env::current_exe()?;
    if let Some(dir) = exe.parent() {
        let helper = dir.join("quick-look-helper");
        if helper.exists() {
            return Ok(helper);
        }
    }

    let triple = option_env!("WAFFLEPAD_TARGET_TRIPLE").unwrap_or("unknown");
    let fallback = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("quick-look-helper-{triple}"));
    if fallback.exists() {
        return Ok(fallback);
    }

    Err(AppError::Validation("Quick Look helper not found".into()))
}

#[tauri::command]
pub(crate) async fn show_window(window: tauri::WebviewWindow) -> Result<(), AppError> {
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Quit the app, saving order state first
#[tauri::command]
pub(crate) fn quit_app(app: tauri::AppHandle) {
    crate::graceful_exit(&app);
}

/// Quit the app after a delay (used for launch animation)
/// During the delay, focus-loss closing is disabled
#[tauri::command]
pub(crate) fn quit_after_delay(app: tauri::AppHandle, delay_ms: u64) {
    crate::IS_LAUNCHING.store(true, std::sync::atomic::Ordering::SeqCst);

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        crate::graceful_exit(&app);
    });
}
