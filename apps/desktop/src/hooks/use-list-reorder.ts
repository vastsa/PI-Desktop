import { useEffect, useState, type ButtonHTMLAttributes, type HTMLAttributes } from "react";
import {
  dropPlacement,
  sameDropTarget,
  visibleNeighborMove,
  type DropTarget,
  type ReorderPlacement,
} from "../lib/list-reorder";

/** Dragging previews a destination; only dropping or an arrow key edits the draft. */
export function useListReorder(
  visibleItems: readonly { id: string }[],
  move: (sourceId: string, targetId: string, placement: ReorderPlacement) => void,
  busy: boolean,
  mimeType: string,
) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const disabled = busy || visibleItems.length < 2;

  const clearDrag = () => {
    setDraggingId(null);
    setDropTarget(null);
  };

  useEffect(() => {
    if (disabled || !visibleItems.some((model) => model.id === draggingId)) {
      setDraggingId(null);
      setDropTarget(null);
    }
  }, [disabled, draggingId, visibleItems]);

  const destination = (id: string, clientY: number, element: HTMLElement): DropTarget => {
    const rect = element.getBoundingClientRect();
    return { id, placement: dropPlacement(clientY, rect.top, rect.height) };
  };

  const previewDrop = (id: string, clientY: number, element: HTMLElement) => {
    const next = id === draggingId ? null : destination(id, clientY, element);
    setDropTarget((current) => (sameDropTarget(current, next) ? current : next));
  };

  const rowEvents = (id: string): HTMLAttributes<HTMLLIElement> => ({
    onDragEnter(event) {
      if (disabled || !draggingId) return;
      event.preventDefault();
      event.stopPropagation();
    },
    onDragOver(event) {
      if (disabled || !draggingId) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      previewDrop(id, event.clientY, event.currentTarget);
    },
    onDragLeave(event) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setDropTarget((current) => (current?.id === id ? null : current));
      }
    },
    onDrop(event) {
      const sourceId = draggingId || event.dataTransfer.getData(mimeType);
      if (disabled || !sourceId) return;
      event.preventDefault();
      event.stopPropagation();
      const target = destination(id, event.clientY, event.currentTarget);
      move(sourceId, id, target.placement);
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
      event.dataTransfer.setData(mimeType, id);
      setDraggingId(id);
      setDropTarget(null);
    },
    onDragEnd: clearDrag,
    onKeyDown(event) {
      if (disabled || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      event.stopPropagation();
      const neighbor = visibleNeighborMove(
        visibleItems,
        id,
        event.key === "ArrowDown" ? "down" : "up",
      );
      if (!neighbor) return;
      move(id, neighbor.targetId, neighbor.placement);
    },
  });

  return { draggingId, dropTarget, rowEvents, handleEvents };
}
