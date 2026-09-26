import {
  findSkillMentions,
  type ComposerCommand,
  type ComposerTrigger,
} from "@pi-desktop/shared";

export function continuingSkillTrigger(
  value: string,
  cursor: number,
  expectedValue: string | null,
  expectedSession: string,
  activeSession: string,
): ComposerTrigger | null {
  if (
    !expectedValue ||
    expectedSession !== activeSession ||
    value !== expectedValue ||
    cursor !== value.length ||
    !value.endsWith(" ")
  ) {
    return null;
  }
  return { mode: "slash", query: "", tokenStart: cursor, tokenEnd: cursor };
}

export function selectedSkillNames(
  value: string,
  commands: readonly Pick<ComposerCommand, "name" | "kind" | "skillId">[],
): string[] {
  const active = new Map(
    commands.flatMap((command) =>
      command.kind === "skill" && command.skillId
        ? [[command.name, command.skillId] as const]
        : [],
    ),
  );
  return [...new Set(findSkillMentions(value, active).map((mention) => mention.id))];
}
