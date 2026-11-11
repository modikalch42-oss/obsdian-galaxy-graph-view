/* Test vaults. "student" is a typical small vault: a Home note, six subject MOCs and about 75 notes. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function student() {
  const files = [], links = {}, unresolved = {};
  const add = (path, extra) => { files.push(Object.assign({ path }, extra)); links[path] = links[path] || []; return path; };
  const link = (a, b) => { (links[a] = links[a] || []).push(b); };
  const home = add('Home.md');
  const subjects = {
    'Philosophy': ["Plato's Cave", 'Ethical Thinkers', 'The Five Precepts', 'Absolute and Relative Ethics', 'Situation Ethics',
      'Cosmological Argument', 'Introduction to Ethics', 'Euthanasia', 'Aristotle',
      'An essay with a very long title that has to wrap onto a second line under its note', 'Theory of Forms', 'Concepts of God',
      'Theory of reality summary', "Leibniz' Cosmological Argument", 'Teleological Argument', 'Natural Law',
      'Sanctity and Quality of Life', 'Situation Ethics on Euthanasia', 'Philosophy of Religion',
      'Teleological Argument (Modern Versions)', 'Hume on Causation', 'Kantian Ethics', 'Utilitarianism',
      'Ontological Argument', 'Religious Experience', 'Problem of Evil'],
    'Politics': ['Case Studies and Acts', 'Example', 'Principles of the Constitution',
      'Example Paragraphs', 'Devolution plan', 'Devolution essay', 'Threats to Democracy', 'The End of History',
      'Mill on Liberty', 'Parliamentary Sovereignty', 'Pressure Groups', 'Electoral Systems'],
    'History': ['Impacts of the War', 'Westward Expansion', 'Declaration of Independence',
      'Articles of Confederation', 'Civil Rights Movement', 'Crash Course', 'How political identity formed', 'Reconstruction'],
    'Economics': ['Definitions (Macro)', 'Introduction to Economics', 'Market Failure', 'Elasticity', 'Fiscal Policy', 'Externalities'],
    'Maths': ['Year 1 textbook', 'Proof by Induction'],
    'Admin': ['Essay Competitions', 'Project question research', 'Timetable'],
  };
  const P = {};
  for (const subj in subjects) {
    const moc = add(`${subj}/${subj} MOC.md`);
    link(home, moc);
    link(moc, home);
    for (const n of subjects[subj]) { P[n] = add(`${subj}/${n}.md`); link(moc, P[n]); }
  }
  // links between notes, as in a real vault
  const L = (a, ...bs) => bs.forEach((b) => link(P[a], P[b]));
  L('Philosophy of Religion', 'Cosmological Argument', 'Teleological Argument', 'Ontological Argument', 'Concepts of God', 'Religious Experience', 'Problem of Evil');
  L('Introduction to Ethics', 'Natural Law', 'Situation Ethics', 'Absolute and Relative Ethics', 'Kantian Ethics', 'Utilitarianism');
  L('Situation Ethics on Euthanasia', 'Situation Ethics', 'Euthanasia');
  L('Euthanasia', 'Sanctity and Quality of Life', 'Natural Law');
  L('Cosmological Argument', "Leibniz' Cosmological Argument", 'Hume on Causation', 'An essay with a very long title that has to wrap onto a second line under its note', 'Aristotle');
  L('Teleological Argument', 'Teleological Argument (Modern Versions)');
  L('Theory of Forms', "Plato's Cave", 'Theory of reality summary', 'Aristotle');
  L('Natural Law', 'The Five Precepts', 'Aristotle');
  L('Ethical Thinkers', 'Aristotle', 'Kantian Ethics', 'Utilitarianism', 'Mill on Liberty');
  L('Devolution plan', 'Devolution essay', 'Principles of the Constitution');
  L('Principles of the Constitution', 'Parliamentary Sovereignty', 'Case Studies and Acts');
  L('Example Paragraphs', 'Example');
  L('Threats to Democracy', 'The End of History', 'Pressure Groups');
  L('How political identity formed', 'Declaration of Independence', 'Westward Expansion', 'Civil Rights Movement');
  L('Crash Course', 'Reconstruction', 'Impacts of the War');
  L('Introduction to Economics', 'Definitions (Macro)', 'Elasticity');
  L('Market Failure', 'Externalities');
  L('Project question research', 'Aristotle', 'Essay Competitions');
  // attachments
  link('Maths/Maths MOC.md', 'Maths/Textbook.pdf');
  link(P['Year 1 textbook'], 'Maths/Textbook.pdf');
  link('Philosophy/Philosophy MOC.md', 'Philosophy/Timeline.canvas');
  // links to notes that do not exist yet
  unresolved[P['Ethical Thinkers']] = ['Bentham', 'Fletcher'];
  unresolved[P['Definitions (Macro)']] = ['Aggregate Demand'];
  unresolved[P['Parliamentary Sovereignty']] = ['Dicey'];
  // notes linked to nothing
  add('Untitled.md'); add('Scratchpad.md'); add('Inbox/Reading list.md'); add('Inbox/Ideas.md');
  link('Inbox/Ideas.md', 'Inbox/Reading list.md');
  return { files, links, unresolved };
}

/** Synthetic vault: `mocs` subject MOCs of varying size hanging off a Home note. */
function synthetic({ seed = 1, mocs = 6, notes = 300, orphans = 10, home = true, mocWord = 'MOC', skew = 1.2, deep = 0.35 } = {}) {
  const r = rng(seed);
  const files = [], links = {}, unresolved = {};
  const add = (path) => { files.push({ path }); links[path] = []; return path; };
  const names = ['Physics', 'History', 'Biology', 'Music', 'Coding', 'Design', 'Travel', 'Cooking', 'Books', 'Film', 'Health', 'Finance', 'Latin', 'Chess', 'Garden', 'Art', 'Maths', 'Law', 'Poetry', 'Space'];
  const h = home ? add('Home.md') : null;
  const weights = [];
  for (let m = 0; m < mocs; m++) weights.push(1 / Math.pow(m + 1, skew));
  const wsum = weights.reduce((a, b) => a + b, 0);
  for (let m = 0; m < mocs; m++) {
    const name = names[m % names.length] + (m >= names.length ? ' ' + (Math.floor(m / names.length) + 1) : '');
    const moc = add(mocWord ? `${name}/${name} ${mocWord}.md` : `${name}/${name}.md`);
    if (h) links[h].push(moc);
    const n = Math.max(1, Math.round((notes * weights[m]) / wsum));
    const made = [];
    for (let i = 0; i < n; i++) {
      const p = add(`${name}/${name} note ${i + 1}.md`);
      if (made.length && r() < deep) links[made[Math.floor(r() * made.length)]].push(p);
      else links[moc].push(p);
      if (made.length > 2 && r() < 0.25) links[p].push(made[Math.floor(r() * made.length)]);
      made.push(p);
    }
  }
  // a few links across subjects
  const md = files.map((f) => f.path);
  for (let i = 0; i < notes * 0.03; i++) links[md[Math.floor(r() * md.length)]].push(md[Math.floor(r() * md.length)]);
  for (let i = 0; i < orphans; i++) add(`Inbox/Loose note ${i + 1}.md`);
  return { files, links, unresolved };
}

