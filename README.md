# weegloo-service-user

**Add OAuth sign-in to a static site or SPA that has no backend.** Google, GitHub, Facebook, GitLab, LINE, Kakao, or Naver — two `<script>` tags, no server, no client secret in your code.

Browser SDK for **Weegloo ServiceLogin**, the per-Space member sign-in of [Weegloo](https://weegloo.com). Vanilla JavaScript, zero runtime dependencies. Ships UMD, ESM, and minified builds.

- Drives the full OAuth 2.0 flow: redirect → callback → token exchange → refresh → logout.
- Stores tokens in `sessionStorage` (or `localStorage`, or a custom adapter).
- Auto-refreshes the `accessToken` before it expires.
- Removes `exchangeToken` from the address bar **before** the network call (success, failure, or reload — never leaks).
- Auto-injects `Authorization: Bearer …` for ACMA / ACDA calls.

**If you know Firebase Auth:** this is the equivalent piece. Weegloo's `ServiceLogin` ≈ Firebase Auth, and the signed-in user then reads and writes their own rows through Weegloo's ACMA / ACDA APIs ≈ Firestore. The difference worth knowing up front: access control is a role with filters (`createdBy: ":self"` means "only rows this user created") rather than a rules language.

> The Bearer Token issued by ServiceLogin is valid **only** against `acma.weegloo.com` / `acda.weegloo.com`. It is **not** valid against `cma.weegloo.com` / `cda.weegloo.com`.

---

## Install

### Option A. `<script>` tag (static sites, Weegloo WebHosting)

Served from Weegloo's CDN at `https://weegloo-media.com/static/libs/service-login/`:

```html
<!-- Development / prototyping: always the newest build -->
<script src="https://weegloo-media.com/static/libs/service-login/service-login.min.js"></script>
```

The library exposes a global `WeeglooServiceLogin`.

**For production, pin a hashed build** so a CDN refresh cannot ship a new SDK into a deployed product without your release:

```html
<script src="https://weegloo-media.com/static/libs/service-login/service-login.<hash>.min.js"></script>
```

Look up the hash for your version in the CDN manifest at
`https://weegloo-media.com/static/libs/service-login/manifest.json`. For v1.3.0:

| Build | Pinned filename |
|---|---|
| UMD | `service-login.4d602c59.js` |
| ESM | `service-login.e57a867f.esm.js` |
| UMD, minified | `service-login.52caeb73.min.js` |

Available filenames — `service-login.js` (UMD), `service-login.esm.js` (ESM), `service-login.min.js` (UMD minified), each with a `.<hash>` variant.

### Option B. npm + bundler (Vite, Webpack, Next.js, …)

```bash
npm install weegloo-service-user
```

```js
import WeeglooServiceLogin from 'weegloo-service-user';

const auth = WeeglooServiceLogin.init({
  spaceId:  'YOUR_SPACE_ID',
  provider: 'google', // set this explicitly — see Providers below
});
```

The package also ships `dist/manifest.json`, which records each build's `<hash>` (sha256, first 8 hex chars), byte size, and an `sha384` SRI integrity string — read it with `require('weegloo-service-user/manifest')`.

---

## Providers

Pass the one your product uses. There is no sensible default — `'google'` is the SDK's fallback, not a recommendation.

| `provider` | Service |
|---|---|
| `'google'` | Google |
| `'github'` | GitHub |
| `'facebook'` | Facebook |
| `'gitlab'` | GitLab |
| `'line'` | LINE Login |
| `'kakao'` | Kakao Login |
| `'naver'` | Naver Login |

Each provider needs its own OAuth client registered in that provider's console, and its own redirect URI (see *Setup*). One provider's console steps do **not** transfer to another.

---

## Complete example

Copy this into an `index.html`, fill in two values, and serve it over `http://` (OAuth callbacks don't work from `file://`).

```html
<button id="login">Sign in</button>
<button id="logout">Sign out</button>
<button id="load">Load my data</button>
<pre id="out"></pre>

<script src="https://weegloo-media.com/static/libs/service-login/service-login.min.js"></script>
<script>
  const SPACE_ID = 'YOUR_SPACE_ID';

  const auth = WeeglooServiceLogin.init({
    spaceId:  SPACE_ID,
    provider: 'google',
  });

  document.querySelector('#login').onclick  = () => auth.login();
  document.querySelector('#logout').onclick = () => auth.logout();

  document.querySelector('#load').onclick = async () => {
    // auth.fetch() adds Authorization: Bearer <accessToken> for you.
    const res = await auth.fetch(
      `https://acda.weegloo.com/v1/spaces/${SPACE_ID}/contents?limit=20`
    );
    document.querySelector('#out').textContent =
      JSON.stringify(await res.json(), null, 2);
  };

  (async () => {
    // The OAuth flow returns to this page with ?exchangeToken=... — trade it first.
    if (location.search.includes('exchangeToken=')) {
      try { await auth.handleCallback(); } catch (e) { console.error(e); }
    }

    if (auth.isLoggedIn()) {
      // Current member: /v1/me on ACMA — NOT /v1/spaces/{spaceId}/me.
      const me = await auth.fetch('https://acma.weegloo.com/v1/me').then(r => r.json());
      document.querySelector('#out').textContent = `Signed in as ${me.email}`;
    }
  })();
