# 雨滴 + 雨刮特写：Blender Cycles 路径追踪。
# 用法：blender -b -P blender/rain_glass.py -- --res 1280x720 --samples 160 --px 0.25 --out blender/out/still.png
#
# 场景全部由脚本生成，没有外部素材：
#   · 玻璃 = 内侧一张平面 + 外侧一张高密度网格。外侧网格的起伏就是水（高度场），
#     水珠、水痕、雨刮推着的水脊都是真实几何体，折射由 Cycles 算出来。
#   · 外景 = 远处的一堆小发光体（路灯、尾灯、大灯、窗户、招牌）+ 湿路面。
#     相机对焦在玻璃上，光圈 f/2.8，所以外景的光斑是真实的景深虚化。
import math
import os
import sys
import time

import bpy
import numpy as np

# ---------------------------------------------------------------- 参数
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default


RES_X, RES_Y = (int(v) for v in arg('--res', '1280x720').split('x'))
SAMPLES = int(arg('--samples', '160'))
PX = float(arg('--px', '0.25')) * 1e-3          # 水面网格的格距（米）
OUT = os.path.abspath(arg('--out', 'blender/out/still.png'))
SEED = int(arg('--seed', '7'))
WIPE_DEG = float(arg('--wipe', '62'))           # 雨刮当前角度

rng = np.random.default_rng(SEED)

# 玻璃坐标：u 向右，v 沿玻璃向上，单位米。下面是相机能看到的那一块。
U0, U1 = -0.34, 0.34
V0, V1 = -0.25, 0.15
GLASS_T = 0.004                                  # 玻璃厚度
GLASS_DIST = 0.5                                 # 相机到玻璃中心
GLASS_TILT = math.radians(25)
EYE_Z = 1.2

# 雨刮：轴心、刮片内外半径、起止角、角速度
PIVOT = (-0.10, -0.48)
R_IN, R_OUT = 0.20, 0.70
A0 = math.radians(8)
A1 = math.radians(112)
ALPHA = math.radians(WIPE_DEG)
OMEGA = math.radians(100) / 0.55                 # 0.55 秒扫过 100°
BLADE_HALF = 0.005

N = int(round((U1 - U0) / PX)) + 1
M = int(round((V1 - V0) / PX)) + 1
print(f'[rain] grid {N}x{M} = {N * M / 1e6:.2f}M verts, px {PX * 1e3:.2f} mm')

# ---------------------------------------------------------------- 高度场
t_start = time.time()
H = np.zeros((M, N), np.float32)                 # 水的厚度（米）
OCC = np.zeros((M, N), bool)                     # 已经被水珠占掉的格子


def zone(u, v):
    """返回 (区域, 距上次刮过的秒数)。区域：0 没刮到，1 刚刮过，2 刮片/水脊下面"""
    du, dv = u - PIVOT[0], v - PIVOT[1]
    r = math.hypot(du, dv)
    phi = math.atan2(dv, du)
    dp = r * math.sin(phi - ALPHA)
    al = r * math.cos(phi - ALPHA)
    if R_IN - 0.004 < al < R_OUT + 0.004 and -BLADE_HALF - 0.002 < dp < 0.016:
        return 2, 0.0
    if R_IN < r < R_OUT and A0 < phi < ALPHA:
        return 1, (ALPHA - phi) / OMEGA
    if R_OUT <= r < R_OUT + 0.006 and A0 < phi < ALPHA:
        return 2, 0.0
    return 0, 1e3


def window(cu, cv, rw):
    i0 = max(int((cu - rw - U0) / PX), 0)
    i1 = min(int((cu + rw - U0) / PX) + 2, N)
    j0 = max(int((cv - rw - V0) / PX), 0)
    j1 = min(int((cv + rw - V0) / PX) + 2, M)
    return i0, i1, j0, j1


