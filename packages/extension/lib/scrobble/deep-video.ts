/**
 * Videos inside open shadow roots. Some players are web components that keep
 * their `<video>` in a shadow root (the Internet Archive's `<play-av>`), where
 * `document.querySelectorAll` cannot see it. Closed shadow roots stay out of
 * reach, as they must.
 */

/** TMSync's own injected UI hosts (badge, picker, quick links): never searched. */
const OWN_HOST = /^TMSYNC-/;

/** Every open shadow root under `root`, nested ones included, except TMSync's own. */
export function openShadowRoots(root: Document | ShadowRoot): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  for (const el of root.querySelectorAll("*")) {
    const shadow = el.shadowRoot;
    if (!shadow || OWN_HOST.test(el.tagName)) continue;
    out.push(shadow, ...openShadowRoots(shadow));
  }
  return out;
}

/** The `<video>` elements in every open shadow root under `root`. */
export function shadowVideos(root: Document | ShadowRoot): HTMLVideoElement[] {
  return openShadowRoots(root).flatMap((s) => [...s.querySelectorAll<HTMLVideoElement>("video")]);
}
