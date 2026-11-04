//! The macOS computer-use backend: accessibility inspection and actions over
//! `AXUIElement`, window enumeration over `CGWindowList`, and key input posted
//! to the granted application's process.
//!
//! The C surface it is built on — the `extern "C"` declarations, the type
//! aliases, and the owning `CFString`/`CFType` wrappers — is in [`ffi`]; this
//! module is the behaviour: which windows exist, what their accessibility trees
//! say, and what a granted action is allowed to touch.
//!
//! The pointer is never warped. Element actions go through `AXUIElementPerformAction`
//! and values through `AXUIElementSetAttributeValue`, so the user keeps their
//! mouse while the agent works. Keys are posted with `CGEventPostToPid`, which
//! delivers to the granted process rather than to whatever has focus.

#![allow(non_snake_case)]

mod ffi;

use ffi::*;

use super::backend::{
    Desktop, DesktopError, Dispatched, Measured, RawInspection, RawTarget, TargetRef,
};
use super::{
    Action, ActionKind, Capabilities, Fidelity, Node, PermissionState, Rect, MAX_LABEL_CHARS,
};

pub struct MacDesktop;

impl MacDesktop {
    pub fn new() -> Self {
        Self
    }

    fn trusted(&self) -> bool {
        // SAFETY: the call takes no arguments and only reads TCC state.
        unsafe { AXIsProcessTrusted() != 0 }
    }

    /// The AX element for one window, re-resolved from the application each
    /// time: holding an `AXUIElementRef` across calls would mean acting on a
    /// window that may already be gone.
    fn window_element(&self, target: &TargetRef) -> Result<CfOwned, DesktopError> {
        if !self.trusted() {
            return Err(DesktopError::PermissionMissing);
        }
        // SAFETY: the pid is validated by the caller's grant; a dead pid
        // yields an element whose attribute reads fail, which we map below.
        let app = unsafe { AXUIElementCreateApplication(target.pid) };
        if app.is_null() {
            return Err(DesktopError::TargetGone);
        }
        let app = CfOwned(app);
        let windows = attribute(app.as_ref(), "AXWindows").ok_or(DesktopError::TargetGone)?;
        // SAFETY: type-checked; entries are borrowed from an array we keep.
        let found = unsafe {
            if CFGetTypeID(windows.as_ref()) != CFArrayGetTypeID() {
                return Err(DesktopError::TargetGone);
            }
            let count = CFArrayGetCount(windows.as_ref());
            let mut found: Option<CFTypeRef> = None;
            for index in 0..count {
                let window = CFArrayGetValueAtIndex(windows.as_ref(), index);
                if window.is_null() {
                    continue;
                }
                // `AXWindowNumber` is not public API on every release, so the
                // window is matched on geometry and title, the two things
                // `CGWindowList` also gave us. A mismatch is a refusal, not a
                // guess at which window the user meant.
                if self.window_matches(window, target) {
                    found = Some(window);
                    break;
                }
            }
            found
        };
        let window = found.ok_or(DesktopError::TargetGone)?;
        // Retain before the window array drops, so the caller holds a
        // reference that outlives the enumeration it came from.
        // SAFETY: `window` is a live entry of an array we still own here.
        let retained = unsafe { CFRetain(window) };
        drop(windows);
        Ok(CfOwned(retained))
    }

