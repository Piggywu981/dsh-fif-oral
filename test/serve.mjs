// 常驻调试服务：在后台持有一个 headful 浏览器，通过本地 HTTP 交互式驱动。
// 这是给开发/联调用的（DSH 插件里同一套 lib 直接以工具形式暴露）。
// 用法：node test/serve.mjs   默认 http://127.0.0.1:8901
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { createLog, describeError } from '../lib/log.js'
import { createBrowserHost, LOGIN_URL, H5_URL } from '../lib/browser.js'
import { resolveConfig } from '../lib/config.js'
import { createFifClient } from '../lib/fif.js'
import { createUi } from '../lib/ui.js'
import { createTts } from '../lib/tts.js'
import { createReadingSolver } from '../lib/reading.js'
import { createListeningSolver } from '../lib/listening.js'
import { createRunner } from '../lib/runner.js'

const require = createRequire(import.meta.url)
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const pluginRoot = root.replace(/[\\/]+$/, '')
const config = resolveConfig(
  {
    browser: { channel: 'chrome', headless: false, profileDir: `${pluginRoot}/data/profile` },
    tts: { engine: 'edge', voice: 'en-US-AriaNeural' },
  },
  pluginRoot,
)
const log = createLog()
const browser = createBrowserHost({ config, logger: log })
const fif = createFifClient({ browser, logger: log })
const ui = createUi({ browser, logger: log })
const tts = createTts(config, log)
const reading = createReadingSolver({ browser, ui, tts, logger: log })
const listening = createListeningSolver({ browser, ui, tts, logger: log, config })
const runner = createRunner({ fif, reading, listening, tts, log, config, browser })

