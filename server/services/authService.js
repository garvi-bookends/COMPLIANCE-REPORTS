'use strict';
/* ---------------------------------------------------------------------------
   Authentication logic (reqs 4, 5, 6, 7).

   All of the decision-making lives here rather than in the routes, so the
   rules are in one readable place and the routes stay thin.

   The single most important rule in this file: every way a login can fail
   returns the SAME message, "Invalid username or password." A message that
   distinguishes "no such user" from "wrong password" tells an attacker which
   usernames are real, which is half the work of breaking in.
   --------------------------------------------------------------------------- */

var userModel = require('../models/userModel');
var refreshTokens = require('../models/refreshTokenModel');
var passwords = require('../services/passwordService');
var tokens = require('../services/tokenService');
var config = require('../config/env');

var GENERIC_LOGIN_ERROR = 'Invalid username or password.';

function authError(message, code, status) {
  var err = new Error(message);
  err.status = status || 401;
  err.code = code || 'UNAUTHORIZED';
  err.expected = true;      // errorHandler logs these quietly — they are not bugs
  return err;
}

/* --------------------------------------------------------------------------
   Login
   -------------------------------------------------------------------------- */

/* Verifies credentials and, on success, advances the login bookkeeping and
   mints a session. ctx carries { ip, userAgent } for the audit trail.

   Returns { user, accessToken, refreshToken, expiresIn }. */
function login(rawUid, rawPassword, ctx) {
  var uid = userModel.normaliseUid(rawUid);
  var password = String(rawPassword == null ? '' : rawPassword);

  if (!uid || !password) {
    return Promise.reject(authError('Enter your ID and password', 'MISSING_CREDENTIALS', 400));
  }

  return userModel.findAuthRecordByUid(uid).then(function (record) {
    /* Step 1: does the username exist? (req 4)
       When it does not we still run one bcrypt comparison against a dummy
       hash, so a missing account and a wrong password take the same time and
       usernames cannot be enumerated by timing the response. */
    if (!record) {
      return passwords.burnTime().then(function () {
        userModel.recordLoginAttempt({ uid: uid, success: false, reason: 'no_such_user', ip: ctx.ip, userAgent: ctx.userAgent });
        throw authError(GENERIC_LOGIN_ERROR, 'INVALID_CREDENTIALS');
      });
    }

    var user = record.user;

    /* A disabled account gets the generic message too — no reason to confirm
       to an outsider that the account exists at all. */
    if (user.disabled) {
      userModel.recordLoginAttempt({ uid: uid, userId: user.id, success: false, reason: 'disabled', ip: ctx.ip, userAgent: ctx.userAgent });
      throw authError(GENERIC_LOGIN_ERROR, 'INVALID_CREDENTIALS');
    }

    /* Locked out after too many wrong guesses. This one IS specific, because
       the user needs to know waiting will fix it, and it only ever appears
       after the account has already been identified by repeated attempts. */
    if (record.lockedUntil && new Date(record.lockedUntil).getTime() > Date.now()) {
      var minutes = Math.max(1, Math.ceil((new Date(record.lockedUntil).getTime() - Date.now()) / 60000));
      userModel.recordLoginAttempt({ uid: uid, userId: user.id, success: false, reason: 'locked', ip: ctx.ip, userAgent: ctx.userAgent });
      throw authError(
        'Too many failed attempts. Try again in ' + minutes + ' minute' + (minutes === 1 ? '' : 's') +
        ', or ask Husen, Manish or Rutvik to reset your password.',
        'ACCOUNT_LOCKED', 423
      );
    }

    /* Step 2: verify the password against the stored hash (req 4).
       The plaintext is never stored, logged or compared with ===. */
    return passwords.verify(password, record.passwordHash).then(function (ok) {
      if (!ok) {
        return userModel.registerFailedAttempt(user.id, config.lockout.maxFailedAttempts, config.lockout.lockoutMinutes)
          .then(function () {
            userModel.recordLoginAttempt({ uid: uid, userId: user.id, success: false, reason: 'bad_password', ip: ctx.ip, userAgent: ctx.userAgent });
            throw authError(GENERIC_LOGIN_ERROR, 'INVALID_CREDENTIALS');
          });
      }

      /* A self sign-up that no admin has approved yet.

         Checked only AFTER the password is verified, so the "waiting for
         approval" message goes only to the person who owns the account. Anyone
         guessing still gets the generic error, and learns nothing about which
         usernames exist. */
      if (user.pending) {
        return userModel.clearFailedAttempts(user.id).then(function () {
          userModel.recordLoginAttempt({ uid: uid, userId: user.id, success: false, reason: 'pending', ip: ctx.ip, userAgent: ctx.userAgent });
          throw authError(
            'Your account is waiting for approval by the Super Admin (Husen). You can sign in once it is approved.',
            'ACCOUNT_PENDING', 403
          );
        });
      }

      /* Step 3: success.

         req 7 — this is a second or later login. Note what does NOT happen
         here: no password is written, no new credential row is created. The
         existing hash is left exactly as it is; only last_login_at,
         login_count and first_login are updated. */
      return userModel.clearFailedAttempts(user.id)
        .then(function () { return userModel.recordSuccessfulLogin(user.id); })
        .then(function (freshUser) {
          userModel.recordLoginAttempt({ uid: uid, userId: user.id, success: true, reason: null, ip: ctx.ip, userAgent: ctx.userAgent });
          return issueSession(freshUser, ctx);
        });
    });
  });
}

