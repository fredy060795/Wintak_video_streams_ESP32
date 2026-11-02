// Map tiles for the EUD through our own server: same origin as the app (no half-loaded
// tiles from foreign servers), disk cache (fast for all devices, keeps working
// on the LAN without internet).

const fs = require('fs');
const path = require('path');

const SOURCES = {
  osm: { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, type: 'image/png', attribution: '© OpenStreetMap' },
  topo: { name: 'OpenTopoMap', url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', maxZoom: 17, type: 'image/png', attribution: '© OpenTopoMap, © OpenStreetMap' },
  sat: { name: 'Esri Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19, type: 'image/jpeg', attribution: '© Esri' },
  esritopo: { name: 'Esri Topo', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', maxZoom: 19, type: 'image/jpeg', attribution: '© Esri' },
  // Elevation data for the 3D map (Terrarium encoding, free: AWS Open Data "Terrain Tiles"); not a selectable map
  dem: { name: 'Terrain', url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', maxZoom: 15, type: 'image/png', attribution: '© Mapzen, AWS Terrain Tiles', hidden: true },
};

const MAX_AGE_MS = 30 * 86400 * 1000; // fetch again after this (the old tile stays as a fallback when offline)
const PARALLEL = 6;

class TileCache {
  constructor(dir, userAgent, override) {
    this.dir = dir;
    this.override = override || ''; // tests only: all sources from this address ({s} = source)
    this.userAgent = userAgent || 'TAKweb/1.0';
    this.inflight = new Map();
    this.active = 0;
    this.queue = [];
  }

  static list() {
    return Object.entries(SOURCES).filter(([, s]) => !s.hidden).map(([id, s]) => ({ id, name: s.name, maxZoom: s.maxZoom, attribution: s.attribution }));
  }

  // "osm/12/2200/1400.png" -> { src, z, x, y } or null
  static parse(rel) {
    const m = /^([a-z]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})(?:\.(?:png|jpg))?$/.exec(rel);
    if (!m || !SOURCES[m[1]]) return null;
    const z = Number(m[2]), x = Number(m[3]), y = Number(m[4]);
    if (z > SOURCES[m[1]].maxZoom || x >= 2 ** z || y >= 2 ** z) return null;
    return { src: m[1], z, x, y };
  }

  file(t) {
    return path.join(this.dir, t.src, String(t.z), String(t.x), String(t.y));
  }

  async get(t) {
    const file = this.file(t);
    let stat = null;
    try { stat = await fs.promises.stat(file); } catch (e) { /* not there yet */ }
    if (stat && Date.now() - stat.mtimeMs < MAX_AGE_MS) return { data: await fs.promises.readFile(file), type: SOURCES[t.src].type };
    try {
      const data = await this.fetchOnce(t);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, data);
      return { data, type: SOURCES[t.src].type };
    } catch (e) {
      if (stat) return { data: await fs.promises.readFile(file), type: SOURCES[t.src].type }; // old, but better than nothing
      throw e;
    }
  }

  // Fetch the same tile only once at a time; at most PARALLEL outgoing requests
  fetchOnce(t) {
    const key = `${t.src}/${t.z}/${t.x}/${t.y}`;
    if (!this.inflight.has(key)) {
      const p = this.limit(() => this.download(t)).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return this.inflight.get(key);
  }

  limit(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.active++;
        fn().then(resolve, reject).finally(() => {
          this.active--;
          const next = this.queue.shift();
          if (next) next();
        });
      };
      if (this.active < PARALLEL) run();
      else this.queue.push(run);
    });
  }

  async download(t) {
    const url = (this.override || SOURCES[t.src].url).replace('{s}', t.src).replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': this.userAgent }, signal: ctrl.signal });
      if (!res.ok) throw new Error('Tile server answered ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 50) throw new Error('empty tile');
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { TileCache, SOURCES };
