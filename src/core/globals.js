import * as THREE from 'three';

// 所有外景材质共享的 uniform。材质里直接引用这些对象，改一处全部生效。
export const G = {
  uTime: { value: 0 },
  uRoadPh: { value: new THREE.Vector4() },
  uOriginZ: { value: 0 },

  uFogColor: { value: new THREE.Color(0.16, 0.18, 0.215) },
  uFogDensity: { value: 0.0045 },
  uSkyTop: { value: new THREE.Color(0.1, 0.125, 0.17) },
  uSkyAmb: { value: new THREE.Color(0.1, 0.12, 0.155) },
  uGndAmb: { value: new THREE.Color(0.03, 0.03, 0.035) },

  uLampColor: { value: new THREE.Color(1.0, 0.6, 0.28) },
  uWindowGlow: { value: 1 },

  uHeadPos: { value: new THREE.Vector3() },
  uHeadDir: { value: new THREE.Vector3(0, 0, -1) },
  uHeadColor: { value: new THREE.Color(0, 0, 0) },
  uHighBeam: { value: 0 },

  uFlash: { value: 0 },
  uFlashDir: { value: new THREE.Vector2(1, 0) },

  uReflPass: { value: 0 },
  uRain: { value: 0.7 },
  uPixelAngle: { value: 0.001 },

  tNoise: { value: null },
};

export const shared = () => ({ ...G });
