// @bun
// bot/submit-modes.ts
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// mechfight-kit/ts/mechfight.ts
var log = (...args) => console.error(...args);

class Draw {
  caps = {};
  d = {};
  room(list, cap) {
    return (list?.length ?? 0) < (cap ?? Infinity);
  }
  line(a, b, color) {
    if (this.room(this.d.lines, this.caps.max_lines))
      (this.d.lines ??= []).push(color ? { a, b, color } : { a, b });
  }
  point(at, color, size) {
    if (this.room(this.d.points, this.caps.max_points))
      (this.d.points ??= []).push({ at, ...color && { color }, ...size !== undefined && { size } });
  }
  text(text, at, color) {
    if (this.room(this.d.text, this.caps.max_text))
      (this.d.text ??= []).push({ text: String(text), ...at && { at }, ...color && { color } });
  }
  label(text) {
    this.d.label = String(text);
  }
  clear() {
    this.d = {};
  }
  take() {
    const d = this.d;
    this.d = {};
    return Object.keys(d).length ? d : undefined;
  }
}
var draw = new Draw;
var send = (o) => process.stdout.write(JSON.stringify(o) + `
`);
function run(factory) {
  let bot = null;
  let last = {};
  let errors = 0;
  let buf = "";
  let queued = false;
  const handle = (lines) => {
    let latest = null;
    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "hello") {
        draw.caps = msg.config.debug ?? {};
        try {
          bot = factory(msg);
        } catch (e) {
          log(e);
        }
        send({ type: "ready", name: String(bot?.name ?? "bot").slice(0, 32) });
      } else if (msg.type === "obs")
        latest = msg;
      else if (msg.type === "end")
        process.exit(0);
    }
    if (!latest)
      return;
    let action = {};
    draw.clear();
    if (bot)
      try {
        action = { ...bot.act(latest) };
        last = { move: action.move, aim: action.aim, boost: action.boost };
      } catch (e) {
        errors++;
        if (errors <= 5 || errors % 100 === 0)
          log(`act() failed at tick ${latest.tick} (${errors} so far):`, e);
        action = { ...last };
      }
    action.tick = latest.tick;
    const d = draw.take();
    if (d && !action.debug)
      action.debug = d;
    send(action);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    if (queued)
      return;
    queued = true;
    setImmediate(flush);
  });
  const flush = () => {
    queued = false;
    const lines = buf.split(`
`);
    buf = lines.pop() ?? "";
    handle(lines.filter((l) => l.trim()));
  };
  process.stdin.on("end", () => {
    buf += `
`;
    flush();
  });
}

