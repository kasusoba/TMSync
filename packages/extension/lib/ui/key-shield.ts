import { useEffect } from "preact/hooks";

/**
 * Stop keystrokes typed inside an injected shadow-DOM UI (badge, picker) from
 * firing the host page's and OTHER extensions' keyboard shortcuts.
 *
 * Element-level stopPropagation only stops BUBBLE-phase listeners; site players
 * and especially other extensions often bind keydown in the CAPTURE phase on
 * document/window, which fires BEFORE the event reaches our input — so a bubble
 * stop is too late (a gap MALSync's document-level stop shares). A window
 * capture-phase listener runs first of all, and DOM propagation is shared across
 * isolated worlds, so stopping here blocks those handlers too.
 *
 * We swallow two classes of key, only when the event originates inside our host:
 *  1. PRINTABLE single-character keys (a, k, space…) — what fires letter
 *     shortcuts. Always swallowed inside our UI.
 *  2. Text caret / selection / editing keys (arrows incl. Shift/Ctrl+arrow, Home,
 *     End, PageUp/Down, Backspace, Delete; Enter in a textarea) — but ONLY while
 *     focus is in one of our own editable fields. Otherwise e.g. asbplayer's
 *     "Shift+Arrow = subtitle offset" fires AND preventDefaults our textarea, so
 *     typing can't even select text. Swallowing here lets the field do its native
 *     editing while nothing leaks.
 *
 * stopPropagation never cancels the DEFAULT action, so the caret still moves, text
 * still highlights, and characters still insert (our inputs read the `input`
 * event, not keydown). Control keys we DON'T swallow (Enter in inputs, Escape,
 * Tab) pass through to our own panel handlers; element-level stopKeys then keeps
 * THOSE from leaking on the bubble back up.
 *
 * `rootRef` is any element inside the shadow root; its host is derived from it.
 */

/** Keys that move the caret / change the selection / edit text in a field. */
const EDIT_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
]);

function isTextField(node: EventTarget | undefined): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
}

export function useKeyShield<T extends HTMLElement>(rootRef: { current: T | null }): void {
  useEffect(() => {
    const shield = (e: KeyboardEvent) => {
      const root = rootRef.current;
      const host =
        root && root.getRootNode() instanceof ShadowRoot
          ? (root.getRootNode() as ShadowRoot).host
          : root;
      if (!host) return;
      const path = e.composedPath();
      if (!path.includes(host)) return;

      // 1) printable keys — letter/space shortcuts.
      if (e.key.length === 1) {
        e.stopImmediatePropagation();
        return;
      }

      // 2) editing/navigation keys — only while typing in one of our fields, so
      // they edit the text instead of triggering page/other-extension shortcuts.
      const target = path[0];
      if (!isTextField(target)) return;
      const isTextarea = target instanceof HTMLElement && target.tagName === "TEXTAREA";
      if (EDIT_KEYS.has(e.key) || (e.key === "Enter" && isTextarea)) {
        e.stopImmediatePropagation();
      }
    };
    const types = ["keydown", "keyup", "keypress"] as const;
    for (const type of types) window.addEventListener(type, shield, true);
    return () => {
      for (const type of types) window.removeEventListener(type, shield, true);
    };
  }, [rootRef]);
}
