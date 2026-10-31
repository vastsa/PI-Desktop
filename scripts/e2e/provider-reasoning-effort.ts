import type { i18n } from "i18next";
import type { ProviderPublic, ProviderUpdateInput } from "@pi-desktop/shared";

export async function verifyReasoningEffort({ render, fixture, i18n, updates, click, control, until, frame }: {
  render: (props: { provider: ProviderPublic }) => void;
  fixture: (apiStyle: string) => ProviderPublic;
  i18n: i18n;
  updates: ProviderUpdateInput[];
  click: (element: HTMLElement | undefined | null) => void;
  control: (key: string) => HTMLButtonElement | undefined;
  until: (condition: () => boolean, label: string) => Promise<void>;
  frame: () => Promise<void>;
}) {
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  let provider = fixture("chat_completions");
  provider = { ...provider, models: [{ ...provider.models[0], id: "deepseek-v4.1-flash" }] };
  const trigger = () => [...document.querySelectorAll<HTMLButtonElement>(".settings-menu-select-trigger")]
    .find((element) => element.getAttribute("aria-label") === i18n.t("settings.reasoningEffortParameter"));
  render({ provider });
  await until(() => Boolean(trigger()), "reasoning effort settings");
  assert(trigger()?.textContent?.trim() === i18n.t("settings.reasoningEffortAuto"), "legacy binding must start on Auto");
  await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished));
  const assertFits = () => {
    const bounds = trigger()!.getBoundingClientRect();
    const panel = document.querySelector(".provider-chosen-reasoning-effort")!.getBoundingClientRect();
    assert(bounds.left >= panel.left - 1 && bounds.right <= panel.right + 1 && bounds.right <= innerWidth, "reasoning effort control overflows the model panel");
  };
  assertFits();
  for (const [key, value] of [
    ["settings.reasoningEffortSend", true],
    ["settings.reasoningEffortOmit", false],
    ["settings.reasoningEffortAuto", null],
  ] as const) {
    trigger()?.scrollIntoView({ block: "center" });
    await frame();
    click(trigger());
    await frame();
    const option = [...document.querySelectorAll<HTMLButtonElement>(".settings-menu-select-option")]
      .find((element) => element.textContent?.trim() === i18n.t(key));
    assert(option, `missing reasoning effort choice ${key}`);
    click(option);
    const count = updates.length;
    click(control("settings.saveProvider"));
    await until(() => updates.length === count + 1, "save reasoning effort override");
    const update = updates.at(-1)!;
    assert(update.models?.[0].supportsReasoningEffort === value, "saved reasoning effort override differs from selection");
    provider = { ...provider, ...update };
    render({ provider });
    await until(() => Boolean(trigger()), "reopen reasoning effort settings");
    assert(trigger()?.textContent?.trim() === i18n.t(key), "reasoning effort choice lost on reopen");
    assertFits();
  }
  for (const apiStyle of ["responses", "anthropic_messages"]) {
    render({ provider: { ...provider, apiStyle } });
    assert(!trigger(), `${apiStyle} must not offer the Completions-only setting`);
  }
}
