/**
 * Minimal React hook runtime for driving one hook under test.
 *
 * Implements exactly the hooks `use-host-collection.ts` imports, with
 * production-faithful semantics: state cells survive across renders, a state
 * write is observable on the next `__render`, `useCallback`/`useEffect`
 * compare deps with `Object.is`, an effect whose deps changed runs its
 * cleanup before the new body, and effect bodies run at the end of the render
 * that scheduled them. Register `react-alias-hooks.mjs` so the module under
 * test resolves this file as "react".
 */

let cells = [];
let cellIndex = 0;
let pendingEffects = [];
let renderRequested = false;

/** Reset every cell and start a fresh mount. */
export function __mount(hookFn) {
  cells = [];
  cellIndex = 0;
  pendingEffects = [];
  renderRequested = false;
  return __render(hookFn);
}

/** Re-run the hook against the surviving cells; runs scheduled effect bodies. */
export function __render(hookFn) {
  cellIndex = 0;
  const result = hookFn();
  // React commits effect bodies after the render that scheduled them; keep
  // draining because an effect body can schedule another.
  while (pendingEffects.length > 0) {
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) effect();
  }
  return result;
}

/** Whether a state write happened since the last render. */
export function __renderRequested() {
  return renderRequested;
}

export function useState(initial) {
  const index = cellIndex++;
  if (cells[index] === undefined) {
    cells[index] = { value: typeof initial === "function" ? initial() : initial };
  }
  const cell = cells[index];
  const setState = (action) => {
    const next = typeof action === "function" ? action(cell.value) : action;
    if (Object.is(next, cell.value)) return;
    cell.value = next;
    renderRequested = true;
  };
  return [cell.value, setState];
}

export function useRef(initial) {
  const index = cellIndex++;
  // Unlike useState, a ref stores its initial value as-is - it is often a
  // callback, never a lazy initializer.
  if (cells[index] === undefined) {
    cells[index] = { current: initial };
  }
  return cells[index];
}

export function useCallback(fn, deps) {
  const index = cellIndex++;
  const cell = cells[index] ?? (cells[index] = { deps: undefined, fn: undefined });
  const same =
    cell.deps !== undefined &&
    deps?.length === cell.deps.length &&
    deps.every((dep, i) => Object.is(dep, cell.deps[i]));
  if (!same) {
    cell.deps = deps;
    cell.fn = fn;
  }
  return cell.fn;
}

export function useEffect(fn, deps) {
  const index = cellIndex++;
  const cell = cells[index] ?? (cells[index] = { deps: undefined, cleanup: undefined });
  const same =
    cell.deps !== undefined &&
    deps?.length === cell.deps.length &&
    deps.every((dep, i) => Object.is(dep, cell.deps[i]));
  if (same) return;
  cell.deps = deps;
  if (typeof cell.cleanup === "function") cell.cleanup();
  pendingEffects.push(() => {
    cell.cleanup = fn();
  });
}
