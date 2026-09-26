'use strict';
/* ---------------------------------------------------------------------------
   Copies every record from one Postgres to another — for moving hosts, e.g.
   Neon or a local database to Supabase.

   Run from your own computer, never on Vercel:

     npm run copy-db -- --to "postgresql://...:5432/postgres"
     npm run copy-db -- --to "..." --dry-run

   Reads DATABASE_URL from .env as the source. The destination must already
   have the schema; run migrate against it first:

     DATABASE_URL="<destination>" npm run migrate

   Safe to run more than once. Every row is written with "on conflict do
   update", so a second run refreshes rather than duplicates, and nothing in
   the source is changed or deleted.

   Accounts are copied with their password hashes, so everybody signs in with
   the password they already have.
   --------------------------------------------------------------------------- */

var Pool = require('pg').Pool;
var config = require('../config/env');

/* Parents before children: credentials reference a user, audit rows reference
   a checklist row. Copying in this order means no foreign key is ever left
   pointing at something that has not arrived yet. */
var TABLES = [
  { name: 'app_users', key: 'id' },
  { name: 'app_user_credentials', key: 'user_id' },
  { name: 'bk_checklist', key: 'tkey' },
  { name: 'bk_checklist_audit', key: 'id' },
  { name: 'bk_tasks', key: 'id' },
  { name: 'bk_products', key: 'id' }
];

function arg(name) {
  var i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : null;
}
var DRY = process.argv.indexOf('--dry-run') > -1;
var TO = arg('to');

if (!TO) {
  console.error('Usage: npm run copy-db -- --to "<destination connection string>" [--dry-run]\n' +
    '  The source is DATABASE_URL from .env.\n' +
    '  Run migrate against the destination first so the tables exist.');
  process.exit(1);
}

var src = new Pool({ connectionString: config.db.connectionString, ssl: config.db.ssl, max: 2 });
/* The destination is given on the command line, so its TLS setting comes
   from the string itself rather than from DATABASE_SSL, which describes the
   source. A database on this machine has no TLS to speak of; a hosted one
   always does. */
function destinationSsl(url) {
  if (/sslmode=disable/.test(url)) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) return false;
  return { rejectUnauthorized: false };
}
var dst = new Pool({ connectionString: TO, ssl: destinationSsl(TO), max: 2 });

function columnsOf(pool, table) {
  return pool.query(
    'select column_name from information_schema.columns' +
    " where table_schema = 'public' and table_name = $1 order by ordinal_position", [table]
  ).then(function (r) { return r.rows.map(function (x) { return x.column_name; }); });
}

function copy(t) {
  return Promise.all([columnsOf(src, t.name), columnsOf(dst, t.name)]).then(function (cols) {
    var from = cols[0], to = cols[1];
    if (!from.length) { console.log('  ' + t.name + ': not in the source — skipped'); return; }
    if (!to.length) {
      throw new Error(t.name + ' does not exist in the destination. Run migrate against it first:\n' +
        '    DATABASE_URL="<destination>" npm run migrate');
    }
    /* Only the columns both sides have, so a destination built from a newer
       or older schema still takes what it can rather than failing outright. */
    var shared = from.filter(function (c) { return to.indexOf(c) > -1; });
    var dropped = from.filter(function (c) { return to.indexOf(c) === -1; });

    return src.query('select ' + shared.join(', ') + ' from ' + t.name).then(function (r) {
      var note = '  ' + t.name + ': ' + r.rows.length + ' row' + (r.rows.length === 1 ? '' : 's');
      if (dropped.length) note += '  (destination has no ' + dropped.join(', ') + ')';
      if (DRY || !r.rows.length) { console.log(note + (DRY ? '  — dry run, nothing written' : '')); return; }

      var updates = shared.filter(function (c) { return c !== t.key; })
        .map(function (c) { return c + ' = excluded.' + c; });
      var sql = 'insert into ' + t.name + ' (' + shared.join(', ') + ') values (' +
        shared.map(function (_, i) { return '$' + (i + 1); }).join(', ') + ') ' +
        'on conflict (' + t.key + ') do update set ' + updates.join(', ');

      /* One row at a time on purpose: a failure names the row it choked on,
         which is worth more than speed for a move you do once. */
      return r.rows.reduce(function (chain, row) {
        return chain.then(function () {
          return dst.query(sql, shared.map(function (c) { return row[c]; }));
        });
      }, Promise.resolve()).then(function () { console.log(note + '  copied'); });
    });
  });
}

console.log('[copy-db] from ' + config.db.connectionString.replace(/:\/\/[^@]*@/, '://***@'));
console.log('[copy-db] to   ' + TO.replace(/:\/\/[^@]*@/, '://***@'));
if (DRY) console.log('[copy-db] dry run — counting only, nothing is written\n');
else console.log('');

TABLES.reduce(function (chain, t) { return chain.then(function () { return copy(t); }); }, Promise.resolve())
  .then(function () {
    console.log('\n[copy-db] done' + (DRY ? ' (dry run)' : '') + '. Nothing in the source was changed.');
    return Promise.all([src.end(), dst.end()]);
  })
  .then(function () { process.exit(0); })
  .catch(function (err) {
    console.error('\n[copy-db] FAILED: ' + err.message);
    Promise.all([src.end(), dst.end()]).then(function () { process.exit(1); }, function () { process.exit(1); });
  });
