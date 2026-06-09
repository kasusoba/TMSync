import { PickerPanel, type UrlPart } from "@/lib/ui/proto/PickerPanel";
import { PopupView } from "@/lib/ui/proto/PopupView";
import { type Variant, tokens } from "@/lib/ui/proto/kit";
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
    parts.push({ num: m[0], ordinal: ordinal++ });
    last = idx + m[0].length;
  }
  if (last < href.length) parts.push({ text: href.slice(last) });
  return parts;
}

function Tile({
  label,
  t,
  children,
}: { label: string; t: ReturnType<typeof tokens>; children: preact.ComponentChildren }) {
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

const EP_URL = "popcornmovies.org/episode/spider-noir/1-1";

export function App() {
  const [variant, setVariant] = useState<Variant>("trakt");
  const t = tokens(variant);

  return (
    <div class={clsx("min-h-screen px-6 py-6", t.page)}>
      {/* toolbar */}
      <div class="mx-auto mb-8 flex max-w-6xl items-center justify-between">
        <div>
          <h1 class={clsx("text-lg font-semibold tracking-tight", t.heading)}>
            TMSync · UI Gallery
          </h1>
          <p class={clsx("text-[12px]", t.sub)}>
            Prototype — popup &amp; picker, two directions. Pick one and it gets wired in.
          </p>
        </div>
        <div class={clsx("flex gap-1 rounded-xl p-1", t.card)}>
          {(["clean", "trakt"] as Variant[]).map((v) => (
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

      <div class="mx-auto max-w-6xl space-y-10">
        {/* POPUP */}
        <section class="space-y-4">
          <h2 class={clsx("text-sm font-semibold", t.heading)}>Popup</h2>
          <div class="grid gap-6 lg:grid-cols-2">
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
            <Tile label="Connected · enabled + player frame" t={t}>
              <PopupView
                variant={variant}
                connected
                note="Enabled — reload the page to start."
                origins={[
                  { origin: "https://www.cineby.at", isTop: true, enabled: true },
                  { origin: "https://onlyflix.to", isTop: false, enabled: false },
                ]}
              />
            </Tile>
            <Tile label="Connected · no streaming page" t={t}>
              <PopupView variant={variant} connected origins={[]} />
            </Tile>
          </div>
        </section>

        {/* PICKER */}
        <section class="space-y-4">
          <h2 class={clsx("text-sm font-semibold", t.heading)}>Picker</h2>
          <div class="grid gap-6 lg:grid-cols-2">
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
                iframe={false}
                preview={{ ok: true, text: "show: Spider-Noir S1E1" }}
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
                iframe
                preview={{ ok: false, error: "no title yet — pick one" }}
              />
            </Tile>
            <Tile label="Edit · loaded your saved recipe" t={t}>
              <PickerPanel
                variant={variant}
                mode="edit"
                name="Cineby"
                banner={{ kind: "edit" }}
                fields={[
                  { key: "title", label: "Title", value: "Dune: Part Two", source: "meta" },
                  { key: "year", label: "Year", value: "2024", source: "dom" },
                  { key: "season", label: "Season", value: null },
                  { key: "episode", label: "Episode", value: null },
                ]}
                urlParts={urlParts("www.cineby.at/movie/693134")}
                mediaType="movie"
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
                iframe={false}
                preview={{ ok: true, text: "movie: Srimulat (2023)" }}
              />
            </Tile>
          </div>
        </section>
      </div>
    </div>
  );
}
