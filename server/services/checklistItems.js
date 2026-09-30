'use strict';
/* ---------------------------------------------------------------------------
   The checklist questions (from the "Capiche kitchen opening checklist" form).
   The server keeps its own copy so a submission is judged against the real
   list, and the stored record carries the wording as it was that day.
   Keep in step with CK_FORM in index.html.
   --------------------------------------------------------------------------- */

var SECTIONS = [
  ['General Cleanliness', [
    'Sweep and mop the floor (ensure no spills or hazards)',
    'Clean all surfaces (counters, tables, and workstations)',
    'Check for any food debris or leftover packaging in work areas and garbage bins.']],
  ['Equipment Check', [
    'Turn on all appliances (ovens, grills, fryers, etc.) and check for proper function.',
    'Inspect refrigeration units (ensure proper temperature, check for food safety compliance).',
    'Ensure the dishwasher is working and stocked with detergent.',
    'Check small appliances (microwave, mixers, blenders, etc.).']],
  ['Stock and Inventory', [
    'Check received prep & store purchase according to PO & vegetables order.',
    'Check inventory levels (ensure that essentials are stocked: flour, oil, prep etc.)',
    'Ensure proper storage of ingredients (check refrigerators, freezers, and dry storage areas).',
    'Restock prep areas with necessary ingredients and tools (knives, cutting boards, etc.).',
    'Check produce quality (freshness of fruits and vegetables).']],
  ['Food Safety and Hygiene', [
    'Check expiration dates on perishables and dispose of anything past date.',
    'Verify hand-washing stations are stocked with soap, sanitizer, and paper towels.',
    'Check first aid kits to ensure they are stocked and accessible.']],
  ['Setup for Food Prep', [
    'Organize prep stations with necessary tools (mixing bowls, knives, cutting boards).',
    'Set up workstation-specific items ( sauté pans, etc.) for your cooks.',
    'Thaw any frozen items that need prep (corn,green peas, dough, etc.).',
    'Check upon all the prep, vegetables & store purchase completed']],
  ['Staff Readiness', [
    'Ensure staff uniform compliance (check for clean aprons, gloves, and proper footwear).',
    'Hold a quick team briefing to discuss specials, expected rushes, and any concerns.',
    'Ensure all staff is aware of dietary restrictions and allergies that need to be noted for orders.']],
  ['Waste Management', ['Empty all trash bins and line with fresh bags.']],
  ['Final Walkthrough', ['Perform a final walkaround to ensure everything is clean, organized, and functioning.']]
];

var ITEMS = [];
SECTIONS.forEach(function (s) {
  s[1].forEach(function (q) { ITEMS.push({ section: s[0], question: q }); });
});

/* `answers` must be one boolean per question: true for ticked, false for
   left unticked. A checklist may be sent with items left unticked; the
   record says which. Resolves to the record to store, or an error message. */
function check(answers) {
  if (!Array.isArray(answers) || answers.length !== ITEMS.length) {
    return { error: 'The checklist is out of date. Please reload the page and try again.' };
  }
  for (var i = 0; i < answers.length; i++) {
    if (typeof answers[i] !== 'boolean') return { error: 'The checklist is out of date. Please reload the page and try again.' };
  }
  return { answers: ITEMS.map(function (it, i) {
    return { section: it.section, question: it.question, done: answers[i] };
  }) };
}

module.exports = { SECTIONS: SECTIONS, ITEMS: ITEMS, check: check };
