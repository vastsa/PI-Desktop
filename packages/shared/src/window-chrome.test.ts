import { describe, expect, it } from "vitest";
import {
  MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH_DIP,
  MAC_TRAFFIC_LIGHT_EDGE_DIP,
  MAC_TRAFFIC_LIGHT_POSITION,
} from "./window-chrome.js";

describe("macOS traffic-light geometry", () => {
  it("derives the cluster edge from the position the main process applies", () => {
    expect(MAC_TRAFFIC_LIGHT_EDGE_DIP).toBe(
      MAC_TRAFFIC_LIGHT_POSITION.x + MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH_DIP,
    );
  });

  it("pins the measured native geometry the renderer reserve is built on", () => {
    // Native geometry measured on macOS 26, not a design choice: moving either
    // value moves the space the shell reserves in front of the buttons.
    expect(MAC_TRAFFIC_LIGHT_POSITION).toEqual({ x: 16, y: 16 });
    expect(MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH_DIP).toBe(60);
  });
});
