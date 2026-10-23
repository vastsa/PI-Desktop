//! Whole-file 4-hex tags (ADR 0087 / spec 18 §3).
//!
//! `tag(text) = uppercase_hex_4(low_16_bits(SHA-256(normalize_for_hash(text))))`.

use crate::tools::cancel::{Cancelled, ToolCancellation};
use sha2::{Digest, Sha256};
use std::convert::Infallible;

const CHECK_CHUNK: usize = 64 * 1024;

fn unchecked<T>(result: Result<T, Infallible>) -> T {
    match result {
        Ok(value) => value,
        Err(never) => match never {},
    }
}

fn text_chunks<E>(
    text: &str,
    check: &mut impl FnMut() -> Result<(), E>,
    mut consume: impl FnMut(&str),
) -> Result<(), E> {
    let mut start = 0;
    while start < text.len() {
        check()?;
        let mut end = (start + CHECK_CHUNK).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        consume(&text[start..end]);
        start = end;
    }
    check()
}

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
const UTF16LE_BOM: &[u8] = &[0xFF, 0xFE];
const UTF16BE_BOM: &[u8] = &[0xFE, 0xFF];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    Crlf,
}

impl LineEnding {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lf => "\n",
            Self::Crlf => "\r\n",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedFile {
    /// LF-normalized text, BOM stripped, original trailing whitespace kept.
    pub text: String,
    pub ending: LineEnding,
    /// Whether a UTF-8 BOM was present.
    pub bom: bool,
    /// Byte order for BOM-marked UTF-16: true for little endian, false for big endian.
    pub utf16: Option<bool>,
}

fn decode_bytes_checked<E>(
    bytes: &[u8],
    check: &mut impl FnMut() -> Result<(), E>,
) -> Result<(bool, String), E> {
    check()?;
    if bytes.starts_with(UTF16LE_BOM) || bytes.starts_with(UTF16BE_BOM) {
        let little_endian = bytes.starts_with(UTF16LE_BOM);
        let body = &bytes[2..];
        let units = body.as_chunks::<2>().0.iter().map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        });
        let mut decoded = String::new();
        for (index, character) in std::char::decode_utf16(units).enumerate() {
            if index % (CHECK_CHUNK / 4) == 0 {
                check()?;
            }
            decoded.push(character.unwrap_or(char::REPLACEMENT_CHARACTER));
        }
        check()?;
        return Ok((false, decoded));
    }
    let bom = bytes.starts_with(UTF8_BOM);
    let rest = if bom { &bytes[3..] } else { bytes };
    let mut decoded = String::new();
    let mut start = 0;
    while start < rest.len() {
        check()?;
        let mut end = (start + CHECK_CHUNK).min(rest.len());
        if end < rest.len() {
            // Keep an incomplete UTF-8 suffix for the next chunk, including
            // when an earlier invalid sequence requires lossy decoding.
            for tail in end.saturating_sub(3).max(start)..end {
                if std::str::from_utf8(&rest[tail..end])
                    .is_err_and(|error| error.valid_up_to() == 0 && error.error_len().is_none())
                {
                    end = tail;
                    break;
                }
            }
        }
        decoded.push_str(&String::from_utf8_lossy(&rest[start..end]));
        start = end;
    }
    check()?;
    Ok((bom, decoded))
}

fn detect_ending_checked<E>(
    text: &str,
    check: &mut impl FnMut() -> Result<(), E>,
) -> Result<LineEnding, E> {
    let (mut crlf, mut lf, mut previous_cr) = (0_usize, 0_usize, false);
    text_chunks(text, check, |chunk| {
        for byte in chunk.bytes() {
            if byte == b'\n' {
                lf += 1;
                crlf += usize::from(previous_cr);
            }
            previous_cr = byte == b'\r';
        }
    })?;
    Ok(if crlf > lf.saturating_sub(crlf) {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    })
}

fn to_lf_checked<E>(text: &str, check: &mut impl FnMut() -> Result<(), E>) -> Result<String, E> {
    let mut out = String::new();
    let mut previous_cr = false;
    text_chunks(text, check, |chunk| {
        for character in chunk.chars() {
            if !(previous_cr && character == '\n') {
                out.push(if character == '\r' { '\n' } else { character });
            }
            previous_cr = character == '\r';
        }
    })?;
    Ok(out)
}

pub fn normalize_file(bytes: &[u8]) -> NormalizedFile {
    unchecked(normalize_file_checked(bytes, &mut || Ok(())))
}

