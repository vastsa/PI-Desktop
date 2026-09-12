//! Patch language parser (spec 18 §7).

use std::path::PathBuf;

pub const MAX_OPS_BYTES: usize = 256 * 1024;
pub const MAX_OPS_PER_CALL: usize = 200;
pub const MAX_REGISTER_LINES: usize = 4096;
pub const MAX_REGISTER_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Locator {
    Range { start: u32, end: u32 },
    Block { line: u32 },
    Before { line: u32 },
    After { line: u32 },
    End,
    AfterBlock { line: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedOp {
    Put {
        locator: Locator,
        body: Vec<String>,
        register: Option<String>,
    },
    Cut {
        locator: Locator,
        register: Option<String>,
    },
    Rem,
    Mv {
        dest: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedOps {
    pub header_path: Option<String>,
    pub header_tag: Option<String>,
    pub ops: Vec<ParsedOp>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub code: &'static str,
    pub message: String,
}

impl ParseError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub fn parse_ops(ops: &str) -> Result<ParsedOps, ParseError> {
    if ops.len() > MAX_OPS_BYTES {
        return Err(ParseError::new(
            "INVALID_ARGUMENT",
            format!("ops payload exceeds {MAX_OPS_BYTES} bytes"),
        ));
    }
    let mut lines: Vec<&str> = ops.split('\n').collect();
    if ops.ends_with('\n') {
        lines.pop();
    }
    let mut idx = 0;
    let mut header_path = None;
    let mut header_tag = None;
    if let Some(first) = lines.first() {
        if let Some((path, tag)) = super::tag::parse_section_header(first) {
            header_path = Some(path.to_string());
            header_tag = Some(tag.to_uppercase());
            idx = 1;
        }
    }

    let mut parsed = Vec::new();
    while idx < lines.len() {
        let raw = lines[idx];
        if raw.trim().is_empty() {
            idx += 1;
            continue;
        }
        if raw.starts_with('+') || raw.starts_with('-') {
            return Err(ParseError::new(
                "EDIT_PARSE_FAILED",
                format!(
                    "body or context row without a header at op line {}: {raw}",
                    idx + 1
                ),
            ));
        }
        let (op, colon) = parse_header(raw)?;
        idx += 1;
        match op {
            ParsedOp::Put {
                locator, register, ..
            } => {
                if colon {
                    if register.is_some() {
                        return Err(ParseError::new(
                            "EDIT_PARSE_FAILED",
                            "a register paste takes no body rows; drop the trailing colon",
                        ));
                    }
                    let mut body = Vec::new();
                    while idx < lines.len() {
                        let line = lines[idx];
                        if let Some(rest) = line.strip_prefix('+') {
                            body.push(rest.to_string());
                            idx += 1;
                        } else {
                            break;
                        }
                    }
                    if body.is_empty() {
                        return Err(ParseError::new(
                            "EDIT_PARSE_FAILED",
                            "PUT with a colon requires at least one + body row; use CUT to delete",
                        ));
                    }
                    parsed.push(ParsedOp::Put {
                        locator,
                        body,
                        register: None,
                    });
                } else if register.is_none() {
                    let next_non_empty = lines[idx..]
                        .iter()
                        .find(|line| !line.trim().is_empty())
                        .copied();
                    if next_non_empty.is_some_and(|line| line.starts_with('+')) {
                        return Err(ParseError::new(
                            "EDIT_PARSE_FAILED",
                            format!(
                                "PUT header `{raw}` is missing a trailing `:` before + body rows; use `{raw}:`"
                            ),
                        ));
                    }
                    return Err(ParseError::new(
                        "EDIT_PARSE_FAILED",
                        "PUT without a body must paste a register (`PUT <1 @name`)",
                    ));
                } else {
                    parsed.push(ParsedOp::Put {
                        locator,
                        body: Vec::new(),
                        register,
                    });
                }
            }
            other => {
                if colon {
                    return Err(ParseError::new(
                        "EDIT_PARSE_FAILED",
                        "CUT/REM/MV take no body rows",
                    ));
                }
                parsed.push(other);
            }
        }
    }

    if parsed.is_empty() {
        return Err(ParseError::new(
            "EDIT_PARSE_FAILED",
            "ops is empty; supply at least one PUT, CUT, REM, or MV",
        ));
    }
    if parsed.len() > MAX_OPS_PER_CALL {
        return Err(ParseError::new(
            "INVALID_ARGUMENT",
            format!("ops exceeds {MAX_OPS_PER_CALL} operations"),
        ));
    }
    Ok(ParsedOps {
        header_path,
        header_tag,
        ops: parsed,
    })
}

fn parse_header(raw: &str) -> Result<(ParsedOp, bool), ParseError> {
    let line = raw.trim_end_matches('\r');
    let colon = line.ends_with(':');
    let core = if colon {
        line[..line.len() - 1].trim_end()
    } else {
        line.trim_end()
    };
    let mut parts = core.split_whitespace();
    let kind = parts
        .next()
        .ok_or_else(|| ParseError::new("EDIT_PARSE_FAILED", "empty operation header"))?;
    match kind {
        "PUT" => {
            let locator_raw = parts
                .next()
                .ok_or_else(|| ParseError::new("EDIT_PARSE_FAILED", "PUT requires a locator"))?;
            let locator = parse_locator(locator_raw)?;
            let register = match parts.next() {
                Some(token) => Some(parse_register(token)?),
                None => None,
            };
            if parts.next().is_some() {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    format!("unexpected token in PUT header: {raw}"),
                ));
            }
            Ok((
                ParsedOp::Put {
                    locator,
                    body: Vec::new(),
                    register,
                },
                colon,
            ))
        }
        "CUT" => {
            if colon {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    "CUT takes no body; drop the colon",
                ));
            }
            let locator_raw = parts
                .next()
                .ok_or_else(|| ParseError::new("EDIT_PARSE_FAILED", "CUT requires a locator"))?;
            let locator = parse_locator(locator_raw)?;
            let register = match parts.next() {
                Some(token) => Some(parse_register(token)?),
                None => None,
            };
            if parts.next().is_some() {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    format!("unexpected token in CUT header: {raw}"),
                ));
            }
            Ok((ParsedOp::Cut { locator, register }, false))
        }
        "REM" => {
            if colon {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    "REM takes no body; drop the colon",
                ));
            }
            if parts.next().is_some() {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    "REM takes no arguments",
                ));
            }
            Ok((ParsedOp::Rem, false))
        }
        "MV" => {
            if colon {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    "MV takes no body; drop the colon",
                ));
            }
            let rest = core.strip_prefix("MV").unwrap_or("").trim();
            if rest.is_empty() {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    "MV requires a dest path",
                ));
            }
            let dest = parse_dest(rest)?;
            Ok((ParsedOp::Mv { dest }, false))
        }
        other => Err(ParseError::new(
            "EDIT_PARSE_FAILED",
            format!("unknown operation {other}; expected PUT, CUT, REM, or MV"),
        )),
    }
}

