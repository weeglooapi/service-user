#!/usr/bin/env node
/*
 * Build script for weegloo-service-user.
 *
 * Reads:    src/service-login.js  (UMD, the canonical source)
 * Produces: dist/service-login.js              (UMD copy)
 *           dist/service-login.<hash>.js       (UMD, content-addressed)
 *           dist/service-login.esm.js          (ESM build)
 *           dist/service-login.<hash>.esm.js   (ESM, content-addressed)
 *           dist/service-login.min.js          (UMD minified)
 *           dist/service-login.<hash>.min.js   (UMD minified, content-addressed)
 *           dist/manifest.json                 (file map + integrity hashes)
 *
 * The non-hashed files are the "latest" aliases - they are mutable across
 * releases and meant to be referenced via `<script src="...service-login.min.js">`
 * by consumers who want auto-updates. The hashed files are immutable; the same
 * <hash> always serves the same bytes, suitable for `integrity="sha384-..."`
 * pinning and aggressive CDN caching.
 *
 * No external dependencies - runs on a stock Node.js install.
 *
 *   node scripts/build.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC  = path.join(ROOT, 'src',  'service-login.js');
const DIST = path.join(ROOT, 'dist');

const HASH_LEN = 8;            // 8 hex chars of sha256 - collision-safe for our scale
const SRI_ALGO = 'sha384';     // Standard SRI hash for <script integrity="...">

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------
function read(p)   { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }

function cleanDist() {
  if (!fs.existsSync(DIST)) {
    fs.mkdirSync(DIST, { recursive: true });
    return;
  }
  for (const f of fs.readdirSync(DIST)) {
    const full = path.join(DIST, f);
    if (fs.statSync(full).isFile()) fs.unlinkSync(full);
  }
}

// ---------------------------------------------------------------------------
// ESM builder - strip the UMD wrapper and emit `export default`.
// ---------------------------------------------------------------------------
function buildEsm(srcText) {
  // Locate the factory `function () { 'use strict'; ... }`.
  const factoryMatch = srcText.match(/function\s*\(\s*\)\s*\{\s*'use strict';/);
  if (!factoryMatch) throw new Error('build/esm: factory function not found in source');

  const openIdx = srcText.indexOf('{', factoryMatch.index);
  let depth = 0, endIdx = -1;
  for (let i = openIdx; i < srcText.length; i++) {
    const ch = srcText[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx < 0) throw new Error('build/esm: factory braces not matched');
  const body = srcText.slice(openIdx + 1, endIdx);

  // Walk back from the tail to find the final `return { ... };` (the
  // namespace object). A non-greedy regex backtracks to earlier `return {...}`
  // calls inside helper functions and corrupts the slice - brace walking is
  // the only reliable way.
  let bodyTrimEnd = body.length;
  while (bodyTrimEnd > 0 && /\s/.test(body[bodyTrimEnd - 1])) bodyTrimEnd--;
  if (body[bodyTrimEnd - 1] !== ';' || body[bodyTrimEnd - 2] !== '}') {
    throw new Error('build/esm: factory body does not end with `};`');
  }
  const braceClose = bodyTrimEnd - 2;
  let depth2 = 1, braceOpen = -1;
  for (let p = braceClose - 1; p >= 0; p--) {
    const c = body[p];
    if (c === '}') depth2++;
    else if (c === '{') { depth2--; if (depth2 === 0) { braceOpen = p; break; } }
  }
  if (braceOpen < 0) throw new Error('build/esm: cannot match factory return braces');

  const between = body.slice(0, braceOpen);
  const retM = between.match(/return\s+$/);
  if (!retM) throw new Error('build/esm: expected `return ` before final `{`');
  const namespace = body.slice(braceOpen, braceClose + 1);
  const bodyWithoutReturn = body.slice(0, between.length - retM[0].length);

  // The body declares top-level `function init` (and others) which would clash
  // with named exports, so we expose only the default-exported namespace.
  return [
    '/*! weegloo-service-user (ESM build) */',
    "'use strict';",
    bodyWithoutReturn.trim(),
    '',
    'const __WeeglooServiceLogin = ' + namespace + ';',
    'export default __WeeglooServiceLogin;',
    ''
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Minifier - streaming, string/regex-aware, no post-pass collapse so it cannot
// corrupt literals. NOT a general-purpose minifier; tuned for our hand-written
// source and verified by sanity-tested sample runs.
// ---------------------------------------------------------------------------
function buildMin(srcText) {
  const IDENT = /[A-Za-z0-9_$]/;
  const PUNCT_NO_SPACE  = /[{}()\[\];,]/;
  const SPACE_OPTIONAL  = /[=<>!+\-*/%&|^~?:]/;

  let out = '';
  const lastNonSpace = () => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    return j >= 0 ? out[j] : '';
  };
  const trimTrailingSpace = () => {
    while (out.length && /\s/.test(out[out.length - 1])) out = out.slice(0, -1);
  };

  let i = 0;
  const n = srcText.length;

  while (i < n) {
    const ch = srcText[i];
    const next = srcText[i + 1];

    // line comment
    if (ch === '/' && next === '/') {
      while (i < n && srcText[i] !== '\n') i++;
      continue;
    }
    // block comment (banners included)
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(srcText[i] === '*' && srcText[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // string literals - copy verbatim
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = srcText[i];
        out += c;
        i++;
        if (c === '\\' && i < n) { out += srcText[i]; i++; continue; }
        if (c === q) break;
      }
      continue;
    }

    // regex literal vs division
    if (ch === '/') {
      const prev = lastNonSpace();
      const canRegex = prev === '' || /[=({,;:!&|?+\-*%^~<>\[]/.test(prev);
      let isAfterKeyword = false;
      if (!canRegex && /[A-Za-z_$]/.test(prev)) {
        let k = out.length - 1;
        while (k >= 0 && /\s/.test(out[k])) k--;
        const end = k;
        while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) k--;
        const word = out.slice(k + 1, end + 1);
        if (['return','typeof','in','of','instanceof','new','delete','void','throw','case','do','else'].indexOf(word) >= 0) {
          isAfterKeyword = true;
        }
      }
      if (canRegex || isAfterKeyword) {
        out += ch;
        i++;
        let inClass = false;
        while (i < n) {
          const c2 = srcText[i];
          out += c2;
          i++;
          if (c2 === '\\' && i < n) { out += srcText[i]; i++; continue; }
          if (c2 === '[') inClass = true;
          else if (c2 === ']') inClass = false;
          else if (c2 === '/' && !inClass) break;
        }
        while (i < n && /[a-z]/i.test(srcText[i])) { out += srcText[i]; i++; }
        continue;
      }
    }

    // whitespace - keep one space between two identifier-runs, drop otherwise
    if (/\s/.test(ch)) {
      while (i < n && /\s/.test(srcText[i])) i++;
      const prev = lastNonSpace();
      const nextCh = srcText[i] || '';
      if (prev === '' || nextCh === '') continue;
      if (IDENT.test(prev) && IDENT.test(nextCh)) {
        trimTrailingSpace();
        out += ' ';
      }
      continue;
    }

    // punctuation
    if (PUNCT_NO_SPACE.test(ch) || SPACE_OPTIONAL.test(ch)) {
      trimTrailingSpace();
      out += ch;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out.replace(/^\s+|\s+$/g, '') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const src = read(SRC);

  const outputs = [
    { kind: 'umd', ext: '.js',     content: src              },
    { kind: 'esm', ext: '.esm.js', content: buildEsm(src)    },
    { kind: 'min', ext: '.min.js', content: buildMin(src)    }
  ];

  cleanDist();

  const manifest = {
    name:    'weegloo-service-user',
    version: require(path.join(ROOT, 'package.json')).version,
    builtAt: new Date().toISOString(),
    files:   {}
  };

  for (const o of outputs) {
    const sha256 = crypto.createHash('sha256').update(o.content).digest('hex');
    const sri    = SRI_ALGO + '-' + crypto.createHash(SRI_ALGO).update(o.content).digest('base64');
    const hash   = sha256.slice(0, HASH_LEN);
    const latest = 'service-login' + o.ext;
    const hashed = 'service-login.' + hash + o.ext;

    write(path.join(DIST, latest), o.content);
    write(path.join(DIST, hashed), o.content);

    manifest.files[o.kind] = {
      latest,
      hashed,
      bytes: Buffer.byteLength(o.content, 'utf8'),
      sha256,
      integrity: sri
    };

    console.log('build: dist/' + latest.padEnd(40) + ' ' + manifest.files[o.kind].bytes + ' B');
    console.log('build: dist/' + hashed.padEnd(40) + ' ' + manifest.files[o.kind].bytes + ' B');
  }

  write(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('build: dist/manifest.json');
}

main();
