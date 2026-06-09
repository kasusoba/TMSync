import clsx from "clsx";
import { useState } from "preact/hooks";
import {
  Btn,
  Icon,
  IconBtn,
  type IconName,
  Switch,
  type Tokens,
  type Variant,
  tokens,
} from "./kit";

function Mono({ t, children }: { t: Tokens; children: preact.ComponentChildren }) {
  return <code class={clsx("truncate font-mono text-[12px]", t.heading)}>{children}</code>;
}

function Card({ t, children }: { t: Tokens; children: preact.ComponentChildren }) {
  return <div class={clsx("rounded-lg px-3 py-2", t.card)}>{children}</div>;
}

function PaneHead({
  t,
  title,
  right,
}: {
  t: Tokens;
  title: string;
  right?: preact.ComponentChildren;
}) {
  return (
    <div class="flex items-center justify-between">
      <h2 class={clsx("text-[15px] font-semibold", t.heading)}>{title}</h2>
      {right}
    </div>
  );
}

function Filter({
  t,
  q,
  setQ,
  placeholder,
}: {
  t: Tokens;
  q: string;
  setQ: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div class={clsx("flex items-center gap-2 rounded-lg px-2.5", t.input)}>
      <Icon name="search" class={clsx("text-[14px]", t.faint)} />
      <input
        value={q}
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        placeholder={placeholder}
        class="w-full bg-transparent py-1.5 text-[13px] outline-none"
      />
    </div>
  );
}

// --- mock data sized to stress the layout (realistic volume) ---
type Pair = [string, string];
const pair = (a: string, b: string): Pair => [a, b];

const NAMES = [
  "Rive",
  "CorsFlix",
  "Cineby",
  "Cineplay",
  "Fmovies+",
  "PopcornMovies",
  "BingeBox",
  "Flixer",
  "Hexa",
  "FlickyStream",
  "MeowTV",
  "CineMora",
  "Cinevibe",
  "bCine",
  "Coreflix",
  "Vyla",
  "ShuttleTV",
  "Poprink",
  "Cinegram",
  "LordFlix",
  "Stigstream",
  "dulo.tv",
  "MovieBite",
  "TouStream",
  "IceFY",
  "Lunara",
  "SpenFlix",
  "Willow",
  "Flixtrz",
  "NomorFlix",
  "CineBolt",
  "ZXCSTREAM",
  "NetPlay",
  "Cinelove",
  "Screenscape",
  "Mapple.tv",
  "Watch Surface",
  "Watchott",
  "StreamVaults",
  "ReelStream",
  "Chillflix",
  "GaiaFlix",
  "Vegeta TV",
  "Smashystream",
  "VidPlay",
  "Nxsha",
];
const TLDS = ["to", "net", "cc", "watch", "stream", "mov", "sbs"];
const hostOf = (n: string, i: number) =>
  `${n.toLowerCase().replace(/[^a-z0-9]+/g, "")}.${TLDS[i % TLDS.length] ?? "to"}`;
const nameAt = (i: number) => NAMES[i % NAMES.length] ?? "Site";

const SITES = NAMES.slice(0, 24).map(hostOf);
const QUICK_LINKS = NAMES.slice(0, 22).map((name, i) => ({
  name,
  on: i % 3 !== 0,
  library: i % 4 === 0,
}));
const LIBRARY: Pair[] = NAMES.slice(0, 16).flatMap((n, i) => [
  pair(n, `${hostOf(n, i).replace(/\./g, "\\.")}/movie`),
  pair(n, `${hostOf(n, i).replace(/\./g, "\\.")}/tv`),
]);
const RECIPES = NAMES.slice(0, 7).map((n, i) => {
  const e = hostOf(n, i).replace(/\./g, "\\.");
  const items: Pair[] =
    i % 2 === 0 ? [pair(n, `${e}/movie`), pair(n, `${e}/tv`)] : [pair(n, `${e}/watch`)];
  return { host: hostOf(n, i), items };
});
const SUGGESTIONS = NAMES.slice(24, 42).map(hostOf);
const TITLES = [
  "Dune: Part Two (2024) · movie",
  "The Bear (2022) · show",
  "Interstellar (2014) · movie",
  "Spider-Noir (2026) · show",
  "Oppenheimer (2023) · movie",
  "Severance (2022) · show",
  "Sinners (2025) · movie",
  "Andor (2022) · show",
];
const CORRECTIONS: Pair[] = TITLES.map((title, i) =>
  pair(`${hostOf(nameAt(i), i)}::wrong title ${i + 1}`, title),
);