    fn window_matches(&self, window: AXUIElementRef, target: &TargetRef) -> bool {
        // The window id is encoded in `target_id` as `<pid>:<window>`, and the
        // AX side cannot read it, so geometry is the join key. `measure` is the
        // authority on whether the grant still describes this window.
        let Some(position) = attribute_point(window, "AXPosition") else {
            return false;
        };
        let Some(size) = attribute_size(window, "AXSize") else {
            return false;
        };
        let bounds = Rect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        };
        self.cg_bounds(target)
            .map(|cg| cg.matches(&bounds))
            .unwrap_or(false)
    }

    /// Window geometry straight from `CGWindowList`, which does not need the
    /// Accessibility grant and is therefore also the pre-permission answer.
    fn cg_bounds(&self, target: &TargetRef) -> Option<Rect> {
        self.enumerate()
            .ok()?
            .into_iter()
            .find(|item| item.target.window == target.window && item.target.pid == target.pid)
            .map(|item| item.bounds)
    }

    fn enumerate(&self) -> Result<Vec<RawTarget>, DesktopError> {
        // SAFETY: the returned array is owned by us and released by `CfOwned`.
        let array = unsafe { CGWindowListCopyWindowInfo(WINDOW_LIST_OPTIONS, kCGNullWindowID) };
        if array.is_null() {
            return Err(DesktopError::Failed("window list unavailable".into()));
        }
        let owned = CfOwned(array);
        let mut targets = Vec::new();
        // SAFETY: the array is owned and holds CFDictionary entries.
        unsafe {
            let count = CFArrayGetCount(owned.as_ref());
            for index in 0..count {
                let dict = CFArrayGetValueAtIndex(owned.as_ref(), index);
                if dict.is_null() {
                    continue;
                }
                // Layer 0 is the normal application layer: menu bar extras,
                // the Dock, and overlays sit above it and are not targets a
                // user would mean when they say "this window".
                let layer = dict_value(dict, "kCGWindowLayer")
                    .and_then(cf_number_i64)
                    .unwrap_or(0);
                if layer != 0 {
                    continue;
                }
                let Some(pid) = dict_value(dict, "kCGWindowOwnerPID").and_then(cf_number_i64)
                else {
                    continue;
                };
                let Some(window) = dict_value(dict, "kCGWindowNumber").and_then(cf_number_i64)
                else {
                    continue;
                };
                let app_name = dict_value(dict, "kCGWindowOwnerName")
                    .and_then(cf_string_value)
                    .unwrap_or_default();
                let title = dict_value(dict, "kCGWindowName")
                    .and_then(cf_string_value)
                    .unwrap_or_default();
                let bounds_dict = dict_value(dict, "kCGWindowBounds").unwrap_or(std::ptr::null());
                let read = |key: &str| {
                    dict_value(bounds_dict, key)
                        .and_then(cf_number_f64)
                        .unwrap_or(0.0)
                };
                let bounds = Rect {
                    x: read("X"),
                    y: read("Y"),
                    width: read("Width"),
                    height: read("Height"),
                };
                // A zero-area window is not something a user can point at.
                if bounds.width < 1.0 || bounds.height < 1.0 {
                    continue;
                }
                targets.push(RawTarget {
                    target: TargetRef {
                        target_id: format!("{pid}:{window}"),
                        pid: pid as i32,
                        window: window as u64,
                        // macOS does not publish the bundle id here; the owner
                        // name is what the platform can prove, and `measure`
                        // compares it to catch a reused window handle.
                        app_key: app_name.to_ascii_lowercase(),
                    },
                    app_name,
                    title,
                    bounds,
                    elevated: false,
                });
            }
        }
        Ok(targets)
    }

    fn walk(
        &self,
        element: AXUIElementRef,
        path: &mut Vec<usize>,
        parent: Option<usize>,
        nodes: &mut Vec<Node>,
        max_nodes: usize,
    ) -> bool {
        if nodes.len() >= max_nodes {
            return true;
        }
        let role = attribute_string(element, "AXRole").unwrap_or_else(|| "AXUnknown".into());
        let label = attribute_string(element, "AXTitle")
            .or_else(|| attribute_string(element, "AXDescription"))
            .or_else(|| attribute_string(element, "AXLabel"))
            .map(|value| value.chars().take(MAX_LABEL_CHARS).collect::<String>())
            .filter(|value| !value.trim().is_empty());
        let has_value = attribute(element, "AXValue").is_some();
        let enabled = attribute_bool(element, "AXEnabled").unwrap_or(true);
        let focused = attribute_bool(element, "AXFocused").unwrap_or(false);
        let bounds = match (
            attribute_point(element, "AXPosition"),
            attribute_size(element, "AXSize"),
        ) {
            (Some(position), Some(size)) => Some(Rect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            }),
            _ => None,
        };
        let names = action_names(element);
        let mut actions = supported_actions(&names);
        // A settable value is how text gets entered without typing into
        // whatever happens to have focus.
        if has_value && enabled {
            actions.push(ActionKind::SetValue);
        }
        let index = nodes.len();
        nodes.push(Node {
            uid: make_uid(path, &role, label.as_deref()),
            role,
            label,
            has_value,
            enabled,
            focused,
            bounds,
            parent,
            actions,
        });
        for (child_index, child) in children(element).into_iter().enumerate() {
            path.push(child_index);
            let truncated = self.walk(child.as_ref(), path, Some(index), nodes, max_nodes);
            path.pop();
            if truncated {
                return true;
            }
        }
        false
    }

    /// Re-walk a `uid` path and verify the identity digest still matches.
    fn resolve(
        &self,
        window: AXUIElementRef,
        uid: &str,
    ) -> Result<(CfOwned, Option<Rect>), DesktopError> {
        let (path, digest) = parse_uid(uid).ok_or(DesktopError::ElementNotFound)?;
        // SAFETY: the window reference is owned by the caller for this call.
        let mut current = CfOwned(unsafe { CFRetain(window) });
        for index in &path {
            let mut kids = children(current.as_ref());
            if *index >= kids.len() {
                return Err(DesktopError::ElementNotFound);
            }
            current = kids.swap_remove(*index);
        }
        let element = current.as_ref();
        let role = attribute_string(element, "AXRole").unwrap_or_else(|| "AXUnknown".into());
        let label = attribute_string(element, "AXTitle")
            .or_else(|| attribute_string(element, "AXDescription"))
            .or_else(|| attribute_string(element, "AXLabel"))
            .map(|value| value.chars().take(MAX_LABEL_CHARS).collect::<String>())
            .filter(|value| !value.trim().is_empty());
        if identity_digest(&role, label.as_deref()) != digest {
            // The position still exists but holds something else now.
            return Err(DesktopError::ElementNotFound);
        }
        let bounds = match (
            attribute_point(element, "AXPosition"),
            attribute_size(element, "AXSize"),
        ) {
            (Some(position), Some(size)) => Some(Rect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            }),
            _ => None,
        };
        Ok((current, bounds))
    }

    fn perform_ax_action(&self, element: CFTypeRef, name: &str) -> Result<(), DesktopError> {
        let action =
            CfString::new(name).ok_or_else(|| DesktopError::Failed("action name".into()))?;
        // SAFETY: the element came from a verified walk in this same call.
        let status = unsafe { AXUIElementPerformAction(element, action.as_ref()) };
        if status == kAXErrorSuccess {
            Ok(())
        } else {
            Err(DesktopError::NotActionable)
        }
    }

    fn set_value(&self, element: CFTypeRef, text: &str) -> Result<(), DesktopError> {
        let attr =
            CfString::new("AXValue").ok_or_else(|| DesktopError::Failed("attribute".into()))?;
        let value = CfString::new(text).ok_or_else(|| DesktopError::Failed("value".into()))?;
        // SAFETY: both strings outlive the call; AX copies the value.
        let status =
            unsafe { AXUIElementSetAttributeValue(element, attr.as_ref(), value.as_ref()) };
        if status == kAXErrorSuccess {
            Ok(())
        } else {
            Err(DesktopError::NotActionable)
        }
    }

    /// Post one key chord to the granted process. The event never enters the
    /// HID tap, so it cannot land in another application if focus moves.
    fn press_keys(&self, pid: i32, chords: &[String]) -> Result<(), DesktopError> {
        for chord in chords {
            let (flags, key) = parse_chord(chord).ok_or(DesktopError::NotActionable)?;
            for down in [1u8, 0u8] {
                // SAFETY: a null source is documented as "use a private
                // source"; the event is released before the next iteration.
                let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), key, down) };
                if event.is_null() {
                    return Err(DesktopError::Failed("key event".into()));
                }
                // SAFETY: the event is ours until it is released.
                unsafe {
                    CGEventSetFlags(event, flags);
                    CGEventPostToPid(pid, event);
                    CFRelease(event);
                }
            }
        }
        Ok(())
    }
}

