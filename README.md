# 小鲸鱼记账挂件（Alife 移植版）

把 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）
搬进 Alife：桌面上一只透明悬浮的小鲸鱼娘，帮你盯着 DeepSeek 账户余额，按轮次记账、
点击弹泡泡、拖拽吸附。

- **作者**：智乃乃
- **插件 ID**：`ZhinaiNai.WhaleWidget`
- **兼容**：Alife 客户端 4.x（插件主版本 4）
- **依赖**：`Alife.Function.FunctionCaller`；Python 包 `pywebview`（已在 `manifest.json` 的 `Environments.pip` 声明，同步插件环境时自动安装）

---

## 它做什么

| 能力 | 说明 |
|---|---|
| 余额显示 | 点击小鲸鱼弹出 DeepSeek 账户余额（走官方 `/user/balance`） |
| 每轮消耗 | **需要「Token用量看板」配合**，见下节；读取用量日志，每轮对话结束弹出「本轮花了多少」 |
| 记账与统计 | 今日已用、峰谷价、自定义单价、余额对账校正（原版记账内核原样保留） |
| 角色 / 泡泡 / 音效 | 自定义角色立绘、动图、点击泡泡文案、音效组（原版全部设置项都在） |
| 桌面交互 | 透明悬浮窗、水平拖拽吸附、竖直锁定、隐藏任务栏图标 |
| AI 自助控制 | 三个函数：重启 / 关闭 / 查询状态 |

---

## ⚠️ 「本轮消耗」气泡需要配合「Token用量看板」

