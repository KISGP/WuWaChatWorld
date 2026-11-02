// World 背景资料管线（全自动）：库街区 wiki API 下载（缓存 .cache/）→ 切块 → LLM 场景摘要 → world.json
// 零依赖，Node 18+。用法：
//   node .script/build-index.mjs                 # 全流程：增量下载 + 摘要 + 索引
//   node .script/build-index.mjs --no-llm        # 只下载切块建索引（调试结构）
//   node .script/build-index.mjs --refresh       # 强制重下全部剧情（忽略缓存）
//   node .script/build-index.mjs --out <file> --concurrency 8
// 下载缓存在 .cache/story/<entryId>.json（不入库）；摘要增量缓存在 .cache/summaries.json
// （键＝分类/任务名#场景序号；旧剧情不改只新增，未变场景直接复用；每生成 50 条落盘一次，
//   中断后重跑从断点继续；缓存丢失只是退化为全量重跑）。
// 词条读仓库根目录 名词解释.md（一行一条「词条：定义」）。
// 摘要模型配置读同目录 .env（API_BASE / API_KEY / MODEL，chat-completions 兼容端点）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CACHE_STORY_DIR = path.join(ROOT, '.cache', 'story')
const CACHE_SUMMARIES_FILE = path.join(ROOT, '.cache', 'summaries.json')
const GLOSSARY_FILE = path.join(ROOT, '名词解释.md')
const OUT_DEFAULT = path.join(ROOT, 'world.json')

// ---------- 库街区 wiki API（匿名，POST 表单） ----------
const KURO_API = 'https://api.kurobbs.com'
const KURO_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  source: 'h5',
  wiki_type: '9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
}
const DOWNLOAD_GAP_MS = 300
const HTTP_RETRY_DELAYS_MS = [3_000, 8_000, 20_000]
const ROOT_CATALOGUE_NAME = '剧情合集'

// ---------- 摘要生成 ----------
const SUMMARY_CHECKPOINT_EVERY = 50 // 每生成 N 条落盘一次缓存，中断后重跑从断点继续

const SUMMARY_SYSTEM_PROMPT = [
  '你为游戏《鸣潮》的剧情检索库生成场景摘要。输入是一个场景的对话原文，你输出一段 50~100 字的话题摘要：这段对话里是谁、在哪、发生了什么、结果如何。',
  '要求：',
  '- 用第三人称、话题语言概括，把台词口语转写为可检索的话题词（人物名、地名、事件名、物品名）。',
  '- 不复述台词原文，不加「摘要：」等前缀，不使用引号、列表或换行。',
  '- 只输出摘要正文，50~100 字，一段纯文本。'
].join('\n')
const SUMMARY_MAX_TOKENS = 300
const SUMMARY_TEMPERATURE = 0.3
const SUMMARY_MIN_TEXT_LEN = 30 // 正文不足此长度的场景跳过摘要（近乎空的战斗场景，无检索价值）
const SCENE_INPUT_HEAD = 6000
const SCENE_INPUT_TAIL = 1500
const LLM_TIMEOUT_MS = 120_000
const LLM_RETRY_DELAYS_MS = [3_000, 8_000, 20_000]

// ---------- 参数 ----------
function parseArgs(argv) {
  const args = { out: OUT_DEFAULT, noLlm: false, refresh: false, concurrency: 8 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--no-llm') args.noLlm = true
    else if (arg === '--refresh') args.refresh = true
    else if (arg === '--out') args.out = path.resolve(ROOT, argv[++i])
    else if (arg === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || 8)
    else {
      console.error(`未知参数：${arg}`)
      process.exit(2)
    }
  }
  return args
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return {}
  const env = {}
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

// entryId 超过 Number.MAX_SAFE_INTEGER，先字符串化再 parse
function parseLossless(text) {
  return JSON.parse(text.replace(/"(entryId|id)":(\d{15,})/gu, '"$1":"$2"'))
}

async function kuroPost(pathname, body) {
  let lastError = null
  for (let attempt = 0; attempt <= HTTP_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const res = await fetch(`${KURO_API}${pathname}`, {
        method: 'POST',
        headers: KURO_HEADERS,
        body: body ?? '',
        signal: AbortSignal.timeout(60_000)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = parseLossless(await res.text())
      if (json.code !== 200) throw new Error(`业务码 ${json.code}：${json.msg}`)
      return json.data
    } catch (error) {
      lastError = error
      if (attempt < HTTP_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, HTTP_RETRY_DELAYS_MS[attempt]))
      }
    }
  }
  throw lastError
}

