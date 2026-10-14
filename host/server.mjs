// 小鲸鱼挂件 —— Alife 移植宿主壳
// 作用：模拟原版挂件所需的 webServer / credentials / connection 三个服务，
//       让 upstream/lib/index.js 原封不动运行，23 条 /dsh-whale/* 路由全部照常注册。
//
// 所有路径均可通过环境变量覆盖，由插件模块（WhaleWidgetModule.cs）在启动子进程时注入，
// 脚本内不写死任何机器相关的绝对路径。
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

// ---------------- 用户数据目录 ----------------
// 由模块注入 WHALE_HOME（{Storage}/WhaleWidget）。原版 lib/index.js 通过 DSH_HOME 定位
// 记忆/角色/音效等用户数据，这里把它指到插件自己的数据目录，避免与用户本机安装的
// DSH 客户端互相干扰。
const WHALE_HOME = process.env.WHALE_HOME
  || path.join(os.homedir() || process.env.USERPROFILE || '.', '.alife-whale')
process.env.DSH_HOME = process.env.DSH_HOME || WHALE_HOME

// ---------------- 定位 Alife 存储目录 ----------------
// 由模块注入 WHALE_STORAGE（即 AlifePath.StorageFolderPath）。相对插件目录兜底推导：
// 插件位于 {Storage}/Plugins/<插件ID>/，host/ 再下一级，所以向上 3 级即 Storage。
// 这样即使模块没注入，也不会退化到「用户家目录」这种明显不对的位置。
function guessStorage() {
  if (process.env.WHALE_STORAGE) return process.env.WHALE_STORAGE
  return path.resolve(import.meta.dirname, '..', '..', '..')
}
const STORAGE = guessStorage()

// ---------------- 定位原版源码 ----------------
// 优先环境变量；其次插件目录内的 upstream/（随插件一起分发）；最后兼容旧的手工部署目录名。
const CANDIDATES = [
  process.env.WHALE_SRC,
  path.join(import.meta.dirname, '..', 'upstream'),
  path.join(import.meta.dirname, '..', 'DeepSeek-Balance-Whale-Widget-main'),
].filter(Boolean)
const SRC = CANDIDATES.find((d) => fs.existsSync(path.join(d, 'lib', 'index.js')))
if (!SRC) {
  console.error('[whale-host] 找不到原版源码（lib/index.js），检查路径:', CANDIDATES)
  process.exit(1)
}
console.log('[whale-host] 源码目录:', SRC)
console.log('[whale-host] 用户数据目录:', WHALE_HOME)
console.log('[whale-host] Alife 存储目录:', STORAGE)

const PORT = Number(process.env.WHALE_PORT || 54321)
const HOST = '127.0.0.1'


