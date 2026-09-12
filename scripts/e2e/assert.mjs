export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function shortJson(value, max = 500) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? text.slice(0, max) + "..." : text;
}

export function errorCodeOf(error) {
  return (
    error?.errorCode ??
    error?.data?.errorCode ??
    error?.rpc?.data?.errorCode ??
    error?.code ??
    undefined
  );
}

export function errorText(error) {
  const code = errorCodeOf(error);
  const message = error?.message || String(error);
  return code ? code + ": " + message : message;
}

export async function expectRpcError(call, expectedCodes) {
  let value;
  try {
    value = await call();
  } catch (error) {
    const code = errorCodeOf(error);
    if (!expectedCodes.includes(code)) {
      throw new Error(
        "expected RPC error " + expectedCodes.join("/") + ", got " + errorText(error),
      );
    }
    return code;
  }
  throw new Error(
    "expected RPC error " + expectedCodes.join("/") + ", got " + shortJson(value),
  );
}

export function toolErrorCode(result) {
  return result?.errorCode || result?.content?.code || result?.content?.errorCode;
}

export function assertToolFailure(result, expectedCode) {
  assert(result?.ok === false, "expected tool failure, got " + shortJson(result));
  assert(
    toolErrorCode(result) === expectedCode,
    "expected tool error " + expectedCode + ", got " + shortJson(result),
  );
}

export function assertToolSuccess(result, toolCallId) {
  assert(result?.ok === true, "expected tool success, got " + shortJson(result));
  assert(result.toolCallId === toolCallId, "tool identity mismatch: " + shortJson(result));
}
