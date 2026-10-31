//! Upgrade one self-contained legacy file before appending to it. Conversion is
//! streaming and independently atomic per file; readers never mutate history.
use super::*;

fn current_header(value: &Value) -> Result<bool> {
    if !matches!(
        value.get("type").and_then(Value::as_str),
        Some("session" | "storage")
    ) {
        return Ok(false);
    }
    match value.get("schema").and_then(Value::as_i64) {
        Some(1) => Ok(false),
        None if value["type"] == "session" => Ok(false),
        Some(TRANSCRIPT_SCHEMA) => Ok(true),
        _ => Err(anyhow!("unsupported transcript storage schema")),
    }
}

pub(super) fn validate_header(path: &Path) -> Result<()> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("open transcript storage header"),
    };
    let mut bytes = Vec::new();
    BufReader::new(file).read_until(b'\n', &mut bytes)?;
    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
        current_header(&value)?;
    }
    Ok(())
}

pub(super) fn prepare(path: &Path, header: Option<&str>) -> Result<bool> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error).context("open legacy transcript for conversion"),
    };
    // Conversion replaces regular files atomically. Preserve device/pipe
    // identity so the append still exposes its original write/flush error.
    if !file.metadata()?.is_file() {
        return Ok(false);
    }
    let mut reader = BufReader::new(file);
    let mut raw = Vec::new();
    reader.read_until(b'\n', &mut raw)?;
    let mut has_session_header = false;
    if let Ok(value) = serde_json::from_slice::<Value>(&raw) {
        if current_header(&value)? {
            binary_integrity::verify(path, &mut reader)?;
            return Ok(false);
        }
        has_session_header = value["type"] == "session";
    }
    binary_integrity::verify(path, &mut reader)?;
    reader.seek(SeekFrom::Start(0))?;
    let tmp = path.with_extension("binary.tmp");
    let mut writer = BufWriter::new(File::create(&tmp)?);
    if !has_session_header {
        writer.write_all(
            header
                .unwrap_or("{\"type\":\"storage\",\"schema\":2}")
                .as_bytes(),
        )?;
        writer.write_all(b"\n")?;
    }
    loop {
        raw.clear();
        if reader.read_until(b'\n', &mut raw)? == 0 {
            break;
        }
        let mut replacement = None;
        // Preserve historical torn/invalid lines verbatim, including invalid
        // UTF-8. A valid envelope with invalid references must fail explicitly.
        if let Ok(mut value) = serde_json::from_slice::<Value>(&raw) {
            let kind = value.get("type").and_then(Value::as_str).map(str::to_owned);
            match kind.as_deref() {
                Some("session") => {
                    current_header(&value)?;
                    value["schema"] = Value::from(TRANSCRIPT_SCHEMA);
                    replacement = Some(value);
                }
                // Keep malformed historical plain records skippable. Existing
                // encoded rows were validated before opening the temporary.
                Some("message" | "compaction" | "revision")
                    if value.get("binaryStorage").is_some()
                        || binary_storage::validate_record(value.clone()).is_ok() =>
                {
                    let decoded = binary_storage::decode(value.clone())?;
                    let encoded = binary_storage::encode(decoded.clone())?;
                    anyhow::ensure!(
                        binary_storage::decode(encoded.clone())? == decoded,
                        "lossless transcript conversion verification failed"
                    );
                    if encoded != value {
                        replacement = Some(encoded);
                    }
                }
                _ => {}
            }
        }
        if let Some(value) = replacement {
            let tag = value["type"].as_str().unwrap_or_default().to_owned();
            let mut fields = value.as_object().expect("decoded record object").clone();
            fields.remove("type");
            // Keep type first: bounded identity scanners rely on this ordering.
            let body = serde_json::to_string(&fields)?;
            let fields = &body[1..body.len() - 1];
            writeln!(writer, "{{\"type\":{},{} }}", Value::String(tag), fields)?;
        } else {
            writer.write_all(&raw)?;
            if !raw.ends_with(b"\n") {
                writer.write_all(b"\n")?;
            }
        }
    }
    writer.flush()?;
    writer.get_ref().sync_data()?;
    drop(writer);
    swap_into_place(&tmp, path)?;
    binary_integrity::invalidate(path);
    Ok(true)
}
