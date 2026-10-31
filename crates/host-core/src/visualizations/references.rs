//! Visualization reference identities and Markdown boundaries. Forks resolve
//! the trailing session/file identity, never the historical data-dir prefix.
//! Keep the syntax aligned with packages/shared/src/gen-ui.ts.

use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

/// Locate exactly one safe direct-child fragment, independently of Unix,
/// Windows, relocated, or aliased data-directory spelling.
fn location(path: &str) -> Option<(String, String)> {
    let normalized = path.replace('\\', "/");
    let mut parts = normalized.split('/').filter(|part| !part.is_empty()).rev();
    let file = parts.next()?;
    let session = parts.next()?;
    if parts.next()? != "visualizations"
        || session.len() > 128
        || !super::safe_session_id(session)
        || !super::is_fragment_path(Path::new(file))
    {
        return None;
    }
    Some((session.to_owned(), file.to_owned()))
}

fn parse_json(json: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str(json) {
        return Some(value);
    }
    // Match the renderer's retry for models emitting unescaped Windows paths.
    // Preserve existing escaped quotes, slashes, and backslash pairs.
    let mut escaped = String::with_capacity(json.len());
    let mut chars = json.chars().peekable();
    while let Some(ch) = chars.next() {
        escaped.push(ch);
        if ch != '\\' {
            continue;
        }
        match chars.peek() {
            Some('"' | '\\' | '/') => escaped.push(chars.next()?),
            _ => escaped.push('\\'),
        }
    }
    serde_json::from_str(&escaped).ok()
}

fn rewrite_line(line: &str, source_id: &str, file_name: &str, target: &str) -> Option<String> {
    let trimmed = line.trim();
    let json = trimmed.strip_prefix("::visualize")?;
    if !json.starts_with('{') || !json.ends_with('}') {
        return None;
    }
    let mut value = parse_json(json)?;
    let path = value.as_object_mut()?.get_mut("path")?;
    let (session, file) = location(path.as_str()?)?;
    if session != source_id || file != file_name {
        return None;
    }
    *path = Value::String(target.to_owned());
    let encoded = serde_json::to_string(&value).ok()?;
    let prefix_len = line.len() - line.trim_start().len();
    let suffix_start = line.trim_end().len();
    Some(format!(
        "{}::visualize{encoded}{}",
        &line[..prefix_len],
        &line[suffix_start..]
    ))
}

fn fence_marker(line: &str) -> Option<(char, usize, &str)> {
    let spaces = line.bytes().take_while(|byte| *byte == b' ').count();
    if spaces > 3 {
        return None;
    }
    let line = &line[spaces..];
    let marker = line.chars().next()?;
    if !matches!(marker, '`' | '~') {
        return None;
    }
    let length = line.chars().take_while(|ch| *ch == marker).count();
    (length >= 3).then_some((marker, length, &line[length..]))
}

