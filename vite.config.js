import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// public/music 里放自己的本地歌曲（已加入 .gitignore）：
// 开发服务器启动时把文件名列表注入成 __LOCAL_MUSIC__，车载音响开局就带着这些歌；
// 打包时列表为空，并且把复制进 dist 的 music 目录去掉，歌曲不会随产物发布出去。
const MUSIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public/music');
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i;

const localMusic = () => ({
  name: 'local-music',
  apply: 'build',
  writeBundle(opts) {
    fs.rmSync(path.join(opts.dir, 'music'), { recursive: true, force: true });
  },
});

export default defineConfig(({ command }) => ({
  base: './',
  server: { port: 5183, strictPort: false, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  define: {
    __LOCAL_MUSIC__: JSON.stringify(
      command === 'serve' && fs.existsSync(MUSIC_DIR) ? fs.readdirSync(MUSIC_DIR).filter((f) => AUDIO_EXT.test(f)) : [],
    ),
  },
  plugins: [localMusic()],
}));
