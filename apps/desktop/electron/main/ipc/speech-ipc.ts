import { IPC } from "@pi-desktop/shared";
import type { SpeechService } from "../services/speech-service";
import type { IpcRegistrar } from "./types";

export function registerSpeechIpc({
  registrar,
  speech,
}: {
  registrar: IpcRegistrar;
  speech: SpeechService;
}): void {
  const { handle } = registrar;
  handle(IPC.invoke.speechGetStatus, () => speech.status());
  handle(IPC.invoke.speechTranscribe, (input: Record<string, unknown> = {}) =>
    speech.transcribe({
      sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
      path: String(input.path ?? ""),
      ...(typeof input.mimeType === "string" ? { mimeType: input.mimeType } : {}),
      ...(typeof input.language === "string" ? { language: input.language } : {}),
    }),
  );
  handle(IPC.invoke.speechSynthesize, (input: Record<string, unknown> = {}) =>
    speech.synthesize({
      sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
      text: String(input.text ?? ""),
      ...(typeof input.voice === "string" ? { voice: input.voice } : {}),
      ...(typeof input.format === "string" ? { format: input.format } : {}),
    }),
  );
}