</script>
```

### Writing data as the signed-in member

```js
// ACMA addresses Content UNDER its ContentType — there is no flat /contents on ACMA.
await auth.fetch(
  `https://acma.weegloo.com/v1/spaces/${SPACE_ID}/content-types/${CONTENT_TYPE_ID}/contents`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        title: { 'en-US': 'Hello' },   // per-locale buckets on the write side
      },
    }),
  }
);
// ACMA create auto-publishes. There is no separate publish call.
```

Two shapes that catch everyone once:

- **Reads are flattened, writes are bucketed.** On ACDA/CDA, `item.fields.title` *is* the string. On ACMA/CMA it's `item.fields.title['en-US']`.
- **`/v1/me` is not under `/spaces/{spaceId}`.** `auth.weegloo.com` uses `/v1/spaces/{spaceId}/…` for OAuth; ACMA's current-member endpoint is `https://acma.weegloo.com/v1/me`.

---

## API

### `WeeglooServiceLogin.init(options) → instance`

| Option | Type | Default | Description |
|---|---|---|---|
| `spaceId` | `string` | — (**required**) | Your Weegloo Space ID. |
| `provider` | `string` | `'google'` | OAuth provider path segment. Set it explicitly — see *Providers*. |
| `authBaseUrl` | `string` | `'https://auth.weegloo.com'` | Base URL of the auth server. |
| `storage` | `'session' \| 'local' \| object` | `'session'` | Token storage. The `'session'` default uses `sessionStorage` and is the recommended security posture. A custom adapter `{ getItem, setItem, removeItem }` is also accepted. |
| `storageKey` | `string` | `weegloo:serviceLogin:<spaceId>` | Key used in storage. |
| `autoRefresh` | `boolean` | `true` | If `true`, `getAccessToken()` refreshes automatically when the access token is near expiry. |
| `refreshLeewaySeconds` | `number` | `60` | Refresh fires `N` seconds before `expiresAt`. |

Calling `init()` multiple times with the same `spaceId | authBaseUrl` pair returns the same cached instance.

### Instance methods

