import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CAR } from '../config.js';

// 读入车模，转到车体局部坐标（车头朝 -Z），再按用途把零件分拣好：
//   body      车身 + 内饰（车内场景用）
//   wheel     方向盘（要能转）
//   screens   仪表、行车电脑、导航屏（换成实时画的贴图）
//   glass     全部车窗（换成雨滴着色器）
//   mirrors   三面后视镜的镜片（换成真的反射）
// 分拣靠的是模型里的节点名和材质名，换别的模型时改这几张表就行。

const NODE_WHEEL = 'Object015';
const NODE_GLASS = 'Object016';
const MAT_MIRROR = '13___Default';
const MAT_SCREENS = { Material__2964: 'speedo', Material__2158: 'rev', Material__2160: 'info', Material__2963: 'nav' };

export async function loadCarModel() {
  const gltf = await new GLTFLoader().loadAsync(import.meta.env.BASE_URL + CAR.MODEL);
  const root = gltf.scene;
  root.rotation.y = Math.PI; // 模型的车头朝 +Z
  root.updateMatrixWorld(true);

  const model = { body: [], wheel: [], screens: {}, glass: null, mirrors: null };
  root.traverse((o) => {
    if (!o.isMesh) return;
    const geometry = o.geometry;
    geometry.applyMatrix4(o.matrixWorld);
    const node = o.parent === root ? o.name : o.parent.name;
    const part = { geometry, material: o.material, name: o.material.name };
    if (node === NODE_GLASS) model.glass = geometry;
    else if (part.name === MAT_MIRROR) model.mirrors = geometry;
    else if (MAT_SCREENS[part.name]) model.screens[MAT_SCREENS[part.name]] = geometry;
    else if (node === NODE_WHEEL) model.wheel.push(part);
    else model.body.push(part);
  });
  if (!model.glass || !model.mirrors) throw new Error('车模里没找到车窗或后视镜');
  return model;
}

// 取出几何体里的三角形顶点（展开索引），返回 Float32Array
export function trianglePositions(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  return new Float32Array(g.attributes.position.array);
}
