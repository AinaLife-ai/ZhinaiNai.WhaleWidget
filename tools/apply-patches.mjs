// 对 upstream/ 里的原版源码重新打补丁。
//
// 用法：node tools/apply-patches.mjs
//
// 上游更新时：用新版覆盖 upstream/ 目录（保留 host/、tools/、manifest.json、*.cs），
// 然后跑一次本脚本即可。每处替换都带断言 —— 锚点找不到就报错退出，绝不静默跳过
// （静默跳过会让人以为补丁生效了，实际没有）。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const LIB = path.join(ROOT, 'upstream', 'lib', 'index.js')
const FRONT = path.join(ROOT, 'upstream', 'assets', 'whale-widget.js')

const results = []

function patch(file, label, from, to) {
  let text = fs.readFileSync(file, 'utf8')
  // 先判断是否已打过（补丁文本已在文件中），再找锚点 ——
  // 顺序反了会把锚点仍在的补丁重复应用一遍。
  if (text.includes(to)) { results.push(`[已打过] ${label}`); return }
  const count = text.split(from).length - 1
  if (count === 0) {
    throw new Error(`锚点未找到（上游可能已改动）: ${label}\n  文件: ${path.relative(ROOT, file)}`)
  }
  if (count > 1) throw new Error(`锚点不唯一（出现 ${count} 次）: ${label}`)
  fs.writeFileSync(file, text.replace(from, to), 'utf8')
  results.push(`[已应用] ${label}`)
}

// ============ lib/index.js ============

// ① 读取 Alife 侧定价文件，让挂件与用量看板口径一致
patch(LIB, 'lib: 定价文件读取器',
  `// 用户自定义单价（自定义 API 模型面板里填的「元/百万 token」），按 matchIds 子串匹配，优先于内置价目表
let CUSTOM_PRICES = {}`,
  `// ★ 移植补丁：优先读 Alife 侧定价文件（{Storage}/Tokenlog/pricing.json），
//   让挂件与 Alife 的用量看板口径一致；文件不存在或解析失败时回落到内置价目表。
//   路径由环境变量 WHALE_PRICING 注入（见 host/server.mjs），不写死任何机器路径。
const ALIFE_PRICING_FILE = process.env.WHALE_PRICING || ''
let LOCAL_PRICING = []
let localPricingAt = 0
function refreshLocalPricing() {
  if (!ALIFE_PRICING_FILE) return
  const now = Date.now()
  if (now - localPricingAt < 10000) return
  localPricingAt = now
  try {
    const doc = JSON.parse(fs.readFileSync(ALIFE_PRICING_FILE, 'utf8'))
    const out = []
    for (const r of (doc && doc.rules) || []) {
      const mk = String(r.modelMatch || '').trim().toLowerCase()
      if (!mk) continue
      const n = (v) => (isFinite(Number(v)) ? Number(v) : 0)
      out.push({
        key: mk,
        peak: r.peakEnabled !== false,
        table: {
          hit: [n(r.hitOff), n(r.hitPeak)],
          miss: [n(r.missOff), n(r.missPeak)],
          out: [n(r.outOff), n(r.outPeak)],
        },
      })
    }
    out.sort((a, b) => b.key.length - a.key.length)
    LOCAL_PRICING = out
  } catch (err) {
    LOCAL_PRICING = []
  }
}

// 用户自定义单价（自定义 API 模型面板里填的「元/百万 token」），按 matchIds 子串匹配，优先于内置价目表
let CUSTOM_PRICES = {}`)

patch(LIB, 'lib: priceFor 使用定价文件',
  `function priceFor(model) {
  const m = String(model || '').toLowerCase()
  // 自定义单价同样按键长降序匹配（与 customPriceMetaFor 保持一致）`,
  `function priceFor(model) {
  const m = String(model || '').toLowerCase()
  // ★ 移植补丁：Alife 定价文件优先（长键优先，避免短关键字误伤）
  refreshLocalPricing()
  for (const r of LOCAL_PRICING) if (r.key && m.indexOf(r.key) !== -1) return r.table
  // 自定义单价同样按键长降序匹配（与 customPriceMetaFor 保持一致）`)

