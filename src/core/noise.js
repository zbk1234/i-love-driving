import * as THREE from 'three';

// 启动时生成一张可无缝平铺的噪声贴图，四个通道各有用途：
//   R,G：细颗粒高度场的法线（沥青骨料、水面细纹）
//   B  ：低频云状噪声（积水分布、云层）
//   A  ：中频斑驳（脏污、色差）

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 周期性 value noise：cells × cells 的随机格点，平滑插值
function octave(size, cells, rnd) {
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const out = new Float32Array(size * size);
  const s = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * s;
    const y0 = Math.floor(fy);
    let ty = fy - y0;
    ty = ty * ty * (3 - 2 * ty);
    const ya = (y0 % cells) * cells;
    const yb = ((y0 + 1) % cells) * cells;
    for (let x = 0; x < size; x++) {
      const fx = x * s;
      const x0 = Math.floor(fx);
      let tx = fx - x0;
      tx = tx * tx * (3 - 2 * tx);
      const xa = x0 % cells;
      const xb = (x0 + 1) % cells;
      const a = lat[ya + xa] + (lat[ya + xb] - lat[ya + xa]) * tx;
      const b = lat[yb + xa] + (lat[yb + xb] - lat[yb + xa]) * tx;
      out[y * size + x] = a + (b - a) * ty;
    }
  }
  return out;
}

function fbm(size, layers, rnd) {
  const out = new Float32Array(size * size);
  for (const [cells, amp] of layers) {
    const o = octave(size, cells, rnd);
    for (let i = 0; i < out.length; i++) out[i] += o[i] * amp;
  }
  // 归一化到 0..1
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < out.length; i++) {
    if (out[i] < lo) lo = out[i];
    if (out[i] > hi) hi = out[i];
  }
  const k = 1 / (hi - lo || 1);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * k;
  return out;
}

export function makeNoiseTexture(renderer, size = 512) {
  const rnd = mulberry32(20261110);
  const grain = fbm(size, [[64, 0.3], [128, 0.4], [256, 0.3]], rnd);
  const low = fbm(size, [[3, 0.5], [6, 0.3], [12, 0.2]], rnd);
  const mid = fbm(size, [[8, 0.35], [16, 0.3], [32, 0.2], [64, 0.15]], rnd);

  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => grain[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (at(x + 1, y) - at(x - 1, y)) * 3.0;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 3.0;
      data[i] = Math.max(0, Math.min(255, 127.5 + dx * 127.5));
      data[i + 1] = Math.max(0, Math.min(255, 127.5 + dy * 127.5));
      data[i + 2] = low[y * size + x] * 255;
      data[i + 3] = mid[y * size + x] * 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}
