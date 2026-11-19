# 音视频解析（av-inspect）

NNSerialTool 的只读码流分析视图，数据源是任意串口/TCP/UDP 会话的原始 RX 字节流。

## 当前支持

- **H.264 Annex-B**：NAL 类型、SPS 解析（profile/level/分辨率/色度）、IDR 关键帧标记
- **H.265 Annex-B**：NAL 类型与关键帧统计（分辨率解析待补）
- **ADTS AAC**：逐帧长度、采样率、声道、Profile
- **MPEG-TS**：188 字节包、PAT/PMT、PID 统计、PES 起始行
- **WAV**：RIFF/fmt/data 头解析
- 自动识别 + 手动格式切换、暂停、清空、帧/包表、十六进制预览、导出 JSON

## 用法

1. 在 NNSerialTool 中打开一个连接并选择“音视频解析”视图；
2. “数据源”选择对应会话；
3. 码流到达后自动识别；若自动识别不对，手动选择格式；
4. 点击表格行查看该帧/包前 64 字节；“导出 JSON”保存当前统计与帧列表。

### 文件解析

- 顶部切到“文件解析”，点击“导入文件”或直接拖放；
- MP4/MOV/M4V、AVI、裸 H.264/H.265/AAC/TS/WAV/BIN 均可导入；
- 左侧显示 MP4 box / AVI chunk 树，点击跳转右侧十六进制偏移；
- 右侧支持偏移跳转、上一页/下一页、8/16 字节自适应；
- MP4/MOV/WAV 可点“播放”用 WebView 原生解码预览；AVI 浏览器不支持原生解码，只解析结构。

## 注意

- 插件只读取 `onRawData` / 本地 File API，不发送数据、不上传文件、不写 localStorage；
- 分析缓冲区保留最近 8 MB，帧表最多 5000 行；文件上限 256MB；
- 不支持加密/压缩容器（MKV/FLV 等），当前针对 MP4/AVI 容器和裸码流；
- H.265 暂时只做 NAL 统计，SPS/VPS 分辨率解析后续补；
- 播放能力取决于 WebView 内置解码器：MP4 的 H.264/AAC 通常可播，HEVC 可能不可播；AVI 不可播。