// ⑧ 修复上游发布副本的「空候选表」缺陷。
//   上游的发布脚本 _strip-dev-paths.mjs 会把 DATA_CANDIDATES_TAIL 里的开发机路径删光，
//   于是这个数组变成 `[]`；但代码里仍然有 `DATA_CANDIDATES_TAIL[0] + '...'` 这种取用，
//   结果拼出字面量 `undefined.dshw-usage.json` —— 会被真的写到进程工作目录（也就是插件目录）。
//   实测症状：宿主跑一会儿，插件目录里冒出 undefined.dshw-turn.json / undefined.dshw-usage.json。
//   这里把空表补成一个真实可用的兜底路径（DSH_HOME 下的 profiles/web），
//   既保留原设计意图，又消除 undefined 前缀。
patch(LIB, 'lib: 修复空候选表导致的 undefined 文件名',
  `const DATA_CANDIDATES_TAIL = [
]`,
  `const DATA_CANDIDATES_TAIL = [
  // ★ 移植补丁：上游发布副本里这里原本是空数组（发布脚本删掉了开发机路径），
  //   而代码仍在取 DATA_CANDIDATES_TAIL[0]/[1] ⇒ 拼出字面量 "undefined.dshw-*.json"
  //   并真的写进进程工作目录。补成真实可用的兜底路径。
  path.join(DSH_HOME, 'profiles', 'web', path.sep),
  path.join(DSH_HOME, 'profiles', 'web', path.sep),
]`)

// ============ assets/whale-widget.js ============

// ② 内置厂商模板在「编辑已有模型」时不再被过滤掉
patch(FRONT, 'front: 编辑态保留内置厂商模板',
  '      if (apiTemplates[ti].builtin) continue',
  '      if (apiTemplates[ti].builtin && isNew) continue')

// ③ 下拉兜底：当前 provider 不在候选里时补一项，避免 select 空白 + 提交空值
patch(FRONT, 'front: 厂商下拉兜底',
  `    var tplSel = apiSelectEl(tplOpts, isNew ? 'openrouter' : m.provider)
    if (!isNew) tplSel.disabled = true`,
  `    var tplSel = apiSelectEl(tplOpts, isNew ? 'openrouter' : m.provider)
    // ★ 移植补丁：编辑态若下拉里没有当前 provider 的选项，补一项并重新设值，
    //   否则 select 显示空白、提交时 provider 为空 → 后端报「未知的厂商模板」。
    if (!isNew && String(tplSel.value) !== String(m.provider)) {
      var oFix = document.createElement('option')
      var tFix = null
      for (var tf = 0; tf < apiTemplates.length; tf++) if (apiTemplates[tf].id === m.provider) { tFix = apiTemplates[tf]; break }
      oFix.value = String(m.provider)
      oFix.textContent = tFix ? String(tFix.name || tFix.id) : String(m.provider)
      tplSel.insertBefore(oFix, tplSel.firstChild)
      tplSel.value = String(m.provider)
    }
    if (!isNew) tplSel.disabled = true`)

// ④ 编辑态提交时沿用原有 provider
patch(FRONT, 'front: 编辑态 provider 取值',
  '          provider: tplSel.value,',
  '          provider: isNew ? tplSel.value : ((m && m.provider) || tplSel.value),')

// ⑤ 竖直锁定：挂件只做水平拖拽
//    （竖直位置不动 → 窗口不跟着跑 → 设置弹窗永远有空间展开）
patch(FRONT, 'front: 竖直锁定（拖动中）',
  '  state.top = clampWidgetTop(drag.origTop + dy, Math.max(0, drag.vp.h - drag.h))',
  '  state.top = drag.origTop')

patch(FRONT, 'front: 竖直锁定（松手）',
  '  var top = clampWidgetTop(drag.origTop + dy, Math.max(0, drag.vp.h - drag.h))',
  '  var top = drag.origTop')

console.log(results.join('\n'))
console.log(`\n共 ${results.filter((r) => r.startsWith('[已应用]')).length} 处新应用，` +
  `${results.filter((r) => r.startsWith('[已打过]')).length} 处原本已打过。`)