| Method | Returns | Description |
|---|---|---|
| `login(opts?)` | `Promise<void>` | Redirects the browser to the OAuth login page. Options: `provider`, `returnTo`, and `redirectUri` (see *Returning to more than one URL*). |
| `handleCallback(opts?)` | `Promise<tokens>` | Call on the callback page. **First** strips `exchangeToken` from the address bar, **then** exchanges it for tokens and stores them. After a `redirectUri` login it also checks `state` and sends the PKCE `codeVerifier`. |
| `isLoggedIn()` | `boolean` | `true` if `accessToken` is unexpired *or* a valid `refreshToken` exists. |
| `getAccessToken()` | `Promise<string \| null>` | Returns the access token, auto-refreshing if necessary. `null` if not logged in or refresh failed. |
| `getTokens()` | `tokens \| null` | Returns the stored token bundle. |
| `refresh()` | `Promise<tokens>` | Forces a refresh (`POST /oauth/refresh`). |
| `logout()` | `Promise<true>` | Calls `DELETE /oauth/token` with the stored `refreshToken` and clears local storage. |
| `fetch(input, init?)` | `Promise<Response>` | A `fetch` wrapper that injects `Authorization: Bearer <accessToken>` and avoids forcing `Accept: application/json` (Weegloo serves a vendor media type). Throws when there is no session — guard with `isLoggedIn()`. |
| `onChange(cb)` | `() => void` | Subscribe to lifecycle events: `'login' \| 'refresh' \| 'logout' \| 'set' \| 'clear' \| 'refresh-failed'`. Returns an unsubscribe function. |

---

## Security notes

- **`exchangeToken` is removed from the URL before any network request.** Even if the token-exchange call fails, hangs, or the user reloads mid-flight, the token never lingers in `window.location`, the session-history stack, or outgoing `Referer` headers.
- The default `sessionStorage` discards tokens when the tab closes. Use `storage: 'local'` only when persistent sign-in is a deliberate UX choice.
- The Bearer Token authorizes **ACMA** and **ACDA** only. Do not send it to CMA, CDA, or Upload — the server will reject it.
- The library never sets `Accept: application/json` on outgoing requests, because Weegloo APIs negotiate the vendor media type `application/vnd.com.weegloo.v1+json`.
- **No client secret ever reaches the browser.** The OAuth client secret lives on the `ServiceLogin` record server-side; the browser only ever handles a one-time `exchangeToken` and the resulting Bearer Token.

---

## What is ServiceLogin?

ServiceLogin is the **per-Space, app-managed member directory** of a Weegloo Space. It is *separate* from Weegloo Console accounts (which manage the Space itself). Use it to add member sign-up / sign-in to a product you ship on top of a Weegloo Space — a members-only board, a paid-content portal, or any community where readers must sign in.

### Resource model

- **`ServiceLogin`** — the Space's per-product login configuration (enabled OAuth providers, callback URL, default role).
- **`ServiceUserRole`** — the permission rule set assigned to app-managed members. Defines what they may read or write through ACMA / ACDA. `createdBy: ":self"` scopes a rule to the calling member's own resources.
- **`ServiceUser`** — one record per app-managed member. May carry an optional `roleOverride` (a different `ServiceUserRole` for that member) and an optional `isAdmin: true` (adds *delete* of other members' resources, scoped to the role's permissions — delete only, not cross-member read or update).

A successful sign-in returns a Bearer Token tied to the corresponding `ServiceUser`. That token authorizes **ACMA** and **ACDA** only.

---

## Setup (one-time)

### 1. Register an OAuth client with your provider

In your chosen provider's developer console, create an OAuth client and register Weegloo's redirect URI — substituting your real Space ID and provider:

```
https://auth.weegloo.com/v1/spaces/{spaceId}/login/oauth2/code/{provider}
```

> **This is not the URL the SDK navigates to.** The redirect URI above (with `/code/`) is where the *provider* calls Weegloo back. The SDK sends the browser to `/login/oauth2/{provider}` — no `code` segment. Registering the wrong one is the most common setup failure.

Worked example, Google:

1. Google Cloud Console → "Google Auth Platform" → **create an OAuth Client**.
2. **Authorized JavaScript origins:** add `https://auth.weegloo.com`.
3. **Authorized redirect URIs:** add `https://auth.weegloo.com/v1/spaces/{spaceId}/login/oauth2/code/google`.
4. While the consent screen is in testing, add your testers under **Test users** or sign-in will fail.

Other providers follow the same shape with their own console and their own quirks — GitHub allows only one callback URL per OAuth App; Kakao's REST API key is the `clientId` and the client secret must be generated *and* enabled; LINE and Kakao require a separate application step before they release the user's email. Weegloo's docs carry per-provider walkthroughs.

