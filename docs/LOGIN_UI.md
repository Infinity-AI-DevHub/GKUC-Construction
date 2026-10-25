# Login Screen

Updated 2026-10-26.

The signed-out screen uses the bundled `/construction-site.jpg` and existing GKUC brand assets. Styling is isolated in `frontend/src/login.css`, loaded after workspace styles. No remote image request is needed.

Includes responsive sign-in form, visible keyboard focus, password visibility toggle, busy state and announced error message. Existing authentication endpoint, token storage, redirect behaviour and development-only defaults remain unchanged. Production inputs remain empty by default.

Verification: frontend production build; browser checks at 320, 390, 600, 768, 900, 1100, 1440 and 1920 pixels for image loading, password toggle and horizontal overflow. No production deployment performed.
