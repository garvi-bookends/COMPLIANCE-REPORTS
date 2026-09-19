'use strict';
/* ---------------------------------------------------------------------------
   User model — every read and write of an account goes through here.

   Two rules this file exists to enforce:

   1. PROFILE_COLUMNS is the only column list used by anything that returns a
      user to a caller. password_hash is not in it, and the credentials table
      is only ever touched by the functions named *Credential* / *PasswordHash*,
      which are used exclusively by authService. So no route can leak a hash
      even by mistake.

   2. toAppUser() maps a database row onto the exact object shape the existing
      frontend already uses ({ id, uid, name, role, loc, mustChange,
      createdAt, lastLogin }), so the UI code in index.html did not have to be
      rewritten around a new schema (req 12).
   --------------------------------------------------------------------------- */

var db = require('../db/pool');
var crypto = require('crypto');

var PROFILE_COLUMNS =
  'id, uid, name, role, loc, first_login, must_change_password, ' +
  'last_login_at, login_count, disabled, pending, reset_requested_at, created_at, created_by, updated_at';

var SUPERADMIN = 'superadmin';

var VALID_ROLES = [SUPERADMIN, 'exec', 'aexec', 'admin', 'hok', 'manager', 'staff', 'auditor'];

/* Every role EXCEPT superadmin. This is what the app's forms and APIs accept.
   The Super Admin is never handed out from inside the app — it is set on the
   server with `npm run set-superadmin`, and the database allows only one. */
var ASSIGNABLE_ROLES = VALID_ROLES.filter(function (r) { return r !== SUPERADMIN; });

/* Roles allowed to create users and reset passwords — mirrors ROLES[].manage
   in index.html. The server is the authority; the frontend check only decides
   whether the button is drawn. */
var MANAGER_ROLES = [SUPERADMIN, 'exec', 'aexec', 'admin'];

/* Roles that see every location (ROLES[].all). These accounts get loc = null. */
var ALL_LOCATION_ROLES = [SUPERADMIN, 'exec', 'aexec', 'admin', 'hok', 'auditor'];

/* --------------------------------------------------------------------------
   Shaping
   -------------------------------------------------------------------------- */

/* Database row -> the object the frontend expects. Timestamps become epoch
   milliseconds because the existing UI formats them with Date(ms). */
function toAppUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    uid: row.uid,
    name: row.name,
    role: row.role,
    loc: row.loc,
    mustChange: row.must_change_password,
    firstLogin: row.first_login,
    lastLogin: row.last_login_at ? new Date(row.last_login_at).getTime() : null,
    loginCount: row.login_count,
    disabled: row.disabled,
    pending: row.pending === true,
    resetRequestedAt: row.reset_requested_at ? new Date(row.reset_requested_at).getTime() : null,
    createdAt: new Date(row.created_at).getTime(),
    _u: new Date(row.updated_at).getTime()
  };
}

/* The roster every signed-in user may read: enough to render names, initials
   and assignee pickers, and nothing else. No login counts, no lockout state. */
function toRosterUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    uid: row.uid,
    name: row.name,
    role: row.role,
    loc: row.loc,
    _u: new Date(row.updated_at).getTime()
  };
}

/* --------------------------------------------------------------------------
   Normalising + ids
   -------------------------------------------------------------------------- */

