import * as THREE from 'three';
import { shared } from '../core/globals.js';
import { COMMON } from '../shaders/common.js';

// 阴雨天的天空：地平线处融进雾色，头顶是缓慢流动的雨云；闪电时云层被照亮。
export function createSky() {
  const material = new THREE.ShaderMaterial({
    uniforms: shared(),
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * viewMatrix * vec4(position * 2500.0 + cameraPosition, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec2 cuv = d.xz / (abs(h) + 0.22);
        float c1 = texture2D(tNoise, cuv * 0.09 + uTime * vec2(0.0030, 0.0012)).b;
        float c2 = texture2D(tNoise, cuv * 0.27 - uTime * vec2(0.0040, 0.0021)).a;
        float cl = c1 * 0.65 + c2 * 0.35;
        cl = smoothstep(0.2, 0.85, cl);
        vec3 top = uSkyTop * (0.45 + 1.1 * cl);
        vec3 col = mix(uFogColor, top, smoothstep(0.0, 0.5, h));
        // 地平线以下：高架外面是被雾吞掉的城市
        col = mix(col, uFogColor * 0.6, smoothstep(0.0, -0.3, h));
        // 闪电
        float toward = 0.5 + 0.5 * dot(normalize(d.xz + 1e-4), uFlashDir);
        float fl = uFlash * (0.25 + 1.75 * cl * cl) * smoothstep(-0.15, 0.35, h) * (0.35 + 0.65 * toward * toward);
        col += vec3(0.72, 0.8, 1.0) * fl * 2.2 + uFogColor * uFlash * 4.0;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 100; // 排在所有不透明物体之后画，被挡住的像素直接被深度测试丢弃
  return mesh;
}
