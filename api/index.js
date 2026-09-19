'use strict';
/* ---------------------------------------------------------------------------
   Vercel entry point.

   vercel.json rewrites every /api/* request here. The Express app handles
   them exactly as it does locally; it is simply never told to listen(),
   because Vercel owns the HTTP server. Timers and process handlers live in
   server/server.js and do not run on Vercel — the daily cron at
   /api/cron/cleanup covers the cleanup instead.
   --------------------------------------------------------------------------- */

module.exports = require('../server/app');
