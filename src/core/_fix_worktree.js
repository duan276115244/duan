// Temporary script to fix require-await in git-worktree.ts closures
const fs = require('fs');
const p = 'd:/good/jws/src/core/git-worktree.ts';
let c = fs.readFileSync(p, 'utf8');

// Build the search/replace strings using array join to avoid escaping issues
const backtick = String.fromCharCode(96);

function makeOld(methodName) {
  return [
    '        execute: async (args) => {',
    '          const result = manager.' + methodName + '(args.name as string);',
    '          return result.success',
    '            ? result.output!',
    '            : ' + backtick + '\u274C ${result.error}' + backtick + ';',
    '        },',
  ].join('\n');
}

function makeNew(methodName) {
  return [
    '        execute: (args) => {',
    '          const result = manager.' + methodName + '(args.name as string);',
    '          return Promise.resolve(result.success',
    '            ? result.output!',
    '            : ' + backtick + '\u274C ${result.error}' + backtick + ');',
    '        },',
  ].join('\n');
}

let count = 0;
for (const m of ['getWorktreeDiff', 'syncWorktree']) {
  const oldS = makeOld(m);
  const newS = makeNew(m);
  if (c.includes(oldS)) {
    c = c.replace(oldS, newS);
    console.log(m + ': replaced');
    count++;
  } else {
    console.log(m + ': NOT FOUND');
    // Debug: show what's around the method
    const idx = c.indexOf('manager.' + m + '(args.name as string);');
    if (idx >= 0) {
      const around = c.substring(Math.max(0, idx - 80), idx + 200);
      console.log('  context: ' + JSON.stringify(around));
    }
  }
}

if (count > 0) {
  fs.writeFileSync(p, c);
  console.log('written, count=' + count);
} else {
  console.log('no changes written');
}
