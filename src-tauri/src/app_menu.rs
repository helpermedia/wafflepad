//! Native menus for the frontend: the app-tile and folder-tile context
//! menus and the view-options menu.
//!
//! Tauri's menu API (muda) can only attach legacy named template images to
//! items, which look nothing like the SF Symbols the macOS Apps app uses.
//! These build NSMenus directly; the chosen item is emitted back to the
//! frontend as an event, keeping every action flow (launch animation,
//! close-on-handoff, layout switching) in one place there.

use serde::Deserialize;

use crate::AppError;

/// A folder the selection menu offers as a move target
#[derive(Deserialize)]
pub(crate) struct FolderOption {
    pub(crate) id: String,
    pub(crate) name: String,
}

/// Show the context menu for an app tile at the current cursor position.
/// The chosen action is emitted as an "app-menu-action" event. Sync
/// command: runs on the main thread, which AppKit requires; blocks until
/// the menu is dismissed, so the frontend can await the popup.
#[tauri::command]
pub(crate) fn show_app_menu(window: tauri::WebviewWindow, path: String) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    return macos::show_app(&window, path);

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, path);
        Err(AppError::Validation(
            "App menu is only available on macOS".into(),
        ))
    }
}

/// Show the context menu for a folder tile at the current cursor position.
/// The chosen action is emitted as a "folder-menu-action" event. Sync
/// command: main thread, blocks until dismissed, like show_app_menu.
#[tauri::command]
pub(crate) fn show_folder_menu(
    window: tauri::WebviewWindow,
    folder_id: String,
) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    return macos::show_folder(&window, folder_id);

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, folder_id);
        Err(AppError::Validation(
            "Folder menu is only available on macOS".into(),
        ))
    }
}

/// Show the context menu for a multi-selection of tiles at the current
/// cursor position: a new folder from the selection, or a move into one
/// of `folders`. The choice is emitted as a "selection-menu-action"
/// event. Sync command: main thread, blocks until dismissed, like
/// show_app_menu.
#[tauri::command]
pub(crate) fn show_selection_menu(
    window: tauri::WebviewWindow,
    count: usize,
    folders: Vec<FolderOption>,
) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    return macos::show_selection(&window, count, &folders);

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, count, folders);
        Err(AppError::Validation(
            "Selection menu is only available on macOS".into(),
        ))
    }
}