// ---------- 下载与缓存 ----------
async function fetchStoryPlan() {
  const tree = await kuroPost('/wiki/core/catalogue/config/getTree')
  const find = (nodes, name) => {
    for (const node of nodes || []) {
      if (node.name === name) return node
      const hit = find(node.children, name)
      if (hit) return hit
    }
    return null
  }
  const root = find([tree], ROOT_CATALOGUE_NAME)
  if (!root) throw new Error(`目录树中找不到「${ROOT_CATALOGUE_NAME}」`)
  const plan = []
  for (const node of (root.children || []).filter((c) => /任务剧情$/u.test(c.name))) {
    const category = node.name.replace(/剧情$/u, '')
    const records = []
    for (let page = 1; ; page += 1) {
      const data = await kuroPost(
        '/wiki/core/catalogue/item/getPage',
        `catalogueId=${node.id}&page=${page}&limit=1000`
      )
      const batch = data?.results?.records || []
      records.push(...batch)
      const total = data?.results?.total ?? records.length
      if (batch.length === 0 || records.length >= total) break
    }
    // 列表按新到旧排序，反转为章节自然序（旧→新）
    const entries = records
      .reverse()
      .map((record) => ({
        title: String(record.content?.title || record.name || '').trim(),
        entryId: String(record.entryId || record.content?.linkConfig?.entryId || '')
      }))
      .filter((item) => item.title && item.entryId)
    plan.push({ category, entries })
  }
  return plan
}

async function loadStoryDetail(entry, refresh, counters) {
  const file = path.join(CACHE_STORY_DIR, `${entry.entryId}.json`)
  if (!refresh && fs.existsSync(file)) {
    counters.cached += 1
    return parseLossless(fs.readFileSync(file, 'utf8'))
  }
  const data = await kuroPost('/wiki/core/catalogue/item/getEntryDetail', `id=${entry.entryId}`)
  fs.mkdirSync(CACHE_STORY_DIR, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data), 'utf8')
  counters.downloaded += 1
  await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GAP_MS))
  return data
}

// ---------- 详情 → 场景切块 ----------
const ENTITIES = {
  '&mdash;': '—', '&ndash;': '–', '&nbsp;': ' ', '&amp;': '&',
  '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
  '&ldquo;': '“', '&rdquo;': '”', '&lsquo;': '‘', '&rsquo;': '’', '&hellip;': '…'
}

function htmlToLines(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/p>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/&mdash;|&ndash;|&nbsp;|&amp;|&lt;|&gt;|&quot;|&apos;|&#39;|&ldquo;|&rdquo;|&lsquo;|&rsquo;|&hellip;|&#(\d+);/gu,
      (m, num) => (num ? String.fromCodePoint(Number(num)) : ENTITIES[m] || m))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !/^[^：:]{1,12}[：:]$/u.test(line)) // 说话人冒号空占位行过滤
}

// 对话树按 pid DFS 展开；v1 为 flow.raw 数组，v2 为 flow.data 按 id 的对象表。
// 带 title 的子节点是玩家选项，输出加「漂泊者：」前缀；根节点 title 是场景标签，不输出；共享子树只保留一次
function normalizeFlowNodes(flow) {
  if (Array.isArray(flow && flow.raw)) return flow.raw
  if (flow && flow.data && typeof flow.data === 'object') return Object.values(flow.data)
  return []
}

function flattenFlow(flow) {
  const raw = normalizeFlowNodes(flow)
  const childrenOf = new Map()
  const hasParent = new Set()
  const isRoot = (node) => node.isRoot === true || !(node.pid || []).some((pid) => pid !== '' && pid != null)
  for (const node of raw) {
    for (const pid of node.pid || []) {
      if (pid === '' || pid == null) continue
      if (!childrenOf.has(String(pid))) childrenOf.set(String(pid), [])
      childrenOf.get(String(pid)).push(node)
      hasParent.add(String(node.id))
    }
  }
  const seen = new Set()
  const lines = []
  const emit = (node, root) => {
    if (seen.has(String(node.id))) return
    seen.add(String(node.id))
    const title = String(node.title || '').trim()
    if (title && !root) lines.push(title.startsWith('漂泊者') ? title : `漂泊者：${title}`)
    lines.push(...htmlToLines(node.content))
  }
  const walk = (node, root) => {
    emit(node, root)
    for (const child of childrenOf.get(String(node.id)) || []) walk(child, false)
  }
  for (const node of raw.filter((n) => isRoot(n) || !hasParent.has(String(n.id)))) walk(node, true)
  for (const node of raw) emit(node, false) // 环/断链兜底，按原序补上
  return lines
}

