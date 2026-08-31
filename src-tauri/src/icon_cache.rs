use std::fs;
use std::path::PathBuf;

/// Get icons cache directory
fn get_icons_cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|p| p.join("com.helpermedia.wafflepad").join("icons"))
}

/// Get a stable hash for an app path to use as icon filename
fn get_icon_filename(app_path: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    app_path.hash(&mut hasher);
    format!("{:x}.png", hasher.finish())
}

/// Get cached icon path if it exists and is still fresh
fn get_cached_icon_path(app_path: &str) -> Option<PathBuf> {
    let icons_dir = get_icons_cache_dir()?;
    let icon_file = icons_dir.join(get_icon_filename(app_path));
    if !icon_file.exists() {
        return None;
    }

    // Invalidate cache if the .app bundle was modified after the icon was cached
    let app_modified = fs::metadata(app_path).ok()?.modified().ok()?;
    let icon_modified = fs::metadata(&icon_file).ok()?.modified().ok()?;
    if app_modified > icon_modified {
        return None;
    }

    Some(icon_file)
}

/// Save icon PNG bytes to cache and return the file path
fn save_icon_to_cache(app_path: &str, png_bytes: &[u8]) -> Option<PathBuf> {
    let icons_dir = get_icons_cache_dir()?;
    fs::create_dir_all(&icons_dir).ok()?;
    let icon_file = icons_dir.join(get_icon_filename(app_path));
    fs::write(&icon_file, png_bytes).ok()?;
    Some(icon_file)
}

/// Canvas of the cached PNGs in pixels: the 128pt Launchpad-size icon
/// at 2x, blitted from the icon's own 256px representation, so the
/// canvas keeps the 24px squircle margin of Apple's 256px icon rasters.
/// AppItem's highlight geometry is measured against exactly that (256px
/// canvas, 24px margin), which is why the bitmap is pinned to this size
/// instead of letting AppKit pick a representation for the main
/// screen's backing scale, as the old `swift -e` renderer did — 256px
/// only on Retina.
#[cfg(target_os = "macos")]
const ICON_CANVAS_PX: usize = 256;

/// Render an app's icon to PNG bytes in-process: NSWorkspace's icon for
/// the bundle, blitted into an offscreen Display P3 bitmap. Replaces a
/// per-icon `swift -e` subprocess, which paid interpreter startup per
/// icon and on a Mac without the Xcode command line tools popped their
/// install dialog instead of rendering (/usr/bin/swift is a stub there).
///
/// Renders may run concurrently (one blocking task per uncached app on a
/// cold start): iconForFile hands each call its own NSImage — dock_drag
/// calls it with no coordination either — and each render draws into a
/// context of its own, current only on its thread (the current context
/// is thread-local state).
#[cfg(target_os = "macos")]
fn get_icon_nsworkspace_bytes(app_path: &str) -> Option<Vec<u8>> {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSCompositingOperation, NSGraphicsContext,
        NSWorkspace,
    };
    use objc2_core_graphics::{
        kCGColorSpaceDisplayP3, CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace,
        CGImageAlphaInfo,
    };
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    // Resolve symlinks first: system apps like Safari are cryptex symlinks in
    // /Applications, and iconForFile badges a symlink with the alias arrow
    let resolved = fs::canonicalize(app_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| app_path.to_string());

    // Pool required: blocking-pool threads have no autorelease pool, so
    // autoreleased AppKit objects would otherwise pin until thread exit
    objc2::rc::autoreleasepool(|_| {
        let icon = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(&resolved));

        let canvas = ICON_CANVAS_PX as f64;
        unsafe {
            // Display P3 backing: the icon representations arrive in
            // extended sRGB and vivid icon art exceeds the sRGB gamut, so
            // a narrower canvas would dull it. The PNG carries the profile.
            let space = CGColorSpace::with_name(Some(kCGColorSpaceDisplayP3))?;
            let cg_ctx = CGBitmapContextCreate(
                std::ptr::null_mut(), // CG allocates the backing store
                ICON_CANVAS_PX,
                ICON_CANVAS_PX,
                8,
                0, // bytes per row: computed
                Some(&space),
                CGImageAlphaInfo::PremultipliedLast.0,
            )?;

            // The current context is thread-local state, cleared right
            // after the draw.
            let ctx = NSGraphicsContext::graphicsContextWithCGContext_flipped(&cg_ctx, false);
            NSGraphicsContext::setCurrentContext(Some(&ctx));
            let dest = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(canvas, canvas));
            // Blit the icon's own 256px representation: an NSImage-level
            // draw would match a representation against the destination
            // with any Retina screen in play, land on the 512px 2x one
            // and downscale, softening the squircle's edge one pixel into
            // the margin the canvas constant promises. Fresh icons carry
            // 256px representations throughout; anything without one gets
            // the matched draw as a fallback.
            let exact = icon.representations().iter().find(|rep| {
                rep.pixelsWide() == ICON_CANVAS_PX as isize
                    && rep.pixelsHigh() == ICON_CANVAS_PX as isize
            });
            // The canvas starts transparent, so the default source-over
            // draw fills it with the icon alone either way
            let drew = exact.is_some_and(|rep| rep.drawInRect(dest));
            if !drew {
                icon.drawInRect_fromRect_operation_fraction(
                    dest,
                    NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0)), // whole source image
                    NSCompositingOperation::SourceOver,
                    1.0,
                );
            }
            NSGraphicsContext::setCurrentContext(None);

            let cg_image = CGBitmapContextCreateImage(Some(&cg_ctx))?;
            let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg_image);
            let png = rep.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )?;
            Some(png.to_vec())
        }
    })
}

/// Get cached icon only (doesn't generate new icons)
pub(crate) fn get_icon_if_cached(app_path: &str) -> Option<String> {
    get_cached_icon_path(app_path).map(|p| format!("file://{}", p.display()))
}

/// Remove cached icons for apps that no longer exist on disk
pub(crate) fn cleanup_orphaned_icons(valid_app_paths: &[String]) {
    let Some(icons_dir) = get_icons_cache_dir() else {
        return;
    };
    let Ok(entries) = fs::read_dir(&icons_dir) else {
        return;
    };

    let valid_filenames: std::collections::HashSet<String> = valid_app_paths
        .iter()
        .map(|p| get_icon_filename(p))
        .collect();

    for entry in entries.flatten() {
        let filename = entry.file_name().to_string_lossy().to_string();
        if filename.ends_with(".png") && !valid_filenames.contains(&filename) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Generate icon and save to cache, returns file:// URL
#[cfg(target_os = "macos")]
pub(crate) fn generate_and_cache_icon(app_path: &str) -> Option<String> {
    let png_bytes = get_icon_nsworkspace_bytes(app_path)?;
    let saved_path = save_icon_to_cache(app_path, &png_bytes)?;
    Some(format!("file://{}", saved_path.display()))
}
