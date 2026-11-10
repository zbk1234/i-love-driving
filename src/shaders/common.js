import { ROAD } from '../config.js';

export const glf = (n) => Number(n).toFixed(6);

const [c1, c2] = ROAD.CURVE;

// 所有外景着色器共用：常量、共享 uniform、哈希、道路中心线
export const COMMON = /* glsl */ `
#define LANE_W ${glf(ROAD.LANE_W)}
#define EDGE_IN ${glf(ROAD.EDGE_IN)}
#define EDGE_OUT ${glf(ROAD.EDGE_OUT)}
#define LAMP_S ${glf(ROAD.LAMP_S)}
#define LAMP_H ${glf(ROAD.LAMP_H)}
#define LAMP_U ${glf(ROAD.LAMP_U)}
#define JOINT_S ${glf(ROAD.JOINT_S)}

uniform float uTime;
uniform vec4 uRoadPh;
uniform float uOriginZ;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uSkyTop;
uniform vec3 uSkyAmb;
uniform vec3 uGndAmb;
uniform vec3 uLampColor;
uniform float uWindowGlow;
uniform vec3 uHeadPos;
uniform vec3 uHeadDir;
uniform vec3 uHeadColor;
uniform float uHighBeam;
uniform float uFlash;
uniform vec2 uFlashDir;
uniform float uReflPass;
uniform float uRain;
uniform float uPixelAngle;
uniform sampler2D tNoise;

// hash without sine — Dave Hoskins (MIT)
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }

// 道路中心线，与 core/roadmath.js 保持一致
float roadX(float z) {
  return ${glf(c1[0])} * sin(z * ${glf(c1[1])} + uRoadPh.x) + ${glf(c2[0])} * sin(z * ${glf(c2[1])} + uRoadPh.y);
}
float roadDX(float z) {
  return ${glf(c1[0] * c1[1])} * cos(z * ${glf(c1[1])} + uRoadPh.x) + ${glf(c2[0] * c2[1])} * cos(z * ${glf(c2[1])} + uRoadPh.y);
}
`;

// 解析式光照：路灯位置是 z 的函数，不需要任何真实光源对象。
export const LIGHTING = /* glsl */ `
#define LAMP_P 130.0

// 路灯的漫反射 + 高光。只算前后夹住该点的两盏灯、且只算同侧的灯头：
// 更远的灯贡献不到 1%，这样每个像素只需 2 次计算。
void lampLight(vec3 P, vec3 N, vec3 V, float shin, out vec3 diff, out vec3 spec) {
  float dsum = 0.0;
  float ssum = 0.0;
  float k0 = floor(P.z / LAMP_S);
  for (int i = 0; i < 2; i++) {
    float lz = (k0 + float(i)) * LAMP_S;
    float cx = roadX(lz);
    vec3 L = vec3(cx + (P.x > cx ? LAMP_U : -LAMP_U), LAMP_H, lz) - P;
    float d2 = dot(L, L);
    vec3 Ld = L * inversesqrt(d2);
    float att = pow(max(Ld.y, 0.0), 1.3) / (d2 + 2.0);
    dsum += att * max(dot(N, Ld), 0.0);
    vec3 H = normalize(Ld + V);
    ssum += att * pow(max(dot(N, H), 0.0), shin);
  }
  vec3 c = uLampColor * LAMP_P;
  diff = c * dsum;
  spec = c * ssum;
}

// 无方向的路灯照度（雨丝、水雾用）
float lampScatter(vec3 P) {
  float sum = 0.0;
  float k0 = floor(P.z / LAMP_S);
  for (int i = 0; i < 2; i++) {
    float lz = (k0 + float(i)) * LAMP_S;
    float cx = roadX(lz);
    vec3 L = vec3(cx + (P.x > cx ? LAMP_U : -LAMP_U), LAMP_H, lz) - P;
    float d2 = dot(L, L);
    sum += pow(max(L.y * inversesqrt(d2), 0.0), 1.3) / (d2 + 2.0);
  }
  return sum * LAMP_P;
}

// 自车大灯：近光有明暗截止线，远光是一团更集中的光
float headBeam(vec3 P) {
  vec3 v = P - uHeadPos;
  float f = dot(v, uHeadDir);
  if (f < 0.5) return 0.0;
  vec3 rt = normalize(cross(uHeadDir, vec3(0.0, 1.0, 0.0)));
  float ax = dot(v, rt) / f;
  float ay = v.y / f;
  float wide = exp(-ax * ax / 0.20);
  float hot = exp(-ax * ax / 0.014);
  float cut = smoothstep(0.012, -0.03, ay);
  float low = (0.45 * wide + hot) * (cut + 0.04);
  float hi = exp(-(ax * ax + ay * ay * 3.0) / 0.035) * 3.0 * uHighBeam;
  return (low + hi) / (dot(v, v) + 6.0);
}

vec3 shadeSurface(vec3 albedo, vec3 N, vec3 V, vec3 P, float gloss, float shin, float retro) {
  float flash = 1.0 + uFlash * 8.0;
  vec3 amb = mix(uGndAmb, uSkyAmb, N.y * 0.5 + 0.5) * flash;
  vec3 ld;
  vec3 ls;
  lampLight(P, N, V, shin, ld, ls);
  float hb = headBeam(P);
  vec3 toHead = normalize(uHeadPos - P);
  vec3 col = albedo * (amb + ld + uHeadColor * hb * max(dot(N, toHead), 0.0));
  // 逆反射材料（标志牌、车牌）：把大灯的光原路打回来
  col += albedo * uHeadColor * hb * retro;
  // 湿表面的菲涅尔反光
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  vec3 R = reflect(-V, N);
  // 反射的环境：贴近地平线的方向是较亮的雾色，往上过渡到天顶，往下是暗的地面
  vec3 env = mix(uGndAmb * 1.5, mix(uFogColor * 1.15, uSkyTop * 1.3, smoothstep(0.0, 0.7, R.y)), smoothstep(-0.25, 0.05, R.y)) * flash;
  // 高光按光泽度做能量归一：越光滑的表面高光越小越亮，粗糙表面只有一层很淡的泛光
  col += gloss * (0.03 + 0.62 * fres) * env + gloss * ls * (shin + 8.0) * 0.0032;
  return col;
}

vec3 applyFog(vec3 col, vec3 P) {
  vec3 d = P - cameraPosition;
  float dist = length(d);
  float T = exp(-dist * uFogDensity);
  col = mix(uFogColor * (1.0 + uFlash * 5.0), col, T);
  // 大灯光柱在雨雾里的散射
  vec3 Pm = cameraPosition + d * min(1.0, 16.0 / max(dist, 1e-3));
  col += uHeadColor * headBeam(Pm) * min(dist, 30.0) * uFogDensity * (0.6 + 2.0 * uRain) * 0.12;
  return col;
}
`;
