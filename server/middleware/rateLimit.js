'use strict';
/* ---------------------------------------------------------------------------
   Per-IP rate limiting for the public auth endpoints.

   The per-account lockout in authService stops one account being brute
   forced. This stops one source spraying a common password across many
   accounts, which the per-account counter would never notice.

   The counters live in Postgres (app_rate_limits), not in memory. On Vercel
   many short-lived instances serve requests side by side, each with its own
   memory, so an in-memory counter would let an attacker spread guesses across
   them. One shared table gives every instance the same count, with no extra
   service to run. Each hit is a single atomic upsert, so two requests landing
   at the same moment cannot both squeeze under the limit.

   If the database cannot be reached the request is let through: sign-in
   needs the database anyway, and the per-account lockout still applies.
   Expired rows are removed by the cleanup job (services/cleanupService.js).
   --------------------------------------------------------------------------- */

var db = require('../db/pool');

/* Starts a fresh window when the old one has run out, otherwise counts one
   more hit in the current window. Returns the count and when it resets. */
var HIT_SQL =
  'insert into app_rate_limits (key, count, reset_at) ' +
  "values ($1, 1, now() + make_interval(secs => $2)) " +
  'on conflict (key) do update set ' +
  '  count = case when app_rate_limits.reset_at < now() then 1 else app_rate_limits.count + 1 end, ' +
  "  reset_at = case when app_rate_limits.reset_at < now() then now() + make_interval(secs => $2) else app_rate_limits.reset_at end " +
  'returning count, reset_at';

/* opts: { windowMs, max, message, keyBy } */
function rateLimit(opts) {
  opts = opts || {};
  var windowMs = opts.windowMs || 15 * 60 * 1000;
  var max = opts.max || 30;
  var message = opts.message || 'Too many attempts. Please wait a few minutes and try again.';
  var keyBy = opts.keyBy || function (req) { return req.ip; };

  return function (req, res, next) {
    var key = String(keyBy(req) || 'unknown').slice(0, 200);

    db.query(HIT_SQL, [key, windowMs / 1000]).then(function (r) {
      var row = r.rows[0];
      var remaining = Math.max(0, max - row.count);
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(remaining));

      if (row.count > max) {
        var retryAfter = Math.max(1, Math.ceil((new Date(row.reset_at).getTime() - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({ error: message, code: 'RATE_LIMITED', retryAfter: retryAfter });
      }
      next();
    }, function (err) {
      console.error('[rate-limit] could not record a hit for ' + key + ', letting it through: ' + err.message);
      next();
    });
  };
}

/* Lets a successful login stop counting against the attacker's budget, so a
   user who simply mistyped once is not punished for the rest of the window.
   Fire-and-forget: the login has already succeeded either way. */
function reset(key) {
  return db.query('delete from app_rate_limits where key = $1', [String(key)])
    .catch(function (err) { console.error('[rate-limit] reset failed: ' + err.message); });
}

module.exports = rateLimit;
module.exports.reset = reset;