function json(res, code, body) {
  const text = JSON.stringify(body, null, 1)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

const routes = {
  async '/status'() {
    const out = { browser: browser.isAlive(), auth: null, user: null, runner: runner.status(), log: log.tail(30) }
    if (browser.isAlive()) {
      const auth = await browser.readAuth().catch((err) => ({ token: '', error: describeError(err) }))
      out.auth = { hasToken: Boolean(auth.token), source: auth.source, error: auth.error }
      if (auth.token) out.user = await fif.userInfo().catch((err) => ({ error: describeError(err) }))
    }
    return out
  },
  async '/open'({ page = 'login' } = {}) {
    const ctx = await browser.ensureContext()
    const p = await ctx.newPage()
    await p.goto(page === 'h5' ? H5_URL : LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    return { ok: true, pages: ctx.pages().map((x) => x.url().slice(0, 140)) }
  },
  async '/tasks'() {
    const { user, tasks } = await fif.taskList(1, 1)
    return {
      user: { userId: user.userId, name: user.realName || user.userName },
      tasks: tasks.map((t) => ({ id: t.id, taskId: t.taskId, name: t.taskName || t.name, endTime: t.endTime, raw: t })),
    }
  },
  async '/task'({ taskId }) {
    const { units } = await fif.taskDetail(taskId)
    const out = []
    for (const unit of units) {
      const info = await fif.unitInfo(unit.unitid || unit.unitId || unit.id, taskId)
      const levels = []
      for (const level of info.levelList || []) {
        let detail = null
        try {
          detail = await fif.describeLevel(level)
        } catch (err) {
          detail = { error: describeError(err) }
        }
        levels.push({
          levelId: level.levelId,
          name: level.levelName,
          score: level.levelScore,
          kind: detail?.kind,
          segCount: detail?.segments?.length ?? null,
          qCount: detail?.questions?.length ?? null,
          segPreview: detail?.segments?.slice(0, 2) || null,
          qPreview: detail?.questions?.slice(0, 2) || null,
          error: detail?.error,
        })
      }
      out.push({ unitId: unit.unitid || unit.unitId || unit.id, unitName: unit.unitName, levels })
    }
    return { taskId, units: out }
  },
  async '/level'({ levelId }) {
    return await fif.levelInfo(levelId)
  },
  async '/probe'({ taskId, unitId, levelId, start = false, screenshot = true, keep = false }) {
    const user = await fif.userInfo()
    const page = await ui.openTest({ userId: user.userId, taskId, unitId, levelId })
    try {
      const before = await ui.snapshot(page)
      let started = null
      if (start) {
        let frame = ui.pickFrame(page)
        await ui.clickTab(frame, ['挑战'])
        await new Promise((r) => setTimeout(r, 1500))
        frame = ui.pickFrame(page)
        started = await ui.clickButton(frame, ['开始挑战', '开始答题', '开始'])
        await new Promise((r) => setTimeout(r, 4000))
      }
      const after = await ui.snapshot(page)
      const shot = screenshot ? await ui.screenshot(page, `${config.workDir}/probe-${levelId}-${Date.now()}.png`) : null
      return { started, before, after, screenshot: shot }
    } finally {
      if (!keep) await page.close().catch(() => {})
    }
  },
  async '/run'(opts = {}) {
    return runner.start(opts)
  },
  async '/stop'() {
    runner.stop()
    return runner.status()
  },
  async '/tts'({ text }) {
    const one = await tts.synthesize(Array.isArray(text) ? text : [text])
    return {
      items: one.items.length,
      durationMs: one.durationMs,
      bytes: one.items.reduce((s, i) => s + i.bytes, 0),
      mime: one.items[0]?.mime,
    }
  },
  async '/solve'({ taskId, unitId, levelId, voice }) {
    const { user, tasks } = await fif.taskList(1, 1)
    const task = tasks.find((t) => String(t.id) === String(taskId) || String(t.taskId) === String(taskId)) || tasks[0]
    if (!task) throw new Error('没有可用的任务')
    const { units } = await fif.taskDetail(task.id)
    const unit = units.find((u) => String(u.unitid || u.unitId || u.id) === String(unitId)) || units[0]
    const info = await fif.unitInfo(unit.unitid || unit.unitId || unit.id, task.taskId || task.id)
    const level = (info.levelList || []).find((l) => String(l.levelId) === String(levelId))
    if (!level) throw new Error(`单元里没有关卡 ${levelId}`)
    const detail = await fif.describeLevel(level)
    const started = Date.now()
    const result =
      detail.kind === 'listening'
        ? await listening.solve({ task, unit, user, level, qcontent: detail.qcontent, options: { voice } })
        : await reading.solve({ task, unit, user, level, segments: detail.segments, options: { voice } })
    return { kind: detail.kind, levelName: level.levelName, elapsedMs: Date.now() - started, result }
  },
  async '/pages'() {
    const ctx = browser.context
    if (!ctx) return { pages: [] }
    return {
      pages: ctx.pages().map((p, i) => ({
        i,
        url: p.url().slice(0, 160),
        frames: p.frames().map((f) => f.url().slice(0, 160)),
      })),
    }
  },
  async '/eval'({ frameMatch = '', pageMatch = 'student-h5', code = 'document.body.innerText', index = -1 }) {
    const ctx = browser.context
    if (!ctx) throw new Error('浏览器未启动')
    const pages = ctx.pages().filter((p) => p.url().includes(pageMatch))
    const page = index >= 0 ? pages[index] : pages[pages.length - 1]
    if (!page) throw new Error(`没有匹配 ${pageMatch} 的页面`)
    const frames = frameMatch ? page.frames().filter((f) => f.url().includes(frameMatch)) : [page.mainFrame()]
    const results = []
    for (const frame of frames) {
      try {
        const value = await frame.evaluate((src) => (0, eval)(src), code)
        results.push({ url: frame.url().slice(0, 120), value })
      } catch (err) {
        results.push({ url: frame.url().slice(0, 120), error: String(err?.message || err) })
      }
    }
    return { results }
  },
  async '/click'({ frameMatch = '', pageMatch = 'student-h5', text = '', selector = '' }) {
    const ctx = browser.context
    if (!ctx) throw new Error('浏览器未启动')
    const pages = ctx.pages().filter((p) => p.url().includes(pageMatch))
    const page = pages[pages.length - 1]
    if (!page) throw new Error(`没有匹配 ${pageMatch} 的页面`)
    const frames = frameMatch ? page.frames().filter((f) => f.url().includes(frameMatch)) : [page.mainFrame()]
    const out = []
    for (const frame of frames) {
      try {
        if (selector) {
          await frame.locator(selector).first().click({ timeout: 8000 })
          out.push({ url: frame.url().slice(0, 80), clicked: selector })
        } else {
          const loc = frame.getByText(text, { exact: true })
          const n = await loc.count()
          if (!n) throw new Error(`没有文本「${text}」`)
          await loc.first().click({ timeout: 8000 })
          out.push({ url: frame.url().slice(0, 80), clicked: text, count: n })
        }
      } catch (err) {
        out.push({ url: frame.url().slice(0, 80), error: String(err?.message || err) })
      }
    }
    return { out }
  },
  async '/close'() {
    await browser.close()
    return { ok: true }
  },
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const handler = routes[url.pathname]
  if (!handler) return json(res, 404, { error: 'no route', routes: Object.keys(routes) })
  try {
    const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams)
    const result = await handler(body)
    return json(res, 200, result)
  } catch (err) {
    log.error(`${url.pathname} 失败：${describeError(err)}`)
    return json(res, 500, { error: describeError(err) })
  }
})

server.listen(8901, '127.0.0.1', () => {
  log.info('fif-oral dev server on http://127.0.0.1:8901')
  console.log('READY http://127.0.0.1:8901')
})
