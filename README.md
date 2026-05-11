# weegloo-service-user

Vanilla-JavaScript browser SDK for **Weegloo ServiceLogin** — the per-Space, app-managed member sign-in feature of [Weegloo](https://weegloo.com). Zero runtime dependencies. Ships UMD, ESM, and minified builds.

- Drives the full Google OAuth 2.0 flow: redirect → callback → token exchange → refresh → logout.
- Stores tokens in `sessionStorage` (or `localStorage`, or a custom adapter).
- Auto-refreshes the `accessToken` before it expires.
- Removes `exchangeToken` from the address bar **before** the network call (success, failure, or reload — never leaks).
- Auto-injects `Authorization: Bearer …` for ACMA / ACDA calls.

> The Bearer Token issued by ServiceLogin is valid **only** against `acma.weegloo.com` / `acda.weegloo.com`. It is **not** valid against `cma.weegloo.com` / `cda.weegloo.com`.

---

## Install

### Option A. npm + bundler (Vite, Webpack, Next.js, …)

```bash
npm install weegloo-service-user
```
```js
import WeeglooServiceLogin from 'weegloo-service-user';

const auth = WeeglooServiceLogin.init({ spaceId: 'YOUR_SPACE_ID' });
```

### Option B. `<script>` tag (static sites, Weegloo WebHosting)

After publishing, jsDelivr and unpkg serve the same file automatically:

```html
<script src="https://cdn.jsdelivr.net/npm/weegloo-service-user@1/dist/weegloo-service-login.min.js"></script>
<!-- or -->
<script src="https://unpkg.com/weegloo-service-user@1/dist/weegloo-service-login.min.js"></script>
<script>
  const auth = WeeglooServiceLogin.init({ spaceId: 'YOUR_SPACE_ID' });
</script>
```

The library exposes a global `WeeglooServiceLogin` when loaded via `<script>`.

---

## Minimal example

```html
<button id="login">Login</button>
<button id="logout">Logout</button>
<button id="load">Load via ACDA</button>

<script src="https://cdn.jsdelivr.net/npm/weegloo-service-user@1/dist/weegloo-service-login.min.js"></script>
<script>
  const SPACE_ID = 'YOUR_SPACE_ID';
  const auth = WeeglooServiceLogin.init({ spaceId: SPACE_ID });

  // On the callback page, complete the OAuth handshake.
  if (location.search.includes('exchangeToken=')) {
    auth.handleCallback().catch(console.error);
  }

  document.querySelector('#login').onclick  = () => auth.login();
  document.querySelector('#logout').onclick = () => auth.logout();
  document.querySelector('#load').onclick   = async () => {
    const res  = await auth.fetch(`https://acda.weegloo.com/v1/spaces/${SPACE_ID}/contents`);
    console.log(await res.json());
  };
</script>
```

---

## API

### `WeeglooServiceLogin.init(options) → instance`

| Option | Type | Default | Description |
|---|---|---|---|
| `spaceId` | `string` | — (**required**) | Your Weegloo Space ID. |
| `provider` | `string` | `'google'` | OAuth provider path segment. |
| `authBaseUrl` | `string` | `'https://auth.weegloo.com'` | Base URL of the auth server. |
| `storage` | `'session' \| 'local' \| object` | `'session'` | Token storage. The `'session'` default uses `sessionStorage` and is the recommended security posture. A custom adapter `{ getItem, setItem, removeItem }` is also accepted. |
| `storageKey` | `string` | `weegloo:serviceLogin:<spaceId>` | Key used in storage. |
| `autoRefresh` | `boolean` | `true` | If `true`, `getAccessToken()` will refresh automatically when the access token is near expiry. |
| `refreshLeewaySeconds` | `number` | `60` | Refresh fires `N` seconds before `expiresAt`. |

Calling `init()` multiple times with the same `spaceId | authBaseUrl` pair returns the same cached instance.

### Instance methods

| Method | Returns | Description |
|---|---|---|
| `login(opts?)` | `void` | Redirects the browser to the OAuth login page. |
| `handleCallback(opts?)` | `Promise<tokens>` | Call on the callback page. **First** strips `exchangeToken` from the address bar, **then** exchanges it for tokens and stores them. |
| `isLoggedIn()` | `boolean` | `true` if `accessToken` is unexpired *or* a valid `refreshToken` exists. |
| `getAccessToken()` | `Promise<string \| null>` | Returns the access token, auto-refreshing if necessary. Returns `null` if the user is not logged in or refresh failed. |
| `getTokens()` | `tokens \| null` | Returns the stored token bundle. |
| `refresh()` | `Promise<tokens>` | Forces a refresh (`POST /oauth/refresh`). |
| `logout()` | `Promise<true>` | Calls `DELETE /oauth/token` with the stored `refreshToken` and clears local storage. |
| `fetch(input, init?)` | `Promise<Response>` | A `fetch` wrapper that injects `Authorization: Bearer <accessToken>` and avoids forcing `Accept: application/json` (Weegloo serves a vendor media type). |
| `onChange(cb)` | `() => void` | Subscribe to lifecycle events: `'login' \| 'refresh' \| 'logout' \| 'set' \| 'clear' \| 'refresh-failed'`. Returns an unsubscribe function. |

---

## Security notes

- **`exchangeToken` is removed from the URL before any network request.** Even if the token-exchange call fails, hangs, or the user reloads mid-flight, the token never lingers in `window.location`, the session-history stack, or outgoing `Referer` headers.
- The default `sessionStorage` discards tokens when the tab closes. Use `storage: 'local'` only when persistent sign-in is a deliberate UX choice.
- The Bearer Token authorizes **ACMA** and **ACDA** only. Do not send it to CMA, CDA, or Upload — the server will reject it.
- The library never sets `Accept: application/json` on its outgoing requests because Weegloo APIs negotiate the vendor media type `application/vnd.com.weegloo.v1+json`.

---

## What is ServiceLogin?

ServiceLogin is the **per-Space, app-managed member directory** of a Weegloo Space. It is *separate* from Weegloo Console accounts (which manage the Space itself). Use it to add member sign-up / sign-in to a product you ship on top of a Weegloo Space — for example, a members-only board, a paid-content portal, or any community where readers must sign in.

### Resource model

- **`ServiceLogin`** — the Space's per-product login configuration (enabled OAuth providers, callback URL, default role).
- **`ServiceUserRole`** — the permission rule set assigned to app-managed members. Defines what they may read or write through ACMA / ACDA.
- **`ServiceUser`** — one record per app-managed member. May carry an optional `roleOverride` (a different `ServiceUserRole` for that specific member) and an optional `isAdmin: true` (adds *delete* of other members' resources, scoped to the role's permissions).

A successful sign-in returns a Bearer Token tied to the corresponding `ServiceUser`. That token authorizes **ACMA** and **ACDA** only.

---

## Setup checklist (one-time)

### 1. Configure the OAuth client in Google Cloud

1. In Google Cloud Console → "Google Auth Platform" → **create an OAuth Client**.
2. Add `https://auth.weegloo.com` to **Authorized JavaScript origins**.
3. Add `https://auth.weegloo.com/v1/spaces/{spaceId}/login/oauth2/code/google` to **Authorized redirect URIs**, where `{spaceId}` is the Weegloo Space ID hosting the ServiceLogin.

