'use strict';
/* ---------------------------------------------------------------------------
   Checklist time windows — every case from the spec, run against BOTH copies
   of the logic: the server module and the block inside index.html. If they
   ever disagree, this fails.

   Run with:  npm test
   --------------------------------------------------------------------------- */

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var server = require('../services/checklistWindows');

/* Pull the CHKW block out of index.html and evaluate it on its own. */
function loadFrontend() {
  var html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  var m = /\/\* CHECKLIST-WINDOWS-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* CHECKLIST-WINDOWS-END \*\//.exec(html);
  assert.ok(m, 'CHECKLIST-WINDOWS markers not found in index.html');
  var ctx = {};
  vm.runInNewContext(m[1] + '\nthis.CHKW = CHKW;', ctx);
  return ctx.CHKW;
}
var front = loadFrontend();

/* An instant at a given IST wall-clock time, built WITHOUT the code under
   test: IST is UTC+05:30. */
function ist(ymd, hhmm) {
  var p = ymd.split('-'), t = hhmm.split(':');
  return Date.UTC(+p[0], +p[1] - 1, +p[2], +t[0], +t[1]) - 330 * 60000;
}

var CASES = {
  LUNCH: [
    ['11:29', false], ['11:30', true], ['12:00', true], ['13:29', true], ['13:30', false]
  ],
  DINNER: [
    ['16:59', false], ['17:00', true], ['17:30', true], ['17:59', true], ['18:00', false]
  ],
  CLOSING: [
    ['21:00', false], ['21:59', false], ['22:00', true], ['22:30', true], ['23:00', true],
    ['23:45', true], ['23:59', true], ['00:00', true], ['00:30', true], ['00:59', true], ['01:00', false]
  ]
};

[['server', server], ['index.html', front]].forEach(function (impl) {
  var name = impl[0], W = impl[1];

  Object.keys(CASES).forEach(function (type) {
    test(name + ': ' + type + ' opens and closes on the minute', function () {
      CASES[type].forEach(function (c) {
        var s = W.windowState(W.byType(type), ist('2026-09-30', c[0]));
        assert.strictEqual(s.open, c[1], type + ' at ' + c[0] + ' IST should be ' + (c[1] ? 'open' : 'closed'));
      });
    });
  });

  test(name + ': closing after midnight belongs to the previous day\'s shift', function () {
    var w = W.byType('CLOSING');
    var early = W.windowState(w, ist('2026-10-01', '00:30'));
    assert.strictEqual(early.shiftDate, '2026-09-30');
    assert.strictEqual(early.startsAt, ist('2026-09-30', '22:00'));
    assert.strictEqual(early.endsAt, ist('2026-10-01', '01:00'));
    var late = W.windowState(w, ist('2026-09-30', '23:10'));
    assert.strictEqual(late.shiftDate, '2026-09-30');
  });

  test(name + ': crosses month and year ends', function () {
    var w = W.byType('CLOSING');
    assert.strictEqual(W.windowState(w, ist('2027-01-01', '00:10')).shiftDate, '2026-12-31');
    assert.strictEqual(W.windowState(w, ist('2026-11-01', '00:59')).shiftDate, '2026-10-31');
  });

  test(name + ': next opening time when closed', function () {
    var lunch = W.byType('LUNCH');
    assert.strictEqual(W.windowState(lunch, ist('2026-09-30', '09:00')).nextOpensAt, ist('2026-09-30', '11:30'));
    assert.strictEqual(W.windowState(lunch, ist('2026-09-30', '14:00')).nextOpensAt, ist('2026-10-01', '11:30'));
    assert.strictEqual(W.windowState(W.byType('CLOSING'), ist('2026-09-30', '01:00')).nextOpensAt, ist('2026-09-30', '22:00'));
    assert.strictEqual(W.windowState(lunch, ist('2026-09-30', '12:00')).nextOpensAt, null);
  });

  test(name + ': uses IST regardless of the machine time zone', function () {
    /* 06:00 UTC is 11:30 IST. */
    assert.strictEqual(W.windowState(W.byType('LUNCH'), Date.UTC(2026, 8, 30, 6, 0)).open, true);
    assert.strictEqual(W.windowState(W.byType('LUNCH'), Date.UTC(2026, 8, 30, 5, 59)).open, false);
  });

  test(name + ': labels', function () {
    assert.strictEqual(W.fmtMinutes(690), '11:30 AM');
    assert.strictEqual(W.fmtMinutes(810), '1:30 PM');
    assert.strictEqual(W.fmtMinutes(0), '12:00 AM');
    assert.strictEqual(W.fmtMinutes(720), '12:00 PM');
  });
});

test('server and index.html agree at every minute of a day', function () {
  var base = ist('2026-09-30', '00:00');
  for (var m = 0; m < 1440; m++) {
    var t = base + m * 60000;
    server.WINDOWS.forEach(function (w) {
      var a = server.windowState(w, t), b = front.windowState(front.byType(w.type), t);
      assert.strictEqual(JSON.stringify(b), JSON.stringify(a), w.type + ' differs at minute ' + m);
    });
  }
});
