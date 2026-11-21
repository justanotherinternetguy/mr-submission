// @bun
// bot/main.ts
import { readFileSync } from "fs";
import { join } from "path";

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

// bot/strategy.ts
var SPACE = {
  zoneMargin: { def: 0.85, min: 0.4, max: 1, step: 0.05, desc: "Head back toward the zone center when farther out than this fraction of the zone radius" },
  nextZoneMargin: { def: 0.8, min: 0.3, max: 1, step: 0.05, desc: "Same, for the next (smaller) circle once a shrink is near" },
  shrinkLead: { def: 15, min: 0, max: 60, step: 5, desc: "Seconds before a shrink starts when it begins moving into the next circle" },
  boostEnergyOutside: { def: 30, min: 0, max: 90, step: 10, desc: "Boost toward the zone when outside it and energy is above this" },
  fightOutsideZone: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = keep strafing around its target even when outside the zone (brawler's behavior); 0 = walk back into the zone first and shoot on the way" },
  hurtFrac: { def: 0.35, min: 0.1, max: 0.7, step: 0.05, desc: "Counts as hurt (keeps distance, boosts away) below this fraction of max HP" },
  boostEnergyHurt: { def: 20, min: 0, max: 90, step: 10, desc: "Boost while hurt and fighting when energy is above this" },
  targetRange: { def: 230, min: 0, max: 300, step: 20, desc: "Engage enemy mechs closer than this (m); 0 = never fight mechs, only survive" },
  npcRange: { def: 60, min: 0, max: 150, step: 15, desc: "Shoot drones closer than this (m) when no mech is in range" },
  crateRange: { def: 70, min: 0, max: 150, step: 15, desc: "Go for crates closer than this (m)" },
  crateStop: { def: 25, min: 5, max: 60, step: 5, desc: "Stop walking toward a crate once this close (m) and shoot it" },
  chaseCubesInFight: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "1 = still walk to cubes while an enemy mech is in range" },
  rangeHurt: { def: 140, min: 40, max: 250, step: 15, desc: "Preferred distance to the target when hurt (m)" },
  rangeLightning: { def: 30, min: 10, max: 60, step: 5, desc: "Preferred distance with lightning (m)" },
  rangeLaser: { def: 90, min: 30, max: 200, step: 10, desc: "Preferred distance with a laser (m)" },
  rangeGun: { def: 60, min: 20, max: 200, step: 10, desc: "Preferred distance with the gun only (m)" },
  rangeBand: { def: 10, min: 0, max: 40, step: 5, desc: "Dead band around the preferred distance where it only strafes (m)" },
  strafeMin: { def: 0.6, min: 0.2, max: 3, step: 0.2, desc: "Shortest time between strafe direction changes (s)" },
  strafeMax: { def: 1.4, min: 0.3, max: 5, step: 0.3, desc: "Longest time between strafe direction changes (s)" },
  rankLaser: { def: 3, min: 0, max: 5, step: 1, int: true, desc: "How much it wants a laser (higher = picks it over lower-ranked weapons; gun is 0)" },
  rankLightning: { def: 2, min: 0, max: 5, step: 1, int: true, desc: "How much it wants lightning" },
  rankMortar: { def: 1, min: 0, max: 5, step: 1, int: true, desc: "How much it wants a mortar" },
  gunAimTol: { def: 0.05, min: 0.01, max: 0.2, step: 0.01, desc: "Fire the gun when the aim error is below this (rad)" },
  laserAimTol: { def: 0.03, min: 0.005, max: 0.15, step: 0.01, desc: "Release a charged laser when the aim error is below this (rad)" },
  lightningCone: { def: 0.3, min: 0.05, max: 0.8, step: 0.05, desc: "Fire lightning when the target is within this angle of the aim (rad)" },
  lightningEnergyMin: { def: 15, min: 0, max: 60, step: 5, desc: "Keep at least this much energy before firing lightning" },
  mortarMinDist: { def: 25, min: 5, max: 80, step: 5, desc: "Don't fire the mortar at targets closer than this (m)" },
  reloadBelow: { def: 6, min: 0, max: 12, step: 1, int: true, desc: "Reload the gun when out of combat and ammo is below this" },
  wanderFrac: { def: 0.7, min: 0.1, max: 1, step: 0.1, desc: "When idle, wander within this fraction of the next zone's radius" },
  useNav: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = walk along A* paths around buildings; 0 = brawler's local probing only" },
  aware: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = always turn the torso to whoever is attacking (even while breaking a crate) and sweep it when idle; 0 = brawler's behavior" },
  focusLow: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "1 = of the mechs attacking it, shoot the one with the least HP; 0 = the nearest mech" },
  stickTarget: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "1 = keep shooting the same mech until it dies or leaves range, instead of switching to whichever is nearest" },
  damageFirst: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "Upgrade choice: 1 = gun damage, fire rate and magazine before armor and plating; 0 = armor and plating first (brawler's order)" },
  fleeHp: { def: 0.35, min: 0, max: 0.8, step: 0.05, desc: "Retreat to cover and heal below this fraction of max HP" },
  fleeHpMany: { def: 0.65, min: 0, max: 0.95, step: 0.05, desc: "Same, when two or more mechs are attacking" },
  healTo: { def: 0.85, min: 0.4, max: 1, step: 0.05, desc: "Leave cover once healed to this fraction of max HP" },
  coverRadius: { def: 70, min: 20, max: 150, step: 10, desc: "How far it looks for a spot no attacker can see (m)" },
  initiate: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = attack any mech within targetRange; 0 = only mechs that attack it, and weak ones" },
  ffaPassive: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "1 = once other mechs die without its doing (a free-for-all), stop starting fights" },
  weakFrac: { def: 0.4, min: 0, max: 1, step: 0.05, desc: "When not starting fights, still attack mechs below this fraction of their max HP" },
  autoMode: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "1 = work out which game this is from what the other mechs do: two of them near each other and not fighting = a squad (practice): start fights. One aiming at another, or a death that was not ours = a free-for-all: start none. Until it knows, quietStart applies" },
  farm: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "1 = remember every crate it has seen and walk to the nearest one when it has nothing else to do (instead of wandering)" },
  farmRange: { def: 250, min: 50, max: 500, step: 25, desc: "With farm on: how far it will walk to a remembered crate (m)" },
  quietStart: { def: 0, min: 0, max: 120, step: 10, desc: "Start no fights during the first this many seconds" },
  dodgeEnergy: { def: 100, min: 20, max: 100, step: 10, desc: "Boost while strafing under fire when energy is above this (at 100: only with capacitor upgrades)" },
  restFrac: { def: 0.6, min: 0, max: 1, step: 0.05, desc: "Below this fraction of max HP and with nobody attacking, do not shoot crates or drones (shooting stops regeneration)" },
  unstick: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "1 = when it tries to move but gets nowhere, sidestep with a jump; 0 = brawler's behavior (it can stay wedged on a corner until the zone kills it)" },
  stuckSecs: { def: 1.2, min: 0.6, max: 4, step: 0.3, desc: "With unstick on: counts as stuck after trying to move for this long (s) without getting anywhere" }
};
var DEFAULTS = Object.fromEntries(Object.entries(SPACE).map(([k, p]) => [k, p.def]));

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