def free(cu, cv, a):
    """水珠要落的位置是不是空的"""
    for k in range(9):
        ang = k * math.pi / 4
        rr = 0.0 if k == 8 else a * 1.15
        i = int(round((cu + rr * math.cos(ang) - U0) / PX))
        j = int(round((cv + rr * math.sin(ang) - V0) / PX))
        if 0 <= i < N and 0 <= j < M and OCC[j, i]:
            return False
    return True


def stamp(cu, cv, a, hmax, elong=1.0, check=True):
    """放一颗水珠：球冠（接触角由 hmax/a 决定），轮廓略不规则，elong 沿重力方向拉长"""
    if check and not free(cu, cv, a):
        return False
    i0, i1, j0, j1 = window(cu, cv, a * 1.3 * elong)
    if i0 >= i1 or j0 >= j1:
        return False
    x = (U0 + np.arange(i0, i1) * PX - cu)[None, :]
    y = (V0 + np.arange(j0, j1) * PX - cv)[:, None] / elong
    r = np.hypot(x, y)
    ang = np.arctan2(y, x)
    e2, e3 = rng.uniform(0, 0.10), rng.uniform(0, 0.06)
    aa = a * (1 + e2 * np.cos(2 * ang + rng.uniform(0, 6.28)) + e3 * np.cos(3 * ang + rng.uniform(0, 6.28)))
    rn = r / aa
    th = 2 * math.atan(hmax / a)
    s, c = math.sin(th), math.cos(th)
    prof = (np.sqrt(np.clip(1 - (rn * s) ** 2, 0, None)) - c) / (1 - c)
    prof[rn >= 1] = 0
    H[j0:j1, i0:i1] = np.maximum(H[j0:j1, i0:i1], hmax * prof)
    OCC[j0:j1, i0:i1] |= rn < 1.1
    return True


def occupy(cu, cv, rad):
    i0, i1, j0, j1 = window(cu, cv, rad)
    if i0 >= i1 or j0 >= j1:
        return
    x = (U0 + np.arange(i0, i1) * PX - cu)[None, :]
    y = (V0 + np.arange(j0, j1) * PX - cv)[:, None]
    OCC[j0:j1, i0:i1] |= np.hypot(x, y) < rad


def drop_height(a):
    # 小水珠接触角大（鼓），大水珠被重力压扁，高度封顶在 1.7 mm 左右
    return min(a * rng.uniform(0.55, 0.75), 0.0017 * rng.uniform(0.85, 1.1))


def rand_pos():
    return rng.uniform(U0, U1), rng.uniform(V0, V1)


# ---- 1. 大水珠，其中一部分正在往下淌，身后留一条被「洗干净」的水痕和几颗残留小珠
n_large = 0
for _ in range(90):
    cu, cv = rand_pos()
    if zone(cu, cv)[0] != 0:
        continue
    a = rng.uniform(0.0026, 0.0042)
    if not stamp(cu, cv, a, drop_height(a), elong=rng.uniform(1.05, 1.3)):
        continue
    n_large += 1
    if rng.random() < 0.45:
        length = rng.uniform(0.03, 0.16)
        p1, p2 = rng.uniform(0, 6.28, 2)
        l1, l2 = rng.uniform(0.012, 0.03), rng.uniform(0.004, 0.009)
        next_bead = rng.uniform(0.003, 0.006)
        s = a
        while s < length:
            k = s / length
            pu = cu + 0.0016 * math.sin(s / l1 + p1) + 0.0006 * math.sin(s / l2 + p2) \
                - 0.0016 * math.sin(p1) - 0.0006 * math.sin(p2)
            pv = cv + s
            if zone(pu, pv)[0] != 0:
                break
            occupy(pu, pv, a * (0.95 - 0.35 * k))
            if s >= next_bead + a:
                ab = rng.uniform(0.0005, 0.0010) * (1 - 0.4 * k)
                stamp(pu + rng.normal(0, 0.0003), pv, ab, ab * 0.6, check=False)
                next_bead += rng.uniform(0.0025, 0.008)
            s += PX * 1.5

