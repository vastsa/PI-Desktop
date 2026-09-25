/**
 * The lab's style sheet. `pi.ui.injectStyle` scopes every rule to the lab's
 * own slot mounts, so plain class names are enough; the host tokens keep
 * the samples readable in both themes.
 */
export const LAB_CSS = `
.lab-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px dashed var(--ds-accent);
  border-radius: 8px;
  color: var(--ds-text-primary);
  font-size: 12px;
  line-height: 1.5;
}
.lab-head, .lab-row, .lab-facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.lab-facts, .lab-quiet {
  color: var(--ds-text-muted);
}
.lab-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.lab-btn {
  padding: 1px 8px;
  border: 1px solid var(--ds-border-default);
  border-radius: 6px;
  background: transparent;
  color: var(--ds-accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.lab-btn:hover {
  background: var(--ds-bg-hover);
}
.lab-result {
  color: var(--ds-text-muted);
  font-size: 11px;
}
.lab-result[data-lab-result="ok"] {
  color: var(--ds-success);
}
.lab-result[data-lab-result="error"] {
  color: var(--ds-error);
}
.lab-session, .lab-pill {
  padding: 0 6px;
  border-radius: 99px;
  background: var(--ds-bg-chip);
  color: var(--ds-text-secondary);
  font-size: 10px;
}
.lab-running { color: var(--ds-warning); }
.lab-success { color: var(--ds-success); }
.lab-error, .lab-pill.lab-error { color: var(--ds-error); }
.lab-code {
  overflow-wrap: anywhere;
  font-size: 11px;
}
.lab-lines {
  margin: 0;
  padding-left: 20px;
}
.lab-bars {
  display: grid;
  gap: 4px;
}
.lab-bar-row {
  display: grid;
  grid-template-columns: 80px 1fr 48px;
  align-items: center;
  gap: 6px;
}
.lab-bar {
  height: 10px;
  border-radius: 3px;
  background: var(--ds-accent);
}
.lab-bar-value {
  text-align: right;
}
`;
