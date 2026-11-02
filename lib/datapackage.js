// ATAK/iTAK setup package (data package .zip): truststore, server, user, password, callsign, team.
// ATAK takes over everything when opened and requests its certificate itself – nothing to type,
// works with a self-signed server certificate too (unlike the tak:// QR code).

const crypto = require('crypto');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Simple ZIP writer (deflate), enough for a few small files
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const packed = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);         // Version
    local.writeUInt16LE(0x0800, 6);     // UTF-8 names
    local.writeUInt16LE(8, 8);          // Deflate
    local.writeUInt32LE(0, 10);         // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const entry = (key, value, cls = 'String') => `    <entry key="${xml(key)}" class="class java.lang.${cls}">${xml(value)}</entry>`;

// Settings in ATAK format (like the data packages of the official TAK Server)
function configPref({ host, port = 8089, description, username, password, caPassword, callsign, team, role }) {
  const stream = [
    entry('count', 1, 'Integer'),
    entry('description0', description || host),
    entry('enabled0', 'true', 'Boolean'),
    entry('connectString0', `${host}:${port}:ssl`),
    entry('caLocation0', 'cert/truststore.p12'),
    entry('caPassword0', caPassword),
    entry('enrollForCertificateWithTrust0', 'true', 'Boolean'),
    entry('useAuth0', 'true', 'Boolean'),
    entry('username0', username),
    entry('password0', password),
    entry('cacheCreds0', 'Cache credentials'),
  ];
  const app = [
    entry('displayServerConnectionWidget', 'true', 'Boolean'),
    entry('caLocation', 'cert/truststore.p12'),
    entry('caPassword', caPassword),
    entry('clientPassword', caPassword),
  ];
  if (callsign) app.push(entry('locationCallsign', callsign));
  if (team) app.push(entry('locationTeam', team));
  if (role) app.push(entry('atakRoleType', role));
  return `<?xml version='1.0' encoding='ASCII' standalone='yes'?>\n<preferences>\n`
    + `  <preference version="1" name="cot_streams">\n${stream.join('\n')}\n  </preference>\n`
    + `  <preference version="1" name="com.atakmap.app_preferences">\n${app.join('\n')}\n  </preference>\n</preferences>\n`;
}

function atakPackage(opts) {
  const name = `TAKweb-${String(opts.callsign || opts.username).replace(/[^\w.-]+/g, '_')}`;
  const manifest = `<MissionPackageManifest version="2">\n  <Configuration>\n`
    + `    <Parameter name="uid" value="${crypto.randomUUID()}"/>\n    <Parameter name="name" value="${xml(name)}.zip"/>\n`
    + `    <Parameter name="onReceiveDelete" value="true"/>\n  </Configuration>\n  <Contents>\n`
    + '    <Content ignore="false" zipEntry="certs/config.pref"/>\n    <Content ignore="false" zipEntry="certs/truststore.p12"/>\n'
    + '  </Contents>\n</MissionPackageManifest>\n';
  return {
    filename: name + '.zip',
    data: zip({
      'MANIFEST/manifest.xml': manifest,
      'certs/config.pref': configPref(opts),
      'certs/truststore.p12': opts.truststore,
    }),
  };
}

module.exports = { zip, crc32, configPref, atakPackage };