// sim/world.ts
var NO_HIT = 2;
function pointInRing(r, x, y) {
  let inside = false;
  const n = r.length;
  for (let i = 0, j = n - 2;i < n; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if (yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
function inFootprint(p, x, y) {
  if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY)
    return false;
  if (!pointInRing(p.ring, x, y))
    return false;
  for (const h of p.holes)
    if (pointInRing(h, x, y))
      return false;
  return true;
}

class World {
  static CELL = 8;
  json;
  bounds;
  prisms;
  trees;
  canopyDensity;
  canopyBlockT;
  th;
  tnx;
  tny;
  tminX;
  tminY;
  tstep;
  tscale;
  gx0;
  gy0;
  gnx;
  gny;
  cellPrisms;
  cellTrees;
  cellTerrMax;
  stamp;
  stampGen = 1;
  tstamp;
  tstampGen = 1;
  tbuf = [];
  constructor(json, terrain) {
    this.json = json;
    this.bounds = json.bounds;
    this.canopyDensity = json.rules?.canopyDensity ?? 0.35;
    this.canopyBlockT = json.rules?.canopyBlockT ?? 0.25;
    const t = json.terrain;
    this.tnx = t.nx;
    this.tny = t.ny;
    this.tminX = t.minX;
    this.tminY = t.minY;
    this.tstep = t.step;
    this.tscale = t.scale ?? 0.01;
    const bytes = terrain instanceof Uint8Array ? terrain : new Uint8Array(terrain);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.th = new Int16Array(copy.buffer, 0, t.nx * t.ny);
    this.prisms = json.prisms.map((p, idx) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0;i < p.ring.length; i += 2) {
        minX = Math.min(minX, p.ring[i]);
        maxX = Math.max(maxX, p.ring[i]);
        minY = Math.min(minY, p.ring[i + 1]);
        maxY = Math.max(maxY, p.ring[i + 1]);
      }
      return { idx, kind: p.kind, base: p.base, top: p.top, ring: p.ring, holes: p.holes ?? [], minX, minY, maxX, maxY };
    });
    const f = json.trees.fields, d = json.trees.data, nf = f.length;
    const col = (name) => f.indexOf(name);
    const ix = col("x"), iy = col("y"), iz = col("z"), ih = col("height"), icr = col("crownR"), icb = col("crownBase"), itr = col("trunkR"), icx = col("crownX"), icy = col("crownY");
    this.trees = [];
    for (let i = 0;i + nf <= d.length; i += nf) {
      this.trees.push({
        x: d[i + ix],
        y: d[i + iy],
        z: d[i + iz],
        height: d[i + ih],
        crownR: d[i + icr],
        crownBase: d[i + icb],
        trunkR: d[i + itr],
        cx: icx >= 0 ? d[i + icx] : d[i + ix],
        cy: icy >= 0 ? d[i + icy] : d[i + iy]
      });
    }
    const C = World.CELL;
    this.gx0 = this.tminX;
    this.gy0 = this.tminY;
    this.gnx = Math.ceil((t.nx - 1) * t.step / C) + 1;
    this.gny = Math.ceil((t.ny - 1) * t.step / C) + 1;
    const ncell = this.gnx * this.gny;
    this.cellPrisms = Array.from({ length: ncell }, () => []);
    this.cellTrees = Array.from({ length: ncell }, () => []);
    this.cellTerrMax = new Float32Array(ncell).fill(-Infinity);
    for (const p of this.prisms) {
      const [c0, r0] = this.cellOf(p.minX, p.minY), [c1, r1] = this.cellOf(p.maxX, p.maxY);
      for (let r = r0;r <= r1; r++)
        for (let c = c0;c <= c1; c++)
          this.cellPrisms[r * this.gnx + c].push(p.idx);
    }
    this.trees.forEach((tr, i) => {
      const rad = Math.max(tr.crownR, tr.trunkR);
      const x0 = Math.min(tr.x, tr.cx) - rad, x1 = Math.max(tr.x, tr.cx) + rad;
      const y0 = Math.min(tr.y, tr.cy) - rad, y1 = Math.max(tr.y, tr.cy) + rad;
      const [c0, r0] = this.cellOf(x0, y0), [c1, r1] = this.cellOf(x1, y1);
      for (let r = r0;r <= r1; r++)
        for (let c = c0;c <= c1; c++)
          this.cellTrees[r * this.gnx + c].push(i);
    });
    for (let j = 0;j < t.ny; j++) {
      for (let i = 0;i < t.nx; i++) {
        const h = this.th[j * t.nx + i] * this.tscale;
        const x = this.tminX + i * t.step, y = this.tminY + j * t.step;
        for (const [dx, dy] of [[0, 0], [-0.5, 0], [0, -0.5], [-0.5, -0.5]]) {
          const [c, r] = this.cellOf(x + dx * t.step, y + dy * t.step);
          const k = r * this.gnx + c;
          if (h > this.cellTerrMax[k])
            this.cellTerrMax[k] = h;
        }
      }
    }
    this.stamp = new Int32Array(this.prisms.length);
    this.tstamp = new Int32Array(this.trees.length);
  }
  cellOf(x, y) {
    const C = World.CELL;
    let c = Math.floor((x - this.gx0) / C), r = Math.floor((y - this.gy0) / C);
    c = c < 0 ? 0 : c >= this.gnx ? this.gnx - 1 : c;
    r = r < 0 ? 0 : r >= this.gny ? this.gny - 1 : r;
    return [c, r];
  }
  cellIndex(x, y) {
    const [c, r] = this.cellOf(x, y);
    return r * this.gnx + c;
  }
  prismsNear(x, y) {
    return this.cellPrisms[this.cellIndex(x, y)].map((i) => this.prisms[i]);
  }
  treesNear(x, y) {
    return this.cellTrees[this.cellIndex(x, y)].map((i) => this.trees[i]);
  }
  inBounds(x, y, margin = 0) {
    const b = this.bounds;
    return x >= b.minX + margin && x <= b.maxX - margin && y >= b.minY + margin && y <= b.maxY - margin;
  }
  ground(x, y) {
    let fx = (x - this.tminX) / this.tstep, fy = (y - this.tminY) / this.tstep;
    if (fx < 0)
      fx = 0;
    if (fy < 0)
      fy = 0;
    if (fx > this.tnx - 1.0001)
      fx = this.tnx - 1.0001;
    if (fy > this.tny - 1.0001)
      fy = this.tny - 1.0001;
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const k = j * this.tnx + i, nx = this.tnx, h = this.th;
    const a = h[k], b = h[k + 1], c = h[k + nx], d = h[k + nx + 1];
    return ((a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v) * this.tscale;
  }
  surfaceTop(x, y) {
    let h = this.ground(x, y);
    for (const i of this.cellPrisms[this.cellIndex(x, y)]) {
      const p = this.prisms[i];
      if (p.top > h && inFootprint(p, x, y))
        h = p.top;
    }
    return h;
  }
  floorAt(x, y, z, stepUp) {
    let h = this.ground(x, y);
    const lim = z + stepUp;
    for (const i of this.cellPrisms[this.cellIndex(x, y)]) {
      const p = this.prisms[i];
      if (p.top <= lim && p.top > h && inFootprint(p, x, y))
        h = p.top;
    }
    return h;
  }
  ceilingAt(x, y, z) {
    let c = Infinity;
    for (const i of this.cellPrisms[this.cellIndex(x, y)]) {
      const p = this.prisms[i];
      if (p.base > z && p.base < c && inFootprint(p, x, y))
        c = p.base;
    }
    return c;
  }
  prismWallAt(x, y, z, height, stepUp) {
    const lo = z + stepUp, hi = z + height;
    for (const i of this.cellPrisms[this.cellIndex(x, y)]) {
      const p = this.prisms[i];
      if (p.top > lo && p.base < hi && inFootprint(p, x, y))
        return true;
    }
    return false;
  }
  isOpenGround(x, y) {
    for (const i of this.cellPrisms[this.cellIndex(x, y)])
      if (inFootprint(this.prisms[i], x, y))
        return false;
    return true;
  }
  solidAt(x, y, z) {
    if (z < this.ground(x, y))
      return true;
    for (const i of this.cellPrisms[this.cellIndex(x, y)]) {
      const p = this.prisms[i];
      if (z >= p.base && z <= p.top && inFootprint(p, x, y))
        return true;
    }
    return false;
  }
  prismHit(p, ax, ay, az, dx, dy, dz) {
    let lo = 0, hi = 1;
    if (Math.abs(dz) < 0.000000000001) {
      if (az < p.base || az > p.top)
        return NO_HIT;
    } else {
      const ta = (p.base - az) / dz, tb = (p.top - az) / dz;
      lo = Math.max(lo, Math.min(ta, tb));
      hi = Math.min(hi, Math.max(ta, tb));
      if (lo > hi)
        return NO_HIT;
    }
    if (Math.abs(dx) < 0.000000000001) {
      if (ax < p.minX || ax > p.maxX)
        return NO_HIT;
    } else {
      const ta = (p.minX - ax) / dx, tb = (p.maxX - ax) / dx;
      lo = Math.max(lo, Math.min(ta, tb));
      hi = Math.min(hi, Math.max(ta, tb));
      if (lo > hi)
        return NO_HIT;
    }
    if (Math.abs(dy) < 0.000000000001) {
      if (ay < p.minY || ay > p.maxY)
        return NO_HIT;
    } else {
      const ta = (p.minY - ay) / dy, tb = (p.maxY - ay) / dy;
      lo = Math.max(lo, Math.min(ta, tb));
      hi = Math.min(hi, Math.max(ta, tb));
      if (lo > hi)
        return NO_HIT;
    }
    const ts = this.tbuf;
    ts.length = 0;
    ts.push(lo, hi);
    const addEdges = (r) => {
      const n = r.length;
      for (let i = 0, j = n - 2;i < n; j = i, i += 2) {
        const ex = r[i] - r[j], ey = r[i + 1] - r[j + 1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 0.000000000001)
          continue;
        const qx = r[j] - ax, qy = r[j + 1] - ay;
        const t = (qx * ey - qy * ex) / den;
        const s = (qx * dy - qy * dx) / den;
        if (s >= 0 && s <= 1 && t > lo && t < hi)
          ts.push(t);
      }
    };
    addEdges(p.ring);
    for (const h of p.holes)
      addEdges(h);
    ts.sort((a, b) => a - b);
    if (ts.length === 2 && hi - lo < 0.000000001)
      return inFootprint(p, ax + dx * lo, ay + dy * lo) ? lo : NO_HIT;
    for (let i = 0;i + 1 < ts.length; i++) {
      const m = (ts[i] + ts[i + 1]) / 2;
      if (inFootprint(p, ax + dx * m, ay + dy * m))
        return ts[i];
    }
    return NO_HIT;
  }
  rayHit(ax, ay, az, bx, by, bz, terrain = true) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len2 = Math.hypot(dx, dy);
    const C = World.CELL;
    const gen = ++this.stampGen;
    if (gen > 2000000000) {
      this.stamp.fill(0);
      this.stampGen = 1;
    }
    let best = NO_HIT;
    let c = Math.floor((ax - this.gx0) / C), r = Math.floor((ay - this.gy0) / C);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    const tdx = Math.abs(dx) < 0.000000000001 ? Infinity : C / Math.abs(dx);
    const tdy = Math.abs(dy) < 0.000000000001 ? Infinity : C / Math.abs(dy);
    let tmx = Math.abs(dx) < 0.000000000001 ? Infinity : ((c + (dx > 0 ? 1 : 0)) * C + this.gx0 - ax) / dx;
    let tmy = Math.abs(dy) < 0.000000000001 ? Infinity : ((r + (dy > 0 ? 1 : 0)) * C + this.gy0 - ay) / dy;
    let t0 = 0;
    for (let guard = 0;guard < 1e5; guard++) {
      const t1 = Math.min(tmx, tmy, 1);
      if (c >= 0 && r >= 0 && c < this.gnx && r < this.gny) {
        const k = r * this.gnx + c;
        for (const pi of this.cellPrisms[k]) {
          if (this.stamp[pi] === gen)
            continue;
          this.stamp[pi] = gen;
          const t = this.prismHit(this.prisms[pi], ax, ay, az, dx, dy, dz);
          if (t < best)
            best = t;
        }
        if (terrain && t0 < best) {
          const zmin = Math.min(az + dz * t0, az + dz * t1);
          if (zmin <= this.cellTerrMax[k]) {
            const tt = this.terrainHitIn(ax, ay, az, dx, dy, dz, t0, Math.min(t1, best), len2);
            if (tt < best)
              best = tt;
          }
        }
      }
      if (best <= t1 || t1 >= 1)
        break;
      t0 = t1;
      if (tmx < tmy) {
        tmx += tdx;
        c += sx;
      } else {
        tmy += tdy;
        r += sy;
      }
    }
    return best;
  }
  terrainHitIn(ax, ay, az, dx, dy, dz, t0, t1, len2) {
    const len = len2 > 0.000000001 ? len2 : 1;
    const step = Math.min(0.5 / len, Math.max(t1 - t0, 0.000001));
    let prevT = t0;
    const below = (t) => az + dz * t < this.ground(ax + dx * t, ay + dy * t);
    if (below(t0))
      return t0;
    for (let t = t0 + step;; t += step) {
      const tt = Math.min(t, t1);
      if (below(tt)) {
        let lo = prevT, hi = tt;
        for (let i = 0;i < 6; i++) {
          const m = (lo + hi) / 2;
          if (below(m))
            hi = m;
          else
            lo = m;
        }
        return hi;
      }
      prevT = tt;
      if (tt >= t1)
        return NO_HIT;
    }
  }
  clearLine(a, b) {
    return this.rayHit(a[0], a[1], a[2], b[0], b[1], b[2]) >= 1;
  }
  canopyBlocks(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const gen = ++this.tstampGen;
    if (gen > 2000000000) {
      this.tstamp.fill(0);
      this.tstampGen = 1;
    }
    const C = World.CELL;
    const L = Math.hypot(dx, dy, dz);
    const maxCrown = -Math.log(this.canopyBlockT) / this.canopyDensity;
    let crown = 0;
    let c = Math.floor((ax - this.gx0) / C), r = Math.floor((ay - this.gy0) / C);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    const tdx = Math.abs(dx) < 0.000000000001 ? Infinity : C / Math.abs(dx);
    const tdy = Math.abs(dy) < 0.000000000001 ? Infinity : C / Math.abs(dy);
    let tmx = Math.abs(dx) < 0.000000000001 ? Infinity : ((c + (dx > 0 ? 1 : 0)) * C + this.gx0 - ax) / dx;
    let tmy = Math.abs(dy) < 0.000000000001 ? Infinity : ((r + (dy > 0 ? 1 : 0)) * C + this.gy0 - ay) / dy;
    const A = dx * dx + dy * dy;
    for (let guard = 0;guard < 1e5; guard++) {
      const t1 = Math.min(tmx, tmy, 1);
      if (c >= 0 && r >= 0 && c < this.gnx && r < this.gny) {
        for (const ti of this.cellTrees[r * this.gnx + c]) {
          if (this.tstamp[ti] === gen)
            continue;
          this.tstamp[ti] = gen;
          const tr = this.trees[ti];
          if (A < 0.000000001)
            continue;
          const tt = segCylinder(ax, ay, az, dx, dy, dz, tr.x, tr.y, tr.trunkR, tr.z, tr.z + tr.crownBase);
          if (tt <= 1)
            return true;
          const fx = ax - tr.cx, fy = ay - tr.cy;
          const B = 2 * (fx * dx + fy * dy), Cc = fx * fx + fy * fy - tr.crownR * tr.crownR;
          const disc = B * B - 4 * A * Cc;
          if (disc <= 0)
            continue;
          const sq = Math.sqrt(disc);
          let lo = Math.max(0, (-B - sq) / (2 * A)), hi = Math.min(1, (-B + sq) / (2 * A));
          const z0 = tr.z + tr.crownBase, z1 = tr.z + tr.height;
          if (Math.abs(dz) > 0.000000001) {
            const ta = (z0 - az) / dz, tb = (z1 - az) / dz;
            lo = Math.max(lo, Math.min(ta, tb));
            hi = Math.min(hi, Math.max(ta, tb));
          } else if (az < z0 || az > z1)
            continue;
          if (hi > lo) {
            crown += (hi - lo) * L;
            if (crown > maxCrown)
              return true;
          }
        }
      }
      if (t1 >= 1)
        break;
      if (tmx < tmy) {
        tmx += tdx;
        c += sx;
      } else {
        tmy += tdy;
        r += sy;
      }
    }
    return false;
  }
}
function segCylinder(ax, ay, az, dx, dy, dz, cx, cy, r, z0, z1) {
  const fx = ax - cx, fy = ay - cy;
  const A = dx * dx + dy * dy;
  let lo = 0, hi = 1;
  if (A < 0.000000000001) {
    if (fx * fx + fy * fy > r * r)
      return NO_HIT;
  } else {
    const B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
    const disc = B * B - 4 * A * C;
    if (disc < 0)
      return NO_HIT;
    const sq = Math.sqrt(disc);
    lo = Math.max(lo, (-B - sq) / (2 * A));
    hi = Math.min(hi, (-B + sq) / (2 * A));
    if (lo > hi)
      return NO_HIT;
  }
  if (Math.abs(dz) < 0.000000000001) {
    if (az < z0 || az > z1)
      return NO_HIT;
  } else {
    const ta = (z0 - az) / dz, tb = (z1 - az) / dz;
    lo = Math.max(lo, Math.min(ta, tb));
    hi = Math.min(hi, Math.max(ta, tb));
  }
  return lo <= hi ? lo : NO_HIT;
}

