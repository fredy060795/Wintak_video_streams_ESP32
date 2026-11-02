// ATAK setup package: ZIP with manifest, config.pref and truststore – cross-checked with our own package reader
const { test } = require('node:test');
const assert = require('node:assert/strict');
const forge = require('node-forge');
const { atakPackage } = require('../lib/datapackage');
const tak = require('../lib/tak');

function truststore(password) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86400e3);
  const attrs = [{ name: 'commonName', value: 'Test CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  const asn1 = forge.pkcs12.toPkcs12Asn1(null, [cert], password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

test('setup package: ATAK finds server, login, callsign, team and truststore', () => {
  const pkg = atakPackage({
    host: 'tak.example.com', port: 8089, description: 'TAKweb', username: 'mike', password: 'atakatak',
    caPassword: 'atakatak', callsign: 'MIKE & Co', team: 'Blue', role: 'Team Lead', truststore: truststore('atakatak'),
  });
  assert.equal(pkg.filename, 'TAKweb-MIKE_Co.zip');
  const files = tak.unzip(pkg.data);
  assert.deepEqual(Object.keys(files).sort(), ['MANIFEST/manifest.xml', 'certs/config.pref', 'certs/truststore.p12']);
  const manifest = files['MANIFEST/manifest.xml'].toString();
  assert.match(manifest, /zipEntry="certs\/config.pref"/);
  assert.match(manifest, /zipEntry="certs\/truststore.p12"/);
  const pref = files['certs/config.pref'].toString();
  for (const [k, v] of [['connectString0', 'tak.example.com:8089:ssl'], ['username0', 'mike'], ['password0', 'atakatak'], ['useAuth0', 'true'],
    ['enrollForCertificateWithTrust0', 'true'], ['caLocation0', 'cert/truststore.p12'], ['locationCallsign', 'MIKE &amp; Co'], ['locationTeam', 'Blue'], ['atakRoleType', 'Team Lead']]) {
    assert.match(pref, new RegExp(`key="${k}"[^>]*>${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`), k);
  }
  // Cross-check: TAKweb's package reader (like ATAK) reads server, login and certificate
  const r = tak.readDataPackage(pkg.data.toString('base64'));
  assert.deepEqual(r.server, { host: 'tak.example.com', port: 8089, proto: 'ssl', description: 'TAKweb' });
  assert.equal(r.enroll, true);
  assert.equal(r.caPems.length, 1);
});
