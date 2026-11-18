// 浏览器层：持久化 Chromium（共享登录态）、页面复用、跨域接口请求、浏览器自动探测。
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { MIC_INJECT } from './mic-inject.js'
import { describeError, sleep } from './log.js'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

export const H5_URL = 'https://static.fifedu.com/static/fiforal/kyxl-web-static/student-h5/index.html'
export const LOGIN_URL = 'https://www.fifedu.com/iplat/fifLogin/index.html'

const DEFAULT_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--allow-running-insecure-content',
  '--lang=zh-CN',
  '--no-first-run',
  '--no-default-browser-check',
]

const CHANNEL_CANDIDATES = ['chrome', 'msedge', undefined]

export function createBrowserHost({ config, logger }) {
  /** @type {import('playwright-core').BrowserContext|null} */
  let context = null
  /** @type {import('playwright-core').Page|null} */
  let h5Page = null
  let launching = null
  let usedChannel = null

  function isAlive() {
    try {
      return !!(context && context.browser?.()?.isConnected())
    } catch {
      return false
    }
  }

  async function launchOnce(channel) {
    await mkdir(config.profileDir, { recursive: true })
    const options = {
      headless: !!config.headless,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      args: DEFAULT_ARGS,
      permissions: ['microphone'],
      ignoreDefaultArgs: ['--enable-automation'],
    }
    if (channel) options.channel = channel
    return await chromium.launchPersistentContext(config.profileDir, options)
  }

  async function launch() {
    const requested = config.channel && config.channel !== 'auto' ? [config.channel] : CHANNEL_CANDIDATES
    const errors = []
    for (const channel of requested) {
      try {
        logger?.info(`启动浏览器 channel=${channel || 'playwright-chromium'} headless=${!!config.headless}`)
        const ctx = await launchOnce(channel)
        await ctx.addInitScript({ content: MIC_INJECT })
        usedChannel = channel || 'chromium'
        ctx.on('close', () => {
          logger?.warn('浏览器上下文已关闭')
          context = null
          h5Page = null
        })
        return ctx
      } catch (err) {
        errors.push(`${channel || 'chromium'}: ${describeError(err).slice(0, 200)}`)
      }
    }
    throw new Error(
      `启动浏览器失败（profile 可能被另一个进程占用，或本机没有 Chrome/Edge）：\n${errors.join('\n')}\n` +
        `可用 npx playwright install chromium 安装内置内核，或在 config.browser.channel 指定 chrome/msedge。`,
    )
  }

  async function ensureContext() {
    if (isAlive()) return context
    if (!launching) {
      launching = launch()
        .then((ctx) => {
          context = ctx
          return ctx
        })
        .finally(() => {
          launching = null
        })
    }
    return await launching
  }

  async function ensureH5Page() {
    const ctx = await ensureContext()
    if (h5Page && !h5Page.isClosed()) return h5Page
    const pages = ctx.pages().filter((p) => !p.isClosed())
    const existing = pages.find((p) => p.url().includes('student-h5'))
    if (existing) {
      h5Page = existing
      return h5Page
    }
    const page = pages[0] || (await ctx.newPage())
    h5Page = page
    if (!page.url().includes('student-h5')) {
      await page.goto(H5_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await sleep(1500)
    }
    return page
  }

  /** 打开一个可读 localStorage 的同源页面并取出鉴权信息。 */
  async function readAuth() {
    const page = await ensureH5Page()
    return await page.evaluate(() => ({
      token: localStorage.getItem('Authorization') || '',
      source: localStorage.getItem('source') || '',
    }))
  }

  async function request(page, url, { method = 'POST', form, json, headers } = {}) {
    const ctx = await ensureContext()
    const auth = await readAuth().catch(() => ({ token: '', source: '' }))
    const baseHeaders = {
      Authorization: `Bearer ${auth.token}`,
      source: auth.source || 'student',
      Origin: 'https://static.fifedu.com',
      Referer: 'https://static.fifedu.com/',
    }
    const options = { method, headers: { ...baseHeaders, ...(headers || {}) }, timeout: 60_000 }
    if (form) options.form = form
    if (json) {
      options.data = json
      options.headers['Content-Type'] = 'application/json'
    }
    const res = await ctx.request.fetch(url, options)
    const status = typeof res.status === 'function' ? res.status() : res.status
    const text = await res.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = { __raw: text.slice(0, 2000) }
    }
    return { status, body }
  }

  /** 所有 frame 广播（注入脚本在每个 frame 都跑过一份）。 */
  async function broadcast(page, fnSource, arg) {
    const results = []
    for (const frame of page.frames()) {
      try {
        const result = await frame.evaluate(fnSource, arg)
        results.push({ url: frame.url().slice(0, 120), result })
      } catch (err) {
        results.push({ url: frame.url().slice(0, 120), error: describeError(err) })
      }
    }
    return results
  }

  /** 单条音频入队（每轮 getUserMedia 消费一条）。 */
  async function feedAudio(page, item) {
    return await broadcast(
      page,
      async (payload) => {
        if (!window.__fifOral) return { injected: false }
        return await window.__fifOral.feed(payload.b64, payload.mime)
      },
      { b64: item.b64, mime: item.mime },
    )
  }

  /** 一组音频入队（一次录音里连播，整段朗读用）。 */
  async function feedGroup(page, items, gapMs = 260) {
    return await broadcast(
      page,
      async (payload) => {
        if (!window.__fifOral) return { injected: false }
        return await window.__fifOral.feedGroup(payload.items, payload.gapMs)
      },
      { items: items.map((i) => ({ b64: i.b64, mime: i.mime })), gapMs },
    )
  }

  async function micStatus(page) {
    return await broadcast(page, async () => (window.__fifOral ? window.__fifOral.status() : null))
  }

  async function close() {
    const ctx = context
    context = null
    h5Page = null
    if (ctx) await ctx.close().catch(() => {})
  }

  return {
    ensureContext,
    ensureH5Page,
    readAuth,
    request,
    broadcast,
    feedAudio,
    feedGroup,
    micStatus,
    close,
    isAlive,
    get channel() {
      return usedChannel || config.channel
    },
    get context() {
      return context
    },
  }
}
