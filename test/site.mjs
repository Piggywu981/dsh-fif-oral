// 站点可达性 / 登录页结构 / H5 登录态探测（不提交任何账号密码）。
// 用法：node test/site.mjs
import { createRequire } from 'node:module'
import { createLog } from '../lib/log.js'
import { createBrowserHost, LOGIN_URL, H5_URL } from '../lib/browser.js'
import { resolveConfig } from '../lib/config.js'
import { createFifClient, API } from '../lib/fif.js'

const require = createRequire(import.meta.url)
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const config = resolveConfig(
  { dataDir: `${root.replace(/\\/g, '/')}data/probe-profile`, browser: { channel: 'chrome', headless: true } },
  root.replace(/\\/g, '/'),
)
const log = createLog()
const browser = createBrowserHost({ config, logger: log })

async function main() {
  const ctx = await browser.ensureContext()
  const page = await ctx.newPage()

  log.info(`打开登录页 ${LOGIN_URL}`)
  const resp = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  console.log('登录页 HTTP', resp?.status(), '->', page.url())
  await page.waitForTimeout(3000)

  const loginForm = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].map((el) => ({
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      cls: String(el.className).slice(0, 60),
    }))
    const buttons = [...document.querySelectorAll('button,a[role=button],[class*=btn]')]
      .map((el) => String(el.innerText || '').trim())
      .filter(Boolean)
      .slice(0, 20)
    return { title: document.title, inputs, buttons, text: (document.body.innerText || '').slice(0, 600) }
  })
  console.log('登录页结构:', JSON.stringify(loginForm, null, 1))

  log.info(`打开 H5 ${H5_URL}`)
  await page.goto(H5_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForTimeout(4000)
  const h5 = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    lsKeys: Object.keys(localStorage),
    auth: localStorage.getItem('Authorization'),
    source: localStorage.getItem('source'),
    text: (document.body.innerText || '').slice(0, 800),
  }))
  console.log('H5 状态:', JSON.stringify({ ...h5, auth: h5.auth ? '<有 token>' : null }, null, 1))

  const fif = createFifClient({ browser, logger: log })
  for (const [name, url, opts] of [
    ['userInfo', API.userInfo, { method: 'GET' }],
    ['taskList', API.taskList, { method: 'POST', form: { userId: '0', status: 1, page: 1 } }],
  ]) {
    try {
      const res = await browser.request(page, url, opts)
      console.log(`接口 ${name}: HTTP ${res.status()} ->`, JSON.stringify(res.body).slice(0, 300))
    } catch (err) {
      console.log(`接口 ${name} 失败:`, String(err?.message || err).slice(0, 300))
    }
  }

  await browser.close()
}

main().catch((err) => {
  console.error('FAILED', err)
  process.exit(1)
})