function normaliseUid(uid) {
  return String(uid == null ? '' : uid).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function newUserId() {
  return 'U-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

/* First name in lower case, with a number appended if taken — the same rule
   the frontend used, kept so existing login IDs stay predictable. */
function suggestUid(name, takenUids) {
  var base = normaliseUid(String(name).trim().split(/\s+/)[0]) || 'user';
  var uid = base, n = 1;
  var taken = {};
  (takenUids || []).forEach(function (u) { taken[u] = 1; });
  while (taken[uid]) { n++; uid = base + n; }
  return uid;
}

/* --------------------------------------------------------------------------
   Reads (profiles only — never credentials)
   -------------------------------------------------------------------------- */

function findById(id) {
  return db.query('select ' + PROFILE_COLUMNS + ' from app_users where id = $1', [id])
    .then(function (r) { return toAppUser(r.rows[0]); });
}


function listUsers() {
  return db.query('select ' + PROFILE_COLUMNS + ' from app_users order by name asc')
    .then(function (r) { return r.rows.map(toAppUser); });
}

function listRoster() {
  return db.query('select ' + PROFILE_COLUMNS + ' from app_users where disabled = false and pending = false order by name asc')
    .then(function (r) { return r.rows.map(toRosterUser); });
}

function listUids() {
  return db.query('select uid from app_users')
    .then(function (r) { return r.rows.map(function (x) { return x.uid; }); });
}

function uidExists(uid) {
  return db.query('select 1 from app_users where uid = $1', [normaliseUid(uid)])
    .then(function (r) { return r.rowCount > 0; });
}

/* Used to refuse the last remaining admin being demoted or deleted, which
   would lock everyone out of user management permanently. */
function countManagers() {
  return db.query(
    'select count(*)::int as n from app_users where disabled = false and role = any($1)',
    [MANAGER_ROLES]
  ).then(function (r) { return r.rows[0].n; });
}

/* --------------------------------------------------------------------------
   Credentials — authService only
   -------------------------------------------------------------------------- */

/* The single place a password hash is ever read. Returns the profile plus the
   hash and lockout state, for verifying a login. Not exposed by any route. */
function findAuthRecordByUid(uid) {
  var sql =
    'select u.id, u.uid, u.name, u.role, u.loc, u.first_login, u.must_change_password, ' +
    '       u.last_login_at, u.login_count, u.disabled, u.pending, u.created_at, u.created_by, u.updated_at, ' +
    '       c.password_hash, c.failed_attempts, c.locked_until ' +
    '  from app_users u ' +
    '  join app_user_credentials c on c.user_id = u.id ' +
    ' where u.uid = $1';
  return db.query(sql, [normaliseUid(uid)]).then(function (r) {
    var row = r.rows[0];
    if (!row) return null;
    return {
      user: toAppUser(row),
      passwordHash: row.password_hash,
      failedAttempts: row.failed_attempts,
      lockedUntil: row.locked_until
    };
  });
}

function findCredentialById(userId) {
  return db.query('select password_hash from app_user_credentials where user_id = $1', [userId])
    .then(function (r) { return r.rows[0] ? r.rows[0].password_hash : null; });
}

/* Replaces the stored hash. mustChange decides whether the user is sent to the
   "choose your password" screen on next login: false after the user picks
   their own, true after an admin reset. */
function setPasswordHash(userId, passwordHash, mustChange) {
  return db.transaction(function (client) {
    return client.query(
      'update app_user_credentials ' +
      '   set password_hash = $2, password_updated_at = now(), ' +
      '       failed_attempts = 0, locked_until = null ' +
      ' where user_id = $1',
      [userId, passwordHash]
    ).then(function (r) {
      if (r.rowCount === 0) {
        /* Profile exists but has no credential row — repair rather than fail,
           so an account can never become permanently unloggable. */
        return client.query(
          'insert into app_user_credentials (user_id, password_hash) values ($1, $2)',
          [userId, passwordHash]
        );
      }
    }).then(function () {
      return client.query(
        'update app_users set must_change_password = $2, reset_requested_at = null, updated_at = now() ' +
        ' where id = $1 returning ' + PROFILE_COLUMNS,
        [userId, !!mustChange]
      );
    }).then(function (r) { return toAppUser(r.rows[0]); });
  });
}

/* --------------------------------------------------------------------------
   Writes
   -------------------------------------------------------------------------- */

/* Creates the profile and its credential row in one transaction, so a user can
   never exist without a password hash. */
function createUser(fields) {
  var id = fields.id || newUserId();
  var uid = normaliseUid(fields.uid);
  var role = fields.role;
  var loc = ALL_LOCATION_ROLES.indexOf(role) > -1 ? null : (fields.loc || null);

  return db.transaction(function (client) {
    return client.query(
      'insert into app_users (id, uid, name, role, loc, first_login, must_change_password, created_by, pending) ' +
      'values ($1, $2, $3, $4, $5, true, $6, $7, $8) ' +
      'returning ' + PROFILE_COLUMNS,
      [id, uid, String(fields.name).trim(), role, loc,
        fields.mustChange === undefined ? true : !!fields.mustChange,
        fields.createdBy || null,
        !!fields.pending]
    ).then(function (r) {
      return client.query(
        'insert into app_user_credentials (user_id, password_hash) values ($1, $2)',
        [id, fields.passwordHash]
      ).then(function () { return toAppUser(r.rows[0]); });
    });
  });
}

/* Called after a password is verified. This is req 7: no new password record
   is written, only the login bookkeeping is advanced, and first_login flips to
   false the first time through. */
function recordSuccessfulLogin(userId) {
  var sql =
    'update app_users ' +
    '   set last_login_at = now(), ' +
    '       login_count   = login_count + 1, ' +
    '       first_login   = false, ' +
    '       updated_at    = now() ' +
    ' where id = $1 ' +
    ' returning ' + PROFILE_COLUMNS + ', (login_count = 1) as was_first_login';
  return db.query(sql, [userId]).then(function (r) {
    var row = r.rows[0];
    if (!row) return null;
    var user = toAppUser(row);
    user.wasFirstLogin = row.was_first_login;
    return user;
  });
}

/* Counts a wrong password and locks the account once the threshold is hit.
   The interval is built with a bound parameter, not string concatenation. */
function registerFailedAttempt(userId, maxAttempts, lockoutMinutes) {
  var sql =
    'update app_user_credentials ' +
    '   set failed_attempts = failed_attempts + 1, ' +
    '       locked_until = case when failed_attempts + 1 >= $2 ' +
    '                           then now() + make_interval(mins => $3) ' +
    '                           else locked_until end ' +
    ' where user_id = $1 ' +
    ' returning failed_attempts, locked_until';
  return db.query(sql, [userId, maxAttempts, lockoutMinutes])
    .then(function (r) { return r.rows[0] || null; });
}

function clearFailedAttempts(userId) {
  return db.query(
    'update app_user_credentials set failed_attempts = 0, locked_until = null where user_id = $1',
    [userId]
  );
}

function updateProfile(userId, patch) {
  var sets = [], params = [userId], i = 2;

  if (patch.name !== undefined) { sets.push('name = $' + i++); params.push(String(patch.name).trim()); }

  if (patch.role !== undefined) {
    sets.push('role = $' + i++); params.push(patch.role);
    /* A role that sees everything must not stay pinned to one location, and a
       role that does not must not keep a null location. Derive loc from the
       new role unless the caller passed one explicitly. */
    if (ALL_LOCATION_ROLES.indexOf(patch.role) > -1) {
      sets.push('loc = null');
    } else if (patch.loc !== undefined) {
      sets.push('loc = $' + i++); params.push(patch.loc || null);
    }
  } else if (patch.loc !== undefined) {
    sets.push('loc = $' + i++); params.push(patch.loc || null);
  }

  if (patch.disabled !== undefined) { sets.push('disabled = $' + i++); params.push(!!patch.disabled); }

  if (!sets.length) return findById(userId);

  sets.push('updated_at = now()');
  return db.query(
    'update app_users set ' + sets.join(', ') + ' where id = $1 returning ' + PROFILE_COLUMNS,
    params
  ).then(function (r) { return toAppUser(r.rows[0]); });
}

/* Hard delete. Credentials and refresh tokens cascade, so removing someone
   also kills their live sessions. */
/* Admin approval of a self sign-up: clears pending and sets the role and
   location the admin chose. Returns null if the account is not pending, so
   the route can tell "already approved" apart from "approved now". */
/* "Forgot password?" — records that someone has asked for a reset. Returns
   true if a matching active account was found. The route never tells the
   caller which, so the form cannot be used to discover usernames. Pending
   and disabled accounts are ignored: they cannot sign in anyway. */
function requestPasswordReset(uid) {
  return db.query(
    'update app_users set reset_requested_at = now() ' +
    ' where uid = $1 and pending = false and disabled = false returning id',
    [normaliseUid(uid)]
  ).then(function (r) { return r.rowCount > 0; });
}

/* The Super Admin decided no reset was needed. */
function dismissPasswordReset(userId) {
  return db.query(
    'update app_users set reset_requested_at = null where id = $1 and reset_requested_at is not null',
    [userId]
  ).then(function (r) { return r.rowCount > 0; });
}

function approveUser(userId, role, loc) {
  var finalLoc = ALL_LOCATION_ROLES.indexOf(role) > -1 ? null : (loc || null);
  return db.query(
    'update app_users set pending = false, role = $2, loc = $3, updated_at = now() ' +
    ' where id = $1 and pending = true returning ' + PROFILE_COLUMNS,
    [userId, role, finalLoc]
  ).then(function (r) { return toAppUser(r.rows[0]); });
}

/* Makes one account the Super Admin. Server-side only: no route calls this.

   Any existing Super Admin is stepped down to Execution Head first, inside the
   same transaction, because the database's unique index would otherwise refuse
   a second one. Returns { user, previous } where previous is the uid that was
   stepped down, or null. */
function setSuperadmin(uid) {
  var target = normaliseUid(uid);
  return db.transaction(function (client) {
    return client.query(
      'update app_users set role = \'exec\', updated_at = now() ' +
      ' where role = $1 and uid <> $2 returning uid',
      [SUPERADMIN, target]
    ).then(function (demoted) {
      return client.query(
        'update app_users set role = $1, loc = null, pending = false, disabled = false, updated_at = now() ' +
        ' where uid = $2 returning ' + PROFILE_COLUMNS,
        [SUPERADMIN, target]
      ).then(function (r) {
        if (!r.rows[0]) throw new Error('No account with the username "' + target + '"');
        return { user: toAppUser(r.rows[0]), previous: demoted.rows[0] ? demoted.rows[0].uid : null };
      });
    });
  });
}

function deleteUser(userId) {
  return db.query('delete from app_users where id = $1', [userId])
    .then(function (r) { return r.rowCount > 0; });
}

/* --------------------------------------------------------------------------
   Audit
   -------------------------------------------------------------------------- */

function recordLoginAttempt(entry) {
  return db.query(
    'insert into app_login_audit (uid, user_id, success, reason, ip, user_agent) ' +
    'values ($1, $2, $3, $4, $5, $6)',
    [entry.uid || null, entry.userId || null, !!entry.success, entry.reason || null,
      entry.ip || null, String(entry.userAgent || '').slice(0, 300)]
  ).catch(function (err) {
    /* Auditing must never break a login. Log and carry on. */
    console.error('[audit] could not record login attempt:', err.message);
  });
}

module.exports = {
  SUPERADMIN: SUPERADMIN,
  VALID_ROLES: VALID_ROLES,
  ASSIGNABLE_ROLES: ASSIGNABLE_ROLES,
  MANAGER_ROLES: MANAGER_ROLES,
  ALL_LOCATION_ROLES: ALL_LOCATION_ROLES,

  toAppUser: toAppUser,
  toRosterUser: toRosterUser,
  normaliseUid: normaliseUid,
  newUserId: newUserId,
  suggestUid: suggestUid,

  findById: findById,
  listUsers: listUsers,
  listRoster: listRoster,
  listUids: listUids,
  uidExists: uidExists,
  countManagers: countManagers,

  findAuthRecordByUid: findAuthRecordByUid,
  findCredentialById: findCredentialById,
  setPasswordHash: setPasswordHash,

  createUser: createUser,
  recordSuccessfulLogin: recordSuccessfulLogin,
  registerFailedAttempt: registerFailedAttempt,
  clearFailedAttempts: clearFailedAttempts,
  updateProfile: updateProfile,
  approveUser: approveUser,
  requestPasswordReset: requestPasswordReset,
  dismissPasswordReset: dismissPasswordReset,
  setSuperadmin: setSuperadmin,
  deleteUser: deleteUser,
  recordLoginAttempt: recordLoginAttempt
};
