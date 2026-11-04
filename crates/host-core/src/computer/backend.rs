//! The platform contract for computer use, plus the fallback that exists on
//! every target so an unimplemented platform is a refusal rather than a
//! compile error or a silent no-op (ADR 0340 §11).
//!
//! A backend may only *attempt* work. It never decides whether a request is
//! allowed: policy has already admitted the request by the time a backend sees
//! it, and the grant's own re-measurement happens above this layer.

use serde::{Deserialize, Serialize};

use super::{Action, Capabilities, Fidelity, Node, PermissionState, Rect};

/// A platform handle for one target. The renderer never receives one of these,
/// and a caller cannot construct one: it only comes back from `list_targets`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRef {
    /// Opaque, host-minted. Encodes the platform handle so a later call cannot
    /// smuggle a different window in under a known id.
    pub target_id: String,
    pub pid: i32,
    /// Platform window handle: CGWindowID, HWND, or X11 window id.
    pub window: u64,
    /// Bundle id, executable name, or WM class — whatever the platform proves.
    pub app_key: String,
}

#[derive(Debug, Clone)]
pub struct RawTarget {
    pub target: TargetRef,
    pub app_name: String,
    pub title: String,
    pub bounds: Rect,
    /// Set when the platform itself knows the window cannot be driven, e.g. a
    /// higher-integrity owner on Windows.
    pub elevated: bool,
}

/// What a re-measurement found. `None` means the window is gone, which is a
/// scope violation rather than an element error.
#[derive(Debug, Clone)]
pub struct Measured {
    pub bounds: Rect,
    pub app_key: String,
    /// Live window title. Read by the backends that refresh a grant label; a
    /// title change alone never bumps the revision, because a document rename
    /// is not a different window.
    #[allow(dead_code)]
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Dispatched {
    /// The platform's own accessibility action ran. No pointer was involved.
    AccessibilityAction,
    /// A window-targeted event was posted. Still no global pointer warp.
    WindowEvent,
}

/// Variants a given platform may never produce — `Elevated` is Windows-only,
/// `Unsupported` comes from the fallback — are kept so the contract is the
/// same everywhere and a port does not have to widen the enum.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopError {
    /// No backend on this platform, or no input path in this session type.
    Unsupported,
    PermissionMissing,
    TargetGone,
    Elevated,
    ElementNotFound,
    NotActionable,
    Timeout,
    Failed(String),
}

pub struct RawInspection {
    pub nodes: Vec<Node>,
    pub truncated: bool,
    pub fidelity: Fidelity,
}

pub trait Desktop: Send + Sync {
    fn capabilities(&self) -> Capabilities;

    /// Every window the platform can enumerate, unfiltered. Policy removes and
    /// annotates entries; a backend never hides one, because a target the user
    /// can see but the picker silently dropped is indistinguishable from a bug.
    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError>;

    /// Re-read the live geometry and identity of one target.
    fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError>;

    fn inspect(&self, target: &TargetRef, max_nodes: usize) -> Result<RawInspection, DesktopError>;

    /// Whether the OS reports a secure input state right now. A backend that
    /// cannot tell must answer `true`: refusing is the safe default, since the
    /// alternative is typing into a password field.
    fn secure_input_active(&self) -> bool;

    fn perform(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
    ) -> Result<Dispatched, DesktopError>;

    /// Process ids that belong to this application, so policy can refuse our
    /// own windows without trusting a name comparison.
    ///
    /// host-core has no windows of its own — the windows to refuse belong to
    /// the Electron process that spawned it. The parent pid is therefore part
    /// of the answer, and it is discovered here rather than supplied by a
    /// request, so no caller can shrink this set.
    fn self_pids(&self) -> Vec<i32> {
        let mut pids = vec![std::process::id() as i32];
        #[cfg(unix)]
        {
            // SAFETY: `getppid` takes no arguments and cannot fail.
            let parent = unsafe { libc::getppid() };
            if parent > 1 {
                pids.push(parent);
            }
        }
        pids
    }
}

/// The backend every platform has: it exists so that an unimplemented platform
/// answers with a code instead of panicking or pretending to work. On a
/// platform whose backend is built, nothing constructs it outside the tests.
#[allow(dead_code)]
pub struct UnsupportedDesktop {
    platform: &'static str,
    reason: &'static str,
}

impl UnsupportedDesktop {
    #[allow(dead_code)]
    pub fn new(platform: &'static str, reason: &'static str) -> Self {
        Self { platform, reason }
    }
}

impl Desktop for UnsupportedDesktop {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: self.platform.to_string(),
            backend: "unsupported".into(),
            fidelity: Fidelity::None,
            accessibility: PermissionState::Unsupported,
            capture: PermissionState::Unsupported,
            session_type: None,
            input_unsupported_reason: Some(self.reason.to_string()),
        }
    }

    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
        Err(DesktopError::Unsupported)
    }

    fn measure(&self, _target: &TargetRef) -> Result<Measured, DesktopError> {
        Err(DesktopError::Unsupported)
    }

    fn inspect(
        &self,
        _target: &TargetRef,
        _max_nodes: usize,
    ) -> Result<RawInspection, DesktopError> {
        Err(DesktopError::Unsupported)
    }

    fn secure_input_active(&self) -> bool {
        true
    }

    fn perform(
        &self,
        _target: &TargetRef,
        _uid: Option<&str>,
        _action: &Action,
    ) -> Result<Dispatched, DesktopError> {
        Err(DesktopError::Unsupported)
    }
}

/// The backend for this build. Each platform arm is compiled only on its own
/// target, so an unported platform cannot fail to build.
pub fn active() -> Box<dyn Desktop> {
    #[cfg(target_os = "macos")]
    {
        Box::new(super::macos::MacDesktop::new())
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(UnsupportedDesktop::new(
            "win32",
            "the Windows UI Automation backend lands in stage 2",
        ))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Box::new(UnsupportedDesktop::new(
            "linux",
            "the Linux AT-SPI backend lands in stage 2",
        ))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
    {
        Box::new(UnsupportedDesktop::new(
            "other",
            "no backend for this platform",
        ))
    }
}
