/** A WeTrakr page's title, read from its URL: `/movies/{id}`, `/shows/{id}`, and a
 * show's `/seasons/{n}` and `/episodes/{e}` sub-pages. Null elsewhere. Pure. */
export function parseWetrakrPath(
  path: string,
): { type: "movie" | "show"; id: number; season?: number; episode?: number } | null {
  const m = /^\/(movies|shows)\/(\d+)(?:\/seasons\/(\d+)(?:\/episodes\/(\d+))?)?/.exec(path);
  if (!m) return null;
  return {
    type: m[1] === "movies" ? "movie" : "show",
    id: Number(m[2]),
    season: m[3] !== undefined ? Number(m[3]) : undefined,
    episode: m[4] !== undefined ? Number(m[4]) : undefined,
  };
}
