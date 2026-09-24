'use strict';
/* ---------------------------------------------------------------------------
   Build step for Vercel (`npm run build`).

   1. Copies index.html into public/. vercel.json publishes public/ and
      nothing else, so server code, the schema and any .env file can never be
      downloaded from the site.

   2. Checks that the security headers in vercel.json match
      server/securityHeaders.js. On Vercel the page is served by the CDN
      without Express, so those headers come from vercel.json; if someone
      edits the CSP in one place and not the other, the build fails here
      instead of the live site quietly running a different policy.
   --------------------------------------------------------------------------- */

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var PUBLIC = path.join(ROOT, 'public');

function fail(msg) {
  console.error('[build] FAILED: ' + msg);
  process.exit(1);
}

var expected = require('../server/securityHeaders').staticPageHeaders();

/* `npm run vercel:headers` — prints the block to paste into vercel.json. */
if (process.argv.indexOf('--print') > -1) {
  console.log(JSON.stringify(Object.keys(expected).map(function (k) { return { key: k, value: expected[k] }; }), null, 2));
  process.exit(0);
}

/* 1 ---------------------------------------------------------------------- */
fs.mkdirSync(PUBLIC, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(PUBLIC, 'index.html'));
console.log('[build] copied index.html -> public/index.html');

/* 2 ---------------------------------------------------------------------- */
var vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
var pageRule = (vercel.headers || []).filter(function (r) { return r.source === '/((?!api/).*)'; })[0];
if (!pageRule) fail('vercel.json has no headers rule for "/((?!api/).*)"');

var actual = {};
pageRule.headers.forEach(function (h) { actual[h.key] = h.value; });

var problems = [];
Object.keys(expected).forEach(function (k) {
  if (actual[k] !== expected[k]) problems.push(k + '\n    expected: ' + expected[k] + '\n    vercel.json: ' + (actual[k] || '(missing)'));
});
if (problems.length) {
  fail('vercel.json headers differ from server/securityHeaders.js:\n  ' + problems.join('\n  ') +
       '\nRun `npm run vercel:headers` to print the correct block.');
}
console.log('[build] vercel.json security headers match server/securityHeaders.js');

/* 3 ----------------------------------------------------------------------
   On Vercel, set the database up as part of every deployment, so nobody has
   to run a database command by hand:

     - migrate   creates any missing tables. Every statement is idempotent,
                 so on an existing database it changes nothing.
     - seed      only when SEED_ADMIN_PASSWORD is set: creates the Super
                 Admin and the starting roster. Accounts that already exist
                 are left alone, so nobody's changed password is ever reset.

   Uses Neon's direct (unpooled) connection when the integration provides
   one, which is what Neon recommends for schema changes. A failure here
   fails the deployment, rather than going live on a half-built database.
   Locally (no VERCEL variable) this step is skipped. */
if (process.env.VERCEL) {
  var spawnSync = require('child_process').spawnSync;
  var env = Object.assign({}, process.env);
  if (env.DATABASE_URL_UNPOOLED) env.DATABASE_URL = env.DATABASE_URL_UNPOOLED;

  if (!env.DATABASE_URL) fail('DATABASE_URL is not set. Add the Neon database under Vercel → Storage and connect it to this project.');

  /* The example connection string is a shape, not an address: its host is
     literally ep-XXXX-pooler.REGION.aws.neon.tech. Pasted into Vercel as-is
     it fails several seconds later as a DNS error, which reads like a
     network fault rather than an unedited placeholder. Name it here. */
  if (/ep-XXXX|REGION\.aws|USER:PASSWORD/.test(env.DATABASE_URL)) {
    fail('DATABASE_URL is still the example from .env.example — its host does not exist.\n' +
      '  Replace it with the real connection string:\n' +
      '    Vercel → Storage → your Neon database → .env.local tab → copy DATABASE_URL\n' +
      '  Connecting the Neon integration sets it for you; delete any DATABASE_URL you typed by hand first,\n' +
      '  because a manually added variable overrides the one the integration provides.');
  }

  var steps = [['migrate', 'server/scripts/migrate.js']];
  if (env.SEED_ADMIN_PASSWORD) steps.push(['seed', 'server/scripts/seed.js']);
  else console.log('[build] SEED_ADMIN_PASSWORD not set — skipping account creation');

  steps.forEach(function (s) {
    console.log('[build] running ' + s[0] + '…');
    var r = spawnSync(process.execPath, [path.join(ROOT, s[1])], { env: env, stdio: 'inherit' });
    if (r.status !== 0) fail(s[0] + ' did not finish (exit ' + r.status + ') — see the lines above.');
  });
}
