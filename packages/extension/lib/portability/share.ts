import type { QuickLinkSite } from "@/lib/storage";
import type { LibraryLink, Recipe } from "@tmsync/shared";

/**
 * Share recipes and quick links as a recipe source file: the same format TMSync
 * reads from a source URL. The user hosts it anywhere (a gist, a repo), and
 * anyone adds that URL as a source. There is no central list (docs/RECIPES.md).
 *
 * Only site config is shared. Corrections, manual picks, and the crosswalk reveal
 * what the user watches and never leave the device (constraint #6).
 */
export interface SourceFile {
  name?: string;
  recipes: Recipe[];
  links: LibraryLink[];
}

/** A quick link without its device-local fields (on/off, where it came from). */
function shareLink(l: QuickLinkSite): LibraryLink {
  const { enabled: _on, source: _source, sourceId: _from, ...rest } = l;
  return { ...rest, tracker: l.tracker ?? "trakt" };
}

/** The source file for these recipes and quick links, as pretty JSON. */
export function sourceFile(recipes: Recipe[], links: QuickLinkSite[], name?: string): string {
  const file: SourceFile = {
    ...(name ? { name } : {}),
    recipes,
    links: links.filter((l) => l.source !== "source").map(shareLink),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}
