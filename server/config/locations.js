'use strict';
/* ---------------------------------------------------------------------------
   The eight kitchens, as the backend knows them.

   They are not in the database: the app has always carried them as a literal
   in index.html, and seed.js carried its own copy. That was fine while nothing
   on this side had to check a location, but a job now names the outlets it
   runs at, and those have to be checked against something.

   So the ids live here, once, and both seed.js and the checklist route read
   them. Add a kitchen in index.html, add it here too — the mismatch is caught
   the first time someone tries to use the new one.
   --------------------------------------------------------------------------- */

var LOCATIONS = [
  { id: 'SUR-PREP',    code: 'SPK', head: 'Rahul' },
  { id: 'SUR-CAP-PIP', code: 'CPP', head: 'Amisha' },
  { id: 'SUR-CAP-VES', code: 'CPV', head: 'Rahil' },
  { id: 'SUR-AIKO',    code: 'AKP', head: 'Harish' },
  { id: 'AHM-PREP',    code: 'APK', head: 'Raju' },
  { id: 'AHM-CAP-AMB', code: 'CPA', head: 'Pankaj' },
  { id: 'AHM-CAP-UNI', code: 'CPU', head: 'Atul' },
  { id: 'AHM-AIKO',    code: 'AKA', head: 'Akshay' }
];

var IDS = LOCATIONS.map(function (L) { return L.id; });

function isLocation(id) { return IDS.indexOf(id) > -1; }

module.exports = { LOCATIONS: LOCATIONS, IDS: IDS, isLocation: isLocation };
