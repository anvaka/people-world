// A density-equalizing flow on a grid (after Gastner, Seguy & More, "Fast flow-based algorithm for
// creating density-equalizing map projections", 2018). Every country has a density: the area it
// should have over the area it has. The density relaxes linearly to its mean while the plane
// flows with it: v = grad(phi) / rho(t), laplace(phi) = rho0 - mean. Points carried by the flow
// end where every region has grown or shrunk by its density. The flow deforms the whole plane, so
// what touched still touches and what was apart stays apart: a map carried by it keeps its
// borders and its neighbours. time.js uses it to take a drawn world to another year's sizes.
// in-place radix-2 FFT
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; ++i) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; ++k) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
// C[k] = sum x[n] cos(pi k (2n+1) / 2N), and its inverse; n a power of two
function makeDct(n) {
  const re = new Float64Array(2 * n), im = new Float64Array(2 * n);
  const cs = new Float64Array(n), sn = new Float64Array(n);
  for (let k = 0; k < n; ++k) { cs[k] = Math.cos(Math.PI * k / (2 * n)); sn[k] = Math.sin(Math.PI * k / (2 * n)); }
  return {
    forward(x, out) {
      for (let i = 0; i < n; ++i) { re[i] = x[i]; re[2 * n - 1 - i] = x[i]; }
      im.fill(0);
      fft(re, im);
      for (let k = 0; k < n; ++k) out[k] = (re[k] * cs[k] + im[k] * sn[k]) / 2;
    },
    inverse(c, out) {
      re.fill(0); im.fill(0);
      // unnormalized inverse FFT of Z[k] = w_k C[k] e^{i pi k / 2N}: conj(fft(conj(Z)))
      for (let k = 0; k < n; ++k) { const w = k ? 2 : 1; re[k] = w * c[k] * cs[k]; im[k] = -w * c[k] * sn[k]; }
      fft(re, im);
      for (let i = 0; i < n; ++i) out[i] = re[i] / n;
    },
  };
}

export class Flow {
  constructor(domain, nx, ny) {
    Object.assign(this, {x0: domain.x0, y0: domain.y0, nx, ny, dx: (domain.x1 - domain.x0) / nx, dy: (domain.y1 - domain.y0) / ny});
    this.dctX = makeDct(nx); this.dctY = makeDct(ny);
    this.gx = new Float32Array(nx * ny); this.gy = new Float32Array(nx * ny); this.rho = null; this.mean = 1;
    this.phi = new Float64Array(nx * ny);   // (doubles: the flow is its small differences)
  }
  // rho: densities at the cells' centres
  solve(rho) {
    const {nx, ny, dx, dy, phi} = this, n = nx * ny;
    let mean = 0;
    for (let i = 0; i < n; ++i) mean += rho[i];
    mean /= n;
    this.rho = rho; this.mean = mean;
    const row = new Float64Array(nx), rowOut = new Float64Array(nx), col = new Float64Array(ny), colOut = new Float64Array(ny);
    for (let j = 0; j < ny; ++j) {
      for (let i = 0; i < nx; ++i) row[i] = rho[j * nx + i] - mean;
      this.dctX.forward(row, rowOut);
      phi.set(rowOut, j * nx);
    }
    for (let i = 0; i < nx; ++i) {
      for (let j = 0; j < ny; ++j) col[j] = phi[j * nx + i];
      this.dctY.forward(col, colOut);
      const lx = (2 * Math.cos(Math.PI * i / nx) - 2) / (dx * dx);
      for (let j = 0; j < ny; ++j) {
        const l = lx + (2 * Math.cos(Math.PI * j / ny) - 2) / (dy * dy);
        col[j] = l ? colOut[j] / l : 0;
      }
      this.dctY.inverse(col, colOut);
      for (let j = 0; j < ny; ++j) phi[j * nx + i] = colOut[j];
    }
    for (let j = 0; j < ny; ++j) {
      for (let i = 0; i < nx; ++i) row[i] = phi[j * nx + i];
      this.dctX.inverse(row, rowOut);
      phi.set(rowOut, j * nx);
    }
    // the gradient at the cells' centres (no flow through the walls)
    const {gx, gy} = this;
    for (let j = 0; j < ny; ++j) for (let i = 0; i < nx; ++i) {
      const k = j * nx + i;
      gx[k] = (phi[j * nx + Math.min(nx - 1, i + 1)] - phi[j * nx + Math.max(0, i - 1)]) / (2 * dx);
      gy[k] = (phi[Math.min(ny - 1, j + 1) * nx + i] - phi[Math.max(0, j - 1) * nx + i]) / (2 * dy);
    }
    for (let j = 0; j < ny; ++j) { gx[j * nx] = 0; gx[j * nx + nx - 1] = 0; }
    for (let i = 0; i < nx; ++i) { gy[i] = 0; gy[(ny - 1) * nx + i] = 0; }
  }
  // carries points (x, y pairs in one array) along the flow from t = 0 to 1
  advect(pts, steps = 16) {
    const {nx, ny, dx, dy, x0, y0, gx, gy, rho, mean} = this;
    const n = pts.length >> 1;
    let vx = 0, vy = 0;
    const vel = (x, y, t) => {
      let u = (x - x0) / dx - 0.5, v = (y - y0) / dy - 0.5;
      u = u < 0 ? 0 : u > nx - 1.0001 ? nx - 1.0001 : u; v = v < 0 ? 0 : v > ny - 1.0001 ? ny - 1.0001 : v;
      const i = u | 0, j = v | 0, fu = u - i, fv = v - j, k = j * nx + i;
      const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
      const r = w00 * rho[k] + w10 * rho[k + 1] + w01 * rho[k + nx] + w11 * rho[k + nx + 1];
      const d = mean + (1 - t) * (r - mean);
      vx = (w00 * gx[k] + w10 * gx[k + 1] + w01 * gx[k + nx] + w11 * gx[k + nx + 1]) / d;
      vy = (w00 * gy[k] + w10 * gy[k + 1] + w01 * gy[k + nx] + w11 * gy[k + nx + 1]) / d;
    };
    const h = 1 / steps;
    for (let p = 0; p < n; ++p) {
      let x = pts[2 * p], y = pts[2 * p + 1];
      for (let s = 0; s < steps; ++s) {
        const t = s * h;
        vel(x, y, t); const k1x = vx, k1y = vy;
        vel(x + 0.5 * h * k1x, y + 0.5 * h * k1y, t + 0.5 * h);
        x += h * vx; y += h * vy;
      }
      pts[2 * p] = x; pts[2 * p + 1] = y;
    }
  }
}

