// The world as a raster for the inked map's survey: each country drawn in a colour that spells its
// index. Used by the survey worker (on an OffscreenCanvas) or, where workers cannot draw, the page.
export function drawIds(ctx, grid, shapes) {
  let {w, h, cell, x0, y0} = grid;
  ctx.setTransform(1 / cell, 0, 0, 1 / cell, -x0 / cell, y0 / cell);
  // each country in a colour that spells its index, with a check byte: a blend of two colours at
  // an edge almost never passes the check, so edge cells are known as such
  for (let [index, rings] of shapes) {
    let i = index + 1;
    ctx.fillStyle = `rgb(${i & 255},${i >> 8},${(i * 37 + 101) & 255})`;
    ctx.beginPath();
    rings.forEach(r => { r.forEach(([x, y], k) => k ? ctx.lineTo(x, -y) : ctx.moveTo(x, -y)); ctx.closePath(); });
    ctx.fill('evenodd');
  }
  let data = ctx.getImageData(0, 0, w, h).data;
  let ids = new Int16Array(w * h);
  for (let c = 0; c < w * h; ++c) {
    let r = data[4 * c], g = data[4 * c + 1], b = data[4 * c + 2], a = data[4 * c + 3];
    if (a === 0) { ids[c] = -1; continue; }
    let i = r + (g << 8);
    ids[c] = a === 255 && i > 0 && b === ((i * 37 + 101) & 255) ? i - 1 : (a < 128 ? -1 : -2);
  }
  return ids;
}
