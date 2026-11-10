// 键盘 + 鼠标。鼠标不锁定指针：光标离屏幕中心越远，头转得越多，移回中间就回正。

const PREVENT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab']);

export class Input {
  constructor() {
    this.keys = new Set();
    this.look = { x: 0, y: 0 };
    this.onPress = null;

    window.addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code)) e.preventDefault();
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      this.keys.add(e.code);
      this.onPress?.(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    const move = (x, y) => {
      this.look.x = Math.max(-1, Math.min(1, (x / window.innerWidth) * 2 - 1));
      this.look.y = Math.max(-1, Math.min(1, -((y / window.innerHeight) * 2 - 1)));
    };
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    document.addEventListener('mouseleave', () => {
      this.look.x = 0;
      this.look.y = 0;
    });
    window.addEventListener('touchmove', (e) => move(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    window.addEventListener('touchend', () => {
      this.look.x = 0;
      this.look.y = 0;
    });
  }

  has(...codes) {
    return codes.some((c) => this.keys.has(c));
  }
  get throttle() {
    return this.has('KeyW', 'ArrowUp') ? 1 : 0;
  }
  get brake() {
    return this.has('KeyS', 'ArrowDown', 'Space') ? 1 : 0;
  }
  // 左转为正
  get steer() {
    return (this.has('KeyA', 'ArrowLeft') ? 1 : 0) - (this.has('KeyD', 'ArrowRight') ? 1 : 0);
  }
}