// bot/modes.ts
var SPACE = {
  zoneMargin: { def: 0.85, min: 0.4, max: 1, step: 0.05, group: "general", desc: "Head back toward the zone center when farther out than this fraction of the radius" },
  nextZoneMargin: { def: 0.8, min: 0.3, max: 1, step: 0.05, group: "general", desc: "Same for the next circle once a shrink is near" },
  shrinkLead: { def: 15, min: 0, max: 60, step: 5, group: "general", desc: "Seconds before a shrink to start moving into the next circle" },
  boostEnergyOutside: { def: 30, min: 0, max: 90, step: 10, group: "general", desc: "Boost toward the zone when outside it and energy is above this" },
  hurtFrac: { def: 0.35, min: 0.1, max: 0.7, step: 0.05, group: "general", desc: "Counts as hurt below this fraction of max HP" },
  rankLaser: { def: 1, min: 0, max: 5, step: 1, int: true, group: "general", desc: "How much it wants a laser (gun = 0)" },
  rankLightning: { def: 2, min: 0, max: 5, step: 1, int: true, group: "general", desc: "How much it wants lightning" },
  rankMortar: { def: 1, min: 0, max: 5, step: 1, int: true, group: "general", desc: "How much it wants a mortar" },
  gunAimTol: { def: 0.05, min: 0.01, max: 0.2, step: 0.01, group: "general", desc: "Fire the gun when the aim error is below this (rad)" },
  laserAimTol: { def: 0.02, min: 0.005, max: 0.15, step: 0.01, group: "general", desc: "Release a charged laser when the aim error is below this (rad)" },
  lightningCone: { def: 0.3, min: 0.05, max: 0.8, step: 0.05, group: "general", desc: "Fire lightning when the target is within this angle (rad)" },
  lightningEnergyMin: { def: 15, min: 0, max: 60, step: 5, group: "general", desc: "Keep this much energy before firing lightning" },
  mortarMinDist: { def: 25, min: 5, max: 80, step: 5, group: "general", desc: "No mortar at targets closer than this (m)" },
  reloadBelow: { def: 6, min: 0, max: 12, step: 1, int: true, group: "general", desc: "Reload out of combat when ammo is below this" },
  recentS: { def: 4, min: 0.5, max: 10, step: 0.5, group: "general", desc: "An enemy seen within this many seconds keeps the bot in combat-move" },
  hearMemory: { def: 2, min: 0.5, max: 6, step: 0.5, group: "general", desc: "Seconds a heard enemy sound keeps counting" },
  hearRange: { def: 160, min: 40, max: 400, step: 20, group: "general", desc: "Heard enemies count when their estimated distance (near 40, mid 110, far 250 m) is below this" },
  mvRingFrac: { def: 0.78, min: 0.5, max: 0.9, step: 0.02, group: "move", desc: "Patrol loop radius as a fraction of the planning circle (close to but inside the edge)" },
  mvRingBand: { def: 0.1, min: 0.02, max: 0.3, step: 0.02, group: "move", desc: "Loop points may sit this fraction of the radius off the ring, to reach better-scoring ground" },
  mvSectors: { def: 12, min: 6, max: 24, step: 2, int: true, group: "move", desc: "Number of loop points around the ring" },
  mvRingScoreW: { def: 2, min: 0, max: 6, step: 0.5, group: "move", desc: "Weight of point score vs staying exactly on the ring when placing loop points" },
  mvLookahead: { def: 25, min: 0, max: 60, step: 5, group: "general", desc: "Plan on the zone circle as it will be this many seconds from now (never caught by a shrink)" },
  mvReach: { def: 6, min: 2, max: 15, step: 1, group: "move", desc: "A loop point counts as passed within this distance (m)" },
  mvLowThr: { def: 0.35, min: 0, max: 0.8, step: 0.05, group: "move", desc: "Route cells scoring below this (0..1 scale) count as low" },
  mvLowW: { def: 2, min: 0, max: 10, step: 0.5, group: "move", desc: "Extra route cost through low cells (per unit below the threshold)" },
  mvMaxLowStretch: { def: 60, min: 10, max: 300, step: 10, group: "move", desc: "Reject routes with a continuous low stretch longer than this (m)" },
  mvHop: { def: 1, min: 0, max: 1, step: 1, int: true, group: "move", desc: "1 = hop while walking straight stretches (fewer footstep sounds, harder to hit)" },
  mvSweep: { def: 0.8, min: 0, max: 1, step: 0.1, group: "move", desc: "View sweep half-width (rad) around the walking direction (< 1.05 keeps the path in the 120\xB0 view)" },
  mvSweepPeriod: { def: 2.4, min: 0.6, max: 6, step: 0.3, group: "move", desc: "Seconds per full view sweep" },
  mvCornerLook: { def: 18, min: 0, max: 50, step: 4, group: "move", desc: "Within this distance of a turn in the route, look around the corner instead of sweeping (m)" },
  mvWCube: { def: 1.2, min: 0, max: 4, step: 0.2, group: "move", desc: "Value of a cube" },
  mvWWeapon: { def: 1, min: 0, max: 4, step: 0.2, group: "move", desc: "Value of a weapon it wants" },
  mvWCrate: { def: 0.6, min: 0, max: 4, step: 0.2, group: "move", desc: "Value of a crate (1 cube, half the time a weapon)" },
  mvWDrop: { def: 2.5, min: 0, max: 8, step: 0.5, group: "move", desc: "Value of a landed supply drop (3 cubes, full HP and energy)" },
  mvWSpot: { def: 1, min: 0, max: 4, step: 0.2, group: "move", desc: "Weight of the best point score near the item (a safe place to take it from)" },
  mvWItemDist: { def: 1, min: 0, max: 4, step: 0.2, group: "move", desc: "Cost per 100 m of detour" },
  mvItemThresh: { def: 0.2, min: -1, max: 3, step: 0.1, group: "move", desc: "Go for an item when its value minus costs is above this" },
  mvLockMax: { def: 25, min: 5, max: 90, step: 5, group: "move", desc: "Longest it stays locked onto one item before choosing again (s)" },
  mvItemRange: { def: 150, min: 30, max: 250, step: 10, group: "move", desc: "Consider loot up to this far away (m)" },
  mvCrateFire: { def: 1, min: 0, max: 1, step: 1, int: true, group: "move", desc: "1 = shoot crates seen in front while walking (torso turns, legs keep the route)" },
  mvCrateFireRange: { def: 80, min: 20, max: 200, step: 10, group: "move", desc: "Shoot crates in front up to this far (m)" },
  mvCrateCone: { def: 0.9, min: 0.2, max: 1.6, step: 0.1, group: "move", desc: "'In front' = within this angle of the walking direction (rad)" },
  mvCrateShoot: { def: 35, min: 10, max: 80, step: 5, group: "move", desc: "Shoot crates from the best point within this distance of them (m)" },
  cbBias: { def: 0, min: -3, max: 3, step: 0.2, group: "combat", desc: "Baseline lean toward fighting (+) or backing off (-)" },
  cbWHp: { def: 1.5, min: 0, max: 5, step: 0.25, group: "combat", desc: "Per 1000 HP I have more than the target" },
  cbWThird: { def: 1.2, min: 0, max: 4, step: 0.2, group: "combat", desc: "Target is facing and fighting another mech" },
  cbWMatchup: { def: 0.6, min: 0, max: 3, step: 0.2, group: "combat", desc: "Weapon triangle: laser > mortar > lightning > laser" },
  cbWCubes: { def: 0.3, min: 0, max: 2, step: 0.1, group: "combat", desc: "Per 5 cubes I have more than the target" },
  cbWOutnumber: { def: 0.8, min: 0, max: 3, step: 0.2, group: "combat", desc: "Per extra enemy in sight" },
  cbWHurt: { def: 1, min: 0, max: 4, step: 0.2, group: "combat", desc: "Penalty when I'm hurt" },
  cbWRange: { def: 0.4, min: 0, max: 2, step: 0.1, group: "combat", desc: "Bonus when the target is inside my best weapon's range" },
  cbDodge: { def: 1, min: 0, max: 1, step: 1, int: true, group: "combat", desc: "1 = sidestep incoming bullets, shells and aimed laser charges" },
  cbDodgeHorizon: { def: 0.8, min: 0.2, max: 2, step: 0.1, group: "combat", desc: "Look this far ahead for projectiles that will hit (s)" },
  cbDodgeMargin: { def: 1.5, min: 0, max: 5, step: 0.25, group: "combat", desc: "Extra miss distance counted as a hit (m)" },
  cbDodgeJump: { def: 1, min: 0, max: 1, step: 1, int: true, group: "combat", desc: "1 = also jump to dodge" },
  cbCoverDist: { def: 60, min: 15, max: 120, step: 5, group: "combat", desc: "Search this far for cover when backing off (m)" },
  cbCoverScoreW: { def: 0.5, min: 0, max: 3, step: 0.25, group: "combat", desc: "Prefer cover spots with a high point score" },
  cbStrafeMin: { def: 0.6, min: 0.2, max: 3, step: 0.2, group: "combat", desc: "Shortest time between strafe direction changes (s)" },
  cbStrafeMax: { def: 1.4, min: 0.3, max: 5, step: 0.3, group: "combat", desc: "Longest time between strafe direction changes (s)" },
  rangeGun: { def: 60, min: 20, max: 200, step: 10, group: "combat", desc: "Preferred distance with the gun only (m)" },
  rangeLaser: { def: 90, min: 30, max: 200, step: 10, group: "combat", desc: "Preferred distance with a laser (m)" },
  rangeLightning: { def: 30, min: 10, max: 60, step: 5, group: "combat", desc: "Preferred distance with lightning (m)" },
  rangeBand: { def: 10, min: 0, max: 40, step: 5, group: "combat", desc: "Dead band around the preferred distance (m)" },
  cmBias: { def: 0, min: -3, max: 3, step: 0.2, group: "cmove", desc: "Baseline lean toward fighting when the enemy isn't in sight" },
  cmWEdgeFight: { def: 0.8, min: 0, max: 3, step: 0.2, group: "cmove", desc: "Lean toward fighting when right next to a wall edge" },
  cmWNoEdge: { def: 0.8, min: 0, max: 3, step: 0.2, group: "cmove", desc: "Lean toward reaching an edge first when in the open" },
  cmEdgeDist: { def: 6, min: 2, max: 15, step: 1, group: "cmove", desc: "A wall this close counts as 'next to an edge' (m)" },
  cmStealth: { def: 1, min: 0, max: 1, step: 1, int: true, group: "cmove", desc: "1 = walk under 5 m/s (silent) unless rushing" },
  cmAdvance: { def: 0.5, min: 0, max: 1, step: 0.1, group: "cmove", desc: "When leaning to fight, how much to close in (0 = hold and pre-aim, 1 = advance)" }
};
var DEFAULTS = Object.fromEntries(Object.entries(SPACE).map(([k, p]) => [k, p.def]));
var GROUPS = Object.fromEntries(Object.entries(SPACE).map(([k, p]) => [k, p.group]));

