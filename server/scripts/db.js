'use strict';
/* ---------------------------------------------------------------------------
   Start / stop / status for the local PostgreSQL instance.

     npm run db:start
     npm run db:stop
     npm run db:status
     npm run db:restart

   Why a Node wrapper rather than putting pg_ctl straight into package.json:
   on Windows npm runs scripts through cmd.exe, which treats the forward
   slashes in "C:/Program Files/..." as switches and mangles backslashes in
   JSON. Spawning the process directly sidesteps shell quoting completely, and
   the same script works on macOS and Linux.

   Paths come from the environment so nothing is hardcoded:
     PG_BIN  - the PostgreSQL bin directory (default: the PG18 Windows path)
     PGDATA  - the data directory           (default: ~/bookends-pgdata)
   The port is read from DATABASE_URL, so it cannot drift out of step with
   what the app actually connects to.
   --------------------------------------------------------------------------- */

require('dotenv').config();

var path = require('path');
var fs = require('fs');
var os = require('os');
var spawnSync = require('child_process').spawnSync;

var ACTIONS = ['start', 'stop', 'status', 'restart'];
var action = (process.argv[2] || '').toLowerCase();

if (ACTIONS.indexOf(action) === -1) {
  console.error('Usage: node server/scripts/db.js <' + ACTIONS.join('|') + '>');
  process.exit(1);
}

var PG_BIN = process.env.PG_BIN ||
  (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\18\\bin' : '/usr/bin');

var PGDATA = process.env.PGDATA || path.join(os.homedir(), 'bookends-pgdata');

var pgCtl = path.join(PG_BIN, 'pg_ctl' + (process.platform === 'win32' ? '.exe' : ''));

/* The port the app is configured to use — one source of truth. */
function portFromDatabaseUrl() {
  var url = process.env.DATABASE_URL || '';
  var m = /:(\d{2,5})\//.exec(url);
  return m ? m[1] : '5432';
}

if (!fs.existsSync(pgCtl)) {
  console.error('pg_ctl not found at ' + pgCtl);
  console.error('Set PG_BIN in .env to your PostgreSQL bin directory.');
  process.exit(1);
}

if (!fs.existsSync(path.join(PGDATA, 'PG_VERSION'))) {
  console.error('No PostgreSQL data directory at ' + PGDATA);
  console.error('Set PGDATA in .env, or see SETUP.md section 2.2 to create one.');
  process.exit(1);
}

var args = ['-D', PGDATA];

if (action === 'start' || action === 'restart') {
  args.push('-l', path.join(PGDATA, 'server.log'));
  args.push('-o', '-p ' + portFromDatabaseUrl());
}
/* Shutdown mode "fast" for both stop and restart.

   pg_ctl defaults to "smart", which waits for every client to disconnect —
   and the backend keeps a connection pool open, so a smart stop hangs until
   you also stop the app. "fast" disconnects clients and rolls back their open
   transactions, but still checkpoints properly on the way out, so it is a
   clean shutdown rather than the crash-recovery that "immediate" causes. */
if (action === 'stop' || action === 'restart') args.push('-m', 'fast');
args.push(action);

console.log('[db] ' + action + '  (data: ' + PGDATA + ', port: ' + portFromDatabaseUrl() + ')');

/* stdio must NOT be inherited for start/restart.

   pg_ctl launches the postgres server as a detached child, and on Windows
   that child inherits whatever handles we pass it. Inheriting our stdout
   means the pipe stays open for as long as the database runs, so spawnSync
   never returns and `npm run db:start` appears to hang forever. The server's
   own output already goes to -l server.log, so discarding it here loses
   nothing. `stop` and `status` are short-lived and can report normally. */
var starts = (action === 'start' || action === 'restart');

var r = spawnSync(pgCtl, args, starts
  ? { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  : { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, encoding: 'utf8' });

if (r.error) {
  console.error('[db] could not run pg_ctl: ' + r.error.message);
  process.exit(1);
}

if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr && r.stderr.length) process.stderr.write(r.stderr.toString());

/* `pg_ctl status` exits 3 when the server is simply not running. That is an
   answer, not a failure, so report it plainly rather than as an error. */
if (action === 'status' && r.status === 3) {
  console.log('[db] not running — start it with: npm run db:start');
  process.exit(0);
}

/* start/restart produced no stdout (deliberately), so say what happened. */
if (starts && r.status === 0) {
  console.log('[db] server ' + (action === 'start' ? 'started' : 'restarted') +
    ' — log: ' + path.join(PGDATA, 'server.log'));
}

process.exit(r.status === null ? 1 : r.status);
