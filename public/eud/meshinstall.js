// Puts TAKweb onto a Meshtastic radio (ESP32): over the normal client connection (USB or Bluetooth) – the old web files
// in /static are removed, the TAKweb files (lib/meshsite.js, gzipped) written with XModem, checked against the radio's
// file list, then the radio's WLAN is set (e.g. a phone hotspot) and the radio restarts. After that its web server
// serves TAKweb: the phone on that WLAN opens https://<radio> – mesh only, no internet needed.
// Works in the browser (window.MeshInstall) and in Node (tests).
'use strict';

(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MeshInstall = m;
}(typeof self !== 'undefined' ? self : this, () => {
  const CHUNK = 128; // XModem buffer of the firmware
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  class RadioInstaller {
    // P: meshproto; send(bytes): one ToRadio to the radio; log(text); feed() gets every FromRadio (parsed)
    constructor({ P, send, log = () => {} }) {
      Object.assign(this, { P, send, log });
      this.waiters = [];
      this.myNode = 0;
      this.files = [];
      this.network = null;
    }

    feed(m) {
      if (m.kind === 'myInfo') this.myNode = m.nodeNum;
      else if (m.kind === 'fileInfo') this.files.push({ name: m.name, size: m.size });
      else if (m.kind === 'config' && m.network) this.network = m.network;
      for (const w of this.waiters.slice()) if (w.test(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(m); }
    }

    waitFor(test, ms, what) {
      return new Promise((resolve, reject) => {
        const w = { test, resolve };
        w.timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(what + ': no answer from the radio')); }, ms);
        this.waiters.push(w);
      });
    }

    // the radio's state: own node, files on the flash, network settings
    async readState() {
      this.files = [];
      const nonce = 1 + Math.floor(Math.random() * 0x7ffffff0);
      const done = this.waitFor(m => m.kind === 'configComplete' && m.id === nonce, 30000, 'Reading the radio');
      await this.send(this.P.wantConfig(nonce));
      await done;
      if (!this.myNode) throw new Error('The radio did not say who it is.');
      return { node: this.myNode, files: this.files.slice(), network: this.network };
    }

    // one XModem packet, the answer of the radio (ACK / NAK / CAN)
    async xm(pkt, ms = 6000) {
      const answer = this.waitFor(m => m.kind === 'xmodem', ms, 'File transfer');
      await this.send(this.P.toRadioXmodem(pkt));
      return (await answer).control;
    }

    async remove(name) {
      const X = this.P.XMODEM;
      if (await this.xm({ control: X.SOH, seq: 0, buffer: new TextEncoder().encode(name) }) !== X.ACK) throw new Error('Cannot open ' + name);
      await this.xm({ control: X.CAN });
    }

    async put(name, data, onBytes = () => {}) {
      const X = this.P.XMODEM;
      let ok = false;
      for (let t = 0; t < 3 && !ok; t++) ok = await this.xm({ control: X.SOH, seq: 0, buffer: new TextEncoder().encode(name) }).catch(() => 0) === X.ACK;
      if (!ok) throw new Error('The radio does not take ' + name);
      for (let i = 0, seq = 1; i < data.length; i += CHUNK, seq++) {
        const part = data.subarray(i, i + CHUNK);
        let sent = false;
        for (let t = 0; t < 6 && !sent; t++) {
          const c = await this.xm({ control: X.SOH, seq, buffer: part }).catch(() => 0);
          if (c === X.ACK) sent = true;
          else if (c === X.CAN) throw new Error('The radio cancelled ' + name);
          else await sleep(200);
        }
        if (!sent) throw new Error(`Packet ${seq} of ${name} not accepted`);
        onBytes(Math.min(data.length, i + CHUNK));
      }
      if (await this.xm({ control: X.EOT }) !== X.ACK) throw new Error('End of ' + name + ' not confirmed');
    }

    // files: [{ name, gz: Uint8Array }]; wifi: { ssid, psk } or null; onProgress({ step, done, total, file })
    async install({ files, wifi, onProgress = () => {} }) {
      const st = await this.readState();
      this.log(`Radio ${this.P.nodeId(st.node)}: ${st.files.length} files on the flash`);
      const old = st.files.filter(f => /^\/?static\//.test(f.name));
      for (const [i, f] of old.entries()) {
        onProgress({ step: 'remove', done: i, total: old.length, file: f.name });
        await this.remove(f.name.startsWith('/') ? f.name : '/' + f.name);
      }
      const total = files.reduce((n, f) => n + f.gz.length, 0);
      let before = 0;
      for (const f of files) {
        const target = `/static/${f.name}.gz`;
        await this.put(target, f.gz, b => onProgress({ step: 'upload', done: before + b, total, file: f.name }));
        before += f.gz.length;
        this.log(`${f.name}: ${f.gz.length} bytes`);
      }
      // the firmware confirms even when the flash is full – compare with its file list
      onProgress({ step: 'check', done: 0, total: 1 });
      const after = await this.readState();
      const bad = files.filter(f => { const x = after.files.find(y => y.name.replace(/^\//, '') === `static/${f.name}.gz`); return !x || x.size !== f.gz.length; });
      if (bad.length) throw new Error(`Not stored completely (flash full?): ${bad.map(f => f.name).join(', ')}`);
      if (wifi && wifi.ssid) {
        onProgress({ step: 'wifi', done: 0, total: 1 });
        await this.send(this.P.adminSetWifi(this.myNode, this.network, { ssid: wifi.ssid, psk: wifi.psk || '', ip: wifi.ip || '' }));
        await sleep(1500);
        await this.send(this.P.adminReboot(this.myNode, 3)).catch(() => {});
        this.log(`WLAN set: "${wifi.ssid}", ${wifi.ip ? 'fixed address ' + wifi.ip : 'address from the hotspot (DHCP)'} – the radio restarts (Bluetooth is off while WLAN is on)`);
      }
      onProgress({ step: 'done', done: 1, total: 1 });
    }
  }

  // Meshtastic over USB (Web Serial, Chrome/Edge): frames 0x94 0xC3 <length 2 bytes> <protobuf>; other bytes are log text
  class SerialLink {
    constructor(port, onFrame, onText = () => {}) { Object.assign(this, { port, onFrame, onText }); this.buf = new Uint8Array(0); }
    async open(baud = 115200) {
      await this.port.open({ baudRate: baud });
      this.writer = this.port.writable.getWriter();
      this.reading = this.readLoop();
      await this.writer.write(new Uint8Array(32).fill(0xc3)); // wake the radio's API
      await sleep(100);
    }
    async send(bytes) {
      const f = new Uint8Array(4 + bytes.length);
      f.set([0x94, 0xc3, bytes.length >> 8, bytes.length & 255]);
      f.set(bytes, 4);
      await this.writer.write(f);
    }
    push(chunk) {
      let b = new Uint8Array(this.buf.length + chunk.length);
      b.set(this.buf); b.set(chunk, this.buf.length);
      for (;;) {
        const i = b.findIndex((x, k) => x === 0x94 && b[k + 1] === 0xc3);
        if (i < 0) { if (b.length) this.onText(new TextDecoder().decode(b.subarray(0, Math.max(0, b.length - 1)))); b = b.subarray(Math.max(0, b.length - 1)); break; }
        if (i > 0) this.onText(new TextDecoder().decode(b.subarray(0, i)));
        if (b.length < i + 4) { b = b.subarray(i); break; }
        const len = (b[i + 2] << 8) | b[i + 3];
        if (len > 512) { b = b.subarray(i + 1); continue; } // not a frame
        if (b.length < i + 4 + len) { b = b.subarray(i); break; }
        this.onFrame(b.slice(i + 4, i + 4 + len));
        b = b.subarray(i + 4 + len);
      }
      this.buf = Uint8Array.from(b);
    }
    async readLoop() {
      while (this.port.readable) {
        const reader = this.port.readable.getReader();
        this.reader = reader;
        try {
          for (;;) { const { value, done } = await reader.read(); if (done) return; if (value) this.push(value); }
        } catch (e) { return; } finally { reader.releaseLock(); }
      }
    }
    async close() {
      try { if (this.reader) await this.reader.cancel(); } catch (e) { /* gone */ }
      try { this.writer.releaseLock(); } catch (e) { /* gone */ }
      try { await this.port.close(); } catch (e) { /* gone */ }
    }
  }

  return { RadioInstaller, SerialLink, CHUNK };
}));
