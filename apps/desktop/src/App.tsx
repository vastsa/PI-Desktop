import { ErrorBoundary } from "./features/app/chrome";
import { AppShell } from "./features/app/AppShell";

export default function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}