> Note: the `/login/oauth2/code/{provider}` path is the **redirect URI** that Google calls Weegloo at — it is *different* from the URL the SDK navigates the browser to (`/login/oauth2/{provider}`, no `code` segment).

### 2. Configure ServiceLogin in the Weegloo Console

1. In the target Space, **create a `ServiceLogin`** record.
2. Set `clientId` / `clientSecret` to the values issued by Google Cloud above.
3. Set `defaultRole` to a `Refer` of a `ServiceUserRole` you have created in advance with the appropriate permissions. Per-member overrides are possible later via `ServiceUser.roleOverride`.
4. Set `callbackUrl` to a URL on **your own product** that the SDK can intercept — Weegloo will redirect the browser there with `?exchangeToken=...` after a successful Google sign-in. The SDK's `handleCallback()` consumes this parameter to obtain a Bearer Token usable against ACMA / ACDA.

---

## OAuth flow (for reference)

The SDK encapsulates all of this; you only need to read it if you are debugging or porting the flow elsewhere.

1. Navigate the browser to:  
   `GET https://auth.weegloo.com/v1/spaces/{spaceId}/login/oauth2/google`  
   The user signs in through Google.
2. Weegloo redirects the browser to the configured `callbackUrl` with `?exchangeToken=…` appended.
3. Exchange the `exchangeToken` for tokens:  
   `POST https://auth.weegloo.com/v1/spaces/{spaceId}/oauth/token`  
   `Content-Type: application/json`  
   ```json
   { "exchangeToken": "abc" }
   ```
   Response:
   ```json
   {
     "accessToken": "XXXXXX",
     "tokenType": "Bearer",
     "scope": ["App"],
     "createdAt":  "2026-04-16T12:12:21.602Z",
     "expiresAt":  "2026-06-16T12:12:21.602Z",
     "refreshToken": "YYYYYYYY",
     "refreshExpiresAt": "2026-04-23T12:12:21.602Z"
   }
   ```
4. Send `Authorization: Bearer <accessToken>` to ACMA / ACDA.
5. Before `expiresAt`, refresh the access token:  
   `POST https://auth.weegloo.com/v1/spaces/{spaceId}/oauth/refresh`  
   ```json
   { "refreshToken": "YYYYYYYY" }
   ```
6. To sign out:  
   `DELETE https://auth.weegloo.com/v1/spaces/{spaceId}/oauth/token`  
   ```json
   { "refreshToken": "YYYYYYYY" }
   ```
   Sending the `refreshToken` is strongly recommended so the server can invalidate it — calling without a body is permitted but leaves the refresh token usable until natural expiry.

---

## Builds

| File | Format | Use case |
|---|---|---|
| `dist/weegloo-service-login.js` | UMD | `<script>` tag, CommonJS `require`, AMD |
| `dist/weegloo-service-login.esm.js` | ES Module | Modern bundlers, `import` |
| `dist/weegloo-service-login.min.js` | UMD (minified) | Production `<script>` / CDN |

The same source under `src/weegloo-service-login.js` is the canonical implementation; the `dist/` files are built from it.

## License

[MIT](./LICENSE)
