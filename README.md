<div align="center">
  <img src="packages/extension/public/icon/128.png" width="96" height="96" alt="TMSync icon">
  <h1>TMSync</h1>
  <p>
    <a href="https://chromewebstore.google.com/detail/tmsync/hkfpacmhbiccimikfleemmhfemdnjfpf"><b>Install for Chrome</b></a>
    &nbsp;·&nbsp;
    <a href="https://addons.mozilla.org/en-US/firefox/addon/tmsync/"><b>Install for Firefox</b></a>
  </p>
</div>

Automatically scrobble what you watch to your media trackers, on the sites you choose. TMSync is
multi-tracker by design. Today it supports [Trakt](https://trakt.tv),
[WeTrakr](https://wetrakr.com), [AniList](https://anilist.co),
[MyAnimeList](https://myanimelist.net), and [Simkl](https://simkl.com), with room for more.

TMSync is a browser extension for Chrome and Firefox. While you watch on a site you set up, it
reads what's playing, finds it on the right tracker, and logs it for you. No manual check-ins.
It works on any site with a video player and a readable title, even one with no official app or
API. TMSync comes with no sites: you add the ones you use.

Each thing you watch is routed to the trackers that fit it, all at once if you like:

| Tracker | Takes |
|---|---|
| Trakt, WeTrakr, Simkl | Everything: movies and TV, live-action and anime |
| AniList, MyAnimeList | Anime only: series and movies |

You choose which trackers are on for each site. If you know MAL-Sync for anime, this is the same
idea, made general across trackers.

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/screenshots/scrobble.jpeg" alt="TMSync scrobbling a show, with the on-page badge and the point-and-click site editor">
      <br><sub>Passive scrobbling with the on-page badge, plus the point-and-click site editor.</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/screenshots/quick-links.png" alt="A TMSync 'watch on' quick link injected onto an AniList page">
      <br><sub>"Watch on" quick links injected onto Trakt and AniList pages.</sub>
    </td>
  </tr>
</table>

## What it does

- Detects the title and episode when you press play and records it to the right tracker. Trakt,
  WeTrakr, and Simkl update in real time, so your profile shows what you're currently watching. AniList
  and MyAnimeList get one list update per episode, once you pass the point where it counts as
  watched.
- Works on any site with a video and a readable title, including ones with no API. It comes with
  no sites, and you add the ones you use.
- Lets you add a site yourself with a point-and-click picker, like an ad blocker's element
  picker. No code.
- Or add a recipe source: a file of sites that someone else set up, at a web address. Share your
  own sites the same way.
- Got the wrong match? Click the badge, search the tracker, pick the right one. It remembers the fix.
- Rate what you watch and keep a private note per item, synced back to your tracker (Simkl
  takes ratings only).
- Asks before it touches a finished series. Watching a completed anime again shows a
  "Rewatching?" prompt first, and TMSync never lowers the progress you already have.
- Keeps your lists in sync. List sync reads every connected tracker, shows you the plan
  (episodes, status, ratings, and anything it would remove), and writes it only when you apply.
  Pick one tracker as the main list, or let each list fill in what the others have. A removal
  on one list carries over to the others. You can turn on a daily automatic sync (it only adds;
  removals and conflicts wait for you).
- Adds "watch on..." links to trakt.tv, wetrakr.com, and anilist.co pages that take you to your
  own sites at the right episode.
- Backs up your sites, quick links, and corrections to a file, and exports your Trakt or WeTrakr
  movie history to Letterboxd as a CSV.
- Your watch history only goes to your own tracker accounts. Matching and scrobbling happen on
  your machine, and each item goes only to the trackers it's routed to.
- Only gets access to a site once you enable it there. No broad permissions at install.

## Getting started

1. Install it from the
   [Chrome Web Store](https://chromewebstore.google.com/detail/tmsync/hkfpacmhbiccimikfleemmhfemdnjfpf)
   or [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tmsync/).
2. Click the toolbar icon and connect the trackers you use: Trakt, WeTrakr, AniList, MyAnimeList, Simkl,
   or any mix. MyAnimeList asks for access to myanimelist.net when you connect it.
3. Add your sites. On a movie or episode page, click "Set up recipe" in the toolbar popup and
   point at the title and episode. Or, if someone shared a recipe source with you, paste its
   address in Options, under Sources.
4. Turn TMSync on for the site in the popup and press play. A small badge shows what it matched.

## Contributing

Code contributions are welcome. This repo does not keep a list of sites: to share yours, save them
as a recipe source from Options, under Sources, and post the file anywhere. The recipe and source
format is in [`docs/RECIPES.md`](./docs/RECIPES.md), and running the code locally is in
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

For how the code works, start with [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Support & status

This is a hobby project, maintained in spare time on a best-effort basis, with no SLA and no
guarantees. Issues and PRs are read and appreciated, but may be answered slowly. If something's
broken, opening an issue with the details is the most useful thing you can do.

Want to chat or ask a question? Join the
[TMSync Discord](https://discord.gg/XCRsUnrJR).

<!--
  Chrome Web Store listing copy, kept here so it stays in sync.

  Short description (max 132 chars):
  Auto-scrobble what you watch to your trackers (Trakt, WeTrakr, AniList, MyAnimeList, Simkl) on the sites you set up.

  Full description: the "What it does" + "Getting started" sections above.

  Host permission justification (optional host access, "*://*/*"):
  TMSync comes with no sites. It asks for access to one site at a time, only when the user turns
  it on. It needs access to a site the user set up to read the title and episode that plays
  there. When the user adds a recipe source (a file of site settings at a web address), it asks
  for read access to that address's host, unless the host already allows it. It also asks
  for access to myanimelist.net and api.myanimelist.net only when the user connects a
  MyAnimeList account, to sign in and to update that user's anime list. MyAnimeList's API
  does not allow calls from other origins without this access. In the same way it asks for
  access to api.wetrakr.com and wetrakr.com only when the user connects a WeTrakr account: to
  sign in, to record that user's watches, and to show "watch on" links on wetrakr.com pages.
  No access is granted at install.
-->

## License

[GPL-3.0](./LICENSE). You're free to use, study, modify, and share it; derivative works must stay
open under the same license. TMSync talks only to your own Trakt, AniList, MyAnimeList, and
Simkl accounts and is not affiliated with or endorsed by Trakt, AniList, MyAnimeList, or Simkl.
