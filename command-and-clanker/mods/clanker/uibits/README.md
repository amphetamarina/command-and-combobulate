# Custom art slots

Drop-in replacements for the mod's custom images. Keep the filenames and sizes
below and the game picks them up on next launch — no code changes needed.

## Load screen (banner logo)
A centered banner on the loading screen (dark background + animated stripe +
the loading phrases). Wide 2:1 banner, PNG, transparent or dark background.
- `clanker-loadscreen.png` — 512x256
- `clanker-loadscreen-2x.png` — 1024x512
- `clanker-loadscreen-3x.png` — 2048x1024

(The committed files are dark placeholders; overwrite them with real art.)

## Terminal build cameo
The icon in the production sidebar.
- `terminal-icon.png` — 62x46 PNG

## Terminal building sprite (not wired yet)
The in-world building that replaces the construction-yard look. Generate a
transparent PNG in Red Alert's three-quarter top-down perspective (light from
the top-left), with the base reading ~72px wide on a ~192px canvas. Hand it
over and it gets wired with a placement offset (needs one visual tuning pass).
