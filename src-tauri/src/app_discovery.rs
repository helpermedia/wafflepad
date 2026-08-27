use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub(crate) fn get_applications_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
    ];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join("Applications"));
    }
    dirs
}

fn sort_paths_by_name(paths: &mut [PathBuf]) {
    paths.sort_by(|a, b| {
        a.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
            .cmp(
                &b.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase(),
            )
    });
}

/// Bundle identifier of an .app bundle, read via NSBundle.
#[cfg(target_os = "macos")]
fn bundle_identifier(path: &std::path::Path) -> Option<String> {
    use objc2_foundation::{NSBundle, NSString};
    // Pool required: called off the main thread (no ambient autorelease pool)
    objc2::rc::autoreleasepool(|_| {
        let ns_path = NSString::from_str(path.to_str()?);
        let bundle = NSBundle::bundleWithPath(&ns_path)?;
        let identifier = bundle.bundleIdentifier()?;
        Some(identifier.to_string())
    })
}

/// App Store category identifier (LSApplicationCategoryType) of an .app,
/// e.g. "public.app-category.developer-tools". Used for folder name
/// suggestions, matching original Launchpad behavior.
#[cfg(target_os = "macos")]
pub(crate) fn app_category(path: &str) -> Option<String> {
    use objc2_foundation::{NSBundle, NSString};
    // Pool required: rayon worker threads have no autorelease pool, so
    // autoreleased NSBundle/NSString would otherwise pin until thread exit
    objc2::rc::autoreleasepool(|_| {
        let ns_path = NSString::from_str(path);
        let bundle = NSBundle::bundleWithPath(&ns_path)?;
        let key = NSString::from_str("LSApplicationCategoryType");
        let value = bundle.objectForInfoDictionaryKey(&key)?;
        let category = value.downcast::<NSString>().ok()?;
        Some(category.to_string())
    })
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn app_category(_path: &str) -> Option<String> {
    None
}

/// Path of the .app bundle this process runs from (None in dev-server mode).
fn own_bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|ext| ext == "app"))
        .map(|p| p.to_path_buf())
}

/// Whether the .app at `path` is this application itself (any copy of it).
/// A launcher listing itself is useless at best: "launching" it while it is
/// already frontmost only plays the quit animation, and with a second copy
/// on disk it can even spawn a second instance.
///
/// This runs per discovered app on the startup path (window still hidden),
/// so the expensive Info.plist identifier read is gated behind two cheap
/// checks: the running bundle's exact path, then a bundle-name match.
fn is_own_bundle(
    path: &std::path::Path,
    own_bundle_id: &str,
    own_app_path: Option<&std::path::Path>,
) -> bool {
    #[cfg(target_os = "macos")]
    {
        if own_app_path.is_some_and(|own| own == path) {
            return true;
        }
        let needle = own_bundle_id
            .rsplit('.')
            .next()
            .unwrap_or(own_bundle_id)
            .to_lowercase();
        let looks_like_self = path
            .file_stem()
            .is_some_and(|stem| stem.to_string_lossy().to_lowercase().contains(&needle));
        if !looks_like_self {
            return false;
        }
        bundle_identifier(path).as_deref() == Some(own_bundle_id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, own_bundle_id, own_app_path);
        false
    }
}

/// What a scan of the Applications directories found
pub(crate) struct Discovery {
    pub(crate) apps: Vec<PathBuf>,
    /// Subdirectories holding two or more apps, with those apps
    pub(crate) folders: Vec<(PathBuf, Vec<PathBuf>)>,
    /// Directories that exist but could not be read this time. Apps the
    /// saved arrangement places under them are unverified rather than
    /// gone, and the frontend's healing keeps them (see healFolders).
    pub(crate) unreadable: Vec<PathBuf>,
}

/// Read a directory's entries. A directory that no longer exists is
/// simply absent; any other failure is recorded in `unreadable`.
fn read_dir_or_record(dir: &Path, unreadable: &mut Vec<PathBuf>) -> Option<fs::ReadDir> {
    match fs::read_dir(dir) {
        Ok(entries) => Some(entries),
        Err(e) => {
            if e.kind() != io::ErrorKind::NotFound {
                unreadable.push(dir.to_path_buf());
            }
            None
        }
    }
}

fn get_apps_in_dir(
    dir: &PathBuf,
    own_bundle_id: &str,
    own_app_path: Option<&Path>,
    unreadable: &mut Vec<PathBuf>,
) -> Vec<PathBuf> {
    let mut apps = Vec::new();
    if let Some(entries) = read_dir_or_record(dir, unreadable) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "app")
                && !is_own_bundle(&path, own_bundle_id, own_app_path)
            {
                apps.push(path);
            }
        }
    }
    sort_paths_by_name(&mut apps);
    apps
}

pub(crate) fn discover_apps_and_folders(own_bundle_id: &str) -> Discovery {
    let mut apps = Vec::new();
    let mut folders: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
    let mut unreadable = Vec::new();
    let own_app = own_bundle_path();
    let own_app_path = own_app.as_deref();

    for dir in get_applications_dirs() {
        if let Some(entries) = read_dir_or_record(&dir, &mut unreadable) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|ext| ext == "app") {
                    if !is_own_bundle(&path, own_bundle_id, own_app_path) {
                        apps.push(path);
                    }
                } else if path.is_dir() {
                    // Check for apps in subdirectory (1 level deep)
                    let sub_apps =
                        get_apps_in_dir(&path, own_bundle_id, own_app_path, &mut unreadable);
                    if sub_apps.len() >= 2 {
                        // Only create folder if 2+ apps
                        folders.push((path, sub_apps));
                    } else if sub_apps.len() == 1 {
                        // Single app goes to main list
                        apps.extend(sub_apps);
                    }
                }
            }
        }
    }

    sort_paths_by_name(&mut apps);

    folders.sort_by(|a, b| {
        a.0.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
            .cmp(
                &b.0.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase(),
            )
    });

    Discovery {
        apps,
        folders,
        unreadable,
    }
}
