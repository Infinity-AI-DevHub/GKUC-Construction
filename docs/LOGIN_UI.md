# Login Screen

Updated 2026-10-26.

The signed-out screen uses a procedural Three.js architectural construction scene and existing GKUC brand assets, without a background photograph. The unframed scene includes buildings, a moving crane and truck, and subtle pointer response. Three.js is loaded lazily when this screen mounts. Styling is isolated in `frontend/src/login.css`, loaded after workspace styles.

Rendering is capped at 30 frames per second and a 1.75 pixel ratio. Hidden tabs skip rendering. Reduced-motion preferences produce a static scene; unavailable WebGL shows a CSS architectural fallback. Rendering resources and listeners are disposed on unmount.

Includes responsive sign-in form, visible keyboard focus, password visibility toggle, busy state and announced error message. Existing authentication endpoint, token storage, redirect behaviour and development-only defaults remain unchanged. Production inputs remain empty by default.

Verification: frontend production build and 33 passing unit tests; browser checks at 320, 390, 600, 768, 900, 1100, 1440 and 2560 pixels for nonblank canvas pixels, password toggle, footer clearance and horizontal overflow. Additional checks cover animation, pointer interaction, announced authentication errors, reduced motion and unavailable WebGL. Browser harness: `frontend/browser-tests/login-architecture.mjs`. No production deployment performed.
