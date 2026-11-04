//! The CoreFoundation and Accessibility C API surface the macOS backend is
//! built on: type aliases, `extern "C"` declarations, and the small owning
//! wrappers that keep every `Copy`/`Create` result released.
//!
//! Only declarations live here, never policy. The refusals and the tree walk
//! are in `mod.rs`, so a review of "what can this process do to another app"
//! reads the call surface in one place.
#![allow(non_upper_case_globals, non_snake_case)]

use std::ffi::c_void;

use super::super::ActionKind;

pub(super) type Boolean = u8;
pub(super) type CFIndex = isize;
pub(super) type CFTypeRef = *const c_void;
pub(super) type CFStringRef = *const c_void;
pub(super) type CFArrayRef = *const c_void;
pub(super) type CFDictionaryRef = *const c_void;
pub(super) type AXUIElementRef = *const c_void;
pub(super) type AXValueRef = *const c_void;
pub(super) type AXError = i32;
pub(super) type CGEventRef = *const c_void;
pub(super) type CGEventSourceRef = *const c_void;

pub(super) const kAXErrorSuccess: AXError = 0;
pub(super) const kCFStringEncodingUTF8: u32 = 0x0800_0100;
/// `kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements`
pub(super) const WINDOW_LIST_OPTIONS: u32 = 1 | 16;
pub(super) const kCGNullWindowID: u32 = 0;
pub(super) const kAXValueTypeCGPoint: u32 = 1;
pub(super) const kAXValueTypeCGSize: u32 = 2;
/// `kCFNumberSInt64Type` and `kCFNumberDoubleType`
pub(super) const kCFNumberSInt64Type: CFIndex = 4;
pub(super) const kCFNumberDoubleType: CFIndex = 13;
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(super) struct CGPoint {
    pub(super) x: f64,
    pub(super) y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(super) struct CGSize {
    pub(super) width: f64,
    pub(super) height: f64,
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub(super) fn CFRelease(cf: CFTypeRef);
    pub(super) fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    pub(super) fn CFGetTypeID(cf: CFTypeRef) -> usize;
    pub(super) fn CFStringGetTypeID() -> usize;
    pub(super) fn CFArrayGetTypeID() -> usize;
    pub(super) fn CFBooleanGetTypeID() -> usize;
    pub(super) fn CFNumberGetTypeID() -> usize;
    pub(super) fn CFDictionaryGetTypeID() -> usize;
    pub(super) fn CFStringCreateWithBytes(
        alloc: CFTypeRef,
        bytes: *const u8,
        num_bytes: CFIndex,
        encoding: u32,
        is_external_representation: Boolean,
    ) -> CFStringRef;
    pub(super) fn CFStringGetLength(value: CFStringRef) -> CFIndex;
    pub(super) fn CFStringGetCString(
        value: CFStringRef,
        buffer: *mut i8,
        buffer_size: CFIndex,
        encoding: u32,
    ) -> Boolean;
    pub(super) fn CFArrayGetCount(array: CFArrayRef) -> CFIndex;
    pub(super) fn CFArrayGetValueAtIndex(array: CFArrayRef, index: CFIndex) -> CFTypeRef;
    pub(super) fn CFDictionaryGetValue(dict: CFDictionaryRef, key: CFTypeRef) -> CFTypeRef;
    pub(super) fn CFBooleanGetValue(value: CFTypeRef) -> Boolean;
    pub(super) fn CFNumberGetValue(
        value: CFTypeRef,
        number_type: CFIndex,
        out: *mut c_void,
    ) -> Boolean;
    /// Builds a dictionary from parallel key/value arrays. The callbacks are
    /// `NULL` here, which means the dictionary borrows both arrays for its whole
    /// lifetime — fine for the synchronous trust call that is its only user.
    pub(super) fn CFDictionaryCreate(
        allocator: CFTypeRef,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        num_values: CFIndex,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFDictionaryRef;
    /// The shared boolean CoreFoundation hands out for `true`. Immortal, so it
    /// is never released.
    pub(super) static kCFBooleanTrue: CFTypeRef;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub(super) fn AXIsProcessTrusted() -> Boolean;
    /// The OS handles an asynchronous prompt when this option is true.
    pub(super) fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> Boolean;
    pub(super) static kAXTrustedCheckOptionPrompt: CFStringRef;
    pub(super) fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    pub(super) fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    pub(super) fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    pub(super) fn AXUIElementCopyActionNames(
        element: AXUIElementRef,
        names: *mut CFArrayRef,
    ) -> AXError;
    pub(super) fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef)
        -> AXError;
    pub(super) fn AXValueGetValue(value: AXValueRef, value_type: u32, out: *mut c_void) -> Boolean;
    pub(super) fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
    pub(super) fn CGEventCreateKeyboardEvent(
        source: CGEventSourceRef,
        virtual_key: u16,
        key_down: Boolean,
    ) -> CGEventRef;
    pub(super) fn CGEventSetFlags(event: CGEventRef, flags: u64);
    pub(super) fn CGEventPostToPid(pid: i32, event: CGEventRef);
}

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    pub(super) fn IsSecureEventInputEnabled() -> Boolean;
}

