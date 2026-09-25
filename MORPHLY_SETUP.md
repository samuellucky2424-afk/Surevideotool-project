# Morphly setup

The application loads the current hosted [Morphly browser SDK](https://morphly.fun/docs) directly from `https://morphly.fun/sdk/morphly.js`, including its relative dependency chunks. Choose **M2.1** or **M2.5** in the dashboard before starting. `/api/start-session` authenticates the Supabase bearer token, checks the app wallet, claims a database-backed start limit, and returns Morphly's complete session response plus the existing local session metadata. The permanent provider key never goes to the browser or desktop package.

## Models

| Dashboard model | Provider model | Behavior |
| --- | --- | --- |
| M2.1 (default) | `M 2.1` | Uses the existing garment prompt and reference image. Live updates send the prompt and image. |
| M2.5 | `M2.5` | Replaces the subject using the reference image and `subject_replacement` mode. No text prompts or audio transformation. Live updates send only the image and editing mode. |

The model selector is locked while starting, live, stopping, or awaiting stop confirmation. Stop first, select another model, then explicitly Start again. M2.5 is subject replacement, not a garment-only editing mode.

The session route accepts `M2.1`/`M 2.1`, `M2.5`/`M 2.5`, and the existing `morphly-realtime` and `lucy-2.5` aliases. Missing models default to `M 2.1`. M2.5 requests forward the SDK's `image_url` and `editing_type`; other models do not receive these fields. Invalid models, missing/invalid M2.5 images, and unsupported editing modes are rejected before claiming a start attempt or creating a session.

M2.5 uploads in this app are limited to **3 MB** so their base64 session requests fit under the [hosted function request limit](https://vercel.com/docs/functions/limitations#request-body-size). The local session route accepts up to 4.5 MB of JSON. This is an app transport limit, not the SDK's 10 MB image limit. Resize larger images before selecting them. M2.5 needs enough Morphly workspace credits for the requested maximum duration; actual usage is settled after the stream ends.

## Configure and run

1. Run [supabase/morphly-session-rate-limit.sql](supabase/morphly-session-rate-limit.sql) in the existing Supabase project's SQL editor. This adds a provider expiry column and an atomic per-user limit of one start attempt every 30 seconds. The API fails closed until this migration is applied.
2. Create a Morphly key with `realtime:create`. In Morphly's key settings, allow the exact origins used below. Use the dashboard's **Test Morphly connection** to validate the key without starting a paid stream.
3. Enter these variables directly in the backend environment (locally, `app/.env`; in production, the hosting environment settings):

   ```dotenv
   MORPHLY_API_KEY=<enter your key here, never in chat or source control>
   APP_ORIGIN=http://127.0.0.1:5173
   DESKTOP_APP_ORIGIN=http://127.0.0.1:47831
   ```

   Production `APP_ORIGIN` must be your exact HTTPS website origin, with no path or trailing slash. `DESKTOP_APP_ORIGIN` remains the fixed loopback origin. Both must be allowed on the Morphly key. Existing `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) remain required on the backend. Do not prefix server secrets with `VITE_`.
4. From the repository root, run `npm ci --prefix app`, then `npm run dev --prefix app`. Open **http://127.0.0.1:5173**; `localhost` is a different origin. For Electron development, use `npm run electron:dev --prefix app`.
5. For production, configure the environment and migration first, then redeploy the backend and frontend together. The root Vercel configuration builds into `app/dist`. For a different API domain, set public `VITE_API_URL=https://your-backend.example/api` before building. The default desktop backend remains `https://surevideotool-project.vercel.app/api`.
6. Build the frontend with `npm run build:app --prefix app`. Build a Windows installer with `npm run electron:build --prefix app` when the native camera build prerequisites are available. Publish a new desktop release through the existing release workflow after validation.

The packaged renderer is now served at `http://127.0.0.1:47831`, because `file://` has an opaque origin. Users will need to sign in again after upgrading. Keep port 47831 available. The installer no longer includes `.env`; public configuration is embedded by Vite at build time. Server secrets are only needed on the hosted backend.

### Vercel build directory

Vite always writes to this repository's `app/dist`, independent of the build working directory. Both supported Vercel roots have a checked-in configuration:

| Vercel Root Directory | Configuration | Output Directory relative to that root |
| --- | --- | --- |
| Repository root (blank) | `vercel.json` | `app/dist` |
| `app` | `app/vercel.json` | `dist` |

Use the configuration for your selected root. Both use `npm run build:app`. A successful Vite build followed by `No Output Directory named "dist" found` indicates the deployment is looking in the wrong directory; check Root Directory and remove stale Build Command/Output Directory overrides. When deploying from `app`, include source files outside the Root Directory so the existing `../shared` imports are available.

## Session behavior

- Each Start requests up to five minutes, capped further by the app wallet and Morphly's available balance. Camera changes and frozen streams stop the current session; the user explicitly starts the next one. No automatic paid replacement sessions are created.
- Model-appropriate reference-image updates use the existing session. The current SDK's `getState()` initializes connection state; startup does not redundantly reapply the initial transform. Webcam capture and virtual-camera forwarding remain in place. SDK statistics are optional; decoded video frames drive the freeze check as well.
- Stop closes local camera resources and awaits Morphly. An unconfirmed stop retains the same SDK object in memory and offers **Retry Stop**. Start stays disabled until confirmation. That object survives dashboard navigation, but not closing/reloading the entire application; Morphly's duration limit still applies.
- The app's existing wallet remains server-billed separately. Morphly workspace available, reserved, charged credits, and billable seconds are displayed separately using SDK events. Final provider settlement may remain pending after Stop.
- Errors from Morphly retain their upstream status and JSON. `REALTIME_SETUP_REQUIRED` needs Morphly support; repeated replacement starts will not fix it.

## Verification

Automated checks (no live provider calls):

```powershell
npm run build:app --prefix app
cd app
node --import tsx --test tests/morphly-session.test.ts
```

The tests cover both model contracts and legacy aliases, M2.5 image/editing-mode validation and forwarding, prompt-free M2.5 start/live controls, image-size limits, origin and login enforcement, impersonation denial, duration/rate/active-session limits, full credential-response forwarding, upstream failure rollback, both deployment route copies, and the desktop static server.

Manual checks after configuring the backend:

1. Sign in, validate the key in Morphly's dashboard, select M2.1, upload a garment image, and Start. Allow camera permission and stop after about 10 seconds for the first live test. Live streaming consumes Morphly credits.
2. Confirm transformed video in the preview and in the Surevideotool camera selected by Zoom/OBS. Change the garment reference and verify the output updates. After Stop confirms, select M2.5, upload a replacement subject image up to 3 MB, and repeat a short test. Confirm live image replacement works without text-prompt errors and the model selector stays locked until Stop confirms.
3. Stop; confirm the camera closes and Start becomes available after stop confirmation. Inspect the distinct app wallet and Morphly usage values.
4. During a separate short test, disconnect the network before Stop. Confirm **Retry Stop** appears and Start remains disabled. Restore the network and retry the same stop. Confirm settlement can remain pending.
5. Deny camera permission, use an expired login, test an unapproved origin, and test insufficient app/provider credits. Each should show an actionable error without opening a usable stream.
6. Navigate away while connecting and while live; verify media cleanup. Switch cameras and confirm an explicit new Start is required.

No live key validation, paid stream, production deployment, database migration, or installer release was performed as part of the local implementation.