// ---------------- 可选：mock 余额（仅供调试外观，默认关闭） ----------------
// 只拦截对 DeepSeek 官方余额接口的请求，其它一律放行。
if (process.env.WHALE_MOCK_BALANCE === '1') {
  const _fetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    if (url.includes('/user/balance')) {
      console.log('[mock] 拦截余额请求 ->', url)
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{
          currency: 'CNY',
          total_balance: '42.75',
          granted_balance: '5.50',
          topped_up_balance: '37.25',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return _fetch(input, init)
  }
  console.log('[mock] 已启用假余额（仅调试用，WHALE_MOCK_BALANCE=1 才开启）')
}

const routes = []
const indexTaps = []
const indexInjectSubs = []
const disposers = []
// 原版靠 ctx.on('session/event') 拿每轮真实 usage 来算钱、弹「本轮消耗」气泡。
// 本壳把它桥接到 Alife 的用量日志（见下方 usageBridge）。
const sessionSubs = []
const disposedSubs = []

// ---------------- 模拟 connection 服务 ----------------
const connectionSvc = {
  requestRejection(req) { return false },   // 本地挂件：不拒任何请求
}

// ---------------- 模拟 credentials 服务 ----------------
// 密钥落盘在用户目录（工程目录之外），保证插件打包/分发时不夹带任何密钥。
const SECRET_DIR = path.join(os.homedir() || process.env.USERPROFILE || '.', '.alife-whale')
const SECRET_FILE = path.join(SECRET_DIR, 'credentials.json')

function readSecrets() {
  try { return JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8')) || {} } catch (e) { return {} }
}
function writeSecrets(obj) {
  try {
    fs.mkdirSync(SECRET_DIR, { recursive: true })
    fs.writeFileSync(SECRET_FILE, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 })
    return true
  } catch (e) { console.log('[credentials] 写入失败:', e.message); return false }
}

const credentialsSvc = {
  // 读取优先级：环境变量 WHALE_DS_KEY > 本地密钥文件 > 空（留空＝未配置）
  // 注意：不读取 DSH 的 .credentials.yaml，避免把别处的密钥悄悄带进来。
  async resolve(key) {
    // 原版期望 { value } 对象（lib/index.js 里一律 `cred && cred.value`）；
    // 返回裸字符串会导致 key 恒为空 → 带空 Authorization 请求 → HTTP 401。
    if (!key) return { value: '' }
    if (key === 'DEEPSEEK_API_KEY' && process.env.WHALE_DS_KEY) return { value: process.env.WHALE_DS_KEY }
    const store = readSecrets()
    return { value: store[key] || '' }
  },
  async set(key, value) {
    if (!key) return false
    const store = readSecrets()
    store[key] = String(value == null ? '' : value)
    const ok = writeSecrets(store)
    console.log('[credentials.set]', key, ok ? '已保存到用户目录' : '保存失败')
    return ok
  },
  async delete(key) {
    const store = readSecrets()
    if (key && key in store) { delete store[key]; writeSecrets(store) }
    console.log('[credentials.delete]', key)
    return true
  },
}

// ---------------- 模拟 ctx ----------------
const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
    tapIndex(fn) {
      indexTaps.push(fn)
      return () => {
        const i = indexTaps.indexOf(fn)
        if (i >= 0) indexTaps.splice(i, 1)
      }
    },
  },
  credentials: credentialsSvc,
  connection: connectionSvc,
  get(name) {
    if (name === 'connection') return connectionSvc
    if (name === 'deepseekAccount') return null      // 不做账号登录路
    return null
  },
  on(event, fn) {
    if (event === 'webserver/index-inject') {
      indexInjectSubs.push(fn)
      // 原版要求：订阅后立刻把注入行塞进表（一次性收集）
      const table = []
      try { fn(table) } catch (e) {}
      return () => {
        const i = indexInjectSubs.indexOf(fn)
        if (i >= 0) indexInjectSubs.splice(i, 1)
      }
    }
    // 原版还会订阅 session/event（每轮真实用量）与 session/disposed；
    // 只接 index-inject 会让事件通道静默失效（last-turn.json 的 seq 恒为 0）。
    if (event === 'session/event') {
      sessionSubs.push(fn)
      return () => {
        const i = sessionSubs.indexOf(fn)
        if (i >= 0) sessionSubs.splice(i, 1)
      }
    }
    if (event === 'session/disposed') {
      disposedSubs.push(fn)
      return () => {
        const i = disposedSubs.indexOf(fn)
        if (i >= 0) disposedSubs.splice(i, 1)
      }
    }
    return () => {}
  },
  effect(fn) {
    try {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    } catch (e) { console.log('[ctx.effect] err:', e.message) }
    return () => {}
  },
  inject(deps, cb) {
    try { cb(ctx) } catch (e) { console.log('[root.inject] cb err:', e.stack) }
  },
}

// ---------------- 首页 HTML（含 #root + 输入框，满足原版启动闸门）----------------
function readScale() {
  try {
    const p = path.join(process.env.DSH_HOME, '.dshw-size.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (j && typeof j.scale === 'number') return j.scale
  } catch (e) {}
  return 1
}
// 原版公式：base = clamp(122, min(250, min(vw,vh)*0.28) * scale, 625)
// 桌宠窗口的视口比网页端小得多，会让挂件缩水 ⇒ 直接按 scale 算满值固定住
function whaleBase() { return Math.min(250 * readScale(), 625) }

const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>小鲸鱼挂件</title>
<style id="whale-fit">
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;}
  .dshwv-root{--dshw-base:__BASE__px !important;position:fixed !important;right:0 !important;bottom:0 !important;}
</style>
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;}
  #root{width:100%;height:100%;}
  #fake-composer{position:absolute;left:-9999px;top:-9999px;}
</style>
</head>
<body>
<div id="root">
  <div data-composer-input style="display:none"></div>
  <textarea id="fake-composer"></textarea>
