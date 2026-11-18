// Agent 工具注册：状态 / 登录 / 任务 / 探针 / 自动执行 / 日志。
import { describeError } from './log.js'
import { LOGIN_URL } from './browser.js'

const OUTPUT_OBJECT = { type: 'object', additionalProperties: true }

function jsonRender(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 1).slice(0, 60_000) }]
}

function defineTool(name, description, parameters, run) {
  return {
    name,
    description,
    parameters,
    output: { schema: OUTPUT_OBJECT, render: jsonRender },
    async execute(args, exec) {
      try {
        return await run(args || {}, exec)
      } catch (err) {
        throw new Error(`${name}: ${describeError(err)}`)
      }
    },
  }
}

export function registerTools(deps) {
  const { ctx, config, log, browser, fif, ui, tts, reading, listening, runner } = deps

  function add(definition, label) {
    ctx.effect(() => ctx.tools.register(definition), `fif-oral.tools.${label}`)
  }

  add(
    defineTool(
      'fif_status',
      '查看 FiF 口语插件状态：浏览器是否在线、登录态、后台 runner 进度、最近日志。',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        let auth = null
        let user = null
        if (browser.isAlive()) {
          try {
            auth = await browser.readAuth()
            if (auth.token) user = await fif.userInfo()
          } catch (err) {
            auth = { error: describeError(err) }
          }
        }
        return {
          browser: { alive: browser.isAlive(), channel: config.channel, headless: config.headless, profile: config.profileDir },
          auth: auth ? { hasToken: Boolean(auth.token), source: auth.source, error: auth.error } : null,
          user: user ? { userId: user.userId, name: user.realName || user.userName } : null,
          tts: { engine: config.engine, voice: config.voice, rate: config.rate },
          runner: runner.status(),
          log: log.tail(20),
        }
      },
    ),
    'status',
  )

  add(
    defineTool(
      'fif_open',
      '启动 FiF 口语用的浏览器（持久化 profile，首次需在里面手动登录一次）。打开登录页或手动登录后的口语首页。',
      {
        type: 'object',
        properties: {
          page: { type: 'string', enum: ['login', 'h5'], description: 'login 打开登录页（默认），h5 打开口语 H5 首页' },
          headless: { type: 'boolean', description: '覆盖配置的 headless' },
        },
        additionalProperties: false,
      },
      async (args) => {
        if (args.headless !== undefined) config.headless = Boolean(args.headless)
        const ctx0 = await browser.ensureContext()
        const page = await ctx0.newPage()
        if (args.page === 'h5') {
          await page.goto(H5_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        } else {
          await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        }
        const auth = await browser.readAuth().catch((err) => ({ token: '', error: describeError(err) }))
        return {
          ok: true,
          pages: ctx0.pages().map((p) => p.url().slice(0, 160)).slice(0, 10),
          hasToken: Boolean(auth.token),
          hint: auth.token ? '已登录' : '浏览器已打开，请在窗口里完成登录后调用 fif_status 确认',
        }
      },
    ),
    'open',
  )

  add(
    defineTool(
      'fif_login',
      '用账号密码登录 FiF（fifedu.com），成功后把口语系统的 token/source 存进页面 localStorage 供后续接口使用。',
      {
        type: 'object',
        properties: {
          user: { type: 'string', description: '登录账号（学校缩写+学号）' },
          pass: { type: 'string', description: '密码' },
        },
        required: ['user', 'pass'],
        additionalProperties: false,
      },
      async (args) => {
        const loginCtx = await browser.ensureContext()
        const page = await loginCtx.newPage()
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.fill('input[name="user"]', String(args.user))
        await page.fill('input[name="pass"]', String(args.pass))
        await page.getByRole('button', { name: '登录' }).click().catch(() => {})
        await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {})
        await page.waitForTimeout(2500)

        let token = ''
        let source = ''
        try {
          const popupPromise = page.waitForEvent('popup', { timeout: 15_000 }).catch(() => null)
          await page.getByText('FiF口语训练系统', { exact: true }).first().click({ timeout: 8000 }).catch(() => {})
          const popup = await popupPromise
          const target = popup || (await browser.ensureH5Page())
          await target.waitForLoadState('domcontentloaded').catch(() => {})
          await target.waitForTimeout(2000)
          token = await target.evaluate(() => localStorage.getItem('Authorization') || '')
          source = await target.evaluate(() => localStorage.getItem('source') || '')
          if (popup) await popup.close().catch(() => {})
        } catch (err) {
          log.warn(`点击应用入口失败：${describeError(err)}`)
        }
        if (!token) {
          const h5 = await browser.ensureH5Page()
          token = await h5.evaluate(() => localStorage.getItem('Authorization') || '')
          source = await h5.evaluate(() => localStorage.getItem('source') || '')
        }
        await page.close().catch(() => {})
        if (!token) return { ok: false, reason: '登录后没有拿到 Authorization，请用 fif_open 手动登录一次' }
        const user = await fif.userInfo()
        return { ok: true, userId: user.userId, name: user.realName || user.userName, hasToken: true, source }
      },
    ),
    'login',
  )

  add(
    defineTool(
      'fif_tasks',
      '列出进行中的 FiF AI 任务（教师任务），返回任务 id、名称、完成度、截止时间。',
      {
        type: 'object',
        properties: {
          status: { type: 'integer', description: '1 进行中（默认），其他数值按平台口径' },
        },
        additionalProperties: false,
      },
      async (args) => {
        const { user, tasks } = await fif.taskList(args.status ?? 1, 1)
        return {
          user: { userId: user.userId, name: user.realName || user.userName },
          tasks: tasks.map((t) => ({
            id: t.id,
            taskId: t.taskId,
            name: t.taskName || t.name,
            progress: t.finishRate ?? t.progress ?? null,
            endTime: t.endTime ?? t.finishTime ?? null,
            raw: t,
          })),
        }
      },
    ),
    'tasks',
  )

  add(
    defineTool(
      'fif_task',
      '查看一个 AI 任务的结构：单元列表、每个单元的关卡（题型、当前分数、朗读段数）。',
      {
        type: 'object',
        properties: { taskId: { type: 'string', description: '任务 id（来自 fif_tasks）' } },
        required: ['taskId'],
        additionalProperties: false,
      },
      async (args) => {
        const { units } = await fif.taskDetail(args.taskId)
        const out = []
        for (const unit of units) {
          const info = await fif.unitInfo(unit.unitid || unit.unitId || unit.id, args.taskId)
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
              segments: detail?.segments?.length ?? null,
              questions: detail?.questions?.length ?? null,
              preview: detail?.segments?.slice(0, 2) || null,
              error: detail?.error,
            })
          }
          out.push({ unit: unit.unitName, unitId: unit.unitid || unit.unitId || unit.id, levels })
        }
        return { taskId: args.taskId, units: out }
      },
    ),
    'task',
  )

  add(
    defineTool(
      'fif_probe',
      '打开一个关卡的真实页面并 dump 结构（iframe 里的按钮/输入/文本 + 接口原始题目内容），用于定位听力选项与提交按钮。',
      {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 id' },
          unitId: { type: 'string', description: '单元 id' },
          levelId: { type: 'string', description: '关卡 id（gId）' },
          screenshot: { type: 'boolean', description: '是否截图并返回路径' },
          start: { type: 'boolean', description: '是否自动点「挑战 → 开始挑战」（默认 false）' },
        },
        required: ['taskId', 'unitId', 'levelId'],
        additionalProperties: false,
      },
      async (args) => {
        const user = await fif.userInfo()
        const page = await ui.openTest({
          userId: user.userId,
          taskId: args.taskId,
          unitId: args.unitId,
          levelId: args.levelId,
        })
        try {
          const before = await ui.snapshot(page)
          let started = null
          if (args.start) {
            let frame = ui.pickFrame(page)
            await ui.clickTab(frame, ['挑战'])
            await new Promise((r) => setTimeout(r, 1200))
            frame = ui.pickFrame(page)
            started = await ui.clickButton(frame, ['开始挑战', '开始答题', '开始'])
            await new Promise((r) => setTimeout(r, 3000))
          }
          const after = await ui.snapshot(page)
          const shot = args.screenshot ? await ui.screenshot(page, `${config.workDir}/probe-${args.levelId}-${Date.now()}.png`) : null
          let levelInfo = null
          try {
            levelInfo = await fif.levelInfo(args.levelId)
          } catch (err) {
            levelInfo = { error: describeError(err) }
          }
          return { started, before, after, screenshot: shot, levelInfo }
        } finally {
          await page.close().catch(() => {})
        }
      },
    ),
    'probe',
  )

  add(
    defineTool(
      'fif_run',
      '后台自动完成 AI 任务：听力（取答案后回填提交）与朗读（TTS 喂麦克风录音提交）。返回启动状态，用 fif_status 轮询进度。',
      {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['all', 'listening', 'reading'], description: 'all 两类都做（默认）' },
          taskId: { type: 'string', description: '只跑指定任务；省略则跑所有进行中任务' },
        },
        additionalProperties: false,
      },
      async (args) => {
        const auth = await browser.readAuth()
        if (!auth.token) return { started: false, reason: '未登录，请先 fif_open 手动登录或 fif_login' }
        return runner.start({ mode: args.mode || 'all', taskId: args.taskId })
      },
    ),
    'run',
  )

  add(
    defineTool(
      'fif_stop',
      '停止正在运行的后台自动任务（当前关卡结束后退出）。',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        runner.stop()
        return { ok: true, status: runner.status() }
      },
    ),
    'stop',
  )

  add(
    defineTool(
      'fif_log',
      '读取插件运行日志（默认最近 80 条），用于排查哪一关卡在哪一步停住。',
      {
        type: 'object',
        properties: { tail: { type: 'integer', description: '返回条数，默认 80' } },
        additionalProperties: false,
      },
      async (args) => ({ lines: log.tail(args.tail || 80) }),
    ),
    'log',
  )

  add(
    defineTool(
      'fif_voices',
      '列出可用的英文 TTS 音色（edge-tts），用于挑选评分更高的朗读音色。',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => ({ voices: await tts.listVoices() }),
    ),
    'voices',
  )

  add(
    defineTool(
      'fif_doctor',
      '体检插件运行依赖：浏览器内核、Python + edge-tts、音色、数据目录、登录态。排障先跑这个。',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        const ttsInfo = await tts.doctor()
        let authOk = false
        let authError = ''
        if (browser.isAlive()) {
          try {
            authOk = Boolean((await browser.readAuth()).token)
          } catch (err) {
            authError = describeError(err)
          }
        }
        return {
          ok: ttsInfo.python !== '未找到（edge-tts 需要 pip install edge-tts）' && authOk,
          browser: { alive: browser.isAlive(), channel: browser.channel, profile: config.profileDir },
          tts: ttsInfo,
          login: { ok: authOk, error: authError || undefined },
          dataDir: config.dataDir,
          ffmpeg: '不需要',
        }
      },
    ),
    'doctor',
  )

  add(
    defineTool(
      'fif_close',
      '关闭 FiF 口语用的浏览器与后台任务，释放麦克风与 profile 锁。',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        runner.stop()
        await browser.close()
        return { ok: true }
      },
    ),
    'close',
  )
}