/// Show the view-options menu (the "…" button) at the current cursor
/// position, check-marking the active layout. The chosen layout is emitted
/// as an "options-menu-action" event. Sync command: main thread, blocks
/// until dismissed, like show_app_menu.
#[tauri::command]
pub(crate) fn show_options_menu(
    window: tauri::WebviewWindow,
    layout: String,
) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    return macos::show_options(&window, &layout);

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, layout);
        Err(AppError::Validation(
            "Options menu is only available on macOS".into(),
        ))
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;

    use objc2::rc::Retained;
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSEvent, NSImage, NSMenu, NSMenuItem};
    use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
    use serde::Serialize;
    use tauri::{Emitter, Manager};

    use crate::AppError;

    /// One selectable menu entry
    struct ItemSpec<'a> {
        title: &'a str,
        /// SF Symbol shown left of the title
        symbol: Option<&'a str>,
        /// Check-marked (NSControlStateValueOn)
        checked: bool,
        /// Entries of a submenu this item opens (the item itself then
        /// never fires)
        submenu: Option<Vec<ItemSpec<'a>>>,
    }

    struct HandlerIvars {
        /// Called with the chosen item's index into the popup's specs;
        /// each menu supplies a closure emitting its own event/payload
        on_select: Box<dyn Fn(usize)>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "WafflepadMenuHandler"]
        #[ivars = HandlerIvars]
        struct MenuHandler;

        unsafe impl NSObjectProtocol for MenuHandler {}

        impl MenuHandler {
            #[unsafe(method(menuAction:))]
            fn menu_action(&self, sender: &NSMenuItem) {
                if let Ok(index) = usize::try_from(sender.tag()) {
                    (self.ivars().on_select)(index);
                }
            }
        }
    );

    impl MenuHandler {
        fn new(mtm: MainThreadMarker, on_select: Box<dyn Fn(usize)>) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(HandlerIvars { on_select });
            unsafe { msg_send![super(this), init] }
        }
    }

    thread_local! {
        /// NSMenuItem.target is weak and the selection action can be
        /// delivered after the popup call returns — keep the last handler
        /// alive until the next menu replaces it (same pattern as
        /// dock_drag's ACTIVE_SOURCE).
        static ACTIVE_HANDLER: RefCell<Option<Retained<MenuHandler>>> =
            const { RefCell::new(None) };
    }

    /// Append `specs` to `menu`, tagging every item in depth-first order
    /// from `next_tag` (a submenu's parent takes a tag too, though it never
    /// fires), so each reachable item maps to one index for on_select
    fn add_items(
        mtm: MainThreadMarker,
        menu: &NSMenu,
        specs: &[ItemSpec],
        handler: &MenuHandler,
        next_tag: &mut usize,
    ) {
        for spec in specs {
            let item = NSMenuItem::new(mtm);
            item.setTitle(&NSString::from_str(spec.title));
            item.setTag(*next_tag as isize);
            *next_tag += 1;
            unsafe {
                item.setTarget(Some(handler));
                item.setAction(Some(sel!(menuAction:)));
            }
            if let Some(symbol) = spec.symbol {
                let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(
                    &NSString::from_str(symbol),
                    None,
                );
                if let Some(image) = image {
                    item.setImage(Some(&image));
                }
            }
            if spec.checked {
                item.setState(1); // NSControlStateValueOn
            }
            if let Some(entries) = &spec.submenu {
                let submenu = NSMenu::new(mtm);
                submenu.setAutoenablesItems(false);
                add_items(mtm, &submenu, entries, handler, next_tag);
                item.setSubmenu(Some(&submenu));
            }
            menu.addItem(&item);
        }
    }

    /// Build and show a native menu at the cursor, with an optional dimmed
    /// section header. Blocks until the menu is dismissed; a selection
    /// reaches on_select as the depth-first index into `items` (see
    /// add_items).
    fn popup(
        header: Option<&str>,
        items: &[ItemSpec],
        on_select: Box<dyn Fn(usize)>,
    ) -> Result<(), AppError> {
        let mtm = MainThreadMarker::new().ok_or_else(|| {
            AppError::Validation("Menus must be shown on the main thread".into())
        })?;

        let handler = MenuHandler::new(mtm, on_select);

        let menu = NSMenu::new(mtm);
        menu.setAutoenablesItems(false);

        if let Some(title) = header {
            // Apps-app style section header: a disabled item renders gray
            let item = NSMenuItem::new(mtm);
            item.setTitle(&NSString::from_str(title));
            item.setEnabled(false);
            menu.addItem(&item);
        }

        let mut next_tag = 0;
        add_items(mtm, &menu, items, &handler, &mut next_tag);

        ACTIVE_HANDLER.with(|slot| *slot.borrow_mut() = Some(handler));

        // Blocks until the menu is dismissed. With no view given, the
        // location is interpreted in screen coordinates — so this pops up
        // at the current cursor position.
        menu.popUpMenuPositioningItem_atLocation_inView(None, NSEvent::mouseLocation(), None);
        Ok(())
    }

    /// Menu title, SF Symbol, action id — the index doubles as the
    /// NSMenuItem tag. Symbols mirror the Apps app's context menu.
    const APP_ACTIONS: [(&str, &str, &str); 4] = [
        ("Open", "arrow.up.forward.app", "open"),
        ("Show in Finder", "finder", "show-in-finder"),
        ("Get Info", "info.circle", "get-info"),
        ("Quick Look", "eye", "quick-look"),
    ];

    #[derive(Clone, Serialize)]
    struct ActionPayload {
        action: &'static str,
        path: String,
    }

    pub(super) fn show_app(window: &tauri::WebviewWindow, path: String) -> Result<(), AppError> {
        let app = window.app_handle().clone();
        let items: Vec<ItemSpec> = APP_ACTIONS
            .iter()
            .map(|(title, symbol, _)| ItemSpec {
                title,
                symbol: Some(symbol),
                checked: false,
                submenu: None,
            })
            .collect();

        popup(
            None,
            &items,
            Box::new(move |index| {
                let Some((_, _, action)) = APP_ACTIONS.get(index) else {
                    return;
                };
                let _ = app.emit(
                    "app-menu-action",
                    ActionPayload {
                        action,
                        path: path.clone(),
                    },
                );
            }),
        )
    }

    /// Menu title, SF Symbol, action id — same shape as APP_ACTIONS.
    /// Actions are pure frontend state changes, so the payload only names
    /// the choice; the frontend routes it to the tile's callbacks.
    const FOLDER_ACTIONS: [(&str, &str, &str); 3] = [
        ("Open", "folder", "open"),
        ("Rename", "pencil", "rename"),
        ("Ungroup", "folder.badge.minus", "ungroup"),
    ];

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FolderActionPayload {
        action: &'static str,
        folder_id: String,
    }

    pub(super) fn show_folder(
        window: &tauri::WebviewWindow,
        folder_id: String,
    ) -> Result<(), AppError> {
        let app = window.app_handle().clone();
        let items: Vec<ItemSpec> = FOLDER_ACTIONS
            .iter()
            .map(|(title, symbol, _)| ItemSpec {
                title,
                symbol: Some(symbol),
                checked: false,
                submenu: None,
            })
            .collect();

        popup(
            None,
            &items,
            Box::new(move |index| {
                let Some((_, _, action)) = FOLDER_ACTIONS.get(index) else {
                    return;
                };
                let _ = app.emit(
                    "folder-menu-action",
                    FolderActionPayload {
                        action,
                        folder_id: folder_id.clone(),
                    },
                );
            }),
        )
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SelectionActionPayload {
        action: &'static str,
        folder_id: Option<String>,
    }

    pub(super) fn show_selection(
        window: &tauri::WebviewWindow,
        count: usize,
        folders: &[super::FolderOption],
    ) -> Result<(), AppError> {
        let app = window.app_handle().clone();
        let new_folder_title = format!("New Folder with Selection ({count} Items)");

        // The items and, in the same depth-first order the tags take, the
        // payload each one fires (None for the submenu's parent, which
        // never fires): a lookup, so a reordered menu can't misroute
        let mut items = Vec::new();
        let mut actions: Vec<Option<SelectionActionPayload>> = Vec::new();

        items.push(ItemSpec {
            title: &new_folder_title,
            symbol: Some("folder.badge.plus"),
            checked: false,
            submenu: None,
        });
        actions.push(Some(SelectionActionPayload {
            action: "new-folder",
            folder_id: None,
        }));

        if !folders.is_empty() {
            actions.push(None);
            let mut targets = Vec::with_capacity(folders.len());
            for folder in folders {
                targets.push(ItemSpec {
                    title: &folder.name,
                    symbol: Some("folder"),
                    checked: false,
                    submenu: None,
                });
                actions.push(Some(SelectionActionPayload {
                    action: "move-to-folder",
                    folder_id: Some(folder.id.clone()),
                }));
            }
            items.push(ItemSpec {
                title: "Move to Folder",
                symbol: Some("folder"),
                checked: false,
                submenu: Some(targets),
            });
        }

        popup(
            None,
            &items,
            Box::new(move |index| {
                let Some(Some(payload)) = actions.get(index) else {
                    return;
                };
                let _ = app.emit("selection-menu-action", payload.clone());
            }),
        )
    }

    /// Menu title, layout id — ids match LayoutMode's serde names; the
    /// default (Paged) leads
    const LAYOUTS: [(&str, &str); 2] = [("Paged", "paged"), ("Scrollable", "scroll")];

    #[derive(Clone, Serialize)]
    struct LayoutPayload {
        layout: &'static str,
    }

    pub(super) fn show_options(
        window: &tauri::WebviewWindow,
        active_layout: &str,
    ) -> Result<(), AppError> {
        let app = window.app_handle().clone();
        let items: Vec<ItemSpec> = LAYOUTS
            .iter()
            .map(|(title, layout)| ItemSpec {
                title,
                symbol: None,
                checked: *layout == active_layout,
                submenu: None,
            })
            .collect();

        popup(
            Some("View apps as"),
            &items,
            Box::new(move |index| {
                let Some((_, layout)) = LAYOUTS.get(index) else {
                    return;
                };
                let _ = app.emit("options-menu-action", LayoutPayload { layout });
            }),
        )
    }
}
