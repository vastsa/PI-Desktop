//! Reads the Keychain secret Google Chrome uses to encrypt its cookie store.
//!
//! The read runs inside the signed host binary rather than through
//! `/usr/bin/security`, so the macOS consent prompt names PI-Desktop's own
//! host and an "Always Allow" grant is bound to this binary's code signature
//! instead of to a system tool every local process can run. The service and
//! account are fixed: callers cannot use this to read other Keychain items.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::fmt;

pub const CHROME_SAFE_STORAGE_SERVICE: &str = "Chrome Safe Storage";
pub const CHROME_SAFE_STORAGE_ACCOUNT: &str = "Chrome";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeychainReadError {
    /// The user denied or dismissed the consent prompt.
    Denied,
    /// No such item: Chrome is not installed or has never stored cookies.
    NotFound,
    /// The secret is not valid UTF-8 or is empty.
    InvalidSecret,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unsupported,
    Other(i32),
}

impl KeychainReadError {
    pub fn error_code(&self) -> &'static str {
        match self {
            KeychainReadError::Denied => "CHROME_KEYCHAIN_DENIED",
            KeychainReadError::NotFound => "CHROME_KEYCHAIN_NOT_FOUND",
            KeychainReadError::InvalidSecret => "CHROME_KEYCHAIN_INVALID",
            KeychainReadError::Unsupported => "UNSUPPORTED",
            KeychainReadError::Other(_) => "CHROME_KEYCHAIN_FAILED",
        }
    }
}

impl fmt::Display for KeychainReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeychainReadError::Denied => {
                write!(
                    f,
                    "access to the Chrome Safe Storage Keychain item was denied"
                )
            }
            KeychainReadError::NotFound => {
                write!(f, "the Chrome Safe Storage Keychain item does not exist")
            }
            KeychainReadError::InvalidSecret => {
                write!(f, "the Chrome Safe Storage Keychain item is unreadable")
            }
            KeychainReadError::Unsupported => {
                write!(
                    f,
                    "reading Chrome's Keychain item is only supported on macOS"
                )
            }
            KeychainReadError::Other(status) => {
                write!(
                    f,
                    "reading the Chrome Safe Storage Keychain item failed (OSStatus {status})"
                )
            }
        }
    }
}

/// Maps a Security framework `OSStatus` to the error surfaced to callers.
pub fn classify_status(status: i32) -> KeychainReadError {
    match status {
        // errSecUserCanceled, errSecAuthFailed, errSecInteractionNotAllowed
        -128 | -25293 | -25308 => KeychainReadError::Denied,
        // errSecItemNotFound
        -25300 => KeychainReadError::NotFound,
        other => KeychainReadError::Other(other),
    }
}

pub fn secret_from_bytes(bytes: &[u8]) -> Result<String, KeychainReadError> {
    let secret = std::str::from_utf8(bytes).map_err(|_| KeychainReadError::InvalidSecret)?;
    if secret.is_empty() {
        return Err(KeychainReadError::InvalidSecret);
    }
    Ok(secret.to_string())
}

