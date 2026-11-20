/**
 * Connectors destination: the accounts PI-Desktop may act with on the user's
 * behalf. GitHub is the first; each connector is one card that shows who is
 * connected and how to connect or disconnect.
 */
import { GitHubConnectorCard } from "../connectors/GitHubConnectorCard";

export function ConnectorsSettings() {
  return (
    <div className="settings-stack">
      <GitHubConnectorCard />
    </div>
  );
}
