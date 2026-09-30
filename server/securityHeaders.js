'use strict';
/* ---------------------------------------------------------------------------
   The one source of truth for the page's security headers.

   Two things serve index.html:
     - Express (local, Render) — helmet reads CSP_DIRECTIVES below.
     - Vercel's static CDN — Express never sees that request, so the same
       headers are declared in vercel.json. scripts/build.js compares the two
       and fails the build if they have drifted apart.

   The CSP matches what index.html actually does: one big inline <script> and
   inline style attributes, data: and blob: URIs for icons and captured
   photos, and fetch to this origin only. The browser no longer talks to
   Supabase — task and product sync go through /api/sync — so connect-src is
   'self' alone. Images still allow Supabase Storage (photos recorded before
   the move to Vercel) and Vercel Blob (photos recorded since).

   'unsafe-inline' for scripts is required by the single-file design; moving
   the inline script to its own file would let it be dropped.
   --------------------------------------------------------------------------- */

var PHOTO_HOSTS = [
  'https://*.supabase.co',                       // photos taken before the move
  'https://*.public.blob.vercel-storage.com'     // photos taken since
];

var CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:'].concat(PHOTO_HOSTS),
  connectSrc: ["'self'"],
  fontSrc: ["'self'", 'data:'],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  /* No inline on…= handlers anywhere: every click goes through data-a. */
  scriptSrcAttr: ["'none'"]
};

/* upgrade-insecure-requests makes the browser rewrite every http:// request
   as https://. Right on an HTTPS host (Vercel, Render); fatal on the plain-
   http development server, where it silently breaks every API call made from
   any address other than localhost — e.g. http://172.16.36.24:3000 on the
   office Wi-Fi. So it is only switched on for HTTPS deployments. */
function cspDirectives(opts) {
  var d = {};
  Object.keys(CSP_DIRECTIVES).forEach(function (k) { d[k] = CSP_DIRECTIVES[k]; });
  if (opts && opts.upgrade) d.upgradeInsecureRequests = [];
  return d;
}

function kebab(s) { return s.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }); }

/* The directives as one header value, in the same order helmet writes them. */
function cspString(opts) {
  var d = cspDirectives(opts);
  return Object.keys(d).map(function (k) {
    return d[k].length ? kebab(k) + ' ' + d[k].join(' ') : kebab(k);
  }).join(';');
}

/* What vercel.json must send with index.html. Keys are header names. */
function staticPageHeaders() {
  return {
    'Content-Security-Policy': cspString({ upgrade: true }),   // Vercel is always HTTPS
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Cache-Control': 'no-cache'
  };
}

module.exports = {
  CSP_DIRECTIVES: CSP_DIRECTIVES,
  cspDirectives: cspDirectives,
  cspString: cspString,
  staticPageHeaders: staticPageHeaders
};
