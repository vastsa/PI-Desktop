import { COMPUTER_MAX_STEPS_LIMIT } from "@pi-desktop/shared";
import { Type } from "typebox";

/**
 * The agent-facing `Computer` schema (ADR 0340 §2).
 *
 * It takes an instruction and nothing else: no window, no element, no
 * coordinate. The target comes from the grant the user minted, and addressing
 * is the inner loop's job, so there is no argument here through which the
 * conversation model could choose what gets operated.
 */
export const computerUseParameters = {
  instruction: Type.String({
    minLength: 1,
    maxLength: 4000,
    description:
      "One concrete task to carry out in the granted application window, in plain language.",
  }),
  maxSteps: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: COMPUTER_MAX_STEPS_LIMIT,
      description: "Upper bound on actions for this call. The grant's own budget still applies.",
    }),
  ),
  observeOnly: Type.Optional(
    Type.Boolean({
      description: "Describe the window without acting on it.",
    }),
  ),
};

export const computerUseDescription = [
  "Operate the one native application window the user granted you, through the accessibility layer.",
  "Give a single concrete task in `instruction`; a separate model configured for computer use reads the window and performs the steps.",
  "You do not choose the window, and you cannot click coordinates yourself: the user picks the target in PI-Desktop, and every step is re-validated against it.",
  "Use `observeOnly` to read the window without changing it.",
  "The call fails with a COMPUTER_* code when the feature is off, no model is configured, no grant is active, the grant expired, or the platform has no backend. Those are the user's to fix — report them instead of retrying.",
  "This is not a substitute for Bash, file tools, or the browser tool. Use it only for a GUI application the user has handed over.",
].join(" ");
