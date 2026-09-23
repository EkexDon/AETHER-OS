//! App lifecycle: confirm quitting while terminal sessions are running, and
//! stop background engines on exit.
//!
//! A quit reaches the app in one of three ways:
//!
//! * closing the main window (`WindowEvent::CloseRequested`),
//! * the app menu's "Quit AETHER-OS" item (⌘Q on macOS). The predefined
//!   item calls `terminate:` natively and exits without any cancellable
//!   event, so [`app_menu`] swaps it for a custom item that goes through
//!   [`tauri::AppHandle::exit`],
//! * a programmatic [`tauri::AppHandle::exit`] (`RunEvent::ExitRequested`
//!   with an exit code).
//!
//! When terminals are running and `confirm_quit_with_terminals` (General
//! preferences, default on) is set, [`intercept_quit`] cancels the request
//! and emits [`QUIT_REQUESTED_EVENT`] with [`QuitRequested`]; the webview
//! asks the user and calls [`cmd_quit_confirmed`] to quit for real. A second
//! quit request within [`REPEAT_QUIT_WINDOW`] of a prompt goes through, so a
//! webview that cannot show the dialog never traps the user in the app.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::MenuEvent;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::AppState;

/// Event emitted when a quit waits for the user's confirmation.
pub const QUIT_REQUESTED_EVENT: &str = "quit-requested";
/// Id of the custom "Quit AETHER-OS" menu item (macOS app menu).
pub const QUIT_MENU_ID: &str = "aether-quit";
/// A repeated quit request within this window after a prompt is honoured.
pub const REPEAT_QUIT_WINDOW: Duration = Duration::from_secs(5);

/// Payload of [`QUIT_REQUESTED_EVENT`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QuitRequested {
    /// Terminal sessions that would be ended by quitting.
    pub terminals: usize,
}

/// Whether a quit must wait for confirmation: only when terminals are still
/// running and the user wants to be asked.
pub fn should_block_exit(live_terminals: usize, confirm_pref: bool) -> bool {
    confirm_pref && live_terminals > 0
}

/// Whether an `ExitRequested` with this exit code may be held for a prompt.
/// `None` means every window is already gone (nobody could answer) and
/// restarts (`RESTART_EXIT_CODE`) cannot be cancelled anyway.
pub fn exit_request_can_prompt(code: Option<i32>) -> bool {
    matches!(code, Some(code) if code != tauri::RESTART_EXIT_CODE)
}

/// Quit-confirmation state shared by the run loop and [`cmd_quit_confirmed`].
#[derive(Debug, Default)]
pub struct QuitGuard {
    confirmed: AtomicBool,
    last_prompt: Mutex<Option<Instant>>,
}

impl QuitGuard {
    /// Decide on a quit request at `now`: `true` means "cancel it and ask".
    /// Once confirmed, or when [`should_block_exit`] says no, quits pass. A
    /// request within [`REPEAT_QUIT_WINDOW`] of the previous prompt passes too.
    pub fn should_prompt(&self, live_terminals: usize, confirm_pref: bool, now: Instant) -> bool {
        if self.is_confirmed() || !should_block_exit(live_terminals, confirm_pref) {
            return false;
        }
        let mut last = self
            .last_prompt
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if last.is_some_and(|at| now.saturating_duration_since(at) < REPEAT_QUIT_WINDOW) {
            *last = None;
            return false;
        }
        *last = Some(now);
        true
    }

    /// The user confirmed: every following quit request passes.
    pub fn confirm(&self) {
        self.confirmed.store(true, Ordering::SeqCst);
    }

    /// Whether the user already confirmed quitting.
    pub fn is_confirmed(&self) -> bool {
        self.confirmed.load(Ordering::SeqCst)
    }
}

