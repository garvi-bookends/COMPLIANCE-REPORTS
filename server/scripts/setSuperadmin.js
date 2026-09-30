'use strict';
/* ---------------------------------------------------------------------------
   Makes one account the Super Admin.

     npm run set-superadmin -- husen

   The Super Admin approves every self sign-up, so the role is deliberately
   NOT something the app can hand out: no form offers it, and the API refuses
   it. The only way to set it is from a terminal on the server, here.

   If someone else is already Super Admin they are stepped down to Execution
   Head in the same transaction. The database's unique index guarantees there
   is never more than one.

   Their existing sessions keep the old role until their access token next
   refreshes (at most 15 minutes), or at once if they reload the app.
   --------------------------------------------------------------------------- */

var db = require('../db/pool');
var userModel = require('../models/userModel');

var uid = (process.argv[2] || '').trim();

if (!uid) {
  console.error('\nUsage:  npm run set-superadmin -- <username>\n');
  console.error('Example: npm run set-superadmin -- husen\n');
  process.exit(1);
}

userModel.setSuperadmin(uid)
  .then(function (result) {
    console.log('\n[superadmin] ' + result.user.uid + ' (' + result.user.name + ') is now the Super Admin');
    if (result.previous) {
      console.log('[superadmin] ' + result.previous + ' was stepped down to Execution Head');
    }
    console.log('[superadmin] only this account can approve or reject new sign-ups.\n');
    return db.close();
  })
  .then(function () { process.exit(0); })
  .catch(function (err) {
    console.error('\n[superadmin] FAILED: ' + err.message + '\n');
    db.close().then(function () { process.exit(1); }, function () { process.exit(1); });
  });
