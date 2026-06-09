import clsx from "clsx";
import { Btn, Icon, Section, Switch, type Tokens, type Variant, tokens } from "./kit";

function Row({ t, children }: { t: Tokens; children: preact.ComponentChildren }) {
  return (
    <div class={clsx("flex items-center justify-between gap-3 rounded-xl px-3 py-2.5", t.card)}>
      {children}
    </div>
  );
}

function Mono({ t, children }: { t: Tokens; children: preact.ComponentChildren }) {
  return <code class={clsx("truncate font-mono text-[12px]", t.heading)}>{children}</code>;
}

function RowIcons({ t, open = false }: { t: Tokens; open?: boolean }) {
  const btn = clsx("grid size-7 place-items-center rounded-md", t.faint, "hover:bg-white/5");
  return (
    <span class="flex items-center gap-0.5">
      <button type="button" class={btn} title="Move up">
        <Icon name="up" class="text-[13px]" />
      </button>
      <button type="button" class={btn} title="Move down">
        <Icon name="down" class="text-[13px]" />
      </button>
      <button type="button" class={clsx(btn, open && "text-trakt")} title="Edit">
        <Icon name="edit" class="text-[13px]" />
      </button>
      <button type="button" class={clsx(btn, "hover:text-rose-500")} title="Delete">
        <Icon name="trash" class="text-[13px]" />
      </button>
    </span>
  );
}

// --- mock data sized to stress the layout ---
const SITES = [
  "www.cineby.at",
  "popcornmovies.org",
  "onlyflix.to",
  "vidsrc.to",
  "www.2embed.cc",
  "flixhq.to",
  "sflix.to",
  "watchseries.io",
  "primewire.mov",
];

const QUICK_LINKS: { name: string; library?: boolean; on: boolean }[] = [
  { name: "Cineby", on: true },
  { name: "Popcorn Movies", library: true, on: true },
  { name: "VidSrc", on: true },
  { name: "FlixHQ", library: true, on: false },
  { name: "2Embed", on: false },
  { name: "SFlix", library: true, on: false },
];

const LIBRARY: [string, string][] = [
  ["Cineby", "www\\.cineby\\.at/movie"],
  ["Cineby", "www\\.cineby\\.at/tv"],
  ["Popcorn Movies", "popcornmovies\\.org/movie"],
  ["Popcorn Movies", "popcornmovies\\.org/episode"],
  ["VidSrc", "vidsrc\\.to/embed/movie"],
  ["VidSrc", "vidsrc\\.to/embed/tv"],
  ["FlixHQ", "flixhq\\.to/watch-film"],
  ["2Embed", "2embed\\.cc/embed"],
];

const RECIPES: { host: string; items: [string, string][] }[] = [
  {
    host: "www.cineby.at",
    items: [
      ["Cineby", "www\\.cineby\\.at/movie"],
      ["Cineby", "www\\.cineby\\.at/tv"],
    ],
  },
  {
    host: "popcornmovies.org",
    items: [
      ["Popcorn Movies", "popcornmovies\\.org/movie"],
      ["Popcorn Movies", "popcornmovies\\.org/episode"],
    ],
  },
  { host: "onlyflix.to", items: [["OnlyFlix", "onlyflix\\.to/play"]] },
];

const CORRECTIONS: [string, string][] = [
  ["cineby.at::the wrong title", "Dune: Part Two (2024) · movie"],
  ["popcornmovies.org::srimulat", "Srimulat: Hidup Memang Komedi (2023) · movie"],
  ["onlyflix.to::spider noir e1", "Spider-Noir (2026) · show"],
  ["vidsrc.to::the bear", "The Bear (2022) · show"],
  ["flixhq.to::interstellar", "Interstellar (2014) · movie"],
];

