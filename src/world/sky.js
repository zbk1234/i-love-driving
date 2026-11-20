import * as THREE from 'three';
import { shared } from '../core/globals.js';
import { COMMON } from '../shaders/common.js';

export function createSky() {
  const material = new THREE.ShaderMaterial({
    uniforms: shared(),
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * viewMatrix * vec4(position * 2500.0 + cameraPosition, 1.0);
        gl_Position.z = gl_Position.w * 0.999999;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        if (uDesert > 0.5) {
          vec3 col = mix(uFogColor, uSkyTop, smoothstep(-0.02, 0.65, h));
          float sunDist = length(d - uSunDir);
          col += vec3(0.65, 0.25, 0.075) * exp(-sunDist * sunDist / 0.07);
          float disc = 1.0 - smoothstep(0.064, 0.069, sunDist);
          vec3 sun = mix(vec3(2.0, 0.64, 0.18), vec3(2.6, 1.55, 0.62), smoothstep(0.02, 0.16, h));
          col = mix(col, sun, disc);
          vec2 cloudUV = d.xz / max(h + 0.16, 0.08);
          cloudUV = cloudUV * vec2(0.24, 1.05) + uTime * vec2(0.00065, 0.00012);
          float n = texture2D(tNoise, cloudUV).b * 0.65;
          n += texture2D(tNoise, cloudUV * 2.7).a * 0.25;
          n += texture2D(tNoise, cloudUV * 7.1).b * 0.10;
          float clouds = smoothstep(0.62, 0.78, n) * smoothstep(0.01, 0.09, h) * (1.0 - smoothstep(0.26, 0.48, h));
          vec3 cloudColor = mix(vec3(0.38, 0.27, 0.29), vec3(1.05, 0.65, 0.40), exp(-sunDist * 3.0));
          col = mix(col, cloudColor, clouds * 0.82);
          col = mix(col, uFogColor * 0.75, 1.0 - smoothstep(-0.20, -0.015, h));
          gl_FragColor = vec4(col, 1.0);
          return;
        }
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