/* --------------------------------------------------------------------------
   Session issuing / refresh / logout
   -------------------------------------------------------------------------- */

function issueSession(user, ctx) {
  var accessToken = tokens.signAccessToken(user);
  var refreshToken = tokens.newRefreshToken();
  var expiresAt = tokens.refreshTokenExpiry();

  return refreshTokens.issue(user.id, refreshToken, expiresAt, ctx).then(function () {
    return {
      user: user,
      accessToken: accessToken,
      refreshToken: refreshToken,
      expiresIn: tokens.accessTokenTtlSeconds()
    };
  });
}

/* Exchanges a refresh token for a new access token, and rotates the refresh
   token at the same time.

   Rotation matters: the presented token is revoked and replaced, so a token
   captured earlier stops working the moment the real client refreshes. */
function refresh(rawToken, ctx) {
  if (!rawToken) return Promise.reject(authError('Not signed in', 'NO_SESSION'));

  return refreshTokens.findActive(rawToken).then(function (row) {
    if (!row) throw authError('Your session has expired. Please sign in again.', 'SESSION_EXPIRED');

    return userModel.findById(row.user_id).then(function (user) {
      if (!user || user.disabled) {
        return refreshTokens.revoke(rawToken).then(function () {
          throw authError('Your session has expired. Please sign in again.', 'SESSION_EXPIRED');
        });
      }
      return refreshTokens.revoke(rawToken).then(function () {
        return issueSession(user, ctx);
      });
    });
  });
}

function logout(rawToken) {
  if (!rawToken) return Promise.resolve(false);
  return refreshTokens.revoke(rawToken);
}

/* --------------------------------------------------------------------------
   Password changes
   -------------------------------------------------------------------------- */

/* The user choosing their own password.

   When the account is still on the admin-issued password (mustChange), the
   current password is not demanded again — the user has just proved it by
   signing in, and the old forced-change screen never asked for it. Otherwise
   the current password is required, so a hijacked access token alone cannot
   be used to take the account over permanently. */
function changePassword(userId, currentPassword, newPassword) {
  return userModel.findById(userId).then(function (user) {
    if (!user) throw authError('Account not found', 'NOT_FOUND', 404);

    var validation = passwords.validationError(newPassword);
    if (validation) throw Object.assign(new Error(validation), { status: 400, code: 'WEAK_PASSWORD', expected: true });

    var mustVerifyCurrent = !user.mustChange;

    return Promise.resolve().then(function () {
      if (!mustVerifyCurrent) return true;
      if (!currentPassword) {
        throw Object.assign(new Error('Enter your current password'), { status: 400, code: 'MISSING_CURRENT_PASSWORD', expected: true });
      }
      return userModel.findCredentialById(userId).then(function (storedHash) {
        return passwords.verify(currentPassword, storedHash);
      }).then(function (ok) {
        if (!ok) throw authError('Your current password is not right', 'INVALID_CREDENTIALS', 400);
        return true;
      });
    })
      .then(function () { return passwords.hash(newPassword); })
      .then(function (newHash) { return userModel.setPasswordHash(userId, newHash, false); })
      .then(function (updated) {
        /* Every other device is signed out. If the old password was the reason
           for the change, sessions built on it must not survive it. */
        return refreshTokens.revokeAllForUser(userId).then(function () { return updated; });
      });
  });
}

/* Admin resetting someone's forgotten password back to the shared starting
   password. Returns the plaintext to display once so the admin can pass it
   on — it is never stored in that form. */
function resetPassword(targetUserId, newPassword) {
  var plain = newPassword || config.password.defaultPassword;
  return passwords.hash(plain)
    .then(function (hash) { return userModel.setPasswordHash(targetUserId, hash, true); })
    .then(function (updated) {
      if (!updated) throw authError('Account not found', 'NOT_FOUND', 404);
      return refreshTokens.revokeAllForUser(targetUserId).then(function () {
        return { user: updated, password: plain };
      });
    });
}

/* --------------------------------------------------------------------------
   Self sign-up
   -------------------------------------------------------------------------- */

/* A person creates their own account, choosing their own username and
   password.

   What they do NOT get to choose is their power. The account is created as
   `staff`, and pending: it cannot sign in at all until an admin approves it
   and sets the real role and kitchen. Without that step anyone who can reach
   the login page could give themselves access to a kitchen's records.

   Because they chose the password themselves, they are not forced to change
   it on first sign-in. */
function register(fields) {
  var weak = passwords.validationError(fields.password);
  if (weak) {
    return Promise.reject(Object.assign(new Error(weak), { status: 400, code: 'WEAK_PASSWORD', expected: true }));
  }

  return userModel.uidExists(fields.uid).then(function (exists) {
    if (exists) {
      throw Object.assign(new Error('The username "' + fields.uid + '" is already taken — choose another.'),
        { status: 409, code: 'UID_TAKEN', expected: true });
    }
    return passwords.hash(fields.password);
  }).then(function (hash) {
    return userModel.createUser({
      uid: fields.uid,
      name: fields.name,
      role: 'staff',
      loc: fields.loc || null,
      passwordHash: hash,
      mustChange: false,
      pending: true,
      createdBy: 'self'
    });
  });
}

module.exports = {
  GENERIC_LOGIN_ERROR: GENERIC_LOGIN_ERROR,
  login: login,
  register: register,
  refresh: refresh,
  logout: logout,
  issueSession: issueSession,
  changePassword: changePassword,
  resetPassword: resetPassword
};