export function OptionsView({ variant }: { variant: Variant }) {
  const t = tokens(variant);
  return (
    <div class={clsx("min-h-full px-6 py-8", t.page)}>
      <div class="mx-auto max-w-2xl space-y-8">
        <header class="flex items-center gap-2.5">
          <span class="grid size-9 place-items-center rounded-xl bg-trakt text-white">
            <Icon name="play" fill class="text-[16px]" />
          </span>
          <div>
            <h1 class={clsx("text-[18px] font-semibold tracking-tight", t.heading)}>
              TMSync settings
            </h1>
            <p class={clsx("text-[12px]", t.sub)}>Manage sites, links, recipes &amp; corrections</p>
          </div>
        </header>

        {/* Trakt */}
        <Section title="Trakt" t={t}>
          <Row t={t}>
            <span class="flex items-center gap-2 text-[13px]">
              <span class="size-2 rounded-full bg-emerald-500" />
              <span class={t.heading}>Connected</span>
            </span>
            <Btn t={t} tone="ghost">
              Disconnect
            </Btn>
          </Row>
        </Section>

        {/* Enabled sites */}
        <Section title={`Enabled sites · ${SITES.length}`} t={t}>
          <div class="space-y-1.5">
            {SITES.map((h) => (
              <Row t={t} key={h}>
                <Mono t={t}>{h}</Mono>
                <Btn t={t} tone="ghost">
                  Disable
                </Btn>
              </Row>
            ))}
          </div>
        </Section>

        {/* Quick links */}
        <Section
          title="Quick links"
          t={t}
          right={
            <Btn t={t} tone="link">
              <Icon name="plus" class="text-[12px]" /> Add blank
            </Btn>
          }
        >
          <p class={clsx("text-[12px]", t.sub)}>
            “Watch on …” buttons on Trakt movie/show pages. Toggle a site on to show it — keep it to
            your favourites. Order = display order.
          </p>
          <div class="space-y-1.5">
            {QUICK_LINKS.map((q, i) => {
              const open = i === 1; // show one expanded
              return (
                <div class={clsx("rounded-xl px-3 py-2.5", t.card)} key={q.name}>
                  <div class="flex items-center gap-3">
                    <Switch on={q.on} t={t} />
                    <span class="flex-1 truncate">
                      <span class={clsx("text-[13px] font-semibold", t.heading)}>{q.name}</span>
                      {q.library && (
                        <span class={clsx("ml-1.5 text-[11px]", t.faint)}>· library</span>
                      )}
                    </span>
                    <RowIcons t={t} open={open} />
                  </div>
                  {open && (
                    <div class={clsx("mt-3 space-y-2.5 border-t pt-3", t.divider)}>
                      {[
                        ["Movie URL", "https://popcornmovies.org/movie/{slug}"],
                        ["TV URL", "https://popcornmovies.org/episode/{slug}/{season}-{episode}"],
                        ["Search URL", "https://popcornmovies.org/search/{title}"],
                      ].map(([label, val]) => (
                        <label key={label} class="block">
                          <span class={clsx("mb-1 block text-[11px] font-medium", t.faint)}>
                            {label}
                          </span>
                          <input
                            value={val}
                            class={clsx(
                              "w-full rounded-lg px-2.5 py-1.5 font-mono text-[11px] outline-none ring-inset focus:ring-2",
                              t.input,
                            )}
                          />
                        </label>
                      ))}
                      <p class={clsx("text-[11px] leading-relaxed", t.faint)}>
                        Placeholders: {"{tmdb} {imdb} {season} {episode} {title} {slug}"}{" "}
                        (year-free), {"{slugyear}"} (with year).
                      </p>
                      <Btn t={t} tone="primary">
                        Save
                      </Btn>
                    </div>
                  )}
                </div>
              );
            })}
            <p class={clsx("text-[12px]", t.sub)}>
              From your recipes:{" "}
              <button type="button" class={clsx("underline underline-offset-2", t.link)}>
                + onlyflix.to
              </button>
            </p>
          </div>
        </Section>

        {/* Recipe library */}
        <Section
          title="Recipe library"
          t={t}
          right={
            <Btn t={t} tone="link">
              <Icon name="refresh" class="text-[12px]" /> Refresh
            </Btn>
          }
        >
          <p class={clsx("text-[12px]", t.sub)}>
            {LIBRARY.length} recipes from the library · updated just now
          </p>
          <div class="space-y-1.5">
            {LIBRARY.map(([name, pat]) => (
              <div class={clsx("rounded-xl px-3 py-2", t.card)} key={pat}>
                <span class={clsx("block text-[13px] font-semibold", t.heading)}>{name}</span>
                <code class={clsx("block truncate font-mono text-[11px]", t.faint)}>{pat}</code>
              </div>
            ))}
          </div>
          <p class={clsx("text-[11px] leading-relaxed", t.faint)}>
            Recipes are shared through the project repo (no server) and merge with your own (yours
            win). Add a site by opening a PR —{" "}
            <span class={clsx("underline underline-offset-2", t.link)}>contribute here</span>.
          </p>
        </Section>

        {/* Your recipes */}
        <Section title="Your recipes" t={t}>
          <div class="space-y-3">
            {RECIPES.map((g) => (
              <div key={g.host}>
                <div
                  class={clsx("mb-1.5 flex items-center justify-between px-1 text-[11px]", t.faint)}
                >
                  <code class="font-mono">{g.host}</code>
                  <span>
                    {g.items.length} recipe{g.items.length > 1 ? "s" : ""}
                  </span>
                </div>
                <div class="space-y-1.5">
                  {g.items.map(([name, pat]) => (
                    <div class={clsx("rounded-xl px-3 py-2.5", t.card)} key={pat}>
                      <div class="min-w-0">
                        <span class={clsx("block text-[13px] font-semibold", t.heading)}>
                          {name}
                        </span>
                        <code class={clsx("block truncate font-mono text-[11px]", t.faint)}>
                          {pat}
                        </code>
                      </div>
                      <div class={clsx("mt-2 flex gap-3 border-t pt-2", t.divider)}>
                        <Btn t={t} tone="link">
                          <Icon name="copy" class="text-[12px]" /> Copy JSON
                        </Btn>
                        <Btn t={t} tone="link" class="!text-rose-500">
                          <Icon name="trash" class="text-[12px]" /> Delete
                        </Btn>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Corrections */}
        <Section
          title={`Corrections · ${CORRECTIONS.length}`}
          t={t}
          right={
            <Btn t={t} tone="link" class="!text-rose-500">
              Clear all
            </Btn>
          }
        >
          <div class="space-y-1.5">
            {CORRECTIONS.map(([key, val]) => (
              <div class={clsx("rounded-xl px-3 py-2.5", t.card)} key={key}>
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <code class={clsx("block truncate font-mono text-[11px]", t.faint)}>{key}</code>
                    <span class={clsx("text-[12px]", t.heading)}>→ {val}</span>
                  </div>
                  <Btn t={t} tone="link" class="!text-rose-500">
                    Remove
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
