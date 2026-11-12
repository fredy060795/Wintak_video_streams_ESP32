// Admin → Meshtastic: put TAKweb onto a Meshtastic radio over USB (Web Serial, Chrome/Edge) – public/eud/meshinstall.js
'use strict';

(() => {
  const P = window.meshProto;
  const log = t => { $('mfLog').classList.remove('hidden'); $('mfLog').textContent += t + '\n'; $('mfLog').scrollTop = $('mfLog').scrollHeight; };
  const bar = (done, total) => { $('mfBar').classList.remove('hidden'); $('mfFill').style.width = (total ? Math.round(100 * done / total) : 0) + '%'; };
  const kb = n => Math.round(n / 1024) + ' KB';
  let busy = false;

  const mapQ = () => ($('mfMap').checked ? '?map=full' : '');
  async function loadPackage() {
    const r = await fetch('/api/eud/meshsite' + mapQ());
    if (!r.ok) throw new Error('Package not available (' + r.status + ')');
    return r.json();
  }
  async function showSize() {
    try { const p = await loadPackage(); $('mfSize').textContent = `TAKweb ${p.version} for the radio: ${p.files.length} files, ${kb(p.total)} on the flash`; } catch (err) { $('mfSize').textContent = err.message; }
  }
  document.addEventListener('admin-view', e => { if (e.detail === 'mesh') showSize(); });
  $('mfMap').addEventListener('change', showSize);

  $('mfGo').addEventListener('click', async () => {
    if (busy) return;
    if (!('serial' in navigator)) return setMsg($('mfMsg'), 'This browser cannot reach USB devices – use Chrome or Edge on a PC.');
    const ssid = $('mfSsid').value.trim(), psk = $('mfPsk').value;
    if (psk && psk.length < 8) return setMsg($('mfMsg'), 'A WLAN password needs at least 8 characters (or leave it empty for an open network).');
    const ip = $('mfIp').value.trim();
    if (ip) { try { P.staticNet(ip); } catch (e) { return setMsg($('mfMsg'), e.message); } }
    let port;
    try { port = await navigator.serial.requestPort(); } catch (e) { return; } // dialog closed
    busy = true;
    $('mfGo').disabled = true;
    $('mfLog').textContent = '';
    setMsg($('mfMsg'), 'Loading TAKweb …', true);
    let link = null;
    try {
      const pkg = await loadPackage();
      const files = [];
      for (const f of pkg.files) {
        const r = await fetch('/api/eud/meshsite/' + encodeURIComponent(f.name) + mapQ());
        if (!r.ok) throw new Error(f.name + ': ' + r.status);
        files.push({ name: f.name, gz: new Uint8Array(await r.arrayBuffer()) });
      }
      // index.html last: until everything is there the radio keeps showing nothing half-finished
      files.sort((a, b) => (a.name === 'index.html') - (b.name === 'index.html'));
      let inst = null;
      link = new MeshInstall.SerialLink(port, frame => { try { inst.feed(P.parseFromRadio(frame)); } catch (e) { /* not for us */ } });
      inst = new MeshInstall.RadioInstaller({ P, send: b => link.send(b), log });
      setMsg($('mfMsg'), 'Connecting to the radio …', true);
      await link.open();
      const LABEL = { remove: 'Removing the old web files', upload: 'Writing TAKweb', check: 'Checking', wifi: 'Setting the WLAN', done: 'Done' };
      await inst.install({
        files, wifi: ssid ? { ssid, psk, ip } : null,
        onProgress: p => {
          setMsg($('mfMsg'), `${LABEL[p.step]}${p.file ? ' – ' + p.file : ''}${p.step === 'upload' ? ` (${kb(p.done)} / ${kb(p.total)})` : ''}`, true);
          if (p.step === 'upload') bar(p.done, p.total);
        },
      });
      bar(1, 1);
      setMsg($('mfMsg'), ssid
        ? `Done. The radio restarts and joins the WLAN "${ssid}". On the phone: hotspot "${ssid}" on, then open ${ip ? 'https://' + ip : "https://<radio address> (on the radio's display) or https://meshtastic.local"} and accept the certificate once.`
        : 'Done – TAKweb is on the radio (WLAN not changed).', true);
    } catch (e) {
      setMsg($('mfMsg'), 'Not installed: ' + e.message);
      log('Error: ' + e.message);
    } finally {
      if (link) await link.close();
      busy = false;
      $('mfGo').disabled = false;
    }
  });
})();