fn parse_locator(raw: &str) -> Result<Locator, ParseError> {
    if raw == ">$" {
        return Ok(Locator::End);
    }
    if let Some(rest) = raw.strip_prefix('<') {
        let line = parse_line(rest)?;
        return Ok(Locator::Before { line });
    }
    if let Some(rest) = raw.strip_prefix('>') {
        if let Some(line_raw) = rest.strip_suffix('*') {
            let line = parse_line(line_raw)?;
            return Ok(Locator::AfterBlock { line });
        }
        let line = parse_line(rest)?;
        return Ok(Locator::After { line });
    }
    if let Some(line_raw) = raw.strip_suffix('*') {
        let line = parse_line(line_raw)?;
        return Ok(Locator::Block { line });
    }
    if let Some((start, end)) = raw.split_once(".=") {
        let start = parse_line(start)?;
        let end = parse_line(end)?;
        if start > end {
            return Err(ParseError::new(
                "EDIT_RANGE_INVALID",
                format!("reversed range {start}.={end}"),
            ));
        }
        return Ok(Locator::Range { start, end });
    }
    Err(ParseError::new(
        "EDIT_PARSE_FAILED",
        format!("invalid locator {raw}; expected N.=M, N*, <N, >N, >$, or >N*"),
    ))
}