const SECTIONS: { id: string; label: string; icon: IconName; count?: number }[] = [
  { id: "trakt", label: "Trakt", icon: "play" },
  { id: "sites", label: "Sites", icon: "frame", count: SITES.length },
  { id: "links", label: "Quick links", icon: "link", count: QUICK_LINKS.length },
  { id: "library", label: "Library", icon: "refresh", count: LIBRARY.length },
  {
    id: "recipes",
    label: "Your recipes",
    icon: "edit",
    count: RECIPES.reduce((a, g) => a + g.items.length, 0),
  },
  { id: "corrections", label: "Corrections", icon: "check", count: CORRECTIONS.length },
];

export function OptionsView({ variant }: { variant: Variant }) {
  const t = tokens(variant);
  const [active, setActive] = useState("sites");
  const [openLink, setOpenLink] = useState<string | null>(QUICK_LINKS[1]?.name ?? null);
  const [q, setQ] = useState("");
  const has = (s: string) => s.toLowerCase().includes(q.toLowerCase());

  return (
    <div class={clsx("flex min-h-full flex-col", t.page)}>
      <header class={clsx("flex items-center gap-2.5 border-b px-5 py-3.5", t.divider)}>
        <span class="grid size-8 place-items-center rounded-lg bg-trakt text-white">
          <Icon name="play" fill class="text-[15px]" />
        </span>
        <span class={clsx("text-[15px] font-semibold tracking-tight", t.heading)}>
          TMSync settings
        </span>
      </header>

      <div class="flex flex-1">
        {/* tab rail */}
        <nav class={clsx("w-52 shrink-0 space-y-0.5 border-r p-3", t.divider)}>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setActive(s.id);
                setQ("");
              }}
              class={clsx(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                active === s.id
                  ? clsx(t.card, t.heading, "font-medium")
                  : clsx(t.sub, "hover:bg-white/5"),
              )}
            >
              <Icon name={s.icon} class="text-[14px]" />
              <span class="flex-1">{s.label}</span>
              {s.count !== undefined && (
                <span class={clsx("rounded-full px-1.5 py-0.5 text-[10px] tabular-nums", t.chip)}>
                  {s.count}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* active pane */}
        <main class="min-w-0 flex-1 p-6">
          <div class="mx-auto max-w-xl space-y-3">
            {active === "trakt" && (
              <>
                <PaneHead t={t} title="Trakt" />
                <div
                  class={clsx("flex items-center justify-between rounded-lg px-3 py-2.5", t.card)}
                >
                  <span class="flex items-center gap-2 text-[13px]">
                    <span class="size-2 rounded-full bg-emerald-500" />
                    <span class={t.heading}>Connected</span>
                  </span>
                  <Btn t={t} tone="ghost">
                    Disconnect
                  </Btn>
                </div>
              </>
            )}

            {active === "sites" && (
              <>
                <PaneHead t={t} title="Enabled sites" />
                <Filter t={t} q={q} setQ={setQ} placeholder="Filter sites…" />
                <div class="space-y-1.5">
                  {SITES.filter(has).map((h) => (
                    <div
                      key={h}
                      class={clsx(
                        "flex items-center justify-between gap-3 rounded-lg px-3 py-2",
                        t.card,
                      )}
                    >
                      <Mono t={t}>{h}</Mono>
                      <Btn t={t} tone="ghost">
                        Disable
                      </Btn>
                    </div>
                  ))}
                </div>
              </>
            )}

            {active === "links" && (
              <>
                <PaneHead
                  t={t}
                  title="Quick links"
                  right={
                    <Btn t={t} tone="ghost">
                      <Icon name="plus" class="text-[12px]" /> Add blank
                    </Btn>
                  }
                />
                <p class={clsx("text-[12px]", t.sub)}>
                  “Watch on …” buttons on Trakt pages. Toggle a site on to show it; order = display
                  order.
                </p>
                <Filter t={t} q={q} setQ={setQ} placeholder="Filter quick links…" />
                <div class="space-y-1.5">
                  {QUICK_LINKS.filter((l) => has(l.name)).map((l) => {
                    const open = openLink === l.name;
                    return (
                      <div class={clsx("rounded-lg px-3 py-2", t.card)} key={l.name}>
                        <div class="flex items-center gap-3">
                          <Switch on={l.on} t={t} />
                          <span class="flex-1 truncate">
                            <span class={clsx("text-[13px] font-medium", t.heading)}>{l.name}</span>
                            {l.library && (
                              <span class={clsx("ml-1.5 text-[11px]", t.faint)}>· library</span>
                            )}
                          </span>
                          <IconBtn t={t} name="up" title="Move up" />
                          <IconBtn t={t} name="down" title="Move down" />
                          <IconBtn
                            t={t}
                            name="edit"
                            title="Edit"
                            onClick={() => setOpenLink(open ? null : l.name)}
                          />
                          <IconBtn t={t} name="trash" title="Delete" danger />
                        </div>
                        {open && (
                          <div class={clsx("mt-3 space-y-2.5 border-t pt-3", t.divider)}>
                            {[
                              ["Movie URL", "https://site/movie/{slug}"],
                              ["TV URL", "https://site/episode/{slug}/{season}-{episode}"],
                              ["Search URL", "https://site/search/{title}"],
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
                            <Btn t={t} tone="primary">
                              Save
                            </Btn>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div class={clsx("flex flex-wrap items-center gap-1.5 pt-1 text-[12px]", t.sub)}>
                  <span class="mr-1 shrink-0">From your recipes:</span>
                  {SUGGESTIONS.map((h) => (
                    <button
                      key={h}
                      type="button"
                      class={clsx(
                        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px]",
                        t.ghost,
                      )}
                    >
                      <Icon name="plus" class="text-[10px]" />
                      {h}
                    </button>
                  ))}
                </div>
              </>
            )}

            {active === "library" && (
              <>
                <PaneHead
                  t={t}
                  title="Recipe library"
                  right={
                    <Btn t={t} tone="ghost">
                      <Icon name="refresh" class="text-[12px]" /> Refresh
                    </Btn>
                  }
                />
                <p class={clsx("text-[12px]", t.sub)}>
                  {LIBRARY.length} recipes · updated just now
                </p>
                <Filter t={t} q={q} setQ={setQ} placeholder="Filter library…" />
                <div class="space-y-1.5">
                  {LIBRARY.filter(([n, p]) => has(n) || has(p)).map(([name, patt]) => (
                    <Card t={t} key={patt}>
                      <span class={clsx("block text-[13px] font-medium", t.heading)}>{name}</span>
                      <code class={clsx("block truncate font-mono text-[11px]", t.faint)}>
                        {patt}
                      </code>
                    </Card>
                  ))}
                </div>
                <p class={clsx("text-[11px] leading-relaxed", t.faint)}>
                  Shared through the project repo (no server) and merged with your own (yours win).
                  Add a site by opening a PR —{" "}
                  <a href="#contribute" class={clsx("underline underline-offset-2", t.link)}>
                    contribute here
                  </a>
                  .
                </p>
              </>
            )}

            {active === "recipes" && (
              <>
                <PaneHead t={t} title="Your recipes" />
                <Filter t={t} q={q} setQ={setQ} placeholder="Filter recipes…" />
                <div class="space-y-3">
                  {RECIPES.map((g) => {
                    const items = g.items.filter(([n, p]) => has(n) || has(p) || has(g.host));
                    if (items.length === 0) return null;
                    return (
                      <div key={g.host}>
                        <div
                          class={clsx(
                            "mb-1.5 flex items-center justify-between px-1 text-[11px]",
                            t.faint,
                          )}
                        >
                          <code class="font-mono">{g.host}</code>
                          <span>
                            {items.length} recipe{items.length > 1 ? "s" : ""}
                          </span>
                        </div>
                        <div class="space-y-1.5">
                          {items.map(([name, patt]) => (
                            <div
                              key={patt}
                              class={clsx(
                                "flex items-center justify-between gap-2 rounded-lg px-3 py-2",
                                t.card,
                              )}
                            >
                              <div class="min-w-0">
                                <span class={clsx("block text-[13px] font-medium", t.heading)}>
                                  {name}
                                </span>
                                <code class={clsx("block truncate font-mono text-[11px]", t.faint)}>
                                  {patt}
                                </code>
                              </div>
                              <div class="flex shrink-0 items-center">
                                <IconBtn t={t} name="copy" title="Copy JSON" />
                                <IconBtn t={t} name="trash" title="Delete" danger />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {active === "corrections" && (
              <>
                <PaneHead
                  t={t}
                  title="Corrections"
                  right={
                    <Btn t={t} tone="danger">
                      Clear all
                    </Btn>
                  }
                />
                <Filter t={t} q={q} setQ={setQ} placeholder="Filter corrections…" />
                <div class="space-y-1.5">
                  {CORRECTIONS.filter(([k, v]) => has(k) || has(v)).map(([key, val]) => (
                    <div
                      key={key}
                      class={clsx(
                        "flex items-center justify-between gap-2 rounded-lg px-3 py-2",
                        t.card,
                      )}
                    >
                      <div class="min-w-0">
                        <code class={clsx("block truncate font-mono text-[11px]", t.faint)}>
                          {key}
                        </code>
                        <span class={clsx("text-[12px]", t.heading)}>→ {val}</span>
                      </div>
                      <IconBtn t={t} name="trash" title="Remove" danger />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
