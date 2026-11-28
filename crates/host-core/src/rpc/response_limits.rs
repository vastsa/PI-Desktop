use std::io::{self, Write};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::{JsonRpcError, JsonRpcResponse};

// Keep in sync with MAX_HOST_STDOUT_LINE_BYTES in packages/shared/src/rpc-limits.ts.
const MAX_STDOUT_LINE_BYTES: usize = 64 * 1024 * 1024;
const FALLBACK_LINE_BYTES: usize = 4096;

struct BoundedLine {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl Write for BoundedLine {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit - self.bytes.len() {
            self.exceeded = true;
            return Err(io::Error::other(
                "host response exceeds the stdout line limit",
            ));
        }
        let required = self.bytes.len() + bytes.len();
        if required > self.bytes.capacity() {
            let capacity = self.bytes.capacity().saturating_mul(2).max(128);
            let capacity = capacity.max(required).min(self.limit);
            self.bytes
                .try_reserve_exact(capacity - self.bytes.len())
                .map_err(io::Error::other)?;
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Debug)]
enum EncodeError {
    Limit,
    Serialization,
}

fn encode_line(response: &impl Serialize, limit: usize) -> Result<String, EncodeError> {
    let mut line = BoundedLine {
        bytes: Vec::new(),
        limit,
        exceeded: false,
    };
    if serde_json::to_writer(&mut line, response).is_err() || line.write_all(b"\n").is_err() {
        return Err(if line.exceeded {
            EncodeError::Limit
        } else {
            EncodeError::Serialization
        });
    }
    String::from_utf8(line.bytes).map_err(|_| EncodeError::Serialization)
}

#[derive(Serialize)]
struct ErrorResponse<'a> {
    jsonrpc: &'static str,
    id: &'a Value,
    error: JsonRpcError,
}

fn encode_response(response: &impl Serialize, id: &Value, limit: usize) -> String {
    let (code, message, data) = match encode_line(response, limit) {
        Ok(line) => return line,
        Err(EncodeError::Limit) => (
            1002,
            "Host response exceeds the stdout line byte limit",
            json!({ "errorCode": "LIMIT_EXCEEDED", "scope": "host-response", "limitBytes": limit }),
        ),
        Err(EncodeError::Serialization) => {
            tracing::warn!("Host RPC response could not be serialized");
            (
                1000,
                "Host response could not be serialized",
                json!({ "errorCode": "INTERNAL", "scope": "host-response" }),
            )
        }
    };
    let fallback = ErrorResponse {
        jsonrpc: "2.0",
        id,
        error: JsonRpcError {
            code,
            message: message.into(),
            data: Some(data),
        },
    };
    encode_line(&fallback, FALLBACK_LINE_BYTES).unwrap_or_else(|_| {
        // The app uses UUIDs. An arbitrary peer ID may itself exceed the small
        // fallback budget, in which case there is no safe ID to echo.
        tracing::warn!("Host RPC error response could not retain its request ID");
        encode_line(
            &ErrorResponse {
                id: &Value::Null,
                ..fallback
            },
            FALLBACK_LINE_BYTES,
        )
        .unwrap_or_else(|_| {
            // Last resort uses only constants and cannot contain response data.
            concat!(
                r#"{"jsonrpc":"2.0","id":null,"error":{"code":1000,"message":"Host response could not be serialized","data":{"errorCode":"INTERNAL","scope":"host-response"}}}"#,
                "\n"
            )
            .to_owned()
        })
    })
}

pub(super) fn send_response(tx: &mpsc::UnboundedSender<String>, response: JsonRpcResponse) {
    let _ = tx.send(encode_response(
        &response,
        &response.id,
        MAX_STDOUT_LINE_BYTES,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(id: Value, result: Value) -> JsonRpcResponse {
        JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    #[test]
    fn accepts_the_exact_wire_budget_and_counts_the_newline() {
        let response = response(json!("request-a"), json!({"content": "中🙂\u{2028}\r\n"}));
        let expected = format!("{}\n", serde_json::to_string(&response).unwrap());
        assert_eq!(
            encode_response(&response, &response.id, expected.len()),
            expected
        );
        let over = encode_response(&response, &response.id, expected.len() - 1);
        let parsed: Value = serde_json::from_str(&over).unwrap();
        assert_eq!(parsed["id"], response.id);
        assert_eq!(parsed["error"]["code"], 1002);
        assert_eq!(parsed["error"]["data"]["errorCode"], "LIMIT_EXCEEDED");
        assert_eq!(parsed["error"]["data"]["scope"], "host-response");
        assert_eq!(parsed["error"]["data"]["limitBytes"], expected.len() - 1);
    }

    #[test]
    fn oversized_reply_and_following_valid_reply_are_independent_ndjson_records() {
        let oversized = response(json!("request-a"), json!("sensitive content".repeat(256)));
        let valid = response(json!("request-b"), json!({"ok": true}));
        let limit = 256;
        let response = encode_response(&oversized, &oversized.id, limit);
        assert!(response.len() <= limit);
        assert!(!response.contains("sensitive content"));
        let wire = response + &encode_response(&valid, &valid.id, limit);
        let frames: Vec<Value> = wire
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["id"], "request-a");
        assert!(frames[0].get("result").is_none());
        assert_eq!(frames[1]["id"], "request-b");
        assert_eq!(frames[1]["result"]["ok"], true);
    }

    #[test]
    fn serialization_failure_returns_a_small_correlated_internal_error() {
        struct BrokenResponse;
        impl Serialize for BrokenResponse {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use serde::ser::{Error, SerializeSeq};
                let mut partial = serializer.serialize_seq(None)?;
                partial.serialize_element("sensitive content")?;
                Err(S::Error::custom("sensitive cause"))
            }
        }
        let id = json!("request-c");
        let wire = encode_response(&BrokenResponse, &id, 256);
        assert!(wire.len() <= 256);
        assert!(!wire.contains("sensitive"));
        let parsed: Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(parsed["id"], id);
        assert_eq!(parsed["error"]["code"], 1000);
        assert_eq!(parsed["error"]["data"]["errorCode"], "INTERNAL");
        assert_eq!(parsed["error"]["data"]["scope"], "host-response");
    }

    #[test]
    fn unbounded_peer_id_cannot_make_the_fallback_oversized() {
        let response = response(json!("i".repeat(FALLBACK_LINE_BYTES)), json!(false));
        let wire = encode_response(&response, &response.id, 256);
        assert!(wire.len() <= 256);
        let parsed: Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(parsed["id"], Value::Null);
        assert_eq!(parsed["error"]["data"]["errorCode"], "LIMIT_EXCEEDED");
    }
}
