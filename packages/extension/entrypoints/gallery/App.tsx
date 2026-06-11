import {
  BadgeMini,
  BadgePill,
  type BadgeState,
  CorrectionPanel,
  EpisodePickPanel,
  EpisodePrompt,
  ManualPickPanel,
  ManualPrompt,
  RateNotePanel,
  RatingPrompt,
} from "@/lib/ui/proto/BadgeView";
import { OptionsView } from "@/lib/ui/proto/OptionsView";
import { PickerPanel, type UrlPart } from "@/lib/ui/proto/PickerPanel";
import { PopupView } from "@/lib/ui/proto/PopupView";
import { QuickLinksView } from "@/lib/ui/proto/QuickLinksView";
import { type Tokens, type Variant, tokens } from "@/lib/ui/proto/kit";
import clsx from "clsx";
import { useState } from "preact/hooks";

/** Split a URL into text + numeric tokens, like the real picker does. */
function urlParts(href: string): UrlPart[] {
  const parts: UrlPart[] = [];
  let last = 0;
  let ordinal = 0;
  for (const m of href.matchAll(/\d+/g)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push({ text: href.slice(last, idx) });
    const paramKey = /[?&]([\w.-]+)=$/.exec(href.slice(0, idx))?.[1];
    parts.push({ num: m[0], ordinal: ordinal++, paramKey });
    last = idx + m[0].length;
  }
  if (last < href.length) parts.push({ text: href.slice(last) });
  return parts;
}