/// Handle a user quit request. Returns `true` when the caller must cancel it:
/// the main window was brought forward and `quit-requested` was emitted.
/// Without app state, a main window or a deliverable event the quit passes.
pub fn intercept_quit<R: Runtime>(app: &AppHandle<R>) -> bool {
    let (Some(state), Some(guard)) = (app.try_state::<AppState>(), app.try_state::<QuitGuard>())
    else {
        return false;
    };
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let terminals = state.terminal.live_count();
    let confirm = state
        .onboarding
        .get_general_prefs()
        .map(|prefs| prefs.confirm_quit_with_terminals)
        .unwrap_or(true);
    if !guard.should_prompt(terminals, confirm, Instant::now()) {
        return false;
    }
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    app.emit(QUIT_REQUESTED_EVENT, QuitRequested { terminals })
        .is_ok()
}

/// Stop background work that must not outlive the app: language servers
/// (child processes), the sync loop (wipes the in-memory sync key) and the
/// note-history watcher.
pub fn shutdown_engines(state: &AppState) {
    state.lsp.stop_all();
    state.sync.shutdown();
    state.history.shutdown();
}

/// The default macOS menu (the one Tauri installs when an app sets none)
/// with the app menu's predefined "Quit" item swapped for [`QUIT_MENU_ID`]
/// (same label and ⌘Q), so quitting can be confirmed. Other platforms have
/// no default menu bar; closing the window is their quit path.
#[cfg(target_os = "macos")]
pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        for (position, item) in app_menu.items()?.into_iter().enumerate() {
            let MenuItemKind::Predefined(predefined) = item else {
                continue;
            };
            let label = predefined.text()?;
            if label.starts_with("Quit") {
                app_menu.remove_at(position)?;
                let quit = MenuItem::with_id(app, QUIT_MENU_ID, label, true, Some("CmdOrCtrl+Q"))?;
                app_menu.insert(&quit, position)?;
                break;
            }
        }
    }
    Ok(menu)
}

/// Menu handler: the custom quit item requests a (cancellable) exit.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() == QUIT_MENU_ID {
        app.exit(0);
    }
}

/// The user confirmed the `quit-requested` dialog: quit now.
#[tauri::command]
pub fn cmd_quit_confirmed(app: AppHandle, guard: State<'_, QuitGuard>) {
    guard.confirm();
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_only_with_live_terminals_and_the_preference_on() {
        assert!(should_block_exit(1, true));
        assert!(should_block_exit(3, true));
        assert!(!should_block_exit(0, true));
        assert!(!should_block_exit(2, false));
        assert!(!should_block_exit(0, false));
    }

    #[test]
    fn only_programmatic_non_restart_exits_can_prompt() {
        assert!(exit_request_can_prompt(Some(0)));
        assert!(exit_request_can_prompt(Some(1)));
        assert!(!exit_request_can_prompt(None));
        assert!(!exit_request_can_prompt(Some(tauri::RESTART_EXIT_CODE)));
    }

    #[test]
    fn guard_prompts_once_then_honours_a_quick_repeat() {
        let guard = QuitGuard::default();
        let start = Instant::now();
        assert!(guard.should_prompt(2, true, start));
        // A second ⌘Q right away means "yes, quit".
        assert!(!guard.should_prompt(2, true, start + Duration::from_secs(1)));
        // Later requests ask again.
        assert!(guard.should_prompt(2, true, start + Duration::from_secs(2)));
        assert!(guard.should_prompt(2, true, start + Duration::from_secs(60)));
    }

    #[test]
    fn guard_passes_without_terminals_or_after_confirmation() {
        let guard = QuitGuard::default();
        let now = Instant::now();
        assert!(!guard.should_prompt(0, true, now));
        assert!(!guard.should_prompt(4, false, now));
        assert!(guard.should_prompt(1, true, now));
        guard.confirm();
        assert!(guard.is_confirmed());
        assert!(!guard.should_prompt(1, true, now + REPEAT_QUIT_WINDOW * 2));
    }

    #[test]
    fn quit_requested_payload_matches_the_ipc_contract() {
        let json = serde_json::to_value(QuitRequested { terminals: 2 }).expect("serialize");
        assert_eq!(json, serde_json::json!({ "terminals": 2 }));
    }
}
