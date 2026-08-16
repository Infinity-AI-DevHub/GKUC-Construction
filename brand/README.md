# Brand assets

`gkuc-logo-master.png` is the original artwork as supplied: 6250 x 6250, transparent.
Keep it here as the master — it is not shipped with the app.

The assets the app actually serves are generated from it into
`frontend/public/brand/` and are copied into the build as-is:

| File | Used for |
| --- | --- |
| `gkuc-mark-64/128/256/512.png` | favicon, top bar, login, apple-touch-icon |
| `gkuc-logo-512/1024.png` | the complete logo, for light backgrounds and printed documents |

Only the **mark** appears on the app's dark surfaces. The full logo sets
"CONSTRUCTION (PVT) LTD." in black, which disappears against them.

Brand colours, sampled from the artwork:

- mark, deep navy `#0c0c30` → blue `#183c90`
- wordmark red `#cc2430`
- subtitle black `#000000`

To regenerate after the artwork changes, see `brand/generate.py`.