### 2. Configure `ServiceLogin` in the Weegloo Console

1. In the target Space, **create a `ServiceLogin`** record.
2. Set `clientId` / `clientSecret` to the values issued by your provider.
3. Set `defaultRole` to a `Refer` of a `ServiceUserRole` you created in advance with the appropriate permissions. Per-member overrides are possible later via `ServiceUser.roleOverride`.
4. Set `callbackUrl` to a URL on **your own product** that the SDK can intercept — Weegloo redirects the browser there with `?exchangeToken=…` after a successful sign-in, and `handleCallback()` consumes it.

`callbackUrl` must be `http` or `https`. It is the one URL used when `login()` is called without `redirectUri`. Any other URL you want to return to — `http://localhost:…` while developing, a staging host — goes in `allowedCallbackUrls`; see the next section.

---

## Returning to more than one URL (local development, staging)

`callbackUrl` is a single URL. To sign in from `http://localhost:8080` while the product is deployed elsewhere — without editing `callbackUrl` back and forth — register every return URL in the ServiceLogin's `allowedCallbackUrls` (up to 10) and pass the one you are on as `redirectUri`:

```json
{
  "callbackUrl": "https://your-product.example.com/callback",
  "allowedCallbackUrls": [
    { "url": "https://your-product.example.com/callback" },
    { "url": "http://localhost:8080/callback" }
  ]
}
```

```js
// Same code on every environment — each one returns to itself.
document.querySelector('#login').onclick = () =>
  auth.login({ redirectUri: location.origin + '/callback' });

(async () => {
  // A redirectUri login can also come back with ?error=… instead of ?exchangeToken=…
  const q = new URLSearchParams(location.search);
  if (q.has('exchangeToken') || q.has('error')) {
    try {
      await auth.handleCallback();
    } catch (e) {
      // e.g. "Your account is waiting for approval — contact admin@example.com"
      if (e.code === 'LOGIN_FAILED') console.warn(e.error, e.contact);
      else console.error(e);
    }
  }
})();
```

With `redirectUri` the SDK runs PKCE (S256) and `state` for you: `login()` stores a one-time verifier under `<storageKey>:pkce`, and `handleCallback()` checks the returned `state` and sends the verifier with the exchange. Without `redirectUri`, nothing changes — Weegloo returns to `callbackUrl` exactly as before.

- **Only registered URLs — `callbackUrl` does not count.** When `redirectUri` is given, Weegloo checks it against `allowedCallbackUrls` **alone**. A `redirectUri` equal to `callbackUrl` is still refused unless that URL is also in `allowedCallbackUrls`, and with an **empty** `allowedCallbackUrls` every `redirectUri` is refused. Pass `redirectUri` only for a URL you have registered; to return to `callbackUrl`, call `login()` without it.
- **Match exactly.** `redirectUri` must equal a registered `url` character for character — `http://localhost:8080/callback/` (trailing slash), `http://127.0.0.1:8080/callback`, or another port are all different URLs. An unregistered value fails at the login entry with `WGL400075` (some deployments answer an unregistered value with a bare HTTP `500` instead).
- **An unregistered `redirectUri` cannot be caught in code.** `login()` resolves as soon as it has issued the navigation, so the refusal happens on the Weegloo login-entry page, after the browser has left your app — no `.catch()` or `handleCallback()` sees it, and Weegloo cannot send the browser back to a URL it has not registered. The browser simply stops on an error page. The browser also cannot read `allowedCallbackUrls`, so decide in your own config which environments pass `redirectUri`, and keep that list in step with the ServiceLogin.
- **Secure context only.** PKCE needs `crypto.subtle`, which browsers expose on `https` and on `http://localhost` / `http://127.0.0.1` — not on other plain-`http` hosts such as a LAN IP. There, `login()` rejects with `code: 'PKCE_UNSUPPORTED'`.
- **Same tab.** With the default `sessionStorage`, the callback must land in the tab that called `login()` (the normal redirect flow does).

On failure Weegloo returns to the `redirectUri` instead of its own notice page, and `handleCallback()` rejects:

