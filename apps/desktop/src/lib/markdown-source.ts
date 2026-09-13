type SourceNode = {
  type: string;
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: SourceNode[];
};

export type SourcePositionProps = {
  "data-source-start"?: number;
  "data-source-end"?: number;
};

/** Attach parser-owned offsets after sanitization, relative to the full message. */
export function rehypeSourcePositions({ offset }: { offset: number }) {
  return (tree: SourceNode) => {
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.children) pending.push(...node.children);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (node.type !== "element" || start === undefined || end === undefined) continue;
      node.properties = {
        ...node.properties,
        "data-source-start": offset + start,
        "data-source-end": offset + end,
      };
    }
  };
}

/** Custom Markdown components may change their tag but retain the source anchor. */
export function sourcePositionProps(props: SourcePositionProps): SourcePositionProps {
  return {
    "data-source-start": props["data-source-start"],
    "data-source-end": props["data-source-end"],
  };
}
