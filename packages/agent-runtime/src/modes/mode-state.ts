/**
 * Mode state of one agent runtime (ADR mode-definitions): the session mode
 * id, the definition Electron main handed in for it, and the claimed run turn
 * of a staged mode. The runtime asks it for the tool policy level and the
 * mode part of the system prompt; the runtime itself only wires it in.
 */
import { modeStage, type Mode, type ModeDefinition, type ModePermission, type ModeTurnContext } from "@pi-desktop/shared";
import { modePolicyLevel, offersAgentModeOnlyTools, ownModeDefinition } from "./mode-policy.js";
import { composeModeInstructions, resolveModeInjects, type ModeArtifactReader } from "./stage-brief.js";

function sameDefinition(left: ModeDefinition | undefined, right: ModeDefinition | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

export class RuntimeModeState {
  private currentModeId: Mode;
  private currentDefinition?: ModeDefinition;
  private turn?: ModeTurnContext;
  /** Whether the claimed turn is still running (CompleteStage, injects). */
  private turnActive = false;
  private enterInjects: string[] = [];
  private compactionInjects: string[] = [];
  /** The context window was compacted at least once (restored or live). */
  private compacted: boolean;
  /** Invalidates inject reads that resolve after the turn changed. */
  private epoch = 0;

  constructor(modeId: Mode, definition?: ModeDefinition, options: { compacted?: boolean } = {}) {
    this.currentModeId = modeId;
    this.currentDefinition = ownModeDefinition(modeId, definition);
    this.compacted = options.compacted === true;
  }

  get modeId(): Mode {
    return this.currentModeId;
  }

  get definition(): ModeDefinition | undefined {
    return this.currentDefinition;
  }

  /** The run turn this runtime last started, while that turn runs. */
  get activeTurn(): ModeTurnContext | undefined {
    return this.turnActive ? this.turn : undefined;
  }

  /** The run context the tools and prompt are built for. */
  get modeTurn(): ModeTurnContext | undefined {
    return this.turn;
  }

  level(): ModePermission {
    return modePolicyLevel({ modeId: this.currentModeId, definition: this.currentDefinition, modeTurn: this.turn });
  }

  isAgentLevel(): boolean {
    return this.level() === "agent";
  }

  offersAgentModeOnlyTools(): boolean {
    return offersAgentModeOnlyTools(this.currentModeId);
  }

  /**
   * Switch the session mode or its definition. Returns whether tools and
   * prompt depend on something that changed. A different mode drops the run
   * turn: it belonged to the previous mode.
   */
  setMode(modeId: Mode, definition?: ModeDefinition): boolean {
    const own = ownModeDefinition(modeId, definition);
    if (modeId === this.currentModeId && sameDefinition(own, this.currentDefinition)) return false;
    if (modeId !== this.currentModeId) this.dropTurn();
    this.currentModeId = modeId;
    this.currentDefinition = own;
    return true;
  }

  /**
   * Start a prompt with its trusted run context (or none). Resolves the
   * `on.enter` injects when the run entered the stage with this turn, and
   * the `on.compaction` injects when the context window was compacted.
   * Returns whether the prompt must be recomposed.
   */
  async beginTurn(turn: ModeTurnContext | undefined, read: ModeArtifactReader): Promise<boolean> {
    const hadPromptState = Boolean(this.turn);
    this.epoch += 1;
    const epoch = this.epoch;
    this.turn = turn && this.currentDefinition ? turn : undefined;
    this.turnActive = Boolean(this.turn);
    this.enterInjects = [];
    this.compactionInjects = [];
    const definition = this.currentDefinition;
    const stage = this.turn && definition ? modeStage(definition, this.turn.stageId) : undefined;
    if (this.turn && definition && stage) {
      const enter = this.turn.enteredStage ? await resolveModeInjects(stage.onEnter, definition, this.turn, read) : [];
      const compaction = this.compacted ? await resolveModeInjects(stage.onCompaction, definition, this.turn, read) : [];
      if (epoch !== this.epoch) return false;
      this.enterInjects = enter;
      this.compactionInjects = compaction;
    }
    return hadPromptState || Boolean(this.turn);
  }

  /** The prompt's turn settled; CompleteStage and injects no longer apply. */
  endTurn(): void {
    this.turnActive = false;
  }

  /** Forget the run context (approved-plan execution, mode change). */
  clearTurn(): boolean {
    const had = Boolean(this.turn);
    this.dropTurn();
    return had;
  }

  /**
   * A compaction replaced the context window. During a run turn the stage's
   * `on.compaction` injects are read again; returns whether the prompt must
   * be recomposed.
   */
  async afterCompaction(read: ModeArtifactReader): Promise<boolean> {
    this.compacted = true;
    const turn = this.activeTurn;
    const definition = this.currentDefinition;
    const stage = turn && definition ? modeStage(definition, turn.stageId) : undefined;
    if (!turn || !definition || !stage || stage.onCompaction.length === 0) return false;
    const epoch = this.epoch;
    const compaction = await resolveModeInjects(stage.onCompaction, definition, turn, read);
    if (epoch !== this.epoch || this.activeTurn !== turn) return false;
    this.compactionInjects = compaction;
    return true;
  }

  /** The mode part of the system prompt. */
  instructions(): string {
    return composeModeInstructions({
      modeId: this.currentModeId,
      definition: this.currentDefinition,
      modeTurn: this.turn,
      level: this.level(),
      injects: { enter: this.enterInjects, compaction: this.compactionInjects },
    });
  }

  private dropTurn(): void {
    this.epoch += 1;
    this.turn = undefined;
    this.turnActive = false;
    this.enterInjects = [];
    this.compactionInjects = [];
  }
}
