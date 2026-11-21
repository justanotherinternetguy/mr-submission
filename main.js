// @bun
// hybrid/main.ts
import { readFileSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { gunzipSync } from "zlib";

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

// hybrid/strategy.ts
var SPACE = {
  zoneLead: { def: 5, min: 1, max: 20, step: 1, desc: "Leave for the next circle when the zone edge reaches us within this many seconds (plus zoneWalkK x the walk time into the next circle)" },
  zoneWalkK: { def: 0.35, min: 0, max: 1.5, step: 0.1, desc: "Fraction of the walking time into the next circle added to zoneLead" },
  zoneLateLead: { def: 4, min: 0, max: 20, step: 2, desc: "In the phases with heavy zone damage (60 HP/s and more): be on the way this many seconds (plus the walk time) before the shrink starts" },
  boostEnergyOutside: { def: 24, min: 0, max: 90, step: 10, desc: "Boost toward the zone when outside it and energy is above this" },
  homeFrac: { def: 0.5, min: 0.1, max: 0.9, step: 0.1, desc: "When it must move in: walk to this fraction of the next circle's radius (on our side of it)" },
  tsD: { def: 60, min: 20, max: 200, step: 10, desc: "Target score: meters of distance worth one point" },
  tsHp: { def: 1.5, min: 0, max: 4, step: 0.3, desc: "Target score: points for a target with no HP left against one at full HP" },
  tsLos: { def: 2.5, min: 0, max: 5, step: 0.5, desc: "Target score: points for a clear line of fire" },
  tsStick: { def: 0.6, min: 0, max: 3, step: 0.2, desc: "Target score: points for the mech it is already shooting" },
  tsAtk: { def: 1, min: 0, max: 3, step: 0.3, desc: "Target score: points for the mech that hit it last (within 4 s)" },
  engR: { def: 175, min: 60, max: 280, step: 15, desc: "Fights a mech it has a line of fire to within this distance (m)" },
  engNear: { def: 60, min: 20, max: 120, step: 10, desc: "Fights any mech closer than this, line of fire or not (m)" },
  onlyHostile: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "1 = fight only mechs that hit us in the last 6 s, are closer than engNear or can be finished; 0 = any mech in line of fire within engR" },
  armFirst: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "1 = the same restraint, but only while the second weapon slot is empty and the match is younger than armFirstT (fetch a weapon before starting fights)" },
  startVsLaser: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "0 = without a laser of its own, start no fight with a laser carrier beyond 55 m (it still answers one that hits it); 1 = fight it like any other mech" },
  armFirstT: { def: 60, min: 0, max: 240, step: 15, desc: "armFirst applies until this match time (s)" },
  useHide: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = break line of sight and repair when losing; 0 = never retreat" },
  evHp: { def: 0.4, min: 0.1, max: 0.8, step: 0.05, desc: "Retreat to cover below this fraction of max HP (unless the target can be finished)" },
  evHp2: { def: 0.5, min: 0.1, max: 0.9, step: 0.05, desc: "Same, with two or more mechs in contact" },
  evHpPer: { def: 0, min: 0, max: 0.3, step: 0.03, desc: "Added to evHp2 for every mech in contact beyond two" },
  evAtk2: { def: 0.5, min: 0.1, max: 0.95, step: 0.05, desc: "Retreat below this fraction of max HP when two or more mechs have hit us in the last 4 s" },
  evN: { def: 6, min: 2, max: 12, step: 1, int: true, desc: "Retreat whatever the HP with this many mechs in contact" },
  useOutgun: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = retreat from a laser carrier beyond 55 m when it has no laser itself and HP is below ogHp" },
  ogHp: { def: 0.8, min: 0.2, max: 1, step: 0.05, desc: "HP fraction for useOutgun" },
  exHp0: { def: 0.75, min: 0.4, max: 1, step: 0.05, desc: "Leave cover with nobody in contact once HP is above this (or after exQuiet seconds without contact)" },
  exHp1: { def: 0.85, min: 0.4, max: 1, step: 0.05, desc: "Leave cover with one mech in contact once HP is above this" },
  exHp2: { def: 1.05, min: 0.5, max: 1.05, step: 0.05, desc: "Leave cover with two or more mechs in contact once HP is above this (above 1: only when they have gone)" },
  unseenHideHp: { def: 1.05, min: 0.2, max: 1.05, step: 0.1, desc: "Hit by a shooter it cannot see, and no target in view: take cover when HP is below this (above 1: always), else just turn to it" },
  exQuiet: { def: 8, min: 2, max: 30, step: 2, desc: "Leave cover after this many seconds without contact" },
  coverKeep: { def: 0, min: 0, max: 150, step: 15, desc: "Cover spots closer than this to a mech in contact are marked down (so it keeps moving away, hidden, from mechs that walk up to it); 0 = only line of sight counts" },
  evadeShoot: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "While retreating: 1 = shoot back whenever the target has a line of fire to us; 0 = hold fire unless we were hit in the last second (dealing damage stops the repair)" },
  usePhantom: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = a hit from a mech it cannot see places that mech 110 m away along the hit's bearing (35 m for lightning) and counts it as in contact" },
  gmin: { def: 45, min: 15, max: 150, step: 10, desc: "Gun only: back off when the target is closer than this (m)" },
  gmax: { def: 85, min: 30, max: 220, step: 10, desc: "Gun only: close in when the target is farther than this (m)" },
  lmin: { def: 125, min: 30, max: 220, step: 10, desc: "With a laser: back off when the target is closer than this (m)" },
  lmax: { def: 185, min: 60, max: 270, step: 10, desc: "With a laser: close in when the target is farther than this (m)" },
  litMin: { def: 12, min: 5, max: 30, step: 3, desc: "With lightning (and no laser): back off closer than this (m)" },
  litMax: { def: 36, min: 15, max: 60, step: 4, desc: "With lightning (and no laser): close in farther than this (m)" },
  litClose: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = holding lightning (and no laser), fight inside litMin..litMax; 0 = keep the gun's band and use the lightning only on what comes close" },
  litAvoid: { def: 60, min: 0, max: 120, step: 10, desc: "Back away, before anything but the zone, from a lightning carrier closer than this (m) unless we fight at lightning range ourselves; no loot detours toward one either" },
  vsLaserMin: { def: 30, min: 10, max: 100, step: 10, desc: "Gun only against a laser carrier: lower end of the range band (m)" },
  vsLaserMax: { def: 60, min: 30, max: 150, step: 10, desc: "Gun only against a laser carrier: upper end of the range band (m)" },
  vsLitMin: { def: 60, min: 20, max: 120, step: 10, desc: "Stay at least this far from a lightning carrier when it has no lightning itself (m)" },
  finishFrac: { def: 0.3, min: 0, max: 0.8, step: 0.05, desc: "A target below this fraction of its HP is chased down (when our HP is above half)" },
  finishRange: { def: 45, min: 15, max: 120, step: 10, desc: "Distance it closes to on a target it is finishing (m)" },
  backBoostM: { def: 15, min: 0, max: 60, step: 5, desc: "Boost away when the target is this much closer than the lower end of the band (and energy is above 45)" },
  flipA: { def: 0.45, min: 0.15, max: 2, step: 0.1, desc: "Shortest time between strafe direction changes (s)" },
  flipB: { def: 0.7, min: 0, max: 3, step: 0.2, desc: "Random extra time between strafe direction changes (s)" },
  jinkLos: { def: 0.7, min: 0, max: 2, step: 0.15, desc: "Weight of the strafe across a target that has a line of fire to us" },
  jinkNo: { def: 0.2, min: 0, max: 2, step: 0.1, desc: "Weight of the strafe while the target is behind cover" },
  usePeek: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = step out of the target's sight while no weapon is ready (reloading) or while a laser aimed at us is charging, step back in when one is" },
  losW: { def: 1.3, min: 0, max: 4, step: 0.3, desc: "Weight of getting (or breaking) the line of fire in the peek rule" },
  hideW: { def: 1, min: 0, max: 3, step: 0.25, desc: "How strongly it wants to be out of sight while no weapon is ready" },
  useDodge: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = step off the line of visible bullets and out of the blast of falling shells" },
  dodgeW: { def: 10, min: 0, max: 30, step: 2, desc: "Weight of dodging a bullet that would hit" },
  dodgeR: { def: 2, min: 0, max: 6, step: 0.5, desc: "Margin around our body that a bullet's line should miss (m)" },
  multiCover: { def: 0.45, min: 0, max: 2, step: 0.15, desc: "In a fight with several mechs about: weight of standing where the others cannot see us" },
  valLaser: { def: 4, min: 0, max: 6, step: 0.5, desc: "How much it wants a laser (the gun is 2 and is never dropped)" },
  valLightning: { def: 2.4, min: 0, max: 6, step: 0.4, desc: "How much it wants lightning" },
  valMortar: { def: 0, min: 0, max: 6, step: 0.4, desc: "How much it wants a mortar (at 0 it never takes one: a laser does +60% to a mortar carrier)" },
  fetchLaser: { def: 320, min: 50, max: 500, step: 30, desc: "Nobody in contact: walk this far for a remembered laser, or for any weapon while a slot is empty (m)" },
  fetchOther: { def: 150, min: 0, max: 400, step: 25, desc: "Nobody in contact, both slots full: walk this far for a better weapon that is not a laser (m)" },
  grabLaser: { def: 120, min: 0, max: 300, step: 20, desc: "In a fight: still walk this far for a laser (m)" },
  grabOther: { def: 60, min: 0, max: 200, step: 15, desc: "In a fight with an empty slot: still walk this far for another weapon (m)" },
  grabCube: { def: 45, min: 0, max: 120, step: 10, desc: "In a fight: still walk this far for a cube no enemy is nearer to (m)" },
  grabHp: { def: 0.35, min: 0, max: 0.9, step: 0.05, desc: "No loot detours in a fight below this fraction of max HP" },
  cubeR: { def: 90, min: 20, max: 200, step: 15, desc: "Nobody in contact: walk this far for a cube (m)" },
  dropReach: { def: 280, min: 50, max: 500, step: 30, desc: "Go for a supply drop within this distance (m)" },
  farmHp: { def: 0.9, min: 0.3, max: 1, step: 0.05, desc: "Shoot crates and drones only above this fraction of max HP (shooting stops the repair)" },
  farmWait: { def: 6, min: 0, max: 20, step: 2, desc: "... and only after this many seconds without a mech in contact" },
  crateR: { def: 150, min: 30, max: 220, step: 15, desc: "Shoot crates it has a line of fire to within this distance (m)" },
  crateWalk: { def: 200, min: 0, max: 400, step: 25, desc: "Walk to a remembered crate within this distance (m)" },
  npcR: { def: 110, min: 0, max: 200, step: 15, desc: "Shoot drones for cubes within this distance (m)" },
  scanEvery: { def: 11, min: 3, max: 30, step: 2, desc: "With no mech in contact: turn the torso a full circle (1.8 s) every this many seconds, also while shooting crates" },
  openScan: { def: 1.8, min: 0, max: 4, step: 0.3, desc: "Turn the torso a full circle for this long at the start (to see the weapons lying around)" },
  seek: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "1 = with two weapons, HP above 80% and nothing to collect, walk to where a mech was last seen" },
  wanderFrac: { def: 0.69, min: 0.1, max: 1, step: 0.1, desc: "With nothing to do: wander within this fraction of the next circle's radius" },
  gunLat: { def: 0.075, min: 0, max: 0.2, step: 0.02, desc: "Gun: seconds between the observation and the shot leaving, used in the lead" },
  tolYaw: { def: 0.6, min: 0.2, max: 1.5, step: 0.1, desc: "Fire when the aim is within this fraction of the target's radius" },
  gunT: { def: 0.8, min: 0.3, max: 1.2, step: 0.1, desc: "Gun: do not shoot at a moving mech when the bullet would fly longer than this (s)" },
  lightningEnergyMin: { def: 6, min: 0, max: 60, step: 5, desc: "Keep at least this much energy before firing lightning" },
  mortarMinDist: { def: 22.8, min: 5, max: 80, step: 5, desc: "Don't fire the mortar at targets closer than this (m)" },
  upgOrder: { def: 0, min: 0, max: 3, step: 1, int: true, desc: "Upgrade order: 0 = plating, nanites, armor, then damage; 1 = plating, armor, damage, nanites; 2 = damage first; 3 = armor, plating, laser (the old bot's)" },
  salt: { def: 0, min: 0, max: 1e6, step: 1, int: true, desc: "Changes the bot's own random numbers (strafe timing, wander points) without changing any rule; 0 = seeded from the match seed alone" },
  ffaDeaths: { def: 3, min: 1, max: 8, step: 1, int: true, desc: "This many deaths that were not our kills mean a free-for-all" },
  ffaCareful: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = in a free-for-all, fight only mechs within ffaEngR, mechs that hit us and mechs that can be finished, and retreat earlier (ffaEvHp, ffaEvHp2, three in contact)" },
  ffaEngR: { def: 50, min: 30, max: 250, step: 15, desc: "Free-for-all: fight mechs within this distance (m)" },
  ffaEvHp: { def: 0.45, min: 0.1, max: 0.9, step: 0.05, desc: "Free-for-all: retreat below this fraction of max HP" },
  ffaEvHp2: { def: 0.7, min: 0.1, max: 0.95, step: 0.05, desc: "Free-for-all: same, with two or more mechs in contact" },
  detect: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = decide the game type from what it sees: a mech that dies in the first detectEarlyT seconds without our doing = free-for-all (nothing else kills one that early); two mechs close together, in sight of each other and not aiming at each other for 2 s = a squad, and then ffaDeathsSquad such deaths are needed instead of ffaDeaths. 0 = only the ffaDeaths rule (as before)" },
  detectEarlyT: { def: 60, min: 0, max: 120, step: 10, desc: "With detect on: a death that was not our doing before this match time (s) means a free-for-all (the zone covers every spawn until 60 s)" },
  detectEarlySquadN: { def: 2, min: 1, max: 5, step: 1, int: true, desc: "With detect on and a squad seen: this many early deaths that were not our doing are needed instead of one (in 200 practice matches one house bot died that way, at 38 s, after a squad had been seen)" },
  detectHurt: { def: 0, min: 0, max: 0.95, step: 0.05, desc: "With detect on: a mech we never hit, seen below this fraction of its HP before detectHurtT, means a free-for-all (somebody else shot it); 0 = off" },
  detectHurtT: { def: 60, min: 0, max: 200, step: 10, desc: "detectHurt applies until this match time (s): later the zone hurts mechs too" },
  detectUntil: { def: 120, min: 30, max: 480, step: 20, desc: "With detect on: decide for a free-for-all only before this match time (s). Late in a practice match house bots die to the zone and to drones, and the cautious mode would cost the long matches that are worth the most" },
  ffaAssume: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "LAB, for measuring only: 1 = treat every match as a free-for-all from the first second (what perfect, instant detection would give)" },
  ffaDeathsSquad: { def: 4, min: 3, max: 99, step: 1, int: true, desc: "With detect on and a squad seen: this many deaths that were not our kills (before detectUntil) still mean a free-for-all (99 = never)" },
  detectEarlyAny: { def: 2, min: 1, max: 9, step: 1, int: true, desc: "With detect on: this many deaths that were not our kills before detectEarlyT mean a free-for-all, also when we were shooting at the time (9 = off)" },
  ffaHide: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = in a free-for-all, with nobody in contact and nothing to collect, walk to a spot few places can see, toward the edge of the next circle, and stand there until the zone moves (instead of roaming)" },
  hideFrac: { def: 0.75, min: 0.2, max: 0.8, step: 0.05, desc: "With ffaHide: the spot is within this fraction of the next circle's radius from its center" },
  hideEdge: { def: 10, min: 0, max: 40, step: 3, desc: "With ffaHide: how much it prefers a spot far from the next circle's center (0 = only how hidden and how near the spot is)" },
  hideSearch: { def: 110, min: 40, max: 250, step: 20, desc: "With ffaHide: how far around it looks for the spot (m)" },
  ffaQuiet: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = in a free-for-all, shoot no crates and no drones for cubes and go for no supply drops (noise and tracer lines give the spot away)" },
  ffaArmed: { def: 0, min: 0, max: 1, step: 1, int: true, desc: "1 = the free-for-all restraint (ffaCareful, ffaHide, ffaQuiet) starts only once the second weapon slot is filled or the match is older than armFirstT" },
  ffaFightN: { def: 0, min: 0, max: 16, step: 1, int: true, desc: "Free-for-all: with this many or fewer mechs alive, drop the restraint and fight as in practice (0 = never)" },
  holdStill: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "With no goal pulling and nothing to dodge or strafe: 1 = stand still; 0 = keep drifting in the last direction (always moving, but it walks out of cover)" },
  useField: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = when one path search cannot reach a far goal, fill a distance field from the goal over the next decisions and follow it (else the bot walks to the cell nearest the goal as the crow flies, which can be a dead end)" },
  useEscape: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = when no walking route leads out of where it stands (an enclosed courtyard, a roof), jump and jet over the wall toward the nearest spot that has one" },
  stuckSecs: { def: 1.43, min: 0.6, max: 4, step: 0.3, desc: "Counts as stuck after trying to move for this long (s) without getting anywhere: sidestep with a jump" }
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
class Nav {
  static CELL = 4;
  x0;
  y0;
  nx;
  ny;
  h;
  free;
  tight;
  clr;
  wx;
  wy;
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
    this.tight = new Uint8Array(n);
    this.wx = new Float32Array(n);
    this.wy = new Float32Array(n);
    this.clr = new Float32Array(n);
    const fits = (px, py, hz, r) => {
      if (!world.inBounds(px, py, 3.5) || world.prismWallAt(px, py, hz, 9, 1.2))
        return false;
      for (let q = 0;q < 8; q++) {
        const ax = px + r * Math.cos(q * Math.PI / 4), ay = py + r * Math.sin(q * Math.PI / 4);
        if (world.prismWallAt(ax, ay, hz, 9, 1.2) || world.ground(ax, ay) > hz + 3.5)
          return false;
      }
      return true;
    };
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
        this.wx[k] = cx;
        this.wy[k] = cy;
        if (ok) {
          let c = 3;
          for (const r of [3.4, 3.8, 4.3, 5, 6]) {
            if (!fits(cx, cy, hz, r))
              break;
            c = r;
          }
          this.clr[k] = c;
        }
        if (!ok && world.inBounds(cx, cy, 3.5)) {
          for (let q = 0;q < 9; q++) {
            const px = cx + (q === 0 ? 0 : 1.4 * Math.sign(Math.round(Math.cos(q * Math.PI / 4)))), py = cy + (q === 0 ? 0 : 1.4 * Math.sign(Math.round(Math.sin(q * Math.PI / 4))));
            const g2 = world.ground(px, py), h2 = world.floorAt(px, py, g2 + 2.5, 1.2);
            if (!fits(px, py, h2, 2.65))
              continue;
            this.tight[k] = 1;
            this.clr[k] = 2.65;
            this.wx[k] = px;
            this.wy[k] = py;
            this.h[k] = h2;
            this.onTop[k] = h2 > g2 + 0.3 ? 1 : 0;
            break;
          }
        }
      }
  }
  exits = null;
  canExit(k) {
    if (!this.exits) {
      const n = this.nx * this.ny, nx = this.nx;
      const ok = (q) => this.free[q] === 1 || this.tight[q] === 1;
      const comp = new Int32Array(n).fill(-1);
      let bestId = -1, bestSize = 0, bestSeed = -1, ids = 0;
      const stack = [];
      for (let s = 0;s < n; s++) {
        if (!ok(s) || comp[s] >= 0)
          continue;
        const id = ids++;
        let m = 0;
        comp[s] = id;
        stack.push(s);
        while (stack.length) {
          const c = stack.pop();
          m++;
          const ci = c % nx, cj = Math.floor(c / nx);
          for (let q = 0;q < 4; q++) {
            const i = ci + (q === 0 ? 1 : q === 1 ? -1 : 0), j = cj + (q === 2 ? 1 : q === 3 ? -1 : 0);
            if (i < 0 || j < 0 || i >= nx || j >= this.ny)
              continue;
            const b = j * nx + i;
            if (comp[b] >= 0 || !ok(b) || !this.step(c, b) || !this.step(b, c))
              continue;
            comp[b] = id;
            stack.push(b);
          }
        }
        if (m > bestSize) {
          bestSize = m;
          bestId = id;
          bestSeed = s;
        }
      }
      const ex = new Uint8Array(n);
      if (bestSeed >= 0) {
        for (let s = 0;s < n; s++)
          if (comp[s] === bestId) {
            ex[s] = 1;
            stack.push(s);
          }
        while (stack.length) {
          const c = stack.pop();
          const ci = c % nx, cj = Math.floor(c / nx);
          for (let q = 0;q < 4; q++) {
            const i = ci + (q === 0 ? 1 : q === 1 ? -1 : 0), j = cj + (q === 2 ? 1 : q === 3 ? -1 : 0);
            if (i < 0 || j < 0 || i >= nx || j >= this.ny)
              continue;
            const b = j * nx + i;
            if (ex[b] || !ok(b) || !this.step(b, c))
              continue;
            ex[b] = 1;
            stack.push(b);
          }
        }
      }
      this.exits = ex;
    }
    return this.exits[k] === 1;
  }
  cellOf(x, y) {
    const i = Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.x0) / Nav.CELL))), j = Math.max(0, Math.min(this.ny - 1, Math.floor((y - this.y0) / Nav.CELL)));
    return j * this.nx + i;
  }
  center(k) {
    return [this.wx[k], this.wy[k]];
  }
  isFree(x, y) {
    return this.free[this.cellOf(x, y)] === 1;
  }
  step(a, b, strict = false) {
    if (!this.free[b] && (strict || !this.tight[b]))
      return false;
    const dh = this.h[b] - this.h[a];
    return dh <= (this.onTop[b] ? 1.2 : 4);
  }
  nearestFree(k, maxR = 8) {
    if (this.free[k] || this.tight[k])
      return k;
    const i0 = k % this.nx, j0 = Math.floor(k / this.nx);
    let best = -1, bd = Infinity;
    for (let r = 1;r <= maxR && best < 0; r++)
      for (let j = j0 - r;j <= j0 + r; j++)
        for (let i = i0 - r;i <= i0 + r; i++) {
          if (i < 0 || j < 0 || i >= this.nx || j >= this.ny || Math.abs(i - i0) !== r && Math.abs(j - j0) !== r)
            continue;
          const q = j * this.nx + i;
          if (!this.free[q] && !this.tight[q])
            continue;
          const d = (i - i0) ** 2 + (j - j0) ** 2;
          if (d < bd) {
            bd = d;
            best = q;
          }
        }
    return best;
  }
  walkable(ax, ay, bx, by, need = 0) {
    const d = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(d / 2));
    let prev = this.cellOf(ax, ay);
    for (let q = 1;q <= n; q++) {
      const k = this.cellOf(ax + (bx - ax) * q / n, ay + (by - ay) * q / n);
      if (k === prev)
        continue;
      if (!this.step(prev, k, true) || this.clr[k] < need)
        return false;
      prev = k;
    }
    return true;
  }
  lastPartial = false;
  fieldNew() {
    const n = this.nx * this.ny;
    return { goal: -1, dist: new Int32Array(n), q: new Int32Array(n), head: 0, tail: 0, done: true };
  }
  fieldStart(f, goal) {
    f.goal = goal;
    f.dist.fill(-1);
    f.head = 0;
    f.tail = 0;
    f.done = goal < 0;
    if (goal >= 0) {
      f.dist[goal] = 0;
      f.q[f.tail++] = goal;
    }
  }
  fieldPump(f, maxCells) {
    const nx = this.nx, ny = this.ny;
    let n = 0;
    while (f.head < f.tail && n++ < maxCells) {
      const c = f.q[f.head++], ci = c % nx, cj = (c - ci) / nx, d = f.dist[c] + 1;
      for (let q = 0;q < 4; q++) {
        const i = ci + (q === 0 ? 1 : q === 1 ? -1 : 0), j = cj + (q === 2 ? 1 : q === 3 ? -1 : 0);
        if (i < 0 || j < 0 || i >= nx || j >= ny)
          continue;
        const b = j * nx + i;
        if (f.dist[b] >= 0 || !this.free[b] && !this.tight[b] || !this.step(b, c))
          continue;
        f.dist[b] = d;
        f.q[f.tail++] = b;
      }
    }
    if (f.head >= f.tail)
      f.done = true;
  }
  fieldPath(f, x, y, maxSteps) {
    let c = this.nearestFree(this.cellOf(x, y));
    if (c < 0 || f.dist[c] < 0)
      return null;
    const nx = this.nx, out = [];
    for (let s = 0;s < maxSteps && f.dist[c] > 0; s++) {
      const ci = c % nx, cj = (c - ci) / nx;
      let best = -1, bd = f.dist[c];
      for (let dj = -1;dj <= 1; dj++)
        for (let di = -1;di <= 1; di++) {
          if (!di && !dj)
            continue;
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= nx || j >= this.ny)
            continue;
          const b = j * nx + i;
          if (f.dist[b] < 0 || f.dist[b] >= bd || !this.step(c, b))
            continue;
          if (di && dj && (!this.step(c, cj * nx + i) || !this.step(c, j * nx + ci)))
            continue;
          best = b;
          bd = f.dist[b];
        }
      if (best < 0)
        break;
      c = best;
      out.push(this.center(c));
    }
    return out.length ? out : null;
  }
  path(sx, sy, tx, ty, maxExpand = 14000, deadline = Infinity, need = 0) {
    const s = this.nearestFree(this.cellOf(sx, sy)), goal = this.nearestFree(this.cellOf(tx, ty));
    this.lastPartial = true;
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
      if (deadline !== Infinity && (expanded & 127) === 0 && performance.now() > deadline)
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
          const g = this.gScore[cur] + (di && dj ? Math.SQRT2 : 1) + (this.tight[nb] ? 2.5 : 0) + (this.clr[nb] < need ? 5 : 0);
          if (this.seen[nb] === gen && g >= this.gScore[nb])
            continue;
          this.seen[nb] = gen;
          this.gScore[nb] = g;
          this.from[nb] = cur;
          f[nb] = g + 1.25 * hx(nb);
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
    this.lastPartial = best !== goal;
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
  let nav = world.__provenNav;
  if (!nav) {
    nav = new Nav(world);
    nav.canExit(0);
    world.__provenNav = nav;
  }
  return nav;
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
var clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
var NDIR = 16;
var DIRX = new Float64Array(NDIR);
var DIRY = new Float64Array(NDIR);
for (let i = 0;i < NDIR; i++) {
  DIRX[i] = Math.cos(i * 2 * Math.PI / NDIR);
  DIRY[i] = Math.sin(i * 2 * Math.PI / NDIR);
}
var UPGRADE_ORDERS = [
  ["plating", "nanites", "armor", "servos", "laser_damage", "gun_damage", "jets", "reactor", "capacitor", "gun_rate", "laser_charge", "lightning_efficiency", "lightning_range", "lightning_chain", "gun_mag", "gun_velocity", "gyros", "sensors"],
  ["plating", "armor", "laser_damage", "gun_damage", "nanites", "laser_charge", "gun_rate", "lightning_efficiency", "servos", "gun_velocity", "gyros", "gun_mag", "lightning_chain", "reactor"],
  ["laser_damage", "gun_damage", "plating", "gun_rate", "armor", "laser_charge", "gun_mag", "nanites", "servos", "jets", "reactor", "capacitor", "gun_velocity"],
  ["armor", "plating", "laser_charge", "laser_damage", "nanites", "gun_rate", "gun_damage", "lightning_efficiency", "gyros", "servos"]
];
function interceptT(dx, dy, dz, vx, vy, vz, speed) {
  const a = vx * vx + vy * vy + vz * vz - speed * speed;
  const b = 2 * (dx * vx + dy * vy + dz * vz);
  const c = dx * dx + dy * dy + dz * dz;
  if (Math.abs(a) < 0.000000001)
    return b < 0 ? -c / b : 0;
  const disc = b * b - 4 * a * c;
  if (disc < 0)
    return 0;
  const r = Math.sqrt(disc);
  const t1 = (-b - r) / (2 * a), t2 = (-b + r) / (2 * a);
  const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
  return lo > 0 ? lo : hi > 0 ? hi : 0;
}
function makeBot(hello, world, params, opts) {
  const Q = { ...DEFAULTS, ...params ?? {} };
  const cfg = hello.config;
  const saltBits = Math.imul(Math.round(Q.salt) | 0, 2654435761);
  const rng = new Rng(hello.seed ^ saltBits);
  const nav = navOf(world);
  const unstick = makeUnstick(new Rng(hello.seed ^ 625341585 ^ saltBits), Math.max(0.6, Q.stuckSecs));
  const nMechs = cfg.match?.mechs ?? 16;
  const upg = UPGRADE_ORDERS[clamp(Math.round(Q.upgOrder), 0, UPGRADE_ORDERS.length - 1)];
  const wval = { laser: Q.valLaser, lightning: Q.valLightning, mortar: Q.valMortar, gun: 2 };
  const sizePerCube = Number(cfg.cubes?.size_per_cube) || 0;
  const baseR = cfg.mech?.radius ?? 2.5, baseH = cfg.mech?.height ?? 9;
  const tracks = new Map;
  const pickMem = new Map, crateMem = new Map, cubeMem = new Map;
  const ignore = new Map;
  let kills = 0, ffa = false;
  let gameSquad = false, calmSince = -1, calmLast = -99;
  let foreign = 0, foreignEarly = 0, lastGone = 0, lastHitT = -99, oldRule = false, riseT = -1, riseOk = false, lateSaid = false;
  const hitIds = new Set;
  let strangerMin = 1;
  let lair = null, lairKey = NaN, lairCand = [], lairI = 0, lairTop = [];
  const dbgOn = !!globalThis.process?.env?.V5_DBG;
  const dbg = (ev, t, extra = "") => {
    if (dbgOn)
      console.error(`@@v5 ${hello.seed} ${Q.dbgTag ?? 0} ${ev} ${t.toFixed(1)} ${extra}`);
  };
  let targetId = -1, strafe = 1, strafeFlipT = 0;
  let hiding = false, coverPt = null, coverT = -99;
  let lastHurtT = -99, lastHurtBy = -1, lastMechHurtT = -99, lastThreatT = -99, lastSawTargetT = -99;
  let alertYaw = 0, alertUntil = -1;
  let scanStart = 0, scanUntil = Q.openScan, scanYaw0 = NaN, nextScanT = 12;
  let lastDX = 0, lastDY = 0;
  let wanderGoal = null;
  let chaseId = -1, chaseBest = Infinity, chaseT = 0;
  let zKey = NaN, zHoldR = NaN, zSame = 0, zStatic = false;
  let route = null;
  let tick0 = 0;
  let field = null, fieldGoal = [1e9, 1e9];
  let myR = baseR;
  let escaping = false, escPt = null, escT = -99, escMove = [0, 0], escJump = false, escBoost = false;
  const pa = [0, 0, 0], pb = [0, 0, 0];
  const los = (ax, ay, az, bx, by, bz) => {
    pa[0] = ax;
    pa[1] = ay;
    pa[2] = az;
    pb[0] = bx;
    pb[1] = by;
    pb[2] = bz;
    return world.clearLine(pa, pb);
  };
  const d2 = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  function headingTo(x, y, gx, gy, t) {
    const d = d2(x, y, gx, gy);
    if (d < 0.000001)
      return [0, 0];
    if (d < 6 || nav.walkable(x, y, gx, gy, myR))
      return [(gx - x) / d, (gy - y) / d];
    if (!route || d2(route.goal[0], route.goal[1], gx, gy) > Math.max(8, 0.1 * d) || t - route.t > 3 || route.i >= route.pts.length) {
      let pts = Q.useField >= 0.5 && field && d2(fieldGoal[0], fieldGoal[1], gx, gy) < 12 ? nav.fieldPath(field, x, y, 40) : null;
      if (!pts) {
        pts = nav.path(x, y, gx, gy, 7000, opts?.deadlineMs ? tick0 + opts.deadlineMs : Infinity, myR);
        if (Q.useField >= 0.5 && nav.lastPartial && (!field || d2(fieldGoal[0], fieldGoal[1], gx, gy) >= 12)) {
          field ??= nav.fieldNew();
          nav.fieldStart(field, nav.nearestFree(nav.cellOf(gx, gy)));
          fieldGoal = [gx, gy];
        }
      }
      route = pts ? { goal: [gx, gy], pts, i: 0, t } : null;
      if (!route)
        return [(gx - x) / d, (gy - y) / d];
    }
    const r = route;
    while (r.i < r.pts.length - 1 && d2(x, y, r.pts[r.i][0], r.pts[r.i][1]) < 4)
      r.i++;
    let k = r.i;
    for (let q = Math.min(r.pts.length - 1, r.i + 10);q > r.i; q--)
      if (nav.walkable(x, y, r.pts[q][0], r.pts[q][1], myR)) {
        k = q;
        break;
      }
    r.i = k;
    const px = r.pts[k][0] - x, py = r.pts[k][1] - y, pd = Math.hypot(px, py);
    return pd > 0.000001 ? [px / pd, py / pd] : [(gx - x) / d, (gy - y) / d];
  }
  const EXPO_D = [35, 80, 140];
  function exposure(px, py, zcx, zcy, zr) {
    const bz = nav.h[nav.cellOf(px, py)] + 4.5;
    let n = 0;
    for (let k = 0;k < NDIR; k++)
      for (let q = 0;q < 3; q++) {
        const ex = px + DIRX[k] * EXPO_D[q], ey = py + DIRY[k] * EXPO_D[q];
        if (!world.inBounds(ex, ey, 3) || d2(ex, ey, zcx, zcy) > zr)
          continue;
        const c = nav.cellOf(ex, ey);
        if (nav.free[c] && los(ex, ey, nav.h[c] + 8, px, py, bz))
          n++;
      }
    return n;
  }
  function hideGoal(x, y, zn) {
    const ncx = zn.next_center[0], ncy = zn.next_center[1], nR = zn.next_radius, maxR = Q.hideFrac * nR;
    if (nR !== lairKey) {
      lairKey = nR;
      lair = null;
      lairTop = [];
      lairCand = [];
      lairI = 0;
      const r = d2(x, y, ncx, ncy), rt = Math.min(r, maxR);
      const ax = r > 1 ? ncx + (x - ncx) / r * rt : ncx, ay = r > 1 ? ncy + (y - ncy) / r * rt : ncy;
      const R = Q.hideSearch, step = 10;
      for (let dy = -R;dy <= R; dy += step)
        for (let dx = -R;dx <= R; dx += step) {
          const px = ax + dx, py = ay + dy;
          if (Math.hypot(dx, dy) <= R && d2(px, py, ncx, ncy) <= maxR && nav.isFree(px, py) && nav.canExit(nav.cellOf(px, py)))
            lairCand.push([px, py]);
        }
      const k = nav.nearestFree(nav.cellOf(ax, ay));
      lairTop.push({ c: k >= 0 ? nav.center(k) : [ax, ay], s: 1e9 });
    }
    if (!lair) {
      if (lairI < lairCand.length) {
        for (let n = 0;n < 6 && lairI < lairCand.length; n++, lairI++) {
          const c = lairCand[lairI];
          lairTop.push({ c, s: exposure(c[0], c[1], zn.center[0], zn.center[1], zn.radius) + 0.08 * d2(x, y, c[0], c[1]) - Q.hideEdge * d2(c[0], c[1], ncx, ncy) / Math.max(nR, 30) });
        }
        if (lairI >= lairCand.length)
          lairTop.sort((a, b) => a.s - b.s);
      } else {
        const c = lairTop[0].c;
        if (lairTop.length === 1)
          lair = c;
        else {
          const pts = nav.path(x, y, c[0], c[1], 7000, opts?.deadlineMs ? tick0 + opts.deadlineMs : Infinity, myR);
          if (pts && !nav.lastPartial)
            lair = c;
          else
            lairTop.shift();
        }
      }
    }
    return lair ?? (lairI >= lairCand.length ? lairTop[0].c : null);
  }
  if (opts?.warm) {
    const w = new Rng(12345), b = world.bounds;
    const pt = () => [b.minX + w.next() * (b.maxX - b.minX), b.minY + w.next() * (b.maxY - b.minY), 0];
    for (let i = 0;i < 150; i++) {
      const a = pt(), c = pt();
      nav.path(a[0], a[1], c[0], c[1]);
      nav.walkable(a[0], a[1], c[0], c[1]);
      for (let k = 0;k < 40; k++) {
        const e = pt();
        los(a[0], a[1], world.ground(a[0], a[1]) + 7, e[0], e[1], world.ground(e[0], e[1]) + 5);
      }
    }
    try {
      const { weapons: W, mech: M, zone: Z } = cfg;
      for (let i = 0;i < 300; i++) {
        const a = pt();
        exposure(a[0], a[1], Z.start_center[0], Z.start_center[1], Z.start_radius);
      }
      const second = [null, "laser", "lightning", "mortar", "laser", "laser"];
      for (let sc = 0;sc < second.length; sc++) {
        const twin = makeBot(hello, world, params);
        let p = pt();
        for (let k = 0;k < 80 && !nav.isFree(p[0], p[1]); k++)
          p = pt();
        const nFoe = sc === 0 ? 0 : 1 + sc % 4;
        const foe = Array.from({ length: nFoe }, (_, i) => {
          const a = w.next() * 6.283, r = 25 + 40 * i + 60 * w.next();
          return { id: i + 1, x: p[0] + r * Math.cos(a), y: p[1] + r * Math.sin(a), kind: second[1 + (sc + i) % 3] };
        });
        for (let n = 0;n < 70; n++) {
          const gz = world.ground(p[0], p[1]);
          const hurt = sc >= 2 && n > 20;
          const fake = {
            type: "obs",
            tick: 2 * n,
            t: 0.1 * n,
            alive: nMechs,
            self: {
              id: hello.slot ?? 0,
              pos: [p[0], p[1], gz],
              vel: [0, 0, 0],
              aim: [n * 0.3 % 3, 0],
              hp: M.hp * (hurt ? 0.3 : 0.95),
              max_hp: M.hp,
              energy: 20 + n * 7 % 80,
              max_energy: M.energy ?? 100,
              grounded: true,
              cubes: sc,
              upgrades: [],
              in_zone: sc !== 5,
              stats: M,
              weapons: [{ kind: "gun", cooldown: 0, ammo: n % 13, reload: n % 13 ? 0 : 1.2, stats: W.gun }, second[sc] ? { kind: second[sc], cooldown: 0, charge: second[sc] === "laser" ? n % 10 * 0.08 : undefined, stats: W[second[sc]] } : null]
            },
            mechs: foe.map((f, i) => ({ id: f.id, kind: "mech", pos: [f.x, f.y, world.ground(f.x, f.y)], vel: [8 * Math.cos(n + i), 8 * Math.sin(n + i), 0], aim: [Math.atan2(p[1] - f.y, p[0] - f.x), 0], hp: 200 + 300 * i + 5 * n, max_hp: M.hp, cubes: i, weapons: ["gun", f.kind], charging: f.kind === "laser" && n % 8 < 3 })),
            projectiles: foe.slice(0, 3).map((f, i) => ({ id: 700 + i, kind: i === 2 ? "mortar" : "gun", pos: [(f.x + p[0]) / 2, (f.y + p[1]) / 2, gz + 7], vel: [(p[0] - f.x) * 2, (p[1] - f.y) * 2, i === 2 ? 15 : 0] })),
            crates: [{ id: 1001, pos: [p[0] + 35, p[1] - 12, world.ground(p[0] + 35, p[1] - 12)], hp: 300 }],
            cubes: n % 4 ? [{ id: 5001, pos: [p[0] - 18, p[1] + 22, world.ground(p[0] - 18, p[1] + 22)] }] : [],
            pickups: [{ id: 8001, kind: second[1 + n % 3], pos: [p[0] + 50, p[1] + 40, world.ground(p[0] + 50, p[1] + 40)] }],
            sounds: n % 9 ? [] : [{ kind: "step", bearing: 0.5, dist: "near", age: 0.05 }],
            beams: [],
            events: nFoe && n % 5 === 0 ? [{ type: "damaged", amount: 45, weapon: "gun", bearing: n * 0.7 % 3, by: n % 10 ? foe[0].id : 9 }] : [],
            zone: { center: Z.start_center, radius: Z.start_radius, next_center: [Z.start_center[0] + 50, Z.start_center[1] - 40], next_radius: Z.phases[0].radius, shrink_start: Z.phases[0].hold_s, shrink_end: Z.phases[0].hold_s + Z.phases[0].shrink_s, dps: Z.phases[0].dps },
            offer: n === 15 ? { id: 1, expires: 9, choices: (cfg.upgrades ?? []).slice(0, 3).map((u) => ({ id: u.id, name: u.name, desc: u.desc })) } : null,
            drops: sc === 4 ? [{ id: 20001, pos: [p[0] + 70, p[1], gz], radius: 8, lands_in: 3, capture_s: 4, progress: 0, holder: null }] : []
          };
          const a = twin.act(fake);
          const m = a.move ?? [0, 0];
          if (nav.isFree(p[0] + m[0] * 1.2, p[1] + m[1] * 1.2))
            p = [p[0] + m[0] * 1.2, p[1] + m[1] * 1.2, 0];
        }
      }
    } catch (e) {
      console.error("rehearsal failed (harmless):", e);
    }
  }
  let hybridPassive = false;
  return {
    name: "hamster",
    isFfa: () => ffa,
    setPassive: (v) => {
      hybridPassive = v;
    },
    act(obs) {
      if (opts?.deadlineMs)
        tick0 = performance.now();
      const { self: me, t } = obs;
      const x = me.pos[0], y = me.pos[1], z = me.pos[2];
      const S = me.stats;
      const radius = S.radius ?? baseR, height = S.height ?? baseH;
      myR = radius;
      const mh = S.muzzle_height ?? 7, eyeZ = z + (S.eye_height ?? 8), walk = S.walk_speed ?? 11.7;
      const hpF = me.hp / Math.max(1, me.max_hp);
      const zn = obs.zone;
      const out = { tick: obs.tick, fire: [false, false] };
      if (field && !field.done)
        nav.fieldPump(field, 6000);
      for (const m of obs.mechs) {
        const npc = m.kind === "npc";
        const scale = npc ? 1 : 1 + sizePerCube * (m.cubes ?? 0);
        const old = tracks.get(m.id);
        tracks.set(m.id, {
          id: m.id,
          npc,
          x: m.pos[0],
          y: m.pos[1],
          z: m.pos[2],
          vx: m.vel[0],
          vy: m.vel[1],
          vz: m.vel[2],
          yaw: m.aim[0],
          hp: m.hp ?? m.max_hp ?? 1400,
          maxHp: m.max_hp ?? 1400,
          cubes: m.cubes ?? 0,
          weapons: m.weapons ?? [],
          charging: !!m.charging,
          seen: t,
          phantom: false,
          r: npc ? cfg.npc?.radius ?? 1.8 : baseR * scale,
          h: npc ? cfg.npc?.height ?? 3.5 : baseH * scale,
          hitT: old?.hitT ?? -99
        });
      }
      const guess = (id, px, py, weapon, fresh) => {
        const k = tracks.get(id);
        if (k && t - k.seen <= fresh)
          return;
        const weapons = k?.weapons.length ? k.weapons.includes(weapon) ? k.weapons : [...k.weapons, weapon] : [weapon];
        tracks.set(id, { id, npc: false, x: px, y: py, z: world.ground(px, py), vx: 0, vy: 0, vz: 0, yaw: Math.atan2(y - py, x - px), hp: k?.hp ?? 1400, maxHp: k?.maxHp ?? 1400, cubes: k?.cubes ?? 0, weapons, charging: false, seen: t, phantom: true, r: baseR, h: baseH, hitT: k?.hitT ?? -99 });
      };
      if (Q.usePhantom >= 0.5)
        for (const b of obs.beams ?? []) {
          if (b.by === me.id || !b.path?.length || b.by >= 100)
            continue;
          guess(b.by, b.path[0][0], b.path[0][1], b.kind, 0.5);
        }
      for (const [id, k] of tracks)
        if (t - k.seen > 25)
          tracks.delete(id);
      const refresh = (mem, list, ttl) => {
        for (const it of list) {
          const o = mem.get(it.id);
          if (o) {
            o.x = it.pos[0];
            o.y = it.pos[1];
            o.z = it.pos[2];
            o.seen = t;
          } else
            mem.set(it.id, { id: it.id, x: it.pos[0], y: it.pos[1], z: it.pos[2], kind: it.kind ?? "", seen: t, roof: it.pos[2] - world.ground(it.pos[0], it.pos[1]) > 2.5 });
        }
        for (const [id, it] of mem) {
          if (it.seen === t)
            continue;
          if (t - it.seen > ttl || t - it.seen > 0.4 && d2(x, y, it.x, it.y) < 38 && los(x, y, eyeZ, it.x, it.y, it.z + 1))
            mem.delete(id);
        }
      };
      refresh(pickMem, obs.pickups, 150);
      refresh(crateMem, obs.crates, 150);
      refresh(cubeMem, obs.cubes, 60);
      for (const e of obs.events) {
        if (e.type === "damaged") {
          if (e.weapon === "zone")
            continue;
          lastHurtT = t;
          lastHurtBy = e.by ?? -1;
          if (e.bearing != null) {
            alertYaw = e.bearing;
            alertUntil = t + 2.5;
            if (e.by != null && e.by >= 0 && e.by < 100) {
              lastMechHurtT = t;
              const k = tracks.get(e.by);
              if (Q.usePhantom >= 0.5) {
                const D = k ? clamp(d2(x, y, k.x, k.y), 30, 250) : e.weapon === "lightning" ? 35 : 110;
                guess(e.by, x + Math.cos(e.bearing) * D, y + Math.sin(e.bearing) * D, e.weapon, 1);
              }
              const k2 = tracks.get(e.by);
              if (k2)
                k2.hitT = t;
            }
          }
        } else if (e.type === "took")
          pickMem.delete(e.id);
        else if (e.type === "take_failed") {
          if (e.reason === "gone")
            pickMem.delete(e.id);
          else
            ignore.set(e.id, t + (e.reason === "range" ? 1 : 20));
        } else if (e.type === "kill") {
          tracks.delete(e.target);
          kills++;
        } else if (e.type === "hit" && e.target < 100) {
          lastHitT = t;
          hitIds.add(e.target);
        }
      }
      if (!ffa && Q.ffaAssume >= 0.5)
        ffa = true;
      if (!ffa) {
        const gone = nMechs - obs.alive - kills;
        if (dbgOn && !oldRule && gone >= Math.round(Q.ffaDeaths)) {
          oldRule = true;
          dbg("old3", t, `alive=${obs.alive}`);
        }
        if (Q.detect >= 0.5 && (dbgOn || Q.detectHurt > 0) && t < Math.max(Q.detectHurtT, dbgOn ? 200 : 0)) {
          for (const m of obs.mechs) {
            if (m.kind === "npc" || hitIds.has(m.id))
              continue;
            const f = (m.hp ?? 1) / Math.max(1, m.max_hp ?? 1);
            if (f < strangerMin - 0.05) {
              strangerMin = f;
              dbg("stranger", t, `hp=${f.toFixed(2)}`);
            }
          }
          if (t < Q.detectHurtT && strangerMin < Q.detectHurt) {
            ffa = true;
            dbg("ffa", t, `hurt=${strangerMin.toFixed(2)} alive=${obs.alive}`);
          }
        }
        if (!ffa && Q.detect >= 0.5) {
          if (gone > lastGone) {
            if (riseT < 0) {
              riseT = t;
              riseOk = t - lastHitT > 5;
            }
            if (t - riseT >= 0.5) {
              if (riseOk) {
                foreign += gone - lastGone;
                if (riseT < Q.detectEarlyT)
                  foreignEarly += gone - lastGone;
                dbg("foreign", riseT, `n=${foreign} alive=${obs.alive}`);
              }
              lastGone = gone;
              riseT = -1;
            }
          } else {
            lastGone = gone;
            riseT = -1;
          }
          const why1 = foreignEarly >= (gameSquad ? Math.round(Q.detectEarlySquadN) : 1) ? "early" : lastGone >= Math.round(Q.detectEarlyAny) && t < Q.detectEarlyT ? "early-any" : lastGone >= Math.round(gameSquad ? Q.ffaDeathsSquad : Q.ffaDeaths) ? "count" : "";
          if (why1) {
            if (t < Q.detectUntil) {
              ffa = true;
              dbg("ffa", t, `early=${foreignEarly} by=${why1} n=${lastGone} squad=${gameSquad ? 1 : 0} alive=${obs.alive}`);
            } else if (dbgOn && !lateSaid) {
              lateSaid = true;
              dbg("ffa-late", t, `n=${lastGone} squad=${gameSquad ? 1 : 0} alive=${obs.alive}`);
            }
          } else if (!gameSquad) {
            let calm = false;
            const ms = obs.mechs;
            for (let i = 0;i < ms.length && !calm; i++) {
              const a = ms[i];
              if (a.kind === "npc")
                continue;
              for (let j = i + 1;j < ms.length; j++) {
                const b = ms[j];
                if (b.kind === "npc" || d2(a.pos[0], a.pos[1], b.pos[0], b.pos[1]) > 60)
                  continue;
                if (Math.abs(wrapAngle(Math.atan2(b.pos[1] - a.pos[1], b.pos[0] - a.pos[0]) - a.aim[0])) < 0.5 || Math.abs(wrapAngle(Math.atan2(a.pos[1] - b.pos[1], a.pos[0] - b.pos[0]) - b.aim[0])) < 0.5)
                  continue;
                if (!los(a.pos[0], a.pos[1], a.pos[2] + 8, b.pos[0], b.pos[1], b.pos[2] + 4.5))
                  continue;
                calm = true;
                break;
              }
            }
            if (calm) {
              if (t - calmLast > 0.35)
                calmSince = t;
              calmLast = t;
              if (t - calmSince >= 2) {
                gameSquad = true;
                dbg("squad", t);
              }
            }
          }
        } else if (gone >= Math.round(Q.ffaDeaths)) {
          ffa = true;
          dbg("ffa", t, `old alive=${obs.alive}`);
        }
      }
      if (alertUntil < t)
        for (const s of obs.sounds) {
          if (s.dist === "near" && s.kind !== "explosion" && s.kind !== "death" && s.kind !== "crate" && s.kind !== "drop" && s.kind !== "npc_gun") {
            alertYaw = s.bearing;
            alertUntil = t + 1.5;
            break;
          }
        }
      if (zn.shrink_end !== zKey) {
        zKey = zn.shrink_end;
        zHoldR = zn.radius;
        zSame = 0;
        zStatic = false;
      } else if (t > zn.shrink_start + 0.3 && t < zn.shrink_end - 0.3 && Math.abs(zn.radius - zn.next_radius) > 0.5) {
        if (Math.abs(zn.radius - zHoldR) < 0.001) {
          if (++zSame >= 3)
            zStatic = true;
        } else {
          zSame = 0;
          zStatic = false;
        }
      }
      const zoneAt = (tt) => {
        let f = 0;
        if (tt > zn.shrink_start && zn.shrink_end > zn.shrink_start) {
          if (zStatic)
            f = clamp((tt - zn.shrink_start) / (zn.shrink_end - zn.shrink_start), 0, 1);
          else {
            const t0 = Math.max(t, zn.shrink_start);
            f = zn.shrink_end > t0 ? clamp((tt - t0) / (zn.shrink_end - t0), 0, 1) : 1;
          }
        }
        return [zn.center[0] + (zn.next_center[0] - zn.center[0]) * f, zn.center[1] + (zn.next_center[1] - zn.center[1]) * f, zn.radius + (zn.next_radius - zn.radius) * f];
      };
      if (obs.offer) {
        let best = 0, bs = 99;
        obs.offer.choices.forEach((c, i) => {
          const s = upg.indexOf(c.id);
          const sc = s < 0 ? 50 : s;
          if (sc < bs) {
            bs = sc;
            best = i;
          }
        });
        out.pick = best;
      }
      if (hybridPassive)
        return {};
      const slot = (kind) => me.weapons.findIndex((w) => w?.kind === kind);
      const sGun = slot("gun"), sLaser = slot("laser"), sLight = slot("lightning");
      const ncx = zn.next_center[0], ncy = zn.next_center[1], nr = zn.next_radius;
      const live = zoneAt(t);
      const dNext = d2(x, y, ncx, ncy) - nr;
      let mustGo = !me.in_zone;
      if (dNext >= -6 && !mustGo) {
        let tEdge = Infinity;
        for (let tt = Math.max(t, zn.shrink_start);; tt += 1) {
          const last = tt >= zn.shrink_end;
          const c = zoneAt(last ? zn.shrink_end : tt);
          if (d2(x, y, c[0], c[1]) > c[2] - 4) {
            tEdge = Math.min(tt, zn.shrink_end);
            break;
          }
          if (last)
            break;
        }
        const walkIn = Math.max(0, dNext) / walk;
        if (tEdge - t < Q.zoneLead + walkIn * Q.zoneWalkK)
          mustGo = true;
        if (zn.dps >= 60 && t > zn.shrink_start - (walkIn / 0.6 + Q.zoneLateLead))
          mustGo = true;
      }
      const king = nr <= 25.5;
      const threats = [];
      let exposed = false, unseenShooter = false;
      for (const k of tracks.values()) {
        if (k.npc || t - k.seen > 3 || d2(x, y, k.x, k.y) > 300)
          continue;
        threats.push(k);
      }
      const nT = threats.length;
      if (nT > 1)
        threats.sort((a, b) => d2(x, y, a.x, a.y) - d2(x, y, b.x, b.y));
      if (nT)
        lastThreatT = t;
      const underFire = t - lastMechHurtT < 3;
      const hurtByMech = lastHurtBy >= 0 && lastHurtBy < 100 && t - lastHurtT < 4;
      let nAtk = 0;
      for (const k of threats)
        if (t - k.hitT < 4)
          nAtk++;
      let target = null, targetLos = false, targetDist = Infinity, bestScore = -1e9;
      for (const k of threats) {
        if (k.phantom) {
          if (t - k.seen < 1.5) {
            exposed = true;
            unseenShooter = true;
          }
          continue;
        }
        if (k.seen < t - 0.01)
          continue;
        const d = Math.hypot(k.x - x, k.y - y, k.z - z);
        let frac = 0.5;
        let l = los(x, y, z + mh, k.x, k.y, k.z + k.h * 0.5);
        if (!l && los(x, y, z + mh, k.x, k.y, k.z + k.h * 0.86)) {
          l = true;
          frac = 0.86;
        }
        if (l)
          exposed = true;
        let s = -d / Q.tsD - k.hp / Math.max(1, k.maxHp) * Q.tsHp + (l ? Q.tsLos : 0);
        if (k.id === targetId)
          s += Q.tsStick;
        if (k.id === lastHurtBy && t - lastHurtT < 4)
          s += Q.tsAtk;
        if (s > bestScore) {
          bestScore = s;
          targetLos = l;
          targetDist = d;
          target = { id: k.id, kind: "mech", x: k.x, y: k.y, z: k.z, vx: k.vx, vy: k.vy, vz: k.vz, r: k.r, h: k.h, hp: k.hp, maxHp: k.maxHp, weapons: k.weapons, frac };
        }
      }
      const tk0 = target;
      targetId = tk0 ? tk0.id : -1;
      if (tk0 && targetLos)
        lastSawTargetT = t;
      const finishable = !!tk0 && (tk0.hp < me.hp * 0.5 || tk0.hp < 0.55 * tk0.maxHp && me.hp > tk0.hp * 1.3);
      const outgunned = Q.useOutgun >= 0.5 && !!tk0 && tk0.weapons.includes("laser") && sLaser < 0 && targetDist > 55;
      const ffaOn = ffa && !(Q.ffaFightN >= 0.5 && obs.alive <= Math.round(Q.ffaFightN)) && !(Q.ffaArmed >= 0.5 && t < Q.armFirstT && me.weapons.some((w) => !w));
      const careful = ffaOn && Q.ffaCareful >= 0.5;
      const hideMode = ffaOn && Q.ffaHide >= 0.5, quietMode = ffaOn && Q.ffaQuiet >= 0.5;
      let hide = hiding;
      let fight;
      let mayStart = true;
      if (careful) {
        if (!hide) {
          if (nT > 0 && hpF < (nT >= 2 ? Q.ffaEvHp2 : Q.ffaEvHp) && !finishable)
            hide = true;
          if (nT >= 3)
            hide = true;
          if (unseenShooter && underFire && !tk0)
            hide = true;
          if (outgunned && hpF < 0.85 && !finishable)
            hide = true;
        } else if (nT === 0) {
          if (hpF > 0.85 || t - lastThreatT > 10)
            hide = false;
        } else if (nT === 1 && (hpF > 0.85 && !unseenShooter && !outgunned || finishable))
          hide = false;
        fight = nT > 0 && !hide && !!tk0 && (targetDist <= Q.ffaEngR || hurtByMech || finishable);
      } else {
        if (!hide) {
          if (nT > 0 && hpF < Q.evHp && !finishable)
            hide = true;
          if (nT >= Math.round(Q.evN))
            hide = true;
          if (nT >= 2 && hpF < Q.evHp2 + Q.evHpPer * (nT - 2))
            hide = true;
          if (nAtk >= 2 && hpF < Q.evAtk2)
            hide = true;
          if (unseenShooter && underFire && !tk0 && hpF < Q.unseenHideHp)
            hide = true;
          if (outgunned && hpF < Q.ogHp && !finishable)
            hide = true;
        } else if (nT >= 2 && hpF > Q.exHp2)
          hide = false;
        else if (nT === 0 && (hpF > Q.exHp0 || t - lastThreatT > Q.exQuiet) || nT === 1 && hpF > Q.exHp1 && !unseenShooter && !outgunned || finishable && nT === 1)
          hide = false;
        mayStart = !(Q.onlyHostile >= 0.5 || Q.armFirst >= 0.5 && t < Q.armFirstT && me.weapons.some((w) => !w) || Q.startVsLaser < 0.5 && !!tk0 && tk0.weapons.includes("laser") && sLaser < 0 && targetDist > 55);
        const provoked = !!tk0 && (targetDist <= Q.engNear || hurtByMech || t - (tracks.get(tk0.id)?.hitT ?? -99) < 6);
        fight = !hide && !!tk0 && (mayStart ? targetLos && targetDist <= Q.engR || provoked : provoked || finishable);
      }
      if (king || Q.useHide < 0.5)
        hide = false;
      hiding = hide;
      if (hide)
        fight = false;
      const evade = hide || careful && nT > 0 && !fight && !king;
      if (!target) {
        let bd = Infinity;
        const consider = (a, maxD, bonus) => {
          const d = Math.hypot(a.x - x, a.y - y, a.z - z);
          if (d > maxD || !los(x, y, z + mh, a.x, a.y, a.z + a.h * 0.5))
            return;
          if (d - bonus < bd) {
            bd = d - bonus;
            target = a;
            targetLos = true;
            targetDist = d;
          }
        };
        const calm = nT === 0 && !underFire && !hide && hpF >= Q.farmHp && t - lastThreatT > Q.farmWait && me.in_zone && !quietMode;
        for (const k of tracks.values()) {
          if (!k.npc || k.seen < t - 0.01)
            continue;
          const a = { id: k.id, kind: "npc", x: k.x, y: k.y, z: k.z, vx: k.vx, vy: k.vy, vz: k.vz, r: k.r, h: k.h, hp: k.hp, maxHp: k.maxHp, weapons: [], frac: 0.5 };
          if (k.id === lastHurtBy && t - lastHurtT < 6)
            consider(a, 200, 1000);
          else if (calm)
            consider(a, Q.npcR, 0);
        }
        if (calm)
          for (const it of obs.crates)
            consider({ id: it.id, kind: "crate", x: it.pos[0], y: it.pos[1], z: it.pos[2], vx: 0, vy: 0, vz: 0, r: cfg.crates?.radius ?? 1.4, h: cfg.crates?.height ?? 2.4, hp: it.hp ?? 300, maxHp: 300, weapons: [], frac: 0.5 }, Q.crateR, 60);
      }
      const T = target;
      let wantLos = 0;
      if (Q.usePeek >= 0.5 && nT > 0 && tk0 && fight) {
        const gun = sGun >= 0 ? me.weapons[sGun] : null, laser = sLaser >= 0 ? me.weapons[sLaser] : null, light = sLight >= 0 ? me.weapons[sLight] : null;
        let ready = false, laserHot = false;
        if (gun && (gun.ammo ?? 1) > 0 && (gun.reload ?? 0) <= 0.25)
          ready = true;
        if (laser && (laser.charge ?? 0) >= (laser.stats.charge ?? 0.75) - 0.3 && targetDist <= (laser.stats.range ?? 280) - 5) {
          ready = true;
          laserHot = true;
        }
        if (light && targetDist <= (light.stats.range ?? 45) + 6 && me.energy >= (light.stats.energy ?? 3) * 3)
          ready = true;
        let duck = false;
        for (const k of threats) {
          if (!k.charging || k.seen < t - 0.3)
            continue;
          if (Math.abs(wrapAngle(Math.atan2(y - k.y, x - k.x) - k.yaw)) < 0.3)
            duck = true;
        }
        wantLos = duck && !laserHot ? -1.6 : ready ? 1 : -Q.hideW;
      }
      let gx = x, gy = y, arrive = 1e9, why = "hold", gBoost = false, travel = false;
      const go = (px, py, arr, w, b = false) => {
        gx = px;
        gy = py;
        arrive = arr;
        why = w;
        gBoost = b;
        travel = true;
      };
      const late = t > zn.shrink_start - 20;
      const okSpot = (px, py) => late ? d2(px, py, ncx, ncy) < nr - 4 : d2(px, py, live[0], live[1]) < live[2] - 6;
      const skip = (id) => (ignore.get(id) ?? -1) > t;
      const chase = (id, d, limit) => {
        if (id !== chaseId || d < chaseBest - 2.5) {
          chaseId = id;
          chaseBest = d;
          chaseT = t;
        }
        if (t - chaseT <= limit)
          return true;
        ignore.set(id, t + 30);
        chaseId = -1;
        return false;
      };
      const gain = (kind) => {
        if (kind === "gun" || me.weapons.some((w) => w?.kind === kind))
          return 0;
        const v = wval[kind] ?? 0;
        if (me.weapons.some((w) => !w))
          return v;
        let worst = Infinity;
        for (const w of me.weapons)
          if (w && w.kind !== "gun")
            worst = Math.min(worst, wval[w.kind] ?? 0);
        return worst === Infinity ? 0 : v - worst - 0.5;
      };
      const homePoint = () => {
        const frac = nr >= 140 ? Q.homeFrac : nr >= 60 ? Q.homeFrac * 0.7 : 0;
        const R = nr * frac, d = d2(x, y, ncx, ncy);
        let hx = ncx, hy = ncy;
        if (d <= R) {
          hx = x;
          hy = y;
        } else if (R > 0) {
          hx = ncx + (x - ncx) / d * R;
          hy = ncy + (y - ncy) / d * R;
        }
        const c = nav.nearestFree(nav.cellOf(hx, hy), 6);
        if (c >= 0) {
          const p = nav.center(c);
          return [p[0], p[1]];
        }
        return [ncx, ncy];
      };
      const seenBy = (px, py, except = -1) => {
        const g = world.ground(px, py);
        let n = 0, cnt = 0;
        for (const k of threats) {
          if (k.id === except)
            continue;
          if (++cnt > 4)
            break;
          const ez = k.z + k.h * 0.89;
          if (los(k.x, k.y, ez, px, py, g + height * 0.5) || los(k.x, k.y, ez, px, py, g + height - 0.5))
            n++;
        }
        return n;
      };
      const coverSpot = () => {
        if (coverPt && t - coverT < 0.3)
          return coverPt;
        if (coverPt && t - coverT < 1.5 && seenBy(coverPt[0], coverPt[1]) === 0)
          return coverPt;
        if (opts?.deadlineMs && coverPt && performance.now() - tick0 > opts.deadlineMs * 0.5)
          return coverPt;
        const soon = zoneAt(t + 6);
        const lead = zn.shrink_start - t;
        const outPen = lead > 40 ? 0.5 : lead > 0 ? 0.5 + (40 - lead) / 40 * 3.5 : 6;
        let best = -1e9, bx = x, by = y, bestSeen = 99;
        const consider = (px, py, r, bonus) => {
          if (!nav.isFree(px, py) || d2(px, py, soon[0], soon[1]) > soon[2] - 5)
            return;
          const seen = seenBy(px, py);
          let s = bonus - 3 * seen - r / 35;
          let near = Infinity;
          for (const k of threats)
            near = Math.min(near, d2(px, py, k.x, k.y));
          if (near < Infinity)
            s += Math.min(near, 150) / 75;
          if (near < Q.coverKeep)
            s -= (Q.coverKeep - near) / 15;
          if (d2(px, py, ncx, ncy) > nr - 5)
            s -= outPen;
          if (s > best) {
            best = s;
            bx = px;
            by = py;
            bestSeen = seen;
          }
        };
        if (coverPt)
          consider(coverPt[0], coverPt[1], d2(x, y, coverPt[0], coverPt[1]), 0.8);
        const ring = (r) => {
          if (r === 0)
            consider(x, y, 0, 0);
          else
            for (let k = 0;k < NDIR; k++)
              consider(x + DIRX[k] * r, y + DIRY[k] * r, r, 0);
        };
        for (const r of [0, 6, 12, 20, 30, 42, 56, 72])
          ring(r);
        if (bestSeen > 0)
          for (const r of [95, 125])
            ring(r);
        coverPt = [bx, by];
        coverT = t;
        return coverPt;
      };
      const backOff = (kx, ky, kid) => {
        const soon = zoneAt(t + 5), d = d2(x, y, kx, ky);
        let best = -1e9, bx = 0, by = 0;
        for (const r of [22, 38])
          for (let i = 0;i < NDIR; i++) {
            const px = x + DIRX[i] * r, py = y + DIRY[i] * r;
            if (!nav.isFree(px, py) || !nav.walkable(x, y, px, py))
              continue;
            if (d2(px, py, soon[0], soon[1]) > soon[2] - 8 || late && d2(px, py, ncx, ncy) > nr - 6)
              continue;
            let s = d2(px, py, kx, ky), near = Infinity;
            for (const th of threats)
              if (th.id !== kid)
                near = Math.min(near, d2(px, py, th.x, th.y));
            if (near < 90)
              s -= (90 - near) * 0.8;
            if (s > best) {
              best = s;
              bx = px;
              by = py;
            }
          }
        return best > d + 6 ? [bx, by] : null;
      };
      const fightsClose = sLight >= 0 && sLaser < 0 && Q.litClose >= 0.5;
      const decide = () => {
        if (mustGo) {
          const h = homePoint();
          return go(h[0], h[1], 3, "zone", !me.in_zone && me.energy > Q.boostEnergyOutside);
        }
        if (king)
          return go(ncx, ncy, 0.5, "king", d2(x, y, ncx, ncy) > nr + 10);
        if (!fightsClose) {
          let lk = null, ld = evade ? Math.min(47, Q.litAvoid) : Q.litAvoid;
          for (const k of threats) {
            if (k.phantom || t - k.seen > 1 || !k.weapons.includes("lightning"))
              continue;
            const d = d2(x, y, k.x, k.y);
            if (d < ld) {
              ld = d;
              lk = k;
            }
          }
          if (lk) {
            const b = backOff(lk.x, lk.y, lk.id);
            if (b) {
              go(b[0], b[1], 2, "fight-back", ld < Q.litAvoid - 15 && me.energy > 30);
              travel = false;
              return;
            }
          }
        }
        if (nT > 0 && hpF > Q.grabHp) {
          const contested = (px, py, d) => threats.some((k) => {
            const kd = d2(px, py, k.x, k.y);
            return kd + 10 < d || !fightsClose && !k.phantom && k.weapons.includes("lightning") && kd < Q.litAvoid + 10;
          });
          let gc = null, gd = careful ? Q.grabCube * 0.55 : Q.grabCube;
          for (const it of cubeMem.values()) {
            if (it.roof || skip(it.id) || !okSpot(it.x, it.y))
              continue;
            const d = d2(x, y, it.x, it.y);
            if (d < gd && !contested(it.x, it.y, d)) {
              gd = d;
              gc = it;
            }
          }
          if (gc && chase(gc.id, gd, 6))
            return go(gc.x, gc.y, 0.8, "grab-cube");
          let gw = null, gs = 0;
          for (const it of pickMem.values()) {
            if (it.roof || skip(it.id) || !okSpot(it.x, it.y))
              continue;
            const g = gain(it.kind), d = d2(x, y, it.x, it.y);
            const reach = (it.kind === "laser" ? Q.grabLaser : me.weapons.some((w) => !w) ? Q.grabOther : 0) * (careful ? 0.6 : 1);
            if (g <= 0 || d > reach || contested(it.x, it.y, d))
              continue;
            const s = g / (d + 25);
            if (s > gs) {
              gs = s;
              gw = it;
            }
          }
          if (gw && chase(gw.id, d2(x, y, gw.x, gw.y), 9))
            return go(gw.x, gw.y, 1.2, "grab-" + gw.kind, exposed && me.energy > 50);
        }
        if (evade) {
          const c = coverSpot();
          return go(c[0], c[1], 1.5, "evade", exposed && me.energy > 30);
        }
        if (fight && tk0) {
          const k = tk0, d = d2(x, y, k.x, k.y);
          let { gmin: rmin, gmax: rmax } = Q;
          if (sLaser >= 0) {
            rmin = Q.lmin;
            rmax = Q.lmax;
          } else if (sLight >= 0 && me.energy > 25 && Q.litClose >= 0.5) {
            rmin = Q.litMin;
            rmax = Q.litMax;
          } else if (k.weapons.includes("laser")) {
            rmin = Q.vsLaserMin;
            rmax = Q.vsLaserMax;
          }
          if (k.weapons.includes("lightning") && sLight < 0)
            rmin = Math.max(rmin, Q.vsLitMin);
          if (k.hp < Q.finishFrac * k.maxHp && hpF > 0.5) {
            rmax = Math.min(rmax, Q.finishRange);
            rmin = Math.min(rmin, rmax - 15);
          }
          rmax = Math.max(rmax, rmin + 15);
          const lost = t - lastSawTargetT > 4;
          const inZone = d2(k.x, k.y, ncx, ncy) < nr + 20 || t < zn.shrink_start - 25;
          if (d > rmax + 4 && !lost && inZone)
            return go(k.x, k.y, rmax, "fight-close");
          if (d < rmin - 4 && d > 0.5) {
            const b = backOff(k.x, k.y, k.id);
            if (b) {
              go(b[0], b[1], 2, "fight-back", d < rmin - Q.backBoostM && me.energy > 45);
              travel = false;
              return;
            }
          }
          why = "fight";
          return;
        }
        if (coverPt && t - lastThreatT < 6 && t - coverT < 12 && d2(x, y, coverPt[0], coverPt[1]) < 40) {
          go(coverPt[0], coverPt[1], 2, "wary");
          travel = false;
          return;
        }
        const quiet = nT === 0;
        for (const d of obs.drops ?? []) {
          if (skip(d.id) || quietMode)
            continue;
          const dd = d2(x, y, d.pos[0], d.pos[1]);
          if (dd > Q.dropReach || d.lands_in > dd / walk + 16)
            continue;
          if (!okSpot(d.pos[0], d.pos[1]) && d.lands_in > 0)
            continue;
          if (!quiet && hpF < 0.5)
            continue;
          if (d.holder != null && d.holder !== me.id && d.progress > 1.5 && dd > 30)
            continue;
          if (dd > 6 && !chase(d.id, dd, 14))
            continue;
          return go(d.pos[0], d.pos[1], 1.5, "drop");
        }
        let bc = null, bd = Q.cubeR;
        for (const it of cubeMem.values()) {
          if (it.roof || !okSpot(it.x, it.y) || skip(it.id))
            continue;
          const d = d2(x, y, it.x, it.y);
          if (d < bd) {
            bd = d;
            bc = it;
          }
        }
        if (bc && chase(bc.id, bd, 7))
          return go(bc.x, bc.y, 0.8, "cube");
        let bw = null, bs = 0;
        const empty = me.weapons.some((w) => !w);
        for (const it of pickMem.values()) {
          if (it.roof || !okSpot(it.x, it.y) || skip(it.id))
            continue;
          const g = gain(it.kind);
          if (g <= 0)
            continue;
          const d = d2(x, y, it.x, it.y);
          if (d > (it.kind === "laser" || empty ? Q.fetchLaser : Q.fetchOther))
            continue;
          const s = g / (d + 25);
          if (s > bs) {
            bs = s;
            bw = it;
          }
        }
        if (bw && chase(bw.id, d2(x, y, bw.x, bw.y), 9))
          return go(bw.x, bw.y, 1.2, "get-" + bw.kind);
        if (quiet && hpF >= Q.farmHp && !evade && !quietMode) {
          let cr = null, cd = Q.crateWalk;
          for (const it of crateMem.values()) {
            if (it.roof || !okSpot(it.x, it.y) || skip(it.id))
              continue;
            const d = d2(x, y, it.x, it.y);
            if (d < cd) {
              cd = d;
              cr = it;
            }
          }
          if (cr) {
            if (T && T.id === cr.id) {
              why = "crate";
              return;
            }
            if (chase(cr.id, cd, 10))
              return go(cr.x, cr.y, 6, "to-crate");
          }
        }
        if (T && T.kind !== "mech") {
          why = "farm";
          return;
        }
        if (Q.seek >= 0.5 && !empty && hpF > 0.8 && !ffa) {
          let recent = null;
          for (const k of tracks.values())
            if (!k.npc && !k.phantom && t - k.seen < 20 && okSpot(k.x, k.y) && (!recent || k.seen > recent.seen))
              recent = k;
          if (recent && d2(x, y, recent.x, recent.y) > 40)
            return go(recent.x, recent.y, 30, "seek");
        }
        if (hideMode) {
          const g = hideGoal(x, y, zn);
          if (g) {
            if (d2(x, y, g[0], g[1]) > 4)
              return go(g[0], g[1], 2, "lair");
            why = "lair";
            return;
          }
        }
        if (!wanderGoal || d2(wanderGoal[0], wanderGoal[1], x, y) < 15 || d2(wanderGoal[0], wanderGoal[1], ncx, ncy) > nr - 4 || rng.next() < 0.005) {
          const a = rng.range(0, 2 * Math.PI), d = Math.sqrt(rng.next()) * nr * Q.wanderFrac;
          wanderGoal = [ncx + Math.cos(a) * d, ncy + Math.sin(a) * d];
          const c = nav.nearestFree(nav.cellOf(wanderGoal[0], wanderGoal[1]), 6);
          if (c >= 0)
            wanderGoal = nav.center(c);
        }
        return go(wanderGoal[0], wanderGoal[1], 8, "roam");
      };
      decide();
      {
        const hc = nav.cellOf(x, y);
        const pocket = (nav.free[hc] === 1 || nav.tight[hc] === 1) && !nav.canExit(hc);
        const onRoof = me.grounded && z - nav.h[nav.cellOf(x, y)] > 3 && z - world.ground(x, y) > 3;
        if (Q.useEscape >= 0.5 && (onRoof || pocket || escaping && !me.grounded)) {
          if (!escPt || t - escT > 6) {
            let best = Infinity;
            escPt = null;
            for (const r of [10, 16, 24, 32, 44, 60, 80])
              for (let i = 0;i < NDIR; i++) {
                const px = x + DIRX[i] * r, py = y + DIRY[i] * r;
                if (!world.inBounds(px, py, 6) || !nav.isFree(px, py) || !nav.canExit(nav.cellOf(px, py)))
                  continue;
                let top = -1e9;
                for (let q = 2;q < r; q += 2)
                  top = Math.max(top, world.surfaceTop(x + DIRX[i] * q, y + DIRY[i] * q));
                const climb = Math.max(0, top - z);
                if (climb > 45)
                  continue;
                const cost = r + 2.5 * climb + 0.15 * d2(px, py, ncx, ncy);
                if (cost < best) {
                  best = cost;
                  escPt = [px, py];
                }
              }
            escT = t;
          }
          if (escPt) {
            escaping = true;
            const ex = escPt[0] - x, ey = escPt[1] - y, ed = Math.hypot(ex, ey) || 1;
            const ux = ex / ed, uy = ey / ed;
            let top = -1e9;
            for (let q = 1;q <= 9; q += 2)
              top = Math.max(top, world.surfaceTop(x + ux * q, y + uy * q));
            const wallAhead = top > z + 1.2;
            escMove = [ux, uy];
            escJump = me.grounded && wallAhead && me.energy > Math.min(90, 25 + (top - z) * 2.2);
            escBoost = !me.grounded && z < top + 2 && me.energy > 1;
            if (me.grounded && wallAhead && !escJump)
              escMove = [0, 0];
          } else
            escaping = false;
        } else
          escaping = false;
      }
      const vx = me.vel[0], vy = me.vel[1];
      const accel = S.ground_accel ?? 58.5;
      const laserW = sLaser >= 0 ? me.weapons[sLaser] : null;
      const charging = !!laserW && (laserW.charge ?? 0) > 0;
      let boost = gBoost && me.energy > 6 && !charging;
      if (evade && exposed && me.energy > 30 && !charging)
        boost = true;
      const speed = (boost ? S.boost_speed ?? 19.5 : walk) * (charging ? S.charge_move_mult ?? 0.5 : 1);
      const gdist = d2(x, y, gx, gy);
      let gdx = 0, gdy = 0;
      if (gdist > arrive) {
        const h = headingTo(x, y, gx, gy, t);
        gdx = h[0];
        gdy = h[1];
      }
      const shots = [];
      if (Q.useDodge >= 0.5)
        for (const p of obs.projectiles) {
          const rx = p.pos[0] - x, ry = p.pos[1] - y;
          const sp2 = p.vel[0] * p.vel[0] + p.vel[1] * p.vel[1];
          if (sp2 < 1)
            continue;
          const sp = Math.sqrt(sp2);
          if (p.kind === "mortar") {
            const g = cfg.weapons?.mortar?.gravity ?? 22, dz = p.pos[2] - z;
            const tl = (p.vel[2] + Math.sqrt(Math.max(0, p.vel[2] * p.vel[2] + 2 * g * dz))) / g;
            const lx = p.pos[0] + p.vel[0] * tl, ly = p.pos[1] + p.vel[1] * tl;
            const lr = (cfg.weapons?.mortar?.splash_radius ?? 7) + radius + 2.5;
            if (d2(lx, ly, x, y) < lr + 14)
              shots.push({ px: 0, py: 0, ux: 0, uy: 0, th: Math.min(tl, 1.4), w: 2.5, land: true, lx, ly, lr });
            continue;
          }
          const th = -(rx * p.vel[0] + ry * p.vel[1]) / sp2;
          if (th <= 0 || th > 1.4)
            continue;
          if (Math.abs(rx * (p.vel[1] / sp) - ry * (p.vel[0] / sp)) > 14)
            continue;
          const bz = p.pos[2] + p.vel[2] * th;
          if (bz < z - 2 || bz > z + height + 2)
            continue;
          shots.push({ px: p.pos[0], py: p.pos[1], ux: p.vel[0] / sp, uy: p.vel[1] / sp, th, w: p.kind === "npc" ? 0.6 : 1, land: false, lx: 0, ly: 0, lr: 0 });
        }
      const forced = why === "zone" || why === "king";
      const grabbing = why.startsWith("grab");
      const goalW = forced ? 4 : grabbing ? 2.5 : why === "fight-back" ? 2.5 : 1;
      const coverW = forced ? 0.3 : grabbing ? 0.5 : 1;
      const tk = fight && T && T.kind === "mech" ? T : null;
      const jink = !tk ? 0 : targetLos ? Q.jinkLos : Q.jinkNo;
      let sx = 0, sy = 0;
      if (tk) {
        if (t >= strafeFlipT) {
          strafe = -strafe;
          strafeFlipT = t + Q.flipA + rng.next() * Q.flipB;
        }
        const d = d2(x, y, tk.x, tk.y);
        if (d > 0.5) {
          sx = -(tk.y - y) / d * strafe;
          sy = (tk.x - x) / d * strafe;
        }
      }
      const zSoon = zoneAt(t + 1);
      const insideNow = d2(x, y, zSoon[0], zSoon[1]) < zSoon[2] - 2;
      const wallAt = (px, py, rise) => !world.inBounds(px, py, 4) || world.prismWallAt(px, py, z, height, 1.2) || world.ground(px, py) > z + rise;
      let bestS = -1e9, bmx = 0, bmy = 0;
      let qx = 0, qy = 0;
      const pred = (dx, dy, sp, tau) => {
        const ex = dx * sp - vx, ey = dy * sp - vy;
        const tr = Math.hypot(ex, ey) / accel;
        if (tr < 0.000001) {
          qx = x + vx * tau;
          qy = y + vy * tau;
        } else if (tau <= tr) {
          qx = x + vx * tau + 0.5 * ex * tau * tau / tr;
          qy = y + vy * tau + 0.5 * ey * tau * tau / tr;
        } else {
          qx = x + (vx + 0.5 * ex) * tr + dx * sp * (tau - tr);
          qy = y + (vy + 0.5 * ey) * tr + dy * sp * (tau - tr);
        }
      };
      const evalDir = (dx, dy, moving) => {
        const sp = moving ? speed : 0;
        pred(dx, dy, sp, 0.45);
        const p1x = qx, p1y = qy;
        pred(dx, dy, sp, 1);
        const p2x = qx, p2y = qy;
        let s = (dx * gdx + dy * gdy) * goalW;
        if (moving && me.grounded && (wallAt(x + dx * (radius + 1), y + dy * (radius + 1), 3.2) || wallAt(x + dx * (radius + 4), y + dy * (radius + 4), 5.5)))
          s -= 6;
        for (const sh of shots) {
          pred(dx, dy, sp, sh.th);
          if (sh.land) {
            const d = d2(qx, qy, sh.lx, sh.ly);
            if (d < sh.lr)
              s -= Q.dodgeW * sh.w * (1 - d / sh.lr);
          } else {
            const miss = Math.abs((qx - sh.px) * sh.uy - (qy - sh.py) * sh.ux), safe = radius + Q.dodgeR;
            if (miss < safe) {
              const q = 1 - miss / safe;
              s -= Q.dodgeW * sh.w * q * q;
            }
          }
        }
        if (king)
          s -= d2(p1x, p1y, ncx, ncy) * 0.8;
        else if (insideNow && d2(p2x, p2y, zSoon[0], zSoon[1]) > zSoon[2] - 2)
          s -= 2.5;
        if (tk) {
          s += jink * (dx * sx + dy * sy);
          if (wantLos !== 0) {
            const tz = tk.z + tk.h * 0.5;
            const l1 = los(p1x, p1y, world.ground(p1x, p1y) + mh, tk.x, tk.y, tz);
            const l2 = los(p2x, p2y, world.ground(p2x, p2y) + mh, tk.x, tk.y, tz);
            s += coverW * wantLos * ((l1 ? 1 : -1) * Q.losW + (l2 ? 0.6 : -0.6));
          }
        }
        if (evade || nT > 1)
          s -= (evade ? 1.2 : Q.multiCover) * coverW * seenBy(p1x, p1y, tk ? tk.id : -1);
        s += 0.15 * (dx * lastDX + dy * lastDY);
        if (s > bestS) {
          bestS = s;
          bmx = moving ? dx : 0;
          bmy = moving ? dy : 0;
        }
      };
      if (gdx === 0 && gdy === 0 && Q.holdStill >= 0.5)
        evalDir(0, 0, false);
      if (gdx !== 0 || gdy !== 0)
        evalDir(gdx, gdy, true);
      for (let k = 0;k < NDIR; k++)
        evalDir(DIRX[k], DIRY[k], true);
      if (gdx === 0 && gdy === 0 && Q.holdStill < 0.5 || shots.length > 0 && (gdx !== 0 || gdy !== 0))
        evalDir(0, 0, false);
      let mag = 1;
      if (!tk && shots.length === 0 && gdist <= arrive + 3 && arrive < 100)
        mag = clamp((gdist - arrive * 0.5) / 3, 0, 1);
      if (king && gdist < 3)
        mag = clamp(gdist / 2, 0.15, 1);
      lastDX = bmx;
      lastDY = bmy;
      const wantMove = [bmx * mag, bmy * mag];
      const tryMove = travel && gdist > arrive + 4 ? wantMove : [0, 0];
      const free = unstick(t, [x, y], tryMove);
      if (free.move !== tryMove) {
        out.move = free.move;
        route = null;
      } else
        out.move = wantMove;
      if (free.jump)
        out.jump = true;
      if (escaping) {
        out.move = escMove;
        out.jump = escJump;
        why = "escape";
      }
      out.boost = escaping ? escBoost : boost && (out.move[0] !== 0 || out.move[1] !== 0);
      const fire = [false, false];
      const mz = z + mh;
      const minPitch = S.min_pitch ?? -0.7, maxPitch = S.max_pitch ?? 1.3;
      const cubeMult = 1 + (Number(cfg.cubes?.damage_per_cube) || 0) * Math.min(me.cubes, Number(cfg.cubes?.stat_cap) || 10);
      let yaw = me.aim[0], pitch = 0, haveAim = false;
      const mechT = !!T && T.kind === "mech";
      const repairing = mechT && evade && hpF < 0.85 && (Q.evadeShoot >= 0.5 ? !targetLos : t - lastHurtT > 1) && T.hp > 0.25 * T.maxHp && targetDist > 45;
      const unprovoked = mechT && (careful || !mayStart) && !fight && !hide && t - lastMechHurtT > 3 && T.hp > 0.35 * T.maxHp;
      const holdFire = repairing || unprovoked;
      if (t >= nextScanT && nT === 0 && !mechT) {
        scanStart = t;
        scanUntil = t + 1.8;
        scanYaw0 = me.aim[0];
        nextScanT = t + Q.scanEvery;
      }
      const lookAway = !!T && !mechT && (alertUntil > t || t < scanUntil) && !(T.kind === "npc" && T.id === lastHurtBy && t - lastHurtT < 6);
      if (T && !lookAway) {
        const cz = T.z + T.h * T.frac;
        const rel = (lat) => [T.x + (T.vx - me.vel[0]) * lat - x, T.y + (T.vy - me.vel[1]) * lat - y, cz + (T.vz - me.vel[2]) * lat - mz];
        const r0 = rel(0.05);
        const dist3 = Math.hypot(r0[0], r0[1], r0[2]);
        const tolYaw = Math.atan2(T.r * Q.tolYaw, dist3) + 0.002;
        const tolPitch = Math.atan2(T.h * 0.8 * Math.min(T.frac, 1 - T.frac), dist3) + 0.002;
        const errYaw = Math.abs(wrapAngle(Math.atan2(r0[1], r0[0]) - me.aim[0]));
        const errPitch = Math.abs(Math.atan2(r0[2], Math.hypot(r0[0], r0[1])) - me.aim[1]);
        const r1 = rel(0.1);
        const instYaw = Math.atan2(r1[1], r1[0]), instPitch = Math.atan2(r1[2], Math.hypot(r1[0], r1[1]));
        yaw = instYaw;
        pitch = instPitch;
        haveAim = true;
        let prio = 0;
        for (let s = 0;s < 2; s++) {
          const wp = me.weapons[s];
          if (!wp)
            continue;
          const st = wp.stats;
          if (wp.kind === "gun") {
            const g = rel(Q.gunLat);
            const tl = interceptT(g[0], g[1], g[2], T.vx, T.vy, T.vz, st.speed ?? 252);
            if (tl <= 0)
              continue;
            const lx = g[0] + T.vx * tl, ly = g[1] + T.vy * tl, lz = g[2] + T.vz * tl;
            const gyaw = Math.atan2(ly, lx), gp = Math.atan2(lz, Math.hypot(lx, ly));
            const ready = (wp.ammo ?? 1) > 0 && (wp.reload ?? 0) <= 0;
            const inRange = (st.speed ?? 252) * tl <= (st.range ?? 230) - 4;
            const worth = T.kind !== "mech" || tl <= Q.gunT || Math.hypot(T.vx, T.vy) < 3;
            const ey = wrapAngle(gyaw - me.aim[0]), ep = gp - me.aim[1];
            let onAim = Math.abs(ey) <= tolYaw && Math.abs(ep) <= tolPitch;
            if (!onAim) {
              const turn = (S.turn_rate ?? 4) * 0.05, tilt = (S.pitch_rate ?? 3) * 0.05;
              onAim = Math.abs(ey - clamp(ey, -turn, turn)) <= tolYaw && Math.abs(ep - clamp(ep, -tilt, tilt)) <= tolPitch;
            }
            if (ready && inRange && worth && targetLos && onAim && !holdFire)
              fire[s] = true;
            if (ready && inRange && prio < 1) {
              prio = 1;
              yaw = gyaw;
              pitch = gp;
            }
          } else if (wp.kind === "laser") {
            if (T.kind === "crate")
              continue;
            const full = st.charge ?? 0.75, ch = wp.charge ?? 0;
            const inRange = dist3 <= (st.range ?? 280) - 3;
            const closing = dist3 > 1 ? -(r0[0] * T.vx + r0[1] * T.vy) / dist3 : 0;
            const recently = t - lastSawTargetT < 1.5 || dist3 < 70 && closing > 2;
            let hold = false;
            if (inRange && (ch > 0 || wp.cooldown <= 0.05 && !holdFire) && (targetLos || recently || ch > 0))
              hold = true;
            if (ch > 0) {
              const minFrac = st.min_frac ?? 0.35;
              let dmg = (st.damage ?? 315) * (minFrac + (1 - minFrac) * Math.min(1, ch / full)) * cubeMult;
              if (T.weapons.includes("mortar"))
                dmg *= 1 + (st.cookoff ?? 0);
              const onAim = targetLos && inRange && errYaw <= tolYaw && errPitch <= tolPitch;
              if (onAim && ch >= (st.min_charge ?? 0.15) && (ch >= full - 0.02 || dmg >= T.hp))
                hold = false;
              if (ch >= full - 0.3 && prio < 3) {
                prio = 3;
                yaw = instYaw;
                pitch = instPitch;
              }
            }
            fire[s] = hold;
          } else if (wp.kind === "lightning") {
            const cone = (st.cone_deg ?? 30) * Math.PI / 180;
            const reserve = T.kind === "mech" ? Q.lightningEnergyMin : 40;
            if (dist3 <= (st.range ?? 45) - 2 && targetLos && me.energy >= (st.energy ?? 3) + reserve && errYaw <= cone * 0.45 && !holdFire)
              fire[s] = true;
          } else if (wp.kind === "mortar") {
            const v = st.speed ?? 72, g = st.gravity ?? 22, d = d2(x, y, T.x, T.y);
            const q = v * v * v * v - g * (g * d * d);
            if (T.kind === "mech" && d > Q.mortarMinDist && q > 0 && wp.cooldown <= 0.15 && prio < 1 && !holdFire) {
              const mp = Math.atan((v * v - Math.sqrt(q)) / (g * d)), my = Math.atan2(T.y - y, T.x - x);
              const gunW = sGun >= 0 ? me.weapons[sGun] : null;
              if (!gunW || (gunW.ammo ?? 1) <= 0 || (gunW.reload ?? 0) > 0) {
                prio = 2;
                yaw = my;
                pitch = mp;
              }
              if (Math.abs(wrapAngle(my - me.aim[0])) < 0.03 && Math.abs(mp - me.aim[1]) < 0.03)
                fire[s] = true;
            }
          }
        }
      } else if (laserW && charging) {
        fire[sLaser] = true;
      }
      if (!haveAim) {
        const moving = Math.hypot(vx, vy) > 2;
        if (!Number.isFinite(scanYaw0))
          scanYaw0 = me.aim[0];
        let recent = null;
        for (const k of tracks.values())
          if (!k.npc && t - k.seen < 12 && (!recent || k.seen > recent.seen))
            recent = k;
        if (alertUntil > t)
          yaw = alertYaw;
        else if (t < scanUntil)
          yaw = scanYaw0 + (t - scanStart + 0.1) * (S.turn_rate ?? 4) * 0.9;
        else if (recent)
          yaw = Math.atan2(recent.y - y, recent.x - x);
        else if (moving)
          yaw = Math.atan2(vy, vx) + 0.9 * Math.sin(t * 1.3);
        else
          yaw = me.aim[0] + 0.35;
        pitch = 0;
      }
      out.aim = [wrapAngle(yaw), clamp(pitch, minPitch, maxPitch)];
      out.fire = fire;
      const gunW = sGun >= 0 ? me.weapons[sGun] : null;
      if (gunW && (gunW.reload ?? 0) <= 0) {
        const ammo = gunW.ammo ?? 1, mag = gunW.stats.mag ?? 12;
        if (ammo <= 0 || !T && ammo < mag * 0.7 && t - lastSawTargetT > 1.5 || fight && !targetLos && ammo < mag * 0.34 && t - lastSawTargetT > 0.8)
          out.reload = true;
      }
      {
        const reach = (cfg.loot?.pickup_radius ?? 4) - 0.3;
        let best = 0, pick = null;
        for (const p of obs.pickups) {
          if (d2(x, y, p.pos[0], p.pos[1]) > reach || Math.abs(p.pos[2] - z) > 3.7 || skip(p.id))
            continue;
          const g = gain(p.kind);
          if (g > best) {
            best = g;
            pick = p;
          }
        }
        if (pick) {
          if (me.weapons.some((w) => !w))
            out.take = pick.id;
          else {
            let sl = -1, worst = Infinity;
            for (let s = 0;s < 2; s++) {
              const w = me.weapons[s];
              if (!w || w.kind === "gun" || w.kind === "laser" && (w.charge ?? 0) > 0)
                continue;
              const v = wval[w.kind] ?? 0;
              if (v < worst) {
                worst = v;
                sl = s;
              }
            }
            if (sl >= 0) {
              out.take = pick.id;
              out.drop = sl;
            }
          }
        }
      }
      out.debug = { label: why + (hide ? " H" : "") };
      return out;
    }
  };
}

// bot/params.json
var params_default = {};

// hybrid/warm-data.ts
var WARM_B64 = "H4sIAAAAAAACA+29y3IbybKmO++noMlsj5rEzrhH1KytL3YGe9DWfWZlMhlLokrcRZE8FFVr1SrTux93j8hERIKXkASASeDvbb1KBAEib/G5h19+//vN/V+3F29+efPp4urq5s3pm9u7m/ub9zdX9NLni/efPl7+/un+3xX94svVzf2bXwz94+LiA/1DOW1M0v70zefz2ze//P3mw+UdfWi1+vfzu4vrc/rEx8uriy9vfvn1zZ/63/9xc3f1YfWfX26u6Rf08/3F3d355fXqUvk3b7+dvnl/c01fxX/m8/n9+0/8j/vL93+8+/SvN7/o4fTNh4v3lx8u3l38eXH3F71CL3y9O7+/vLl+R99gI72Dj5b+reiAvtye/+P63edL+uXF7Xl+H/3GDOOv/nVzffHu4935+/ybYRVP38hRv/t8fvf7Jb1kBjqo3/iMy4H89vXD7xf37z7TVzj6O3K56hf1QP+Pz+P8yz0fkzp9c/Px48Xdu/vLzxc3X+U1x9fqn++uLunbf/vrni+Od874b/no+bvuzj9cfuU/t3L8JXz13/ySTt9c/HXxbvyRDvbz13/962r9SqD30j1Qlg/hH+dXf7z7cit3SalV4PO44YMqLyX+07/f3Xy9/vDu/P37C7rVLvJr55d34wtK81vO/7y856tNP/zn18+36z9KP9Npl/cam0/r7vLLxfQWvtT3F7fvvvJhrXR+Bz1CtxfvPlz8nq/hxfXF3e9/8ZunH97dXfx+wfcqtq/Qh67O/+I75cfT+cDPD70z5IMZf6TzuP96d/2O7jo91nRot5f0PJUf6enlp0JeevPL2cAXhw+svKBW9Ibm+9z48y3dSX7S6IX3n+gZuXj3+eZP+p+vV/d8VI6XxdXHdx/OP5//3rx8fvf5htbFwH/o/K78RvFvPt7dXNNFvHufr4jih/ia33N3fk1/47eba34Q6MU/L7/wg75+4RO96/KaP/Nt/G1+duhz8iTSH7/5s/xZ3fzZcgrn1ze3f7377erm/R/0J+/vvl7QCXy6+cc7uuif/3rHD1N+8fMFHf5f8vDSd33hh4a/6rd8BO+ub/imyxeF/DX0SPNivOSHwI9PQXkqXPmxrGK5meWo/pbf0NEN5f7SUy/X7Orm/EP+m79/5XXJp0OHdM/fZPmHi3/eXt3kSyA/X51/oXuVb5IsifISfZav8BWvmOt89fiv0rOTv+rDxfn9J/4mXsX5cdFy7W7fv5Ovluv64e7mVt70jS7HPy7Ob2+uv/DRyzuIgXL/y0W+ubn6cPMP4Yu2jB65CNrp6ax1RhI9GR/yRZRLQn8ir8Dx7PXKfluf9fpb5Ii+3NLpfRqvtvzwbqRImF65+MAfGPgBXx+XXvnpsMJ8xd/fX8kf+OOaHpLMVfmnLOnEV0IWnOXnolzg9ZEZNS0U/tbg8sJbv6LKKwxhOS7GHR0XP2m6Pka18m59vfgO3l5e3L2/kIVQlqIs+LKy5LN/EHrlYn5rbvj6+Pwwuz/r78i37ro81SZ/C5+pLv8aF5Ky4wsfz8kY5G8Ma6wZWVJ3Qn7NjwuZ1v+8IJNzdVGemOk+yX3hB616gY3i198u5Om6JQv09Xb6rRHjcCtQ4vfw+wc6mkKf+ctf7s/v371nI63G5/wdP8fvLv55f3cuJ/bl8l+zz9E3fL2lB4KM7v2nu4svfHPYmKtTc+pP6Q/RHdTqVMdT40+tExvOq0aO9z1xgp0FXt83Nx8bU6tdNlaGH97xjNTKrs2d5h/KuTPhrm6yHZ5dBXrTxf/39fK2WNuP9DY6/vzNvOrzCw9+vxzpu7x8+aG8lueJr+r66sgf/Ycc0nqFV/BR02OvWqrwraZ7WV0HXstyyq455bg+Zbmja0peXciSLg8fEba8wI/t+e9ku2uY0yHXL6XJy3l/JTweTtfAaLCk6kdyZHSaEUkckXIz9LcMwC/ZK/os3l2gR4Eut1bDW7rmtBLkeXfrE41sb25pjV68y3et/DWxtbfnl/kK5u+UJUTfwg5aNgrntIDeX1zf84X+1bKFPgt6Fd+elt+N3+L42tzyxeKD+nuCiVDxExmrP94V121aRQyTD7fiu307XX+Cr+n6E7b6hLbjJ4yrP2GaT5jq3NX0Cd98h2mOylTfEcYPkFdUf0I331FfX/53/kT7HerRT0znTR/ghfvh4revxffO3ikfb/Hqbm8ur++rn+8JGtkajD8J1fk+D/m14tlGlYrbJx799PIwZE95PExadt/kSRCH629yi84/rx39bxOG8m1lv+INvfWe1xqtM3ovvfDfbz7fkg9wf3Gy/hV9gtbgm/+q3L+d0FGc/D//+40cjjx4F+Sav7/Pf/JW7L544CtapexcswdMJoovTvnK7MZNX/h/Lhgof16cjK+XbzuL/3aSF9vJ/fkfF9cdXzn+hfMP8vQPsfpWwsufN1/WX/sfF7+fTK+NJ0hfyS7/yfn1hxNxnU7yUn7+q6udwnTW9P2n7bvq3UP9tvVh0vI+f395X1+g/z6+dPLb+fUf1dGaQe5GMZLPH+P0Rrk+Zqi+9o5vwsZdoa+8/0r0qL/y38r3neTtRe+3vpvenk/aVF9OfmN1Y/7nx4+X7y8JUyfl9fF50PT05ZvCt4d+OR5Jdp/KkejHj6Te7JQDYX9qfpPWW6D6TevDvT6/vuT1V10rRu/J+vXxanm6WrRfPbv5ePb+5vNv5/f5op2eCG+/nNDe5eTLyZcbIvRdx/HX26fpQvr54debrnKrz+iLqhP4/a+7eiX8vzd3X25OxhfrO31++fmEHcIT8eGfP8D1brG6z7PDq/aQDz4MXy6uv9ABrQ/v/8oLJ1++Xt5fNCw6+XxCNvefl5/Jzz4pHzs9+a+af5F3cqcnn86v/rzgS/yVV3TeaZ1QvOSm53pv7CDL5VQbj0yzrSzv0hvvGvea02PV3BTyYYtvsb4zX69/p70cXX8+/i8zEhPtTuhTJ9On7tiHu2O6i4f15NIs+60VvXE1/YGHaJ196/vqqP7PDT29f518zBB76Ig+0lGMz8yPHtTkW01XK4bZYf1Je7r3vMlaH9r55RVR8o52e9Wh6erQ1l7ahPaHj1A/e4QzjDf3u35fdiYfv7q8R53O4H/cff1MVP/9/F+XDXhjeQZOT840rcy8nT1hx/EnziB/szyt8bGDz/vm9U2oDj677+/Krnltr66+0kNLK5YDe3Ok5M+c5M+cFC+qOYOyKeg6ifzeVbtVfxAr5Vin0ynH+t++3t/wKxe146HidJzVU/joIZqeQ3zgcdabh7f5RP/HDQHrnneS1fNM11Eu7kOP8A9dvvZBro6riQBNB/W/KDB7MnkqcxstnznJn3ngCc07va7jk7eupm9/yBjnA5yD83/dvP/6hVF/RWahhlQcD+8haDZHZjqObAOccePISoRlOrL/zdsqMUWf18f1H3JIt+dfaMd1QiGCm6+/fzohp4CfQvZ+6fTvnzhU1XGo03FkC1Yf57jffpeDM+u1cfeeOSNuxHQBT6a3n8jbTziaPTu2aQPfd5PHt6/G73/iEEeWjgby4svVOS3Sy6vZ8lgfpXxCPEaORG3pSGdI1w/AszqtMQL28Aqbzu2iOL7vq+X/f7+Su0d/4MPX4p6PC824+iSLI/ye/FvygNTwbw8/3z96uusdRl6B3j15whvLgk737bdv/+XvMUF28xsvSs4FyQb6Xv73/Io2gSXpRPF/3r/yBaJ1SPtROj4KV68oSnZGgcuVTvTf1WAodPEn501+HU7p/95y3uUz/USBlkHLz+tUDu+e1z81+RL+VfNCzuhwCCdH7kuUZWg20G+roDVdvD8urz9M9reKh+aY4ZddR7TPP3++aV+nAMb116srOszLnKWbkhPj8SBBhgTZ9yTIvk2ZYX741550eWGMWcu/84qR90moufzwJW9k5N9sA8s/KUQlkTH+9xivfDhS2cQoryVkNr7vzOoVPUthpdTb8rsmPjkG8Hjv3QQzL67lQatDmDnh/OYXXkFToPbXt48wTGeGrVQHxWhJxEIxpYRidqLYmaMzpfUcGpYFSiCAZWAZWAaW7Z5ltrBM97AsrmIkhoW08kFYptcsU/zM2VWyDczikAAzwAwwA8z2ADNfYGZ6YBYoJJdhpmIfzBItAsAMMAPMALPdwywWmNkemPlV8AyzuPLzWNmDMDOrASwDy8AysGwfLFMl7C/34FmYuVXILFNpHjF7mGVqMIAZYAaYAWb7gNkY//c9MLMrqv8lmoVV6HHMzsgzKy+AZqAZaAaa7ZhmYwYg9NCMum1ippkWmqnnaaaQzgTNQDPQbC80G1MAsYdmtNwkBUDRM6rNUKuUnsEZ5QCsB86AM+AMONsHzsYkQOrBGbWC+4wznXHmn8VZpIIO4Aw4A86Asz0UzuY0QFfdLCc+iWWUC9DCMvM8yyxSmmAZWAaW7YVlOQuguroAhrQyBWfaCM708zgbAnAGnAFnwNk+cGYLznoaAYa40lKiYVch40w9i7MQETgDzoAz4GwvOPMFZz2tAEPIneaEM1r4nTgLCJwBZ8AZcLYXnMWCs55mgMGzRjDhzKxCxlmHc4YCWtAMNAPN9kEzU9IAXd0Ag6OC2EwzEuIlmsXYETqDHBBwBpwBZ3vB2ZgJ6OkHGCy1ADDONI926MSZQQktcAacAWd7wdmYCehpCBioIjZknFHIjXH2/GYzBmgCAWfAGXC2F5yNmYCejoCBY/+MM1ouQXD2fAltMkhsAmfAGXC2F5yNmYCejoCB+qBcxpnOONPP92tCSwM4A86As/3Iz+ZUQEfRmU5pFSQRQM9DZJiF8DzMUKQBloFlYNleWJbzALqnI0CnKKWzTDOdaeafVTlToBloBpqBZnuhmS006/LNQp4I4LOPRovmWc3GQSNsBpqBZqDZXmjmC81MD838yqtMM+luCubZyQAarhlgBpgBZnuBWSwwsz0wcyvHOQBPw5v6YBbhmQFmgBlgtheYuZIB6GkG0MmubMowM6pnn0lVthr5TNAMNAPN9kKzMQfge2hmVpZzAD7IjODnM5r0ZxVqZ0Ez0Aw02wvNxhxA6KEZBddCppnRPcVmtDwVJM5AM9AMNNsLzcYcQOyhmZIdpvZexgQTzZ71zSxoBpqBZqDZfmg2JgFSD80GEc9gmhnTIQlErhzCZoAZYAaY7QVmPicBeoozYspjgb0jwf8eKW2qYIN+BlgGloFl+2FZTgGYrjaASEPOTaaZyTR7NqGpHGgGmoFmoNleaGYLzXraAGJYDZICsNJ3TjR7Nmg2RNAMNAPNQLO90MwXmnXtNH1GmXE9o87pHdoCZUAZUAaU7QNlsaCspwkgCqyIZmYlVCM37WmaseuGLgDQDDQDzfZBs1ASAF1dAJEoFjPNjNBMuWdpZlA3C5qBZqDZXmg2pgB6ugCilgoz7VkZm2mm1bM0U/DNQDPQDDTbC83GFEBPF0BkJbNMMxOFZs/7ZgNoBpqBZqDZXmg2pgB6ugAiPwkEM5U3nCudnocZNpqAGWC2KJjlZU1TIekWleVydf6FmFFPmeQ6LKUTCxnyqMm3307Hj/EIkfFj/Che82FNH9V2RSVfZzQ8nGSpSdfQvv12uPAckw49TQchrZLL9Bw26OlXpGKUVoWWIz1dJz1JPdcAn8An8LlNfOYFrAaqr5/g5qmsgbhI03ep7JSajVRZnTRb5NsScTtb0L+NV4GJSaf14fILXdo3H8/5YGRRDyv17aAYHXMqxfYRWoQuXSppYV2JkGtuFVN0b1SDaBNVH6J9ph4QDUQD0UD0gXrEMad6bFe3B/GWwwm0TLWRvPW6CodHDZ6qQD5yS9vQpylAwngJtAVtQVvQ9pBpawttdV/wVrpRnC+CVClOuDV8sWhRKzPDbV8qKplxdQK3wC1wC9z2xB/sccQffGG06WO05RixI2HnmTq94VFCDyG6r2EwyfMLRAPRQDQQfbgecSy0tX20jRx4cFpk9NXKbou2pMoTQVvQFrQFbQ+Ytqnk1vralBTnzoi29EjJ6CVlno8/dOI2crwZuAVugVvgtjP+kOJRxB/SmJHzfYx2rCZpowwwJv/Yb43RfmXBaDAajEaJ72vC55hi6+z2Spxis35FVKTn0LltpdiiHR9q4BP4BD7R7vVjOBuzUbGvFV/E3qwVbXFa/mZrOEO/AmAGmC17v26fcAL1YGRKJ4kOkYqkW+nYu/HWVEd/FBvvMRWV+lAbWPWEjjYRUVdqa6BVaA0DaoHa70btSNOJgfyL9R6Ye4WYrJYfCfr/rUgRpaEtD8xrJq/7p/Vw10twvejKYstb97flYsmxfjy/+nLxbav24HT8gJ4+oKnhiXe0tNWn2lGbS0Zf1H7ICjwC6yGr+F6WTI/xkM5iOiuryXiYWPVRkFmhm+hd9SwOomZK63UYPEwITAhMyMuYkJjn3NuBfT5eqWsbQp1P+jSyHWmmEL6YCQnTUVNpKqfxFRWUWksmJLqHTMi+bc7BBmzoymQ70Dc/iS4va0vQI0V6EvS4rwM2tLZoC0GFEqqxBNHZbAkiLAEsASzBS1kCxQOCDEnE+NOm7J+UYVwgZRjfWgLlw4FZgh6yPx5UGnia+VFsC2wxB7pTS1dlc0CmlJ75UOtZEDv0ytuZOYjZHKRlmAMebrpXi6BgEWARFmARaHScZ4sQi0WolGgUPbDqVOU1XdkEB5vQBoq49O0obIIvNsH02QSbTQIrGa0qOWIrRStkEkxrEqJdlkkYYBJgEo7QJHjSI2OTEDjaq1ax2SN4NghKYZNwaOGfWNhuO9XmTYZ7ZH/fmCaiyEE1up4t3XOh4mLoDrQD7ceHdiftFsp41k8ntFfZZMdLmdmu2+mqycPZr5z9dCRVRfJZMQiur8M95wNkDAk/RLVBIPJH/n3r7WdzEI40/jPAIsAiLMAiWBagEIugxdmvPLnEqhVuFVtn38IgtNEfvvtHYRDGBLHvFJiyuc40gz7VngZrTnH50MwipO+oFdI7VwLce/wHJgEmYQkmwUhvtjJcLMkmwTYpAarwU1JIVBsFrSwiQK+d72PGN3SOMBC+G/kvwbzaSkYuD6X/bbaS9Myw+jYD3nb1oR5UAAhsB9uXwHapxiC2G47PEturQg0qhyTVe2XmDr8uy1geLmP0qO95iHT/MTmDDpswIffT5T0jl5+e+3yjzj/TZxnmHCgpV3ACFj8vmQ/fXqtZGZPGPZ3AIZY4kpUJObR4bJN9opOlWQ5tZiHZkM2K7jErbueCifsOJSWYFpiWBZiWHAJWRue0cT2yVbG1iZxWrg2Lh2H5ecPyWq3CmG5OfVZBJllaqjySzUYIdZSSNXU93bfWKpi+kZYx7Hxe2r4DSTAIMAgLMAieQMb2gEPkp80UGGpF4+AvbTVUXVlKCl+wCFBO+25bonOmuictQeXOtginSSyqfiitdAMq7l6Y9TCfdu8u0mFpT8KSwJIswZJE3lOTKaGk4qlucolkSeiekiWx9d6CistjqObl6hj2aUoOzzJ0hK/sPHj1WgNWOue5fd9oUeqfkUrYsDIy2kOl2qKYnOmOM4tCyY3ePEhSu0907zlgFWFVYFUWYFWoCFZniJJPqFeqSXPTmghtlpuMioVRwXZD22Ifejqjg9TVidC9zEI1qU6TUxE290v42X4jbzhc10DUA4tdwTbANizDNkhbtI5sA9otR+C9hhXdm9o2KNgG2Abti23o6ZAO3FtBpiExZMk2ON80TXjpmmh7pLn2urNpItnDGg0IywDLsATLkHOQYhlY12aI9aLlwfeKxexb0+A1TMPRm4ZYTENPgzVdkmSybZBabCqyrfsnKDtlVl43Qt069Ql1J3NYMwxhF2AXlmAXLOtL52hSYrsQ6sJFapog66DSzC44v2+7AM7vmvOmZKO7+qaDFZEkGlWbswehwTw7GqnNbA3SgN6rowrWg/Vg/S5YL54056M5czC4mvVWVm0Ic9ZbsP7gWD+mirtqj2jfJbBX+eLmurKpitVIFetMJSPpHPBJy4D9vjPFAbwH7xfAe0NjsHIpq+XIyWDB++Pk/Zj67WqR1lz/zLiPgvvUNC1Q/TPjPs1wL4VBaiG0H0B70P74aK9z3wKNwZEAf6NtGUTLLMyKTXVygP3BwX7M5XY1LovwHdFeBFLO2rxQJIFUfmz0rHGZZhEx7dURRnLAerB+Cawn56zoYeiZY/+KWA9or6E9ZllTH7R5FrIzoorLefo6+q5zN5i1M2jHJUF73xEZD26D24vg9iCDzCwrA7w6cB8uf23OfnbFR4aMXWq3Djw8jJSpmuSny/id+cyS/FT6OCMkoC/ouwT6ypQAoa+zs/xnkkmA5E7Pal30kOd/WA0E7xjBOSkZuvpXvYh8E4RzLTqxqr6VWtqTZiXozvYj+KDUEEBf0HcB9HWJ638ZvlQZ1hYaJlZI1O14LmGvzuw1E3vtT2vrjJqUP4feJybt8tP5Xbr6xyRSYG2BfE8Tqo8lOO3ymF7qOG3E+XI5SmjLyUNnObk+rFFdgDwgvwTIU85IFaHmzTYjiud6Dny0lH8RyENX/1lU+4Jq04fqQVBN8jN2jmonLQamrTViVKs+VA87l7oEqoHqo0N1YMwJqgnZOhNmjWoi9YY/bkosxALVy0J1LKju6dEkvf6USZ2zh7raiMnQc+J1MwSXlquPfaLEkfOXIDVIDVJvk9S+DDvUKxH8ss+CeogA9RJB7UqasavJknxqLaQOnE3k27reTDn5VeBxtC2ou9XjNUANUAPU2wW1DCMXUEszvWpi3IGEL1Zz9a1oM6ndqwlxK+nuO4rRsW5MSfq+lKSWPslcNk3x5enmqzw3nArXzSwCovtw7cZHArgGroHr7eFal5YZL451o4GdpLDAzbVPvHsJYMO1fpbVY2Yx9LFa5vVRTnrIrF4Hv7xkJDzXyLWs7oyBmMPSLwSrweplsFqVjhfFldMq1lFLzjm5Ddlz9t+E1f5VshptMpuQH3OSsa9QWzTMXe5a577YtUcuM1ln5p1WejR9kNeH1dYIyAPyy4A8q5KwXkXT1SbDkqg1Jtq5M370fH+8EJEa5Y8kSjNmP1OfURhGoxBmRoFKVBT36SQ7MwqVJM4Q3aNGYVihbhxGAUZh60YhSUmho9rqNv3pWOqEK4E3hMvj9g3DC6iXb8cyjDoqVQRfDesI/mf6rodtw99vfvuruTGTIsv5PT11v9K9MTzage6NzKSiAn+Kikl/ugTPnFR8ElLM27ftN2zWvucHUI6k1LwbVRe9b5wEDxyi9ZyP8LWWw/ucD46dISuT0wsxzkJWZzL81bdCzbPdzBOGi+aUBxguGC4Yrm2X7Xid4egkvbBOCAapvVOk0eTn+eCwN8s1WpnTdtWWo7e0Iokz5F0zdyjiUvfe2KwROASJrChG7LdXt0XipGyPGTyALZLPiezY21trfbY0pZY/1bqhRIrQ7sTpQnLBKLlnpsfawNbA1sDWbL2YXwJnkfVHmtiZrFXCLsl2z4tETTY14aVNzWQaRNmRrGV8AVPTWfpEf/AogmreFovR2aib1Rg4MbNhMEiQTM0Vg6PMilV2CfZi31pkDiYDJmMRrbqcP6FnhMI2bUY9yMQHshlp3qtr9UJshirCtYNIbbmq2PJ5k3F8xVHeF5p39vKqkP3/XBzV4pxjq2ZjA1DUdZYB9AFAB9CPEeiesU088u0ewEjoWBnm4Yznbhk81ymIkJdWHHPgOVXP8HxUfg+PRq9krCGJ4lPrXGwGoUtIizNKyeUQFz0l4fstxONhpUDO8HGElWIxK519x3o0K25uVhLvCBRrSDRWhYqtu62KOyxBHxgVGJVlGJXAqQortZJaMrxl0Q6CY/q9mRsVs4wcBuU/c0sWoTRy0XA9pvRHrAolGuRiRJmxElor9bxV2WeoSq+GI2nSCyWH3tdT7WXWPUeqnJ/1VPMzwN30era1CbHfCJmdSxXtO1plYYdghxahHirK+dZwqLlJphsJSdDuxs2V84NdiCGikIr0m/GMLk1+rvU/Z4iGUgQ0KA7EUIGc3fr25sCMxJgA7+rktuzriERSMRL17XK8yyYyzfSlo+3PgKudyyTtOwQGKwErsRCNaclp2A0rMUhQO7aKOVJGqRZiJHigCM91ol2L4fHZKiKn8RTSxwx1V8O3tI1mKelc01TNfmDXQZMVDXFGdLckpIPn4PkRRp8Sh0esYyS20nc5tmMZPy3Q957SeNhJ14FHmVDwiToVqCo17C8DoWRE63EEf8bEdlcLhZKkEBvamP160/j11E/Cfr2aZbZ9vxUYdi6rt+/wj4EhgCFYxlwBlw2BVW0agkpSHDtqYWYG9h77ecQM+DytlYaPWd6SBLXHTLQn6/lIJvp0+tTFP2+vbvgm1Z8lf1npI7EhYxa7p3+cbqMuNqQ0R6h2I8H7iFmtq0+LsiADLAgsyDF2SHAIni2Ij215FK3ikAeUzBIIJqiF7CV4A8SbCWqRoIZr8mMNAv5PQj3mrHAP0jm1ZPM89RQ3kK5YsrftrCakm0VtCsBz8PwYO97KjiDMcO5ZxkdxYc0sMJReRBXkCOGbs62pq92Y60FT9qiNnc9Tp+i+4yBffLDb4EhjMhoEBoEXQWDOnTKBk51NO9DSQcbVcLOgzA7GHTzpUFO15SO1oYHzfdJxQBFf34zBonKRrDYbZYwlzVkhafAuh3rM8PITPhdNKqU7Ls+t1dLsbDgROVX77Ernoh7YcNANCdEWw9PTtZzlqcTwpDBPBxjRjvUbOWEduy2Pjzuf2rDvWA4sDyzPMpSV2JdfW55YD5tN3EmkZlKxRi/G8gRRazvThiwARYude+2G58BsiC82xPTZEI4RSl3RrKxIyyzNWcHZQ3sX+6jMOHUrHNQsCZgPmI9lKMqGMZnMsSNd96FSj6qYkLaTIC0rdLRA2j+h5GprIdeNWqWBHO1XLuMaYzEZts9k2NJdIOW+TXeBkUufOMfcGI0YYTRgNGA0XnYAkc9GQ+SS6iQhkZK3IXref+YDrMZB7hFSyS539Rwz6G3pObZz4EeeCXrGsyvanmO9JN7vO8GhgHwgfxHIZwE0QX6aIV9E886UdGq1Pcd+73GmxwpPS3ybRGHp4aCQWB1ncqwPQXGmgYtnWYmcWPOKMxzBHonkUhpT677P8qii5O02ut6cpNuV6Ce2bW9pUbZngO2B7TlG22NCtj2iu6SrYXg81tRuNDLrVCyPfXHL4wapDGD+5LSLe/2258DMyJgo72medtLSIDPzVM5yNG2YfDNdW23HNRX10LwnLIg7rEmqMB8wHwuZpFoap5NqUxxDUUBwdr5ziUuxH4bELqTbwZJV42NVBvZjWfZjTJLHPvuR+66T9Ke09mOQEqt2H/0d5sMc1sxVmA+YjyWYj1wSORVY1ZEvt5Ju6/nuYxxc5/Y6ixuk3znpx9x26iO9djnglNy8l8NlaXc9J73pI706rCGlID1IvwzSS1e06CLPUxyyTxg2aqF2oKzxMOnLsavHC2mTKCxpHm5HFZh1JS2JeIpiSMpv4mIbbBL2ajr0kLPk/Cd6LMdQpkNENW/CHlaSD7fzEJOaLEdKj7dhDDAbMBswG1uvhnLZbthZalzQNmvZlQaMfVmN4yqglcfuVZfP6kEXO9HXL+7kWRLZjjDbY3DD6ZmouTaGYkg9hsLFw5ogBFMBU7EMU6FtNhXBbWwxDDOWgwWtsRgUrMVBbgnsiHrdV780qIz6oGb1S1F+FTYTB12bAvrLHqwH68H6rUeTTGG92cgbUI2mBGNmiQML1B8k6v2IetOHeumK87mwummSMNIjQZneOEO970K9PazRDEA9UL8M1OsSAfKC+ibTF1ikdJhXGPkI1B8k6uOIetuHelcU0bWa98MNIrdqZiM42+7np2BvDktsFbAH7JcAe8MAFNg7gb1pYB/Yr0/zctIdzOEB7F8e9mrM6vY2P6sSwolpswWNDIDdENeejdJ8Cvdq9xJ7e+59HuqXjQP0Af2Xg74qKV5hvt1k/rw0KCQw/yCZP2VofV+GNpUMbXBz5g8cGZzV8jDzjTB/7D3x8dFCUJsOrue4Yb4G88H8F2O+zvOFCfpG+sZaqRons+sf6RsLUDn6e/6NVZlOpPD18xIVf5dans1jP7+nh+9XukWDTK9UNnJXVRK4/jqJC9F/I3dsOP32bfsNPYVGRtWVRg+dhLevvdpITSnozt5nl01ZmQ3U7HxN4ryEmtmy5Bdky17OkCkYMhiyFzNkSgamyXggHvemUzPTy9LEB6/3sHt57YZsQ65VUVfFMSgtcXa52ImuHme6kDmn4aVrRqVmiFHgUqXgGjuRtIWdoJcH2AnYiRezE8M0Rs5ydaqpKpbIpZZJoRuZDci6btiJB4dIaxpWqh4eIk2L/sDMxZQD72qUNqso9kL202ft/MIoVdGRkyONvRiwr2BIJNgL2IuXshe0srK9sByF4Yl21b5CpJUCsW1uMNTeNGGRF9kn9HXJhas+5Iv6ESFfutYpPjLTxqBQklGPdq4dK+4jcA/cvxjuo+znGfeyO3D17kDlQPu8yFXPZPRUCq8O9n2q21HF74wFTRj9dHnPGOWHYpSIeKzZ+bUmGnRJmqtVp3mQXjcyD1EyDar2LNhk0PPf9rqpUn9xzNYhwDrAOrygddCqWAdWwTDNJC8WYN0wDrONwO5sw6idlB4ZDhG5R4O0k+yKZnJTFKIef+35VFg7SXMlzJliDfJdiicd8AbBjjagq99Zc49bjgrZ+RbB86AGSjnPTIBbmwDzaJ0sPajqYE2AhwmACXhBE6BsmRGk2QSsOcqNr7RqnXpkg+CXsUHYqTQRx4ped7mQ9iPBTR/Btcl54KxYUcf1uWWZzqHplGGEq6NHuAPCgfAXRLgtncwZ4bXyQGJfVbXTTUQEVc9qhRYP8dfK3zjyt6u3mCIlPvOXc6itB839LJrvdVOtaXSbVT1SBFsgGAh+QQRn3aBAOhJzBLMeMCN43nfAaGYEx70FU6qoRhtMEctBwRRJ4Bly/epgSs73cTCFC4c4FBD6gil9BZmDVcdRkGnGZGtf43EuAJbG47kjHliyRGZjNpZAtz1oLj0eUveHNXamsQRoOoYleMn6Gp2bm4yZG4JMz3k4JbnX5on/eDglvXqtZzMlRbs6ienhDBniPrvzsaY4ywSxGHRDcQWIM8sAcUD8BSHupEU1laL6muKuYHwmDmcMAir7IfCUkuzpf7VFt4cCKoOZz2Xx3BHOwq6tgE9ICQzmVjkwGAx+QQZL6cbAKG4qF40UFzCCN0a07M+VHiMqj0wADlIdckb1Exx6J/W5OqASWJCI5v8GGUuuqIJlm/EUqn45knjKlNmMfYZAOlu9DOOaqXYqiX+FuapPSP3OuD2s8Y6NIUCHKwzBS3a4ckmCooCo53ZWYypLICMSVdtpyJZA+b3VqDxjCagWkQP9MuTxdFZPsRVLcGBQn9KlqQ/qyeaCQ69n8jZ5fibt4ELL9Oi7mW4OlOgDelBB9BcluoRXqNgsqlazgOqpUya6mYfJ01J8e66zSRk6joXdgwbSn0K6LXlP3Ql0qT/UWQ6u0StTMmIlzfOegYYng+hoMwXRX5ToHBZ3Jg9TqVVoZMqd9s9plb0YzqmRR5pV4iBNQ7vg+RMdqFyefQzBGlvyprqrmZTMgBETa7j9QKasNY1Ehs1AiG3idIgwA+gnhRl4UTMgU9VJTHCQoH0zU0tm4Om5GFnae6SGMrUPR2qMbEs0S24mln6pXU+fRa3YDvA8EOKY90fv2NuR6Z2uvZLmUJsv82xsFmdilXQdtdXts5pG+3h1u1odLtbRIwqsv2hNYypYT20EntwwzzkyH+YD0MPelAJetqqRsmPDq28StX4keU+TKIsKiXfuxiBNqL1zHsCQ+DcNyL0DyHldA+QA+Us2+7scpiH1Vh6V0orKi9B8fGQOokdh444hHEcI2z4IDwJhP0K4cqe9+NKDe3BGlTtyBKNTFAh+OQSPYXKuK7em4S+/NK9p1EntW3LLPC65NcgsIZGUp9qbtkmUoyPJ8KLl6Migjj064sa0Z1e7J3UOZ586cHpzNnOQrjU9NqTYrFvlleAn5ZVjhTmaPQHzl4O5o7R75rllLd1GhFBx6opAOAd6XArPWWuEi+aCYhFg4iR4/iTPpwym7+O5c5nn2m1Gu/MM2RnN3dHTHF2foPnL0dzy+AuhuebspdsYHeseRvk2a1genhb+DMmNZCzPdJIBHlTdC5I/SfIpbxn6SB5VJjmXHzYdpKTpkMdehNkEVdsbaTEpE/IgcY4GUuD8JXGufca54mC3U3UxCklZESfDHOhq+5JcDxP9yAk85RtjX6jb8UaFAlAqi9KuQ09ZwT5wXqMlcDeAA3caHSiA0bgJAL8cgA03bAqABwGw3gTwvMvHAcD7AfCUa+xrs8z0lYhGPtrJ/1Xs/9rZpM9u+PpxpR4GfOvXB6AX6H059KrcYJm4YM+ZhrzcJxHnYelROwXk3S15fUkLmr6SaRGtIvR6NUMv3azIJrRplOUhy6Ebvna8vzuDLyeK98pfBf6Cvwvgr5RI5A53rupwrqmY5liymTfCWLi++wFwyeOZvk5EQm8msJmHHriliUdEp7YdPWnfTWC988mWXCQIAoPAR0dgNWmMBAk++Hrdigc8Dz0Av3vBrx3xq/vwa1UJ/aY5f1mg71QG5TT8Vd1lzkYd1kAcwBfwXQR8aRXGDF8v8YfwLHzDUun7mHaH5tT/KN3x8fyulu44nT508c/bqxu+pPVHKWA60Ak/8uEDw70fcd/bWRgy7m2el6DrWHOUWgs9w73rxT0rvRxawGMA8UH8PRAfXmyLtThizXbGcQvWjJ5hjXrqrYTo22LgaHuKgfdBtAFEA9FAtCc8Q/nUTBOCS3Uf1nVbO4fZZ2314PyR6MGFMQ3W1x2Xcu2tD+McrVrnmeqwY1uCywANCwEo6Al6gp7frcLz6fKeacFnf59v8aNqPK9VdSdMmSj/PdLIo+BDNRrcciZKsQgwIAgIAoLYFL8Iz6bUTuibjWpCVhGzfjbhGjwDz8Az8OyFeTblLmIfz3KfqM1co64z8Aw8A88OIcS3KfpKddfPBvg2U8bcd3MMad8w5Ud6+otIiUbbPO5BJ6AT6AQ64QouimexpCtsH81szDPMLKuD1cNrOGpHyQo6iygqLd+Ls+ea1UUJDDwDz8Az8OwpnpXUg+1qguHRy2XMbpAuJbNWmJJOpsB1bz9GNP+MgwaigWgg2j43tzxKTx9HFUq0IwZ1HwaDzhgcuMdvnX8duCzFs97UHIJdCs3awq0DBAFBuHU/yzM/8sx8D88GlqpWtVdHjwm10TnurZsTrUulWBu4dSAaiAai/SzR4ki0ztCbd5lo0lVRj40WUUj+MzOgpb59qoKLBqABaADaTwItjZmErsYHJ1NEaOZS4sZYUydGz4R15GeFDaL1bToHuGggGogGov0s0aZcgu+s9UiZaJbcsaHS5eHBl5qbG+Y86+qFVREeGngGnoFnP8uzKSnQ2caQCs9oEgEF8pu5jfQ5xdqtc6KZLqIFeGggGoi2J6LllR0Hyu1NHfr8TF3z35+0rULKtRBUWWpocdMSpXlap9Nnw1OfpWFP0rppIo+k4ekneRbXoYJ0ykZ09k94nUFKx0syYbYGKTmZA4+TqEHK+n99IHVwDQFSgBQgfaUgnZIgqQ+kKkwg9TRrdg1SKyN5eNDqjKSmk6QWLilICpLum6TqdC4aVUgYOYx2polNVMu2AVEAeCsANkNJ2nRqVcll5YAAH61vxp5ZHsJLVTQz/Oo++mr4saAv6Av6Hhd9S4LJ9U1sSVz7UxJMsRn7y9MGZYrWj9FXwfcFfUHfV0Jf88jHrA08OY8+Z2UuLSmQAto7gLYdod0558WUmAUFKOi+1tBOjnX/B/tD1E5wmQFtQBsu83HR14/07Rq7EvJ8WS6b9yy2o6tOoFBmfKewwV/dA+AIrxkABoAB4OMCcBwB3DUgxstwK+nE1KeKA8RrAEcu8T/j3N+cv111sR4OMPgL/oK/R8VfNWbs+ubLeBL0zPylWgta5I3/axzjlyBMlG7468Ff8Bf8BX/B3w3+Tjm7rtk2rsyC4BQbXRvbJu0M85cC+lYkl9b8TeAv+Av+gr/g7wZ/p/RbTxMbpUKjKQKfcnF8qovWlASAPTXnmpq/VoO/4C/4C/6Cvxv8nRJwsY+/NivG07RtujahUkWwp7mPmLo6Gvgi+Av4Ar6AL+C7Cd8p+Zb64DukTF8eNUTOby1JEzkvRz10UjjcABjRXwAYAAaAAeANAOuSfeuK/ZrMWMIv6T/QpdGm1jgMMhuYJcPsLPoQwV/wF/wFf8HfDf6W7Jvv65ijge3FAaYJxrTIvalls70MsaPbRam4Jv/WNQkgcAAEAAaAAWAA+HgAbEcA604XWGUAJ+m/iLoaLcXVv1wXQYXATfmZ0339bx78BX/BX/D3mPjrR/6aPv6mMn+ermKiXoxqvKkTwTTi8hmBuem/cJCNAIFBYBAYBH6AwHEksO3LwamYCax45KBbRyAo+cYA5jE4yrQpONcVgaBPaQAYAAaAAeAjArAZc3B9HXDUW2EKgB0d77AeY5GDEyINccaCEg2BfZ/+OvgL/oK/UF9/lSCdkml9rWyFojzDwqxLyWweYUE9a2d0tds8WtcEWvp+ZNKAUWAUGH2dGJ1SYqGvI9iFEpKVKbdrRUjPrcCDFCTQkm1TYrFzUiRyYiApSIpJkT+JtCnLFPtEZrQvWX5DYyHNWuSADp4iIXkwrpolmRKGeQNpQBqQth+kTWmb1CccOxSkBalSqsKGkWlHC4n3w3aWt+ljmkbeBkwD08C0n2SaLZmQ0Ee0FDLRnHQeuTXRZI+vecz3UNOsKwWin3bP8toHyUAykAwke5xkJRUReidhlapy2XeuzDqGpnj7SWG14YdY5p7JRIBmoBloBpo9RzM70kz3jbXWRaMu5Z5wvSWchWfSAcAZcAac7QBn04K5+Oft1Q1/5xsBXP4uWs48+P7D5Rc6gTcfz7mCUJYOlaK5bweGQj+isKdfxSneiQoKvaBQhS2hMK2wTwUKgUJ4dj+HszjirKf5w9GSTRlnPGqDjtptB2dGPZNBAM6AM+AMOHsGZ25MIHS1UjjDQmaCsyHjzG8JZwYwA8wAs32W//I9friLbXDcqnqmaM/kAy1pXY+RN09WDVM9BBMiWJ76yJPND7nu1005i572CWdzxQhNYgsZnmlL8LRIWgCfwCfw+crwOSVJespXnCtiulQPLPjUW8r5Go8kCfAJfAKfrwyfU2Klp0XDBaaj4FNlfMYt4TMisQJ8Ap+IRP4kzqbESk97Bq0AxR3GLq1ixtmWNtN2QGIFOAPOgLOfw5kviZXKN3OPwiytdMgwc1v1zSxQBpQBZd+Lsrw++cqX555/sd5lkosgvsdA8seKuqZilQSlH0S7w9bLlRsUeAwJVfdFVVatUk6ezHbhrtfievWVVZd3yW/LVZODli7Rb9urVfxwcX7/qa5TpOP26UjqFH1J5sS6AeVRZNNXC6+tEl6vnwAezDhw+KGmtWMxwdUgWH8O2QbJHEAb0N4BtLnFYjBciKdX1W5x5VVGtmmRbVmGiZFtFozsB8vLz9hdPJb6cm9HbusublPavbjac3QP4n3Tw5laePOD0Qlvt/NUEh/+PvmdgG/gexH4tuJzO5aSYpmpCuBcWs0Ady3AnVqsy31gCPYjgk1ftCOOoVsrCF63+NAkXE7yG9bcaRhM8RFmcOpgcNh5PoqHqoPBYPARutBc/T14XqTEYFdPs2ZtGUX595kX7RjOtGJCAoV3TOE4Utj2UXgo1ahOz2LOPI6RbGfg6QgNhUlCrZfC6bDSaEAwELwMBEsVzxBYc79FsBFZ6TTDL0t9MX498Ltb/IYx4Vd3Urkn6hd06XM3cY7fwCq6Zyzl3QaRbS99aedzWFGICPwCvy+PX55rwIn6IfK0kxa/NGWKN67azwFsMoC3GUXmB36LQWT5hnf5ntRxZJpEwDMiShj5M12aKYysDiyKHKbsn++hN8UYSh9sVPMQRpSEAskGz8LIwc/wnVZPuc/mwIIYQDgQvgSEx1UqBLdMcFu7XQR1WtHzCIZ1GwQPS+D3gRF4yuOFHgLz7McsE+VmabwzYqfZrJjzwyyN5+wTIeSD6ggDeoHeZaDXlOBFsG0O78xx+UVgJrfsDYW9bmKvV8vwng+MvlMKr6tgeezFHVX6ql5cupXKy8CM1v/1Kgl/w8RfGhr0VCVFOrAYRgCFQeEFUDjkPevAc3AIwroOYVAST0IbLYQ5tdfGkNlLWzKFJ8h9urxnyPGdus8X5fwzffY+38J8nAUO314ruqe8X+pDty9TQIYceDZ1FpdnHjnuRmnQreP3oNvuPPW379gF0A10LwPd0h9G6CZvuWW3dJ6YjSLmzfTf0tH9SikcS/qvk8ExlXGZauY+Gx7CdJY2EKz09yB4yjAcRgAD/AV/l8FfX/DrW/wqqYyjfsAwr34z4O9++FsSeKmrfY8InFKewb4hJparHGmu56yHL4XvIfCw8za+fccvPCAMCC8CwimW+EVoKWwlGeS5Q2TWCBIzhQMovGMK25HCutMPLhBO81CEXnkud4uzPpDwPW6wEWNwUJEIQBgQXkYqT2YIcyrPtak8J+rWgRNEDzeCAMK7hrAfIWz6ICxdPUThITeCqCYtm04dG9qHKpHHO6npojxB4XBYApFAMBC8jFpkrXMlm3dtJVsOE6uh3cJKKVvaAYO3rWkx6gFXdciGirkeqUM+nWGhEi9y/Ng/JILRVC///ea3v5rrPOkRsxrSL7/Spfak38SXmjqW9WmSSy1FwKlEcTka5OPbt+0XbGYj8+Mkh1+ykEbVacgHztyRvGU5wNeaoIxxtEddjYk210/TZY1GxmQ0nTFSRe1moRkyPmyP/FLs0b5DMw4mCSZpEd2JmqOpihcjm6RmOhjr7lCDeJg3yKS4gxD5T9ikH1OoP9ztRBozm32NjTaLIzK+LadEKmFmCqrzVmPgFGcUCa6R4Dak7yH4c8WBcvdfV2AHCAfCl4DwMtkx85oQvna+vBQrENvDLMnph1IfaA+G4I/tKYhUvOSPoSMyTQnVro5Ik0P5WgrD6TLVugRKIn80OXkG/Shuu+oMI9ln3PYtQB/EB/GPkPgSxlCatZuI+JU06iC69MpxsL9Fvsp1LTYePPL1ynYEkQ4B+FPuNvQB35U68sQYt6kRAxMjQM/DjPhWEgdD6iO+3r2bD+KD+EdHfPLIOMJKwRhtWh+f3X7etc9xr3OMZh8Ofj54zd3ZzaIt3AmG+UjqoQPXupNcaOVpauWluUVpyoAw6wmjWih/xNngNGWDYx/WrcnZYHXK2lQ11cUZWFEJzozqWk3DaFR6siBHwYcH0UH0HRA9MRTZU1etD09jP3nVUnvQDOk2TzcwaoGp4Oe6OjfzqBvdnE3QxvOT9LqTqGlKoqY+jJtS3y5y6bU+lYS22Ue3c47nPd3knT/Ncp3gnYPlYPnWWZ6TZOzLmtiynCr0GFO88W5Z7jLLtV5yWc9GXCUO6SgiK3Lt7/mTnQ54yOR2FKVS9Wy5QarkVXggqnJWB9KfAXeEEw5wA9w7BDcJrJja4eIAu+HfzrCdqzGVfT0u+GslsC4E7usONUUjhebQcIxpWMv86jypl73rGYR9bm+YSliegbCH9wwIA8I7gLDm8jMK/VKRMIuA1hzmguLEDtSMw7l+ZXCoQFwmve1Ib91H71TaSsnu2roxYuz29xsh7BIMc33wdvCgAW/AewfwZulQnenL/YgNvJXEsf0GvUWcbjBHUIniqnEMhx0x8SPxTV/Nucxh95a9cxIVMLUkhDQRxY1gt87+uu1EvoG/DuQD+TtAPucnNee1NCO/iZtwLfFDyKcGQY6baPjry6R3HOnd2fCZQqY3bcQ81ZdUWhIyDHjYiHirHDlztg/eGv464A1476LshFeuVqwlPYd3chne81pCn8VDFILeO8awGtOOfY2bLrvKhGESpyWlS1V3fgmH9UbQO3f2DL6TwwOcaHAYHN4Bh6NwWPPiazmsHoGwDCNcTPHf6EHzvn/0oPn5v+Y/PJ1nSCwKSOdJylb+lEL8Vr1l/ZfdBVwMFdw8EnB5Qncm8EiGYwjTqCmt6vtmtuWpmY4RTFyantIocT/Dk+jnBmbWWfykfckKM7AvsC+wL9uOy3PejIKghvk51Bk1l8vLlZ1bGAnLWxiYw9tXTOnY0Dcr2ZhMfQrb0YVd17MmnvdH2A/z4LxJOb4TdR/3A/YV4D64vwPuC/Ytq8CaugzOcJ+RYH++sZAhCUsrpGH1yIfJHdllPNNWMoRz4LPz/+DHLE0Ilh1XTl+QXXT1x37CxtBfe+KzpPnJpf6a5JfpISbFhqi6RQzsI3uSwR3apmTKHXc1vNK8Q5kkTfeCEB5r8QuC+JnJMxFb65SjXqnTOnnsSmCdYJ12YJ2igFQcSzJPvq7z89k8zbte8/wID/u0NPvk9ZGEzKbceFcfb8qjUbznUBg/0KHW6ggypypt2CeJmqmh0z5Z7J5gn2Cftm6fnEgea2r1oS4irmKp7ZPO9inN7ZNh+xRgn17GPh2WrdGlAKCn580PRc/Nc5cM64U0OoBOLI3j8qza0kTpnFEKlgaWBpbmBS0Nhyo0yZ5FN7c0JtfQznuPjVRheQtLs7SdkKaA01FshXSpHlBdTdleiaaf9oEtDF1RW+eR2DxpT91+rjFP0tan1rWGME8wTzBP+zdPkdv6SHgmSflArWjEGWA2T2ouTyeBuqBhnxYXqQvmSOyTHe1TT9s5CWHLkDiyT1T6omQgXFXfJgaKtRlNY6CyfYqwT7BPsE8vZZ982T4lnnDT2KcgFaiJNkpz8yTzqgICdYszT4YHZh5FoYP2o33qaZLn+c6SSor8X7qkwdUNPpoN1MCTHFRtoEIO8OkECwULBQv1UhYqcHCDcDjwAOKZhWKvM/Ga3hAX5ApaGChkkrZgauJoamyfqfHF1FCZqOIZr1VLP1V7814oipZtY2tkNqgyMDUwNTA1L2dquHxI0/AtKqRtquq8dOnRwovqoaLvqGBrlrYZCscxu86asdKhS+qAJA5UzPaJpiPRBdW6EgxzUlXnxEo1wbo8HwP2CfYJ9unl7FPMCtzGcN9GoxGZAxycTJrvhWJOJiUYKGyGtmBsproF32dsnDQYJR6wxFoc9RPLU5rsKpBf5dvSBWe/KzXESmmwNrA2sDbbtjZSFcvD52M7KpW15cXamPluKIk6ZUATLKzNNqzNVIUQ+qxNzMaGRNwUi2bXo0tkY0O2JrZV3LaUIXSrLXjYGtga2Jqt2xrBqXHcDEm2pp46lHKZHCmpNLZGAm8eSZ7vtDR9wbPkjqQn1UyFBLHPxCQuxA4DP45pFUI9olBsDO9qyPg0TalZyk0pSLnByMDIvJiRSVnKzXg2FMQ4XxmZmEUTKK7WGhklTakO4bOfMDMHZjGmeoDUaTFsthj02BBlmrk+nFS0rB94pkxbEGBywmXoy7joiTAwGTAZMBlbNBmc+dQmcEyBTEaoTEbI6p9mNqElaNGXtgEi/zsmsS2Zb90ZHBIOs44MHW2l43omZp/rsljH1LWJ7zIqK6bOUVmgMCgMCm+dwpJGpKh3jg6tMxGDDO5wXMPfQlha/I1ZIIOf6C6MRxJ0sSWLrPu63y2L3Am66b/E53VwkO50KVZipYfQppHLYNvQ6UJbpJEBb8B7Fy50gbdkkVPtd4lzZeOc3RLaV3Cgd85hO3K404WW8jM6pYF7RW01asdw4/eZTB0/o5XepFj99w0s9EixgsPg8A44bFTmsFUbIKaslduMZFjpgKVgM0i8axL7kcSd/cxRZxITwtWqArGV39gs7K5m2rhS6zKYvloXkqxBGhIgBoh3kIa0OaZMseUmmkEgpnLoByShRhJrDRLvmsRxJHFnuy9HiJnE7PnWLYMclYqMYs/t67ZJ79mc3huGvrAy9b4jvQcUA8XbLzv0OleEZJ84NKtXcRXxnMQmJ4SsAYl3TGI3pvf6Glt1jjOFrKuo63lGpBFipbO1zhIM/P4mzvQ0g58mcGYWAAwAA8DfBeBB5brvjaCEZ+U5xQt0Xl+RfSfvQeBdE3jK0/lOlWopsbB855jAviYwv0ZbnpbAXsor+zJ01PYcwWAwGAzetuoN9yxIn6dIgJqawTSlJ3HPwwzBJbWOFN3OETyl6KoWSPvEJJvsBNtV9oHrKjclg2t1K5dHHwjpOxjsnsnOgcFgMBj8AzLMwWdlF2takUtiMN3ExJOpZsIuOZuzmF77B2vcPlyc33+qq9x4lLY+EpFiNyX1Yge7XZrYnUQgUqvafXaikxJcy+74PewOzyT0wG6wG+z+AXarohppWZVLqZrd9FJits/85+Wi+8AQPGXzUg+CI3cwEoJd3hKRVGLlPw+smMjteg2C3SACa50q8STggjgyGAwGb33MlhX/WfHM8DmDScYqcX3qTLi3QNgCwjuGsC+JPNOD4CCRi+BLDFnp2gnmbK3ngoqGwLlHv5PAFOMCf8Ff8Her/LV5QCkVKoU0i1+IHJusyFn8Yt6eBf7uir8ljWfqdrvHCexXJhOYayZ0rTL8qA+sJAzRKdhqNfJ4YDAYvG0Gmzxq1gx5ekVdV+y5t8PzpjZWLQEyKql4wSgs3jmF7Uhh3UNhV0IRIU8eoen2tUnlEUL0G9NiWIv6bmejHdlspPKAYWB46xg2ZaIqpdupHaupKVaMYerZmmOYewSWNKbhgDHsRwx3hSNKJx1hmO4GYdjbxhtWoj4SZwEJLe6w78OwR1YOGAaGt41hzWEHwrAoS9PkRV+LFSTB8KY3bLI3HJGY2zmG44hh24NhI6NedYhZX7nRnkhlhoxtayOckfYO34nhiMQcMAwMbx/DLmYM0+aUUjeNdldgDLtNb9hkbxjO8K4pHMbMXN1i9ziFdR7FTRQOPP+n1p2gNW+lutjPQsMixBf6JCd4fQLBQDAQvF0ESzGTDqyiSf/TKN86QfCmJ1w6PBI84Z0zeMrO+R4GKz5OYXBi/Wlq0HkAwi7NIJyHgPbl55xCfg4cBod3wGFOrJPAYWTe1lvYIefn/KYrXObTQYJt9xye8nM9nXZuKBzOnRlq1TRr+CBDbecUljq12JeecwbpOVAYFN4BhWOmMN1Q0sTUlZY89dgRhDedYesyhKE4sXMIT9m5npY5m1UldOSqB5Ffa2vVeDaAZWvbYljms3RO9KA6DKTngGFgePtxYc6ra8f/paWq62HN1FLleYTHnMNK5zmaKFbbOYen9FxP3xzLOJnMYS+jTqvRisxhrlZznAhoOSwy/+sI09McDsjPgcPg8A7KJGR2JxeqsfLwGsOGHWTP/RwbseEyzhjqP7vGcCz5uZ4aCctD7RjCapWD96kJSUQJSei5L0xMXqk+AifwF/wFf7ddLSwpddYHT8zfSgGTNLwYwBSU2PCD83BgqMHvHsAlOWe7WueolnfQGcFRbGRd/C2bHPaDw6xCgsvU1NDnBpPAG3JzwDAwvHUMB6mRMNy0oYhI6+Y5x6oDhOG4geHBZgzDD945hu2I4Z7eOeps49oIHfUqF3THVsbHSdPGTAYzY7jPFfYauTlQGBTevoqElQoJCUooYvLaffIcWfSs8rNBYSkWVmarzjA/81uUwZRveJdvS62GSbc3mEkN8zNdnYOd+Rz9iHDTh3AJKJtVNrJtFyXnYwPPGn0glqG6HeldxzN4R7dPiltQHBRfhBabcpniFNpQPP9sWrss7iUZvw2I5zI3E5YH8QPDcBwxbPswrITDeaQHPcexKVqku0b+9IMFFqqz5WP3gpjs6YPD4PDxcThJaFlxKYVi7E5rN/LSdSu9EVrWQ07SL1ZQPn9F40J71+NC//3mt7+aqzX+pVtWqP/l16zcoXIsnmZOkfliOv+qaOQFj/i0SqZk55fftt/x2o1CGtOMXW2AHCxT2SgkSUQE1zjn/iHnXKIr2i7FJsAgwCAc45ARnQ0CXTPFOkSVY25YJYOKBBqDQPlIa5ZtEPIXTeZAi/v54HyRQ4uopCk32dM4yJU+kpvMhCavXTVB8UEGpNoZtZNgOy3Gld9zSMWA3CD3Mkb0SdOK6Cko+slUgXHSuaFesw1wh0Vy+8AQPOUle3oG6YSCyQhmbSqKQLftKvyi5WLphsGeFTRoF3Ks4RQwGAxeBoMTl9fS/efkJOkZ6apEhG5i4LD3HMIlNCpPF0ndL5zCE+Q+Xd4z5PhG3edrcv6ZPnuf72A+0MKGb68V3VM+sqvTMHe26Chto9xp6BrZDa64plLOMEO3uM/HGfQAtoHtJWA75poSxcuLqJ1cVV9NcXEZ3keBkToIbl4XtV8rgKdMZNViaB4DsOH1K/zNahuxwS8HL7hlvKVvOG1SyscWvNAgMAi8CAJHIXCU4AWp9dY9hiT4QLXVBKAmDTkMyyTw43OtuXNHHUXc2Q0lW+h6sB25iYm4HYpCh2n184OEPNxsjknQ4jf7Yw15gNwg9xLInbLGGQWcieAUfK7CztwGzvThMpLGeR5UlTCkkXDLTxh6iq1/H7iPKE7C460z7esOyMd5H3INDfHeikS0042jztWEhh+dlvdSuW11b+X2QY1wBewB+2XAXiYdKRbaIdYHW7FecYqRSgOpPbJmvV0o6w/M37YjgXUPgb20mTOBo0SqfduDnqTOY5jFSoKUbJs+j9urVQKBQWAQeNsEliHaVJlHoUvdlAfQMo6n0tacp24s3t0+MAT7EcGmB8HSXE4IjmV2a2idYM0+sJkTWMo8OkdoezMuDBAYBAaBt0dgHsTKBKbWRc0VWRWBya0yIqM2zIPV/pVFPCwlOI8jVB1HbtsebpuiG0JB6yjcVg8VecyGvbKcE51aX420dysHcAPcAPe2wR0keEE9j47B7U0l60+ulZYZoUakLitwLzxULZ9qs4zBHEd3i1NjlnHVlWekU3EZ3SXq0RaIcEiEfG7/UIXI0Fch4gOvIKAb6Aa6t4zulNEdxOdWvkI3NUMo8cndLOwx6Ffmc2tu1zsKcE8JQ98DbpWbUmOS3KBqJgQzuBODe67V52WSVuqrrPYJCUOAG+DeAbhjBjfFpukpsL7WBlKc03ci1FbnDF8ZtUOlLXLY1J6SjKGH2rxuBNrWPQRtJ4ES80Az+RD6AiVhQI4R0Aa0dwBtU7xtxf0wlSjUGUspcXSbB5qmuqqPi5vjKyN3dI+WY58+/in1WHhlcIcG/CmlGTuAr5OohjDxQ3bTfUN8KR3iKtGW+JzTHHyfm05XCzlNEB/E335OsxA/inaIrZNa3P0oNWKnvIrb3vVaQQSVJbvC8JSh7OmCpLsgpE1cA72ZoHy4ulp0sQfbF+UOFglKUBgU3j6FbcyVJRTL5P+t/SfxuLWEU0gvW7UUdqDwzimsS7KxJ2KtQy6wTkX/mrze1hWWezmfdcsdjUNndV/wyDSCwWDw9hmsU2YwnQWB1lY1AjJ0nDUk6B30BtMy2L6q4AfrTh1JlYguyUbf1Z2ofS7MJnQH8Z+raZsSt86V2bP5jIa1qwfV1xsTIpKNYDfY/b3shkPacs2OXOvp+eO+lJi5Fvm/1RR3njebRDHJNVSzprJpz3mjFkQD0UC0PRPtCffusdzWwWWptB85aPo4OG7NRXJqpZrsJjlyike7tBw0vRy0yE+Bg+DgYjhIyj3+SPrYdBwxaPsw6Io76IJgsJaqph2w4b7kloK6l4KITIKBYCB2tz+DMzOmW7p6u+RtQjMJ3pEHt27K5vAcKdCZuVOnenGmkGoB0AC0BTl1IR1Jyb2Zchedaec01tzPss7c9cwSytb9IAWpQ8qDgqAgKAi37meANiUtQl9JeZ6GFmW32qhkUZkqdYVSKtXOiNYLtIDuIQANQFuQWxftkfS/myllEfv6311Waw1BILg9BvrDGigGBoKBrz1foY9lazvlK1Kf7p4OebhX8tv2BNHPAgqCgtja/hzQbMlYhE755zKrUEmoLrjt4Yw7S4Az4Aw4W06+Ih6HU2dLviL0TYLyosSpI2Vns2KE3R4FFZosQEFQcEkUJKm346CgHSmo++afOhkFQttQ0SW226OgS2jMAAVBQWxtfw5ofgRa12yjVMpQSqs0Re7WQKPVzONggTPgDDg7hJytOpJ8hY0jA3v6K+iEBpMZKPG9SrFe8egRGtQXIyAICAKCBwDB5I9kZ+vGHEdXVwYdZx5ySVdItFSGAAqCgqAgdraLAdqUsOhpsLCGNVIEaFZCdYMG0AA0AO0Q3To6D73WUPlMJDhct25KWPQUr1grKng6ksqMkVHHERQEBUHBg6AgHfG9bGEnENJsPXck9StuSnT0NGZYx8MnBYSU8mUQIsoHEAKE2N8uB2hT1qKny8KShp5loA2SwaX/3V7Azg+QUQHQADQA7aeA5ksGoss/IzdOZZxpKUSpZaFIEMXRGRj9g/5ZhB4KcAacAWc/h7OSf4hdDROWs6mBRFHstrOpoBloBpqBZj9JMzvSrKfxwfHg3ww0LSPilQXQADQADUBbDND8CLSexgeXx+tqGvAVRKREA2gAGoAGoC0HaHEEWk8Xg6PjTBloWqTnTALQADQADUBbCtDCmA/o6khwRraaOoQ8SX3lHIAGoAFoANpigDZlBHo6EpzlDKYATRSUggHPwDPwDDxbDM+mnEBPb4ErY6pponSUltGktllSC51fAA1AA9B+CmhTTqCnBs156Q1goImjRr0U2yupxWRCAA1AA9B+EmhTTqCnR8AFEfPQwa28k8nRfntFtRgyCKABaADazwEtlpxAF87SqtCM/7PSW91uAmaAGWAGmP0UzEo+IHV1CFCXpeI5WcGufAaaAdAANAANQFsM0OwItJ4mAYpxaZOBpiR+ph2ABqABaADaYoDmR6D1NAnQeD4tNbWG4cVAiwAagAagAWiLAVocgdbTJODNyvgMNBHHJbwBaAAagAagLQVoaUwIdDUJ0Dx4KzW1euUZbCuDpACABqABaEsBWlDZQ6Mx8h05TqOoBo1BxrK25pSGsaxzAoQud+p5yGiDs0HUHwcbR6iR5vfjTDOHVVerwDQwbQ9My8uUr/wovU2/eDOtWs8qOmd6oFlLihZtWJdZnVlux1Yiv79etuSohGDzutXjuiUNxPmyXa/D9corK+7q/AtB6G25ZHLEH8+vvlx868VvPiU3ED/G09CepqRQJT9tD2n+M0+CevutoXT+TBz4KZ1rkJe/QTVnhmJmjhcZqZFH+Qub0uX58JsRDlqvlcv5Xj0iXf73m9/+am7F+Kduz+/pOfuV7obLCdUhcUt8kttBZM1KH0xWylLQEJnw9m37DZOlmUCeHzmZJvGZToExzosg34yHz8Jw234+wm+n0x/6dHnPFoEf7vt88OMftPXf41v77ZXaOZ2T38b3JL8Nlx/afDdoWmNj53istjT8ptkkbdY14BWTyopJ6QlDN/Bh7NTQ8cC0fdq6oX5ZO5g7mLuXMneenVMCLG2f5/bOsZeqeZr0w+ZOTeZu0Adp7k6nT6VNEyUfcnTdDKvokZoeyfDxYN5HrKQ8njP7wkvoQSs5uMcmfPyQGTp9wgpuvLs5RMuzmIoJfKXGzAyjMXM9xoyiT7QczMC+Hj1HrrJlakUOwVnkQvzamDl+8uptm3ti10az7A6qeaiyZGoVYclgyV7MkjGz2ZIZ7pAhM7VO8J8lejQp3mJUa8m8K5bshQzZ94bNfhjjIaVXj3E/Yryj/9MMPHmFMC4jokyLcarRDafDiip8CeU1x/WM40/sSUx8Zk6UPAivleMOHAfHX4zjdLYhc1zJjiTVETg6MY7DmTnIoyxd4w6d5Mb6V0hy/hBdoavz94Xaf1xeXfG9+PZf/n+7r0aD6IwGAA==";

// hybrid/main.ts
var ENV = process.env;
var CHILD = ENV.HYBRID_CHILD ?? "/bot/core";
var CHILD_ARGS = ENV.HYBRID_CHILD_ARGS ? JSON.parse(ENV.HYBRID_CHILD_ARGS) : [];
var CHILD_MS = Number(ENV.HYBRID_CHILD_MS ?? 38);
var WARM_MS = Number(ENV.HYBRID_WARM_MS ?? 2000);
var WARM_PASSES = 12;
var READY_MS = Number(ENV.HYBRID_READY_MS ?? 1e4);
var STALL_MS = 3;
var MAX_MISSES = 3;
var DEBUG = ENV.HYBRID_DEBUG === "1";
var PASSIVE = ENV.HYBRID_PASSIVE !== "0";
var NL = 10;
var log = (...a) => console.error("hybrid:", ...a);
var out = (line) => process.stdout.write(line);
var bot = null;
var last = {};
var errors = 0;
var child = null;
var childAlive = false;
var own = ENV.HYBRID_FORCE === "own";
var ownWhy = own ? "HYBRID_FORCE" : "";
var misses = 0;
var readySent = false;
var ended = false;
var pending = null;
var lastChild = null;
var st = { obs: 0, relayed: 0, ownAnswers: 0, timeouts: 0, stalled: 0, repeats: 0, lost: 0, bad: 0, warmMs: 0, warmCalls: 0, stale: 0, switchT: -1, switchTick: -1, childMaxMs: 0, childSumMs: 0, ownMaxMs: 0, ownSumMs: 0, ownN: 0, fullMaxMs: 0, fullSumMs: 0, fullN: 0, cpuReady: "", answerMaxMs: 0, over25: 0, lastT: 0, readyMs: 0, childReadyMs: -1, makeMs: 0 };
var hIn = createHash("sha256");
var hChildIn = createHash("sha256");
var hChildOut = createHash("sha256");
var hOut = createHash("sha256");
var hashOn = true;
function ownAct(obs, full) {
  const t0 = performance.now();
  let action = {};
  if (bot)
    try {
      if (PASSIVE)
        bot.setPassive?.(!full);
      action = { ...bot.act(obs) };
      if (full)
        last = { move: action.move, aim: action.aim, boost: action.boost };
    } catch (e) {
      errors++;
      if (errors <= 5 || errors % 100 === 0)
        log(`act() failed at tick ${obs.tick} (${errors} so far):`, e);
      action = { ...last };
    }
  action.tick = obs.tick;
  const ms = performance.now() - t0;
  if (full) {
    st.fullN++;
    st.fullSumMs += ms;
    if (ms > st.fullMaxMs)
      st.fullMaxMs = ms;
  } else {
    st.ownN++;
    st.ownSumMs += ms;
    if (ms > st.ownMaxMs)
      st.ownMaxMs = ms;
  }
  return action;
}
function cpuStat() {
  try {
    return readFileSync("/sys/fs/cgroup/cpu.stat", "utf8").split(`
`).filter((l) => /^(usage_usec|nr_periods|nr_throttled|throttled_usec) /.test(l)).map((l) => l.split(" ")[1]).join("/");
  } catch {
    return "";
  }
}
function switchToOwn(why, obs) {
  if (own)
    return;
  own = true;
  ownWhy = why;
  hashOn = false;
  st.switchT = obs ? obs.t : st.lastT;
  st.switchTick = obs ? obs.tick : -1;
  log(`switch to own brain at t=${st.switchT.toFixed(1)} tick=${st.switchTick}: ${why}`);
  killChild();
}
function killChild() {
  const c = child;
  if (!c)
    return;
  childAlive = false;
  try {
    c.stdin?.destroy();
  } catch {}
  try {
    c.kill("SIGKILL");
  } catch {}
}
function answerOwn(p) {
  if (p.timer)
    clearTimeout(p.timer);
  pending = null;
  const a = ownAct(p.obs, true);
  out(JSON.stringify(a) + `
`);
  st.ownAnswers++;
  noteAnswer(p);
  if (!own && bot?.isFfa?.())
    switchToOwn("free-for-all detected", p.obs);
}
function noteAnswer(p) {
  const ms = performance.now() - p.t0;
  if (ms > st.answerMaxMs)
    st.answerMaxMs = ms;
  if (ms > 25) {
    st.over25++;
    if (DEBUG)
      log(`slow answer at tick ${p.obs.tick}: ${ms.toFixed(1)} ms`);
  }
}
function onObs(obs) {
  st.obs++;
  st.lastT = obs.t;
  if (pending) {
    if (pending.timer)
      clearTimeout(pending.timer);
    ownAct(pending.obs, false);
    pending = null;
  }
  const p = { obs, t0: performance.now(), timer: null };
  if (own || !childAlive) {
    if (!own)
      switchToOwn("child not running", obs);
    pending = p;
    answerOwn(p);
    return;
  }
  pending = p;
  p.timer = setTimeout(() => {
    p.timer = null;
    setImmediate(() => {
      if (pending === p)
        childMissed(p, false);
    });
  }, CHILD_MS);
}
function childMissed(p, badLine) {
  if (p.timer)
    clearTimeout(p.timer);
  pending = null;
  const elapsed = performance.now() - p.t0;
  const stalled = !badLine && elapsed > CHILD_MS + STALL_MS;
  if (badLine)
    st.bad++;
  else
    st.timeouts++;
  if (stalled)
    st.stalled++;
  else
    misses++;
  if (elapsed < 49) {
    const a = { tick: p.obs.tick };
    if (lastChild) {
      for (const k of ["move", "aim", "boost", "fire"])
        if (lastChild[k] !== undefined)
          a[k] = lastChild[k];
    }
    out(JSON.stringify(a) + `
`);
    st.repeats++;
  } else
    st.lost++;
  if (DEBUG)
    log(`child ${badLine ? "sent an unusable line" : "missed"} at tick ${p.obs.tick} (${elapsed.toFixed(1)} ms${stalled ? ", we were stalled too" : ""}), ${misses} in a row`);
  noteAnswer(p);
  ownAct(p.obs, false);
  if (bot?.isFfa?.())
    switchToOwn("free-for-all detected", p.obs);
  else if (misses >= MAX_MISSES)
    switchToOwn(`child missed ${misses} answers in a row`, p.obs);
}
function onChildLine(line) {
  if (!readySent && !childReady.done) {
    let ok = false;
    try {
      ok = JSON.parse(line.toString("utf8"))?.type === "ready";
    } catch {}
    childReady.resolve(ok);
    return;
  }
  const p = pending;
  if (own || !p) {
    st.stale++;
    return;
  }
  if (hashOn)
    hChildOut.update(line);
  let msg = null;
  try {
    msg = JSON.parse(line.toString("utf8"));
  } catch {}
  const tick = msg?.tick;
  if (typeof tick === "number" && tick < p.obs.tick) {
    st.stale++;
    return;
  }
  if (tick !== p.obs.tick) {
    childMissed(p, true);
    return;
  }
  if (p.timer)
    clearTimeout(p.timer);
  pending = null;
  out(line);
  if (hashOn)
    hOut.update(line);
  const ms = performance.now() - p.t0;
  st.relayed++;
  st.childSumMs += ms;
  if (ms > st.childMaxMs)
    st.childMaxMs = ms;
  noteAnswer(p);
  misses = 0;
  lastChild = msg;
  ownAct(p.obs, false);
  if (bot?.isFfa?.())
    switchToOwn("free-for-all detected", p.obs);
}
var childReady = (() => {
  let res;
  const s = { done: false, promise: new Promise((r) => res = r), resolve(ok) {
    if (!s.done) {
      s.done = true;
      res(ok);
    }
  } };
  return s;
})();
function startChild(helloLine) {
  try {
    const c = spawn(CHILD, CHILD_ARGS, { stdio: ["pipe", "pipe", DEBUG ? "inherit" : "ignore"] });
    child = c;
    childAlive = true;
    c.on("error", (e) => {
      childAlive = false;
      log(`child could not run: ${e.message}`);
      childReady.resolve(false);
      onChildGone();
    });
    c.on("exit", (code, sig) => {
      if (childAlive && !ended)
        log(`child exited (code ${code}, signal ${sig})`);
      childAlive = false;
      childReady.resolve(false);
      onChildGone();
    });
    c.stdin.on("error", () => {});
    let buf = Buffer.alloc(0);
    c.stdout.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let i;
      while ((i = buf.indexOf(NL)) >= 0) {
        const lineNl = buf.subarray(0, i + 1);
        buf = buf.subarray(i + 1);
        if (lineNl.length > 1)
          onChildLine(lineNl);
      }
    });
    toChild(helloLine);
  } catch (e) {
    childAlive = false;
    log(`child could not be started: ${e.message}`);
    childReady.resolve(false);
  }
}
function onChildGone() {
  if (ended || own)
    return;
  const p = pending;
  switchToOwn("child exited", p?.obs);
  if (p)
    answerOwn(p);
}
function toChild(lineNl) {
  if (!childAlive || own || !child?.stdin || child.stdin.destroyed)
    return;
  if (hashOn)
    hChildIn.update(lineNl);
  try {
    child.stdin.write(lineNl);
  } catch {}
}
function warmFull(hello, world, helloT0) {
  const t0 = performance.now();
  const until = Math.min(t0 + WARM_MS, helloT0 + 8000);
  try {
    const lines = gunzipSync(Buffer.from(WARM_B64, "base64")).toString("utf8").split(`
`).filter((l) => l.trim());
    const h0 = JSON.parse(lines[0]);
    const obs = lines.slice(1).map((l) => JSON.parse(l)).filter((m) => m.type === "obs");
    for (let pass = 0;pass < WARM_PASSES && performance.now() < until; pass++) {
      const b = makeBot({ ...h0, map: hello.map, config: hello.config }, world, params_default, { deadlineMs: 12 });
      b.setPassive?.(pass === 1);
      for (const o of obs) {
        try {
          b.act(o);
        } catch {}
        st.warmCalls++;
        if (performance.now() > until)
          break;
      }
    }
  } catch (e) {
    log("warm-up failed (harmless):", e);
  }
  st.warmMs = performance.now() - t0;
}
async function onHello(hello, lineNl) {
  const t0 = performance.now();
  if (!own)
    startChild(lineNl);
  try {
    const files = hello.map.files;
    const wj = files.find((f) => f.endsWith("world.json")) ?? "v2/world.json";
    const tf = files.find((f) => f.endsWith(".i16")) ?? "v2/terrain.i16";
    const world = new World(JSON.parse(readFileSync(join(hello.map.dir, wj), "utf8")), new Uint8Array(readFileSync(join(hello.map.dir, tf))));
    bot = makeBot(hello, world, params_default, { deadlineMs: 12, warm: true });
    warmFull(hello, world, t0);
  } catch (e) {
    log("own bot could not be made:", e);
  }
  st.makeMs = performance.now() - t0;
  if (!own) {
    const left = Math.max(0, READY_MS - (performance.now() - t0));
    const ok = await Promise.race([childReady.promise, new Promise((r) => setTimeout(() => r(false), left))]);
    st.childReadyMs = performance.now() - t0;
    if (!ok) {
      childReady.resolve(false);
      switchToOwn(childAlive ? `child not ready within ${READY_MS} ms` : "child did not start");
    }
  }
  out(JSON.stringify({ type: "ready", name: String(bot?.name ?? "hamster").slice(0, 32) }) + `
`);
  readySent = true;
  st.readyMs = performance.now() - t0;
  st.cpuReady = cpuStat();
  if (DEBUG)
    log(`ready after ${st.readyMs.toFixed(0)} ms (own bot ${st.makeMs.toFixed(0)} ms, child ready at ${st.childReadyMs.toFixed(0)} ms), brain: ${own ? "own (" + ownWhy + ")" : "child"}`);
}
function finish() {
  if (ended)
    return;
  ended = true;
  if (pending?.timer)
    clearTimeout(pending.timer);
  const hx = (h) => h.digest("hex").slice(0, 16);
  const hin = hx(hIn), hci = hx(hChildIn), hco = hx(hChildOut), ho = hx(hOut);
  const cpu = cpuStat();
  log(`summary ${JSON.stringify({
    obs: st.obs,
    relayed: st.relayed,
    ownAnswers: st.ownAnswers,
    timeouts: st.timeouts,
    stalled: st.stalled,
    repeats: st.repeats,
    lost: st.lost,
    bad: st.bad,
    stale: st.stale,
    switchT: st.switchT,
    why: ownWhy,
    lastT: st.lastT,
    childMeanMs: +(st.childSumMs / Math.max(1, st.relayed)).toFixed(2),
    childMaxMs: +st.childMaxMs.toFixed(1),
    passiveMeanMs: +(st.ownSumMs / Math.max(1, st.ownN)).toFixed(3),
    passiveMaxMs: +st.ownMaxMs.toFixed(1),
    fullN: st.fullN,
    fullMeanMs: +(st.fullSumMs / Math.max(1, st.fullN)).toFixed(2),
    fullMaxMs: +st.fullMaxMs.toFixed(1),
    answerMaxMs: +st.answerMaxMs.toFixed(1),
    over25: st.over25,
    passive: PASSIVE,
    cpuReady: st.cpuReady,
    cpu,
    warmMs: Math.round(st.warmMs),
    warmCalls: st.warmCalls,
    readyMs: Math.round(st.readyMs),
    makeMs: Math.round(st.makeMs),
    childReadyMs: Math.round(st.childReadyMs),
    errors,
    inEqChildIn: hin === hci,
    childOutEqOut: hco === ho,
    hashIn: hin,
    hashChildIn: hci,
    hashChildOut: hco,
    hashOut: ho
  })}`);
  killChild();
  process.exit(0);
}
var inBuf = Buffer.alloc(0);
var queue = [];
var busy = false;
var inputEnded = false;
function pump() {
  if (busy || ended)
    return;
  const lines = queue.splice(0);
  if (!lines.length) {
    if (inputEnded)
      finish();
    return;
  }
  const msgs = lines.map((l) => {
    try {
      return JSON.parse(l.toString("utf8"));
    } catch {
      return null;
    }
  });
  let newest = -1;
  for (let i = 0;i < msgs.length; i++)
    if (msgs[i]?.type === "obs")
      newest = i;
  for (let i = 0;i < lines.length; i++) {
    const lineNl = lines[i], msg = msgs[i];
    if (hashOn)
      hIn.update(lineNl);
    if (msg?.type === "hello" && !helloSeen) {
      helloSeen = true;
      busy = true;
      queue.unshift(...lines.slice(i + 1));
      onHello(msg, lineNl).catch((e) => log("hello failed:", e)).then(() => {
        busy = false;
        pump();
      });
      return;
    }
    toChild(lineNl);
    if (msg?.type === "obs") {
      if (i === newest)
        onObs(msg);
      else {
        st.obs++;
        if (pending) {
          if (pending.timer)
            clearTimeout(pending.timer);
          ownAct(pending.obs, false);
          pending = null;
        }
        ownAct(msg, false);
      }
    } else if (msg?.type === "end") {
      finish();
      return;
    }
  }
  if (inputEnded)
    finish();
}
var helloSeen = false;
process.stdin.on("data", (chunk) => {
  inBuf = inBuf.length ? Buffer.concat([inBuf, chunk]) : chunk;
  let i;
  while ((i = inBuf.indexOf(NL)) >= 0) {
    const l = inBuf.subarray(0, i + 1);
    inBuf = inBuf.subarray(i + 1);
    if (l.length > 1)
      queue.push(Buffer.from(l));
  }
  pump();
});
process.stdin.on("end", () => {
  if (inBuf.length) {
    queue.push(Buffer.concat([inBuf, Buffer.from(`
`)]));
    inBuf = Buffer.alloc(0);
  }
  inputEnded = true;
  pump();
});
process.on("exit", () => {
  try {
    child?.kill("SIGKILL");
  } catch {}
});
process.on("SIGTERM", () => {
  killChild();
  process.exit(0);
});
