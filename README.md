# NNSerialTool 插件仓库 & 开发指南

[NNSerialTool](https://github.com/lsx666xsl/NNSerialTool)（串口/网络调试工具）的插件生态仓库。
本仓库既是**插件市场的内容源**（应用内"设置 → 插件管理 → 插件市场"从这里读取清单），
也是**插件开发的唯一权威文档**。

```
本仓库结构
├─ plugins/<插件id>/        ← 插件源文件（贡献者只改这里，PR 提交到这里）
│   ├─ plugin.json             清单（必需，见下文规范）
│   ├─ main.js                 入口（必需，ES Module；带 src/ 的插件由 CI 构建生成）
│   ├─ src/                    TS 源码（可选；存在则 CI 经 esbuild 打包出 main.js）
│   └─ README.md               插件说明（可选）
├─ packages/                 ← CI 自动打包的 zip 产物（禁止手改）
├─ index.json                ← 市场索引（CI 自动再生成，禁止手改）
├─ schema.json               ← plugin.json 校验规则（编辑器套用后自动补全）
└─ scripts/build-index.mjs   ← 校验 + 生成索引脚本（CI 与本地自检共用）
```

---

## 一、五分钟上手

1. 复制 `plugins/hello-view/` 为 `plugins/<你的插件id>/`；
2. 改 `plugin.json` 的 id / name / version / description；
3. 改 `main.js` 实现你的功能（API 见下文第三节）；
4. 本地自检：`node scripts/build-index.mjs --check`；
5. 本地体验：把插件目录打成 zip（根含 plugin.json 与 main.js），在应用
   "设置 → 插件管理 → 导入本地插件包" 安装；
6. 提 PR 合并进 `main` → CI 自动打包上架 → 应用内插件市场即可安装。

---

## 二、plugin.json 清单规范

```json
{
  "id": "hello-view",
  "name": "Hello 视图",
  "version": "1.0.0",
  "apiVersion": 1,
  "type": "view",
  "entry": "main.js",
  "author": "yourname",
  "description": "一句话描述，市场列表展示",
  "permissions": [],
  "minAppVersion": "0.6.0"
}
```

| 字段 | 必填 | 规则 |
|------|------|------|
| `id` | ✅ | `^[a-z0-9][a-z0-9-]{0,63}$`，全局唯一，安装目录名也用它 |
| `name` | ✅ | 展示名（功能切换按钮 / 市场列表） |
| `version` | ✅ | 语义化版本 `MAJOR.MINOR.PATCH`，市场据此判断"可更新" |
| `apiVersion` | ✅ | 当前为 **1**；应用加载时会校验，不匹配直接拒绝 |
| `type` | ✅ | `view`（新增界面）或 `protocol`（新增数据解析协议） |
| `entry` | ❌ | 入口文件名，默认 `main.js`；只能是文件名，不能带路径 |
| `author` | ❌ | 展示用 |
| `description` | ❌ | 展示用 |
| `permissions` | ❌ | 权限白名单，只允许 `send`（发送数据）/ `storage`（本地存储） |
| `minAppVersion` | ❌ | 要求的最低应用版本，低于则拒绝加载并提示升级 |

**zip 包布局**：`plugin.json` 与 `main.js` 在 zip 根目录，或同处唯一一个顶层目录下
（如 `hello-view/plugin.json`）。两种都接受，其余布局拒绝安装。

---

## 三、PluginContext —— 插件能调用的全部 API

入口文件 `main.js` 是 ES Module，**默认导出 `activate`，可选导出 `deactivate`**：

```js
export default function activate(ctx) { /* 注册你的视图/协议 */ }
export function deactivate() { /* 可选：插件停用/卸载时清理 */ }
```

`ctx` 即 PluginContext，这是插件与宿主唯一的通信面——拿不到任何底层接口。

### 3.1 视图插件（type: "view"）

#### 方式 A：DOM 挂载（推荐，零构建、纯 JS）

```js
export default function activate(ctx) {
  ctx.registerView({
    id: 'demo',            // 最终视图键自动变为 plugin-<插件id>-demo
    name: 'Demo',          // 功能切换按钮文案（排在 转发/波形 之后）
    tip: '悬停说明',
    blocks: 2,             // 悬停缩略图方块数 1~4
    component: {           // DOM 契约：不用 Vue 也能写界面
      mount(el, ctx) {
        el.innerHTML = '<div class="demo">Hello</div>';
        const off = ctx.onThemeChange(() => repaint());
        return () => off();          // 返回清理函数（可选）
      },
      unmount(el) { el.innerHTML = ''; },
    },
  });
}
```

#### 方式 B：Vue 组件对象

若你有自己的构建链（Vite 库模式等）能产出编译好的组件对象，直接把组件对象
传给 `component` 字段（`defineComponent(...)` 的返回值或 SFC 编译产物）。
组件将被渲染在应用主区域，`<component :is>` 动态挂载。

### 3.2 协议插件（type: "protocol"）

为波形视图（或未来任何数据订阅方）新增一种数据帧解析器：

```js
export default function activate(ctx) {
  ctx.registerProtocol({
    id: 'mylink',
    name: 'MyLink',
    description: '自定义帧协议',
    createParser() {
      let buf = new Uint8Array(0);
      return {
        // 字节流按到达顺序连续喂入；返回本批解析出的帧
        feed(bytes, t) {
          buf = concat(buf, bytes);
          const frames = [];
          // ...按你的帧格式切帧，每个帧吐 { t, channels: [v1, v2, ...] }
          return frames;
        },
        reset() { buf = new Uint8Array(0); },  // 切换会话/协议时被调用
      };
    },
  });
}
```

帧对象 `WaveFrame`：`{ t: number, channels: number[], seq?: number }`。
`t` 用传入的时间戳；`seq` 可选（连续帧序号，用于丢帧统计）。
解析器契约：**自持状态、容忍粘包/断包、坏帧后能重新同步**（参考内置 NN-Wave 实现）。

### 3.3 能力面速查

| 方法 | 说明 | 权限 |
|------|------|------|
| `ctx.theme()` | 当前主题 `'light' \| 'dark'` | — |
| `ctx.themeColors()` | 主题色板（bg/panel/border/text/textDim/grid/accent/palette[8]） | — |
| `ctx.onThemeChange(cb)` | 主题变化通知，返回取消订阅函数 | — |
| `ctx.listSessions()` | 会话快照 `[{id,name,type,status}]` | — |
| `ctx.onRawData(cb)` | 订阅原始 RX 字节流 `{sessionId, sessionName, bytes, t}` | — |
| `ctx.send(sessionId, bytes)` | 向会话发送原始字节 | `send` |
| `ctx.notify(text)` | 中央 toast 提示 | — |
| `ctx.onSessionsChange(cb)` | 会话列表变化订阅（新建/断开/更名），返回取消函数（应用 ≥ 0.5.2 功能版） | — |
| `ctx.exportTextFiles(title, files)` | 弹目录选择后覆盖写出文本文件（固件模板导出等），返回目录（取消返回 ''） | — |
| `ctx.storage.get(key, fallback)` / `.set(key, value)` | 插件私有持久化（按插件 id 隔离） | `storage` |
| `ctx.registerView(def)` / `ctx.registerProtocol(def)` | 注册视图/协议 | — |
| `ctx.log(...)` | 控制台日志（带 `[plugin:<id>]` 前缀） | — |

未声明权限就调用 `send` / `storage` 会直接抛错；权限清单会在安装时展示给用户。

---

## 四、主题必须继承应用（硬性要求）

插件**不允许自带独立主题、不允许写死颜色**：

- DOM 方式写界面：容器会被渲染在应用主区域内，深浅色由应用全局类
  `theme-light` / `theme-dark` 控制；颜色一律取 `ctx.themeColors()`，
  并用 `ctx.onThemeChange()` 重绘（Canvas 类界面尤其注意）；
- 通道/曲线配色从 `themeColors().palette` 取（8 色循环）；
- 主题切换不会重建 DOM，插件自行监听并更新样式。

---

## 五、NN-Wave 协议参考（内置波形协议）

开发"兼容某上位机协议"的解析插件时可参考内置 NN-Wave 的帧设计：

```
[AA 55][type][N][seq][float32 × N 小端][CRC8]
  type: 0x01 数据帧（N 个 float32）
        0x02 通道名元数据帧（payload 若干 [len][utf8]，0x00 补齐 4N 字节）
  seq : 0~255 循环递增（丢帧检测）
  CRC8: 多项式 0x07 初值 0x00，覆盖 type..data
```

解析要点：逐字节扫描帧头重同步；半帧留缓冲等下一批；CRC 不符前移一字节继续扫。

---

## 六、打包与上架

- CI 在 PR 上做校验 + 构建（esbuild 编译带 `src/` 的插件，编译错误直接挡在 PR）；合并到 `main` 后自动
  zip 打包到 `packages/<id>-<version>.zip`、计算 sha256、重写 `index.json` 并提交回仓库；
- 市场索引条目自动生成：`{id, name, version, type, description, author,
  download, sha256, size, apiVersion}`；`download` 用 jsDelivr CDN（备源 GitHub raw）；
- **`plugins/wave/`（波形外置版）**：应用内置波形的外置副本（同源引擎/渲染器，DOM 挂载契约实现）。
  过渡期与内置版共存——功能切换会出现两个「波形」入口，属预期；应用侧移除内置版后即为唯一入口。
  本地构建：`npm install && npm run build`；
- **版本升级 = 改 plugin.json 的 version + 提 PR**；同版本改动不会被市场识别为更新；
- 删除插件 = 删 `plugins/<id>/` 目录（CI 会从索引移除）。

## 七、兼容性承诺

- `apiVersion` 只在破坏性变更时递增；应用升级尽量只追加 API 方法；
- 插件加载时被隔离在 try/catch 中——抛错只影响该插件自身（界面提示加载失败），
  不影响应用与其他插件；
- 每个插件只能读自己的 storage 命名空间，卸载即清除。

## 八、本地开发调试技巧

- 改完代码 → 打 zip → 应用内"导入本地插件包"覆盖安装（同 id 直接覆盖）；
- `ctx.log()` 输出在 WebView 控制台（开发版 F12 / 右键检查）；
- 卸载会清目录，重装即全新状态；storage 在 localStorage，键为 `st-plugin-<id>:*`。
