'use strict';
/* ---------------------------------------------------------------------------
   Postgres connection pool.

   One pool for the whole process. Every query goes through query() so that
   slow statements are visible in the log and parameters are always bound
   (never string-concatenated into SQL).
   --------------------------------------------------------------------------- */

var Pool = require('pg').Pool;
var config = require('../config/env');

var pool = new Pool({
  connectionString: config.db.connectionString,
  ssl: config.db.ssl,
  max: config.db.max,
  /* On Vercel an instance can be frozen between requests. A short idle
     timeout means connections are handed back to Neon's pooler quickly
     instead of sitting open on a sleeping instance. */
  idleTimeoutMillis: config.onVercel ? 5000 : 30000,
  connectionTimeoutMillis: 10000
});

/* An idle client dying (a pooler recycling the connection, for example) must
   not take the process down with it. */
pool.on('error', function (err) {
  console.error('[db] idle client error:', err.message);
});

/* Lets Vercel's Fluid compute close idle clients before it suspends an
   instance, so a burst of cold starts cannot leak connections. */
if (config.onVercel) {
  require('@vercel/functions').attachDatabasePool(pool);
}

function query(text, params) {
  var started = Date.now();
  return pool.query(text, params).then(function (res) {
    var ms = Date.now() - started;
    if (ms > 500) console.warn('[db] slow query ' + ms + 'ms: ' + text.split('\n')[0].trim());
    return res;
  });
}

/* Runs fn inside a transaction, rolling back on any rejection. Used where a
   write has to be all-or-nothing, e.g. creating a profile and its
   credentials together. */
function transaction(fn) {
  return pool.connect().then(function (client) {
    return client.query('BEGIN')
      .then(function () { return fn(client); })
      .then(function (result) {
        return client.query('COMMIT').then(function () { return result; });
      })
      .catch(function (err) {
        return client.query('ROLLBACK').then(function () { throw err; }, function () { throw err; });
      })
      .then(
        function (r) { client.release(); return r; },
        function (e) { client.release(); throw e; }
      );
  });
}

function close() { return pool.end(); }

module.exports = { pool: pool, query: query, transaction: transaction, close: close };
