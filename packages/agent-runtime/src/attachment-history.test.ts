import { describe, expect, it } from "vitest";
import { hydrateAttachmentHistory } from "./attachment-history.js";
import type { UiMessage } from "@pi-desktop/shared";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import os from "node:os";

async function withTempDir(run: (path: string) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(os.tmpdir(), "test-attachment-history-"));
  try {
    await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

function userMessage(
  id: string,
  attachments: NonNullable<UiMessage["attachments"]>,
): UiMessage {
  return {
    id,
    role: "user",
    content: id,
    createdAt: new Date().toISOString(),
    attachments,
  };
}

describe("hydrateAttachmentHistory", () => {
  it("inlines image attachments when supportsVision is true and within per-image byte limits", async () => {
    await withTempDir(async (tmp) => {
      const imgPath = resolve(tmp, "sample.png");
      await writeFile(imgPath, "fake-png-bytes");
      const history = [
        userMessage("msg-1", [
          {
            name: "sample.png",
            ref: imgPath,
            kind: "image",
            mimeType: "image/png",
            size: 14,
          },
        ]),
      ];

      const hydrated = await hydrateAttachmentHistory(history, {
        projectPath: tmp,
        supportsVision: true,
      });

      expect(hydrated[0]?.attachments?.[0]?.data).toBe(
        Buffer.from("fake-png-bytes").toString("base64"),
      );
    });
  });

  it("preserves historical image turns beyond ten messages when within the default byte budget", async () => {
    await withTempDir(async (tmp) => {
      const history: UiMessage[] = [];
      const payloads: string[] = [];
      for (let i = 1; i <= 12; i++) {
        const payload = `image-${i}`;
        const imgPath = resolve(tmp, `sample-${i}.png`);
        await writeFile(imgPath, payload);
        payloads.push(payload);
        history.push(
          userMessage(`msg-${i}`, [
            {
              name: `sample-${i}.png`,
              ref: imgPath,
              kind: "image",
              mimeType: "image/png",
              size: payload.length,
            },
          ]),
        );
      }

      const hydrated = await hydrateAttachmentHistory(history, {
        projectPath: tmp,
        supportsVision: true,
      });

      for (let i = 0; i < payloads.length; i++) {
        expect(hydrated[i]?.attachments?.[0]?.data).toBe(
          Buffer.from(payloads[i]!).toString("base64"),
        );
      }
    });
  });

  it("bounds actual aggregate bytes across many attachments in one message", async () => {
    await withTempDir(async (tmp) => {
      const attachments: NonNullable<UiMessage["attachments"]> = [];
      for (let i = 1; i <= 5; i++) {
        const imgPath = resolve(tmp, `burst-${i}.png`);
        await writeFile(imgPath, "x".repeat(100));
        attachments.push({
          name: `burst-${i}.png`,
          ref: imgPath,
          kind: "image",
          mimeType: "image/png",
          // Deliberately incorrect metadata must not bypass the actual byte budget.
          size: 1,
          ...(i === 1 ? { data: "stale-base64-must-be-cleared" } : {}),
        });
      }
      const history = [userMessage("msg-burst", attachments)];

      const hydrated = await hydrateAttachmentHistory(history, {
        projectPath: tmp,
        supportsVision: true,
        maxInlinedImageBytes: 250,
      });
      const result = hydrated[0];
      expect(result?.attachments?.map((attachment) => attachment.data)).toEqual([
        undefined,
        undefined,
        undefined,
        Buffer.from("x".repeat(100)).toString("base64"),
        Buffer.from("x".repeat(100)).toString("base64"),
      ]);
      for (let i = 1; i <= 3; i++) {
        expect(result?.content).toContain(`burst-${i}.png`);
        expect(result?.attachments?.[i - 1]?.ref).toContain(`burst-${i}.png`);
      }
    });
  });

  it("treats a zero history byte budget as no images inlined", async () => {
    await withTempDir(async (tmp) => {
      const imgPath = resolve(tmp, "sample.png");
      await writeFile(imgPath, "image");
      const history = [
        userMessage("msg-1", [
          {
            name: "sample.png",
            ref: imgPath,
            kind: "image",
            mimeType: "image/png",
            size: 5,
          },
        ]),
      ];

      const hydrated = await hydrateAttachmentHistory(history, {
        projectPath: tmp,
        supportsVision: true,
        maxInlinedImageBytes: 0,
      });

      expect(hydrated[0]?.attachments?.[0]?.data).toBeUndefined();
      expect(hydrated[0]?.content).toContain("sample.png");
    });
  });
});
