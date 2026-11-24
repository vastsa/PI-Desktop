import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export default async function bundleModelsDevCatalog({ electronPlatformName, appOutDir, targets }, fetchImpl = fetch) {
  if (electronPlatformName !== "linux" || !targets.some((target) => target.name === "deb")) return;
  const { MODELS_DEV_API_URL, MODELS_DEV_TIMEOUT_MS, parseModelsDevCatalog } =
    await import("../apps/desktop/electron/main/models-dev-catalog.ts");
  const response = await fetchImpl(MODELS_DEV_API_URL, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`models.dev catalog request failed (${response.status})`);
  const catalog = await response.json();
  const providers = parseModelsDevCatalog(catalog);
  if (!providers.length) throw new Error("models.dev catalog contained no usable providers");

  const fetchedAt = new Date().toISOString();
  const catalogPath = join(appOutDir, "resources", "models.dev", "api.json");
  await writeFile(catalogPath, JSON.stringify({ fetchedAt, catalog }));
  console.log(`Bundled models.dev catalog from ${fetchedAt} (${providers.length} providers)`);
}
