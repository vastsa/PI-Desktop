export type RpcErrorValue = {
  code: number;
  message: string;
  data?: unknown;
  errorCode?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function stableCode(error: Record<string, unknown> | undefined): string | undefined {
  const nested = record(error?.data)?.errorCode;
  return typeof nested === "string" ? nested
    : typeof error?.errorCode === "string" ? error.errorCode : undefined;
}

/** Preserve wire data and copy only established fields, not arbitrary Error properties. */
export function rpcErrorToWire(error: unknown): RpcErrorValue {
  const value = record(error);
  const errorCode = stableCode(value);
  const data = value?.data;
  return {
    code: typeof value?.code === "number" ? value.code : -32000,
    message: error instanceof Error ? error.message : String(error),
    data: errorCode && (data === undefined || record(data))
      ? { ...record(data), errorCode } : data,
    // Legacy scalar/array data keeps its shape, with an additive error code.
    ...(errorCode && data !== undefined && !record(data) ? { errorCode } : {}),
  };
}

export function rpcErrorFromWire(value: RpcErrorValue): Error & {
  code: number; data?: unknown; errorCode?: string;
} {
  const errorCode = stableCode(value);
  return Object.assign(new Error(value.message), {
    code: value.code, data: value.data,
    ...(errorCode ? { errorCode } : {}),
  });
}