/// Rewrite only real standalone directives, not prose paths, indented code,
/// or arbitrary fenced examples. The renderer also accepts a final fenced
/// block consisting of exactly one reference; preserve that compatibility.
/// JSON encoding of the child path is identical on every platform.
pub(crate) fn rewrite(text: &mut String, source_id: &str, file_name: &str, target: &str) -> bool {
    if !text.contains("::visualize") {
        return false;
    }
    let lines: Vec<_> = text.split_inclusive('\n').collect();
    let mut eligible = HashSet::new();
    let mut fence: Option<(char, usize, usize)> = None;
    let mut last_block = None;
    for (index, line) in lines.iter().enumerate() {
        let marker = fence_marker(line);
        if let Some((open_marker, open_length, open_index)) = fence {
            if marker.is_some_and(|(marker, length, rest)| {
                marker == open_marker && length >= open_length && rest.trim().is_empty()
            }) {
                last_block = Some((open_index, index));
                fence = None;
            }
            continue;
        }
        if let Some((marker, length, rest)) = marker {
            if marker != '`' || !rest.contains('`') {
                fence = Some((marker, length, index));
                continue;
            }
        }
        if !line.starts_with("    ") && !line.starts_with('\t') {
            eligible.insert(index);
        }
    }
    if fence.is_none() {
        if let Some((open, close)) = last_block {
            if close == open + 2 && lines[close + 1..].iter().all(|line| line.trim().is_empty()) {
                eligible.insert(open + 1);
            }
        }
    }
    let mut output = String::with_capacity(text.len());
    let mut changed = false;
    for (index, line) in lines.iter().enumerate() {
        if eligible.contains(&index) {
            if let Some(rewritten) = rewrite_line(line, source_id, file_name, target) {
                output.push_str(&rewritten);
                changed = true;
                continue;
            }
        }
        output.push_str(line);
    }
    if changed {
        *text = output;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reference_identity_ignores_prefix_and_requires_a_safe_session_and_file() {
        for path in [
            "/retired/visualizations/source/chart.html",
            r"C:\profile\visualizations\source\chart.html",
        ] {
            assert_eq!(location(path), Some(("source".into(), "chart.html".into())));
        }
        for path in [
            "/x/visualizations/source/sub/chart.html",
            "/x/visualizations/source/../chart.html",
            "/x/visualizations/source/a..b.html",
            "/x/visualizations/source/.hidden.html",
            "/x/visualizations/source/chart.HTML",
        ] {
            assert!(location(path).is_none(), "{path}");
        }
    }

    #[test]
    fn json_paths_are_escaped_consistently_for_windows_and_unix() {
        for source in [
            "/old/visualizations/source/chart.html",
            r"C:\old\visualizations\source\chart.html",
        ] {
            for target in [
                "/new/visualizations/child/chart.html",
                r"C:\new\visualizations\child\chart.html",
            ] {
                let mut text = format!(
                    "  ::visualize{} \r\n",
                    json!({"path": source, "title": "Chart"})
                );
                assert!(rewrite(&mut text, "source", "chart.html", target));
                let value: Value =
                    serde_json::from_str(text.trim().strip_prefix("::visualize").unwrap()).unwrap();
                assert_eq!(value["path"], target);
                assert_eq!(value["title"], "Chart");
                assert!(text.starts_with("  ::visualize"));
                assert!(text.ends_with(" \r\n"));
            }
        }
        let mut unescaped =
            r#"::visualize{"path":"C:\old\visualizations\source\chart.html"}"#.to_string();
        assert!(rewrite(
            &mut unescaped,
            "source",
            "chart.html",
            "/new/visualizations/child/chart.html"
        ));
        assert_eq!(
            unescaped,
            r#"::visualize{"path":"/new/visualizations/child/chart.html"}"#
        );
    }

    #[test]
    fn markdown_boundaries_and_foreign_sessions_are_preserved() {
        let reference = r#"::visualize{"path":"/old/visualizations/source/chart.html"}"#;
        for original in [
            format!("```json\n{reference}\n```\nExample only."),
            format!("~~~\n{reference}\n~~~\nExample only."),
            format!("    {reference}"),
            format!("\t{reference}"),
            format!("`{reference}`"),
            reference.replace("source/", "foreign/"),
            reference.replace("chart.html", "chart.html.bak"),
        ] {
            let mut text = original.clone();
            assert!(!rewrite(
                &mut text,
                "source",
                "chart.html",
                "/child/chart.html"
            ));
            assert_eq!(text, original);
        }
        let mut final_fence = format!("Chart:\n````json\n{reference}\n````\n");
        assert!(rewrite(
            &mut final_fence,
            "source",
            "chart.html",
            "/new/visualizations/child/chart.html"
        ));
        assert!(final_fence.starts_with("Chart:\n````json\n::visualize"));
        assert!(final_fence.ends_with("\n````\n"));
    }
}
