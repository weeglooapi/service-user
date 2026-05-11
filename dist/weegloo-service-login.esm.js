/*! weegloo-service-login (ESM build) */
'use strict';
'use strict';

  var DEFAULT_AUTH_BASE_URL = 'https://auth.weegloo.com';
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
  // HTTP — Weegloo-friendly (no Accept: application/json, vendor media type ok)
  // ---------------------------------------------------------------------------

  function httpJson(method, url, body) {
    var init = { method: method };
    if (body !== undefined && body !== null) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var parser = ct.indexOf('json') >= 0 ? res.json() : res.text();
      return parser.then(function (payload) {
        if (!res.ok) {
          var err = new Error('Weegloo ServiceLogin HTTP ' + res.status);
          err.status = res.status;
          err.body = payload;
          throw err;
        }
        return payload;
      }, function () {
        if (!res.ok) {
          var err2 = new Error('Weegloo ServiceLogin HTTP ' + res.status);
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
    // Login entry URL — see UMD source for details.
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

  // Best-effort removal of `exchangeToken` from the live address bar via
  // history.replaceState. Idempotent; safe to call when the param is absent.
  function stripExchangeTokenFromAddressBar() {
    if (typeof window === 'undefined') return;
    if (!window.location || !window.history) return;
    if (typeof window.history.replaceState !== 'function') return;
    var search = window.location.search || '';
    if (search.indexOf('exchangeToken') < 0) return;
    try {
      var p = new URLSearchParams(search);
      if (!p.has('exchangeToken')) return;
      p['delete']('exchangeToken');
      var qs = p.toString();
      var newUrl = window.location.pathname + (qs ? ('?' + qs) : '') + (window.location.hash || '');
      window.history.replaceState(null, '', newUrl);
    } catch (_e) { /* noop */ }
  }

  // ---------------------------------------------------------------------------
  // Instance
  // ---------------------------------------------------------------------------

  // Cache of instances keyed by spaceId so init() can be called freely.
  var instanceCache = {};

  function init(options) {
    if (!options || !options.spaceId) {
      throw new Error('WeeglooServiceLogin.init: "spaceId" is required.');
    }
    var cacheKey = options.spaceId + '|' + (options.authBaseUrl || DEFAULT_AUTH_BASE_URL);
    if (instanceCache[cacheKey]) return instanceCache[cacheKey];

    var spaceId = String(options.spaceId);
    var authBaseUrl = options.authBaseUrl || DEFAULT_AUTH_BASE_URL;
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
      // Optional return target — not part of Weegloo OAuth spec, but we let the
      // caller stash a value to read after handleCallback().
      if (loginOptions && loginOptions.returnTo) {
        try { storage.setItem(storageKey + ':returnTo', String(loginOptions.returnTo)); } catch (_e) { /* noop */ }
      }
      window.location.assign(url);
    }

    function exchangeFor(exchangeToken) {
      // POST + JSON body — see UMD source for rationale.
      return httpJson('POST', buildTokenUrl(authBaseUrl, spaceId), {
        exchangeToken: exchangeToken
      });
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

      // SECURITY: strip exchangeToken from address bar BEFORE network call.
      if (cbOptions.cleanUrl !== false) {
        stripExchangeTokenFromAddressBar();
      }

      if (!exchangeToken) {
        return Promise.reject(new Error('WeeglooServiceLogin.handleCallback: "exchangeToken" not found in URL.'));
      }

      return exchangeFor(exchangeToken).then(function (tokens) {
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
        // Some servers may omit refreshToken on refresh — keep the previous one.
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

      // Always wipe local state, even if the server call fails — the user has
      // already pressed "logout".
      var settle = function () { clearTokensInternal('logout'); };

      // README explicitly recommends sending refreshToken with the logout
      // call. Use DELETE with JSON body (browsers allow body on DELETE).
      return httpJson('DELETE', url, body).then(function () {
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

    function authedFetch(input, init) {
      return getAccessToken().then(function (token) {
        if (!token) {
          var err = new Error('WeeglooServiceLogin.fetch: not logged in.');
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

        // Strip a forced Accept: application/json — Weegloo serves a vendor
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

    var instance = {
      spaceId: spaceId,
      authBaseUrl: authBaseUrl,

      login: login,
      handleCallback: handleCallback,
      refresh: refresh,
      logout: logout,

      isLoggedIn: isLoggedIn,
      getTokens: getTokens,
      getAccessToken: getAccessToken,

      fetch: authedFetch,
      onChange: onChange,

      consumeReturnTo: consumeReturnTo
    };

    instanceCache[cacheKey] = instance;
    return instance;
  }

const __WeeglooServiceLogin = {
    init: init,
    VERSION: '1.0.0'
  };
export default __WeeglooServiceLogin;