pub(super) fn normalize_file_cancellable(
    bytes: &[u8],
    cancellation: &ToolCancellation,
) -> Result<NormalizedFile, Cancelled> {
    normalize_file_checked(bytes, &mut || cancellation.check())
}

fn normalize_file_checked<E>(
    bytes: &[u8],
    check: &mut impl FnMut() -> Result<(), E>,
) -> Result<NormalizedFile, E> {
    let (bom, decoded) = decode_bytes_checked(bytes, check)?;
    let utf16 = if bytes.starts_with(UTF16LE_BOM) {
        Some(true)
    } else if bytes.starts_with(UTF16BE_BOM) {
        Some(false)
    } else {
        None
    };
    let ending = detect_ending_checked(&decoded, check)?;
    Ok(NormalizedFile {
        text: to_lf_checked(&decoded, check)?,
        ending,
        bom,
        utf16,
    })
}

pub fn split_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    if text.ends_with('\n') {
        lines.pop();
    }
    lines
}

pub fn join_lines(lines: &[String], trailing_newline: bool) -> String {
    if lines.is_empty() {
        return if trailing_newline {
            "\n".into()
        } else {
            String::new()
        };
    }
    let mut out = lines.join("\n");
    if trailing_newline {
        out.push('\n');
    }
    out
}

/// Hash input: each line with trailing `[ \t\r]` stripped, joined by LF.
pub fn hash_input(lf_text: &str) -> String {
    unchecked(hash_input_checked(lf_text, &mut || Ok(())))
}

fn hash_input_checked<E>(
    lf_text: &str,
    check: &mut impl FnMut() -> Result<(), E>,
) -> Result<String, E> {
    let mut out = String::new();
    let mut kept = 0;
    text_chunks(lf_text, check, |chunk| {
        for character in chunk.chars() {
            if character == '\n' {
                out.truncate(kept);
                out.push('\n');
                kept = out.len();
            } else {
                out.push(character);
                if !matches!(character, ' ' | '\t' | '\r') {
                    kept = out.len();
                }
            }
        }
    })?;
    out.truncate(kept);
    Ok(out)
}

pub fn tag_of_hash_input(hash_input: &str) -> String {
    unchecked(tag_of_hash_input_checked(hash_input, &mut || Ok(())))
}

fn tag_of_hash_input_checked<E>(
    hash_input: &str,
    check: &mut impl FnMut() -> Result<(), E>,
) -> Result<String, E> {
    let mut hasher = Sha256::new();
    for chunk in hash_input.as_bytes().chunks(CHECK_CHUNK) {
        check()?;
        hasher.update(chunk);
    }
    check()?;
    let digest = hasher.finalize();
    let low = u16::from_be_bytes([digest[30], digest[31]]);
    Ok(format!("{low:04X}"))
}

pub fn tag_of_lf_text(lf_text: &str) -> String {
    tag_of_hash_input(&hash_input(lf_text))
}

pub(super) fn tag_of_lf_text_cancellable(
    lf_text: &str,
    cancellation: &ToolCancellation,
) -> Result<String, Cancelled> {
    let mut check = || cancellation.check();
    tag_of_hash_input_checked(&hash_input_checked(lf_text, &mut check)?, &mut check)
}

pub fn encode_bytes(lf_text: &str, ending: LineEnding, bom: bool, utf16: Option<bool>) -> Vec<u8> {
    let body = match ending {
        LineEnding::Lf => lf_text.to_string(),
        LineEnding::Crlf => lf_text.replace('\n', "\r\n"),
    };
    if let Some(little_endian) = utf16 {
        let mut out = if little_endian {
            UTF16LE_BOM.to_vec()
        } else {
            UTF16BE_BOM.to_vec()
        };
        for unit in body.encode_utf16() {
            out.extend(if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        return out;
    }
    if !bom {
        return body.into_bytes();
    }
    let mut out = Vec::with_capacity(3 + body.len());
    out.extend_from_slice(UTF8_BOM);
    out.extend_from_slice(body.as_bytes());
    out
}

pub fn looks_binary_bytes(bytes: &[u8]) -> bool {
    unchecked(looks_binary_bytes_checked(bytes, &mut || Ok(())))
}

pub(super) fn looks_binary_bytes_cancellable(
    bytes: &[u8],
    cancellation: &ToolCancellation,
) -> Result<bool, Cancelled> {
    looks_binary_bytes_checked(bytes, &mut || cancellation.check())
}

fn looks_binary_bytes_checked<E>(
    bytes: &[u8],
    check: &mut impl FnMut() -> Result<(), E>,
) -> Result<bool, E> {
    check()?;
    if bytes.starts_with(UTF16LE_BOM) || bytes.starts_with(UTF16BE_BOM) {
        let little_endian = bytes.starts_with(UTF16LE_BOM);
        let body = &bytes[2..];
        if !body.len().is_multiple_of(2) {
            return Ok(true);
        }
        for (index, character) in
            std::char::decode_utf16(body.as_chunks::<2>().0.iter().map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            }))
            .enumerate()
        {
            if index % (CHECK_CHUNK / 4) == 0 {
                check()?;
            }
            if character.is_err() || character.is_ok_and(|c| c == '\0') {
                return Ok(true);
            }
        }
        check()?;
        return Ok(false);
    }
    let sample = &bytes[..bytes.len().min(4096)];
    if sample.contains(&0) {
        return Ok(true);
    }
    let non_printable = sample
        .iter()
        .filter(|byte| **byte < 9 || (**byte > 13 && **byte < 32))
        .count();
    Ok(non_printable * 10 > sample.len() * 3)
}

