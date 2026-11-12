// 车载音响：播放项目内置曲目，以及用户自己选中 / 拖进窗口的本地音频文件。
// 本地文件只在本机转成 blob URL 交给 <audio> 流式解码，不上传、不缓存，刷新页面后清空。
// 开发服务器下还会带上 public/music 里的本地歌曲（列表由 vite.config.js 注入，普通打包时为空）。
// 声音接进 AudioEngine 的总线（静音键一起生效），再模拟一下车载喇叭的频响：低频略鼓、高频收一点。

const EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i;
// 音量 10 档对应的增益上限：车里有雨声和路噪压着，给到 +12 dB 的余量（峰值由总线上的压缩器兜住）
const MAX_GAIN = 4;
// 随项目发布、普通打包也会带上的曲目；文件在 public/audio/music/，来源见 public/audio/CREDITS.md
const BUNDLED = [{ name: 'S.T.A.N', file: 'stan.mp3' }];

export class CarStereo {
  constructor(audio) {
    this.audio = audio;
    this.tracks = BUNDLED.map(({ name, file }) => ({
      name,
      url: `${import.meta.env.BASE_URL}audio/music/${file}`,
      preset: true,
    }));
    // 文件名用 encodeURI 而不是 encodeURIComponent：Vite 的静态服务只按 decodeURI 还原路径，
    // 逗号编码成 %2C 后就对不上文件，会退回 index.html；# 和 ? 仍须单独转义
    for (const f of typeof __LOCAL_MUSIC__ !== 'undefined' ? __LOCAL_MUSIC__ : []) {
      const file = encodeURI(f).replace(/[#?]/g, encodeURIComponent);
      this.tracks.push({ name: f.replace(/\.[^.]+$/, ''), url: `${import.meta.env.BASE_URL}music/${file}`, preset: true });
    }
    this.index = -1;
    this.volume = 0.8;
    this.duck = 1; // 外部压低的系数（开车窗时音乐听起来变小），不影响音量档位
    this.onChange = null; // (提示文字) => void

    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.addEventListener('ended', () => this.next());
    this.el.addEventListener('error', () => {
      if (this.index < 0) return;
      const t = this.tracks[this.index];
      if (t.preset) {
        // 预置曲目在当前部署里不存在（比如被部署平台当作忽略文件没传上去）：从列表里拿掉，改由用户自己导入
        this.tracks.splice(this.index, 1);
        this.index = -1;
        this.onChange?.(`没有找到「${t.name}」，按 P 导入本地歌曲`);
        return;
      }
      this.onChange?.(`无法播放：${t.name}`);
    });
    this._src = null;

    this.picker = document.createElement('input');
    this.picker.type = 'file';
    this.picker.accept = 'audio/*';
    this.picker.multiple = true;
    this.picker.addEventListener('change', () => {
      this.add(this.picker.files);
      this.picker.value = '';
    });
  }

  get playing() {
    return !this.el.paused;
  }

  // MediaElementSource 只能在 AudioContext 建好之后创建，且每个 <audio> 只能接一次；
  // 还没有 AudioContext 时（比如 ?autostart 跳过了开始按钮）先直接出声，用元素自己的音量
  _connect() {
    const ctx = this.audio.ctx;
    if (this._src) return;
    if (!ctx) {
      this.el.volume = this.volume;
      return;
    }
    this.el.volume = 1;
    this._src = ctx.createMediaElementSource(this.el);
    const shelf = (type, f, g) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.gain.value = g;
      return b;
    };
    this.gain = ctx.createGain();
    this.gain.gain.value = this.volume * MAX_GAIN * this.duck;
    this._src
      .connect(shelf('lowshelf', 110, 3))
      .connect(shelf('peaking', 2800, -2))
      .connect(shelf('highshelf', 7000, -4))
      .connect(this.gain)
      .connect(this.audio.master);
  }

  open() {
    this.picker.click();
  }

  // 加进播放列表；之前没在放就从新加的第一首开始
  add(files) {
    const first = this.tracks.length;
    for (const f of files) {
      if (!f.type.startsWith('audio/') && !EXT.test(f.name)) continue;
      this.tracks.push({ name: f.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(f) });
    }
    const n = this.tracks.length - first;
    if (!n) {
      this.onChange?.('没有可播放的音频文件');
      return;
    }
    if (!this.playing) this.play(first);
    else this.onChange?.(`已加入 ${n} 首 · 共 ${this.tracks.length} 首`);
  }

  play(i) {
    if (!this.tracks.length) return this.open();
    this._connect();
    this.index = ((i % this.tracks.length) + this.tracks.length) % this.tracks.length;
    const t = this.tracks[this.index];
    this.el.src = t.url;
    this.el.play().catch(() => {});
    this.onChange?.(`♪ ${t.name}`);
  }

  toggle() {
    if (this.index < 0) return this.play(0);
    this._connect();
    if (this.el.paused) {
      this.el.play().catch(() => {});
      this.onChange?.(`♪ ${this.tracks[this.index].name}`);
    } else {
      this.el.pause();
      this.onChange?.('音乐：暂停');
    }
  }

  next(d = 1) {
    if (this.tracks.length) this.play(this.index + d);
  }

  setVolume(d) {
    this.volume = Math.min(Math.max(Math.round((this.volume + d) * 10) / 10, 0), 1);
    if (this.gain) this.gain.gain.setTargetAtTime(this.volume * MAX_GAIN * this.duck, this.audio.ctx.currentTime, 0.05);
    else this.el.volume = this.volume;
    this.onChange?.(`音乐音量 ${Math.round(this.volume * 10)}`);
  }

  // k：0~1，每帧都可以调，变化很小时不重新排自动化
  setDuck(k) {
    if (Math.abs(k - this.duck) < 0.002) return;
    this.duck = k;
    if (this.gain) this.gain.gain.setTargetAtTime(this.volume * MAX_GAIN * k, this.audio.ctx.currentTime, 0.2);
  }
}
