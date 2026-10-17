/** Network-policy guard for a user-configured System One endpoint. */
import { net, session } from "electron";
import { fetchPinnedDirect } from "./public-https-direct";
import { createPublicHttpsClient } from "./public-https-fetch";
import {
  allowInsecureUserEndpointsEnabled,
  noteInsecureUserEndpoint,
  relaxedNetworkPolicyEnabled,
} from "./endpoint-policy";

const client = createPublicHttpsClient({
  fetchImpl: (url, init) => net.fetch(url, init),
  pinnedFetchImpl: (url, init, address) => fetchPinnedDirect(url, init, address),
  routeImpl: (url) => session.defaultSession.resolveProxy(url),
  allowFakeIp: () => relaxedNetworkPolicyEnabled(),
  allowInsecureUserEndpoints: () => allowInsecureUserEndpointsEnabled(),
  onInsecureUserEndpoint: (host) => noteInsecureUserEndpoint(host),
});

/** Apply the same user-entered endpoint policy used by other app-owned fetches. */
export async function assertJevUserEndpoint(url: string): Promise<void> {
  await client.assertPublicUrl(url, "user");
}
