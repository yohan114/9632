const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('--- EXTRACTING RESTORATION BUNDLE ---');
const zipFile = path.join(__dirname, '..', 'restoration_bundle.zip');
const targetDir = path.join(__dirname, '..');

// Save config.js before extraction
const configPath = path.join(targetDir, 'src', 'config.js');
let savedConfig = null;
if (fs.existsSync(configPath)) {
  savedConfig = fs.readFileSync(configPath, 'utf8');
}

// Extract using PowerShell Expand-Archive
console.log('Extracting zip...');
execSync(`powershell -Command "Expand-Archive -Path '${zipFile}' -DestinationPath '${targetDir}' -Force"`, { stdio: 'inherit' });

// Restore / enforce port 1949 and merged db in src/config.js
if (fs.existsSync(configPath)) {
  let conf = fs.readFileSync(configPath, 'utf8');
  // ensure port defaults to 1949
  conf = conf.replace(/process\.env\.PORT\s*\|\|\s*1929/g, "process.env.PORT || 1949");
  conf = conf.replace(/workshopone\.db/g, "workshopone_merged.db");
  conf = conf.replace(/core\.db/g, "workshopone_merged.db");
  fs.writeFileSync(configPath, conf, 'utf8');
  console.log('Enforced port 1949 and workshopone_merged.db in src/config.js');
}

// Clean up zip
if (fs.existsSync(zipFile)) {
  fs.unlinkSync(zipFile);
  console.log('Removed restoration_bundle.zip');
}

console.log('Restoration bundle extracted successfully.');
