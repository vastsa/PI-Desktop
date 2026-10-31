//! Header-only pixel size probe for images Read inlines (issue #1913).
//!
//! A provider rejects an image whose pixel size is too large with a
//! non-retriable 400 even when its bytes are small (a 780 x 14182 full-page
//! screenshot). Once Read returns such an image it is persisted and replayed on
//! every later request, so Read refuses it up front. Mirrors
//! `packages/shared/src/image-dimensions.ts`; no image decoder is needed.

/// Longest edge, in pixels, an inlined image may have. Matches
/// `MAX_INLINE_IMAGE_EDGE_PX` in `packages/shared/src/image-dimensions.ts`.
pub(crate) const MAX_INLINE_IMAGE_EDGE_PX: u32 = 8000;

fn u16_be(bytes: &[u8], offset: usize) -> Option<u32> {
    let pair = bytes.get(offset..offset + 2)?;
    Some(u32::from(u16::from_be_bytes([pair[0], pair[1]])))
}

fn u16_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let pair = bytes.get(offset..offset + 2)?;
    Some(u32::from(u16::from_le_bytes([pair[0], pair[1]])))
}

fn u24_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let triple = bytes.get(offset..offset + 3)?;
    Some(u32::from_le_bytes([triple[0], triple[1], triple[2], 0]))
}

fn u32_be(bytes: &[u8], offset: usize) -> Option<u32> {
    let quad = bytes.get(offset..offset + 4)?;
    Some(u32::from_be_bytes([quad[0], quad[1], quad[2], quad[3]]))
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(12..16)? != b"IHDR" {
        return None;
    }
    Some((u32_be(bytes, 16)?, u32_be(bytes, 20)?))
}

fn gif_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    Some((u16_le(bytes, 6)?, u16_le(bytes, 8)?))
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    match bytes.get(12..16)? {
        b"VP8X" => Some((u24_le(bytes, 24)? + 1, u24_le(bytes, 27)? + 1)),
        b"VP8L" if bytes.get(20) == Some(&0x2f) => {
            let bits = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        b"VP8 " if bytes.get(23..26)? == [0x9d, 0x01, 0x2a] => {
            Some((u16_le(bytes, 26)? & 0x3fff, u16_le(bytes, 28)? & 0x3fff))
        }
        _ => None,
    }
}

/// Walk JPEG marker segments up to the first start-of-frame header.
fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut offset = 2;
    loop {
        if *bytes.get(offset)? != 0xff {
            return None;
        }
        let marker = *bytes.get(offset + 1)?;
        match marker {
            0xff => offset += 1,
            0x01 | 0xd0..=0xd7 => offset += 2,
            // Entropy-coded data starts without a frame header: nothing to read.
            0xd9 | 0xda => return None,
            0xc0..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => {
                return Some((u16_be(bytes, offset + 7)?, u16_be(bytes, offset + 5)?));
            }
            _ => {
                let length = u16_be(bytes, offset + 2)? as usize;
                if length < 2 {
                    return None;
                }
                offset += 2 + length;
            }
        }
    }
}

/// `(width, height)` from a PNG, JPEG, GIF, or WebP header, or `None` when the
/// bytes are not a recognized image or the header is cut short.
pub(crate) fn probe_image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        png_dimensions(bytes)
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        jpeg_dimensions(bytes)
    } else if bytes.starts_with(b"GIF8") {
        gif_dimensions(bytes)
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        webp_dimensions(bytes)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes.extend([8, 2, 0, 0, 0]);
        bytes
    }

    #[test]
    fn reads_png_gif_and_jpeg_headers() {
        assert_eq!(probe_image_dimensions(&png(780, 14182)), Some((780, 14182)));
        let gif = [b"GIF89a".as_slice(), &[0x40, 0x01, 0xc8, 0x00, 0, 0, 0]].concat();
        assert_eq!(probe_image_dimensions(&gif), Some((320, 200)));
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0];
        jpeg.extend([0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0xea, 0x06, 0x98, 0x03]);
        assert_eq!(probe_image_dimensions(&jpeg), Some((1688, 1514)));
    }

    #[test]
    fn reads_webp_headers() {
        let mut vp8x = b"RIFF\x00\x00\x00\x00WEBPVP8X".to_vec();
        vp8x.extend([0; 8]);
        vp8x.extend([0x0b, 0x03, 0x00, 0x65, 0x37, 0x00]);
        assert_eq!(probe_image_dimensions(&vp8x), Some((780, 14182)));
        let bits: u32 = (780 - 1) | ((1000 - 1) << 14);
        let mut vp8l = b"RIFF\x00\x00\x00\x00WEBPVP8L\x00\x00\x00\x00\x2f".to_vec();
        vp8l.extend(bits.to_le_bytes());
        assert_eq!(probe_image_dimensions(&vp8l), Some((780, 1000)));
        let mut vp8 = b"RIFF\x00\x00\x00\x00WEBPVP8 ".to_vec();
        vp8.extend([
            0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x0c, 0x03, 0xe8, 0x03,
        ]);
        assert_eq!(probe_image_dimensions(&vp8), Some((780, 1000)));
    }

    #[test]
    fn unknown_or_truncated_headers_have_no_dimensions() {
        assert_eq!(probe_image_dimensions(b"plain text"), None);
        assert_eq!(probe_image_dimensions(&png(10, 10)[..20]), None);
        assert_eq!(probe_image_dimensions(b"\xff\xd8\xff\xda\x00\x02"), None);
        assert_eq!(probe_image_dimensions(b"\xff\xd8\xffgarbage"), None);
    }
}
