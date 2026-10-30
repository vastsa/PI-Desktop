/** Sidebar entries match names case-insensitively, ignoring surrounding spaces. */
export function matchesSidebarSearch(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.trim().toLowerCase());
}
