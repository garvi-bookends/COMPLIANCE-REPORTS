'use strict';
/* ---------------------------------------------------------------------------
   Refresh token store.

   A JWT on its own cannot be revoked — once issued it is valid until it
   expires. Recording each refresh token here makes a session revocable: log
   out, an admin resetting a password, or deleting a user all take effect
   immediately rather than up to 30 days later.

   Only the SHA-256 of the token is stored. A stolen database dump therefore
   cannot be replayed as a live session, the same reason passwords are hashed.
   --------------------------------------------------------------------------- */

var crypto = require('crypto');
var db = require('../db/pool');

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

function issue(userId, rawToken, expiresAt, ctx) {
  var id = crypto.randomBytes(12).toString('hex');
  return db.query(
    'insert into app_refresh_tokens (id, user_id, token_hash, expires_at, user_agent, ip) ' +
    'values ($1, $2, $3, $4, $5, $6) returning id',
    [id, userId, hashToken(rawToken), expiresAt,
      String((ctx && ctx.userAgent) || '').slice(0, 300), (ctx && ctx.ip) || null]
  ).then(function (r) { return r.rows[0].id; });
}

/* Returns the stored row only if the token is live: not revoked, not expired,
   and belonging to an account that is still enabled. */
function findActive(rawToken) {
  return db.query(
    'select t.id, t.user_id, t.expires_at ' +
    '  from app_refresh_tokens t ' +
    '  join app_users u on u.id = t.user_id ' +
    ' where t.token_hash = $1 ' +
    '   and t.revoked_at is null ' +
    '   and t.expires_at > now() ' +
    '   and u.disabled = false',
    [hashToken(rawToken)]
  ).then(function (r) { return r.rows[0] || null; });
}

function revoke(rawToken) {
  return db.query(
    'update app_refresh_tokens set revoked_at = now() ' +
    ' where token_hash = $1 and revoked_at is null',
    [hashToken(rawToken)]
  ).then(function (r) { return r.rowCount > 0; });
}

/* Signs a user out of every device. Used on password change and admin reset:
   if the old password leaked, any session it created has to die with it. */
function revokeAllForUser(userId) {
  return db.query(
    'update app_refresh_tokens set revoked_at = now() ' +
    ' where user_id = $1 and revoked_at is null',
    [userId]
  ).then(function (r) { return r.rowCount; });
}

/* Housekeeping — dropped rows are already unusable, this just keeps the table
   from growing without bound. Called hourly from server.js. */
function purgeExpired() {
  return db.query(
    'delete from app_refresh_tokens ' +
    ' where expires_at < now() - interval \'7 days\' ' +
    '    or (revoked_at is not null and revoked_at < now() - interval \'7 days\')'
  ).then(function (r) { return r.rowCount; });
}

module.exports = {
  issue: issue,
  findActive: findActive,
  revoke: revoke,
  revokeAllForUser: revokeAllForUser,
  purgeExpired: purgeExpired
};