# ---- 2. 中、小、微水珠（先放大的，后放的遇到占位就放弃，所以不会重叠）
counts = {}
for name, n, lo, hi in (('medium', 700, 0.0015, 0.0026), ('small', 3400, 0.0008, 0.0015), ('tiny', 10000, 0.0005, 0.0008)):
    k = 0
    for _ in range(n):
        cu, cv = rand_pos()
        if zone(cu, cv)[0] != 0:
            continue
        a = rng.uniform(lo, hi)
        k += stamp(cu, cv, a, drop_height(a))
    counts[name] = k

# ---- 3. 刚刮过的区域：只有刮过之后才砸上来的新水珠，离刮片越远（刮得越早）越多
n_fresh = 0
max_since = (ALPHA - A0) / OMEGA
for _ in range(int(6000 * (U1 - U0) * (V1 - V0) * max_since)):
    cu, cv = rand_pos()
    z, since = zone(cu, cv)
    if z != 1 or rng.random() > since / max_since:
        continue
    a = rng.uniform(0.0005, 0.0011)
    n_fresh += stamp(cu, cv, a, a * rng.uniform(0.5, 0.7))

# ---- 4. 整张图上的东西：水膜、刮片前的水脊、刮片外端甩出的弧形水线、刮后的细条纹
u = (U0 + np.arange(N, dtype=np.float32) * PX)[None, :]
v = (V0 + np.arange(M, dtype=np.float32) * PX)[:, None]
du, dv = u - PIVOT[0], v - PIVOT[1]
R = np.hypot(du, dv)
PHI = np.arctan2(dv, du)
DP = R * np.sin(PHI - ALPHA)
AL = R * np.cos(PHI - ALPHA)
in_blade_len = (AL > R_IN) & (AL < R_OUT)
swept = (R > R_IN) & (R < R_OUT) & (PHI > A0) & (PHI < ALPHA) & (DP < -BLADE_HALF)
under_blade = in_blade_len & (np.abs(DP) <= BLADE_HALF)


def wobble(x, scales):
    out = np.zeros_like(x)
    for sc in scales:
        out = out + np.sin(x / sc + rng.uniform(0, 6.28))
    return out / len(scales)


# 没刮到的地方有一层厚薄不均的水膜：外景透过它会轻微扭曲
film = np.zeros((M, N), np.float32)
for _ in range(7):
    ang = rng.uniform(0, math.pi)
    lam = rng.uniform(0.006, 0.022)
    film += np.sin((u * math.cos(ang) + v * math.sin(ang)) * (2 * math.pi / lam) + rng.uniform(0, 6.28)).astype(np.float32)
film = 0.000022 * (1 + film / 7 * 1.6).clip(0, None)
H += np.where(swept | under_blade, 0, film).astype(np.float32)

# 刮片推着走的那道水脊
ridge_w = 0.008
k = np.clip((DP - BLADE_HALF) / ridge_w, 0, 1)
ridge = 0.0013 * np.clip(np.sin(math.pi * k), 0, 1) ** 0.7 * (0.72 + 0.28 * wobble(AL, (0.011, 0.027, 0.006)))
ridge = np.where(in_blade_len & (DP > BLADE_HALF), ridge, 0)
H = np.maximum(H, ridge.astype(np.float32))

# 刮片外端在玻璃上留下的那条弧形水线
arc = 0.0006 * np.exp(-((R - R_OUT - 0.002) / 0.0016) ** 2) * (0.6 + 0.4 * wobble(PHI, (0.02, 0.05, 0.008)))
arc = np.where((PHI > A0) & (PHI < ALPHA) & (DP < 0), arc, 0)
H = np.maximum(H, arc.astype(np.float32))