原版挂件是靠宿主推送的**每轮真实用量事件**来算钱、弹「本轮消耗」气泡的。
Alife 里没有这个事件，唯一提供该数据的来源是 **[Token用量看板](https://github.com/1chuxin/1chuxin-Alife.TokenStats)（`1chuxin.TokenStats`，作者：初心）** ——
它把每轮真实用量（输入/输出/缓存命中/模型/来源）逐行写在：

```
{Storage}/Tokenlog/usage-log.jsonl
```

**所以：想看「本轮消耗」气泡，必须同时安装并激活 Token用量看板。**

没有它的话：

- 挂件照常启动、余额照常显示、记账/角色/泡泡/音效**全部正常**；
- 只有「本轮消耗」气泡不可用；
- 插件会在日志里明确告警，不会静默失败：

  ```
  小鲸鱼挂件：「本轮消耗」气泡需要「Token用量看板」（1chuxin.TokenStats）插件提供用量日志，
  当前未找到 {Storage}/Tokenlog/usage-log.jsonl —— 余额、记账、角色/泡泡/音效等其余功能不受影响。
  ```

顺带一提，装上之后两边**价格口径也是通的**：挂件优先读 Token用量看板的
`{Storage}/Tokenlog/pricing.json`，你在看板配置页调价，挂件自动跟随（读不到才回落内置价目表）。

### 安装顺序

1. 先装并激活 **Token用量看板**（它会开始写 `usage-log.jsonl`）；
2. 再装本插件；
3. 顺序反了也没关系 —— 挂件是**每次启动时**去查这个文件，之后补装看板、重启一下 Alife 即可。

---

## 安装

1. 在 Alife 的插件市场里搜索「小鲸鱼」安装，或手动把本插件文件夹放到 `{存储目录}/Plugins/ZhinaiNai.WhaleWidget/`。
2. 打开「系统管理 → 插件环境 → 同步环境」，等待 pip 依赖（`pywebview`）装好。
3. 编辑角色的 `index.json`，把 `WhaleWidget.WhaleWidgetModule` 加进 `Modules`。
4. **重启 Alife 客户端**（模块是随角色激活时构造的，热重载不会重新创建活动环境）。
5. 小鲸鱼会自动出现在屏幕右下角。

### 前置条件

- **Node.js 18+**：宿主服务（`host/server.mjs`）用它跑原版插件本体。
  没装的话插件不会启动悬浮窗，日志里会提示。
  装了但不在 PATH 里，可以在模块配置的「Node 路径」里填绝对路径。
- **WebView2 运行时**：悬浮窗用 Edge WebView2 渲染，Windows 10/11 通常已自带。

### 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| 启用挂件 | 开 | Alife 启动时自动拉起 |
| 宿主端口 | 54321 | 被占用时自动向后顺延 20 个 |
| 挂件缩放 | 1.5 | 显示大小 |
| Node 路径 | 空 | 留空用 PATH 里的 `node` |
| Python 路径 | 空 | 留空优先用 Alife 运行时自带的 Python，其次 PATH 里的 `python` |
| 宿主就绪超时 | 30 秒 | 超时则不再打开窗口 |

### 填 API key

菜单 → 小鲸鱼记账 → API 模型 → 新建/编辑模型 → 「API key」框。

密钥存在**用户目录** `~/.alife-whale/credentials.json`（权限 600），
**不进插件目录、不进配置文件、不进本仓库**。也可以改用环境变量 `WHALE_DS_KEY`（优先级更高）。

---

## 目录结构

```
ZhinaiNai.WhaleWidget/
├── manifest.json            # Alife 插件清单
├── WhaleWidgetModule.cs     # 模块：随 Alife 启停宿主服务与悬浮窗，提供 AI 函数
├── host/
│   ├── server.mjs           # 宿主壳：模拟原版需要的 DSH 服务，跑原版 lib/index.js
│   └── window.py            # 悬浮窗壳：pywebview + DWM 透明 + 区域裁剪
├── upstream/                # 原版源码（MIT，见 upstream/LICENSE 与 PROVENANCE.md），已打移植补丁
└── tools/
    └── apply-patches.mjs    # 上游更新后，一键重打全部补丁（带锚点断言）
```

## 工作方式

原版挂件是「DSH 网页插件」，靠宿主注入的 `webServer` / `credentials` / `connection` 服务
注册 23 条 `/dsh-whale/*` 路由。本移植**不改动原版逻辑**，而是：

1. `host/server.mjs` 提供这三个服务的本地实现（一个 127.0.0.1 上的 HTTP 服务）；
2. 原版 `lib/index.js` 原样加载运行，全部路由、记账内核、定价、泡泡逻辑照旧；
3. 唯一的桥接是**用量事件**：原版靠 DSH 推 `session/event` 算钱，Alife 没有这个事件，
   于是轮询 Alife 的 `usage-log.jsonl`，把新行翻译成原版认得的 `assistant/message`，
   并在 `speak`（AI 开口说话）后结算本轮 —— 定价表、峰谷、自定义单价、泡泡文案全部复用原版。

## 相对原版的改动

共 7 处，全部由 `tools/apply-patches.mjs` 维护，锚点找不到就报错退出：

**`lib/index.js`**
1. 优先读 Alife 侧定价文件 `{存储}/Tokenlog/pricing.json`（与用量看板口径一致），读不到回落内置价目表；
2. `priceFor()` 接入上面的定价表。

**`assets/whale-widget.js`**
3. 编辑已有 API 模型时不再过滤掉内置厂商模板（否则下拉空白 → 提交空 provider → 报「未知的厂商模板」）；
4. 厂商下拉兜底：当前 provider 不在候选里时补一项，避免显示空白；
5. 编辑态提交沿用原有 provider；
6. 7. 竖直锁定：挂件只做水平拖拽（竖直位置不动 → 窗口不跟着跑 → 设置弹窗永远有空间展开）。

**`host/window.py`**（本移植新写，非补丁）自包含了原版调试期打的两处运行时补丁：
窗体底色置黑 + DWM 玻璃（`DwmExtendFrameIntoClientArea(-1)`）实现真透明，以及 `SetWindowRgn`
区域裁剪让透明区穿透。原版曾把这两处打进 `webview/platforms/winforms.py`，
那会污染用户的 Python 环境、也无法随插件分发，这里改由插件自己完成。

---

## 上游更新怎么办

```bash
# 1) 用新版覆盖 upstream/（保留 host/、tools/、manifest.json、*.cs）
# 2) 重打补丁
node tools/apply-patches.mjs
# 3) 语法自检
node --check upstream/lib/index.js
node --check upstream/assets/whale-widget.js
```

补丁脚本对每处替换都有断言：锚点找不到或出现多次都会报错退出，
不会出现「以为打上了其实没打」的情况。详细排查步骤见 `docs/更新同步指南.md`。

## 已知限制

- 透明区域在部分 Windows 主题下仍可能吃掉鼠标事件（挡下方桌面点击），这是桌面挂件的通病。
- 「本轮消耗」气泡依赖 Token用量看板提供日志（见上文），未安装时该功能不可用。
- 用量日志里没有 `speak` 行的纯工具轮（AI 全程没开口的回合），靠 90 秒静默兜底结算。
  **这个 90 秒是刻意留长的，不要调短**：干活时一个脚本跑几十秒很正常，同一回合里两次
  LLM 调用之间本来就会有长间隔；调短会把同一轮拆成好几个泡泡、在还没干完时就弹账。
- DeepSeek 余额接口只有两位小数，单轮几分钱无法用「余额相减」验证，只适合长时段对账。

## 更新记录

### 4.0.2（2026-10-09）
撤销 4.0.1 里一处**由我误判导致的改动**，回归上游作者的原始设计。

- **撤销「无 speak 轮次 6 秒兜底」**：4.0.1 把无 speak 回合的静默兜底从 90 秒改成了 6 秒，
  理由是「纯工具轮靠 speak 结算永远等不到」。**这个判断是错的** —— 90 秒兜底一直都在正常工作，
  只是慢；而改成 6 秒会把**同一个回合拆成多个泡泡**（实测：同一回合里间隔 10 秒的两次 LLM 调用，
  原版合并成 1 个泡泡，6 秒版拆成 2 个），等于把「干活中途就弹账」这个老毛病又装了回去。
  现恢复 90 秒，并在代码注释里写明**不要调短**。

### 4.0.1（2026-10-09）
说明、依赖声明与鲁棒性更新，不改原版功能（其中「6 秒兜底」一项已在 4.0.2 撤销）。

- **明确「本轮消耗」气泡依赖 Token用量看板**：写进插件描述、模块描述、README 与插件日志告警，
  未安装时其余功能不受影响，不静默失败。
- **路径定位加固**：新增 `WHALE_STORAGE` 注入，用量日志与定价文件多一层插件目录相对推导兜底。
- **修复上游的一个真实缺陷**：上游发布脚本会把 `DATA_CANDIDATES_TAIL` 删空，
  而代码仍在取 `[0]`/`[1]` ⇒ 拼出 `undefined.dshw-usage.json` 这类字面量文件名并真的写进
  进程工作目录（即插件目录）。实测跑一会儿就会冒出这几个文件，现已补成真实兜底路径。
  补丁脚本共 **8 处**。

### 4.0.0（2026-10-09）
首个版本：把 DeepSeek-Balance-Whale-Widget（MIT）移植进 Alife。

## 许可

移植部分与插件壳：随本仓库分发。
原版代码 `upstream/**`：MIT（Copyright © 2026 MeteorNOX），见 `upstream/LICENSE`。
原版 `assets/` 下的美术素材**不在 MIT 覆盖范围内**，按「原样」随插件分发、仅供运行本插件使用，
详见 `upstream/PROVENANCE.md`。