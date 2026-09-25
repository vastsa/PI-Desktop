/**
 * The letter tile that leads an AI service (D625).
 *
 * Deliberately no brand artwork or colour: every service sits in the same
 * quiet raised tone, so a row is told apart by its name and the tile only gives
 * the eye a column to scan. A name without a letter or digit gets the generic
 * server glyph instead.
 */
import { IconServer } from "../icons";
import { monogramLetter } from "./service-row-status";

export function ServiceMonogram({ name }: { name: string }) {
  const letter = monogramLetter(name);
  return (
    <span className="service-monogram" aria-hidden>
      {letter || <IconServer size={14} />}
    </span>
  );
}
