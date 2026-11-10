import * as THREE from 'three';
import { shared } from '../core/globals.js';
import { COMMON, LIGHTING } from '../shaders/common.js';

// 雨丝：一个包住相机的盒子里有几千根雨线，位置在着色器里取模循环，所以永远下不完。
// 雨线的方向 = 雨的速度 - 车的速度，开得越快雨越是迎面扑来。
// 雨线会被路灯和大灯照亮（和路面用的是同一套解析光照）。

const BOX = new THREE.Vector3(26, 14, 40); // z 方向 40 能整除 rebase 距离，换原点时不会跳

export function createRain(count = 7000) {
  const base = new THREE.BufferGeometry();
  base.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  base.setIndex([0, 1, 2, 0, 2, 3]);

  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.attributes.position);
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
  geo.instanceCount = count;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...shared(),
      uBox: { value: BOX },
      uOff: { value: new THREE.Vector3() }, // 累计下落位移（对盒子取模）
      uStreak: { value: new THREE.Vector3(0, -0.2, 0) }, // 一帧曝光时间内相对相机划过的位移
      uCarPos: { value: new THREE.Vector3() },
      uCarFwd: { value: new THREE.Vector2(0, -1) },
      uAmount: { value: 1 },
    },
    vertexShader: /* glsl */ `
      ${COMMON}
      ${LIGHTING}
      attribute vec4 aSeed;
      uniform vec3 uBox;
      uniform vec3 uOff;
      uniform vec3 uStreak;
      uniform vec3 uCarPos;
      uniform vec2 uCarFwd;
      uniform float uAmount;
      varying float vSide;
      varying vec3 vCol;
      void main() {
        vec3 center = cameraPosition + vec3(uCarFwd.x, 0.0, uCarFwd.y) * 9.0 + vec3(0.0, 2.5, 0.0);
        vec3 p = aSeed.xyz * uBox + uOff;
        vec3 rel = mod(p - center + uBox * 0.5, uBox) - uBox * 0.5;
        vec3 head = center + rel;
        vec3 tail = head - uStreak * (0.7 + 0.6 * aSeed.w);
        vec4 v0 = viewMatrix * vec4(head, 1.0);
        vec4 v1 = viewMatrix * vec4(tail, 1.0);
        vec4 v = mix(v0, v1, position.y);
        float dist = length(v.xyz);
        // 沿视线方向展开成一条细带；太细时保持约 1 像素宽并相应变淡
        vec3 sideDir = normalize(cross(v1.xyz - v0.xyz, v.xyz) + vec3(1e-6, 0.0, 0.0));
        float w = max(0.0035, dist * uPixelAngle * 0.8);
        v.xyz += sideDir * position.x * w;
        gl_Position = projectionMatrix * v;

        float a = 0.0035 / w;
        a *= smoothstep(0.5, 2.2, dist) * exp(-dist * uFogDensity * 2.0);
        // 车内不下雨：车身包围盒（含倾斜的挡风玻璃）以内的雨线隐藏
        vec3 lc = head - uCarPos;
        float lf = dot(lc.xz, uCarFwd);
        float lr = dot(lc.xz, vec2(-uCarFwd.y, uCarFwd.x));
        float glassF = 1.05 - (lc.y - 0.94) * 1.74;
        if (abs(lr) < 1.0 && lf > -2.4 && lf < glassF && lc.y < 1.6) a = 0.0;
        a *= step(aSeed.w, uAmount);

        if (a < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // 看不见的雨线直接挪出屏幕，省掉填充

        vec3 lit = uSkyAmb * (0.9 + uFlash * 10.0) + uLampColor * lampScatter(head) * 0.5 + uHeadColor * headBeam(head) * 0.09;
        vCol = lit * a * 1.5;
        vSide = position.x * 2.0;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vSide;
      varying vec3 vCol;
      void main() {
        gl_FragColor = vec4(vCol * (1.0 - vSide * vSide), 1.0);
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.layers.set(1);
  mesh.renderOrder = 10;

  const fall = new THREE.Vector3();
  const off = material.uniforms.uOff.value;

  return {
    mesh,
    material,
    // carVel：车速向量（世界系）；wind：横风
    update(dt, carPos, carFwd, carVel, wind, amount) {
      fall.set(wind.x, -8.6, wind.z);
      off.addScaledVector(fall, dt);
      off.x = ((off.x % BOX.x) + BOX.x) % BOX.x;
      off.y = ((off.y % BOX.y) + BOX.y) % BOX.y;
      off.z = ((off.z % BOX.z) + BOX.z) % BOX.z;
      // 约 1/40 秒的「快门」，相对速度越大雨线越长
      material.uniforms.uStreak.value.copy(fall).sub(carVel).multiplyScalar(0.025);
      material.uniforms.uCarPos.value.copy(carPos);
      material.uniforms.uCarFwd.value.set(carFwd.x, carFwd.z);
      material.uniforms.uAmount.value = amount;
    },
  };
}
