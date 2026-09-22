import { generatedImageType, MAX_IMAGE_BYTES } from "@pi-desktop/agent-runtime";
import { createContainedFileReader } from "./contained-file-reader";

const MAX_IMAGE_SET_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * Session/project roots are captured by the host, never supplied by the model.
 *
 * Containment, capping and the bounded read belong to the shared reader; this
 * loader adds only what makes an edit input an image: the PNG/JPEG/WebP sniff
 * through `generatedImageType`. A missing file keeps its raw filesystem error.
 */
export function imageInputLoader(options: {
  projectPath?: string;
  scratchPath: string;
  dataDir: string;
}) {
  const read = createContainedFileReader({
    roots: options,
    maxFileBytes: MAX_IMAGE_BYTES,
    maxSetBytes: MAX_IMAGE_SET_BYTES,
    maxBudgetBytes: MAX_IMAGE_BUDGET_BYTES,
    codes: {
      outside: "IMAGE_INPUT_OUTSIDE_ROOT",
      // Preserve what this path shipped: a non-regular file and a file over the
      // per-file cap both answer IMAGE_INPUT_INVALID, while the budget and the
      // per-set cap answer IMAGE_INPUT_TOO_LARGE.
      invalid: "IMAGE_INPUT_INVALID",
      fileTooLarge: "IMAGE_INPUT_INVALID",
      setTooLarge: "IMAGE_INPUT_TOO_LARGE",
    },
  });
  return async (refs: string[]) => {
    const files = await read(refs);
    return files.map((bytes) => ({ bytes, ...generatedImageType(bytes) }));
  };
}