/// Modifier bits as `CGEventFlags`.
const FLAG_SHIFT: u64 = 0x0002_0000;
const FLAG_CONTROL: u64 = 0x0004_0000;
const FLAG_OPTION: u64 = 0x0008_0000;
const FLAG_COMMAND: u64 = 0x0010_0000;

/// Map a chord like `cmd+a` onto flags and a virtual key code.
///
/// The accepted set is deliberately small: a key the table does not name is a
/// refusal, so a model cannot reach an arbitrary system shortcut by spelling.
fn parse_chord(chord: &str) -> Option<(u64, u16)> {
    let mut flags = 0u64;
    let mut key: Option<u16> = None;
    for part in chord.split('+') {
        let token = part.trim().to_ascii_lowercase();
        match token.as_str() {
            "" => return None,
            "cmd" | "command" | "meta" => flags |= FLAG_COMMAND,
            "shift" => flags |= FLAG_SHIFT,
            "alt" | "option" | "opt" => flags |= FLAG_OPTION,
            "ctrl" | "control" => flags |= FLAG_CONTROL,
            other => {
                if key.is_some() {
                    return None;
                }
                key = virtual_key(other);
                key?;
            }
        }
    }
    key.map(|value| (flags, value))
}

fn virtual_key(name: &str) -> Option<u16> {
    let code = match name {
        "a" => 0,
        "b" => 11,
        "c" => 8,
        "d" => 2,
        "e" => 14,
        "f" => 3,
        "g" => 5,
        "h" => 4,
        "i" => 34,
        "j" => 38,
        "k" => 40,
        "l" => 37,
        "m" => 46,
        "n" => 45,
        "o" => 31,
        "p" => 35,
        "q" => 12,
        "r" => 15,
        "s" => 1,
        "t" => 17,
        "u" => 32,
        "v" => 9,
        "w" => 13,
        "x" => 7,
        "y" => 16,
        "z" => 6,
        "0" => 29,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "5" => 23,
        "6" => 22,
        "7" => 26,
        "8" => 28,
        "9" => 25,
        "return" | "enter" => 36,
        "tab" => 48,
        "space" => 49,
        "delete" | "backspace" => 51,
        "escape" | "esc" => 53,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        _ => return None,
    };
    Some(code)
}

