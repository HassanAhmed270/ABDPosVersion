## Stage 16 — Backend cross-origin support

**Goal:** prepare the existing backend so the Electron desktop application and future hosted clients can communicate with the API from a different origin.

**Implementation tasks:**

- Add CORS handling to the Express backend. The current same-origin web setup does not require it, but Electron's renderer and future separately hosted clients will.
- Make allowed client origins environment-driven rather than enabling unrestricted CORS.
- Ensure the configuration supports:
  - Electron development/build usage.
  - Local development where appropriate.
  - A future hosted frontend or deployment URL without requiring API code changes.
- Keep the existing API authentication, authorization, and route behavior unchanged.

**Affected areas:** Express application setup, environment/configuration files, dependency configuration if required.

**Testing/validation:** run the backend locally and confirm a client from an allowed cross-origin source can call the API; confirm disallowed origins are not unintentionally opened; `npm test`.

**Completion criteria:** the API can securely serve the Electron client and can later be configured for a hosted client through environment settings.

---

## Stage 17 — Electron desktop application wrapper

**Goal:** package the existing React/Vite billing application as a Windows desktop application without rewriting the existing frontend.

**Implementation tasks:**

- Add Electron to the project as a desktop wrapper around the existing built frontend.
- Load the frontend through the existing `VITE_API_BASE` configuration.
- Default the Electron build's API target to `http://localhost:3000` for the local setup.
- Ensure the API base can later be changed to a real hosted URL through build/environment configuration without changing application code.
- Configure the Electron window for the full desktop interface.
- Set a minimum window size comfortably above Tailwind's `md` breakpoint (`768px`) so the mobile/tablet layout is not triggered during normal desktop use.
- Preserve the existing React application and functionality rather than creating a separate Electron-specific UI.

**Affected areas:** Electron main/preload files, `package.json` scripts/dependencies, build configuration, environment configuration.

**Testing/validation:** run the application through Electron; confirm login, orders, billing, refunds, exchanges, printing, and API requests work through the desktop wrapper; verify the desktop layout remains active at the minimum supported window size; `npm run build`.

**Completion criteria:** the complete billing/POS system runs as a Windows desktop application using the existing frontend and backend.

---

## Stage 18 — Shareable Windows installer and upgrade flow

**Goal:** produce a simple Windows installer that can be easily shared with clients over the internet and can replace an existing installation when a newer version is provided.

**Implementation tasks:**

- Configure `electron-builder` with the Windows NSIS target.
- Produce a single `.exe` installer suitable for sharing through services such as cloud storage, file-sharing links, or other internet delivery methods.
- Configure a stable application identity so future versions are recognized as updates to the same application.
- Use version numbers for each release.
- Ensure running a newer installer replaces/upgrades the existing installation rather than creating a separate application.
- Do **not** implement automatic online updates or an updater server. Updates will be manually built and handed/shared with the client.
- Do **not** add paid code signing.

**Known behavior:** because the application is not code-signed, Windows may display an **Unknown Publisher/SmartScreen warning** on installation. This is accepted for this project to avoid code-signing costs.

**Affected areas:** `electron-builder` configuration, `package.json`, application metadata/versioning, release build scripts.

**Testing/validation:** create the Windows installer; install it on a clean Windows environment; build a newer version with an increased version number; run the new installer and confirm it replaces/upgrades the previous installation while preserving the intended application identity.

**Completion criteria:** one shareable Windows `.exe` installer can be generated and distributed over the internet, and newer manually distributed installers upgrade the existing application.

---

## Stage 19 — Deployment-ready backend and production configuration

**Goal:** make the application easy to move from the current local backend to a real internet-accessible deployment when required.

**Implementation tasks:**

- Finalize environment-based production configuration for the backend.
- Ensure the frontend/Electron build can point to a hosted API using `VITE_API_BASE`.
- Document the required production environment variables without hardcoding URLs or secrets.
- Verify CORS configuration works with the final deployed client origin.
- Ensure MongoDB/database connection configuration is environment-driven.
- Ensure production error handling does not expose unnecessary internal information.
- Define the production startup/build commands required for deployment.
- Keep the desktop application's API URL configurable so a new production build can target the hosted backend without changing the frontend source code.

**Affected areas:** environment configuration, backend startup/configuration, frontend build configuration, deployment documentation/scripts.

**Testing/validation:** configure a non-local API URL and build/run the application against it; verify authentication and core API operations work; verify local and production configurations remain separate; `npm test`; production frontend build.

**Completion criteria:** the backend and desktop application are ready to be deployed and used over the internet by configuring environment values rather than rewriting application logic.