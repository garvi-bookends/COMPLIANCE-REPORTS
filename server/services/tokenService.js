'use strict';
/* ---------------------------------------------------------------------------
   Token minting and verification (req 5).

   Two different tokens, on purpose:

   - ACCESS token: a short-lived (15 min) signed JWT. Sent to the frontend in
     the JSON response body and held in memory only. It carries the claims the
     API needs to authorise a request, so no database read is needed per call.

   - REFRESH token: a long-lived (30 day) opaque random string, delivered in
     an httpOnly cookie the JavaScript cannot read. Recorded (hashed) in
     app_refresh_tokens so it can be revoked. This is what keeps a phone
     signed in across restarts without ever putting a long-lived credential
     somewhere a cross-site script could steal it.

   The access token deliberately does NOT go in localStorage. Anything in
   localStorage is readable by any script on the page; an httpOnly cookie is
   not, which is what req 10 is really asking for.
   --------------------------------------------------------------------------- */

var jwt = require('jsonwebtoken');
var crypto = require('crypto');
var config = require('../config/env');

var REFRESH_COOKIE = 'bk_refresh';

/* --------------------------------------------------------------------------
   Access token
   -------------------------------------------------------------------------- */

/* Claims are kept to what authorisation needs. No name, no password state,
   nothing sensitive — a JWT payload is only signed, not encrypted, so anyone
   holding the token can read it. */
function signAccessToken(user) {
  var payload = {
    sub: user.id,
    uid: user.uid,
    role: user.role,
    loc: user.loc || null,
    typ: 'access'
  };
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.accessTtl,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    algorithm: 'HS256'
  });
}

/* Throws on anything wrong: bad signature, expiry, wrong issuer/audience, or
   an algorithm the caller tried to substitute. Pinning `algorithms` is what
   stops the classic "alg: none" and RS256->HS256 confusion attacks. */
function verifyAccessToken(token) {
  var opts = {
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    algorithms: ['HS256']
  };
  var decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret, opts);
  } catch (err) {
    /* During a secret rotation, a token signed with the old secret is still
       good until it expires. Only a bad signature earns the second try; an
       expired token is expired whichever secret signed it. */
    if (!config.jwt.previousSecret || err.name !== 'JsonWebTokenError' || err.message !== 'invalid signature') throw err;
    decoded = jwt.verify(token, config.jwt.previousSecret, opts);
  }
  if (decoded.typ !== 'access') {
    throw Object.assign(new Error('Wrong token type'), { name: 'JsonWebTokenError' });
  }
  return decoded;
}

/* Seconds until the access token expires, so the frontend can schedule a
   silent refresh instead of waiting for a 401. */
function accessTokenTtlSeconds() {
  var m = /^(\d+)([smhd])?$/.exec(String(config.jwt.accessTtl));
  if (!m) return 900;
  var n = parseInt(m[1], 10);
  var unit = m[2] || 's';
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 })[unit];
}

/* --------------------------------------------------------------------------
   Refresh token
   -------------------------------------------------------------------------- */

/* 48 random bytes from the CSPRNG. Opaque by design: it carries no claims,
   it is only a lookup key into app_refresh_tokens, so revoking it is a single
   UPDATE and there is nothing in it to tamper with. */
function newRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function refreshTokenExpiry() {
  return new Date(Date.now() + config.jwt.refreshTtlDays * 86400 * 1000);
}

/* SameSite:
   - Strict when the page and the API share an origin (Vercel, or Express
     serving index.html). The browser then never attaches the cookie to a
     request started by another site, which shuts out cross-site request
     forgery against /api/auth entirely.
   - None only when CORS_ORIGINS lists a separate frontend origin, because
     that setup genuinely needs the cookie to travel cross-site.
   - Lax in local development over plain http. */
function sameSitePolicy() {
  if (config.corsOrigins.length) return config.isProd ? 'none' : 'lax';
  return config.isProd ? 'strict' : 'lax';
}

function refreshCookieOptions() {
  return {
    httpOnly: true,                              // JavaScript cannot read it
    secure: config.isProd,                       // HTTPS only in production
    sameSite: sameSitePolicy(),
    path: '/api/auth',                           // sent only to the auth routes, not with every request
    maxAge: config.jwt.refreshTtlDays * 86400 * 1000
  };
}

function setRefreshCookie(res, rawToken) {
  res.cookie(REFRESH_COOKIE, rawToken, refreshCookieOptions());
}

function clearRefreshCookie(res) {
  var opts = refreshCookieOptions();
  delete opts.maxAge;
  res.clearCookie(REFRESH_COOKIE, opts);
}

function readRefreshCookie(req) {
  /* Cookie first. The body fallback exists only for clients that cannot keep
     cookies at all (some iOS standalone PWA cases); it is still the same
     revocable, server-recorded token, never a password. */
  return (req.cookies && req.cookies[REFRESH_COOKIE]) ||
         (req.body && req.body.refreshToken) ||
         null;
}

module.exports = {
  REFRESH_COOKIE: REFRESH_COOKIE,
  signAccessToken: signAccessToken,
  verifyAccessToken: verifyAccessToken,
  accessTokenTtlSeconds: accessTokenTtlSeconds,
  newRefreshToken: newRefreshToken,
  refreshTokenExpiry: refreshTokenExpiry,
  setRefreshCookie: setRefreshCookie,
  clearRefreshCookie: clearRefreshCookie,
  readRefreshCookie: readRefreshCookie
};
