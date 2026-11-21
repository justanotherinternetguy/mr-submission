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
  ffaDeaths: { def: 3, min: 1, max: 8, step: 1, int: true, desc: "This many deaths that were not our kills mean a free-for-all" },
  ffaCareful: { def: 1, min: 0, max: 1, step: 1, int: true, desc: "1 = in a free-for-all, fight only mechs within ffaEngR, mechs that hit us and mechs that can be finished, and retreat earlier (ffaEvHp, ffaEvHp2, three in contact)" },
  ffaEngR: { def: 120, min: 30, max: 250, step: 15, desc: "Free-for-all: fight mechs within this distance (m)" },
  ffaEvHp: { def: 0.45, min: 0.1, max: 0.9, step: 0.05, desc: "Free-for-all: retreat below this fraction of max HP" },
  ffaEvHp2: { def: 0.7, min: 0.1, max: 0.95, step: 0.05, desc: "Free-for-all: same, with two or more mechs in contact" },
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
  const rng = new Rng(hello.seed);
  const nav = navOf(world);
  const unstick = makeUnstick(new Rng(hello.seed ^ 625341585), Math.max(0.6, Q.stuckSecs));
  const nMechs = cfg.match?.mechs ?? 16;
  const upg = UPGRADE_ORDERS[clamp(Math.round(Q.upgOrder), 0, UPGRADE_ORDERS.length - 1)];
  const wval = { laser: Q.valLaser, lightning: Q.valLightning, mortar: Q.valMortar, gun: 2 };
  const sizePerCube = Number(cfg.cubes?.size_per_cube) || 0;
  const baseR = cfg.mech?.radius ?? 2.5, baseH = cfg.mech?.height ?? 9;
  const tracks = new Map;
  const pickMem = new Map, crateMem = new Map, cubeMem = new Map;
  const ignore = new Map;
  let kills = 0, ffa = false;
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
  return {
    name: "hamster",
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
        }
      }
      if (!ffa && nMechs - obs.alive - kills >= Math.round(Q.ffaDeaths))
        ffa = true;
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
      const careful = ffa && Q.ffaCareful >= 0.5;
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
        const calm = nT === 0 && !underFire && !hide && hpF >= Q.farmHp && t - lastThreatT > Q.farmWait && me.in_zone;
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
          if (skip(d.id))
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
        if (quiet && hpF >= Q.farmHp && !evade) {
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
var params_default = {
  grabCube: 0,
  grabHp: 0.6
};

// bot/main.ts
run((hello) => {
  const files = hello.map.files;
  const wj = files.find((f) => f.endsWith("world.json")) ?? "v2/world.json";
  const tf = files.find((f) => f.endsWith(".i16")) ?? "v2/terrain.i16";
  const world = new World(JSON.parse(readFileSync(join(hello.map.dir, wj), "utf8")), new Uint8Array(readFileSync(join(hello.map.dir, tf))));
  return makeBot(hello, world, params_default, { deadlineMs: 12, warm: true });
});
