// Firmware library of the admin (lib/firmware.js): packages of the MeshtasticDesktop flasher
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zip } = require('../lib/datapackage');
const { FirmwareLibrary } = require('../lib/firmware');

function pkg(version, chip, devices) {
  const files = { 'meshdesk-firmware.json': JSON.stringify({ version, channel: 'TAKweb', chip }) };
  for (const d of devices) {
    const base = `firmware-${d}-${version}`;
    files[`${base}.mt.json`] = JSON.stringify({
      platformioTarget: d, displayName: d.toUpperCase(), mcu: chip, version,
      files: [{ name: `${base}.factory.bin` }, { name: `${base}.bin`, part_name: 'app0' }, { name: `littlefs-${d}-${version}.bin` }],
      part: [{ name: 'app0', offset: '0x10000' }, { name: 'app1', offset: '0x650000', subtype: 'ota_1' }, { name: 'spiffs', offset: '0xc90000' }],
    });
    files[`${base}.factory.bin`] = Buffer.alloc(300, 1);
    files[`${base}.bin`] = Buffer.alloc(200, 2);
    files[`littlefs-${d}-${version}.bin`] = Buffer.alloc(100, 3);
  }
  return zip(files);
}

test('firmware library: import packages, list devices with flash layout, files, delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-'));
  const lib = new FirmwareLibrary(dir);
  const r = lib.importZip(pkg('2.7.26.54e0d8d-takweb', 'esp32s3', ['seeed-xiao-s3', 'heltec-v3']));
  assert.equal(r.version, '2.7.26.54e0d8d-takweb');
  lib.importZip(pkg('2.7.26.54e0d8d-takweb', 'esp32', ['tbeam'])); // second chip family of the same version
  const [v] = lib.list();
  assert.equal(v.devices.length, 3);
  const xiao = v.devices.find(d => d.target === 'seeed-xiao-s3');
  assert.equal(xiao.chip, 'esp32s3');
  assert.ok(xiao.esp);
  assert.equal(xiao.flash.factory, 'firmware-seeed-xiao-s3-2.7.26.54e0d8d-takweb.factory.bin');
  assert.equal(xiao.flash.app, 'firmware-seeed-xiao-s3-2.7.26.54e0d8d-takweb.bin');
  assert.equal(xiao.flash.littlefs, 'littlefs-seeed-xiao-s3-2.7.26.54e0d8d-takweb.bin');
  assert.deepEqual([xiao.flash.appOff, xiao.flash.otaOff, xiao.flash.fsOff], [0x10000, 0x650000, 0xc90000]);
  assert.equal(xiao.size, 600);
  assert.ok(lib.file(v.key, xiao.flash.factory));
  assert.equal(lib.file(v.key, '../../etc/passwd'), null);
  assert.equal(lib.file('..', 'x'), null);
  assert.throws(() => lib.importZip(zip({ 'readme.txt': 'x' })), /No Meshtastic firmware/);
  assert.throws(() => lib.importZip(Buffer.from('nope')), /Not a ZIP/);
  assert.ok(lib.remove(v.key));
  assert.deepEqual(lib.list(), []);
});

test('firmware library: GitHub releases and download (fake GitHub)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-'));
  const body = pkg('2.7.26-takweb', 'esp32s3', ['seeed-xiao-s3']);
  const fetchImpl = async url => {
    if (url.includes('/releases?')) {
      return { ok: true, json: async () => [{ tag_name: 'takweb-fw-2.7.26-takweb', name: 'TAKweb', assets: [
        { name: 'meshtastic-fw-2.7.26-takweb-esp32s3.zip', size: body.length, browser_download_url: 'https://dl/s3.zip' },
        { name: 'meshtastic-fw-2.7.26-takweb-esp32.zip', size: 1, browser_download_url: 'https://dl/esp32.zip' }] }] };
    }
    if (url === 'https://dl/s3.zip') return { ok: true, arrayBuffer: async () => body };
    return { ok: false, status: 404 };
  };
  const lib = new FirmwareLibrary(dir, { fetchImpl });
  const rels = await lib.releases();
  assert.equal(rels[0].assets.map(a => a.chip).join(), 'esp32s3,esp32');
  const done = await lib.fetchRelease('takweb-fw-2.7.26-takweb', ['esp32s3']);
  assert.equal(done.length, 1);
  assert.equal(lib.list()[0].devices[0].target, 'seeed-xiao-s3');
});
