import type { ModelInfo } from "./types.js";

/**
 * Static model catalog. The repository, filename, size, and SHA-256 values
 * are pinned to the public Hugging Face artifacts so a download cannot be
 * redirected to an unverified model file.
 */
const CATALOG: ModelInfo[] = [
  {
    id: "whisper-large-v3-turbo",
    name: "Whisper Large V3 Turbo",
    description: "Fast and accurate multilingual model (Q8 quantized)",
    languages: ["zh", "en", "ja", "ko", "de", "fr", "es", "pt", "ru", "ar", "yue"],
    sizeBytes: 886_381_760,
    hfRepo: "handy-computer/whisper-large-v3-turbo-gguf",
    hfRevision: "ceea6c8a94a21ab85be244d311e874a39344dbf5",
    hfFilename: "whisper-large-v3-turbo-Q8_0.gguf",
    sha256: "b2e30cc286bc9f3aba4db9099fc7403543497c05ce7100d0d83091ddfd25a183",
    supportsStreaming: false,
    recommended: true,
  },
  {
    id: "whisper-small",
    name: "Whisper Small",
    description: "Lightweight multilingual model (Q8 quantized)",
    languages: ["zh", "en", "ja", "ko", "de", "fr", "es", "pt", "ru", "ar"],
    sizeBytes: 269_751_136,
    hfRepo: "handy-computer/whisper-small-gguf",
    hfRevision: "a2073177cb69bd74b9ca9460b852d17fbfd5d68c",
    hfFilename: "whisper-small-Q8_0.gguf",
    sha256: "9b9c8811bbcc82a7766f0fb0925614bdacb0923b2cc630daeac17108b655b860",
    supportsStreaming: false,
    recommended: false,
  },
  {
    id: "whisper-medium",
    name: "Whisper Medium",
    description: "Balanced multilingual model (Q8 quantized)",
    languages: ["zh", "en", "ja", "ko", "de", "fr", "es", "pt", "ru", "ar"],
    sizeBytes: 831_538_144,
    hfRepo: "handy-computer/whisper-medium-gguf",
    hfRevision: "835ad19fff976143d650e35113a6544980cbd983",
    hfFilename: "whisper-medium-Q8_0.gguf",
    sha256: "09e6a65e7de377aa5b10bae24608bc6f8ca2ed04b3993ef10d4a02bcd9a82adf",
    supportsStreaming: false,
    recommended: false,
  },
  {
    id: "sensevoice-small",
    name: "SenseVoice Small",
    description: "Compact Chinese/English model with good accuracy",
    languages: ["zh", "en", "ja", "ko", "yue"],
    sizeBytes: 252_684_608,
    hfRepo: "handy-computer/SenseVoiceSmall-gguf",
    hfRevision: "3d0e44ad1ba285d09e7c86d6cc07604385082bb4",
    hfFilename: "SenseVoiceSmall-Q8_0.gguf",
    sha256: "6c759ee4c9748c9b3f7a5a60ca74f0f7e685fb9d45d1378fce7cfd62f59adf29",
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
