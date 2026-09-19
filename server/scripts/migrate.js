'use strict';
/* ---------------------------------------------------------------------------
   Applies server/db/schema.sql.

   Run with:  npm run migrate

   Every statement in schema.sql is idempotent, so this is safe to run again
   after a pull. The whole file runs in one transaction: a syntax error part
   way through leaves the database exactly as it was.
   --------------------------------------------------------------------------- */

var fs = require('fs');
var path = require('path');
var db = require('../db/pool');

var schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');

function run() {
  var sql = fs.readFileSync(schemaPath, 'utf8');
  console.log('[migrate] applying ' + schemaPath);

  return db.transaction(function (client) {
    return client.query(sql);
  }).then(function () {
    console.log('[migrate] done — schema.sql applied');
    return verify();
  });
}

/* Reports what ended up in the database, so a successful run is visibly
   successful rather than just silent. */
function verify() {
  return db.query(
    "select table_name from information_schema.tables " +
    " where table_schema = 'public' and (table_name like 'app\\_%' or table_name like 'bk\\_%') order by table_name"
  ).then(function (r) {
    console.log('[migrate] tables present: ' + r.rows.map(function (x) { return x.table_name; }).join(', '));
    return db.query('select count(*)::int as n from app_users');
  }).then(function (r) {
    var n = r.rows[0].n;
    console.log('[migrate] app_users holds ' + n + ' account' + (n === 1 ? '' : 's'));
    if (n === 0) console.log('[migrate] next step: npm run seed  (creates the first admin account)');
  });
}

run()
  .then(function () { return db.close(); })
  .then(function () { process.exit(0); })
  .catch(function (err) {
    console.error('[migrate] FAILED: ' + err.message);
    if (err.position) console.error('[migrate] at character position ' + err.position + ' of schema.sql');
    db.close().then(function () { process.exit(1); }, function () { process.exit(1); });
  });
