/**
 * "Why no badge?": the popup's answer when the on-page badge does not show.
 *
 * Each frame's content script records where its last check stopped (a
 * {@link FrameDiag}) on a global in the extension's isolated world. The popup's
 * frame scan runs in that same world, so it reads the record back with no
 * messaging and no storage. {@link explainBadge} turns the records plus the frame
 * map into a short checklist. A frame with no record runs no content script.
 */
import type { FrameNode } from "./frame-tree";

/** The global the content script writes and the popup's frame scan reads. The
 * scan's injected function cannot import, so it repeats this name as a literal. */
export const FRAME_DIAG_KEY = "__tmsyncDiag";

/** The global the content script sets as it starts, so the background can tell a
 * frame that runs it from one that does not (`startOnTab`). */
export const CONTENT_MARK = "__tmsyncContent";

/** Where the top frame's last recipe check stopped. */
export type MatchStep =
  | "no-recipe" // no recipe names this domain
  | "no-match" // a recipe names this domain, but the address or page marker fails
  | "manual" // a manual recipe: the user picks the title from the badge
  | "read-failed" // the recipe matched, but reading the page failed
  | "needs-episode" // a show URL with no episode: the badge asks for it
  | "waiting-title" // the title has not rendered yet
  | "resolving" // sent to the trackers, no answer yet
  | "resolved" // a tracker matched it: the badge shows
  | "not-found"; // no tracker matched it: the badge shows an error

/** One recipe that names this domain, and which of its checks pass. */
export interface RecipeCheck {
  name: string;
  url: boolean;
  /** Null when the recipe has no page marker (`domFingerprint`). */
  marker: boolean | null;
}

/** Where the video side of a frame stands. */
export type PlayerStep =
  | "no-media" // nothing to play yet (no recipe matched on this tab)
  | "no-video" // media known, but no matching <video> in this frame
  | "running"; // a watch session runs here

export interface FrameDiag {
  /** When the last check ran (ms). */
  at: number;
  /** How many checks ran since the page loaded. */
  checks: number;
  /** How many recipes this frame loaded. */
  recipes: number;
  step?: MatchStep;
  recipe?: string;
  /** "no-match": the recipes that name this domain. */
  candidates?: RecipeCheck[];
  /** What was read from the page, as the badge would show it. */
  media?: string;
  detail?: string;
  player?: PlayerStep;
}

/** Merge a patch into this frame's record. Content script only. */
export function noteFrameDiag(patch: Partial<FrameDiag>): void {
  const g = globalThis as unknown as Record<string, FrameDiag | undefined>;
  const prev = g[FRAME_DIAG_KEY];
  g[FRAME_DIAG_KEY] = { at: 0, checks: 0, recipes: 0, ...prev, ...patch };
}

export interface DiagLine {
  tone: "ok" | "bad" | "wait";
  text: string;
}

function hostOf(origin: string): string {
  return origin.replace(/^https?:\/\//, "");
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

/**
 * The checklist, top to bottom in the order a page goes through: access, script
 * running, recipe match, page read, tracker match, player. It stops at the first
 * step that fails, because later steps depend on it.
 */
export function explainBadge(input: {
  /** Flattened frame map; each reached frame carries its record. */
  frames: FrameNode[];
  badgeHidden: boolean;
  now: number;
}): DiagLine[] {
  const { frames, now } = input;
  const top = frames.find((f) => f.isTop);
  const out: DiagLine[] = [];
  if (!top) return [{ tone: "bad", text: "No web page in this tab." }];
  const host = hostOf(top.origin);

  if (!top.enabled) {
    out.push({ tone: "bad", text: `TMSync is not allowed on ${host}. Allow it above.` });
    return out;
  }
  if (!top.reached) return [{ tone: "wait", text: "Checking this page…" }];
  const d = top.diag;
  if (!d) {
    out.push({
      tone: "bad",
      text: "TMSync is allowed here but does not run on this page yet. Reload the page.",
    });
    return out;
  }
  out.push({
    tone: "ok",
    text: `Running · ${d.recipes} recipes · checked ${d.checks}× · last ${ago(now - d.at)}`,
  });

  switch (d.step) {
    case undefined:
      out.push({ tone: "wait", text: "The first check has not finished yet." });
      return out;
    case "no-recipe":
      out.push({ tone: "bad", text: `No recipe covers ${host}. Set one up below.` });
      return out;
    case "no-match":
      for (const c of d.candidates ?? []) {
        const fails = [
          !c.url && "the address does not fit its URL pattern",
          c.marker === false && "its page marker is not on the page (yet)",
        ].filter(Boolean);
        out.push({ tone: "bad", text: `${c.name}: ${fails.join(", and ")}.` });
      }
      if (!d.candidates?.length) out.push({ tone: "bad", text: "No recipe matches this page." });
      return out;
    case "manual":
      out.push({ tone: "ok", text: `${d.recipe}: manual, pick the title from the badge.` });
      break;
    case "read-failed":
      out.push({
        tone: "bad",
        text: `${d.recipe} matched, but it could not read the page${d.detail ? `: ${d.detail}` : "."}`,
      });
      return out;
    case "needs-episode":
      out.push({ tone: "ok", text: `${d.media}: the badge asks which episode plays.` });
      break;
    case "waiting-title":
      out.push({
        tone: "wait",
        text: `${d.recipe} matched. Waiting for the title to show on the page.`,
      });
      return out;
    case "resolving":
      out.push({ tone: "wait", text: `Read ${d.media}. Waiting for the trackers to answer.` });
      break;
    case "resolved":
      out.push({ tone: "ok", text: `Read and matched ${d.media}.` });
      break;
    case "not-found":
      out.push({
        tone: "bad",
        text: `Read ${d.media}, but ${d.detail ?? "no tracker matched it"}.`,
      });
      break;
  }

  if (input.badgeHidden) {
    out.push({ tone: "bad", text: "The on-page badge is set to Hidden below." });
  }

  // The player: the frame that runs a session, else the best lead.
  const running = frames.find((f) => f.diag?.player === "running");
  if (running) {
    out.push({
      tone: "ok",
      text: running.isTop ? "Player found." : `Player found in ${hostOf(running.origin)}.`,
    });
    return out;
  }
  const blocked = frames.find((f) => !f.isTop && !f.enabled);
  const silent = frames.find((f) => f.enabled && f.reached && f.hasVideo && !f.diag);
  if (silent) {
    out.push({
      tone: "bad",
      text: `${hostOf(silent.origin)} has the video but TMSync does not run there yet. Reload the page.`,
    });
  } else if (blocked) {
    out.push({
      tone: "wait",
      text: `No player yet. It may be in ${hostOf(blocked.origin)}, which is not allowed.`,
    });
  } else {
    out.push({ tone: "wait", text: "No player yet. Press play on the page." });
  }
  return out;
}
