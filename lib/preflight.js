// Checked before anything else is loaded: a Node.js that is too old or packages that were never installed
// (e.g. a new version unpacked over an old folder without "npm install") otherwise end in a long
// "Cannot find module …" stack that does not say what to do.

const fs = require('fs');
const path = require('path');

const MIN_NODE = 20; // nodemailer needs Node.js 20

function problems(root = path.join(__dirname, '..'), version = process.versions.node) {
  const out = [];
  const major = Number(String(version).split('.')[0]);
  if (major < MIN_NODE) {
    out.push(`Node.js ${version} is too old – TAKweb needs Node.js ${MIN_NODE} or newer (recommended: the current LTS, 22).\n`
      + '  Ubuntu/Debian/Mint: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs\n'
      + '  Windows/macOS: https://nodejs.org (LTS)');
  }
  let deps = {};
  try { deps = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies || {}; } catch (e) { /* no package.json */ }
  const missing = Object.keys(deps).filter(d => !fs.existsSync(path.join(root, 'node_modules', d, 'package.json')));
  if (missing.length) {
    out.push(`Packages not installed: ${missing.join(', ')}.\n`
      + `  Run "npm install" in the TAKweb folder (${root}) – the folder with package.json, not in test/ or lib/ –\n`
      + '  and again after every update.');
  }
  return out;
}

function check() {
  const list = problems();
  if (!list.length) return;
  console.error('\nTAKweb cannot start:\n\n' + list.map(p => '- ' + p).join('\n\n') + '\n');
  process.exit(1);
}

module.exports = { check, problems, MIN_NODE };
