import { useEffect } from "preact/hooks";

/**
 * Stop printable keystrokes typed inside an injected shadow-DOM UI (badge, picker)
 * from firing the host page's and OTHER extensions' keyboard shortcuts.
 *
 * Element-level stopPropagation only stops BUBBLE-phase listeners; site players
 * and especially other extensions often bind keydown in the CAPTURE phase on
 * document/window, which fires BEFORE the event reaches our input — so a bubble
 * stop is too late (a gap MALSync's document-level stop shares). A window
 * capture-phase listener runs first of all, and DOM propagation is shared across
 * isolated worlds, so stopping here blocks those handlers too.
 *
 * We only swallow PRINTABLE single-character keys (a, k, space… — what fires
 * letter shortcuts) and only when the event originates inside our shadow host.
 * Control keys (Enter/Escape/Tab) pass through so our own panel handlers still
 * work; element-level stopKeys then keeps THOSE from leaking on the bubble back
 * up. Typing is unaffected: stopPropagation never cancels the default action, and
 * our inputs update from the `input` event (not keydown).
 *
 * `rootRef` is any element inside the shadow root; its host is derived from it.
 */
export function useKeyShield<T extends HTMLElement>(rootRef: { current: T | null }): void {
  useEffect(() => {
    const shield = (e: KeyboardEvent) => {
      if (e.key.length !== 1) return; // control keys pass through to our handlers
      const root = rootRef.current;
      const host =
        root && root.getRootNode() instanceof ShadowRoot
          ? (root.getRootNode() as ShadowRoot).host
          : root;
      if (host && e.composedPath().includes(host)) e.stopImmediatePropagation();
    };
    const types = ["keydown", "keyup", "keypress"] as const;
    for (const type of types) window.addEventListener(type, shield, true);
    return () => {
      for (const type of types) window.removeEventListener(type, shield, true);
    };
  }, [rootRef]);
}
