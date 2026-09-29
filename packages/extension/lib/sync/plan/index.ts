/**
 * The list sync planner (docs/ARCHITECTURE.md section 7). Pure: lists in, a plan out, no I/O,
 * so every edge case is a unit test.
 *
 * The rules, in short:
 *  - Union: each tracker gets what the others have, and progress never goes down.
 *    Only what the user removed from one list is removed from the others (below).
 *  - Items are matched by id only, never by title.
 *  - Movies and non-anime TV move between the trackers that take seasons (Trakt,
 *    Simkl) by their shared tmdb / imdb / tvdb ids. No crosswalk.
 *  - Anime is planned per cour (one AniList entry). A seasoned list (Trakt) reaches
 *    a cour through the crosswalk, and the crosswalk never guesses: a miss or an
 *    ambiguous map is a skip, reported, never a write.
 *  - A completed cour entry is never moved (no silent rewatch).
 *  - Ratings only fill empty ones. Two different ratings are a conflict for the user.
 *  - Status: when the progress finishes the entry, it is completed. Otherwise the
 *    most recently updated entry wins, and a disagreement is listed as a conflict.
 *  - A kind with a MAIN list is not a union: only the main list is a source, and
 *    an entry it does not have is removed from the other lists. Copies still
 *    never go down, and never lose Trakt watch history: where the main list is
 *    behind, the plan says so (a notice) instead of acting.
 *  - Remembered removals (with a base, `base.ts`): in a union, an entry one list
 *    removed since the last clean sync is removed from the others instead of
 *    added back, and so is a rating. Only when every list that still has it had
 *    it at the base too: a list that added it since wins, and it is added back.
 *    Where a copy is kept (Trakt watch history), the plan leaves removed marks, so
 *    the next sync does not add the item back from that copy.
 *
 * The files: `context.ts` (what one run shares, and the plan it builds), `group.ts`
 * (entries into cour groups, through the crosswalk), `western.ts` (movies and
 * non-anime TV), `cour.ts` (anime, per cour), `ratings.ts`, `picks.ts` (`withPicks`),
 * `summary.ts` (`summarize`), and `util.ts`.
 */
import type { SyncPlan } from "../types";
import { type PlanInput, planContext } from "./context";
import { planCour } from "./cour";
import { groupEntries } from "./group";
import { planWestern } from "./western";

export type { PlanInput } from "./context";
export { withPicks } from "./picks";
export { summarize } from "./summary";
export {
  canBeMain,
  normStatus,
  removesEntries,
  stateOf,
  syncKindsFor,
  takesKind,
} from "./util";

export function planSync(input: PlanInput): SyncPlan {
  const ctx = planContext(input);
  const cours = groupEntries(ctx, (members, kind) => planWestern(ctx, members, kind));
  for (const [key, g] of cours) planCour(ctx, key, g);
  const { items, skips, conflicts, notices, removed } = ctx;
  return { items, skips, conflicts, notices, ...(removed.length ? { removed } : {}) };
}
