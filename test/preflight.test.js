// Start check (lib/preflight.js): an old Node.js or packages that were never installed give a clear message
// instead of a "Cannot find module" stack (issue: Node 18 and "npm start" without "npm install").

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { problems } = require('../lib/preflight');

test('preflight: this installation is fine', () => {
  assert.deepEqual(problems(), []);
});

test('preflight: Node 18 and missing packages are named with what to do', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takweb-pre-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { qrcode: '1', ws: '8' } }));
    fs.mkdirSync(path.join(root, 'node_modules', 'ws'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'ws', 'package.json'), '{}');
    const list = problems(root, '18.19.1');
    assert.equal(list.length, 2);
    assert.match(list[0], /Node\.js 18\.19\.1 is too old/);
    assert.match(list[0], /nodesource/);
    assert.match(list[1], /Packages not installed: qrcode\./);
    assert.match(list[1], /npm install/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preflight: the server stops with the message (exit 1), no module stack', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takweb-pre-'));
  try {
    fs.mkdirSync(path.join(root, 'lib'));
    fs.copyFileSync(path.join(__dirname, '..', 'lib', 'preflight.js'), path.join(root, 'lib', 'preflight.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'server.js'), path.join(root, 'server.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(root, 'package.json'));
    const r = spawnSync(process.execPath, ['server.js'], { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /TAKweb cannot start/);
    assert.match(r.stderr, /qrcode/);
    assert.doesNotMatch(r.stderr, /Cannot find module/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
