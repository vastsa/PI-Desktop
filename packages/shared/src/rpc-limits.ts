/**
 * Largest single NDJSON request line host-core accepts on stdin.
 *
 * Must stay equal to `MAX_STDIN_LINE_BYTES` in `crates/host-core/src/rpc/mod.rs`.
 * Electron rejects a larger payload before writing so the caller gets
 * `LIMIT_EXCEEDED` instead of waiting out the 130 s RPC deadline.
 */
export const MAX_HOST_STDIN_LINE_BYTES = 64 * 1024 * 1024;
