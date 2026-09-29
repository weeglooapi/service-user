// Type definitions for weegloo-service-user 1.3.0
// Weegloo ServiceLogin SDK — browser OAuth 2.0 sign-in for app-managed members
// of a Weegloo Space. Issued Bearer Tokens are valid ONLY against ACMA / ACDA
// (and Upload) — never CMA / CDA.
//
// Loaded as a UMD global (`window.WeeglooServiceLogin`), CommonJS, or ESM.

export as namespace WeeglooServiceLogin;

/** OAuth providers Weegloo ServiceLogin supports. */
export type OAuthProvider =
  | 'google'
  | 'github'
  | 'facebook'
  | 'gitlab'
  | 'line'
  | 'kakao'
  | 'naver';

/** Token bundle returned by the exchange/refresh endpoints and persisted in storage. */
export interface ServiceLoginTokens {
  accessToken: string;
  tokenType?: string;
  scope?: string[];
  createdAt?: string;
  /** ISO-8601 expiry of `accessToken`. */
  expiresAt?: string;
  refreshToken?: string;
  /** ISO-8601 expiry of `refreshToken`. */
  refreshExpiresAt?: string;
}

/** Minimal Web Storage shape (localStorage / sessionStorage / custom). */
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface InitOptions {
  /** Required. The target Weegloo Space id. */
  spaceId: string;
  /** OAuth provider to use. Default: `'google'`. Set explicitly per product. */
  provider?: OAuthProvider;
  /** Override the auth host. Default: `https://auth.weegloo.com`. */
  authBaseUrl?: string;
  /** Override the ACMA host used by `getUser()`. Default: `https://acma.weegloo.com`. */
  acmaBaseUrl?: string;
  /** Token storage: `'session'` (default), `'local'`, or a custom adapter. */
  storage?: 'session' | 'local' | StorageAdapter;
  /** Override the storage key. Default: `weegloo:serviceLogin:<spaceId>`. */
  storageKey?: string;
  /** Auto-refresh the access token on demand. Default: `true`. */
  autoRefresh?: boolean;
  /** Seconds of leeway before expiry to trigger refresh. Default: `60`. */
  refreshLeewaySeconds?: number;
}

export interface LoginOptions {
  /** Override the provider for this call. */
  provider?: OAuthProvider;
  /** Arbitrary value stashed in storage; read back with `consumeReturnTo()`. */
  returnTo?: string;
  /**
   * Return here instead of `ServiceLogin.callbackUrl`. Must exactly match one of
   * the ServiceLogin's `allowedCallbackUrls`. Turns on PKCE and `state`, which
   * need `crypto.subtle` (a secure context: https, or http://localhost).
   */
  redirectUri?: string;
}

export interface HandleCallbackOptions {
  /** Query string to parse. Default: `window.location.search`. */
  search?: string;
  /** Provide the exchange token directly instead of reading it from the URL. */
  exchangeToken?: string;
  /** Strip `exchangeToken` from the address bar before the network call. Default: `true`. */
  cleanUrl?: boolean;
}

export type ChangeReason =
  | 'login'
  | 'refresh'
  | 'set'
  | 'clear'
  | 'logout'
  | 'refresh-failed';

export interface ServiceLoginClient {
  readonly spaceId: string;
  readonly authBaseUrl: string;
  readonly acmaBaseUrl: string;

  /**
   * Navigate the browser to the provider sign-in entry URL. Resolves once the
   * navigation is issued; rejects with `code: 'PKCE_UNSUPPORTED'` when
   * `redirectUri` is given outside a secure context.
   */
  login(options?: LoginOptions): Promise<void>;
  /**
   * Run on the callback page: exchange `?exchangeToken=` for tokens. After a
   * `redirectUri` login it also rejects with `code: 'STATE_MISMATCH'`, or with
   * `code: 'LOGIN_FAILED'` carrying Weegloo's `error` and `contact`.
   */
  handleCallback(options?: HandleCallbackOptions): Promise<ServiceLoginTokens>;
  /** Force a token refresh. */
  refresh(): Promise<ServiceLoginTokens>;
  /** Revoke the session server-side and clear local tokens. */
  logout(): Promise<boolean>;

  /** True if a valid (or refreshable) session exists. */
  isLoggedIn(): boolean;
  /** Alias of {@link ServiceLoginClient.isLoggedIn}. */
  isAuthenticated(): boolean;

  /** The raw stored token bundle, or null. */
  getTokens(): ServiceLoginTokens | null;
  /** A valid access token (refreshing if needed), or null when signed out. */
  getAccessToken(): Promise<string | null>;
  /** The current ServiceUser — `GET {acmaBaseUrl}/v1/me`. Rejects if signed out. */
  getUser<T = any>(): Promise<T>;

  /**
   * `fetch` with `Authorization: Bearer <accessToken>` injected. Use against
   * ACMA / ACDA / Upload only. Rejects with `code: 'NOT_LOGGED_IN'` if signed out.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

  /** Subscribe to auth-state changes. Returns an unsubscribe function. */
  onChange(cb: (reason: ChangeReason, tokens: ServiceLoginTokens | null) => void): () => void;

  /** Read and clear a value stashed via `login({ returnTo })`. */
  consumeReturnTo(): string | null;
}

// The built ESM bundle exposes ONLY a default export (the namespace object);
// UMD global and CommonJS `require` return the same object. Named value exports
// are intentionally NOT declared so the types match every build target.

/** Create (or return a cached) client for a Space. */
declare function init(options: InitOptions): ServiceLoginClient;

/** SDK version. */
declare const VERSION: string;

declare const WeeglooServiceLogin: {
  init: typeof init;
  VERSION: string;
};
export default WeeglooServiceLogin;