class Rng {
  s;
  constructor(seed) {
    this.s = seed >>> 0 || 2654435769;
  }
  next() {
    let t = this.s = this.s + 1831565813 >>> 0;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  range(a, b) {
    return a + (b - a) * this.next();
  }
}
var wrapAngle = (a) => {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0)
    a += 2 * Math.PI;
  return a - Math.PI;
};
var dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
var yawTo = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
var clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function steer(world, pos, yaw, look = 6) {
  for (const off of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.7, -1.7, 2.3, -2.3, Math.PI]) {
    const a = yaw + off;
    let ok = true;
    for (const d of [look * 0.5, look]) {
      const x = pos[0] + Math.cos(a) * d, y = pos[1] + Math.sin(a) * d;
      if (!world.inBounds(x, y, 4) || world.prismWallAt(x, y, pos[2], 9, 1.2) || world.ground(x, y) > pos[2] + 2.5) {
        ok = false;
        break;
      }
    }
    if (ok)
      return a;
  }
  return yaw;
}
var pointsCache;
function loadPoints() {
  if (pointsCache !== undefined)
    return pointsCache;
  pointsCache = null;
  try {
    const fs = process.getBuiltinModule?.("node:fs") ?? globalThis.require?.("node:fs");
    const path = [globalThis.__HAMSTER_POINTS, "bot/points.bin", "points.bin"].filter(Boolean).find((p) => fs.existsSync(p));
    if (!path)
      return null;
    const b = fs.readFileSync(path);
    const f = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const n = f.length >> 2, x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n), s = new Float32Array(n);
    const raw = [];
    for (let k = 0;k < n; k++) {
      x[k] = f[4 * k];
      y[k] = f[4 * k + 1];
      z[k] = f[4 * k + 2];
      raw.push(f[4 * k + 3]);
    }
    const sorted = raw.slice().sort((a, b) => a - b), lo = sorted[Math.floor(n * 0.02)], hi = sorted[Math.floor(n * 0.98)];
    for (let k = 0;k < n; k++)
      s[k] = clamp((raw[k] - lo) / (hi - lo || 1), 0, 1);
    pointsCache = { x, y, z, s };
  } catch {
    pointsCache = null;
  }
  return pointsCache;
}

