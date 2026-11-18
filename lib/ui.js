// 页面操作层：进入关卡、切"挑战"、开始/结束录音、等待评分、结构与文本快照。
// FiF 的挑战页在 iframe 里，且按钮文案会随版本变化，所以统一走"文本优先 + 多候选"策略。
import { sleep } from './log.js'
import { TEST_URL } from './fif.js'

const FRAME_HINT = /testWebView|kyxl|challenge|exam/i

export function createUi({ browser, logger }) {
  function pickFrame(page) {
    const frames = page.frames()
    const inner = frames.filter((f) => f !== page.mainFrame())
    return inner.find((f) => FRAME_HINT.test(f.url() || '')) || inner[0] || page.mainFrame()
  }

  async function openTest({ userId, taskId, unitId, levelId }) {
    const ctx = await browser.ensureContext()
    const page = await ctx.newPage()
    const url = TEST_URL(userId, taskId, unitId, levelId)
    logger?.step(`打开关卡页 gId=${levelId}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await sleep(2500)
    // 等 iframe 就位
    for (let i = 0; i < 20; i += 1) {
      const frames = page.frames()
      if (frames.length > 1) break
      await sleep(500)
    }
    await sleep(1500)
    return page
  }

  async function clickText(frame, texts, { timeout = 12_000, exact = false } = {}) {
    for (const text of texts) {
      const loc = frame.getByText(text, { exact })
      const count = await loc.count().catch(() => 0)
      for (let i = 0; i < count; i += 1) {
        const el = loc.nth(i)
        if (!(await el.isVisible().catch(() => false))) continue
        try {
          await el.click({ timeout: 5000 })
          logger?.step(`点击文本「${text}」`)
          return text
        } catch {
          try {
            await el.click({ force: true, timeout: 5000 })
            logger?.step(`强制点击文本「${text}」`)
            return text
          } catch {
            /* 换下一个候选 */
          }
        }
      }
    }
    return null
  }

  async function clickButton(frame, names, options = {}) {
    for (const name of names) {
      const loc = frame.getByRole('button', { name })
      const count = await loc.count().catch(() => 0)
      for (let i = 0; i < count; i += 1) {
        const el = loc.nth(i)
        if (!(await el.isVisible().catch(() => false))) continue
        if (!(await el.isEnabled().catch(() => true))) continue
        try {
          await el.click({ timeout: options.timeout || 8000 })
          logger?.step(`点击按钮「${name}」`)
          return name
        } catch {
          /* 继续 */
        }
      }
    }
    return await clickText(frame, names, options)
  }

  async function clickTab(frame, names = ['挑战']) {
    const loc = frame.getByRole('tab')
    const count = await loc.count().catch(() => 0)
    for (let i = 0; i < count; i += 1) {
      const el = loc.nth(i)
      const label = ((await el.innerText().catch(() => '')) || '').trim()
      if (names.some((n) => label.includes(n))) {
        await el.click({ timeout: 8000 }).catch(() => {})
        logger?.step(`切换 tab「${label || names[0]}」`)
        await sleep(1200)
        return label || names[0]
      }
    }
    // 精确文本优先（避免命中"练习挑战"这种父容器）
    const exact = await clickText(frame, names, { exact: true })
    if (exact) {
      await sleep(1200)
      return exact
    }
    const fuzzy = await clickText(frame, names)
    if (fuzzy) await sleep(1200)
    return fuzzy
  }

  async function waitEnabled(frame, names, { timeout = 30_000, interval = 500 } = {}) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      for (const name of names) {
        const loc = frame.getByText(name, { exact: false })
        const count = await loc.count().catch(() => 0)
        for (let i = 0; i < count; i += 1) {
          const el = loc.nth(i)
          const visible = await el.isVisible().catch(() => false)
          if (!visible) continue
          const disabled = await el.getAttribute('disabled').catch(() => null)
          const aria = await el.getAttribute('aria-disabled').catch(() => null)
          const cls = (await el.getAttribute('class').catch(() => '')) || ''
          if (disabled === null && aria !== 'true' && !/disabled|forbid|ban/.test(cls)) return name
        }
      }
      await sleep(interval)
    }
    return null
  }

  async function textOf(frame) {
    try {
      return (await frame.evaluate(() => document.body.innerText || '')).replace(/\n{3,}/g, '\n\n')
    } catch {
      return ''
    }
  }

  async function hasText(frame, needles) {
    const text = await textOf(frame)
    return needles.filter((n) => text.includes(n))
  }

  /** 页面结构快照：按钮/输入/文本，用于定位题型与调试。 */
  async function snapshot(page) {
    const frames = []
    for (const frame of page.frames()) {
      try {
        const info = await frame.evaluate(() => {
          const visible = (el) => {
            const r = el.getBoundingClientRect()
            const s = getComputedStyle(el)
            return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.05
          }
          const brief = (el) => ({
            tag: el.tagName.toLowerCase(),
            cls: String(el.className || '').slice(0, 90),
            text: String(el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 90),
          })
          const buttons = [...document.querySelectorAll('button,[role=button],.btn,.button,a[href]')]
            .filter(visible)
            .map(brief)
            .slice(0, 70)
          const inputs = [...document.querySelectorAll('input,textarea,select')]
            .filter(visible)
            .map((el) => ({
              ...brief(el),
              type: el.type,
              name: el.name,
              placeholder: el.placeholder,
              checked: !!el.checked,
              value: String(el.value || '').slice(0, 60),
            }))
            .slice(0, 70)
          const radios = [...document.querySelectorAll('input[type=radio],input[type=checkbox]')]
            .filter(visible)
            .map((el) => ({ name: el.name, value: el.value, checked: el.checked, label: String(el.closest('label')?.innerText || '').trim().slice(0, 60) }))
            .slice(0, 80)
          return {
            url: location.href,
            title: document.title,
            buttons,
            inputs,
            radios,
            text: (document.body.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 7000),
          }
        })
        frames.push({ url: frame.url().slice(0, 200), isMain: frame === page.mainFrame(), info })
      } catch (err) {
        frames.push({ url: frame.url().slice(0, 200), error: String(err?.message || err) })
      }
    }
    return frames
  }

  async function screenshot(page, file) {
    try {
      await page.screenshot({ path: file, fullPage: false })
      return file
    } catch {
      return null
    }
  }

  return {
    pickFrame,
    openTest,
    clickText,
    clickButton,
    clickTab,
    waitEnabled,
    textOf,
    hasText,
    snapshot,
    screenshot,
  }
}
