import { generateImageBatch, type ImageEditInput, type ImageEndpoint } from "./index.js";
import type { ImageDownloadOptions } from "./download.js";

/** Test convenience only: exercises the actual Models-backed production batch entry. */
export async function generateTestImage(endpoint: ImageEndpoint, prompt: string, signal: AbortSignal,
  fetchImpl: typeof fetch = fetch, images: ImageEditInput[] = [], downloadOptions: ImageDownloadOptions = {}) {
  let image: ImageEditInput | undefined;
  const results = await generateImageBatch({
    endpoint, input: { items: [{ prompt, ...(images.length ? { images: images.map((_, index) => `${index}.png`) } : {}) }] },
    signal, fetchImpl, downloadOptions, loadImages: async () => images,
    save: async output => { image = output; return "/scratch/test.png"; },
  });
  if (!image) throw Object.assign(new Error(results[0].errorCode), { errorCode: results[0].errorCode });
  return image;
}
