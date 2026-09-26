import { IconBot } from "../../../components/icons";
import { providerMark } from "../../../lib/provider-marks";

/**
 * One provider identity mark for the Composer model list.
 *
 * A known vendor renders its bundled mark: monochrome `currentColor` paths, so
 * the artwork follows the theme's text color and every vendor carries one
 * visual weight instead of a run of saturated color logos. Anything else —
 * including a row the catalog could not place — falls back to the shared
 * generic mark, so no row is ever left without an identity and a missing or
 * renamed artwork degrades silently rather than breaking the list.
 */
export function ModelProviderIcon({ catalogProviderKey }: { catalogProviderKey?: string }) {
  const Mark = providerMark(catalogProviderKey);
  if (!Mark) {
    return <IconBot size={14} className="provider-mark provider-mark-generic" aria-hidden="true" />;
  }
  return <Mark size={14} className="provider-mark provider-mark-brand" />;
}
