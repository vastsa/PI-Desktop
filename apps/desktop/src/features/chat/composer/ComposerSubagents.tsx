import { SubagentPresenceBar } from "../../../components/SubagentPresenceBar";
import { useMemo } from "react";
import { projectSubagentPresence } from "../../../lib/subagent-presence";
import { requestSubagentStop } from "../../../lib/subagent-stops";
import { useAppStore } from "../../../stores/app-store";

export function ComposerSubagents({ sessionId }: { sessionId: string }) {
  const messages = useAppStore(state => state.activeSessionId === sessionId && state.isRunning ? state.messages : null);
  const items = useMemo(() => messages ? projectSubagentPresence(messages) : [], [messages]);
  if (!items.length) return null;
  return (
    <SubagentPresenceBar
      items={items}
      onOpen={item => {
        const state = useAppStore.getState();
        if (state.activeSessionId === sessionId) state.openSubagentTab(item.id, item.agent);
      }}
      onStop={selection => {
        if (useAppStore.getState().activeSessionId !== sessionId) return;
        void requestSubagentStop(sessionId, selection.map(item => item.id));
      }}
    />
  );
}