pub fn section_header(path: &str, tag: &str) -> String {
    format!("[{path}#{tag}]")
}

pub fn parse_section_header(line: &str) -> Option<(&str, &str)> {
    let line = line.trim_end_matches(['\r', '\n']);
    let rest = line.strip_prefix('[')?.strip_suffix(']')?;
    let (path, tag) = rest.rsplit_once('#')?;
    if tag.len() == 4 && tag.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some((path, tag))
    } else {
        None
    }
}

pub fn strip_line_prefix(line: &str) -> Option<&str> {
    let (num, rest) = line.split_once(':')?;
    if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(rest)
}

/// Strip a pasted Read window (`[path#TAG]` + `N:` prefixes) from Write content.
pub fn strip_write_markup(content: &str) -> String {
    let trailing_nl = content.ends_with('\n');
    let mut lines: Vec<&str> = content.split('\n').collect();
    if trailing_nl {
        lines.pop();
    }
    if lines.is_empty() {
        return content.to_string();
    }
    let mut start = 0;
    if parse_section_header(lines[0]).is_some() {
        start = 1;
    }
    let body = &lines[start..];
    if start == 0 {
        return content.to_string();
    }
    let mut out_lines: Vec<String> = Vec::with_capacity(body.len());
    for line in body {
        match strip_line_prefix(line) {
            Some(rest) => out_lines.push(rest.to_string()),
            None => out_lines.push((*line).to_string()),
        }
    }
    join_lines(&out_lines, trailing_nl)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_is_four_uppercase_hex_and_stable() {
        let tag = tag_of_lf_text("hello\n");
        assert_eq!(tag.len(), 4);
        assert!(tag
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_lowercase()));
        assert_eq!(tag, tag_of_lf_text("hello\n"));
        assert_ne!(tag, tag_of_lf_text("hello"));
    }

    #[test]
    fn hash_ignores_trailing_line_whitespace_and_crlf() {
        let lf = tag_of_lf_text("a  \nb\t\n");
        let crlf = tag_of_lf_text(&normalize_file(b"a  \r\nb\t\r\n").text);
        assert_eq!(lf, crlf);
        assert_eq!(lf, tag_of_lf_text("a\nb\n"));
    }

    #[test]
    fn bom_is_stripped_for_the_tag_and_restored_on_encode() {
        let mut raw = Vec::from(UTF8_BOM);
        raw.extend_from_slice(b"hi\n");
        let file = normalize_file(&raw);
        assert!(file.bom);
        assert_eq!(file.text, "hi\n");
        assert_eq!(tag_of_lf_text(&file.text), tag_of_lf_text("hi\n"));
        assert_eq!(encode_bytes("hi\n", LineEnding::Lf, true, None), raw);
    }

    #[test]
    fn split_and_join_round_trip_trailing_newline() {
        assert!(split_lines("").is_empty());
        assert_eq!(split_lines("a\nb\n"), vec!["a", "b"]);
        assert_eq!(split_lines("a\nb"), vec!["a", "b"]);
        assert_eq!(split_lines("\n"), vec![""]);
        assert_eq!(join_lines(&["a".into(), "b".into()], true), "a\nb\n");
        assert_eq!(join_lines(&["a".into(), "b".into()], false), "a\nb");
        assert_eq!(join_lines(&[], true), "\n");
        assert_eq!(join_lines(&[], false), "");
    }

    #[test]
    fn strip_write_markup_drops_header_and_line_numbers() {
        let pasted = "[src/main.rs#A1B2]\n1:fn main() {\n2:    println!(\"hi\");\n3:}\n";
        assert_eq!(
            strip_write_markup(pasted),
            "fn main() {\n    println!(\"hi\");\n}\n"
        );
        assert_eq!(strip_write_markup("plain\ntext\n"), "plain\ntext\n");
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;

    #[test]
    fn every_large_tag_transformation_observes_cancellation() {
        let text = "x \t\r\n".repeat(CHECK_CHUNK);
        assert_eq!(
            decode_bytes_checked(text.as_bytes(), &mut || ToolCancellation::cancel_after(0)
                .check()),
            Err(Cancelled)
        );
        let cancel = ToolCancellation::cancel_after(2);
        assert_eq!(
            normalize_file_cancellable(text.as_bytes(), &cancel),
            Err(Cancelled)
        );
        let cancel = ToolCancellation::cancel_after(2);
        assert_eq!(
            detect_ending_checked(&text, &mut || cancel.check()),
            Err(Cancelled)
        );
        let cancel = ToolCancellation::cancel_after(2);
        assert_eq!(to_lf_checked(&text, &mut || cancel.check()), Err(Cancelled));
        let cancel = ToolCancellation::cancel_after(2);
        assert_eq!(
            hash_input_checked(&text, &mut || cancel.check()),
            Err(Cancelled)
        );
        let cancel = ToolCancellation::cancel_after(2);
        assert_eq!(
            tag_of_hash_input_checked(&text, &mut || cancel.check()),
            Err(Cancelled)
        );
        let utf16 = encode_bytes(&text, LineEnding::Lf, false, Some(true));
        let cancel = ToolCancellation::cancel_after(2);
        assert_eq!(
            looks_binary_bytes_cancellable(&utf16, &cancel),
            Err(Cancelled)
        );
    }

    #[test]
    fn chunked_tags_match_the_original_algorithm_at_encoding_boundaries() {
        for padding in CHECK_CHUNK - 4..CHECK_CHUNK + 4 {
            let text = format!("{}é😀\r\nnext \t\rline\n  ", "x".repeat(padding));
            let mut samples = vec![
                text.as_bytes().to_vec(),
                [UTF8_BOM, text.as_bytes()].concat(),
            ];
            let mut lossy = text.as_bytes().to_vec();
            lossy.insert(4, 0xFF);
            lossy.extend_from_slice(&[0xE2, 0x82]);
            samples.push(lossy);
            for little_endian in [true, false] {
                samples.push(encode_bytes(
                    &text,
                    LineEnding::Lf,
                    false,
                    Some(little_endian),
                ));
            }
            for bytes in samples {
                let (bom, utf16, decoded) =
                    if bytes.starts_with(UTF16LE_BOM) || bytes.starts_with(UTF16BE_BOM) {
                        let little = bytes.starts_with(UTF16LE_BOM);
                        let units: Vec<_> = bytes[2..]
                            .as_chunks::<2>()
                            .0
                            .iter()
                            .map(|p| {
                                if little {
                                    u16::from_le_bytes([p[0], p[1]])
                                } else {
                                    u16::from_be_bytes([p[0], p[1]])
                                }
                            })
                            .collect();
                        (false, Some(little), String::from_utf16_lossy(&units))
                    } else {
                        let bom = bytes.starts_with(UTF8_BOM);
                        (
                            bom,
                            None,
                            String::from_utf8_lossy(if bom { &bytes[3..] } else { &bytes })
                                .into_owned(),
                        )
                    };
                let crlf = decoded.matches("\r\n").count();
                let ending = if crlf > decoded.matches('\n').count() - crlf {
                    LineEnding::Crlf
                } else {
                    LineEnding::Lf
                };
                let normalized = decoded.replace("\r\n", "\n").replace('\r', "\n");
                let file = normalize_file(&bytes);
                assert!(
                    file == NormalizedFile {
                        text: normalized.clone(),
                        ending,
                        bom,
                        utf16
                    },
                    "normalization changed at {padding}"
                );
                let hash_input = normalized
                    .split('\n')
                    .map(|line| line.trim_end_matches([' ', '\t', '\r']))
                    .collect::<Vec<_>>()
                    .join("\n");
                let digest = Sha256::digest(hash_input.as_bytes());
                let expected = format!("{:04X}", u16::from_be_bytes([digest[30], digest[31]]));
                assert_eq!(tag_of_lf_text(&file.text), expected);
                assert_eq!(
                    tag_of_lf_text_cancellable(&file.text, &ToolCancellation::from_receiver(None))
                        .unwrap(),
                    expected
                );
            }
        }
    }
}
