import { describe, expect, it } from "vitest";
import { hydrateAttachmentHistory } from "./attachment-history.js";
import type { UiMessage } from "@pi-desktop/shared";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import os from "node:os";

describe("hydrateAttachmentHistory", () => {
  it("inlines image attachments when supportsVision is true and within byte limits", async () => {
    const tmp = resolve(os.tmpdir(), `test-attach-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    const imgPath = resolve(tmp, "sample.png");
    await writeFile(imgPath, "fake-png-bytes");

    const history: UiMessage[] = [
      {
        id: "msg-1",
        role: "user",
        content: "look at this",
        createdAt: new Date().toISOString(),
        attachments: [
          {
            name: "sample.png",
            ref: imgPath,
            kind: "image",
            mimeType: "image/png",
            size: 14,
          },
        ],
      },
    ];

    const hydrated = await hydrateAttachmentHistory(history, {
      projectPath: tmp,
      supportsVision: true,
    });

    expect(hydrated[0]?.attachments?.[0]?.data).toBe(
      Buffer.from("fake-png-bytes").toString("base64")
    );
  });

  it("limits inlined base64 images by message count to prevent V8 OOM (#1077)", async () => {
    const tmp = resolve(os.tmpdir(), `test-attach-limits-${Date.now()}`);
    await mkdir(tmp, { recursive: true });

    const history: UiMessage[] = [];
    for (let i = 1; i <= 10; i++) {
      const imgPath = resolve(tmp, `sample-${i}.png`);
      await writeFile(imgPath, `fake-png-bytes-${i}`);
      history.push({
        id: `msg-${i}`,
        role: "user",
        content: `image ${i}`,
        createdAt: new Date(Date.now() + i * 1000).toISOString(),
        attachments: [
          {
            name: `sample-${i}.png`,
            ref: imgPath,
            kind: "image",
            mimeType: "image/png",
            size: 20,
          },
        ],
      });
    }

    const hydrated = await hydrateAttachmentHistory(history, {
      projectPath: tmp,
      supportsVision: true,
      maxInlinedImageMessages: 5,
    });

    // Older messages outside the window retain disk references without inlined base64
    for (let i = 0; i < 5; i++) {
      expect(hydrated[i]?.attachments?.[0]?.data).toBeUndefined();
      expect(hydrated[i]?.attachments?.[0]?.ref).toContain(`sample-${i + 1}.png`);
    }

    // Recent messages within the window inline base64
    for (let i = 5; i < 10; i++) {
      expect(hydrated[i]?.attachments?.[0]?.data).toBeDefined();
    }
  });

  it("bounds aggregate inlined image bytes across multiple images in a single user message [P1]", async () => {
    const tmp = resolve(os.tmpdir(), `test-attach-multi-image-${Date.now()}`);
    await mkdir(tmp, { recursive: true });

    const attachments = [];
    for (let j = 1; j <= 5; j++) {
      const imgPath = resolve(tmp, `burst-${j}.png`);
      await writeFile(imgPath, "x".repeat(100)); // 100 bytes each
      attachments.push({
        name: `burst-${j}.png`,
        ref: imgPath,
        kind: "image" as const,
        mimeType: "image/png",
        size: 100,
      });
    }

    const history: UiMessage[] = [
      {
        id: "msg-burst",
        role: "user",
        content: "here are many images",
        createdAt: new Date().toISOString(),
        attachments,
      },
    ];

    // Budget of 250 bytes: should allow exactly first 2-3 images without exceeding
    const hydrated = await hydrateAttachmentHistory(history, {
      projectPath: tmp,
      supportsVision: true,
      maxInlinedImageBytes: 250,
    });

    const inlined = hydrated[0]?.attachments?.filter((a) => Boolean(a.data)) ?? [];
    const notInlined = hydrated[0]?.attachments?.filter((a) => !a.data) ?? [];

    expect(inlined.length).toBe(2);
    expect(notInlined.length).toBe(3);
    // Non-inlined images still retain their file reference and fallback path
    for (const a of notInlined) {
      expect(a.ref).toBeDefined();
    }
  });

  it("preserves image context on replayed historical turns [P2]", async () => {
    const tmp = resolve(os.tmpdir(), `test-attach-replay-${Date.now()}`);
    await mkdir(tmp, { recursive: true });

    const img1 = resolve(tmp, "turn1.png");
    await writeFile(img1, "turn1-image-data");

    const img2 = resolve(tmp, "turn2.png");
    await writeFile(img2, "turn2-image-data");

    const history: UiMessage[] = [
      {
        id: "msg-turn-1",
        role: "user",
        content: "turn 1 prompt",
        createdAt: new Date(Date.now() - 10000).toISOString(),
        attachments: [
          {
            name: "turn1.png",
            ref: img1,
            kind: "image",
            mimeType: "image/png",
            size: 16,
          },
        ],
      },
      {
        id: "msg-turn-2",
        role: "user",
        content: "turn 2 replayed prompt",
        createdAt: new Date().toISOString(),
        attachments: [
          {
            name: "turn2.png",
            ref: img2,
            kind: "image",
            mimeType: "image/png",
            size: 16,
          },
        ],
      },
    ];

    const hydrated = await hydrateAttachmentHistory(history, {
      projectPath: tmp,
      supportsVision: true,
      maxInlinedImageMessages: 5,
    });

    // Both replayed turns remain within the budget and keep their vision base64 data intact
    expect(hydrated[0]?.attachments?.[0]?.data).toBe(
      Buffer.from("turn1-image-data").toString("base64")
    );
    expect(hydrated[1]?.attachments?.[0]?.data).toBe(
      Buffer.from("turn2-image-data").toString("base64")
    );
  });
});
