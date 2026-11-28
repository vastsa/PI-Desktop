import { loadCustomSystemPrompt, type CustomSystemPrompt } from "./custom-system-prompt.js";
import { loadInstructionChain, type ProjectInstructions } from "./project-instructions.js";

const GROUP_INSTRUCTION_SOURCES = new Set([
  "ChatGPT Project folders",
  "ChatGPT Project instructions",
  "Project group folders",
  "Project group instructions",
]);

export async function matchesCacheWarmingInstructions(
  instructionRoot: string | undefined,
  instructionPath: string | undefined,
  customPromptRoot: string | undefined,
  expectedInstructions: ProjectInstructions | undefined,
  expectedPrompt: CustomSystemPrompt | undefined,
): Promise<boolean> {
  const [instructions, customPrompt] = await Promise.all([
    loadInstructionChain(instructionRoot, instructionPath),
    loadCustomSystemPrompt(customPromptRoot),
  ]);
  // Host-owned group instructions are invalidated by successful configuration writes.
  const expectedFiles = expectedInstructions?.entries.filter(entry => !GROUP_INSTRUCTION_SOURCES.has(entry.source)) ?? [];
  return JSON.stringify(instructions?.entries ?? []) === JSON.stringify(expectedFiles) &&
    JSON.stringify(customPrompt) === JSON.stringify(expectedPrompt);
}