/** A generic sample vault for screenshots in the README. */
function demo() {
  const files = [], links = {}, unresolved = {};
  const add = (path) => { files.push({ path }); links[path] = links[path] || []; return path; };
  const home = add('Home.md');
  const plan = { Physics: 27, History: 14, Music: 9, Coding: 7, Books: 4, Travel: 3 };
  const r = rng(42);
  for (const subj in plan) {
    const moc = add(`${subj}/${subj} MOC.md`);
    links[home].push(moc);
    const made = [];
    for (let i = 0; i < plan[subj]; i++) {
      const p = add(`${subj}/${subj} note ${i + 1}.md`);
      links[moc].push(p);
      if (made.length > 1 && r() < 0.45) links[made[Math.floor(r() * made.length)]].push(p);
      made.push(p);
    }
  }
  add('Inbox/Idea.md'); add('Inbox/To sort.md'); add('Inbox/Scratch.md');
  links['Inbox/Idea.md'].push('Inbox/To sort.md');
  return { files, links, unresolved };
}

const VAULTS = {
  demo,
  student,
  small: () => synthetic({ seed: 3, mocs: 4, notes: 22, orphans: 2 }),
  medium: () => synthetic({ seed: 5, mocs: 8, notes: 320, orphans: 14 }),
  large: () => synthetic({ seed: 7, mocs: 6, notes: 1500, orphans: 60 }),
  manymocs: () => synthetic({ seed: 9, mocs: 15, notes: 420, orphans: 8 }),
  nomocs: () => synthetic({ seed: 11, mocs: 6, notes: 200, orphans: 6, mocWord: '' }),
  nohome: () => synthetic({ seed: 13, mocs: 5, notes: 120, orphans: 4, home: false }),
  twomocs: () => synthetic({ seed: 15, mocs: 2, notes: 60, orphans: 3 }),
  flat: () => {
    const files = [], links = {};
    for (let i = 0; i < 40; i++) { files.push({ path: `Folder ${i % 4}/Note ${i}.md` }); links[`Folder ${i % 4}/Note ${i}.md`] = []; }
    return { files, links, unresolved: {} };
  },
};

module.exports = { VAULTS };
