'use strict';
/* ---------------------------------------------------------------------------
   Sets ONE password on every account — everyone signs in with the same word.

     npm run set-all-passwords -- <password>

   Unlike a normal password reset, this does NOT force a change on next
   sign-in: it is meant for quickly handing out access on a test/local
   database, not for production accounts. Every account's failed-attempt
   count and lockout are cleared, and every refresh token is revoked so
   nobody is left signed in under the old password.
   --------------------------------------------------------------------------- */

var db = require('../db/pool');
var userModel = require('../models/userModel');
var passwords = require('../services/passwordService');
var refreshTokens = require('../models/refreshTokenModel');

var plain = process.argv[2];

if (!plain) {
  console.error('\nUsage:  npm run set-all-passwords -- <password>\n');
  process.exit(1);
}

var weak = passwords.validationError(plain);
if (weak) {
  console.error('\n[set-all-passwords] refused: ' + weak + '\n');
  process.exit(1);
}

passwords.hash(plain)
  .then(function (hash) {
    return db.query('select id, uid, name from app_users order by role, uid').then(function (r) {
      return db.transaction(function (client) {
        return client.query(
          'update app_user_credentials set password_hash = $1, password_updated_at = now(), failed_attempts = 0, locked_until = null',
          [hash]
        ).then(function () { return r.rows; });
      });
    });
  })
  .then(function (users) {
    return Promise.all(users.map(function (u) { return refreshTokens.revokeAllForUser(u.id); })).then(function () { return users; });
  })
  .then(function (users) {
    console.log('\n[set-all-passwords] password set on ' + users.length + ' account' + (users.length === 1 ? '' : 's') + ':');
    users.forEach(function (u) { console.log('  ' + u.uid.padEnd(10) + u.name); });
    console.log('\n[set-all-passwords] password: ' + plain);
    console.log('[set-all-passwords] nobody is forced to change it — this is meant for local/test use, not production.\n');
    return db.close();
  })
  .then(function () { process.exit(0); })
  .catch(function (err) {
    console.error('\n[set-all-passwords] failed: ' + err.message + '\n');
    return db.close().then(function () { process.exit(1); }, function () { process.exit(1); });
  });
