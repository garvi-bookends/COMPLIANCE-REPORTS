'use strict';
/* ---------------------------------------------------------------------------
   Creates one user from the command line.

   The admin API is the normal way to add people (req 1). This script exists
   for the case the API cannot cover: bootstrapping, or getting back in when
   every admin account has been locked out.

   Usage:
     npm run create-user -- --name "Suresh Patel" --role staff --loc SUR-PREP
     npm run create-user -- --name "Priya" --role admin --password "a real one"
     npm run create-user -- --name "Amit" --uid amitk --role manager --loc AHM-AIKO

   Options:
     --name      required
     --role      exec | aexec | admin | hok | manager | staff | auditor  (default staff)
     --loc       location id; ignored for roles that see all locations
     --uid       login ID; derived from the first name when omitted
     --password  initial password; DEFAULT_PASSWORD when omitted
   --------------------------------------------------------------------------- */

var db = require('../db/pool');
var config = require('../config/env');
var userModel = require('../models/userModel');
var passwords = require('../services/passwordService');

function parseArgs(argv) {
  var out = {};
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a.indexOf('--') !== 0) continue;
    var key = a.slice(2);
    var next = argv[i + 1];
    if (next === undefined || next.indexOf('--') === 0) { out[key] = true; }
    else { out[key] = next; i++; }
  }
  return out;
}

function usage(message) {
  if (message) console.error('\nError: ' + message);
  console.error('\nUsage:');
  console.error('  npm run create-user -- --name "Suresh Patel" --role staff --loc SUR-PREP');
  console.error('\nRoles: ' + userModel.ASSIGNABLE_ROLES.join(', '));
  console.error('Roles that see every location (no --loc needed): ' + userModel.ALL_LOCATION_ROLES.join(', ') + '\n');
  process.exit(1);
}

var args = parseArgs(process.argv.slice(2));

if (args.help || args.h) usage();

var name = typeof args.name === 'string' ? args.name.trim() : '';
if (!name) usage('--name is required');

var role = typeof args.role === 'string' ? args.role.trim() : 'staff';
if (userModel.ASSIGNABLE_ROLES.indexOf(role) === -1) usage('unknown role "' + role + '"');

var loc = typeof args.loc === 'string' ? args.loc.trim() : null;
var needsLoc = userModel.ALL_LOCATION_ROLES.indexOf(role) === -1;
if (needsLoc && !loc) usage('role "' + role + '" is tied to one kitchen — pass --loc');

var plainPassword = typeof args.password === 'string' ? args.password : config.password.defaultPassword;
if (typeof args.password === 'string') {
  var weak = passwords.validationError(args.password);
  if (weak) usage(weak);
}

/* A password given on the command line ends up in the shell history. Warn
   rather than refuse — sometimes it is the right trade. */
if (typeof args.password === 'string') {
  console.warn('[create-user] note: a password passed as an argument is recorded in your shell history.');
}

Promise.resolve()
  .then(function () {
    if (typeof args.uid === 'string' && args.uid.trim()) {
      return userModel.normaliseUid(args.uid);
    }
    return userModel.listUids().then(function (taken) {
      return userModel.suggestUid(name, taken);
    });
  })
  .then(function (uid) {
    if (uid.length < 2) throw new Error('could not derive a usable login ID from "' + name + '" — pass --uid');

    return userModel.uidExists(uid).then(function (exists) {
      if (exists) throw new Error('the login ID "' + uid + '" is already taken');

      return passwords.hash(plainPassword).then(function (hash) {
        return userModel.createUser({
          uid: uid,
          name: name,
          role: role,
          loc: needsLoc ? loc : null,
          passwordHash: hash,
          mustChange: true,
          createdBy: 'cli'
        });
      });
    });
  })
  .then(function (user) {
    console.log('\n[create-user] created');
    console.log('  name       : ' + user.name);
    console.log('  login ID   : ' + user.uid);
    console.log('  password   : ' + plainPassword);
    console.log('  role       : ' + user.role);
    console.log('  location   : ' + (user.loc || 'all locations'));
    console.log('\n  They will be asked to choose their own password on first sign-in.\n');
    return db.close();
  })
  .then(function () { process.exit(0); })
  .catch(function (err) {
    console.error('\n[create-user] FAILED: ' + err.message + '\n');
    db.close().then(function () { process.exit(1); }, function () { process.exit(1); });
  });