function Tile({
  label,
  t,
  children,
}: { label: string; t: Tokens; children: preact.ComponentChildren }) {
  return (
    <div class="space-y-2">
      <div class={clsx("text-[11px] font-medium uppercase tracking-wider", t.faint)}>{label}</div>
      <div
        class={clsx(
          "flex min-h-[120px] items-start justify-center rounded-xl p-4 ring-1",
          t.divider,
          "bg-[repeating-conic-gradient(#80808012_0_25%,transparent_0_50%)] bg-[length:16px_16px]",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function Group({
  id,
  title,
  t,
  children,
}: { id: string; title: string; t: Tokens; children: preact.ComponentChildren }) {
  return (
    <section id={id} class="scroll-mt-20 space-y-4">
      <h2 class={clsx("text-sm font-semibold", t.heading)}>{title}</h2>
      <div class="grid gap-6 lg:grid-cols-2">{children}</div>
    </section>
  );
}

const EP_URL = "popcornmovies.org/episode/spider-noir/1-1";
const NAV = [
  ["popup", "Popup"],
  ["picker", "Picker"],
  ["badge", "Badge"],
  ["links", "Quick links"],
  ["options", "Options"],
] as const;

export function App() {
  const [variant, setVariant] = useState<Variant>("dark");
  const t = tokens(variant);

  return (
    <div class={clsx("min-h-screen", t.page)}>
      {/* sticky toolbar */}
      <div
        class={clsx("sticky top-0 z-10 border-b backdrop-blur", t.divider, t.page, "bg-opacity-80")}
      >
        <div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div class="flex items-center gap-4">
            <h1 class={clsx("text-[15px] font-semibold tracking-tight", t.heading)}>
              TMSync · UI Gallery
            </h1>
            <nav class="hidden items-center gap-1 sm:flex">
              {NAV.map(([id, label]) => (
                <a
                  key={id}
                  href={`#${id}`}
                  class={clsx(
                    "rounded-md px-2 py-1 text-[12px] transition-colors",
                    t.sub,
                    "hover:bg-white/5",
                  )}
                >
                  {label}
                </a>
              ))}
            </nav>
          </div>
          <div class={clsx("flex gap-1 rounded-xl p-1", t.card)}>
            {(["light", "dark"] as Variant[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVariant(v)}
                class={clsx(
                  "rounded-lg px-3 py-1.5 text-[13px] font-medium capitalize transition-colors",
                  variant === v ? "bg-trakt text-white" : clsx(t.sub, "hover:opacity-80"),
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div class="mx-auto max-w-6xl space-y-12 px-6 py-8">
        {/* POPUP */}
        <Group id="popup" title="Popup" t={t}>
          <Tile label="Not connected" t={t}>
            <PopupView
              variant={variant}
              connected={false}
              redirectUri="https://aplaigellojlejhdjkklgihlmbmdaebk.chromiumapp.org/"
              origins={null}
            />
          </Tile>
          <Tile label="Connected · one site, no recipe" t={t}>
            <PopupView
              variant={variant}
              connected
              origins={[{ origin: "https://www.cineby.at", isTop: true, enabled: false }]}
            />
          </Tile>
          <Tile label="Connected · enabled site" t={t}>
            <PopupView
              variant={variant}
              connected
              note="Enabled — reload the page to start."
              origins={[{ origin: "https://www.cineby.at", isTop: true, enabled: true }]}
            />
          </Tile>
          <Tile label="Connected · per-site watch-on link editor" t={t}>
            <PopupView
              variant={variant}
              connected
              origins={[{ origin: "https://www.cineby.at", isTop: true, enabled: true }]}
              quickLinkHost="www.cineby.at"
              quickLinkInitial={{
                name: "Cineby",
                tracker: "trakt",
                movie: "https://www.cineby.at/movie/{tmdb}",
                tv: "https://www.cineby.at/tv/{tmdb}/{season}/{episode}",
              }}
              quickLinkDerive={() => ({})}
            />
          </Tile>
          <Tile label="Connected · no streaming page" t={t}>
            <PopupView variant={variant} connected origins={[]} />
          </Tile>
          <Tile label="Connected · frame inspector (nested player)" t={t}>
            <PopupView
              variant={variant}
              connected
              inspecting
              origins={[
                { origin: "https://www.rivestream.app", isTop: true, enabled: true },
                { origin: "https://vsrc.su", isTop: false, enabled: true },
              ]}
              frameTree={[
                {
                  frameId: 0,
                  url: "https://www.rivestream.app/watch?id=5",
                  origin: "https://www.rivestream.app",
                  isTop: true,
                  reached: true,
                  enabled: true,
                  title: "Rive",
                  videos: [],
                  hasVideo: false,
                  hasActiveVideo: false,
                  children: [],
                  depth: 0,
                },
                {
                  frameId: 12,
                  url: "https://vsrc.su/embed/5",
                  origin: "https://vsrc.su",
                  isTop: false,
                  reached: true,
                  enabled: true,
                  title: "",
                  videos: [],
                  hasVideo: false,
                  hasActiveVideo: false,
                  children: [],
                  depth: 1,
                },
                {
                  frameId: 34,
                  url: "https://cloudstream.pro/e/abc",
                  origin: "https://cloudstream.pro",
                  isTop: false,
                  reached: true,
                  enabled: true,
                  title: "",
                  videos: [
                    {
                      paused: false,
                      duration: 5400,
                      currentTime: 318,
                      readyState: 4,
                      hasSrc: true,
                      muted: false,
                      loop: false,
                      width: 1280,
                      height: 720,
                    },
                  ],
                  hasVideo: true,
                  hasActiveVideo: true,
                  children: [],
                  depth: 2,
                },
              ]}
            />
          </Tile>
        </Group>

        {/* PICKER */}
        <Group id="picker" title="Picker" t={t}>
          <Tile label="Set up · auto-detected, good preview" t={t}>
            <PickerPanel
              variant={variant}
              mode="setup"
              name="Popcorn Movies"
              fields={[
                { key: "title", label: "Title", value: "Spider-Noir", source: "dom" },
                { key: "year", label: "Year", value: "2026", source: "dom" },
                { key: "season", label: "Season", value: "1", source: "url" },
                { key: "episode", label: "Episode", value: "1", source: "url" },
              ]}
              urlParts={urlParts(EP_URL)}
              mediaType="auto"
              tracker="trakt"
              iframe={false}
              preview={{ ok: true, text: "show: Spider-Noir S1E1" }}
            />
          </Tile>
          <Tile label="SPA player · title from tab title + query-param S/E" t={t}>
            <PickerPanel
              variant={variant}
              mode="setup"
              name="Rivestream"
              fields={[
                { key: "title", label: "Title", value: "Euphoria", source: "title" },
                { key: "year", label: "Year", value: null },
                { key: "season", label: "Season", value: "1", source: "url" },
                { key: "episode", label: "Episode", value: "1", source: "url" },
              ]}
              urlParts={urlParts(
                "https://www.rivestream.app/watch?type=tv&id=85552&season=1&episode=1",
              )}
              titleParts={["Rive", "Watch", "Euphoria", "S1-E1"]}
              mediaType="auto"
              tracker="trakt"
              iframe
              preview={{ ok: true, text: "show: Euphoria S1E1" }}
            />
          </Tile>
          <Tile label="Picking Title — page-click mode" t={t}>
            <PickerPanel
              variant={variant}
              mode="setup"
              name="Cineby"
              picking="Title"
              fields={[
                { key: "title", label: "Title", value: null },
                { key: "year", label: "Year", value: null },
                { key: "season", label: "Season", value: null },
                { key: "episode", label: "Episode", value: null },
              ]}
              urlParts={urlParts("www.cineby.at/tv/273240/1/1")}
              mediaType="auto"
              tracker="trakt"
              iframe
              preview={{ ok: false, error: "no title yet — pick one" }}
            />
          </Tile>
          <Tile label="Edit · loaded your saved recipe" t={t}>
            <PickerPanel
              variant={variant}
              mode="edit"
              name="Cineby"
              fields={[
                { key: "title", label: "Title", value: "Dune: Part Two", source: "meta" },
                { key: "year", label: "Year", value: "2024", source: "dom" },
                { key: "season", label: "Season", value: null },
                { key: "episode", label: "Episode", value: null },
              ]}
              urlParts={urlParts("www.cineby.at/movie/693134")}
              mediaType="movie"
              tracker="trakt"
              iframe
              preview={{ ok: true, text: "movie: Dune: Part Two (2024)" }}
              status="Saved! Reload the page to start scrobbling."
            />
          </Tile>
          <Tile label="Library covers this page · override" t={t}>
            <PickerPanel
              variant={variant}
              mode="setup"
              name="Popcorn Movies"
              banner={{ kind: "library", name: "Popcorn Movies" }}
              fields={[
                { key: "title", label: "Title", value: "Srimulat", source: "dom" },
                { key: "year", label: "Year", value: "2023", source: "dom" },
                { key: "season", label: "Season", value: null },
                { key: "episode", label: "Episode", value: null },
              ]}
              urlParts={urlParts("popcornmovies.org/movie/srimulat-hidup-memang-komedi")}
              mediaType="auto"
              tracker="trakt"
              iframe={false}
              preview={{ ok: true, text: "movie: Srimulat (2023)" }}
            />
          </Tile>
          <Tile label="Manual mode · no title to scrape" t={t}>
            <PickerPanel
              variant={variant}
              mode="setup"
              name="TwoSeven"
              manual
              manualKeyValue="The Bear S03E01.mkv"
              fields={[]}
              urlParts={urlParts("twoseven.xyz/room/abc123")}
              mediaType="auto"
              tracker="trakt"
              iframe
              preview={{ ok: true, text: "Manual — pick each title from the badge" }}
            />
          </Tile>
          <Tile label="Anime site → AniList" t={t}>
            <PickerPanel
              variant={variant}
              mode="setup"
              name="reanime.to"
              fields={[
                { key: "title", label: "Title", value: "Frieren", source: "dom" },
                { key: "episode", label: "Episode", value: "3", source: "url" },
              ]}
              urlParts={urlParts("reanime.to/watch/frieren/3")}
              mediaType="show"
              tracker="anilist"
              iframe
              preview={{ ok: true, text: "show: Frieren E3 → AniList" }}
            />
          </Tile>
        </Group>

        {/* BADGE */}
        <Group id="badge" title="Badge (injected over the player)" t={t}>
          <Tile label="Scrobble pill · states" t={t}>
            <div class="flex flex-col items-center gap-3">
              {(["idle", "watching", "paused", "error"] as BadgeState[]).map((s) => (
                <BadgePill key={s} variant={variant} state={s} title="Dune: Part Two" />
              ))}
            </div>
          </Tile>
          <Tile label="Minimized dot + rating prompt" t={t}>
            <div class="flex flex-col items-center gap-4">
              <div class="flex items-center gap-4">
                <BadgeMini state="watching" />
                <BadgeMini state="paused" />
                <BadgeMini state="scrobbled" />
              </div>
              <RatingPrompt variant={variant} label="Rate movie?" value={8} />
            </div>
          </Tile>
          <Tile label="Rate & note · movie" t={t}>
            <RateNotePanel
              variant={variant}
              isShow={false}
              value={9}
              note="A gorgeous, propulsive epic that earns every minute."
              hasNote
              spoiler={false}
            />
          </Tile>
          <Tile label="Rate & note · show (levels)" t={t}>
            <RateNotePanel
              variant={variant}
              isShow
              level="episode"
              value={null}
              note=""
              hasNote={false}
              spoiler={false}
            />
          </Tile>
          <Tile label="Fix match · search" t={t}>
            <CorrectionPanel
              variant={variant}
              query="spider noir"
              results={[
                "Spider-Noir (2026) · show",
                "Spider-Man Noir (2009) · movie",
                "Into the Spider-Verse (2018) · movie",
              ]}
            />
          </Tile>
          <Tile label="Fix match · corrected" t={t}>
            <CorrectionPanel
              variant={variant}
              query=""
              results={[]}
              saved="Spider-Noir (2026) · show"
            />
          </Tile>
          <Tile label="Manual mode · pick prompt" t={t}>
            <ManualPrompt variant={variant} />
          </Tile>
          <Tile label="Manual mode · pick a movie" t={t}>
            <ManualPickPanel
              variant={variant}
              type="movie"
              query="dune part two"
              results={["Dune: Part Two (2024) · movie", "Dune (2021) · movie"]}
            />
          </Tile>
          <Tile label="Manual mode · pick a show + S/E" t={t}>
            <ManualPickPanel variant={variant} type="show" query="the bear" results={[]} />
          </Tile>
          <Tile label="Episode chooser · prompt (S/E-less URL)" t={t}>
            <EpisodePrompt variant={variant} />
          </Tile>
          <Tile label="Episode chooser · panel" t={t}>
            <EpisodePickPanel variant={variant} title="Severance" />
          </Tile>
        </Group>

        {/* QUICK LINKS */}
        <Group id="links" title="Quick links (injected on Trakt pages)" t={t}>
          <Tile label="Mixed: deep link, deep+search, search-only" t={t}>
            <QuickLinksView
              variant={variant}
              items={[
                { name: "Cineby", direct: "#" },
                { name: "Popcorn Movies", direct: "#", search: "#" },
                { name: "Fmovies", search: "#" },
              ]}
            />
          </Tile>
        </Group>

        {/* OPTIONS */}
        <section id="options" class="scroll-mt-20 space-y-4">
          <h2 class={clsx("text-sm font-semibold", t.heading)}>Options page</h2>
          <div class={clsx("overflow-hidden rounded-xl ring-1", t.divider)}>
            <OptionsView variant={variant} />
          </div>
        </section>
      </div>
    </div>
  );
}
