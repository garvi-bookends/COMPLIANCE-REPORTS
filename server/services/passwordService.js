'use strict';
/* ---------------------------------------------------------------------------
   Password hashing (req 3).

   bcrypt via bcryptjs. bcryptjs is the pure-JavaScript implementation of the
   same algorithm as the native `bcrypt` package — identical hash format and
   identical security properties, but no C++ toolchain needed, which matters
   on Windows. Swapping to native `bcrypt` later is a one-line require change;
   existing hashes stay valid because the format is the same.

   Cost 12 is the default (BCRYPT_ROUNDS). Each +1 doubles the work an
   attacker must do per guess.
   --------------------------------------------------------------------------- */

var bcrypt = require('bcryptjs');
var config = require('../config/env');

/* bcrypt silently truncates input at 72 bytes. Rejecting longer input is
   better than accepting a password whose tail is ignored. */
var MAX_PASSWORD_BYTES = 72;

/* Hashes a password.

   This checks only that the input CAN be hashed safely — not whether it is a
   good password. Strength is product policy and lives in validationError(),
   which callers apply where a password is chosen. Keeping the two apart
   matters: the admin-issued starting password deliberately fails the strength
   policy, and it still has to be hashable. */
function hash(plainPassword) {
  return Promise.resolve().then(function () {
    var err = hashabilityError(plainPassword);
    if (err) throw Object.assign(new Error(err), { status: 400, code: 'WEAK_PASSWORD', expected: true });
    return bcrypt.hash(String(plainPassword), config.password.bcryptRounds);
  });
}

/* The only two things that make a password impossible to store correctly:
   nothing to hash, or input past the point bcrypt silently truncates. */
function hashabilityError(plainPassword) {
  var pw = String(plainPassword == null ? '' : plainPassword);
  if (!pw) return 'Enter a password';
  if (Buffer.byteLength(pw, 'utf8') > MAX_PASSWORD_BYTES) {
    return 'Password is too long (maximum ' + MAX_PASSWORD_BYTES + ' bytes)';
  }
  return null;
}

/* Returns true only for the right password. Wrapped so a malformed stored
   hash cannot throw into a route and turn a failed login into a 500. */
function verify(plainPassword, storedHash) {
  return Promise.resolve().then(function () {
    if (!plainPassword || !storedHash) return false;
    return bcrypt.compare(String(plainPassword), String(storedHash));
  }).catch(function (err) {
    console.error('[password] compare failed:', err.message);
    return false;
  });
}

/* The strength policy for a password somebody CHOOSES.

   Applied by authService.changePassword and by the admin routes when an admin
   supplies a custom password. Deliberately NOT applied by hash(), so the
   force-changed starting password can still be stored.

   Mirrors the rules the old client-side savePw() enforced, so the UI copy in
   index.html stays accurate. */
function validationError(plainPassword) {
  var pw = String(plainPassword == null ? '' : plainPassword);
  var unhashable = hashabilityError(pw);
  if (unhashable) return unhashable;
  /* Spaces are allowed inside a password, but one made only of them is not
     a password — it is an empty one that happens to be long enough. */
  if (!pw.trim().length) return 'Enter a password';
  if (pw.length < config.password.minLength) {
    return 'Password must be at least ' + config.password.minLength + ' characters';
  }
  if (pw === config.password.defaultPassword) {
    return 'Please choose something other than ' + config.password.defaultPassword;
  }
  return null;
}

/* A dummy hash of a throwaway value, computed once at startup.

   Login compares against this when the username does not exist, so that a
   missing user and a wrong password take the same amount of time. Without it,
   an attacker can enumerate valid usernames just by timing the response. */
var DUMMY_HASH = bcrypt.hashSync('not-a-real-password-' + Date.now(), config.password.bcryptRounds);

function burnTime() {
  return verify('not-a-real-password', DUMMY_HASH).then(function () { return false; });
}

module.exports = {
  hash: hash,
  verify: verify,
  validationError: validationError,
  hashabilityError: hashabilityError,
  burnTime: burnTime,
  defaultPassword: config.password.defaultPassword,
  minLength: config.password.minLength
};
