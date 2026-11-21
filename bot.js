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
  stuckSecs: { def: 0, min: 0, max: 4, step: 0.3, desc: "Counts as stuck after trying to move for this long (s) without getting anywhere, then sidesteps with a jump; 0 = never (brawler's behavior: it can stay wedged on a corner until the zone kills it)" }
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
  const upgradePref = ["armor", "plating", "laser_charge", "laser_damage", "nanites", "gun_rate", "gun_damage", "lightning_efficiency", "gyros", "servos"];
  let strafe = 1, strafeT = 0;
  let threatYaw = null, threatT = -99;
  let wanderGoal = null;
  const strafeLo = Math.min(P_.strafeMin, P_.strafeMax), strafeHi = Math.max(P_.strafeMin, P_.strafeMax);
  const unstick = makeUnstick(new Rng(hello.seed ^ 625341585), P_.stuckSecs);
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
      for (const e of obs.events)
        if (e.type === "damaged" && e.bearing !== null && e.by !== null) {
          threatYaw = e.bearing;
          threatT = t;
        }
      const held = me.weapons.map((w) => w?.kind ?? null);
      const worst = held[1] === null ? 1 : rank[held[0]] <= rank[held[1]] ? 0 : 1;
      const wantPickup = obs.pickups.filter((p) => !held.includes(p.kind) && (held[1] === null || rank[p.kind] > rank[held[worst]]) && Math.abs(p.pos[2] - P[2]) < 4).sort((a, b) => dist(a.pos, P) - dist(b.pos, P))[0];
      if (wantPickup && dist(wantPickup.pos, P) < cfg.loot.pickup_radius) {
        act.take = wantPickup.id;
        if (held[1] !== null)
          act.drop = worst;
      }
      const enemies = obs.mechs.filter((m) => m.kind === "mech").sort((a, b) => dist(a.pos, P) - dist(b.pos, P));
      const npcs = obs.mechs.filter((m) => m.kind === "npc" && dist(m.pos, P) < P_.npcRange).sort((a, b) => dist(a.pos, P) - dist(b.pos, P));
      const target = enemies.find((e) => dist(e.pos, P) < P_.targetRange) ?? npcs[0];
      const crate = obs.crates.filter((c) => dist(c.pos, P) < P_.crateRange && Math.abs(c.pos[2] - P[2]) < 6).sort((a, b) => dist(a.pos, P) - dist(b.pos, P))[0];
      const z = obs.zone;
      const zr = t < z.shrink_start ? z.radius : z.next_radius;
      const zc = t < z.shrink_start ? z.center : z.next_center;
      const outside = dist(P, zc) > zr * P_.zoneMargin || t > z.shrink_start - P_.shrinkLead && dist(P, z.next_center) > z.next_radius * P_.nextZoneMargin;
      let goal = null;
      const hurt = me.hp < me.max_hp * P_.hurtFrac;
      if (outside)
        goal = dist(P, z.next_center) > z.next_radius * P_.nextZoneMargin ? z.next_center : zc;
      else if (wantPickup)
        goal = wantPickup.pos;
      else {
        const cube = obs.cubes.filter((c) => Math.abs(c.pos[2] - P[2]) < 4).sort((a, b) => dist(a.pos, P) - dist(b.pos, P))[0];
        if (cube && (P_.chaseCubesInFight >= 0.5 || !(target && target.kind === "mech" && !hurt)))
          goal = cube.pos;
        else if (crate && !target)
          goal = dist(crate.pos, P) > P_.crateStop ? crate.pos : null;
        else if (!target) {
          if (!wanderGoal || dist(wanderGoal, P) < 15 || rng.next() < 0.005) {
            const a = rng.range(0, 2 * Math.PI), d = Math.sqrt(rng.next()) * z.next_radius * P_.wanderFrac;
            wanderGoal = [z.next_center[0] + Math.cos(a) * d, z.next_center[1] + Math.sin(a) * d];
          }
          goal = wanderGoal;
        }
      }
      let move = [0, 0];
      let aimYaw = goal ? yawTo(P, goal) : me.aim[0], aimPitch = 0;
      if (target) {
        const d = dist(target.pos, P);
        if (t - strafeT > rng.range(strafeLo, strafeHi)) {
          strafe = -strafe;
          strafeT = t;
        }
        const toT = yawTo(P, target.pos);
        if (!goal || target.kind === "mech" && (!outside || P_.fightOutsideZone >= 0.5)) {
          const pref = hurt ? P_.rangeHurt : held.includes("lightning") ? P_.rangeLightning : held.includes("laser") ? P_.rangeLaser : P_.rangeGun;
          const radial = d > pref + P_.rangeBand ? 1 : d < pref - P_.rangeBand ? -1 : 0;
          const my = Math.atan2(Math.sin(toT) * radial + Math.sin(toT + Math.PI / 2) * strafe, Math.cos(toT) * radial + Math.cos(toT + Math.PI / 2) * strafe);
          const s = steer(world, P, my);
          move = [Math.cos(s), Math.sin(s)];
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
      } else if (crate) {
        aimYaw = yawTo(P, crate.pos);
        aimPitch = Math.atan2(crate.pos[2] + 1.2 - (P[2] + 7), dist(crate.pos, P));
        const g = me.weapons.findIndex((w) => w?.kind === "gun");
        if (g >= 0)
          act.fire[g] = Math.abs(wrapAngle(aimYaw - me.aim[0])) < 0.05;
        const l = me.weapons.findIndex((w) => w?.kind === "lightning");
        if (l >= 0 && dist(crate.pos, P) < 40)
          act.fire[l] = true;
      } else if (threatYaw !== null && t - threatT < 3) {
        aimYaw = threatYaw;
      } else if (!goal) {
        aimYaw = me.aim[0] + 0.6;
      }
      if (goal && move[0] === 0 && move[1] === 0) {
        const s = steer(world, P, yawTo(P, goal));
        move = [Math.cos(s), Math.sin(s)];
      }
      const free = unstick(t, P, move);
      act.move = free.move;
      if (free.jump)
        act.jump = true;
      act.aim = [aimYaw, Math.max(-0.6, Math.min(1.2, aimPitch))];
      act.boost = outside && me.energy > P_.boostEnergyOutside || hurt && !!target && me.energy > P_.boostEnergyHurt;
      const g = me.weapons.find((w) => w?.kind === "gun");
      if (g && !target && (g.ammo ?? 12) < P_.reloadBelow && (g.reload ?? 0) === 0)
        act.reload = true;
      return act;
    }
  };
}

// bot/params.json
var params_default = {};

// bot/main.ts
run((hello) => {
  const files = hello.map.files;
  const wj = files.find((f) => f.endsWith("world.json")) ?? "v2/world.json";
  const tf = files.find((f) => f.endsWith(".i16")) ?? "v2/terrain.i16";
  const world = new World(JSON.parse(readFileSync(join(hello.map.dir, wj), "utf8")), new Uint8Array(readFileSync(join(hello.map.dir, tf))));
  return makeBot(hello, world, params_default);
});