class Nav {
  static C = 4;
  static STEP = 3.5;
  x0;
  y0;
  nx;
  ny;
  walk;
  gz;
  comp;
  score;
  g;
  parent;
  stamp;
  closed;
  gen = 0;
  heap = [];
  heapF = [];
  constructor(world, pts) {
    const b = world.bounds, C = Nav.C;
    this.x0 = b.minX;
    this.y0 = b.minY;
    this.nx = Math.ceil((b.maxX - b.minX) / C);
    this.ny = Math.ceil((b.maxY - b.minY) / C);
    const N = this.nx * this.ny;
    this.walk = new Uint8Array(N);
    this.gz = new Float32Array(N);
    this.score = new Float32Array(N).fill(0.5);
    for (let j = 0;j < this.ny; j++)
      for (let i = 0;i < this.nx; i++) {
        const x = this.x0 + (i + 0.5) * C, y = this.y0 + (j + 0.5) * C, c = j * this.nx + i;
        this.gz[c] = world.ground(x, y);
        if (!world.inBounds(x, y, 6))
          continue;
        let open = true;
        for (const [dx, dy] of [[0, 0], [-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6], [2.2, 0], [-2.2, 0], [0, 2.2], [0, -2.2]])
          if (world.surfaceTop(x + dx, y + dy) - world.ground(x + dx, y + dy) > 0.5) {
            open = false;
            break;
          }
        if (open)
          this.walk[c] = 1;
      }
    if (pts) {
      const seen = new Uint8Array(N);
      for (let k = 0;k < pts.x.length; k++) {
        const c = this.cellOf(pts.x[k], pts.y[k]);
        if (c >= 0 && (!seen[c] || pts.s[k] > this.score[c])) {
          this.score[c] = pts.s[k];
          seen[c] = 1;
        }
      }
    }
    this.g = new Float32Array(N);
    this.parent = new Int32Array(N);
    this.stamp = new Int32Array(N);
    this.closed = new Int32Array(N);
    this.comp = new Int32Array(N).fill(-1);
    let id = 0;
    for (let s0 = 0;s0 < N; s0++) {
      if (!this.walk[s0] || this.comp[s0] >= 0)
        continue;
      const st = [s0];
      this.comp[s0] = id;
      while (st.length) {
        const c = st.pop(), i = c % this.nx, j = (c - i) / this.nx;
        for (let dj = -1;dj <= 1; dj++)
          for (let di = -1;di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (!di && !dj || ii < 0 || jj < 0 || ii >= this.nx || jj >= this.ny)
              continue;
            const q = jj * this.nx + ii;
            if (this.comp[q] >= 0 || !this.passable(c, q) || di && dj && (!this.walk[j * this.nx + ii] || !this.walk[jj * this.nx + i]))
              continue;
            this.comp[q] = id;
            st.push(q);
          }
      }
      id++;
    }
  }
  cellOf(x, y) {
    const i = Math.floor((x - this.x0) / Nav.C), j = Math.floor((y - this.y0) / Nav.C);
    return i < 0 || j < 0 || i >= this.nx || j >= this.ny ? -1 : j * this.nx + i;
  }
  center(c) {
    return [this.x0 + (c % this.nx + 0.5) * Nav.C, this.y0 + (Math.floor(c / this.nx) + 0.5) * Nav.C];
  }
  scoreAt(x, y) {
    const c = this.cellOf(x, y);
    return c < 0 ? 0 : this.score[c];
  }
  walkable(x, y) {
    const c = this.cellOf(x, y);
    return c >= 0 && this.walk[c] === 1;
  }
  passable(a, b) {
    return this.walk[b] && Math.abs(this.gz[a] - this.gz[b]) < Nav.STEP;
  }
  nearest(x, y, maxR, inComp = -1) {
    const ok = (c) => this.walk[c] && (inComp < 0 || this.comp[c] === inComp);
    const c0 = this.cellOf(x, y);
    if (c0 >= 0 && ok(c0))
      return c0;
    const i0 = Math.floor((x - this.x0) / Nav.C), j0 = Math.floor((y - this.y0) / Nav.C);
    for (let r = 1;r <= maxR; r++) {
      let best = -1, bd = Infinity;
      for (let dj = -r;dj <= r; dj++)
        for (let di = -r;di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r)
            continue;
          const i = i0 + di, j = j0 + dj;
          if (i < 0 || j < 0 || i >= this.nx || j >= this.ny)
            continue;
          const c = j * this.nx + i;
          if (!ok(c))
            continue;
          const [cx, cy] = this.center(c), d = (cx - x) ** 2 + (cy - y) ** 2;
          if (d < bd) {
            bd = d;
            best = c;
          }
        }
      if (best >= 0)
        return best;
    }
    return -1;
  }
  straight(a, b) {
    const [ax, ay] = this.center(a), [bx, by] = this.center(b), n = Math.ceil(Math.hypot(bx - ax, by - ay) / 1.5);
    let prev = a;
    for (let k = 1;k <= n; k++) {
      const c = this.cellOf(ax + (bx - ax) * k / n, ay + (by - ay) * k / n);
      if (c < 0 || !this.walk[c] || Math.abs(this.gz[c] - this.gz[prev]) >= Nav.STEP)
        return false;
      prev = c;
    }
    return true;
  }
  push(c, f) {
    const h = this.heap, hf = this.heapF;
    h.push(c);
    hf.push(f);
    let i = h.length - 1;
    while (i > 0) {
      const p = i - 1 >> 1;
      if (hf[p] <= hf[i])
        break;
      [h[p], h[i]] = [h[i], h[p]];
      [hf[p], hf[i]] = [hf[i], hf[p]];
      i = p;
    }
  }
  pop() {
    const h = this.heap, hf = this.heapF, top = h[0], lc = h.pop(), lf = hf.pop();
    if (h.length) {
      h[0] = lc;
      hf[0] = lf;
      let i = 0;
      for (;; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && hf[l] < hf[m])
          m = l;
        if (r < h.length && hf[r] < hf[m])
          m = r;
        if (m === i)
          break;
        [h[m], h[i]] = [h[i], h[m]];
        [hf[m], hf[i]] = [hf[i], hf[m]];
        i = m;
      }
    }
    return top;
  }
  path(from, to, cost) {
    const s = this.nearest(from[0], from[1], 8);
    const goal = s < 0 ? -1 : this.nearest(to[0], to[1], 16, this.comp[s]);
    if (s < 0 || goal < 0)
      return null;
    const gen = ++this.gen;
    this.heap.length = 0;
    this.heapF.length = 0;
    const [gx, gy] = this.center(goal), hOf = (c) => {
      const [x, y] = this.center(c);
      return Math.hypot(x - gx, y - gy);
    };
    this.stamp[s] = gen;
    this.g[s] = 0;
    this.parent[s] = -1;
    this.push(s, hOf(s));
    let expanded = 0, found = false;
    while (this.heap.length) {
      const c = this.pop();
      if (this.closed[c] === gen)
        continue;
      this.closed[c] = gen;
      if (c === goal) {
        found = true;
        break;
      }
      if (++expanded > 25000)
        break;
      const i = c % this.nx, j = (c - i) / this.nx;
      for (let dj = -1;dj <= 1; dj++)
        for (let di = -1;di <= 1; di++) {
          if (!di && !dj)
            continue;
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.ny)
            continue;
          const n = jj * this.nx + ii;
          if (!this.passable(c, n) || di && dj && (!this.walk[j * this.nx + ii] || !this.walk[jj * this.nx + i]))
            continue;
          const ng = this.g[c] + (di && dj ? 1.4142 : 1) * Nav.C * (cost ? cost(n) : 1);
          if (this.stamp[n] === gen && ng >= this.g[n])
            continue;
          this.stamp[n] = gen;
          this.g[n] = ng;
          this.parent[n] = c;
          this.push(n, ng + hOf(n));
        }
    }
    if (!found)
      return null;
    const cells = [];
    for (let c = goal;c !== -1; c = this.parent[c])
      cells.push(c);
    cells.reverse();
    const out = [cells[0]];
    let k = 0;
    while (k < cells.length - 1) {
      let far = k + 1;
      for (let m = Math.min(cells.length - 1, k + (cost ? 6 : 16));m > k + 1; m--)
        if (this.straight(cells[k], cells[m])) {
          far = m;
          break;
        }
      out.push(cells[far]);
      k = far;
    }
    return { pts: out.slice(1).map((c) => this.center(c)), cells };
  }
}
var navCache = new WeakMap;
var warmedUp = false;
var navFor = (w) => {
  let n = navCache.get(w);
  if (!n) {
    n = new Nav(w, loadPoints());
    navCache.set(w, n);
  }
  return n;
};
var PROF = {};
function timed(name, f) {
  if (!globalThis.__MODES_PROF)
    return f();
  const t0 = performance.now();
  try {
    return f();
  } finally {
    const d = performance.now() - t0, e = PROF[name] ??= { n: 0, ms: 0, max: 0, over5: 0 };
    e.n++;
    e.ms += d;
    if (d > e.max)
      e.max = d;
    if (d > 5)
      e.over5++;
  }
}
var MOVE = 0;
var COMBAT = 1;
var CMOVE = 2;
var MODE_NAMES = ["move", "combat", "combat-move"];
var ENEMY_SOUNDS = new Set(["gun", "laser", "laser_charge", "lightning", "mortar", "explosion", "step", "boost", "jet", "reload"]);
var SOUND_DIST = { near: 40, mid: 110, far: 250 };
var BEATS = { laser: "mortar", mortar: "lightning", lightning: "laser" };
function makeBot(hello, world, params) {
  const p = { ...DEFAULTS, ...params ?? {} };
  const cfg = hello.config, vis = cfg.vision;
  const rng = new Rng(hello.seed);
  const pts = loadPoints();
  const nav = navFor(world);
  const rank = { laser: p.rankLaser, lightning: p.rankLightning, mortar: p.rankMortar, gun: 0 };
  const upgradePref = ["armor", "plating", "nanites", "sensors", "laser_charge", "laser_damage", "gun_rate", "gun_damage", "lightning_efficiency", "gyros", "servos"];
  const stats = {
    ticks: [0, 0, 0],
    move: { cubes: 0, weapons: 0, crateDmg: 0, drops: 0, fightsStarted: 0, dmgTaken: 0 },
    combat: { episodes: 0, survived: 0, kills: 0, dmgDealt: 0, dmgTaken: 0, open: false },
    cmove: { episodes: 0, survived: 0, kills: 0, dmgDealt: 0, dmgTaken: 0, open: false, ambushes: 0 }
  };
  const tracks = new Map;
  let heard = [];
  let mode = MOVE, prevMode = MOVE, cmoveSince = -1;
  let strafe = 1, strafeT = 0;
  let threatYaw = null, threatT = -99;
  let ring = [], ringIdx = -1, ringC = [0, 0], ringR = 0, ringT = -99, ringSkips = 0;
  const ringDir = rng.next() < 0.5 ? 1 : -1;
  let route = [], routeCells = [], routeIdx = 0, routeGoal = null, routeT = -99, routeScored = false;
  let stuckRef = [0, 0, 0], stuckT = 0, strikes = 0, noRoute = false, jetUntil = -99;
  let itemGoal = null, itemT = -99, lockT = -99;
  let cover = null;
  let lastCubes = 0;
  const seesNow = (me, q) => {
    const eye = [me.pos[0], me.pos[1], me.pos[2] + (me.stats.eye_height ?? 8)];
    const near = vis.near_range + (me.stats.near_range_bonus ?? 0), far = vis.range + (me.stats.vision_bonus ?? 0);
    for (const h of [4.5, 9]) {
      const t = [q[0], q[1], q[2] + h], d = Math.hypot(t[0] - eye[0], t[1] - eye[1], t[2] - eye[2]);
      if (d <= near) {
        if (world.clearLine(eye, t))
          return true;
        continue;
      }
      if (d > far || Math.abs(wrapAngle(Math.atan2(t[1] - eye[1], t[0] - eye[0]) - me.aim[0])) > vis.fov_deg * Math.PI / 360)
        continue;
      if (world.clearLine(eye, t) && !(vis.canopy_blocks && world.canopyBlocks(eye[0], eye[1], eye[2], t[0], t[1], t[2])))
        return true;
    }
    return false;
  };
  const blockedAt = (me, x, y, z) => {
    const st = me.stats, r = st.radius ?? 2.5, rise = r * Math.tan((st.max_slope_deg ?? 50) * Math.PI / 180);
    for (let k = 0;k < 9; k++) {
      const px = k === 0 ? x : x + r * Math.cos((k - 1) * Math.PI / 4), py = k === 0 ? y : y + r * Math.sin((k - 1) * Math.PI / 4);
      if (world.ground(px, py) > z + (st.step_up ?? 1.2) + (k === 0 ? 0 : rise) || world.prismWallAt(px, py, z, st.height ?? 9, st.step_up ?? 1.2))
        return true;
    }
    return !world.inBounds(x, y, r);
  };
  const freeHeading = (me, yaw) => {
    const P = me.pos;
    if (!me.grounded)
      return yaw;
    for (const off of [0, 0.15, -0.15, 0.3, -0.3, 0.5, -0.5, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.2, -2.2]) {
      const a = yaw + off;
      if (!blockedAt(me, P[0] + Math.cos(a) * 0.6, P[1] + Math.sin(a) * 0.6, P[2]) && !blockedAt(me, P[0] + Math.cos(a) * 1.5, P[1] + Math.sin(a) * 1.5, P[2]))
        return a;
    }
    return yaw;
  };
  const nearEdge = (P) => {
    for (let k = 0;k < 8; k++) {
      const a = k * Math.PI / 4;
      for (const r of [2, p.cmEdgeDist / 2, p.cmEdgeDist])
        if (world.prismWallAt(P[0] + Math.cos(a) * r, P[1] + Math.sin(a) * r, P[2], 9, 1.2))
          return true;
    }
    return false;
  };
  const fightingOther = (e, eid, others, me) => {
    let best = 0;
    for (const [oid, o] of others) {
      if (oid === eid)
        continue;
      const d = dist(e.pos, o.pos), off = Math.abs(wrapAngle(e.aim[0] - yawTo(e.pos, o.pos)));
      if (d < 230 && off < 0.25 && Math.abs(wrapAngle(e.aim[0] - yawTo(e.pos, me))) > 0.4)
        best = 1;
    }
    return best;
  };
  const matchup = (mine, theirs) => {
    let s = 0;
    for (const a of mine)
      for (const b of theirs) {
        if (BEATS[a] === b)
          s += 1;
        if (BEATS[b] === a)
          s -= 1;
      }
    return clamp(s, -2, 2);
  };
  const engageScore = (me, eid, e, visibleCount, all, held) => {
    const myRange = Math.max(...held.map((k) => k === "laser" ? 280 : k === "lightning" ? 45 : k === "mortar" ? 235 : 230));
    return p.cbBias + p.cbWHp * (me.hp - e.hp) / 1000 + p.cbWThird * fightingOther(e, eid, all, me.pos) + p.cbWMatchup * matchup(held, e.weapons) + p.cbWCubes * (me.cubes - e.cubes) / 5 - p.cbWOutnumber * Math.max(0, visibleCount - 1) - p.cbWHurt * (me.hp < me.max_hp * p.hurtFrac ? 1 : 0) + p.cbWRange * (dist(e.pos, me.pos) <= myRange ? 1 : 0);
  };
  const dodge = (me, obs) => timed("dodge", () => dodge_(me, obs));
  const dodge_ = (me, obs) => {
    const c = [me.pos[0], me.pos[1], me.pos[2] + 4.5], R = (me.stats.radius ?? 2.5) + p.cbDodgeMargin;
    let best = null;
    for (const pr of obs.projectiles) {
      const v = pr.vel;
      if (pr.kind === "mortar") {
        const g = cfg.weapons?.mortar?.gravity ?? 22;
        let x = pr.pos[0], y = pr.pos[1], z = pr.pos[2], vz = v[2];
        for (let t = 0;t < 4; t += 0.05) {
          x += v[0] * 0.05;
          y += v[1] * 0.05;
          vz -= g * 0.05;
          z += vz * 0.05;
          if (z <= world.surfaceTop(x, y)) {
            const d = Math.hypot(x - c[0], y - c[1]), splash = (cfg.weapons?.mortar?.splash_radius ?? 7) + p.cbDodgeMargin;
            if (d < splash && (!best || t < best.t)) {
              const a = Math.atan2(c[1] - y, c[0] - x);
              best = { dir: [Math.cos(a), Math.sin(a)], jump: false, t };
            }
            break;
          }
        }
        continue;
      }
      const r = [c[0] - pr.pos[0], c[1] - pr.pos[1], c[2] - pr.pos[2]], vv = v[0] ** 2 + v[1] ** 2 + v[2] ** 2;
      const tc = (r[0] * v[0] + r[1] * v[1] + r[2] * v[2]) / (vv || 1);
      if (tc <= 0 || tc > p.cbDodgeHorizon)
        continue;
      const off = [r[0] - v[0] * tc, r[1] - v[1] * tc];
      if (Math.hypot(off[0], off[1], r[2] - v[2] * tc) > R)
        continue;
      const n = Math.hypot(v[0], v[1]) || 1, perp = [-v[1] / n, v[0] / n];
      const side = off[0] * perp[0] + off[1] * perp[1] >= 0 ? 1 : -1;
      if (!best || tc < best.t)
        best = { dir: [perp[0] * side, perp[1] * side], jump: true, t: tc };
    }
    for (const m of obs.mechs) {
      if (m.kind !== "mech" || !m.charging)
        continue;
      const off = wrapAngle(yawTo(m.pos, me.pos) - m.aim[0]);
      if (Math.abs(off) < 0.12) {
        const a = yawTo(m.pos, me.pos) + (off >= 0 ? 1 : -1) * Math.PI / 2;
        if (!best)
          best = { dir: [Math.cos(a), Math.sin(a)], jump: true, t: 1 };
      }
    }
    return best && { dir: best.dir, jump: best.jump };
  };
  const findCover = (P, from, zc, zr) => timed("findCover", () => findCover_(P, from, zc, zr));
  const findCover_ = (P, from, zc, zr) => {
    let best = null, bs = -Infinity;
    const eye = [from[0], from[1], from[2] + 8];
    for (let r = 8;r <= p.cbCoverDist; r += 8)
      for (let k = 0;k < 16; k++) {
        const a = k * Math.PI / 8, x = P[0] + Math.cos(a) * r, y = P[1] + Math.sin(a) * r;
        if (!nav.walkable(x, y) || Math.hypot(x - zc[0], y - zc[1]) > zr)
          continue;
        const z = world.ground(x, y);
        if (world.clearLine(eye, [x, y, z + 4.5]))
          continue;
        const s = -r / p.cbCoverDist + p.cbCoverScoreW * nav.scoreAt(x, y) - 0.5 * (dist([x, y], from) < dist(P, from) ? 1 : 0);
        if (s > bs) {
          bs = s;
          best = [x, y, z];
        }
      }
    return best;
  };
  const shoot = (me, tgt, act) => {
    const P = me.pos, d = dist(tgt.pos, P);
    const gun = me.weapons.find((w) => w?.kind === "gun");
    const tc = [tgt.pos[0], tgt.pos[1], tgt.pos[2] + (tgt.kind === "npc" ? 1.75 : 4.5)], mz = [P[0], P[1], P[2] + (me.stats.muzzle_height ?? 7)];
    const lead = Math.hypot(tc[0] - mz[0], tc[1] - mz[1], tc[2] - mz[2]) / (gun?.stats.speed ?? 252);
    const pt = [tc[0] + tgt.vel[0] * lead, tc[1] + tgt.vel[1] * lead, tc[2] + tgt.vel[2] * lead];
    let yaw = yawTo(mz, pt), pitch = Math.atan2(pt[2] - mz[2], dist(pt, mz));
    const err = Math.abs(wrapAngle(yaw - me.aim[0])) + Math.abs(pitch - me.aim[1]), toT = yawTo(P, tgt.pos);
    me.weapons.forEach((w, i) => {
      if (!w)
        return;
      if (w.kind === "gun")
        act.fire[i] = err < p.gunAimTol && d < (w.stats.range ?? 230);
      else if (w.kind === "lightning")
        act.fire[i] = d < (w.stats.range ?? 45) - 3 && Math.abs(wrapAngle(toT - me.aim[0])) < p.lightningCone && me.energy > p.lightningEnergyMin;
      else if (w.kind === "laser") {
        const full = (w.charge ?? 0) >= (w.stats.charge ?? 0.75) - 0.01;
        act.fire[i] = d < (w.stats.range ?? 280) && !(full && err < p.laserAimTol);
      } else if (w.kind === "mortar") {
        const v = w.stats.speed ?? 72, g = w.stats.gravity ?? 22, s = v ** 4 - g * g * d * d;
        if (d > p.mortarMinDist && s > 0) {
          pitch = Math.atan((v * v - Math.sqrt(s)) / (g * d));
          act.fire[i] = Math.abs(wrapAngle(toT - me.aim[0])) < 0.05;
        }
      }
    });
    return [yaw, pitch];
  };
  const headTo = (P, goal, t, scored) => timed("headTo", () => headTo_(P, goal, t, scored));
  const headTo_ = (P, goal, t, scored) => {
    if (dist(goal, P) < 12)
      return steer(world, P, yawTo(P, goal));
    if (!routeGoal || dist(routeGoal, goal) > 8 || t - routeT > 10 || routeScored !== scored) {
      const r = nav.path(P, goal, scored ? (c) => 1 + p.mvLowW * Math.max(0, p.mvLowThr - nav.score[c]) / Math.max(0.05, p.mvLowThr) : undefined);
      route = r?.pts ?? [];
      routeCells = r?.cells ?? [];
      routeIdx = 0;
      routeGoal = goal;
      routeT = t;
      routeScored = scored;
    }
    if (!route.length) {
      noRoute = true;
      return yawTo(P, goal);
    }
    while (routeIdx < route.length - 1 && dist(route[routeIdx], P) < 4)
      routeIdx++;
    return yawTo(P, route[routeIdx]);
  };
  const lowStretch = (cells) => {
    let run = 0, best = 0;
    for (const c of cells) {
      if (nav.score[c] < p.mvLowThr) {
        run += Nav.C;
        best = Math.max(best, run);
      } else
        run = 0;
    }
    return best;
  };
  const buildRing = (c, R, t) => timed("buildRing", () => buildRing_(c, R, t));
  const buildRing_ = (c, R, t) => {
    const S = Math.round(p.mvSectors), rr = Math.min(p.mvRingFrac * R, ringMax), band = Math.max(4, Math.min(p.mvRingBand * R, ringMax * 0.25));
    const best = Array.from({ length: S }, () => ({ v: -Infinity, pt: [] }));
    if (pts)
      for (let k = 0;k < pts.x.length; k++) {
        const x = pts.x[k], y = pts.y[k], r = Math.hypot(x - c[0], y - c[1]);
        if (Math.abs(r - rr) > band || r > ringMax || !nav.walkable(x, y))
          continue;
        const a = Math.atan2(y - c[1], x - c[0]), sec = (Math.floor((a + Math.PI) / (2 * Math.PI) * S) % S + S) % S;
        const v = p.mvRingScoreW * pts.s[k] - Math.abs(r - rr) / band;
        if (v > best[sec].v)
          best[sec] = { v, pt: [x, y, pts.z[k], pts.s[k]] };
      }
    ring = [];
    for (let sec = 0;sec < S; sec++) {
      if (best[sec].pt.length) {
        ring.push(best[sec].pt);
        continue;
      }
      const a = -Math.PI + (sec + 0.5) / S * 2 * Math.PI, x = c[0] + Math.cos(a) * rr, y = c[1] + Math.sin(a) * rr;
      if (nav.walkable(x, y))
        ring.push([x, y, world.ground(x, y), nav.scoreAt(x, y)]);
    }
    ringC = c;
    ringR = R;
    ringT = t;
    ringIdx = -1;
  };
  let zcNow = [0, 0], zrNow = 1e9, ringMax = 1e9;
  const crateMinDist = (me) => Math.max(10, ((me.stats.muzzle_height ?? 7) - 1.2) / Math.tan(-(cfg.mech?.min_pitch ?? -0.7) - 0.1) + 2);
  let crateId = -1, crateSince = -99, crateHitT = -99, nowT = 0;
  const badCrates = new Map;
  const pickItem = (me, obs, held, worst) => timed("pickItem", () => pickItem_(me, obs, held, worst));
  const wants = (kind, held, worst) => {
    if (held.includes(kind))
      return false;
    if (kind === "gun" && held.filter((k) => k && k !== "gun").length >= 2)
      return false;
    return held[1] === null || rank[kind] > rank[held[worst]];
  };
  const pickItem_ = (me, obs, held, worst) => {
    const P = me.pos;
    let best = null, bv = p.mvItemThresh;
    const minD = crateMinDist(me);
    const spotNear = (q, R, needLos) => {
      let s = nav.scoreAt(q[0], q[1]), at = q;
      if (needLos) {
        s = -Infinity;
        const a0 = yawTo(q, P), x = q[0] + Math.cos(a0) * (minD + 2), y = q[1] + Math.sin(a0) * (minD + 2);
        if (nav.walkable(x, y) && world.clearLine([x, y, world.ground(x, y) + 7], [q[0], q[1], q[2] + 1.2])) {
          s = nav.scoreAt(x, y);
          at = [x, y, world.ground(x, y)];
        }
      }
      for (let r = needLos ? Math.ceil(minD / 4) * 4 : 8;r <= (needLos ? Math.max(R, minD + 12) : R); r += needLos ? 4 : 8)
        for (let k = 0;k < 8; k++) {
          const a = k * Math.PI / 4, x = q[0] + Math.cos(a) * r, y = q[1] + Math.sin(a) * r;
          if (!nav.walkable(x, y))
            continue;
          const sc = nav.scoreAt(x, y);
          if (sc > s && (!needLos || world.clearLine([x, y, world.ground(x, y) + 7], [q[0], q[1], q[2] + 1.2]))) {
            s = sc;
            at = [x, y, world.ground(x, y)];
          }
        }
      return { s, at };
    };
    const consider = (pos, kind, id, w, shoot, wkind) => {
      const d = dist(pos, P);
      if (d > p.mvItemRange || Math.abs(pos[2] - P[2]) > 6 || dist(pos, zcNow) > zrNow * 0.9)
        return;
      const spot = spotNear(pos, shoot ? p.mvCrateShoot : 8, shoot);
      if (!Number.isFinite(spot.s))
        return;
      const v = w + p.mvWSpot * spot.s - p.mvWItemDist * d / 100;
      if (v > bv) {
        bv = v;
        best = { pos, kind, id, shootFrom: shoot ? spot.at : undefined, wkind };
      }
    };
    for (const c of obs.cubes)
      consider(c.pos, "cube", c.id, p.mvWCube, false);
    for (const k of obs.pickups)
      if (wants(k.kind, held, worst))
        consider(k.pos, "weapon", k.id, p.mvWWeapon, false, k.kind);
    for (const c of obs.crates)
      if ((badCrates.get(c.id) ?? -1) < nowT)
        consider(c.pos, "crate", c.id, p.mvWCrate, true);
    for (const d of obs.drops)
      if (d.lands_in <= 0 && d.holder === null)
        consider(d.pos, "drop", d.id, p.mvWDrop, false);
    return best;
  };
  const closeEpisode = (m, alive) => {
    if (m === COMBAT && stats.combat.open) {
      stats.combat.open = false;
      if (alive)
        stats.combat.survived++;
    }
    if (m === CMOVE && stats.cmove.open) {
      stats.cmove.open = false;
      if (alive)
        stats.cmove.survived++;
    }
  };
  if (!warmedUp) {
    warmedUp = true;
    const b = world.bounds, c = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    const cost = (cell) => 1 + p.mvLowW * Math.max(0, p.mvLowThr - nav.score[cell]) / Math.max(0.05, p.mvLowThr);
    for (let k = 0;k < 6; k++) {
      buildRing_(c, 150 + 60 * k, 0);
      for (let i = 0;i < ring.length; i++) {
        const a0 = ring[i], a1 = ring[(i + 1) % ring.length], a2 = ring[(i + (ring.length >> 1)) % ring.length];
        nav.path(a0, a1, cost);
        nav.path(a0, a2, i % 2 ? cost : undefined);
        if (i % 3 === 0)
          findCover_(a0, a2, c, 400);
      }
    }
    ring = [];
    ringIdx = -1;
    ringC = [0, 0];
    ringR = 0;
    ringT = -99;
  }
  return {
    name: "hamster-modes",
    stats,
    get mode() {
      return mode;
    },
    get itemGoal() {
      return itemGoal;
    },
    act(obs) {
      const me = obs.self, P = me.pos, t = obs.t;
      nowT = t;
      const act = { tick: obs.tick, fire: [false, false] };
      if (obs.offer) {
        let b = 0, bs = 99;
        obs.offer.choices.forEach((c, i) => {
          const s = upgradePref.indexOf(c.id);
          const sc = s < 0 ? 50 : s;
          if (sc < bs) {
            bs = sc;
            b = i;
          }
        });
        act.pick = b;
      }
      const bucket = mode === COMBAT ? stats.combat : mode === CMOVE ? stats.cmove : null;
      for (const e of obs.events) {
        if (e.type === "damaged") {
          if (mode === MOVE)
            stats.move.dmgTaken += e.amount;
          else
            bucket.dmgTaken += e.amount;
          if (e.bearing !== null && e.by !== null) {
            threatYaw = e.bearing;
            threatT = t;
            heard.push({ t, bearing: e.bearing, est: 100 });
          }
        } else if (e.type === "hit") {
          if (e.target >= 1000 && e.target < 5000) {
            crateHitT = t;
            if (mode === MOVE)
              stats.move.crateDmg += e.amount;
          } else if (bucket && e.target < 100)
            bucket.dmgDealt += e.amount;
        } else if (e.type === "kill") {
          if (bucket)
            bucket.kills++;
        } else if (e.type === "took" && mode === MOVE)
          stats.move.weapons++;
        else if (e.type === "drop")
          stats.move.drops++;
      }
      if (me.cubes > lastCubes && mode === MOVE)
        stats.move.cubes += me.cubes - lastCubes;
      lastCubes = me.cubes;
      const enemies = obs.mechs.filter((m) => m.kind === "mech");
      const visible = [];
      for (const m of enemies) {
        const tr = tracks.get(m.id) ?? { seen: -99, pos: m.pos, vel: m.vel, aim: m.aim, hp: m.hp ?? 1400, weapons: m.weapons ?? [], cubes: m.cubes ?? 0, charging: !!m.charging };
        Object.assign(tr, { pos: m.pos, vel: m.vel, aim: m.aim, hp: m.hp ?? tr.hp, weapons: m.weapons ?? tr.weapons, cubes: m.cubes ?? tr.cubes, charging: !!m.charging });
        if (seesNow(me, m.pos)) {
          tr.seen = t;
          visible.push(m.id);
        }
        tracks.set(m.id, tr);
      }
      for (const s of obs.sounds)
        if (ENEMY_SOUNDS.has(s.kind))
          heard.push({ t: t - s.age, bearing: s.bearing, est: SOUND_DIST[s.dist] ?? 250 });
      heard = heard.filter((h) => t - h.t <= p.hearMemory);
      const recent = [...tracks.entries()].filter(([id, tr]) => !visible.includes(id) && t - tr.seen <= p.recentS);
      const heardNear = heard.filter((h) => h.est <= p.hearRange);
      prevMode = mode;
      mode = visible.length ? COMBAT : recent.length || heardNear.length ? CMOVE : MOVE;
      stats.ticks[mode]++;
      if (mode !== MOVE)
        itemGoal = null;
      if (mode !== prevMode) {
        closeEpisode(prevMode, true);
        if (mode === COMBAT) {
          stats.combat.episodes++;
          stats.combat.open = true;
          if (prevMode === MOVE)
            stats.move.fightsStarted++;
          if (prevMode === CMOVE && t - cmoveSince < 20)
            stats.cmove.ambushes++;
        }
        if (mode === CMOVE) {
          stats.cmove.episodes++;
          stats.cmove.open = true;
          cmoveSince = t;
        }
      }
      const held = me.weapons.map((w) => w?.kind ?? null);
      const worst = held[1] === null ? 1 : rank[held[0]] <= rank[held[1]] ? 0 : 1;
      for (const k of obs.pickups)
        if (dist(k.pos, P) < cfg.loot.pickup_radius && Math.abs(k.pos[2] - P[2]) < 4 && wants(k.kind, held, worst)) {
          act.take = k.id;
          if (held[1] !== null)
            act.drop = worst;
          break;
        }
      const z = obs.zone;
      const circleAt = (tt) => {
        const f = clamp((tt - z.shrink_start) / Math.max(0.000001, z.shrink_end - z.shrink_start), 0, 1);
        return { c: [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f], r: z.radius + (z.next_radius - z.radius) * f };
      };
      const live = circleAt(t), safe = circleAt(t + p.mvLookahead + (t > z.shrink_start - p.shrinkLead ? p.shrinkLead : 0));
      const { c: zc, r: zrFull } = safe;
      const outside = dist(P, live.c) > live.r * p.zoneMargin || dist(P, safe.c) > safe.r * p.nextZoneMargin;
      const outsideHard = dist(P, live.c) > live.r - 3 || dist(P, safe.c) > safe.r;
      ringMax = Math.max(0.2 * safe.r, Math.min(p.nextZoneMargin * safe.r, p.zoneMargin * live.r - dist(safe.c, live.c)) - 4);
      zcNow = zc;
      zrNow = zrFull;
      const hurt = me.hp < me.max_hp * p.hurtFrac;
      const heldKinds = held.filter(Boolean);
      noRoute = false;
      let move = [0, 0], speed = 1;
      let aim = [me.aim[0], 0];
      let label = MODE_NAMES[mode];
      let climbTo = null;
      const lines = [];
      if (mode === COMBAT) {
        const all = [...tracks.entries()].filter(([id]) => visible.includes(id));
        const lastHitter = threatT > t - 2 ? all.find(([, tr]) => Math.abs(wrapAngle(yawTo(P, tr.pos) - (threatYaw ?? 0))) < 0.3) : undefined;
        const [tid, tgt] = lastHitter ?? all.sort((a, b) => dist(a[1].pos, P) - dist(b[1].pos, P))[0];
        const E = engageScore(me, tid, tgt, visible.length, all, heldKinds);
        aim = shoot(me, { pos: tgt.pos, vel: tgt.vel }, act);
        const d = dist(tgt.pos, P), toT = yawTo(P, tgt.pos);
        if (t - strafeT > rng.range(Math.min(p.cbStrafeMin, p.cbStrafeMax), Math.max(p.cbStrafeMin, p.cbStrafeMax))) {
          strafe = -strafe;
          strafeT = t;
        }
        if (E > 0 && !outside) {
          const pref = hurt ? 140 : held.includes("lightning") ? p.rangeLightning : held.includes("laser") ? p.rangeLaser : p.rangeGun;
          const radial = d > pref + p.rangeBand ? 1 : d < pref - p.rangeBand ? -1 : 0;
          const a = steer(world, P, Math.atan2(Math.sin(toT) * radial + Math.sin(toT + Math.PI / 2) * strafe, Math.cos(toT) * radial + Math.cos(toT + Math.PI / 2) * strafe));
          move = [Math.cos(a), Math.sin(a)];
          label = `combat: fight #${tid} (E ${E.toFixed(1)})`;
        } else {
          if (!cover || t - cover.t > 1 || dist(cover.from, tgt.pos) > 15)
            cover = { pos: findCover(P, tgt.pos, zc, zrFull * 0.95) ?? zc, t, from: tgt.pos };
          const a = headTo(P, cover.pos, t, false);
          move = [Math.cos(a), Math.sin(a)];
          label = `combat: back off to cover (E ${E.toFixed(1)})`;
          lines.push({ a: [P[0], P[1], P[2] + 4.5], b: [cover.pos[0], cover.pos[1], cover.pos[2] + 1], color: "#ff8a5b" });
        }
        if (me.hp < me.max_hp * 0.5 && me.energy > 30 && E <= 0)
          act.boost = true;
      } else if (mode === CMOVE) {
        const rec = recent.sort((a, b) => b[1].seen - a[1].seen)[0];
        const h = heardNear.sort((a, b) => b.t - a.t)[0];
        const threat = rec ? rec[1].pos : [P[0] + Math.cos(h.bearing) * h.est, P[1] + Math.sin(h.bearing) * h.est, P[2]];
        const edge = nearEdge(P);
        let E = p.cmBias + (rec ? engageScore(me, rec[0], rec[1], 1, [...tracks.entries()], heldKinds) : 0);
        E += edge ? p.cmWEdgeFight : -p.cmWNoEdge;
        aim = [yawTo(P, threat), 0];
        if (E > 0 && !outside && dist(threat, zc) < zrFull * 0.9) {
          if (edge && p.cmAdvance < 0.5) {
            move = [0, 0];
            label = `combat-move: hold the edge, pre-aim (E ${E.toFixed(1)})`;
          } else {
            const a = headTo(P, threat, t, false);
            move = [Math.cos(a), Math.sin(a)];
            speed = p.cmAdvance;
            label = `combat-move: close in (E ${E.toFixed(1)})`;
          }
        } else {
          if (!cover || t - cover.t > 1.5 || dist(cover.from, threat) > 20)
            cover = { pos: findCover(P, threat, zc, zrFull * 0.95) ?? zc, t, from: threat };
          const a = headTo(P, cover.pos, t, false);
          move = [Math.cos(a), Math.sin(a)];
          label = `combat-move: to ${edge ? "better" : "an edge"} cover (E ${E.toFixed(1)})`;
          lines.push({ a: [P[0], P[1], P[2] + 4.5], b: [cover.pos[0], cover.pos[1], cover.pos[2] + 1], color: "#ffd060" });
        }
        if (p.cmStealth >= 0.5 && !outside)
          speed = Math.min(speed, 0.4);
      } else {
        const npc = obs.mechs.find((m) => m.kind === "npc" && dist(m.pos, P) < 45);
        if (npc)
          aim = shoot(me, { pos: npc.pos, vel: npc.vel, kind: "npc" }, act);
        if (itemGoal) {
          const g = itemGoal;
          let ok = t - lockT <= p.mvLockMax && !outsideHard;
          if (ok && g.kind === "drop")
            ok = obs.drops.some((d) => d.id === g.id && d.holder === null);
          else if (ok && g.kind !== "crate") {
            const seen = (g.kind === "cube" ? obs.cubes : obs.pickups).find((q) => q.id === g.id);
            if (seen) {
              g.pos = seen.pos;
              if (g.kind === "weapon" && !wants(seen.kind, held, worst))
                ok = false;
            } else
              ok = dist(g.pos, P) > 6;
          } else if (ok && g.kind === "crate" && !obs.crates.some((q) => q.id === g.id) && dist(g.pos, P) < crateMinDist(me) + 6)
            ok = false;
          if (!ok)
            itemGoal = null;
        }
        if (!itemGoal && !outside && !outsideHard && t - itemT > 1) {
          itemGoal = pickItem(me, obs, held, worst);
          itemT = t;
          if (itemGoal)
            lockT = t;
        }
        const chasing = !!itemGoal && !outsideHard;
        let goal = null;
        if (outside && !chasing) {
          const rr = Math.min(p.mvRingFrac * zrFull, ringMax), d0 = dist(P, zc) || 1;
          goal = [zc[0] + (P[0] - zc[0]) / d0 * rr * 0.95, zc[1] + (P[1] - zc[1]) / d0 * rr * 0.95, P[2]];
          label = dist(P, live.c) > live.r ? "move: back inside the zone" : dist(P, live.c) > live.r * p.zoneMargin ? "move: back from the edge (safety margin)" : "move: heading inward ahead of the shrink";
        } else if (itemGoal) {
          if (itemGoal.kind === "crate") {
            const c = obs.crates.find((q) => q.id === itemGoal.id);
            if (c && c.id !== crateId) {
              crateId = c.id;
              crateSince = t;
            }
            const minD = crateMinDist(me), mz = me.stats.muzzle_height ?? 7;
            if (!c) {
              goal = itemGoal.shootFrom ?? itemGoal.pos;
              label = "move: heading to a crate (out of sight)";
            } else if (t - crateSince > 12 && crateHitT < crateSince) {
              badCrates.set(c.id, t + 60);
              itemGoal = null;
              crateId = -1;
              label = "move: giving up on a crate";
            } else {
              const d = dist(c.pos, P);
              aim = [yawTo(P, c.pos), Math.atan2(c.pos[2] + 1.2 - (P[2] + mz), d)];
              if (d < minD) {
                const a0 = yawTo(c.pos, P);
                goal = [c.pos[0] + Math.cos(a0) * (minD + 2), c.pos[1] + Math.sin(a0) * (minD + 2), P[2]];
                label = "move: backing off a crate to shoot it";
              } else {
                if (dist(itemGoal.shootFrom, P) > 4 && d > p.mvCrateShoot)
                  goal = itemGoal.shootFrom;
                const err = Math.abs(wrapAngle(aim[0] - me.aim[0])) + Math.abs(aim[1] - me.aim[1]);
                const g = me.weapons.findIndex((w) => w?.kind === "gun");
                if (g >= 0 && world.clearLine([P[0], P[1], P[2] + mz], [c.pos[0], c.pos[1], c.pos[2] + 1.2]))
                  act.fire[g] = err < p.gunAimTol;
                label = "move: shooting a crate from a good spot";
              }
            }
            if (itemGoal && itemGoal.kind === "crate" && !goal) {
              stuckRef = [P[0], P[1], P[2]];
              stuckT = t;
            }
          } else {
            goal = itemGoal.pos;
            label = `move: ${itemGoal.kind} worth the detour`;
          }
        }
        let onLoop = false;
        if (!goal && !itemGoal && !(outside && !chasing)) {
          if (!ring.length || dist(ringC, zc) > 10 || Math.abs(ringR - zrFull) > zrFull * 0.05 || t - ringT > 30 || ring.some((q) => dist(q, zc) > ringMax + 2))
            buildRing(zc, zrFull, t);
          if (ring.length) {
            if (ringIdx < 0) {
              let bd = Infinity;
              ring.forEach((q, i) => {
                const d = dist(q, P);
                if (d < bd) {
                  bd = d;
                  ringIdx = i;
                }
              });
            }
            if (dist(ring[ringIdx], P) < p.mvReach) {
              ringIdx = (ringIdx + ringDir + ring.length) % ring.length;
              ringSkips = 0;
              routeGoal = null;
            }
            goal = ring[ringIdx];
            onLoop = true;
            label = `move: patrol loop \xB7 next point score ${ring[ringIdx][3].toFixed(2)}`;
          }
        }
        if (goal) {
          const a = headTo(P, goal, t, onLoop);
          if (onLoop && routeCells.length && lowStretch(routeCells) > p.mvMaxLowStretch && ringSkips < ring.length - 1) {
            ringIdx = (ringIdx + ringDir + ring.length) % ring.length;
            ringSkips++;
            routeGoal = null;
          }
          move = [Math.cos(a), Math.sin(a)];
          const wp = route[routeIdx], nx = route[routeIdx + 1];
          const turn = wp && nx ? wrapAngle(yawTo(wp, nx) - a) : 0;
          if (!npc) {
            if (wp && nx && Math.abs(turn) > 0.5 && dist(wp, P) < p.mvCornerLook)
              aim = [a + clamp(turn, -1, 1), 0];
            else
              aim = [a + p.mvSweep * Math.sin(2 * Math.PI * t / p.mvSweepPeriod), 0];
          }
          if (p.mvHop >= 0.5 && me.grounded && Math.abs(turn) < 0.35 && dist(goal, P) > 10)
            act.jump = true;
          if (t - stuckT > 6) {
            const still = Math.hypot(stuckRef[0] - P[0], stuckRef[1] - P[1], stuckRef[2] - P[2]) < 3;
            if (still && strikes === 0) {
              strikes = 1;
              routeGoal = null;
              jetUntil = t + 3;
            } else if (still) {
              jetUntil = t + 3;
              if (onLoop)
                ringIdx = (ringIdx + ringDir + ring.length) % ring.length;
              itemGoal = null;
              strikes = 0;
              routeGoal = null;
            } else
              strikes = 0;
            stuckRef = [P[0], P[1], P[2]];
            stuckT = t;
          }
        } else {
          stuckRef = [P[0], P[1], P[2]];
          stuckT = t;
          if (!npc && !itemGoal)
            aim = [me.aim[0] + 0.5, 0];
        }
        if (p.mvCrateFire >= 0.5 && !npc && !outside) {
          const heading = move[0] || move[1] ? Math.atan2(move[1], move[0]) : me.aim[0];
          const mz = [P[0], P[1], P[2] + (me.stats.muzzle_height ?? 7)];
          const crate = obs.crates.filter((c) => dist(c.pos, P) < p.mvCrateFireRange && dist(c.pos, P) >= crateMinDist(me) && (badCrates.get(c.id) ?? -1) < t && Math.abs(wrapAngle(yawTo(P, c.pos) - heading)) < p.mvCrateCone && world.clearLine(mz, [c.pos[0], c.pos[1], c.pos[2] + 1.2])).sort((a, b) => dist(a.pos, P) - dist(b.pos, P))[0];
          if (crate) {
            const d = dist(crate.pos, P);
            aim = [yawTo(P, crate.pos), Math.atan2(crate.pos[2] + 1.2 - mz[2], d)];
            const err = Math.abs(wrapAngle(aim[0] - me.aim[0])) + Math.abs(aim[1] - me.aim[1]);
            me.weapons.forEach((w, i) => {
              if (w?.kind === "gun")
                act.fire[i] = err < p.gunAimTol && d < (w.stats.range ?? 230);
              else if (w?.kind === "lightning")
                act.fire[i] = d < (w.stats.range ?? 45) - 3 && Math.abs(wrapAngle(aim[0] - me.aim[0])) < p.lightningCone && me.energy > 50;
            });
            label += " \xB7 shooting a crate";
          }
        }
        if (ring.length)
          for (let i = 0;i < ring.length; i++) {
            const q = ring[i], q2 = ring[(i + 1) % ring.length];
            lines.push({ a: [q[0], q[1], q[2] + 1], b: [q2[0], q2[1], q2[2] + 1], color: i === ringIdx ? "#ffd060" : "#3d6f99" });
          }
        const g = me.weapons.find((w) => w?.kind === "gun");
        if (g && (g.ammo ?? 12) < p.reloadBelow && (g.reload ?? 0) === 0)
          act.reload = true;
      }
      if ((noRoute || t < jetUntil) && (move[0] || move[1])) {
        if (me.grounded && me.energy > 35)
          act.jump = true;
        climbTo = Math.max(climbTo ?? -1e9, P[2] + 14);
        label += " \xB7 jumping over";
      }
      if (mode !== MOVE && p.cbDodge >= 0.5) {
        const dg = dodge(me, obs);
        if (dg) {
          move = dg.dir;
          speed = 1;
          if (dg.jump && p.cbDodgeJump >= 0.5 && me.grounded)
            act.jump = true;
          label += " \xB7 dodging";
        }
      }
      if (mode === CMOVE && threatYaw !== null && t - threatT < 1.5)
        aim = [threatYaw, 0];
      if (move[0] || move[1]) {
        const a = freeHeading(me, Math.atan2(move[1], move[0]));
        move = [Math.cos(a), Math.sin(a)];
      }
      act.move = [move[0] * speed, move[1] * speed];
      act.aim = [aim[0], clamp(aim[1], -0.6, 1.2)];
      act.boost = act.boost || outside && me.energy > p.boostEnergyOutside || climbTo !== null && !me.grounded && me.energy > 3 && P[2] < climbTo;
      act.debug = { label, lines };
      return act;
    },
    finish(alive) {
      closeEpisode(COMBAT, alive);
      closeEpisode(CMOVE, alive);
    }
  };
}
// bot/params-modes.json
var params_modes_default = {
  zoneMargin: 0.843,
  nextZoneMargin: 0.909,
  shrinkLead: 10.2,
  boostEnergyOutside: 52,
  hurtFrac: 0.249,
  rankLaser: 2,
  rankLightning: 4,
  rankMortar: 0,
  gunAimTol: 0.114,
  laserAimTol: 0.07,
  lightningCone: 0.18,
  lightningEnergyMin: 14.4,
  mortarMinDist: 32.4,
  reloadBelow: 2,
  recentS: 6.61,
  hearMemory: 1.12,
  hearRange: 40,
  mvRingFrac: 0.719,
  mvRingBand: 0.02,
  mvSectors: 14,
  mvRingScoreW: 2.27,
  mvLookahead: 13.2,
  mvReach: 13.5,
  mvLowThr: 0.058,
  mvLowW: 0.59,
  mvMaxLowStretch: 178.1,
  mvHop: 1,
  mvSweep: 0.81,
  mvSweepPeriod: 3.31,
  mvCornerLook: 38.2,
  mvWCube: 2.05,
  mvWWeapon: 0.37,
  mvWCrate: 0.14,
  mvWDrop: 1.02,
  mvWSpot: 3,
  mvWItemDist: 2.87,
  mvItemThresh: -0.36,
  mvLockMax: 27.2,
  mvItemRange: 244,
  mvCrateFire: 1,
  mvCrateFireRange: 146.1,
  mvCrateCone: 1.59,
  mvCrateShoot: 37.2,
  cbBias: -1.14,
  cbWHp: 1.28,
  cbWThird: 0.41,
  cbWMatchup: 1.81,
  cbWCubes: 0.24,
  cbWOutnumber: 0.42,
  cbWHurt: 3.62,
  cbWRange: 2,
  cbDodge: 1,
  cbDodgeHorizon: 1.16,
  cbDodgeMargin: 1.9,
  cbDodgeJump: 1,
  cbCoverDist: 72.6,
  cbCoverScoreW: 0.66,
  cbStrafeMin: 0.3,
  cbStrafeMax: 1.98,
  rangeGun: 171,
  rangeLaser: 150.8,
  rangeLightning: 10,
  rangeBand: 18.8,
  cmBias: 2.2,
  cmWEdgeFight: 0.15,
  cmWNoEdge: 0.06,
  cmEdgeDist: 5.1,
  cmStealth: 1,
  cmAdvance: 0.73
};

// bot/submit-modes.ts
globalThis.__HAMSTER_POINTS = join(dirname(fileURLToPath(import.meta.url)), "points.bin");
run((hello) => {
  const files = hello.map.files;
  const wj = files.find((f) => f.endsWith("world.json")) ?? "v2/world.json";
  const tf = files.find((f) => f.endsWith(".i16")) ?? "v2/terrain.i16";
  const world = new World(JSON.parse(readFileSync(join(hello.map.dir, wj), "utf8")), new Uint8Array(readFileSync(join(hello.map.dir, tf))));
  return makeBot(hello, world, params_modes_default);
});
