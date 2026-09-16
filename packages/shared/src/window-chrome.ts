/**
 * Native window-chrome geometry that more than one process has to agree on.
 *
 * The main process positions the macOS traffic lights with these values, and
 * the renderer derives the space it leaves clear for them from the same
 * numbers (`--ds-traffic-light-edge` in styles/tokens.css). Sharing one
 * constant is what keeps the reserved space and the buttons it exists for
 * from drifting apart.
 *
 * Distances are DIP — the native coordinate space. The buttons are native
 * views: the renderer's zoom factor does not scale them.
 */

/**
 * Position handed to Electron's `trafficLightPosition`. The first button's
 * left edge lands on `x`; `y` is measured from the window's top edge.
 */
export const MAC_TRAFFIC_LIGHT_POSITION = { x: 16, y: 16 } as const;

/**
 * Width of the three-button cluster: first button's left edge to last
 * button's right edge.
 *
 * Measured on macOS 26 at a 2x display — the buttons run at a ~23 DIP pitch
 * with ~14 DIP of visible diameter, spanning ~60 DIP. macOS owns these
 * metrics, so re-measure if a release changes the traffic-light buttons.
 */
export const MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH_DIP = 60;

/** Right edge of the cluster, measured from the window's left edge. */
export const MAC_TRAFFIC_LIGHT_EDGE_DIP =
  MAC_TRAFFIC_LIGHT_POSITION.x + MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH_DIP;
