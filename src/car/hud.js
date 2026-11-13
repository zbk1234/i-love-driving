import * as THREE from 'three';
import { Player } from '@livliv-dev/player';
import { CAR, HUD } from '../config.js';
import { glassPoint } from './glass.js';

// 前挡 HUD：一个 LivLiv 角色（livliv-dev/player，WebGL2 的 2.5D 角色播放器）投在主驾正前方的风挡上。
// 播放器在一张不显示的小画布上自己跑（呼吸、眨眼、四处看），每画完一帧就把画布当贴图交给前挡的雨滴着色器，
// 着色器按玻璃坐标把它叠在玻璃内表面上（见 glass.js 的 HUD 一段）。
// 精选角色只许非商业使用并署名「角色：LivLiv（livliv.ai）」，右下角的 LivLiv 标记是许可的一部分，不去掉。

const CSS_H = 360; // 画布的 CSS 尺寸（播放器按它的大小画），够 HUD 在屏幕上的大小用了
const LOOK_RANGE = 0.9; // 鼠标离 HUD 中心多远（屏幕 NDC）算“看到头”，大概是半个屏幕
const _p = new THREE.Vector3();
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

// HUD 在玻璃上的宽度：从驾驶员眼睛看过去，画面的宽高比要和角色画布一致。
// 风挡斜着放，沿斜面的 H 米看起来要矮得多，所以按张角来算
function hudRect() {
  const eye = new THREE.Vector3(...CAR.EYE);
  const lo = glassPoint(HUD.CX, HUD.Y0).sub(eye);
  const hi = glassPoint(HUD.CX, HUD.Y0 + HUD.H).sub(eye);
  const mid = glassPoint(HUD.CX, HUD.Y0 + HUD.H / 2).sub(eye);
  const w = lo.angleTo(hi) * mid.length() * HUD.ASPECT;
  return new THREE.Vector4(HUD.CX - w / 2, HUD.Y0, 1 / w, 1 / HUD.H);
}

export class WindshieldHud {
  constructor(material) {
    this.material = material;
    this.on = true;
    this.ready = false;
    this.level = 0; // 当前亮度（开关时淡入淡出）
    this.player = null;
    this.center = glassPoint(HUD.CX, HUD.Y0 + HUD.H * 0.75); // 头部大致的位置（车体坐标），算视线用

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    // 必须留在页面里并且有尺寸（播放器按 clientWidth/Height 定画布大小），只是看不见
    Object.assign(canvas.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: `${Math.round(CSS_H * HUD.ASPECT)}px`,
      height: `${CSS_H}px`,
      opacity: '0',
      pointerEvents: 'none',
      zIndex: '-1',
    });
    document.body.appendChild(canvas);
    this.canvas = canvas;

    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.premultiplyAlpha = true; // 播放器的画布本来就是预乘的，原样上传
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this._size = `${canvas.width}x${canvas.height}`; // CanvasTexture 一创建就会按这个尺寸上传一次

    const u = material.uniforms;
    u.uHasHud.value = 1;
    u.tHud.value = this.texture;
    u.uHudRect.value.copy(hudRect());
    u.uHud.value = 0;

    if (!Player.isSupported()) return;
    try {
      // 画布藏在页面左上角，播放器自己跟鼠标会看偏；关掉它的，由 update() 按 HUD 在屏幕上的位置来 lookAt
      // 画布不在视野里（opacity 0），要 renderWhenHidden 才会一直画
      this.player = new Player(canvas, { followPointer: false, renderWhenHidden: true, maxPixelRatio: 1.5 });
    } catch (e) {
      console.warn('HUD 角色播放器启动失败', e);
      return;
    }
    this.player.onFrame = () => {
      // 播放器会按显示尺寸改画布大小；显存里的贴图大小是定死的，尺寸变了就重新建一张
      const s = `${canvas.width}x${canvas.height}`;
      if (s !== this._size) {
        this.texture.dispose();
        this._size = s;
      }
      this.texture.needsUpdate = true;
    };
    this.player
      .load(HUD.MODEL)
      .then((info) => {
        this.ready = true;
        this.info = info;
      })
      .catch((e) => {
        if (e.name !== 'AbortError') console.warn('HUD 角色加载失败', e);
      });
  }

  toggle() {
    this.on = !this.on;
    if (this.on && this.player && !this.player.playing) this.player.play();
    return this.on;
  }

  // 一些小反应：变道时点头，打雷时吓一跳
  react(kind) {
    if (!this.ready || !this.on) return;
    if (kind === 'lane') this.player.act('nod');
    else if (kind === 'thunder') {
      this.player.act('hop');
      this.player.setExpression('surprised') || this.player.setExpression('sad', 0.6);
      clearTimeout(this._exprT);
      this._exprT = setTimeout(() => this.player.setExpression(null), 1800);
    }
  }

  // gain：跟着昼夜调的亮度（白天要更亮才看得清）
  // pointer：鼠标的屏幕 NDC（-1..1，y 向上）；camera / cabinMatrix：把 HUD 投到屏幕上，让她朝鼠标看
  update(dt, gain, pointer, camera, cabinMatrix) {
    const target = this.on && this.ready ? gain : 0;
    this.level += (target - this.level) * Math.min(1, dt * 4);
    this.material.uniforms.uHud.value = this.level;
    if (this.ready && this.on && pointer && camera) {
      _p.copy(this.center).applyMatrix4(cabinMatrix).project(camera);
      this.player.lookAt(clamp1((pointer.x - _p.x) / LOOK_RANGE), clamp1((pointer.y - _p.y) / LOOK_RANGE));
    }
    // 关掉并且淡出完了就停下播放器，不白占 GPU
    if (this.player && !this.on && this.level < 0.002 && this.player.playing) this.player.pause();
  }
}