| `e.code` | When | Extra fields |
|---|---|---|
| `LOGIN_FAILED` | Weegloo refused the sign-in | `e.error`: `signup_limit_exceeded` · `approval_required` · `email_conflict` · `email_required` · `server_error`; `e.contact`: the ServiceLogin's contact email |
| `STATE_MISMATCH` | The callback does not belong to the login this browser started | — |

---

## OAuth flow (for reference)

The SDK encapsulates all of this; read it only if you are debugging or porting the flow elsewhere. `{provider}` is one of the seven listed above.

1. Navigate the browser to:
   `GET https://auth.weegloo.com/v1/spaces/{spaceId}/login/oauth2/{provider}`
   The user signs in through the provider.
   To return somewhere other than `callbackUrl`, append `redirect_uri` (one of `allowedCallbackUrls`), `code_challenge` (BASE64URL, no padding, of SHA-256 over the `code_verifier`), `code_challenge_method=S256`, and an optional `state`.
2. Weegloo redirects the browser to the configured `callbackUrl` with `?exchangeToken=…` appended — or, when `redirect_uri` was sent, to that URL with `?exchangeToken=…&state=…` (on failure `?error=…&contact=…&state=…`).
3. Exchange the `exchangeToken` for tokens:
   `POST https://auth.weegloo.com/v1/spaces/{spaceId}/oauth/token`
   `Content-Type: application/json`
   ```json
   { "exchangeToken": "abc" }
   ```
   When the login sent a `code_challenge`, add `"codeVerifier": "<the code_verifier>"`.
   Response:
   ```json
   {
     "accessToken": "XXXXXX",
     "tokenType": "Bearer",
     "scope": ["SERVICE_OAUTH_ACCESS_TOKEN"],
     "createdAt":  "2026-04-16T12:12:21.602Z",
     "expiresAt":  "2026-06-16T12:12:21.602Z",
     "refreshToken": "YYYYYYYY",
     "refreshExpiresAt": "2026-04-23T12:12:21.602Z"
   }
   ```
4. Send `Authorization: Bearer <accessToken>` to ACMA / ACDA.
5. Before `expiresAt`, refresh:
   `POST https://auth.weegloo.com/v1/spaces/{spaceId}/oauth/refresh`
   ```json
   { "refreshToken": "YYYYYYYY" }
   ```
   Some refresh responses omit `refreshToken` — keep the previously stored one in that case.
6. To sign out:
   `DELETE https://auth.weegloo.com/v1/spaces/{spaceId}/oauth/token`
   ```json
   { "refreshToken": "YYYYYYYY" }
   ```
   Sending the `refreshToken` is strongly recommended so the server can invalidate it — calling without a body is permitted but leaves the refresh token usable until natural expiry.

---

## Builds

Each build ships as a **mutable "latest" alias** that auto-updates with patch releases, and a **content-addressed immutable revision** safe for pinning.

| Format | Latest alias | Immutable revision | Use case |
|---|---|---|---|
| UMD | `service-login.js` | `service-login.<hash>.js` | `<script>` tag, CommonJS `require`, AMD |
| ES Module | `service-login.esm.js` | `service-login.<hash>.esm.js` | Modern bundlers, `import` |
| UMD (minified) | `service-login.min.js` | `service-login.<hash>.min.js` | Production `<script>` / CDN |

`manifest.json` records each build's `<hash>` (sha256, first 8 hex chars), byte size, and an `sha384` SRI integrity string. It is available both in the npm package at `dist/manifest.json` and on the CDN at
`https://weegloo-media.com/static/libs/service-login/manifest.json`.

The single source of truth is `src/service-login.js`. Run `npm run build` to regenerate `dist/`.

## Related

- **Weegloo docs** — <https://docs.weegloo.com>
- **Firebase / Supabase → Weegloo capability mapping** — *[link to the published comparison page]*
- **Single-file starter** — a static `index.html` with public reads, sign-in, and per-member writes: *[link to the starter repo]*

## License

[MIT](./LICENSE)