/// Blocks until the user answers the Keychain prompt; call off the async workers.
pub fn read_chrome_safe_storage_password() -> Result<String, KeychainReadError> {
    #[cfg(target_os = "macos")]
    {
        macos::read_generic_password(CHROME_SAFE_STORAGE_SERVICE, CHROME_SAFE_STORAGE_ACCOUNT)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(KeychainReadError::Unsupported)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{classify_status, secret_from_bytes, KeychainReadError};
    use std::ffi::c_void;
    use std::ptr;

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFDictionaryRef = *const c_void;
    type CFDataRef = *const c_void;
    type CFIndex = isize;
    type OSStatus = i32;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        static kCFBooleanTrue: CFTypeRef;
        fn CFStringCreateWithBytes(
            alloc: CFTypeRef,
            bytes: *const u8,
            num_bytes: CFIndex,
            encoding: u32,
            is_external_representation: u8,
        ) -> CFStringRef;
        fn CFDictionaryCreate(
            allocator: CFTypeRef,
            keys: *const CFTypeRef,
            values: *const CFTypeRef,
            num_values: CFIndex,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CFDictionaryRef;
        fn CFDataGetLength(data: CFDataRef) -> CFIndex;
        fn CFDataGetBytePtr(data: CFDataRef) -> *const u8;
        fn CFRelease(cf: CFTypeRef);
    }

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecClass: CFStringRef;
        static kSecClassGenericPassword: CFStringRef;
        static kSecAttrService: CFStringRef;
        static kSecAttrAccount: CFStringRef;
        static kSecReturnData: CFStringRef;
        static kSecMatchLimit: CFStringRef;
        static kSecMatchLimitOne: CFStringRef;
        fn SecItemCopyMatching(query: CFDictionaryRef, result: *mut CFTypeRef) -> OSStatus;
    }

    /// Owns one Core Foundation reference and releases it on drop.
    struct Owned(CFTypeRef);

    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: the pointer came from a CF Create/Copy call and is released once.
                unsafe { CFRelease(self.0) };
            }
        }
    }

    fn cf_string(value: &str) -> Result<Owned, KeychainReadError> {
        // SAFETY: the bytes and length describe a valid UTF-8 slice for the call's duration.
        let string = unsafe {
            CFStringCreateWithBytes(
                ptr::null(),
                value.as_ptr(),
                value.len() as CFIndex,
                K_CF_STRING_ENCODING_UTF8,
                0,
            )
        };
        if string.is_null() {
            return Err(KeychainReadError::Other(0));
        }
        Ok(Owned(string))
    }

    pub(super) fn read_generic_password(
        service: &str,
        account: &str,
    ) -> Result<String, KeychainReadError> {
        let service = cf_string(service)?;
        let account = cf_string(account)?;
        // SAFETY: the Security and CoreFoundation constants are immutable
        // framework globals; the dictionary retains every key and value, and
        // each created object is released by its `Owned` guard.
        unsafe {
            let keys: [CFTypeRef; 5] = [
                kSecClass,
                kSecAttrService,
                kSecAttrAccount,
                kSecReturnData,
                kSecMatchLimit,
            ];
            let values: [CFTypeRef; 5] = [
                kSecClassGenericPassword,
                service.0,
                account.0,
                kCFBooleanTrue,
                kSecMatchLimitOne,
            ];
            let query = CFDictionaryCreate(
                ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                keys.len() as CFIndex,
                ptr::addr_of!(kCFTypeDictionaryKeyCallBacks),
                ptr::addr_of!(kCFTypeDictionaryValueCallBacks),
            );
            if query.is_null() {
                return Err(KeychainReadError::Other(0));
            }
            let query = Owned(query);
            let mut result: CFTypeRef = ptr::null();
            let status = SecItemCopyMatching(query.0, &mut result);
            let result = Owned(result);
            if status != 0 {
                return Err(classify_status(status));
            }
            if result.0.is_null() {
                return Err(KeychainReadError::InvalidSecret);
            }
            let length = CFDataGetLength(result.0);
            let bytes = CFDataGetBytePtr(result.0);
            if length <= 0 || bytes.is_null() {
                return Err(KeychainReadError::InvalidSecret);
            }
            secret_from_bytes(std::slice::from_raw_parts(bytes, length as usize))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_consent_failures_as_denied() {
        assert_eq!(classify_status(-128), KeychainReadError::Denied);
        assert_eq!(classify_status(-25293), KeychainReadError::Denied);
        assert_eq!(classify_status(-25308), KeychainReadError::Denied);
        assert_eq!(classify_status(-25300), KeychainReadError::NotFound);
        assert_eq!(classify_status(-50), KeychainReadError::Other(-50));
        assert_eq!(
            KeychainReadError::Denied.error_code(),
            "CHROME_KEYCHAIN_DENIED"
        );
    }

    #[test]
    fn rejects_empty_or_non_utf8_secrets() {
        assert_eq!(secret_from_bytes(b"peanuts").as_deref(), Ok("peanuts"));
        assert_eq!(
            secret_from_bytes(b""),
            Err(KeychainReadError::InvalidSecret)
        );
        assert_eq!(
            secret_from_bytes(&[0xff, 0xfe]),
            Err(KeychainReadError::InvalidSecret)
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn is_unsupported_off_macos() {
        assert_eq!(
            read_chrome_safe_storage_password(),
            Err(KeychainReadError::Unsupported)
        );
    }
}
