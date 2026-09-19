'use strict';
/* ---------------------------------------------------------------------------
   Authentication middleware (req 9).

   Any route mounted behind requireAuth is unreachable without a valid,
   unexpired access token. This is the thing that actually protects the
   dashboard data — hiding a tab in the frontend protects nothing, because
   anyone can call the API directly with curl.

   Attaches req.auth = { id, uid, role, loc } for downstream handlers. Nothing
   downstream should ever read a user id out of the request body or query
   string, because the client controls those; req.auth comes from a signature
   the client cannot forge.
   --------------------------------------------------------------------------- */

var tokens = require('../services/tokenService');

function unauthorized(res, message, code) {
  return res.status(401).json({ error: message, code: code || 'UNAUTHORIZED' });
}

function requireAuth(req, res, next) {
  var header = req.headers.authorization || '';
  var match = /^Bearer\s+(.+)$/i.exec(header.trim());

  if (!match) return unauthorized(res, 'Sign in to continue', 'NO_TOKEN');

  var decoded;
  try {
    decoded = tokens.verifyAccessToken(match[1]);
  } catch (err) {
    /* TOKEN_EXPIRED is called out separately so the frontend knows to try a
       silent refresh rather than bouncing the user to the login screen. */
    if (err.name === 'TokenExpiredError') {
      return unauthorized(res, 'Your session has expired', 'TOKEN_EXPIRED');
    }
    return unauthorized(res, 'Sign in to continue', 'INVALID_TOKEN');
  }

  req.auth = {
    id: decoded.sub,
    uid: decoded.uid,
    role: decoded.role,
    loc: decoded.loc || null
  };
  next();
}

module.exports = requireAuth;
