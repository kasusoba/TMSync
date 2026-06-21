/**
 * Keep a shadow-root host visible AND interactive above site modals.
 *
 * Sites that play inside `<dialog>.showModal()` (or use the Fullscreen API) put
 * that element in the browser **top layer** and make everything else **inert** —
 * so our overlay (badge, picker), mounted on `<body>`, is both painted behind the
 * modal and non-clickable (no pointer events, no cursor). `z-index` can't escape
 * the top layer, and nothing can opt an inert subtree back in (a popover in the
 * top layer is still inert while a modal is open).
 *
 * The one robust fix is to live INSIDE the active modal: a descendant of the
 * top-layer modal paints in the top layer and is exempt from the inertness. So we
 * re-parent our host into the open modal while one exists, and back to `<body>`
 * when it closes. Moving the host node preserves the shadow root and its Preact
 * tree, so UI state is kept across the move.
 *
 * Returns a disposer that stops the observer.
 */

/** Modal elements we can actually nest inside (skip replaced media like a
 *  fullscreen `<video>`/`<img>`, which can't host children). */
function activeModal(): HTMLElement | null {
  const modals = Array.from(document.querySelectorAll<HTMLElement>(":modal")).filter(
    (el) => !(el instanceof HTMLMediaElement || el instanceof HTMLImageElement),
  );
  // Last in document order ≈ the active (non-inert) one for the common
  // single-modal case; nested modals are rare on streaming sites.
  return modals.at(-1) ?? null;
}

/** True if a mutation could change which element (if any) is the active modal. */
function touchesModal(records: MutationRecord[]): boolean {
  const hasDialog = (nodes: NodeList) =>
    Array.from(nodes).some(
      (n) => n instanceof Element && (n.matches("dialog") || n.querySelector("dialog") !== null),
    );
  return records.some(
    (r) =>
      (r.type === "attributes" && r.attributeName === "open") ||
      hasDialog(r.addedNodes) ||
      hasDialog(r.removedNodes),
  );
}

export function keepAboveModals(host: HTMLElement): () => void {
  const place = () => {
    const target = activeModal() ?? document.body;
    // Idempotent: only move when the parent is actually wrong (so our own move
    // doesn't ping-pong with the observer). A modal closing can detach the host
    // along with the modal — re-attaching to <body> here revives it.
    if (host.parentElement !== target) target.appendChild(host);
  };
  place();

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      place();
    });
  };

  const obs = new MutationObserver((records) => {
    if (touchesModal(records)) schedule();
  });
  obs.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["open"],
  });
  // Fullscreen has no DOM-attribute signal — it fires its own event.
  document.addEventListener("fullscreenchange", schedule, true);

  return () => {
    obs.disconnect();
    document.removeEventListener("fullscreenchange", schedule, true);
  };
}
