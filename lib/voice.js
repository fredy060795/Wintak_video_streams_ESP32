// Voice (push-to-talk radio) for TAKweb: like a radio net, one speaker per channel at a time. The phones and the HQ send
// short audio frames (G.711 µ-law, 8 kHz – radio quality, ~64 kbit/s) over a WebSocket while the PTT button is held;
// the server passes them on to everybody else in the channel. Channels: "All" and one per team.
// Messages (JSON): join {channel, callsign, uid, team} · ptt {on} · server: roster, floor {talker}, busy, error.
// Binary messages: audio frames of the speaker who holds the floor.

const MAX_TALK_MS = 60000;      // nobody keeps the channel longer (stuck button)
const MAX_FRAME = 4096;
const CHANNEL_RE = /^[A-Za-z0-9 _.-]{1,40}$/;

class Voice {
  constructor({ log } = {}) {
    this.log = log || (() => {});
    this.clients = new Set();
    this.floor = new Map(); // channel -> { client, since, timer }
  }

  channels() {
    const set = new Set(['All']);
    for (const c of this.clients) if (c.channel) set.add(c.channel);
    return [...set];
  }

  members(channel) { return [...this.clients].filter(c => c.channel === channel); }

  send(c, msg) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); }

  roster(channel) {
    const users = this.members(channel).map(c => ({ callsign: c.callsign, hq: c.hq }));
    const f = this.floor.get(channel);
    for (const c of this.members(channel)) this.send(c, { type: 'roster', channel, users, talker: f ? f.client.callsign : null, channels: this.channels() });
  }

  // a new connection; who = { callsign, uid, hq } from the login (TAK connection or admin session)
  attach(ws, who = {}) {
    const c = { ws, callsign: who.callsign || 'Unknown', uid: who.uid || '', hq: !!who.hq, channel: null, fixedName: !!who.callsign };
    this.clients.add(c);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.audio(c, data);
      let m;
      try { m = JSON.parse(String(data)); } catch (e) { return; }
      if (m.type === 'join') this.join(c, m);
      else if (m.type === 'ptt') (m.on ? this.take(c) : this.release(c));
    });
    ws.on('close', () => { this.release(c); this.clients.delete(c); for (const ch of this.channels()) this.roster(ch); });
    ws.on('error', () => {});
    return c;
  }

  join(c, m) {
    const channel = CHANNEL_RE.test(String(m.channel || '')) ? String(m.channel) : 'All';
    if (!c.fixedName && m.callsign) c.callsign = String(m.callsign).slice(0, 40);
    if (m.uid && !c.uid) c.uid = String(m.uid).slice(0, 80);
    const old = c.channel;
    if (old === channel) return this.roster(channel);
    this.release(c);
    const before = this.channels().join();
    c.channel = channel;
    // a new or emptied channel changes everybody's channel list
    if (this.channels().join() !== before) for (const ch of this.channels()) this.roster(ch);
    else { if (old) this.roster(old); this.roster(channel); }
  }

  take(c) {
    if (!c.channel) return;
    const f = this.floor.get(c.channel);
    if (f && f.client !== c) return this.send(c, { type: 'busy', talker: f.client.callsign });
    if (f) return;
    const timer = setTimeout(() => this.release(c), MAX_TALK_MS);
    timer.unref?.();
    this.floor.set(c.channel, { client: c, since: Date.now(), timer });
    for (const m of this.members(c.channel)) this.send(m, { type: 'floor', talker: c.callsign, me: m === c });
  }

  release(c) {
    if (!c.channel) return;
    const f = this.floor.get(c.channel);
    if (!f || f.client !== c) return;
    clearTimeout(f.timer);
    this.floor.delete(c.channel);
    for (const m of this.members(c.channel)) this.send(m, { type: 'floor', talker: null });
  }

  audio(c, data) {
    const f = c.channel && this.floor.get(c.channel);
    if (!f || f.client !== c || data.length > MAX_FRAME) return;
    for (const m of this.members(c.channel)) if (m !== c && m.ws.readyState === 1 && m.ws.bufferedAmount < 256 * 1024) m.ws.send(data, { binary: true });
  }

  stats() { return { clients: this.clients.size, channels: this.channels().map(ch => ({ channel: ch, users: this.members(ch).length, talking: !!this.floor.get(ch) })) }; }

  close() { for (const c of this.clients) c.ws.close(1001, 'server shutdown'); }
}

module.exports = { Voice, MAX_TALK_MS };
