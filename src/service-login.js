/*!
 * weegloo-service-user - Weegloo ServiceLogin SDK
 *
 * Pure-vanilla JavaScript client for Weegloo's per-Space "ServiceLogin"
 * (app-managed member sign-in via Google OAuth 2.0).
 *
 * Issued Bearer Tokens are valid ONLY against ACMA / ACDA - never CMA / CDA.
 * See: https://docs.weegloo.com/api-docs/cma  (ServiceLogin / ServiceUser*)
 *
 * Usage (script tag):
 *   <script src="dist/service-login.min.js"></script>
 *   <script>
 *     const auth = WeeglooServiceLogin.init({ spaceId: 'YOUR_SPACE_ID' });
 *     // login button:  auth.login()
 *     // callback page: await auth.handleCallback();
 *     // call ACMA/ACDA: auth.fetch('https://acda.weegloo.com/v1/spaces/.../...')
 *     // logout:        auth.logout()
 *   </script>
 */
// @ts-check
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    // AMD
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    // CommonJS / Node
    module.exports = factory();
  } else {
    // Browser global
    (/** @type {any} */ (root)).WeeglooServiceLogin = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_AUTH_BASE_URL = 'https://auth.weegloo.com';
  var DEFAULT_ACMA_BASE_URL = 'https://acma.weegloo.com';
  var DEFAULT_PROVIDER = 'google';
  var DEFAULT_LEEWAY_SECONDS = 60;
  var DEFAULT_STORAGE_KEY_PREFIX = 'weegloo:serviceLogin:';

  // ---------------------------------------------------------------------------
  // Storage adapters
  // ---------------------------------------------------------------------------

  function memoryStorage() {
    var store = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    };
  }

  function pickStorage(opt) {
    if (opt && typeof opt === 'object' &&
        typeof opt.getItem === 'function' &&
        typeof opt.setItem === 'function' &&
        typeof opt.removeItem === 'function') {
      return opt;
    }
    var name = (typeof opt === 'string') ? opt : 'session';
    if (typeof window === 'undefined') return memoryStorage();
    try {
      if (name === 'local' && window.localStorage) {
        // probe (Safari private mode etc.)
        var probeKey = '__weegloo_probe__';
        window.localStorage.setItem(probeKey, '1');
        window.localStorage.removeItem(probeKey);
        return window.localStorage;
      }
      if (window.sessionStorage) {
        var probeKey2 = '__weegloo_probe__';
        window.sessionStorage.setItem(probeKey2, '1');
        window.sessionStorage.removeItem(probeKey2);
        return window.sessionStorage;
      }
    } catch (_e) {
      // storage blocked → fall through
    }
    return memoryStorage();
  }

  // ---------------------------------------------------------------------------
  // Token bundle helpers
  // ---------------------------------------------------------------------------

  function isExpired(isoString, leewayMs) {
    if (!isoString) return true;
    var t = Date.parse(isoString);
    if (isNaN(t)) return true;
    return Date.now() + (leewayMs || 0) >= t;
  }

  function readTokens(storage, key) {
    try {
      var raw = storage.getItem(key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.accessToken) return null;
      return parsed;
    } catch (_e) {
      return null;
    }
  }

  function writeTokens(storage, key, tokens) {
    try {
      storage.setItem(key, JSON.stringify(tokens));
    } catch (_e) {
      // quota / disabled → silent
    }
  }

  function clearTokens(storage, key) {
    try { storage.removeItem(key); } catch (_e) { /* noop */ }
  }

  // ---------------------------------------------------------------------------
  // HTTP - Weegloo-friendly (no Accept: application/json, vendor media type ok)
  // ---------------------------------------------------------------------------

  function httpJson(method, url, body, extraHeaders) {
    var init = { method: method };
    var headers = {};
    if (extraHeaders && typeof extraHeaders === 'object') {
      for (var hk in extraHeaders) {
        if (Object.prototype.hasOwnProperty.call(extraHeaders, hk)) {
          headers[hk] = extraHeaders[hk];
        }
      }
    }
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (Object.keys(headers).length) init.headers = headers;
    return fetch(url, init).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var parser = ct.indexOf('json') >= 0 ? res.json() : res.text();
      return parser.then(function (payload) {
        if (!res.ok) {
          var err = /** @type {any} */ (new Error('Weegloo ServiceLogin HTTP ' + res.status));
          err.status = res.status;
          err.body = payload;
          throw err;
        }
        return payload;
      }, function () {
        if (!res.ok) {
          var err2 = /** @type {any} */ (new Error('Weegloo ServiceLogin HTTP ' + res.status));
          err2.status = res.status;
          throw err2;
        }
        return null;
      });
    });
  }

  // ---------------------------------------------------------------------------
  // URL helpers
  // ---------------------------------------------------------------------------

  function joinUrl(base, path) {
    if (base.charAt(base.length - 1) === '/') base = base.slice(0, -1);
    if (path.charAt(0) !== '/') path = '/' + path;
    return base + path;
  }

  function buildLoginUrl(authBaseUrl, spaceId, provider) {
    // Login entry URL - the user is redirected here to start the OAuth flow.
    // NOTE: do NOT confuse with the "/login/oauth2/code/{provider}" path,
    // which is Google's redirect URI (registered in Google Cloud as
    // "Authorized redirect URI"); that one is hit by Google → Weegloo,
    // not by the browser directly.
    return joinUrl(authBaseUrl,
      '/v1/spaces/' + encodeURIComponent(spaceId) +
      '/login/oauth2/' + encodeURIComponent(provider));
  }

  function buildTokenUrl(authBaseUrl, spaceId) {
    return joinUrl(authBaseUrl, '/v1/spaces/' + encodeURIComponent(spaceId) + '/oauth/token');
  }

  function buildRefreshUrl(authBaseUrl, spaceId) {
    return joinUrl(authBaseUrl, '/v1/spaces/' + encodeURIComponent(spaceId) + '/oauth/refresh');
  }

  // Best-effort removal of the given query params from the live address bar via
  // history.replaceState. Idempotent; safe to call when the params are absent.
  function stripParamsFromAddressBar(names) {
    if (typeof window === 'undefined') return;
    if (!window.location || !window.history) return;
    if (typeof window.history.replaceState !== 'function') return;
    var search = window.location.search || '';
    if (!search) return;
    try {
      var p = new URLSearchParams(search);
      var stripped = false;
      for (var i = 0; i < names.length; i++) {
        if (p.has(names[i])) {
          p['delete'](names[i]);
          stripped = true;
        }
      }
      if (!stripped) return;
      var qs = p.toString();
      var newUrl = window.location.pathname + (qs ? ('?' + qs) : '') + (window.location.hash || '');
      window.history.replaceState(null, '', newUrl);
    } catch (_e) { /* noop */ }
  }

  // ---------------------------------------------------------------------------
  // PKCE (RFC 7636, S256) - used only when login() is given a redirectUri
  // ---------------------------------------------------------------------------

  var PKCE_VERIFIER_BYTES = 32; // 43 base64url chars - the RFC 7636 minimum length
  var STATE_BYTES = 16;

  // Params Weegloo appends when it returns to a redirectUri (success or failure).
  var REDIRECT_URI_CALLBACK_PARAMS = ['exchangeToken', 'state', 'error', 'contact'];

  function isPkceSupported() {
    // crypto.subtle exists only in a secure context (https, or http://localhost).
    return typeof window !== 'undefined' && !!window.crypto && !!window.crypto.subtle &&
      typeof window.crypto.getRandomValues === 'function' && typeof TextEncoder === 'function';
  }

  function base64UrlEncode(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomBase64Url(byteLength) {
    var bytes = new Uint8Array(byteLength);
    window.crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
  }

  function s256(codeVerifier) {
    return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
      .then(function (digest) { return base64UrlEncode(new Uint8Array(digest)); });
  }

  // ---------------------------------------------------------------------------
  // Instance
  // ---------------------------------------------------------------------------

  // Cache of instances keyed by spaceId so init() can be called freely.
  var instanceCache = {};

  /**
   * @param {import('./types').InitOptions} options
   * @returns {import('./types').ServiceLoginClient}
   */
  function init(options) {
    if (!options || !options.spaceId) {
      throw new Error('WeeglooServiceLogin.init: "spaceId" is required.');
    }
    var cacheKey = options.spaceId + '|' + (options.authBaseUrl || DEFAULT_AUTH_BASE_URL) +
      '|' + (options.acmaBaseUrl || DEFAULT_ACMA_BASE_URL);
    if (instanceCache[cacheKey]) return instanceCache[cacheKey];

    var spaceId = String(options.spaceId);
    var authBaseUrl = options.authBaseUrl || DEFAULT_AUTH_BASE_URL;
    var acmaBaseUrl = options.acmaBaseUrl || DEFAULT_ACMA_BASE_URL;
    var provider = options.provider || DEFAULT_PROVIDER;
    var storage = pickStorage(options.storage);
    var storageKey = options.storageKey || (DEFAULT_STORAGE_KEY_PREFIX + spaceId);
    var autoRefresh = options.autoRefresh !== false;
    var leewayMs = (typeof options.refreshLeewaySeconds === 'number'
      ? options.refreshLeewaySeconds : DEFAULT_LEEWAY_SECONDS) * 1000;

    var listeners = [];
    var pendingRefresh = null; // de-dup concurrent refresh calls

    function notify(reason, tokens) {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](reason, tokens); } catch (_e) { /* listener errors are isolated */ }
      }
    }

    function setTokens(tokens, reason) {
      writeTokens(storage, storageKey, tokens);
      notify(reason || 'set', tokens);
    }

    function clearTokensInternal(reason) {
      clearTokens(storage, storageKey);
      notify(reason || 'clear', null);
    }

    // The PKCE verifier + state of a redirectUri login, kept until its callback.
    var pendingKey = storageKey + ':pkce';

    function writePendingAuthorization(pending) {
      storage.setItem(pendingKey, JSON.stringify(pending));
    }

    // Read-and-remove: one record answers exactly one callback.
    function consumePendingAuthorization() {
      var raw = null;
      try { raw = storage.getItem(pendingKey); storage.removeItem(pendingKey); } catch (_e) { /* noop */ }
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (_e) { return null; }
    }

    function removePendingAuthorization() {
      try { storage.removeItem(pendingKey); } catch (_e) { /* noop */ }
    }

    // Stores a fresh verifier + state and resolves the login-entry query string.
    function startAuthorization(redirectUri) {
      if (!isPkceSupported()) {
        var err = /** @type {any} */ (new Error('WeeglooServiceLogin.login: "redirectUri" needs crypto.subtle, which browsers expose only in a secure context (https, or http://localhost).'));
        err.code = 'PKCE_UNSUPPORTED';
        return Promise.reject(err);
      }
      var codeVerifier = randomBase64Url(PKCE_VERIFIER_BYTES);
      var state = randomBase64Url(STATE_BYTES);
      return s256(codeVerifier).then(function (codeChallenge) {
        writePendingAuthorization({ state: state, codeVerifier: codeVerifier });
        return new URLSearchParams({
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state: state
        }).toString();
      });
    }

    // ---- public API --------------------------------------------------------

    function getTokens() {
      return readTokens(storage, storageKey);
    }

    function isLoggedIn() {
      var t = getTokens();
      if (!t || !t.accessToken) return false;
      // accessToken not expired (with leeway) OR refreshToken still valid
      if (!isExpired(t.expiresAt, leewayMs)) return true;
      if (t.refreshToken && !isExpired(t.refreshExpiresAt, 0)) return true;
      return false;
    }

    function login(loginOptions) {
      if (typeof window === 'undefined' || !window.location) {
        throw new Error('WeeglooServiceLogin.login: requires a browser window.');
      }
      var url = buildLoginUrl(authBaseUrl, spaceId, (loginOptions && loginOptions.provider) || provider);
      // Optional return target - not part of Weegloo OAuth spec, but we let the
      // caller stash a value to read after handleCallback().
      if (loginOptions && loginOptions.returnTo) {
        try { storage.setItem(storageKey + ':returnTo', String(loginOptions.returnTo)); } catch (_e) { /* noop */ }
      }
      var redirectUri = loginOptions && loginOptions.redirectUri;
      if (!redirectUri) {
        // Weegloo returns to ServiceLogin.callbackUrl. Drop a record left by an
        // abandoned redirectUri login, or handleCallback() would expect its state.
        removePendingAuthorization();
        window.location.assign(url);
        return Promise.resolve();
      }
      return startAuthorization(String(redirectUri)).then(function (query) {
        window.location.assign(url + '?' + query);
      });
    }

    function exchangeFor(exchangeToken, codeVerifier) {
      // POST + Content-Type: application/json + JSON body { exchangeToken, codeVerifier? }.
      // Browsers cannot send a request body on GET/HEAD (per the Fetch and
      // XHR specs - fetch throws synchronously, XHR silently nulls the body),
      // so the token-exchange endpoint is invoked via POST.
      var body = { exchangeToken: exchangeToken };
      if (codeVerifier) body.codeVerifier = codeVerifier;
      return httpJson('POST', buildTokenUrl(authBaseUrl, spaceId), body);
    }

    function handleCallback(cbOptions) {
      cbOptions = cbOptions || {};
      if (typeof window === 'undefined' || !window.location) {
        return Promise.reject(new Error('WeeglooServiceLogin.handleCallback: requires a browser window.'));
      }
      var search = (cbOptions.search != null)
        ? String(cbOptions.search)
        : window.location.search;
      var params;
      try {
        params = new URLSearchParams(search);
      } catch (e) {
        return Promise.reject(e);
      }
      var exchangeToken = cbOptions.exchangeToken || params.get('exchangeToken');
      // Present only when this browser started the login with a redirectUri.
      var pending = consumePendingAuthorization();

      // SECURITY: strip exchangeToken from the address bar BEFORE making the
      // network call. The token must NOT linger in window.location / history /
      // outgoing Referer headers regardless of whether the exchange call
      // succeeds, fails, hangs, or the user reloads mid-flight.
      if (cbOptions.cleanUrl !== false) {
        stripParamsFromAddressBar(pending ? REDIRECT_URI_CALLBACK_PARAMS : ['exchangeToken']);
      }

      if (pending) {
        if (params.get('state') !== pending.state) {
          var stateErr = /** @type {any} */ (new Error('WeeglooServiceLogin.handleCallback: "state" does not match the login this browser started.'));
          stateErr.code = 'STATE_MISMATCH';
          return Promise.reject(stateErr);
        }
        var loginError = params.get('error');
        if (loginError) {
          var failure = /** @type {any} */ (new Error('WeeglooServiceLogin.handleCallback: sign-in failed (' + loginError + ').'));
          failure.code = 'LOGIN_FAILED';
          failure.error = loginError;
          failure.contact = params.get('contact');
          return Promise.reject(failure);
        }
      }

      if (!exchangeToken) {
        return Promise.reject(new Error('WeeglooServiceLogin.handleCallback: "exchangeToken" not found in URL.'));
      }

      return exchangeFor(exchangeToken, pending && pending.codeVerifier).then(function (tokens) {
        setTokens(tokens, 'login');
        return tokens;
      });
    }

    function refresh() {
      var current = getTokens();
      if (!current || !current.refreshToken) {
        return Promise.reject(new Error('WeeglooServiceLogin.refresh: no refreshToken stored.'));
      }
      if (pendingRefresh) return pendingRefresh;

      pendingRefresh = httpJson('POST', buildRefreshUrl(authBaseUrl, spaceId), {
        refreshToken: current.refreshToken
      }).then(function (tokens) {
        // Some servers may omit refreshToken on refresh - keep the previous one.
        if (tokens && !tokens.refreshToken && current.refreshToken) {
          tokens.refreshToken = current.refreshToken;
          if (current.refreshExpiresAt && !tokens.refreshExpiresAt) {
            tokens.refreshExpiresAt = current.refreshExpiresAt;
          }
        }
        setTokens(tokens, 'refresh');
        return tokens;
      }).catch(function (err) {
        // Refresh failed → wipe stored tokens; caller should redirect to login.
        clearTokensInternal('refresh-failed');
        throw err;
      }).then(function (v) {
        pendingRefresh = null;
        return v;
      }, function (e) {
        pendingRefresh = null;
        throw e;
      });

      return pendingRefresh;
    }

    function getAccessToken() {
      var t = getTokens();
      if (!t || !t.accessToken) return Promise.resolve(null);
      if (!isExpired(t.expiresAt, leewayMs)) return Promise.resolve(t.accessToken);
      if (autoRefresh && t.refreshToken && !isExpired(t.refreshExpiresAt, 0)) {
        return refresh().then(function (nt) { return (nt && nt.accessToken) || null; }, function () { return null; });
      }
      return Promise.resolve(null);
    }

    function logout() {
      var current = getTokens();
      var url = buildTokenUrl(authBaseUrl, spaceId);
      var body = (current && current.refreshToken) ? { refreshToken: current.refreshToken } : null;

      // Always wipe local state, even if the server call fails - the user has
      // already pressed "logout".
      var settle = function () { clearTokensInternal('logout'); };

      // Server expects Authorization: Bearer <accessToken> on logout (same as
      // ACMA/ACDA). Use getAccessToken() so an expired access token is refreshed
      // when possible before the DELETE.
      // README also recommends sending refreshToken in the body. Use DELETE
      // with JSON body (browsers allow body on DELETE).
      return getAccessToken().then(function (accessToken) {
        var authHeaders = {};
        if (accessToken) authHeaders['Authorization'] = 'Bearer ' + accessToken;
        return httpJson('DELETE', url, body, authHeaders);
      }).then(function () {
      // README explicitly recommends sending refreshToken with the logout
        settle();
        return true;
      }, function (err) {
        settle();
        // Surface non-network failures so callers can log them, but state
        // is already clean.
        if (!err || (err.status && err.status < 500)) return true;
        throw err;
      });
    }

    function getUser() {
      // The current ServiceUser for the active session.
      // IMPORTANT: ACMA exposes this at /v1/me - NOT /v1/spaces/{spaceId}/me.
      return authedFetch(joinUrl(acmaBaseUrl, '/v1/me')).then(function (res) {
        if (!res.ok) {
          var err = /** @type {any} */ (new Error('WeeglooServiceLogin.getUser: HTTP ' + res.status));
          err.status = res.status;
          throw err;
        }
        return res.json();
      });
    }

    function authedFetch(input, init) {
      return getAccessToken().then(function (token) {
        if (!token) {
          var err = /** @type {any} */ (new Error('WeeglooServiceLogin.fetch: not logged in.'));
          err.code = 'NOT_LOGGED_IN';
          throw err;
        }
        var nextInit = init ? Object.assign({}, init) : {};
        var headers = nextInit.headers ? Object.assign({}, nextInit.headers) : {};
        // Normalize header keys to a single canonical form.
        var hasAuth = false;
        for (var k in headers) {
          if (k.toLowerCase() === 'authorization') { hasAuth = true; break; }
        }
        if (!hasAuth) headers['Authorization'] = 'Bearer ' + token;

        // Strip a forced Accept: application/json - Weegloo serves a vendor
        // media type. (See weegloo-api-endpoints rule.)
        for (var k2 in headers) {
          if (k2.toLowerCase() === 'accept' && /application\/json\b/i.test(headers[k2]) &&
              !/vnd\.com\.weegloo/i.test(headers[k2])) {
            delete headers[k2];
          }
        }

        nextInit.headers = headers;
        return fetch(input, nextInit);
      });
    }

    function onChange(cb) {
      if (typeof cb !== 'function') return function () {};
      listeners.push(cb);
      return function unsubscribe() {
        var i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    }

    function consumeReturnTo() {
      var key = storageKey + ':returnTo';
      var v = null;
      try { v = storage.getItem(key); storage.removeItem(key); } catch (_e) { /* noop */ }
      return v;
    }

    /** @type {import('./types').ServiceLoginClient} */
    var instance = {
      spaceId: spaceId,
      authBaseUrl: authBaseUrl,
      acmaBaseUrl: acmaBaseUrl,

      login: login,
      handleCallback: handleCallback,
      refresh: refresh,
      logout: logout,

      isLoggedIn: isLoggedIn,
      isAuthenticated: isLoggedIn, // alias - common ecosystem name
      getTokens: getTokens,
      getAccessToken: getAccessToken,
      getUser: getUser,

      fetch: authedFetch,
      onChange: onChange,

      consumeReturnTo: consumeReturnTo
    };

    instanceCache[cacheKey] = instance;
    return instance;
  }

  return {
    init: init,
    VERSION: '1.3.0'
  };
}));