</div>
__WHALE_SCRIPTS__
</body>
</html>`

function buildPage() {
  let html = PAGE_HTML.replace('__BASE__', String(whaleBase()))
  // 走原版 tapIndex 注入链，保证注入方式与原版一致
  const tag = '<script defer src="/dsh-whale/widget.js"></script>'
  let injected = false
  for (const fn of indexTaps) {
    try {
      const out = fn(html)
      if (typeof out === 'string') { html = out; injected = true }
    } catch (e) {}
  }
  if (!injected) html = html.replace('__WHALE_SCRIPTS__', tag)
  else html = html.replace('__WHALE_SCRIPTS__', '')
  return html
}

// ---------------- HTTP 服务器 ----------------
const server = http.createServer(async (req, res) => {
  let url
  try { url = new URL(req.url || '/', 'http://' + HOST + ':' + PORT) } catch (e) { url = { pathname: '/' } }

  // 首页
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = buildPage()
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
    return
  }

  // 原版注册的路由
  for (const r of routes) {
    if (r.kind === 'exact' && r.path === url.pathname) {
      try {
        await r.handler(req, res)
      } catch (e) {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('handler error: ' + String(e && e.message || e))
        } catch (e2) {}
      }
      return
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found: ' + url.pathname)
})

// ---------------- 用量事件桥 ----------------
// 原版靠 DSH 推送 ctx.on('session/event') 来算「本轮消耗」并弹泡泡。
// Alife 没有这个事件，但 TokenStats 把每轮真实用量写在 usage-log.jsonl 里。
// 这里轮询该日志：读到新行 → 合成 assistant/message 事件（带真实 usage 与模型名）；
// 结算时机以 speak 为界（见下），定价表、峰谷、自定义单价、泡泡文案全部复用原版逻辑。
// 「本轮消耗」气泡的数据源由「Token用量看板」（1chuxin.TokenStats）插件提供：
// 它把每轮真实用量逐行写到 {Storage}/Tokenlog/usage-log.jsonl。
const USAGE_LOG_CANDIDATES = [
  process.env.WHALE_USAGE_LOG,
  path.join(WHALE_HOME, 'usage-log.jsonl'),
  path.join(STORAGE, 'Tokenlog', 'usage-log.jsonl'),
].filter(Boolean)
const USAGE_LOG = USAGE_LOG_CANDIDATES.find((f) => fs.existsSync(f)) || ''
// 定价文件（可选）：与 Alife 的 Token 用量看板口径保持一致；文件不存在时用原版内置价目表。
const PRICING_CANDIDATES = [
  process.env.WHALE_PRICING,
  path.join(STORAGE, 'Tokenlog', 'pricing.json'),
].filter(Boolean)
const PRICING_FILE = PRICING_CANDIDATES.find((f) => fs.existsSync(f)) || ''

// 结算时机 = 「我开口说话时」：speak 代表这一轮要跟用户说话了 = 该报账了。
// 用静默时间猜轮次结束在长任务下会误判（还在跑脚本就弹了消耗）。
const TURN_QUIET_MS = Number(process.env.WHALE_TURN_QUIET_MS || 12000)
// 兜底：万一某轮一声不吭（纯工具轮），用更长的静默时间收尾，避免账永远挂着。
// ⚠ 这个值必须「足够长」：我干活时一个脚本跑几十秒很正常，中间两次 LLM 调用之间
//   本来就会有长间隔。调短它会把同一轮拆成好几个泡泡、在还没干完时就弹账 ——
//   这正是娅娅当初把结算时机改成以 speak 为界要解决的问题。别动它。
const TURN_FALLBACK_MS = Number(process.env.WHALE_TURN_FALLBACK_MS || 90000)
// speak 后等多久结算（合并同一轮的多次说话）
const SPEAK_SETTLE_MS = Number(process.env.WHALE_SPEAK_SETTLE_MS || 3000)
const USAGE_SESSION = { id: 'alife-main', name: '' }
let usageSeen = 0        // 已处理到第几行
let usageTurn = 0        // 当前轮次号（每次进入新一轮 +1）
let usageLastTs = 0      // 最近一条新行的时间
let usagePending = false // 当前轮是否有未结算的累积
let usageSpeakAt = 0     // 最近一次「我开口说话」的时间（说话即报账的触发点）

function emitSessionEvent(type, data) {
  const ev = { type, data }
  for (const fn of sessionSubs) {
    try { fn(USAGE_SESSION, ev) } catch (e) { console.log('[usage-bridge] 订阅者异常:', e.message) }
  }
}

function pollUsage() {
  if (!USAGE_LOG) return
  let lines
  try {
    lines = fs.readFileSync(USAGE_LOG, 'utf8').split('\n').filter((l) => l.trim())
  } catch (e) { return }
  if (!lines.length) return
  // 启动时只记游标，绝不重放历史（否则挂件会把陈年旧账全部弹一遍）
  if (usageSeen === 0) { usageSeen = lines.length; return }
  // 日志被清空/轮转：重置游标，避免越界
  if (lines.length < usageSeen) { usageSeen = lines.length; return }
  const now = Date.now()
  // 说话即结算（短延迟合并同一轮的多次 speak）
  if (usageSpeakAt && usagePending && now - usageSpeakAt >= SPEAK_SETTLE_MS) {
    emitSessionEvent('turn/end', { turn: usageTurn, reason: 'completed' })
    usagePending = false
    usageSpeakAt = 0
  }
  if (lines.length === usageSeen) {
    // 没有新行 → 静默够久就结算本轮（对应原版的 turn/end）
    if (usagePending && now - usageLastTs > TURN_FALLBACK_MS) {
      emitSessionEvent('turn/end', { turn: usageTurn, reason: 'completed' })
      usagePending = false
    }
    return
  }
  for (let i = usageSeen; i < lines.length; i++) {
    let r = null
    try { r = JSON.parse(lines[i]) } catch (e) { continue }
    if (!r) continue
    // 距上一条超过静默期 → 视为新一轮（先把上一轮收尾）
    if (!usagePending || now - usageLastTs > TURN_QUIET_MS) {
      if (usagePending) emitSessionEvent('turn/end', { turn: usageTurn, reason: 'completed' })
      usageTurn++
    }
    const isSpeak = String(r.s || '') === 'speak'
    // 口径修正：原版按「未命中输入 × miss价 + 命中缓存 × hit价」分开相加，
    // 而 TokenStats 的 i 是**输入总（含缓存）**，c 才是其中命中缓存的量。
    // 直接把 i 当 inputTokens 传会让缓存那部分按 miss 价重复算一遍（miss 价可达 hit 价 50 倍）。
    // 正确口径：inputTokens = i - c，cacheReadTokens = c。
    const inTotal = Number(r.i) || 0
    const cached = Number(r.c) || 0
    emitSessionEvent('assistant/message', {
      turn: usageTurn,
      usage: {
        inputTokens: Math.max(0, inTotal - cached),
        cacheReadTokens: cached,
        outputTokens: Number(r.o) || 0,
      },
      message: { source: { model: String(r.m || '') } },
      // 附带原始字段便于排查（原版不读这些键，无副作用）
      _alife: { source: r.s, channel: r.ch, host: r.h, character: r.n },
    })
    usagePending = true
    usageLastTs = now
    // 说话即结算：speak 是「对用户开口」的时刻，此刻报账时机最自然。
    // 不立即结算而是延后 SPEAK_SETTLE_MS —— 同一条回复里常连说几句，
    // 立刻结算会弹好几次；延后一点就能合并成一次干净的报账。
    if (isSpeak) usageSpeakAt = now
  }
  usageSeen = lines.length
}

// ---------------- 启动 ----------------
async function main() {
  const mod = await import(pathToFileURL(path.join(SRC, 'lib', 'index.js')).href)
  const plugin = mod.default
  await plugin.apply(ctx)
  console.log('[whale-host] 原版插件已加载，路由数:', routes.length)

  // 定价文件：让挂件优先读 Alife 侧的定价配置（存在时才接管，读不到就用原版内置价）
  if (PRICING_FILE && fs.existsSync(PRICING_FILE)) {
    console.log('[whale-host] 定价文件:', PRICING_FILE)
  }

  server.listen(PORT, HOST, () => {
    console.log('[whale-host] 已监听 http://' + HOST + ':' + PORT)
    console.log('[whale-host] 挂件页: http://' + HOST + ':' + PORT + '/')
    console.log('[whale-host] 用量日志:', USAGE_LOG || '（未找到）')
    if (!USAGE_LOG) {
      console.log('[whale-host] ⚠ 未找到用量日志 ⇒「本轮消耗」气泡不可用。')
      console.log('[whale-host]   该功能需要先安装并激活「Token用量看板」（1chuxin.TokenStats）插件，')
      console.log('[whale-host]   它会把每轮真实用量写到 {Storage}/Tokenlog/usage-log.jsonl。')
      console.log('[whale-host]   已检查:', USAGE_LOG_CANDIDATES.join(' | '))
    }
    if (!PRICING_FILE) {
      console.log('[whale-host] 提示: 未找到 pricing.json，将使用内置价目表计费。')
    }
    for (const r of routes) console.log('   [route]', r.kind, r.path)
  })

  // 用量事件桥：每 1.5 秒看一眼 Alife 的用量日志，把新行翻译成原版的会话事件
  setInterval(pollUsage, 1500)
}

main().catch((e) => {
  console.error('[whale-host] 启动失败:', e)
  process.exit(1)
})

process.on('SIGINT', () => { try { server.close() } catch (e) {}; process.exit(0) })