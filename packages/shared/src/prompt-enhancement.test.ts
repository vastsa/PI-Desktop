import { describe, expect, it } from "vitest";
import {
  PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT,
  PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE,
  PROMPT_ENHANCEMENT_DRAFT_VARIABLE,
  isCustomPromptEnhancementTemplateActive,
  isValidPromptEnhancementUserTemplate,
  renderPromptEnhancementUserPrompt,
  resolvePromptEnhancementTemplates,
} from "./prompt-enhancement.js";

describe("prompt-enhancement defaults", () => {
  it("opens with exactly one wrapping tag pair around the draft", () => {
    const template = PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE;
    expect(template).toContain(PROMPT_ENHANCEMENT_DRAFT_VARIABLE);
    expect(template).toMatch(/^<draft>\n\{\{draft\}\}\n<\/draft>/);
    expect(template.match(/<\/draft>/g)).toHaveLength(1);
  });
  it("carries the contract the old single-line prompt lacked", () => {
    const system = PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT;
    // Language following without meta notes.
    expect(system).toContain("same language as the draft");
    expect(system).toContain("no language labels or meta notes");
    // Proper-noun protection: the largest missing constraint before this change.
    expect(system).toContain("proper nouns");
    expect(system).toContain("reproduce them exactly as written");
    // Length brake and the explicit do-not list.
    expect(system).toContain("twice the draft's length");
    expect(system).not.toContain("800 characters");
    expect(system).toContain("DO NOT:");
    expect(system).toContain("Answer, execute, or fulfil the draft's request");
    // Output contract.
    expect(system).toContain("wrapping quotation marks");
    expect(system).toContain("Never end with an unfinished list");
  });

  it("keeps few-shot coverage for Chinese, English, and mixed input", () => {
    const template = PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE;
    expect(template).toContain("帮我看看这段代码");
    expect(template).toContain("fix the login bug");
    expect(template).toContain("这个函数有点慢，can you make it faster");
    // The meta-note failure mode is explicit, without an `Enhanced:` prefix
    // the model would copy into the Composer.
    expect(template).toContain("Never emit");
    expect(template).not.toContain("Enhanced:");
    expect(template).toContain("<example-draft>");
  });
});

describe("resolvePromptEnhancementTemplates", () => {
  it("falls back to the defaults when nothing is stored", () => {
    expect(resolvePromptEnhancementTemplates()).toEqual({
      systemPrompt: PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT,
      userTemplate: PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE,
    });
  });

  it("keeps the built-in template while the switch is off", () => {
    // A stored template is kept for the next time the switch is turned on, but
    // does not apply until then.
    expect(
      resolvePromptEnhancementTemplates({
        customTemplate: false,
        userTemplate: "custom <{{draft}}>",
      }).userTemplate,
    ).toBe(PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE);
    expect(
      resolvePromptEnhancementTemplates({ userTemplate: "custom <{{draft}}>" })
        .userTemplate,
    ).toBe(PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE);
  });

  it("applies the stored template once the switch is on", () => {
    const result = resolvePromptEnhancementTemplates({
      customTemplate: true,
      userTemplate: "custom <{{draft}}>",
    });
    expect(result.systemPrompt).toBe(PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT);
    expect(result.userTemplate).toBe("custom <{{draft}}>");
  });

  it("falls back when the switch is on but the template is unusable", () => {
    // host-core rejects this write, so it can only arrive from a hand-edited
    // store; sending it would silently drop the user's draft.
    for (const userTemplate of ["no placeholder here", "", "   ", null, undefined]) {
      expect(
        resolvePromptEnhancementTemplates({ customTemplate: true, userTemplate })
          .userTemplate,
      ).toBe(PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE);
    }
  });

  it("never returns an overridable system prompt", () => {
    const result = resolvePromptEnhancementTemplates({
      customTemplate: true,
      userTemplate: "custom <{{draft}}>",
    });
    expect(result.systemPrompt).toBe(PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT);
  });
});

describe("isCustomPromptEnhancementTemplateActive", () => {
  it("is true only for an enabled, usable template", () => {
    expect(
      isCustomPromptEnhancementTemplateActive({ customTemplate: true, userTemplate: "{{draft}}" }),
    ).toBe(true);
    expect(
      isCustomPromptEnhancementTemplateActive({ customTemplate: false, userTemplate: "{{draft}}" }),
    ).toBe(false);
    expect(
      isCustomPromptEnhancementTemplateActive({ customTemplate: true, userTemplate: "none" }),
    ).toBe(false);
    expect(isCustomPromptEnhancementTemplateActive()).toBe(false);
  });
});

describe("isValidPromptEnhancementUserTemplate", () => {
  it("requires a non-blank template carrying the variable", () => {
    expect(isValidPromptEnhancementUserTemplate("{{draft}}")).toBe(true);
    expect(isValidPromptEnhancementUserTemplate("text {{draft}} text")).toBe(true);
    expect(isValidPromptEnhancementUserTemplate("no variable")).toBe(false);
    expect(isValidPromptEnhancementUserTemplate("")).toBe(false);
    expect(isValidPromptEnhancementUserTemplate("   ")).toBe(false);
    expect(isValidPromptEnhancementUserTemplate(undefined)).toBe(false);
    expect(isValidPromptEnhancementUserTemplate(null)).toBe(false);
  });
});

describe("renderPromptEnhancementUserPrompt", () => {
  it("wraps the draft in the default template's tags", () => {
    const content = renderPromptEnhancementUserPrompt("  clear this up  ");
    expect(content).toContain("<draft>\n  clear this up  \n</draft>");
    expect(content).not.toContain(PROMPT_ENHANCEMENT_DRAFT_VARIABLE);
  });

  it("uses a stored template with the draft substituted once", () => {
    const content = renderPromptEnhancementUserPrompt("D", "before {{draft}} after");
    expect(content).toBe("before D after");
  });

  it("inserts a draft containing replacement-pattern sequences literally", () => {
    // `$&`, `$'`, `` $` `` and `$1` are String.replace patterns; a string
    // replacement would expand them here and corrupt the draft.
    const draft = "keep $& and $' and $1 and $` literally";
    const content = renderPromptEnhancementUserPrompt(draft);
    expect(content).toContain(draft);
  });

  it("substitutes every occurrence of the variable", () => {
    expect(renderPromptEnhancementUserPrompt("X", "{{draft}}|{{draft}}")).toBe("X|X");
  });

  it("falls back to the default template when the stored one is unusable", () => {
    const content = renderPromptEnhancementUserPrompt("X", "no variable");
    expect(content).toContain("<draft>\nX\n</draft>");
  });
});