impl Desktop for MacDesktop {
    fn capabilities(&self) -> Capabilities {
        let accessibility = if self.trusted() {
            PermissionState::Granted
        } else {
            // macOS does not distinguish "never asked" from "refused" here;
            // reporting `not-requested` keeps the doctor view honest, because
            // the next request is what produces the prompt or the refusal.
            PermissionState::NotRequested
        };
        Capabilities {
            platform: "darwin".into(),
            backend: "macos-ax".into(),
            fidelity: Fidelity::Full,
            accessibility,
            // The capture path is Chromium's in main, so the host reports what
            // it knows: the window list works without a capture grant.
            capture: PermissionState::NotRequested,
            session_type: None,
            input_unsupported_reason: None,
        }
    }

    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
        self.enumerate()
    }

    fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
        let found = self
            .enumerate()?
            .into_iter()
            .find(|item| item.target.window == target.window && item.target.pid == target.pid)
            .ok_or(DesktopError::TargetGone)?;
        Ok(Measured {
            bounds: found.bounds,
            app_key: found.target.app_key,
            title: found.title,
        })
    }

    fn inspect(&self, target: &TargetRef, max_nodes: usize) -> Result<RawInspection, DesktopError> {
        let window = self.window_element(target)?;
        let mut nodes = Vec::new();
        let mut path = Vec::new();
        let truncated = self.walk(window.as_ref(), &mut path, None, &mut nodes, max_nodes);
        Ok(RawInspection {
            nodes,
            truncated,
            fidelity: Fidelity::Full,
        })
    }

    fn secure_input_active(&self) -> bool {
        // SAFETY: the call takes no arguments and only reads global state.
        unsafe { IsSecureEventInputEnabled() != 0 }
    }

    fn perform(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
    ) -> Result<Dispatched, DesktopError> {
        let kind = action.kind.ok_or(DesktopError::NotActionable)?;
        if kind == ActionKind::PressKeys {
            let keys = action.keys.as_ref().ok_or(DesktopError::NotActionable)?;
            self.press_keys(target.pid, keys)?;
            return Ok(Dispatched::WindowEvent);
        }
        let window = self.window_element(target)?;
        let uid = uid.ok_or(DesktopError::ElementNotFound)?;
        let (resolved, _bounds) = self.resolve(window.as_ref(), uid)?;
        let element = resolved.as_ref();
        match kind {
            ActionKind::Click | ActionKind::DoubleClick => {
                self.perform_ax_action(element, "AXPress")?;
                if kind == ActionKind::DoubleClick {
                    self.perform_ax_action(element, "AXPress")?;
                }
            }
            ActionKind::RightClick => self.perform_ax_action(element, "AXShowMenu")?,
            ActionKind::Select => self.perform_ax_action(element, "AXPick")?,
            ActionKind::SetValue => {
                let text = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
                self.set_value(element, text)?;
            }
            ActionKind::Scroll => {
                let scroll = action.scroll.ok_or(DesktopError::NotActionable)?;
                let name = if scroll.dy >= 0.0 {
                    "AXIncrement"
                } else {
                    "AXDecrement"
                };
                self.perform_ax_action(element, name)?;
            }
            ActionKind::PressKeys => unreachable!("handled above"),
        }
        Ok(Dispatched::AccessibilityAction)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_uid_round_trips_its_path_and_identity() {
        let uid = make_uid(&[0, 3, 2], "AXButton", Some("Save"));
        let (path, digest) = parse_uid(&uid).expect("parse");
        assert_eq!(path, vec![0, 3, 2]);
        assert_eq!(digest, identity_digest("AXButton", Some("Save")));
    }

    #[test]
    fn a_uid_whose_element_changed_identity_does_not_verify() {
        let uid = make_uid(&[1], "AXButton", Some("Save"));
        let (_, digest) = parse_uid(&uid).expect("parse");
        assert_ne!(digest, identity_digest("AXButton", Some("Delete")));
        assert_ne!(digest, identity_digest("AXTextField", Some("Save")));
    }

    #[test]
    fn malformed_uids_are_refused() {
        for uid in ["", "abc", "1.2", "1.x#ff", "1.2#zz", "-1#ff", "1.2#"] {
            assert!(parse_uid(uid).is_none(), "accepted {uid}");
        }
    }

    #[test]
    fn the_scope_root_has_an_empty_path() {
        // The inspection emits the window itself as a node, so its uid is a
        // digest with no path. Acting on it is allowed and simply does
        // whatever the window offers, which is usually nothing.
        let uid = make_uid(&[], "AXWindow", Some("Document"));
        let (path, _) = parse_uid(&uid).expect("root uid");
        assert!(path.is_empty());
    }

    #[test]
    fn chords_accept_known_keys_and_refuse_everything_else() {
        assert_eq!(parse_chord("cmd+a"), Some((FLAG_COMMAND, 0)));
        assert_eq!(parse_chord("Shift+Tab"), Some((FLAG_SHIFT, 48)));
        assert_eq!(parse_chord("escape"), Some((0, 53)));
        for chord in ["", "cmd", "cmd+", "cmd+a+b", "f13", "eject", "power"] {
            assert!(parse_chord(chord).is_none(), "accepted {chord}");
        }
    }

    #[test]
    fn ax_actions_map_to_our_kinds() {
        let names = vec!["AXPress".to_string(), "AXShowMenu".to_string()];
        let actions = supported_actions(&names);
        assert!(actions.contains(&ActionKind::Click));
        assert!(actions.contains(&ActionKind::RightClick));
        assert!(
            !actions.contains(&ActionKind::SetValue),
            "value comes from AXValue, not an action"
        );
    }
}