/// A CFString we own. `Drop` releases it, so no attribute lookup can leak.
pub(super) struct CfString(pub(super) CFStringRef);

impl CfString {
    pub(super) fn new(value: &str) -> Option<Self> {
        // SAFETY: the bytes outlive the call, and CoreFoundation copies them.
        let raw = unsafe {
            CFStringCreateWithBytes(
                std::ptr::null(),
                value.as_ptr(),
                value.len() as CFIndex,
                kCFStringEncodingUTF8,
                0,
            )
        };
        if raw.is_null() {
            None
        } else {
            Some(Self(raw))
        }
    }

    pub(super) fn as_ref(&self) -> CFStringRef {
        self.0
    }
}

impl Drop for CfString {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: we created this string and hold the only reference.
            unsafe { CFRelease(self.0) };
        }
    }
}

/// A CFType we received from a `Copy`/`Create` call and must release.
pub(super) struct CfOwned(pub(super) CFTypeRef);

impl CfOwned {
    pub(super) fn as_ref(&self) -> CFTypeRef {
        self.0
    }
}

impl Drop for CfOwned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the value came from a Copy/Create call, so we own it.
            unsafe { CFRelease(self.0) };
        }
    }
}

pub(super) fn cf_string_value(value: CFTypeRef) -> Option<String> {
    if value.is_null() {
        return None;
    }
    // SAFETY: both calls are null-checked and the type is verified first.
    unsafe {
        if CFGetTypeID(value) != CFStringGetTypeID() {
            return None;
        }
        let length = CFStringGetLength(value);
        // UTF-8 can take up to 4 bytes per UTF-16 unit, plus a terminator.
        let capacity = (length * 4 + 1).max(1) as usize;
        let mut buffer = vec![0i8; capacity];
        if CFStringGetCString(
            value,
            buffer.as_mut_ptr(),
            capacity as CFIndex,
            kCFStringEncodingUTF8,
        ) == 0
        {
            return None;
        }
        let bytes: Vec<u8> = buffer
            .into_iter()
            .take_while(|byte| *byte != 0)
            .map(|byte| byte as u8)
            .collect();
        String::from_utf8(bytes).ok()
    }
}

pub(super) fn cf_number_f64(value: CFTypeRef) -> Option<f64> {
    if value.is_null() {
        return None;
    }
    // SAFETY: type-checked before reading, and the out pointer is sized.
    unsafe {
        if CFGetTypeID(value) != CFNumberGetTypeID() {
            return None;
        }
        let mut out: f64 = 0.0;
        if CFNumberGetValue(
            value,
            kCFNumberDoubleType,
            &mut out as *mut f64 as *mut c_void,
        ) == 0
        {
            return None;
        }
        Some(out)
    }
}

pub(super) fn cf_number_i64(value: CFTypeRef) -> Option<i64> {
    if value.is_null() {
        return None;
    }
    // SAFETY: type-checked before reading, and the out pointer is sized.
    unsafe {
        if CFGetTypeID(value) != CFNumberGetTypeID() {
            return None;
        }
        let mut out: i64 = 0;
        if CFNumberGetValue(
            value,
            kCFNumberSInt64Type,
            &mut out as *mut i64 as *mut c_void,
        ) == 0
        {
            return None;
        }
        Some(out)
    }
}

pub(super) fn cf_bool(value: CFTypeRef) -> Option<bool> {
    if value.is_null() {
        return None;
    }
    // SAFETY: type-checked before reading.
    unsafe {
        if CFGetTypeID(value) != CFBooleanGetTypeID() {
            return None;
        }
        Some(CFBooleanGetValue(value) != 0)
    }
}

pub(super) fn dict_value(dict: CFDictionaryRef, key: &str) -> Option<CFTypeRef> {
    if dict.is_null() {
        return None;
    }
    // SAFETY: the dictionary type is verified and the key is owned locally.
    unsafe {
        if CFGetTypeID(dict) != CFDictionaryGetTypeID() {
            return None;
        }
        let cf_key = CfString::new(key)?;
        let value = CFDictionaryGetValue(dict, cf_key.as_ref());
        if value.is_null() {
            None
        } else {
            Some(value)
        }
    }
}

/// Read one AX attribute. The result is owned by the caller.
pub(super) fn attribute(element: AXUIElementRef, name: &str) -> Option<CfOwned> {
    let attr = CfString::new(name)?;
    let mut out: CFTypeRef = std::ptr::null();
    // SAFETY: `out` is a valid slot; on failure AX leaves it untouched.
    let status = unsafe { AXUIElementCopyAttributeValue(element, attr.as_ref(), &mut out) };
    if status != kAXErrorSuccess || out.is_null() {
        return None;
    }
    Some(CfOwned(out))
}