function convertDetail(detail, category) {
  const content = detail?.content || {}
  const story = content.story || {}
  const task = String(content.title || '').trim()
  const scenes = []
  let emptyScenes = 0
  for (const module of content.modules || []) {
    const title = String(module.title || '').trim()
    const lines = []
    for (const comp of module.components || []) {
      const flow = story[comp.idx]
      if (flow && flow.flow) lines.push(...flattenFlow(flow.flow))
    }
    if (!title) continue
    if (lines.length === 0) {
      emptyScenes += 1 // 仅标题无正文的空场景丢弃
      continue
    }
    // cacheKey 为摘要缓存的临时键（分类/任务名#任务内序号），写索引前删除
    scenes.push({ category, task, title, summary: '', text: lines.join('\n'), cacheKey: `${category}/${task}#${scenes.length}` })
  }
  return { task, scenes, emptyScenes }
}

// ---------- 词条 ----------
function parseGlossaryMd(content) {
  const entries = []
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const at = line.search(/[：:]/u)
    if (at <= 0) continue // 无冒号行不构成词条
    entries.push({ term: line.slice(0, at).trim(), definition: line.slice(at + 1).trim() })
  }
  return entries
}

// ---------- 摘要生成 ----------
function buildSummaryUserContent(scene) {
  const text = scene.text.length > SCENE_INPUT_HEAD + SCENE_INPUT_TAIL
    ? `${scene.text.slice(0, SCENE_INPUT_HEAD)}\n……（中略）……\n${scene.text.slice(-SCENE_INPUT_TAIL)}`
    : scene.text
  return `分类：${scene.category}\n任务：${scene.task}\n场景：${scene.title}\n正文：\n${text}`
}