class Nav {
  static CELL = 4;
  x0;
  y0;
  nx;
  ny;
  h;
  free;
  onTop;
  gScore;
  fScore;
  from;
  seen;
  done;
  gen = 0;
  constructor(world) {
    const b = world.bounds, C = Nav.CELL;
    this.x0 = b.minX;
    this.y0 = b.minY;
    this.nx = Math.ceil((b.maxX - b.minX) / C);
    this.ny = Math.ceil((b.maxY - b.minY) / C);
    const n = this.nx * this.ny;
    this.h = new Float32Array(n);
    this.free = new Uint8Array(n);
    this.onTop = new Uint8Array(n);
    this.gScore = new Float32Array(n);
    this.fScore = new Float32Array(n);
    this.from = new Int32Array(n);
    this.seen = new Int32Array(n);
    this.done = new Int32Array(n);
    for (let j = 0;j < this.ny; j++)
      for (let i = 0;i < this.nx; i++) {
        const cx = this.x0 + (i + 0.5) * C, cy = this.y0 + (j + 0.5) * C, k = j * this.nx + i;
        const g = world.ground(cx, cy), hz = world.floorAt(cx, cy, g + 2.5, 1.2);
        this.h[k] = hz;
        this.onTop[k] = hz > g + 0.3 ? 1 : 0;
        let ok = world.inBounds(cx, cy, 3.5);
        for (let q = 0;q < 9 && ok; q++) {
          const px = q === 0 ? cx : cx + 3 * Math.cos((q - 1) * Math.PI / 4), py = q === 0 ? cy : cy + 3 * Math.sin((q - 1) * Math.PI / 4);
          if (world.prismWallAt(px, py, hz, 9, 1.2) || world.ground(px, py) > hz + 3.5)
            ok = false;
        }
        this.free[k] = ok ? 1 : 0;
      }
  }
  cellOf(x, y) {
    const i = Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.x0) / Nav.CELL))), j = Math.max(0, Math.min(this.ny - 1, Math.floor((y - this.y0) / Nav.CELL)));
    return j * this.nx + i;
  }
  center(k) {
    return [this.x0 + (k % this.nx + 0.5) * Nav.CELL, this.y0 + (Math.floor(k / this.nx) + 0.5) * Nav.CELL];
  }
  isFree(x, y) {
    return this.free[this.cellOf(x, y)] === 1;
  }
  step(a, b) {
    if (!this.free[b])
      return false;
    const dh = this.h[b] - this.h[a];
    return dh <= (this.onTop[b] ? 1.2 : 4);
  }
  nearestFree(k, maxR = 8) {
    if (this.free[k])
      return k;
    const i0 = k % this.nx, j0 = Math.floor(k / this.nx);
    let best = -1, bd = Infinity;
    for (let r = 1;r <= maxR && best < 0; r++)
      for (let j = j0 - r;j <= j0 + r; j++)
        for (let i = i0 - r;i <= i0 + r; i++) {
          if (i < 0 || j < 0 || i >= this.nx || j >= this.ny || Math.abs(i - i0) !== r && Math.abs(j - j0) !== r)
            continue;
          const q = j * this.nx + i;
          if (!this.free[q])
            continue;
          const d = (i - i0) ** 2 + (j - j0) ** 2;
          if (d < bd) {
            bd = d;
            best = q;
          }
        }
    return best;
  }
  walkable(ax, ay, bx, by) {
    const d = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(d / 2));
    let prev = this.cellOf(ax, ay);
    for (let q = 1;q <= n; q++) {
      const k = this.cellOf(ax + (bx - ax) * q / n, ay + (by - ay) * q / n);
      if (k === prev)
        continue;
      if (!this.step(prev, k))
        return false;
      prev = k;
    }
    return true;
  }
  path(sx, sy, tx, ty, maxExpand = 14000) {
    const s = this.nearestFree(this.cellOf(sx, sy)), goal = this.nearestFree(this.cellOf(tx, ty));
    if (s < 0 || goal < 0)
      return null;
    const nx = this.nx, gi = goal % nx, gj = Math.floor(goal / nx);
    const hx = (k) => {
      const dx = Math.abs(k % nx - gi), dy = Math.abs(Math.floor(k / nx) - gj);
      return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
    };
    const gen = ++this.gen;
    const heap = [s];
    this.gScore[s] = 0;
    this.fScore[s] = hx(s);
    this.from[s] = -1;
    this.seen[s] = gen;
    let best = s, bestH = hx(s), expanded = 0;
    const f = this.fScore;
    while (heap.length) {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        let i = 0;
        for (;; ) {
          const l = 2 * i + 1, r = l + 1;
          if (l >= heap.length)
            break;
          const c = r < heap.length && f[heap[r]] < f[heap[l]] ? r : l;
          if (f[heap[c]] >= f[last])
            break;
          heap[i] = heap[c];
          i = c;
        }
        heap[i] = last;
      }
      const cur = top;
      if (this.done[cur] === gen)
        continue;
      this.done[cur] = gen;
      if (cur === goal) {
        best = cur;
        break;
      }
      const h = hx(cur);
      if (h < bestH) {
        bestH = h;
        best = cur;
      }
      if (++expanded > maxExpand)
        break;
      const ci = cur % nx, cj = Math.floor(cur / nx);
      for (let dj = -1;dj <= 1; dj++)
        for (let di = -1;di <= 1; di++) {
          if (!di && !dj)
            continue;
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= nx || j >= this.ny)
            continue;
          const nb = j * nx + i;
          if (this.done[nb] === gen || !this.step(cur, nb))
            continue;
          if (di && dj && (!this.step(cur, cj * nx + i) || !this.step(cur, j * nx + ci)))
            continue;
          const g = this.gScore[cur] + (di && dj ? Math.SQRT2 : 1);
          if (this.seen[nb] === gen && g >= this.gScore[nb])
            continue;
          this.seen[nb] = gen;
          this.gScore[nb] = g;
          this.from[nb] = cur;
          f[nb] = g + hx(nb);
          let q = heap.length;
          heap.push(nb);
          while (q > 0) {
            const p = q - 1 >> 1;
            if (f[heap[p]] <= f[nb])
              break;
            heap[q] = heap[p];
            q = p;
          }
          heap[q] = nb;
        }
    }
    const out = [];
    for (let k = best;k >= 0 && k !== s; k = this.from[k])
      out.push(this.center(k));
    out.reverse();
    if (best === goal && this.free[this.cellOf(tx, ty)])
      out.push([tx, ty]);
    return out.length ? out : best === goal ? [[tx, ty]] : null;
  }
}
function navOf(world) {
  return world.__hamsterNav ??= new Nav(world);
}
function makeUnstick(rng, after) {
  let prev = null;
  const steps = [];
  let wantSince = -1, until = -1, yaw = 0, side = 1, tries = 0, lastStuck = null;
  return (t, P, move) => {
    if (after <= 0)
      return { move, jump: false };
    if (prev)
      steps.push({ t, d: dist(P, prev) });
    prev = [P[0], P[1]];
    while (steps.length && steps[0].t < t - after)
      steps.shift();
    if (Math.hypot(move[0], move[1]) <= 0.5) {
      wantSince = -1;
      return { move, jump: false };
    }
    if (wantSince < 0)
      wantSince = t;
    if (t < until)
      return { move: [Math.cos(yaw), Math.sin(yaw)], jump: false };
    if (t - wantSince >= after && steps.reduce((s, x) => s + x.d, 0) < 2) {
      if (lastStuck && dist(lastStuck, P) > 15)
        tries = 0;
      lastStuck = [P[0], P[1]];
      tries++;
      side = -side;
      yaw = Math.atan2(move[1], move[0]) + side * (1.1 + rng.next() * 1.3);
      until = t + 0.7 + 0.4 * Math.min(tries, 5);
      wantSince = t;
      return { move: [Math.cos(yaw), Math.sin(yaw)], jump: true };
    }
    return { move, jump: false };
  };
}
function makeBot(hello, world, params) {
  const P_ = { ...DEFAULTS, ...params ?? {} };
  const cfg = hello.config;
  const rng = new Rng(hello.seed);
  const rank = { laser: P_.rankLaser, lightning: P_.rankLightning, mortar: P_.rankMortar, gun: 0 };
  const upgradePref = P_.damageFirst >= 0.5 ? ["gun_damage", "gun_rate", "gun_mag", "laser_damage", "laser_charge", "plating", "armor", "nanites", "gun_velocity", "lightning_efficiency", "gyros", "servos"] : ["armor", "plating", "laser_charge", "laser_damage", "nanites", "gun_rate", "gun_damage", "lightning_efficiency", "gyros", "servos"];
  let lastTarget = -1;
  const nMechs = cfg.match.mechs;
  let strafe = 1, strafeT = 0;
  let threatYaw = null, threatT = -99;
  let wanderGoal = null;
  const strafeLo = Math.min(P_.strafeMin, P_.strafeMax), strafeHi = Math.max(P_.strafeMin, P_.strafeMax);
  const unstick = makeUnstick(new Rng(hello.seed ^ 625341585), P_.unstick >= 0.5 ? Math.max(0.6, P_.stuckSecs) : 0);
  const nav = P_.useNav >= 0.5 ? navOf(world) : null;
  const foes = new Map;
  const foe = (id) => {
    let f = foes.get(id);
    if (!f) {
      f = { hitT: -99, aimSince: -1, aimLast: -99, pos: [0, 0, 0], seenT: -99 };
      foes.set(id, f);
    }
    return f;
  };
  let kills = 0, ffa = false, squad = false;
  let pairSince = -1, pairLast = -99;
  const crateMem = new Map;
  let fleeing = false, fleeT = -99, cover = null, coverT = -99;
  let route = null;
  function headingTo(P, goal, t) {
    if (!nav || dist(P, goal) < 6 || nav.walkable(P[0], P[1], goal[0], goal[1]))
      return yawTo(P, goal);
    if (!route || dist(route.goal, goal) > 8 || t - route.t > 3 || route.i >= route.pts.length) {
      const pts = nav.path(P[0], P[1], goal[0], goal[1]);
      route = pts ? { goal: [goal[0], goal[1]], pts, i: 0, t } : null;
      if (!route)
        return yawTo(P, goal);
    }
    const r = route;
    while (r.i < r.pts.length - 1 && dist(P, r.pts[r.i]) < 4)
      r.i++;
    let k = r.i;
    for (let q = Math.min(r.pts.length - 1, r.i + 10);q > r.i; q--)
      if (nav.walkable(P[0], P[1], r.pts[q][0], r.pts[q][1])) {
        k = q;
        break;
      }
    r.i = k;
    return yawTo(P, r.pts[k]);
  }
  function findCover(P, from, zc, zr) {
    if (!nav || !from.length)
      return null;
    let best = null, bs = Infinity;
    const R = P_.coverRadius, step = 8;
    for (let dy = -R;dy <= R; dy += step)
      for (let dx = -R;dx <= R; dx += step) {
        const d = Math.hypot(dx, dy);
        if (d > R)
          continue;
        const x = P[0] + dx, y = P[1] + dy;
        if (!nav.isFree(x, y) || dist([x, y], zc) > zr * 0.9)
          continue;
        const hz = nav.h[nav.cellOf(x, y)];
        let hidden = true, near = Infinity;
        for (const e of from) {
          const eye = [e[0], e[1], e[2] + 8];
          if (world.clearLine(eye, [x, y, hz + 4.5]) || world.clearLine(eye, [x, y, hz + 8.5])) {
            hidden = false;
            break;
          }
          near = Math.min(near, dist(e, [x, y]));
        }
        if (!hidden)
          continue;
        const score = d - 0.25 * Math.min(near, 120) + (near < 30 ? 60 : 0);
        if (score < bs) {
          bs = score;
          best = [x, y];
        }
      }
    return best;
  }
  return {
    name: "hamster",
    act(obs) {
      const me = obs.self, P = me.pos, t = obs.t;
      const act = { tick: obs.tick, fire: [false, false] };
      if (obs.offer) {
        let best = 0, bs = 99;
        obs.offer.choices.forEach((c, i) => {
          const s = upgradePref.indexOf(c.id);
          const sc = s < 0 ? 50 : s;
          if (sc < bs) {
            bs = sc;
            best = i;
          }
        });
        act.pick = best;
      }
      for (const e of obs.events) {
        if (e.type === "damaged" && e.bearing !== null && e.by !== null) {
          threatYaw = e.bearing;
          threatT = t;
          if (e.by < 100)
            foe(e.by).hitT = t;
        } else if (e.type === "kill")
          kills++;
      }
      if (obs.alive < nMechs - kills)
        ffa = true;
      const held = me.weapons.map((w) => w?.kind ?? null);
      const worst = held[1] === null ? 1 : rank[held[0]] <= rank[held[1]] ? 0 : 1;
      const wantPickup = obs.pickups.filter((p) => !held.includes(p.kind) && (held[1] === null || rank[p.kind] > rank[held[worst]]) && Math.abs(p.pos[2] - P[2]) < 4).sort((a, b) => dist(a.pos, P) - dist(b.pos, P))[0];
      if (wantPickup && dist(wantPickup.pos, P) < cfg.loot.pickup_radius) {
        act.take = wantPickup.id;
        if (held[1] !== null)
          act.drop = worst;
      }
      const enemies = obs.mechs.filter((m) => m.kind === "mech").sort((a, b) => dist(a.pos, P) - dist(b.pos, P));
      for (const e of enemies) {
        const f = foe(e.id);
        f.pos = e.pos;
        f.seenT = t;
        const aiming = dist(e.pos, P) < 240 && Math.abs(wrapAngle(yawTo(e.pos, P) - e.aim[0])) < 0.25;
        if (!aiming || t - f.aimLast > 0.35)
          f.aimSince = aiming ? t : -1;
        if (aiming)
          f.aimLast = t;
      }
      if (P_.autoMode >= 0.5 && !ffa && !squad) {
        let calm = false;
        for (let i = 0;i < enemies.length && !ffa; i++)
          for (let j = 0;j < enemies.length; j++) {
            if (i === j)
              continue;
            const a = enemies[i], b = enemies[j], d = dist(a.pos, b.pos);
            if (d > 200 || t - foe(a.id).seenT > 0.01 || t - foe(b.id).seenT > 0.01)
              continue;
            if (Math.abs(wrapAngle(yawTo(a.pos, b.pos) - a.aim[0])) < 0.12 && Math.abs(wrapAngle(yawTo(a.pos, P) - a.aim[0])) > 0.3) {
              const f = foe(a.id);
              if (f.vsLast === undefined || t - f.vsLast > 0.35)
                f.vsSince = t;
              f.vsLast = t;
              if (t - (f.vsSince ?? t) >= 0.6) {
                ffa = true;
                break;
              }
            } else
              calm = true;
          }
        if (calm && !ffa) {
          if (t - pairLast > 0.35)
            pairSince = t;
          pairLast = t;
          if (t - pairSince >= 2.5)
            squad = true;
        }
      }
      const isAttacker = (id) => {
        const f = foes.get(id);
        return !!f && (t - f.hitT < 4 || f.aimSince >= 0 && t - f.aimLast < 0.35 && t - f.aimSince >= 0.5);
      };
      const attackers = enemies.filter((e) => isAttacker(e.id));
      const hpF = me.hp / me.max_hp;
      const underFire = t - threatT < 3;
      const nAtk = Math.max(attackers.length, underFire ? 1 : 0);
      const inRange = (e) => dist(e.pos, P) < P_.targetRange;
      const mayStart = P_.autoMode >= 0.5 ? P_.initiate >= 0.5 && !ffa && (squad || t >= P_.quietStart) : P_.initiate >= 0.5 && t >= P_.quietStart && !(ffa && P_.ffaPassive >= 0.5);
      let foeTarget = attackers.filter(inRange).sort((a, b) => (P_.focusLow >= 0.5 ? (a.hp ?? 0) - (b.hp ?? 0) : 0) || dist(a.pos, P) - dist(b.pos, P))[0];
      if (P_.stickTarget >= 0.5 && lastTarget >= 0) {
        const keep = (attackers.length ? attackers : mayStart ? enemies : []).find((e) => e.id === lastTarget && inRange(e));
        if (keep)
          foeTarget = keep;
      }
      if (!foeTarget)
        foeTarget = mayStart ? enemies.find(inRange) : enemies.find((e) => inRange(e) && (e.hp ?? 1e9) < (e.max_hp ?? 1) * P_.weakFrac);
      lastTarget = foeTarget ? foeTarget.id : -1;
      const resting = nAtk === 0 && hpF < P_.restFrac;
      const npcs = resting ? [] : obs.mechs.filter((m) => m.kind === "npc" && dist(m.pos, P) < P_.npcRange).sort((a, b) => dist(a.pos, P) - dist(b.pos, P));
      const target = foeTarget ?? npcs[0];
      const crate = resting ? undefined : obs.crates.filter((c) => dist(c.pos, P) < P_.crateRange && Math.abs(c.pos[2] - P[2]) < 6).sort((a, b) => dist(a.pos, P) - dist(b.pos, P))[0];
      if (P_.farm >= 0.5) {
        for (const c of obs.crates)
          if (Math.abs(c.pos[2] - world.ground(c.pos[0], c.pos[1])) < 3)
            crateMem.set(c.id, c.pos);
        for (const [id, pos] of crateMem)
          if (dist(pos, P) < 30 && !obs.crates.some((c) => c.id === id))
            crateMem.delete(id);
      }
      const z = obs.zone;
      const zr = t < z.shrink_start ? z.radius : z.next_radius;
      const zc = t < z.shrink_start ? z.center : z.next_center;
      const outside = dist(P, zc) > zr * P_.zoneMargin || t > z.shrink_start - P_.shrinkLead && dist(P, z.next_center) > z.next_radius * P_.nextZoneMargin;
      const hurt = hpF < P_.hurtFrac;
      const finishing = !!foeTarget && nAtk <= 1 && (foeTarget.hp ?? 1e9) < (foeTarget.max_hp ?? 1) * 0.25 && hpF > 0.15;
      if (!fleeing && nAtk > 0 && !finishing && (hpF < P_.fleeHp || nAtk >= 2 && hpF < P_.fleeHpMany)) {
        fleeing = true;
        fleeT = t;
        cover = null;
      }
      if (fleeing && (hpF >= P_.healTo || t - fleeT > 40 || nAtk === 0 && t - threatT > 15 && hpF >= P_.fleeHp))
        fleeing = false;
      let goal = null;
      if (outside)
        goal = dist(P, z.next_center) > z.next_radius * P_.nextZoneMargin ? z.next_center : zc;
      else if (fleeing) {
        if (!cover || t - coverT > 0.8) {
          const from = [...foes.values()].filter((f) => t - f.seenT < 8 && (t - f.hitT < 10 || t - f.aimLast < 2)).map((f) => f.pos);
          const inNext = t > z.shrink_start - 20;
          cover = findCover(P, from, inNext ? z.next_center : zc, inNext ? z.next_radius : zr);
          coverT = t;
          if (!cover && from.length) {
            const a = yawTo(from[0], P), tc = yawTo(P, zc);
            const away = Math.atan2(Math.sin(a) + 0.5 * Math.sin(tc), Math.cos(a) + 0.5 * Math.cos(tc));
            cover = [P[0] + Math.cos(away) * 40, P[1] + Math.sin(away) * 40];
          }
        }
        goal = cover && dist(cover, P) > 2.5 ? cover : null;
      } else if (wantPickup)
        goal = wantPickup.pos;
      else {
        const cube = obs.cubes.filter((c) => Math.abs(c.pos[2] - P[2]) < 4).sort((a, b) => dist(a.pos, P) - dist(b.pos, P))[0];
        if (cube && (P_.chaseCubesInFight >= 0.5 || !(target && target.kind === "mech" && !hurt)))
          goal = cube.pos;
        else if (crate && !target)
          goal = dist(crate.pos, P) > P_.crateStop ? crate.pos : null;
        else if (!target && !resting && P_.farm >= 0.5 && (() => {
          let best = null, bd = P_.farmRange;
          const inNext = t > z.shrink_start - 40;
          for (const pos of crateMem.values()) {
            const d = dist(pos, P);
            if (d < bd && dist(pos, inNext ? z.next_center : zc) < (inNext ? z.next_radius : zr) * 0.8) {
              bd = d;
              best = pos;
            }
          }
          goal = best;
          return !!best;
        })()) {} else if (!target) {
          if (!wanderGoal || dist(wanderGoal, P) < 15 || rng.next() < 0.005) {
            const a = rng.range(0, 2 * Math.PI), d = Math.sqrt(rng.next()) * z.next_radius * P_.wanderFrac;
            wanderGoal = [z.next_center[0] + Math.cos(a) * d, z.next_center[1] + Math.sin(a) * d];
          }
          goal = wanderGoal;
        }
      }
      let move = [0, 0];
      const goalYaw = goal ? headingTo(P, goal, t) : null;
      let aimYaw = goalYaw ?? me.aim[0], aimPitch = 0;
      let dodging = false;
      if (target) {
        const d = dist(target.pos, P);
        if (t - strafeT > rng.range(strafeLo, strafeHi)) {
          strafe = -strafe;
          strafeT = t;
        }
        const toT = yawTo(P, target.pos);
        if (!fleeing && (!goal || target.kind === "mech" && (!outside || P_.fightOutsideZone >= 0.5))) {
          const pref = hurt ? P_.rangeHurt : held.includes("lightning") ? P_.rangeLightning : held.includes("laser") ? P_.rangeLaser : P_.rangeGun;
          const radial = d > pref + P_.rangeBand ? 1 : d < pref - P_.rangeBand ? -1 : 0;
          const my = Math.atan2(Math.sin(toT) * radial + Math.sin(toT + Math.PI / 2) * strafe, Math.cos(toT) * radial + Math.cos(toT + Math.PI / 2) * strafe);
          const s = steer(world, P, my);
          move = [Math.cos(s), Math.sin(s)];
          dodging = target.kind === "mech" && underFire && me.energy > P_.dodgeEnergy;
        }
        const gun = me.weapons.find((w) => w?.kind === "gun");
        const speed = gun?.stats.speed ?? 252;
        const tc = [target.pos[0], target.pos[1], target.pos[2] + (target.kind === "mech" ? 4.5 : 1.75)];
        const muzzle = [P[0], P[1], P[2] + (me.stats.muzzle_height ?? 7)];
        const lead = Math.hypot(tc[0] - muzzle[0], tc[1] - muzzle[1], tc[2] - muzzle[2]) / speed;
        const pt = [tc[0] + target.vel[0] * lead, tc[1] + target.vel[1] * lead, tc[2] + target.vel[2] * lead];
        aimYaw = yawTo(muzzle, pt);
        aimPitch = Math.atan2(pt[2] - muzzle[2], dist(pt, muzzle));
        const err = Math.abs(wrapAngle(aimYaw - me.aim[0])) + Math.abs(aimPitch - me.aim[1]);
        me.weapons.forEach((w, i) => {
          if (!w)
            return;
          if (w.kind === "gun")
            act.fire[i] = err < P_.gunAimTol && d < (w.stats.range ?? 230);
          else if (w.kind === "lightning")
            act.fire[i] = d < (w.stats.range ?? 45) - 3 && Math.abs(wrapAngle(toT - me.aim[0])) < P_.lightningCone && me.energy > P_.lightningEnergyMin;
          else if (w.kind === "laser") {
            const charge = w.charge ?? 0;
            const full = charge >= (w.stats.charge ?? 0.75) - 0.01;
            act.fire[i] = d < (w.stats.range ?? 280) && !(full && err < P_.laserAimTol);
          } else if (w.kind === "mortar") {
            const v = w.stats.speed ?? 72, g = w.stats.gravity ?? 22;
            const s = v * v * v * v - g * (g * d * d);
            if (d > P_.mortarMinDist && s > 0) {
              aimPitch = Math.atan((v * v - Math.sqrt(s)) / (g * d));
              act.fire[i] = Math.abs(wrapAngle(toT - me.aim[0])) < 0.05;
            }
          }
        });
      } else if (P_.aware >= 0.5 && underFire && threatYaw !== null) {
        aimYaw = threatYaw;
      } else if (crate && !fleeing) {
        aimYaw = yawTo(P, crate.pos);
        aimPitch = Math.atan2(crate.pos[2] + 1.2 - (P[2] + 7), dist(crate.pos, P));
        const g = me.weapons.findIndex((w) => w?.kind === "gun");
        if (g >= 0)
          act.fire[g] = Math.abs(wrapAngle(aimYaw - me.aim[0])) < 0.05;
        const l = me.weapons.findIndex((w) => w?.kind === "lightning");
        if (l >= 0 && dist(crate.pos, P) < 40)
          act.fire[l] = true;
      } else if (threatYaw !== null && t - threatT < (fleeing ? 30 : 3)) {
        aimYaw = threatYaw;
      } else if (goalYaw !== null && P_.aware >= 0.5) {
        aimYaw = goalYaw + 1.7 * Math.sin(2 * Math.PI * t / 3.4);
      } else if (!goal) {
        aimYaw = me.aim[0] + 0.6;
      }
      if (goalYaw !== null && move[0] === 0 && move[1] === 0) {
        const s = steer(world, P, goalYaw);
        move = [Math.cos(s), Math.sin(s)];
      }
      const free = unstick(t, P, move);
      act.move = free.move;
      if (free.jump)
        act.jump = true;
      act.aim = [aimYaw, Math.max(-0.6, Math.min(1.2, aimPitch))];
      act.boost = outside && me.energy > P_.boostEnergyOutside || hurt && !!target && me.energy > P_.boostEnergyHurt || fleeing && !!goal && me.energy > 5 || dodging;
      const g = me.weapons.find((w) => w?.kind === "gun");
      if (g && !target && (g.ammo ?? 12) < P_.reloadBelow && (g.reload ?? 0) === 0)
        act.reload = true;
      return act;
    }
  };
}
// bot/params.json
var params_default = {
  zoneMargin: 0.852,
  nextZoneMargin: 0.821,
  shrinkLead: 10.7,
  boostEnergyOutside: 24,
  fightOutsideZone: 1,
  hurtFrac: 0.31,
  boostEnergyHurt: 14.7,
  targetRange: 216.7,
  npcRange: 60.9,
  crateRange: 72.1,
  crateStop: 23.1,
  chaseCubesInFight: 0,
  rangeHurt: 133.5,
  rangeLightning: 30.7,
  rangeLaser: 89.8,
  rangeGun: 74.4,
  rangeBand: 8.9,
  strafeMin: 0.48,
  strafeMax: 1.14,
  rankLaser: 3,
  rankLightning: 2,
  rankMortar: 0,
  gunAimTol: 0.048,
  laserAimTol: 0.023,
  lightningCone: 0.311,
  lightningEnergyMin: 15.6,
  mortarMinDist: 22.8,
  reloadBelow: 5,
  wanderFrac: 0.69,
  useNav: 1,
  aware: 1,
  focusLow: 0,
  stickTarget: 0,
  damageFirst: 0,
  fleeHp: 0.35,
  fleeHpMany: 0.65,
  healTo: 0.85,
  coverRadius: 70,
  initiate: 1,
  ffaPassive: 0,
  weakFrac: 0.4,
  autoMode: 0,
  farm: 0,
  farmRange: 250,
  quietStart: 0,
  dodgeEnergy: 100,
  restFrac: 0.6,
  unstick: 1,
  stuckSecs: 1.43
};

// bot/main.ts
run((hello) => {
  const files = hello.map.files;
  const wj = files.find((f) => f.endsWith("world.json")) ?? "v2/world.json";
  const tf = files.find((f) => f.endsWith(".i16")) ?? "v2/terrain.i16";
  const world = new World(JSON.parse(readFileSync(join(hello.map.dir, wj), "utf8")), new Uint8Array(readFileSync(join(hello.map.dir, tf))));
  return makeBot(hello, world, params_default);
});
