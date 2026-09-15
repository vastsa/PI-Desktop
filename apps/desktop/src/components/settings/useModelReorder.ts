import { useEffect, useState, type ButtonHTMLAttributes, type HTMLAttributes } from "react";
import type { ModelBinding } from "@pi-desktop/shared";
import { reorderModel } from "./model-reorder";

type DropTarget = { id: string; placement: "before" | "after" };

/** Dragging previews a destination; only dropping or an arrow key edits the draft. */
export function useModelReorder(
  visibleModels: ModelBinding[],
  setModels: (update: (current: ModelBinding[]) => ModelBinding[]) => void,
  busy: boolean,
) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const disabled = busy || visibleModels.length < 2;

  const clearDrag = () => {
    setDraggingId(null);
    setDropTarget(null);
  };

  useEffect(() => {
    if (disabled || !visibleModels.some((model) => model.id === draggingId)) {
      setDraggingId(null);
      setDropTarget(null);
    }
  }, [disabled, draggingId, visibleModels]);

  const destination = (id: string, clientY: number, element: HTMLElement): DropTarget => {
    const rect = element.getBoundingClientRect();
    return { id, placement: clientY > rect.top + rect.height / 2 ? "after" : "before" };
  };

  const rowEvents = (id: string): HTMLAttributes<HTMLLIElement> => ({
    onDragOver(event) {
      if (disabled || !draggingId) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(
        id === draggingId ? null : destination(id, event.clientY, event.currentTarget),
      );
    },
    onDragLeave(event) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setDropTarget((current) => (current?.id === id ? null : current));
      }
    },
    onDrop(event) {
      if (disabled || !draggingId) return;
      event.preventDefault();
      event.stopPropagation();
      const target = destination(id, event.clientY, event.currentTarget);
      setModels((current) => reorderModel(current, draggingId, id, target.placement));
      clearDrag();
    },
  });

  const handleEvents = (id: string): ButtonHTMLAttributes<HTMLButtonElement> => ({
    disabled,
    draggable: !disabled,
    onDragStart(event) {
      if (disabled) {
        event.preventDefault();
        return;
      }
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-pi-desktop-model", id);
      setDraggingId(id);
      setDropTarget(null);
    },
    onDragEnd: clearDrag,
    onKeyDown(event) {
      if (disabled || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      event.stopPropagation();
      const index = visibleModels.findIndex((model) => model.id === id);
      const down = event.key === "ArrowDown";
      const target = visibleModels[index + (down ? 1 : -1)];
      if (!target) return;
      setModels((current) => reorderModel(current, id, target.id, down ? "after" : "before"));
    },
  });

  return { draggingId, dropTarget, rowEvents, handleEvents };
}
