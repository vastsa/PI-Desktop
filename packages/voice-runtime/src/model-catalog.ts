import type { ModelInfo } from "./types.js";

/**
 * Static model catalog. In a real implementation this would be loaded from
 * catalog/catalog.json and catalog/recommendations.json. For now we include
 * a curated set of recommended models inline.
 */
const CATALOG: ModelInfo[] = [
  {
    id: "whisper-large-v3-turbo",
    name: "Whisper Large V3 Turbo",
    description: "Fast and accurate multilingual model (Q8 quantized)",
    languages: ["zh", "en", "ja", "ko", "de", "fr", "es", "pt", "ru", "ar", "yue"],
    sizeBytes: 1_654_846_464,
    hfRepo: "handy-computer/whisper-large-v3-turbo-GGUF",
    hfFilename: "ggml-large-v3-turbo-q8_0.bin",
    sha256: "",
    supportsStreaming: false,
    recommended: true,
  },
  {
    id: "whisper-small",
    name: "Whisper Small",
    description: "Lightweight multilingual model (Q8 quantized)",
    languages: ["zh", "en", "ja", "ko", "de", "fr", "es", "pt", "ru", "ar"],
    sizeBytes: 466_616_320,
    hfRepo: "handy-computer/whisper-small-GGUF",
    hfFilename: "ggml-small-q8_0.bin",
    sha256: "",
    supportsStreaming: false,
    recommended: false,
  },
  {
    id: "whisper-medium",
    name: "Whisper Medium",
    description: "Balanced multilingual model (Q8 quantized)",
    languages: ["zh", "en", "ja", "ko", "de", "fr", "es", "pt", "ru", "ar"],
    sizeBytes: 809_181_184,
    hfRepo: "handy-computer/whisper-medium-GGUF",
    hfFilename: "ggml-medium-q8_0.bin",
    sha256: "",
    supportsStreaming: false,
    recommended: false,
  },
  {
    id: "sensevoice-small",
    name: "SenseVoice Small",
    description: "Compact Chinese/English model with good accuracy",
    languages: ["zh", "en", "ja", "ko", "yue"],
    sizeBytes: 466_000_000,
    hfRepo: "handy-computer/SenseVoiceSmall-GGUF",
    hfFilename: "ggml-sensevoice-small-q8_0.bin",
    sha256: "",
    supportsStreaming: false,
    recommended: false,
  },
];

/** Get the full model catalog. */
export function getCatalog(): readonly ModelInfo[] {
  return CATALOG;
}

/** Find a model by its ID. */
export function findModel(modelId: string): ModelInfo | undefined {
  return CATALOG.find((m) => m.id === modelId);
}

/** Get the recommended model for the given languages. */
export function getRecommendedModel(languages: string[]): ModelInfo {
  // Prefer a model that covers all requested languages
  const covering = CATALOG.filter(
    (m) => m.recommended && languages.every((l) => m.languages.includes(l)),
  );
  if (covering.length > 0) return covering[0]!;

  // Fallback: first recommended, then first in catalog
  return CATALOG.find((m) => m.recommended) ?? CATALOG[0]!;
}
