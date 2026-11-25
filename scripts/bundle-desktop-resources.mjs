import bundleModelsDevCatalog from "./bundle-models-dev-catalog.mjs";
import bundleOfflineOffice from "./bundle-offline-office.mjs";

export default async function bundleDesktopResources(context) {
  await bundleOfflineOffice(context);
  await bundleModelsDevCatalog(context);
}