# 刚刮过的地方残留的极薄条纹，几分之一秒内蒸发/流平
since_map = np.clip((ALPHA - PHI) / OMEGA, 0, None)
streak = 0.000004 * (1 + wobble(R, (0.0015 / 6.28, 0.0041 / 6.28, 0.0009 / 6.28))) * np.exp(-since_map / 0.25)
H += np.where(swept, streak, 0).astype(np.float32)

H[under_blade] = 0
assert np.isfinite(H).all() and H.min() >= 0, 'heightfield has bad values'
del film, ridge, arc, streak, since_map, R, PHI, DP, AL, swept, in_blade_len, OCC
print(f'[rain] drops: large {n_large}, {counts}, fresh {n_fresh}; heightfield {time.time() - t_start:.1f}s')

# ---------------------------------------------------------------- 场景
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection


def new_obj(name, mesh, mat=None, parent=None):
    ob = bpy.data.objects.new(name, mesh)
    col.objects.link(ob)
    if mat:
        mesh.materials.append(mat)
    if parent:
        ob.parent = parent
    return ob


def node_mat(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    return mat, nt, out


def emission_mat(name, color, strength):
    mat, nt, out = node_mat(name)
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (*color, 1)
    em.inputs['Strength'].default_value = strength
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    return mat


def diffuse_mat(name, color, rough=0.6):
    mat, nt, out = node_mat(name)
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = rough
    nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
    return mat


def boxes_mesh(name, boxes):
    """boxes: [(cx, cy, cz, hx, hy, hz)]，合成一个网格"""
    verts, faces = [], []
    for cx, cy, cz, hx, hy, hz in boxes:
        b = len(verts)
        for sz in (-1, 1):
            for sy in (-1, 1):
                for sx in (-1, 1):
                    verts.append((cx + sx * hx, cy + sy * hy, cz + sz * hz))
        faces += [(b, b + 2, b + 3, b + 1), (b + 4, b + 5, b + 7, b + 6), (b, b + 1, b + 5, b + 4),
                  (b + 2, b + 6, b + 7, b + 3), (b, b + 4, b + 6, b + 2), (b + 1, b + 3, b + 7, b + 5)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    return me


# ---- 玻璃
glass_root = bpy.data.objects.new('glass', None)
col.objects.link(glass_root)
glass_root.location = (0, GLASS_DIST, EYE_Z)
glass_root.rotation_euler = (GLASS_TILT, 0, 0)   # 上沿朝车内倾

mat_glass, nt, out = node_mat('glass')
g = nt.nodes.new('ShaderNodeBsdfGlass')
g.inputs['Color'].default_value = (0.93, 0.975, 0.955, 1)
g.inputs['Roughness'].default_value = 0.0
g.inputs['IOR'].default_value = 1.45              # 玻璃 1.52 和水 1.33 之间取一个值，整体当作一种介质
nt.links.new(g.outputs[0], out.inputs['Surface'])

t_mesh = time.time()
co = np.empty((M, N, 3), np.float32)
co[..., 0] = (U0 + np.arange(N, dtype=np.float32) * PX)[None, :]
co[..., 1] = GLASS_T + H
co[..., 2] = (V0 + np.arange(M, dtype=np.float32) * PX)[:, None]
me = bpy.data.meshes.new('glass_outer')
me.vertices.add(M * N)
me.vertices.foreach_set('co', co.ravel())
idx = np.arange(M * N, dtype=np.int32).reshape(M, N)
loops = np.stack([idx[:-1, :-1], idx[1:, :-1], idx[1:, 1:], idx[:-1, 1:]], -1).ravel()  # 法线朝车外
nq = (M - 1) * (N - 1)
me.loops.add(4 * nq)
me.loops.foreach_set('vertex_index', loops)
me.polygons.add(nq)
me.polygons.foreach_set('loop_start', np.arange(nq, dtype=np.int32) * 4)
try:
    me.polygons.foreach_set('loop_total', np.full(nq, 4, np.int32))
except Exception:
    pass
me.update(calc_edges=True)
if hasattr(me, 'shade_smooth'):
    me.shade_smooth()
else:
    me.polygons.foreach_set('use_smooth', np.ones(nq, bool))
new_obj('glass_outer', me, mat_glass, glass_root)
del co, idx, loops, H

me = bpy.data.meshes.new('glass_inner')
me.from_pydata([(U0, 0, V0), (U1, 0, V0), (U1, 0, V1), (U0, 0, V1)], [], [(0, 1, 2, 3)])  # 法线朝车内
new_obj('glass_inner', me, mat_glass, glass_root)
print(f'[rain] mesh {time.time() - t_mesh:.1f}s')

# ---- 雨刮（在玻璃外侧）
mat_rubber = diffuse_mat('rubber', (0.012, 0.012, 0.013), 0.45)
dir_u, dir_v = math.cos(ALPHA), math.sin(ALPHA)


def wiper_part(name, r_a, r_b, half_w, y_lo, y_hi):
    me = boxes_mesh(name, [(0, (y_lo + y_hi) / 2, 0, (r_b - r_a) / 2, (y_hi - y_lo) / 2, half_w)])
    ob = new_obj(name, me, mat_rubber, glass_root)
    rm = (r_a + r_b) / 2
    ob.location = (PIVOT[0] + dir_u * rm, GLASS_T, PIVOT[1] + dir_v * rm)
    ob.rotation_euler = (0, -ALPHA, 0)


wiper_part('blade_rubber', R_IN, R_OUT, BLADE_HALF * 0.55, 0.0, 0.009)
wiper_part('blade_spine', R_IN + 0.005, R_OUT - 0.005, BLADE_HALF * 1.1, 0.009, 0.017)
wiper_part('blade_bridge', 0.40, 0.50, BLADE_HALF * 0.9, 0.017, 0.030)
wiper_part('arm', 0.0, 0.46, 0.007, 0.030, 0.036)

# ---- 车内：一圈黑色的壳，免得玻璃内表面反射出天空
mat_black = diffuse_mat('cabin', (0.004, 0.004, 0.004), 0.9)
new_obj('cabin', boxes_mesh('cabin', [
    (0, -0.45, EYE_Z, 0.8, 0.01, 0.6), (0, -0.15, EYE_Z + 0.5, 0.8, 0.3, 0.01), (0, -0.15, EYE_Z - 0.5, 0.8, 0.3, 0.01),
    (-0.8, -0.15, EYE_Z, 0.01, 0.3, 0.6), (0.8, -0.15, EYE_Z, 0.01, 0.3, 0.6),
]), mat_black)

# ---- 湿路面：粗糙度有深有浅（积水处像镜子），加一点起伏让倒影拉长、破碎
mat_road, nt, out = node_mat('road')
bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.02, 0.02, 0.022, 1)
tc = nt.nodes.new('ShaderNodeTexCoord')
n1 = nt.nodes.new('ShaderNodeTexNoise')
n1.inputs['Scale'].default_value = 0.35
n1.inputs['Detail'].default_value = 4
mr = nt.nodes.new('ShaderNodeMapRange')
mr.inputs['From Min'].default_value = 0.4
mr.inputs['From Max'].default_value = 0.62
mr.inputs['To Min'].default_value = 0.03
mr.inputs['To Max'].default_value = 0.26
n2 = nt.nodes.new('ShaderNodeTexNoise')
n2.inputs['Scale'].default_value = 9
n2.inputs['Detail'].default_value = 3
bump = nt.nodes.new('ShaderNodeBump')
bump.inputs['Strength'].default_value = 0.12
bump.inputs['Distance'].default_value = 0.02
nt.links.new(tc.outputs['Object'], n1.inputs['Vector'])
nt.links.new(tc.outputs['Object'], n2.inputs['Vector'])
nt.links.new(n1.outputs[0], mr.inputs['Value'])
nt.links.new(mr.outputs[0], bsdf.inputs['Roughness'])
nt.links.new(n2.outputs[0], bump.inputs['Height'])
nt.links.new(bump.outputs[0], bsdf.inputs['Normal'])
nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
me = bpy.data.meshes.new('road')
me.from_pydata([(-60, -5, 0), (60, -5, 0), (60, 420, 0), (-60, 420, 0)], [], [(0, 1, 2, 3)])
new_obj('road', me, mat_road)

# ---- 外景的灯
WARM = (1.0, 0.60, 0.28)
lamps, tails, heads, bodies = [], [], [], []
for i in range(11):
    y = 12 + i * 36
    lamps.append((6.6, y, 9.0, 0.28, 0.28, 0.10))
    lamps.append((-6.2, y + 18, 9.0, 0.28, 0.28, 0.10))
for x, y in ((0.3, 17), (3.8, 31), (-3.2, 44), (0.3, 66), (3.8, 92), (-3.2, 121), (0.3, 155), (3.8, 190)):
    bodies.append((x, y + 2.2, 0.8, 0.9, 2.2, 0.62))
    for sx in (-0.68, 0.68):
        tails.append((x + sx, y - 0.03, 0.86, 0.10, 0.02, 0.045))
    tails.append((x, y - 0.03, 1.32, 0.22, 0.02, 0.015))
for x, y in ((-9.2, 26), (-12.7, 41), (-9.2, 61), (-12.7, 86), (-9.2, 112), (-12.7, 141), (-9.2, 172), (-12.7, 215)):
    bodies.append((x, y + 2.2, 0.8, 0.9, 2.2, 0.62))
    for sx in (-0.66, 0.66):
        heads.append((x + sx, y - 0.03, 0.72, 0.09, 0.02, 0.05))
new_obj('lamps', boxes_mesh('lamps', lamps), emission_mat('lamp', WARM, 42))
new_obj('tails', boxes_mesh('tails', tails), emission_mat('tail', (1.0, 0.03, 0.015), 34))
new_obj('heads', boxes_mesh('heads', heads), emission_mat('head', (0.92, 0.96, 1.0), 110))
new_obj('cars', boxes_mesh('cars', bodies), diffuse_mat('car', (0.02, 0.022, 0.026), 0.25))

# 楼群：深色方块 + 亮着的窗户 + 几块彩色招牌
PALETTE = [((1.0, 0.72, 0.42), 4.0), ((1.0, 0.86, 0.66), 3.2), ((0.62, 0.80, 1.0), 3.0), ((1.0, 0.50, 0.20), 3.6)]
NEON = [((1.0, 0.10, 0.45), 9), ((0.10, 0.85, 1.0), 8), ((0.20, 1.0, 0.35), 7), ((1.0, 0.75, 0.10), 9), ((0.55, 0.25, 1.0), 9)]
blocks = []
windows = [[] for _ in PALETTE]
signs = [[] for _ in NEON]
for side in (-1, 1):
    y = 6.0
    while y < 400:
        depth = rng.uniform(12, 28)
        height = rng.uniform(14, 62)
        face = (16.5 if side < 0 else 14.5) + rng.uniform(0, 7)
        blocks.append((side * (face + 10), y + depth / 2, height / 2, 10, depth / 2, height / 2))
        lit = rng.uniform(0.08, 0.3)
        for row in range(int(height / 3.3)):
            for c in range(int(depth / 3.0)):
                if rng.random() < lit:
                    windows[rng.integers(len(PALETTE))].append(
                        (side * (face - 0.05), y + 1.5 + c * 3.0, 2.6 + row * 3.3, 0.02, 0.85, 0.75))
        if rng.random() < 0.6:
            signs[rng.integers(len(NEON))].append(
                (side * (face - 0.4), y + rng.uniform(2, depth - 2), rng.uniform(4, 11), 0.05, rng.uniform(0.8, 2.4), rng.uniform(0.4, 1.1)))
        y += depth + rng.uniform(1, 9)
new_obj('blocks', boxes_mesh('blocks', blocks), diffuse_mat('block', (0.012, 0.013, 0.016), 0.7))
for i, (c, s) in enumerate(PALETTE):
    if windows[i]:
        new_obj(f'win{i}', boxes_mesh(f'win{i}', windows[i]), emission_mat(f'win{i}', c, s))
for i, (c, s) in enumerate(NEON):
    if signs[i]:
        new_obj(f'sign{i}', boxes_mesh(f'sign{i}', signs[i]), emission_mat(f'sign{i}', c, s))

# ---- 天空：傍晚，地平线略亮
world = bpy.data.worlds.new('dusk')
scene.world = world
world.use_nodes = True
nt = world.node_tree
nt.nodes.clear()
tc = nt.nodes.new('ShaderNodeTexCoord')
sep = nt.nodes.new('ShaderNodeSeparateXYZ')
ramp = nt.nodes.new('ShaderNodeValToRGB')
ramp.color_ramp.elements[0].position = 0.0
ramp.color_ramp.elements[0].color = (0.085, 0.080, 0.095, 1)
ramp.color_ramp.elements[1].position = 1.0
ramp.color_ramp.elements[1].color = (0.010, 0.016, 0.036, 1)
e = ramp.color_ramp.elements.new(0.28)
e.color = (0.034, 0.044, 0.078, 1)
bg = nt.nodes.new('ShaderNodeBackground')
wout = nt.nodes.new('ShaderNodeOutputWorld')
nt.links.new(tc.outputs['Generated'], sep.inputs[0])
nt.links.new(sep.outputs['Z'], ramp.inputs[0])
nt.links.new(ramp.outputs[0], bg.inputs['Color'])
nt.links.new(bg.outputs[0], wout.inputs['Surface'])

# ---- 相机：对焦在玻璃上
cam_data = bpy.data.cameras.new('cam')
cam_data.lens = 35
cam_data.sensor_width = 36
cam_data.clip_start = 0.01
cam_data.clip_end = 1000
cam_data.dof.use_dof = True
cam_data.dof.focus_distance = GLASS_DIST + GLASS_T
cam_data.dof.aperture_fstop = 2.8
cam_data.dof.aperture_blades = 7
cam = bpy.data.objects.new('cam', cam_data)
col.objects.link(cam)
cam.location = (0, 0, EYE_Z)
cam.rotation_euler = (math.radians(87), 0, 0)
scene.camera = cam

# ---- 渲染设置
r = scene.render
r.engine = 'CYCLES'
r.resolution_x, r.resolution_y, r.resolution_percentage = RES_X, RES_Y, 100
r.filepath = OUT
r.image_settings.file_format = 'PNG'
c = scene.cycles
c.device = 'CPU'
c.samples = SAMPLES
c.use_adaptive_sampling = True
c.adaptive_threshold = 0.015
c.use_denoising = True
c.denoiser = 'OPENIMAGEDENOISE'
c.max_bounces = 12
c.transmission_bounces = 10
c.glossy_bounces = 4
c.diffuse_bounces = 2
c.caustics_reflective = False
c.caustics_refractive = False
c.sample_clamp_indirect = 10
scene.view_settings.view_transform = 'AgX'
try:
    scene.view_settings.look = 'AgX - Medium High Contrast'
except Exception:
    pass
scene.view_settings.exposure = float(arg('--exposure', '0'))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
t_render = time.time()
bpy.ops.render.render(write_still=True)
print(f'[rain] RENDER_SECONDS {time.time() - t_render:.1f}  TOTAL_SECONDS {time.time() - t_start:.1f}  -> {OUT}')
