/** Batch policy only: this does not grant permissions or coordinate other agents. */
export function toolExecutionMode(name: string): "parallel" | "sequential" {
  switch (name) {
    case "Read":
    case "Glob":
    case "Grep":
    case "Task":
      return "parallel";
    default:
      return "sequential";
  }
}