pub(super) fn attribute_string(element: AXUIElementRef, name: &str) -> Option<String> {
    let value = attribute(element, name)?;
    cf_string_value(value.as_ref())
}

pub(super) fn attribute_bool(element: AXUIElementRef, name: &str) -> Option<bool> {
    let value = attribute(element, name)?;
    cf_bool(value.as_ref())
}

pub(super) fn attribute_point(element: AXUIElementRef, name: &str) -> Option<CGPoint> {
    let value = attribute(element, name)?;
    let mut point = CGPoint::default();
    // SAFETY: the out type matches `kAXValueTypeCGPoint`.
    let ok = unsafe {
        AXValueGetValue(
            value.as_ref() as AXValueRef,
            kAXValueTypeCGPoint,
            &mut point as *mut CGPoint as *mut c_void,
        )
    };
    if ok == 0 {
        None
    } else {
        Some(point)
    }
}

pub(super) fn attribute_size(element: AXUIElementRef, name: &str) -> Option<CGSize> {
    let value = attribute(element, name)?;
    let mut size = CGSize::default();
    // SAFETY: the out type matches `kAXValueTypeCGSize`.
    let ok = unsafe {
        AXValueGetValue(
            value.as_ref() as AXValueRef,
            kAXValueTypeCGSize,
            &mut size as *mut CGSize as *mut c_void,
        )
    };
    if ok == 0 {
        None
    } else {
        Some(size)
    }
}

/// Children of an element, each retained so it stays valid after the array
/// that produced it is released. Returning borrowed references instead would
/// hand out pointers whose owner is already gone.
pub(super) fn children(element: AXUIElementRef) -> Vec<CfOwned> {
    let Some(value) = attribute(element, "AXChildren") else {
        return Vec::new();
    };
    // SAFETY: type-checked; every child is retained before the array drops.
    unsafe {
        if CFGetTypeID(value.as_ref()) != CFArrayGetTypeID() {
            return Vec::new();
        }
        let count = CFArrayGetCount(value.as_ref());
        let mut out = Vec::new();
        for index in 0..count {
            let child = CFArrayGetValueAtIndex(value.as_ref(), index);
            if !child.is_null() {
                out.push(CfOwned(CFRetain(child)));
            }
        }
        out
    }
}

pub(super) fn action_names(element: AXUIElementRef) -> Vec<String> {
    let mut array: CFArrayRef = std::ptr::null();
    // SAFETY: `array` is a valid slot; AX leaves it null on failure.
    let status = unsafe { AXUIElementCopyActionNames(element, &mut array) };
    if status != kAXErrorSuccess || array.is_null() {
        return Vec::new();
    }
    let owned = CfOwned(array);
    let mut names = Vec::new();
    // SAFETY: the array is owned and its element type is CFString.
    unsafe {
        let count = CFArrayGetCount(owned.as_ref());
        for index in 0..count {
            if let Some(name) = cf_string_value(CFArrayGetValueAtIndex(owned.as_ref(), index)) {
                names.push(name);
            }
        }
    }
    names
}

/// The AX actions we expose, mapped from the platform's own action names.
pub(super) fn supported_actions(names: &[String]) -> Vec<ActionKind> {
    let mut actions = Vec::new();
    let has = |needle: &str| names.iter().any(|name| name == needle);
    if has("AXPress") {
        actions.push(ActionKind::Click);
    }
    if has("AXShowMenu") {
        actions.push(ActionKind::RightClick);
    }
    if has("AXIncrement") || has("AXDecrement") {
        actions.push(ActionKind::Scroll);
    }
    if has("AXPick") {
        actions.push(ActionKind::Select);
    }
    actions
}

/// `uid` encodes the path from the window root plus a digest of the role and
/// label it had when inspected. A later action re-walks the path and checks the
/// digest, so a tree that changed underneath refuses instead of acting on
/// whatever now sits at that position. No native reference is kept between
/// calls, which is also why a uid cannot outlive what it describes.
pub(super) fn make_uid(path: &[usize], role: &str, label: Option<&str>) -> String {
    let joined = path
        .iter()
        .map(|index| index.to_string())
        .collect::<Vec<_>>()
        .join(".");
    format!("{joined}#{:x}", identity_digest(role, label))
}

pub(super) fn identity_digest(role: &str, label: Option<&str>) -> u32 {
    // FNV-1a over role and label. This is a change detector, not a secret.
    let mut hash: u32 = 0x811c_9dc5;
    for byte in role.as_bytes().iter().chain(label.unwrap_or("").as_bytes()) {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

pub(super) fn parse_uid(uid: &str) -> Option<(Vec<usize>, u32)> {
    let (path, digest) = uid.split_once('#')?;
    let indices = path
        .split('.')
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<usize>().ok())
        .collect::<Option<Vec<_>>>()?;
    let digest = u32::from_str_radix(digest, 16).ok()?;
    Some((indices, digest))
}