fn parse_line(raw: &str) -> Result<u32, ParseError> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) || raw.starts_with('0') {
        return Err(ParseError::new(
            "EDIT_PARSE_FAILED",
            format!("line number must be a positive integer, got {raw}"),
        ));
    }
    raw.parse::<u32>().map_err(|_| {
        ParseError::new(
            "EDIT_PARSE_FAILED",
            format!("line number out of range: {raw}"),
        )
    })
}

fn parse_register(raw: &str) -> Result<String, ParseError> {
    let name = raw.strip_prefix('@').ok_or_else(|| {
        ParseError::new(
            "EDIT_PARSE_FAILED",
            format!("register must start with @, got {raw}"),
        )
    })?;
    if name.is_empty()
        || name.len() > 32
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(ParseError::new(
            "EDIT_PARSE_FAILED",
            format!("invalid register name {raw}"),
        ));
    }
    Ok(name.to_string())
}

fn parse_dest(raw: &str) -> Result<String, ParseError> {
    let dest = if (raw.starts_with('"') && raw.ends_with('"'))
        || (raw.starts_with('\'') && raw.ends_with('\''))
    {
        raw[1..raw.len() - 1].to_string()
    } else {
        raw.to_string()
    };
    if dest.is_empty() {
        return Err(ParseError::new("EDIT_PARSE_FAILED", "MV dest is empty"));
    }
    let path = PathBuf::from(&dest);
    if path.as_os_str().is_empty() {
        return Err(ParseError::new("EDIT_PARSE_FAILED", "MV dest is empty"));
    }
    Ok(dest)
}

#[allow(dead_code)]
pub fn mv_dest(ops: &ParsedOps) -> Option<&str> {
    ops.ops.iter().find_map(|op| match op {
        ParsedOp::Mv { dest } => Some(dest.as_str()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_range_put_and_gap_insert() {
        let parsed = parse_ops("PUT 2.=3:\n+new two\n+new three\nPUT >$:\n+tail\n").unwrap();
        assert_eq!(parsed.ops.len(), 2);
        match &parsed.ops[0] {
            ParsedOp::Put { locator, body, .. } => {
                assert_eq!(locator, &Locator::Range { start: 2, end: 3 });
                assert_eq!(body, &["new two".to_string(), "new three".to_string()]);
            }
            other => panic!("{other:?}"),
        }
        match &parsed.ops[1] {
            ParsedOp::Put { locator, body, .. } => {
                assert_eq!(locator, &Locator::End);
                assert_eq!(body, &["tail".to_string()]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn rejects_minus_rows_and_empty_put() {
        assert_eq!(
            parse_ops("PUT 1.=1:\n-old\n+new\n").unwrap_err().code,
            "EDIT_PARSE_FAILED"
        );
        assert_eq!(
            parse_ops("PUT 1.=1:\n").unwrap_err().code,
            "EDIT_PARSE_FAILED"
        );
        assert_eq!(
            parse_ops("PUT 1.=1\n").unwrap_err().message,
            "PUT without a body must paste a register (`PUT <1 @name`)"
        );
    }

    #[test]
    fn explains_missing_put_body_delimiter() {
        let error = parse_ops("PUT 48.=48\n+replacement\n").unwrap_err();

        assert_eq!(error.code, "EDIT_PARSE_FAILED");
        assert_eq!(
            error.message,
            "PUT header `PUT 48.=48` is missing a trailing `:` before + body rows; use `PUT 48.=48:`"
        );
    }

    #[test]
    fn parses_cut_rem_mv_and_optional_header() {
        let parsed = parse_ops("[src/a.rs#AB12]\nCUT 4.=5\nMV dest.rs\n").unwrap();
        assert_eq!(parsed.header_path.as_deref(), Some("src/a.rs"));
        assert_eq!(parsed.header_tag.as_deref(), Some("AB12"));
        assert!(matches!(parsed.ops[0], ParsedOp::Cut { .. }));
        assert!(matches!(parsed.ops[1], ParsedOp::Mv { .. }));
        assert!(matches!(parse_ops("REM\n").unwrap().ops[0], ParsedOp::Rem));
    }
}
