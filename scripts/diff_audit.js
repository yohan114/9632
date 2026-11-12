const fs = require('fs');
const path = require('path');

function getFiles(dir, base = '') {
  let results = [];
  try {
    const list = fs.readdirSync(dir);
    for (const file of list) {
      if (['node_modules', '.git', 'data', 'backups', 'uploads', 'logs', 
           '9632-Fuel-Merged', 'Fuel-System-V2-Ref', 'Fuel-System-V2', '9632', '.claude', 'backend', 'frontend', '.agents'].includes(file)) continue;
      const full = path.join(dir, file);
      const rel = path.join(base, file);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        results = results.concat(getFiles(full, rel));
      } else {
        results.push(rel);
      }
    }
  } catch (e) {}
  return results;
}

const localSrcDir = 'd:/Master system 1';
const mergedDir = 'd:/Master system 1/9632-Fuel-Merged';

const srcFiles = getFiles(localSrcDir);

let missingInMerged = [];
let diffSize = [];

for (const rel of srcFiles) {
  const mergedPath = path.join(mergedDir, rel);
  if (!fs.existsSync(mergedPath)) {
    missingInMerged.push(rel);
  } else {
    const s1 = fs.statSync(path.join(localSrcDir, rel)).size;
    const s2 = fs.statSync(mergedPath).size;
    if (Math.abs(s1 - s2) > 20) {
      diffSize.push({ rel, s1, s2 });
    }
  }
}

console.log('Total files checked in local 9632:', srcFiles.length);
console.log('Missing in 9632-Fuel-Merged:', missingInMerged.length);
missingInMerged.forEach(f => console.log('  MISSING:', f));

console.log('\nDifferent size files:', diffSize.length);
diffSize.forEach(d => console.log('  DIFF:', d.rel, 'Local9632:', d.s1, 'Merged:', d.s2));