// ---- the map as flat arrays: every ring's points in one array; a country is a run of rings
export function flatten(countries) {
  let n = 0;
  for (const c of countries) for (const r of c.rings) n += r.length;
  const pts = new Float64Array(2 * n), rings = [], first = [];
  let at = 0;
  countries.forEach((c, ci) => {
    first.push(rings.length);
    for (const r of c.rings) {
      rings.push({country: ci, start: at, len: r.length});
      for (const [x, y] of r) { pts[2 * at] = x; pts[2 * at + 1] = y; ++at; }
    }
  });
  first.push(rings.length);
  return {pts, rings, first};
}
export function areas(flat, pts = flat.pts) {
  const out = new Float64Array(flat.first.length - 1);
  for (const r of flat.rings) {
    let a = 0;
    for (let i = 0, j = r.len - 1; i < r.len; j = i++) {
      const p = 2 * (r.start + j), q = 2 * (r.start + i);
      a += pts[p] * pts[q + 1] - pts[q] * pts[p + 1];
    }
    out[r.country] += a / 2;
  }
  for (let i = 0; i < out.length; ++i) out[i] = Math.abs(out[i]);
  return out;
}
// which country each cell's centre is in (-1: the sea), by scanline, even-odd per country
export function rasterize(flat, pts, flow) {
  const {nx, ny, dx, dy, x0, y0} = flow;
  const owner = new Int32Array(nx * ny).fill(-1);
  for (let c = 0; c + 1 < flat.first.length; ++c) {
    const rows = new Map();
    for (let ri = flat.first[c]; ri < flat.first[c + 1]; ++ri) {
      const r = flat.rings[ri];
      for (let i = 0, j = r.len - 1; i < r.len; j = i++) {
        const ax = pts[2 * (r.start + j)], ay = pts[2 * (r.start + j) + 1], bx = pts[2 * (r.start + i)], by = pts[2 * (r.start + i) + 1];
        if (ay === by) continue;
        const lo = Math.min(ay, by), hi = Math.max(ay, by);
        let j0 = Math.ceil((lo - y0) / dy - 0.5), j1 = Math.ceil((hi - y0) / dy - 0.5) - 1;
        if (j0 < 0) j0 = 0; if (j1 > ny - 1) j1 = ny - 1;
        for (let row = j0; row <= j1; ++row) {
          const y = y0 + (row + 0.5) * dy, x = ax + (bx - ax) * (y - ay) / (by - ay);
          let list = rows.get(row);
          if (!list) rows.set(row, list = []);
          list.push(x);
        }
      }
    }
    for (const [row, xs] of rows) {
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let i0 = Math.ceil((xs[k] - x0) / dx - 0.5), i1 = Math.ceil((xs[k + 1] - x0) / dx - 0.5) - 1;
        if (i0 < 0) i0 = 0; if (i1 > nx - 1) i1 = nx - 1;
        for (let i = i0; i <= i1; ++i) owner[row * nx + i] = c;
      }
    }
  }
  return owner;
}
export function blur(field, nx, ny, sigma) {
  if (!(sigma > 0)) return field;
  const rad = Math.ceil(3 * sigma), ker = new Float64Array(2 * rad + 1);
  let sum = 0;
  for (let i = -rad; i <= rad; ++i) sum += ker[i + rad] = Math.exp(-i * i / (2 * sigma * sigma));
  for (let i = 0; i < ker.length; ++i) ker[i] /= sum;
  const tmp = new Float32Array(nx * ny), out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; ++j) for (let i = 0; i < nx; ++i) {
    let s = 0;
    for (let k = -rad; k <= rad; ++k) { const ii = i + k < 0 ? 0 : i + k > nx - 1 ? nx - 1 : i + k; s += ker[k + rad] * field[j * nx + ii]; }
    tmp[j * nx + i] = s;
  }
  for (let j = 0; j < ny; ++j) for (let i = 0; i < nx; ++i) {
    let s = 0;
    for (let k = -rad; k <= rad; ++k) { const jj = j + k < 0 ? 0 : j + k > ny - 1 ? ny - 1 : j + k; s += ker[k + rad] * tmp[jj * nx + i]; }
    out[j * nx + i] = s;
  }
  return out;
}
