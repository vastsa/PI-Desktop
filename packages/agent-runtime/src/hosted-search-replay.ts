import type { HostedSearchContent } from "@earendil-works/pi-ai";
import { normalizeHostedSearchContent } from "@earendil-works/pi-ai/utils/hosted-search";
import { LocalRequestError } from "@earendil-works/pi-ai/utils/local-request-error";
import type { HostedSearch } from "@pi-desktop/shared";

/**
 * 持久化类型保持向后兼容；只在进入模型上下文的边界收敛为正式搜索类型。
 *
 * 旧记录没有 replay 时仍可展示。记录带 replay 时分两种情况：容器不是数组
 * 属于损坏记录，仍按本地错误失败；单个块无法回放则整条 replay 降级为空，
 * 与该消息"没有 replay"的旧记录一致。
 *
 * 持久化层明确允许缺少 blockId 的块——网关丢弃 id 时，展示路径用匿名轮次
 * 兜底（`native-web-search.ts`）。这类记录升级前可读，不能在升级后让会话的
 * 每一轮请求都失败：请求级失败无法通过重启或重新打开会话恢复，而搜索回放
 * 只是该消息上下文的一部分。降级保持可观测，且不复制搜索内容或凭据。
 */
export function restoreHostedSearchReplay(
  search: HostedSearch | undefined,
): HostedSearchContent[] {
  if (search?.replay === undefined) return [];
  if (!Array.isArray(search.replay)) throw new LocalRequestError("context-validation");
  try {
    return search.replay.map((block) => normalizeHostedSearchContent(block));
  } catch (error) {
    reportUnreplayableSearchReplay(search.replay, error);
    return [];
  }
}

/**
 * 只记录块数与阶段：足够定位数据形状，又不把搜索结果或凭据写进日志。
 */
function reportUnreplayableSearchReplay(
  replay: readonly unknown[],
  error: unknown,
): void {
  const phases = [
    ...new Set(
      replay
        .map((block) => (block as { phase?: unknown } | null)?.phase)
        .filter((phase): phase is string => typeof phase === "string"),
    ),
  ];
  console.warn(
    `[hosted-search] dropping an unreplayable stored search record ` +
      `(${replay.length} block(s), phases: ${phases.join(", ") || "none"})`,
    error,
  );
}
