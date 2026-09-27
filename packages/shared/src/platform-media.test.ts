import { describe, expect, it } from "vitest";
import { AI_PLATFORM_BASE_URL, AI_PLATFORM_VENDOR_KEY } from "./ai-platform.js";
import { bindingForCustomModel } from "./model-catalog.js";
import { PLATFORM_MEDIA_MODELS, platformMediaModelBindings, platformImageDefaults } from "./platform-media.js";

const provider = { id: "first", vendorKey: AI_PLATFORM_VENDOR_KEY, baseUrl: AI_PLATFORM_BASE_URL,
  authKind: "api_key_and_base_url", enabled: true, hasSecret: true };

describe("platform media defaults", () => {
  it("includes all task/image routes without discovery and preserves custom/chat settings", () => {
    const chat = { ...bindingForCustomModel("chat"), contextWindow: 65536 };
    const original = [chat, { ...bindingForCustomModel("gpt-image-2.5-sunburst"), alias: "Quality", availableForSubagents: true }];
    const before = structuredClone(original);
    const models = platformMediaModelBindings(original);
    expect(models.map(model => model.id)).toEqual(["chat", ...PLATFORM_MEDIA_MODELS]);
    expect(models[0]).toEqual(chat);
    expect(models[2].alias).toBe("Quality");
    expect(models.slice(1).every(model => model.availableForSubagents === false)).toBe(true);
    expect(platformMediaModelBindings(models)).toEqual(models);
    expect(original).toEqual(before);
  });

  it("upgrades effective old-profile defaults without mutating persisted settings", () => {
    const settings = { defaultProviderId: provider.id, imageGeneration: null, imageGenerationModels: [] };
    const before = structuredClone(settings);
    const defaults = platformImageDefaults(settings, [provider]);
    expect(defaults.imageGeneration).toEqual({ providerId: "first", modelId: "gpt-image-2.5-flare" });
    expect(defaults.imageGenerationModels.map(binding => binding.modelId)).toEqual(PLATFORM_MEDIA_MODELS.slice(0, 2));
    expect(settings).toEqual(before);
  });

  it("preserves an explicit selection and never guesses an ambiguous or unavailable account", () => {
    const second = { ...provider, id: "second" };
    const selected = { providerId: "second", modelId: "gpt-image-2.5-sunburst" };
    expect(platformImageDefaults({ imageGeneration: selected }, [provider, second]).imageGeneration).toEqual(selected);
    expect(platformImageDefaults({}, [provider, second]).imageGeneration).toBeNull();
    expect(platformImageDefaults({ defaultProviderId: "missing" }, [provider]).imageGeneration).toBeNull();
    expect(platformImageDefaults({}, [{ ...provider, hasSecret: false }]).imageGeneration).toBeNull();
    expect(platformImageDefaults({}, [{ ...provider, enabled: false }]).imageGeneration).toBeNull();
    expect(platformImageDefaults({}, [{ ...provider, vendorKey: "foreign" }]).imageGenerationModels).toEqual([]);
  });
});
