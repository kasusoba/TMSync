import { WATCHED_THRESHOLD } from "@/lib/tracker/types";
import type { ScrobbleAction } from "@/lib/trakt/types";
import { clampProgress } from "@/lib/trakt/util";

/** Minimal view of the media element the controller needs (eases testing). */
export interface VideoLike {
  currentTime: number;
  duration: number;
  ended: boolean;
}

export type SendScrobble = (action: ScrobbleAction, progress: number) => void;

/**
 * Watch-session state machine (content-side, constraint #4 owns state here).
 *
 * Rules (per CLAUDE.md "Scrobble rules"):
 * - One `start` per session; debounce play/pause bursts (seeking, ad breaks).
 * - Idempotent: never emit the same action twice in a row.
 * - `ended` → stop(~100). Leaving before `ended` → stop(last progress).
 * - Crossing `WATCHED_THRESHOLD` while playing (`progressTick`) commits a stop —
 *   no pause/ended needed (long-credits sites, players that never fire `ended`).
 * - A pause at/after `WATCHED_THRESHOLD` also becomes a `stop`: Trakt rejects a
 *   pause that late ("use stop to scrobble") and it means the user finished.
 *   The threshold equals Trakt's own 80%, so every stop we send there counts.
 */
export class ScrobbleController {
  private started = false;
  private stopped = false;
  private lastAction: ScrobbleAction | null = null;
  private pending: ScrobbleAction | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly video: VideoLike,
    private readonly send: SendScrobble,
    private readonly debounceMs = 800,
  ) {}

  /** Current playback progress as a 0–100 percent. */
  progress(): number {
    const { currentTime, duration } = this.video;
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return clampProgress((currentTime / duration) * 100);
  }

  play(): void {
    this.schedule("start");
  }

  pause(): void {
    // `ended` fires a pause too; ignore it (the stop is handled by ended()).
    if (!this.video.ended) this.schedule("pause");
  }

  ended(): void {
    this.clearTimer();
    this.pending = null;
    this.emitStop(100);
  }

  /**
   * Called on playback progress (timeupdate). Once the "treat as finished here"
   * threshold is crossed WHILE PLAYING, commit a stop — no pause/ended needed.
   * This is the robust path for long-credits sites and gray-market players that
   * never fire `ended`. Idempotent: emits the stop exactly once.
   */
  progressTick(): void {
    if (!this.started || this.stopped) return;
    if (this.progress() >= WATCHED_THRESHOLD * 100) this.emitStop(this.progress());
  }

  /** Leaving before `ended` — tab close, SPA nav, or video element removed. */
  leave(): void {
    this.clearTimer();
    this.pending = null;
    if (this.started) this.emitStop(this.progress());
  }

  private schedule(action: ScrobbleAction): void {
    if (this.stopped) return;
    this.pending = action;
    this.clearTimer();
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    this.timer = null;
    if (this.stopped) return;
    const action = this.pending;
    this.pending = null;
    if (!action) return;
    if (action === "pause" && !this.started) return; // nothing started to pause
    // A pause past the "finished here" point → stop (commit to history, dodge the
    // 422 Trakt returns for a late pause).
    if (action === "pause" && this.progress() >= WATCHED_THRESHOLD * 100) {
      this.emitStop(this.progress());
      return;
    }
    if (action === this.lastAction) return; // idempotent
    this.dispatch(action, this.progress());
    if (action === "start") this.started = true;
  }

  private emitStop(progress: number): void {
    if (this.stopped) return;
    this.dispatch("stop", progress);
    this.stopped = true;
  }

  private dispatch(action: ScrobbleAction, progress: number): void {
    this.lastAction = action;
    this.send(action, progress);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
