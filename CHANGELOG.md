# Changelog

## 0.1.42 (2026-10-02)

- The red capture pill on the taskbar strip now shows time remaining for a render, in the same wording as the full popup ("~22 min left"). A render with no progress for 10 minutes says so instead.

## 0.1.41 (2026-10-02)

- The capture pipeline popup (the red pill on the taskbar strip) now stays open when you click other apps. Only its X closes it, and closing just hides it: the strip and the pipeline keep running, and clicking the red pill brings it back.
- Clicking the red pill while the popup is open brings it to the front instead of closing it.
- The popup reopens where you last moved it and at the size you last left it.
- Quit from the tray menu now works even after the popup has been opened.

## 0.1.40 (2026-09-26)

- Launching the app while it is already running no longer looks like nothing happened. The second copy still quits at once, and the running one now brings its taskbar strip back and opens the HUD above it. Before, only the HUD window was shown and the strip was left alone. With the strip turned off, the HUD opens on its own as before. Each such launch is logged in `strip.log`.

## Earlier versions

Taken from the commit history.

- 0.1.39 (2026-09-21): strip bars coloured by pace, not raw percentage
- 0.1.38 (2026-09-21): throttle alerts when a limit is used faster than it refills
- 0.1.37 (2026-09-21): taskbar strip over the primary taskbar
- 0.1.36 (2026-08-30): restore drag-anywhere, move opacity to a title-bar handle
- 0.1.34 (2026-08-30): smooth, immediate opacity readout while right-dragging
- 0.1.33 (2026-08-30): make the opacity gesture visible immediately
- 0.1.32 (2026-08-30): right-drag opacity actually reaches the app
- 0.1.31 (2026-08-30): stable window geometry, right-drag opacity, dwell-only unpin
- 0.1.26 (2026-08-30): dwell on the pin button to unpin
- 0.1.25 (2026-08-30): middle-click a pinned window to unpin it
- 0.1.24 (2026-08-29): keep the window on top when Windows demotes it
- 0.1.22 (2026-08-22): name the day in the run-out projection
- 0.1.21 (2026-08-22): keep pace ticks on stale data, name the signed-out state, rescue tiny windows
- 0.1.19 (2026-08-20): readable text at every size, responsive compact layout
- 0.1.16 (2026-08-20): resizable window, even-pace tick marks on the limit bars
- 0.1.13 (2026-08-16): fix window growing when dragged, especially across monitors
- 0.1.10 (2026-08-13): settings reachable from compact view, pinned window ignores hover
- 0.1.9 (2026-08-13): automatic token renewal, fix window width creep on drag
- 0.1.7 (2026-08-13): always start unpinned
- 0.1.6 (2026-08-12): fix frozen limit bars, detailed cost grid
- 0.1.5 (2026-08-12): separators + stacked week-by-model bar with per-model colors
- 0.1.4 (2026-08-12): compact window fits content exactly (fix grow-only auto-height), tighter spacing
- 0.1.3 (2026-08-12): pinned window keeps idle transparency (no hover-brighten in click-through mode)
- 0.1.2 (2026-08-12): always-visible per-model weekly spend, gentler limits polling, auto-height
- 0.1.1 (2026-08-11): plan-savings display, 429 handling, hidden-window fix, limits cache
- 0.1.0 (2026-08-11): initial release
