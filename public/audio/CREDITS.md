# 音频素材来源

| 文件 | 来源 | 作者 | 许可 |
| --- | --- | --- | --- |
| `wiper.mp3` | [Freesound #541292 · Windscreen Wipers in the Rain Loop (3)](https://freesound.org/people/OwlStorm/sounds/541292/) | OwlStorm（Ashe Kirk / Owlish Media） | [CC0 1.0](http://creativecommons.org/publicdomain/zero/1.0/) |
| `rain.mp3` | [Freesound #648913 · rain on a car](https://freesound.org/people/hemogobblin/sounds/648913/) | hemogobblin | [CC0 1.0](http://creativecommons.org/publicdomain/zero/1.0/) |
| `pass.mp3` | [Freesound #775045 · Car passing](https://freesound.org/people/Otto_H%C3%A4m%C3%A4l%C3%A4inen/sounds/775045/) | Otto_Hämäläinen | [CC0 1.0](http://creativecommons.org/publicdomain/zero/1.0/) |
| `blinker.mp3` | [Freesound #23968 · 061018_indicatorsR_mkh30-40_t002_ab_xtr.wav](https://freesound.org/people/ermine/sounds/23968/) | ermine | [CC BY-NC 3.0](http://creativecommons.org/licenses/by-nc/3.0/)（须署名、不得商用；作者另注明不得作为素材库二次分发） |
| `music/stan.mp3` | 用户提供的本地文件 `S.T.A.N.mp3`，原样收录、未转码 | 未提供 | 用户声明不涉及版权、可随项目发布；未提供单独的作者或许可证信息 |

`wiper.mp3` 的处理：截取原始文件 1.36 s ~ 10.50 s（7 个完整往复周期），首尾 10 ms 淡入淡出，峰值归一化到 -1 dBFS，48 kHz 立体声 128 kbps MP3。
换向点的时刻记录在 `src/core/audio.js` 的 `WIPER` 常量里；替换这个文件时要一并重新标注。

`rain.mp3` 的处理：使用全长 30.6 s，35 Hz 高通去掉车身低频隆隆声，增益 +22.6 dB（峰值约 -1 dBFS），48 kHz 单声道 80 kbps MP3。
首尾不做淡化——无缝循环在运行时由 `audio.js` 的 `_seamless` 裁掉编码器静音后交叉淡化生成。

`pass.mp3` 的处理：两级 180 Hz 高通去掉手机录音的风噪和低频隆隆声，截取 0.05 s ~ 5.55 s，首尾 0.25 s 淡入淡出，峰值归一化到 -1 dBFS，16 kHz 单声道 48 kbps MP3。
车离得最近的时刻（500 Hz 以上能量最大，2.97 s）记录在 `audio.js` 的 `PASS.PEAK` 里。

`blinker.mp3` 的处理：80 Hz 高通，取原始文件中段 5.6309 s ~ 11.6559 s 的 8 个完整周期（从一声「嗒」到第 9 声「嗒」），
起点提前 30 ms，前后再各留 20 ms 余量、尾部多留 20 ms 供运行时交叉淡化；增益 +9.2 dB（峰值约 -1 dBFS），44.1 kHz 立体声 96 kbps MP3。
「嗒」的时刻和亮灯时长记录在 `audio.js` 的 `BLINK` 常量里。
