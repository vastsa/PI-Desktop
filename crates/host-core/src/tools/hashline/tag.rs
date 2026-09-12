//! Whole-file 4-hex tags (ADR 0087 / spec 18 §3).
//!
//! `tag(text) = uppercase_hex_4(low_16_bits(SHA-256(normalize_for_hash(text))))`.

use sha2::{Digest, Sha256};

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

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
    pub bom: bool,
}

pub fn decode_bytes(bytes: &[u8]) -> (bool, String) {
    let bom = bytes.starts_with(UTF8_BOM);
    let rest = if bom { &bytes[3..] } else { bytes };
    (bom, String::from_utf8_lossy(rest).into_owned())
}

pub fn detect_ending(text: &str) -> LineEnding {
    let crlf = text.matches("\r\n").count();
    let lf_only = text.matches('\n').count().saturating_sub(crlf);
    if crlf > lf_only {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    }
}

pub fn to_lf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

pub fn normalize_file(bytes: &[u8]) -> NormalizedFile {
    let (bom, decoded) = decode_bytes(bytes);
    let ending = detect_ending(&decoded);
    NormalizedFile {
        text: to_lf(&decoded),
        ending,
        bom,
    }
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

fn rtrim_hash_line(line: &str) -> &str {
    line.trim_end_matches([' ', '\t', '\r'])
}

/// Hash input: each line with trailing `[ \t\r]` stripped, joined by LF.
pub fn hash_input(lf_text: &str) -> String {
    if lf_text.is_empty() {
        return String::new();
    }
    let ends_with_nl = lf_text.ends_with('\n');
    let mut out = String::with_capacity(lf_text.len());
    for (i, line) in lf_text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(rtrim_hash_line(line));
    }
    if !ends_with_nl && out.ends_with('\n') {
        // split on a non-terminated string never yields a trailing empty
        // piece, so this only fires for the empty-last-line case which
        // already ended with `\n`. Keep the terminator from split.
    }
    let _ = ends_with_nl;
    out
}

pub fn tag_of_hash_input(hash_input: &str) -> String {
    let digest = Sha256::digest(hash_input.as_bytes());
    let low = u16::from_be_bytes([digest[30], digest[31]]);
    format!("{low:04X}")
}

pub fn tag_of_lf_text(lf_text: &str) -> String {
    tag_of_hash_input(&hash_input(lf_text))
}

pub fn encode_bytes(lf_text: &str, ending: LineEnding, bom: bool) -> Vec<u8> {
    let body = match ending {
        LineEnding::Lf => lf_text.to_string(),
        LineEnding::Crlf => lf_text.replace('\n', "\r\n"),
    };
    if !bom {
        return body.into_bytes();
    }
    let mut out = Vec::with_capacity(3 + body.len());
    out.extend_from_slice(UTF8_BOM);
    out.extend_from_slice(body.as_bytes());
    out
}

pub fn looks_binary_bytes(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(4096)];
    if sample.contains(&0) {
        return true;
    }
    let non_printable = sample
        .iter()
        .filter(|byte| **byte < 9 || (**byte > 13 && **byte < 32))
        .count();
    non_printable * 10 > sample.len() * 3
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
        assert_eq!(encode_bytes("hi\n", LineEnding::Lf, true), raw);
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