function cleanSummary(text) {
  return text
    .replace(/^(摘要|概述|前言|场景摘要)\s*[：:]\s*/u, '')
    .replace(/^[「『"'“]+/u, '')
    .replace(/[」』"'”]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

async function callChat(env, userContent) {
  const res = await fetch(`${env.API_BASE.replace(/\/+$/u, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.API_KEY}` },
    body: JSON.stringify({
      model: env.MODEL,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: SUMMARY_TEMPERATURE,
      max_tokens: SUMMARY_MAX_TOKENS
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('空补全')
  return content
}

async function generateSummaries(scenes, env, concurrency, cache, cacheFile) {
  const targets = scenes.filter((scene) => scene.summaryTarget)
  let done = 0
  let saved = 0
  const failures = []
  let cursor = 0
  const runners = Array.from({ length: concurrency }, async () => {
    while (cursor < targets.length) {
      const scene = targets[cursor++]
      let lastError = null
      for (let attempt = 0; attempt <= LLM_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          scene.summary = cleanSummary(await callChat(env, buildSummaryUserContent(scene)))
          cache[scene.cacheKey] = scene.summary
          saved += 1
          if (saved % SUMMARY_CHECKPOINT_EVERY === 0) {
            fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8')
            console.log(`[摘要] 缓存已落盘 ${saved} 条`)
          }
          lastError = null
          break
        } catch (error) {
          lastError = error
          if (attempt < LLM_RETRY_DELAYS_MS.length) {
            await new Promise((resolve) => setTimeout(resolve, LLM_RETRY_DELAYS_MS[attempt]))
          }
        }
      }
      if (lastError) failures.push(`${scene.category}/${scene.task}/${scene.title}: ${lastError.message}`)
      done += 1
      if (done % 50 === 0 || done === targets.length) console.log(`[摘要] ${done}/${targets.length}`)
    }
  })
  await Promise.all(runners)
  return failures
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv.slice(2))

  console.log('[下载] 拉取目录与任务列表…')
  const plan = await fetchStoryPlan()
  const counters = { downloaded: 0, cached: 0 }
  const story = []
  const failedEntries = []
  for (const { category, entries } of plan) {
    let scenes = 0
    for (const entry of entries) {
      try {
        const detail = await loadStoryDetail(entry, args.refresh, counters)
        const converted = convertDetail(detail, category)
        scenes += converted.scenes.length
        story.push(...converted.scenes)
      } catch (error) {
        failedEntries.push(`${category}/${entry.title}（entryId=${entry.entryId}）：${error.message}`)
      }
    }
    console.log(`[切块] ${category}：${entries.length} 任务，${scenes} 场景`)
  }
  for (const failure of failedEntries) console.error(`[下载失败] ${failure}`)
  console.log(`[下载] 新下 ${counters.downloaded}，缓存命中 ${counters.cached}；场景共 ${story.length} 个`)

  let glossary = []
  if (fs.existsSync(GLOSSARY_FILE)) {
    glossary = parseGlossaryMd(fs.readFileSync(GLOSSARY_FILE, 'utf8'))
    console.log(`[词条] ${GLOSSARY_FILE}：${glossary.length} 条`)
  } else {
    console.warn(`[词条] 未找到 ${GLOSSARY_FILE}，索引将不含词条`)
  }

  let failures = []
  if (!args.noLlm) {
    const env = loadEnv(path.join(__dirname, '.env'))
    for (const key of ['API_BASE', 'API_KEY', 'MODEL']) {
      if (!env[key]) {
        console.error(`[错误] .script/.env 缺少 ${key}（参考 .env.example），或用 --no-llm 跳过摘要`)
        process.exit(1)
      }
    }
    let summaryCache = {}
    if (fs.existsSync(CACHE_SUMMARIES_FILE)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(CACHE_SUMMARIES_FILE, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) summaryCache = parsed
        else throw new Error('缓存不是对象')
      } catch {
        console.warn('[摘要] 摘要缓存损坏，按空缓存处理（本次将重新生成全部摘要）')
      }
    }
    const targets = story.filter((scene) => scene.text.length >= SUMMARY_MIN_TEXT_LEN)
    const skipped = story.length - targets.length
    if (skipped > 0) console.log(`[摘要] 跳过正文不足 ${SUMMARY_MIN_TEXT_LEN} 字的场景 ${skipped} 个`)
    const toGenerate = targets.filter((scene) => !summaryCache[scene.cacheKey])
    for (const scene of toGenerate) scene.summaryTarget = true
    for (const scene of targets) {
      if (!scene.summaryTarget) scene.summary = summaryCache[scene.cacheKey]
    }
    console.log(`[摘要] 缓存复用 ${targets.length - toGenerate.length}，新生成 ${toGenerate.length}，模型 ${env.MODEL}，并发 ${args.concurrency}`)
    failures = await generateSummaries(story, env, args.concurrency, summaryCache, CACHE_SUMMARIES_FILE)
    for (const failure of failures) console.error(`[摘要失败] ${failure}`)
    // 断点已随生成落盘，这里补写尾部不足 50 条的部分；失败的下次重跑再生成
    fs.mkdirSync(path.dirname(CACHE_SUMMARIES_FILE), { recursive: true })
    fs.writeFileSync(CACHE_SUMMARIES_FILE, JSON.stringify(summaryCache, null, 2), 'utf8')
    console.log(`[摘要] 缓存共 ${Object.keys(summaryCache).length} 条 → ${path.relative(ROOT, CACHE_SUMMARIES_FILE)}`)
  }

  for (const scene of story) {
    delete scene.summaryTarget
    delete scene.cacheKey
  }
  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    story,
    glossary
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  fs.writeFileSync(args.out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  const sizeMb = (fs.statSync(args.out).size / 1024 / 1024).toFixed(2)
  const withSummary = story.filter((scene) => scene.summary).length
  console.log(`[索引] ${args.out}（${sizeMb} MB）：场景 ${story.length}（有摘要 ${withSummary}），词条 ${glossary.length}`)
  if (failures.length > 0) {
    console.error(`[结果] ${failures.length} 个场景摘要失败，对应摘要为空；重跑一次即可补齐`)
    process.exit(1)
  }
  if (failedEntries.length > 0) process.exit(1)
}

main().catch((error) => {
  console.error(`[错误] ${error?.stack || error}`)
  process.exit(1)
})
