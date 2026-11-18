// 朗读关卡（实测 2026-11）：
//   assessment frame 点 tab「挑战」→ button「开始挑战」→ 立刻 getUserMedia 开始第 1 句录音
//   → 每点一次「结束录音」提交当前句并自动开始下一句（每轮重新 getUserMedia）
//   → 最后一句后跳 dubbingScene 成绩单（逐句发音/流利度/完整度 + 总分）。
// 策略：N 句分别合成并压入注入麦克风队列，每轮 gum 消费一条。
import { sleep } from './log.js'

const PASSAGE_HINT = ['短文朗读', '全文朗读', '篇章朗读', '段落朗读']

export function createReadingSolver({ browser, ui, tts, logger }) {
  async function pickMicStatus(page) {
    const results = await browser.micStatus(page)
    let best = null
    let bestScore = -1
    for (const item of results) {
      const st = item?.result
      if (!st) continue
      const score = (st.plays || 0) * 100 + (st.gumCalls || 0) + (st.queued || 0)
      if (score > bestScore) {
        best = st
        bestScore = score
      }
    }
    return best
  }

  async function waitPlays(page, baseline, { timeoutMs = 90_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      const st = await pickMicStatus(page)
      if (st) {
        last = st
        if ((st.plays || 0) > baseline && !st.playing) return { ok: true, status: st }
      }
      await sleep(250)
    }
    return { ok: false, status: last }
  }

  async function waitGum(page, baseline, { timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      const st = await pickMicStatus(page)
      if (st) {
        last = st
        if ((st.gumCalls || 0) > baseline) return { ok: true, status: st }
      }
      await sleep(250)
    }
    return { ok: false, status: last }
  }

  /** DOM 级点击：比 Playwright 的可点击性检查更能扛住录制中的遮罩。 */
  async function clickButtonByText(frame, text) {
    return await frame
      .evaluate((label) => {
        const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label)
        if (!btn) return false
        btn.click()
        return true
      }, text)
      .catch(() => false)
  }

  async function clickChallengeTab(page) {
    const frame = page.frames().find((f) => /assessment\//.test(f.url())) || page.frames().find((f) => f !== page.mainFrame())
    if (!frame) return false
    const ok = await frame
      .evaluate(() => {
        const tab = [...document.querySelectorAll('.el-tabs__item')].find((e) => (e.textContent || '').trim() === '挑战')
        if (!tab) return false
        tab.click()
        return true
      })
      .catch(() => false)
    await sleep(2000)
    return ok
  }

  async function readScoreboard(page, timeout = 150_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const main = page.mainFrame()
      if (/dubbingScene/.test(main.url()) || /report\.html/.test(main.url())) {
        await sleep(2000)
        const data = await main
          .evaluate(() => {
            const text = document.body.innerText || ''
            const flat = text.replace(/\s+/g, ' ')
            const hit = flat.match(/(\d{1,3})\s*AI\s*评分/) || flat.match(/(?:对手|再接再厉)\s*(\d{1,3})\b/) || flat.match(/总分[^0-9]{0,6}(\d{1,3})/)
            return {
              total: hit ? Number(hit[1]) : null,
              success: /挑战成功/.test(flat),
              text: flat.slice(0, 1200),
            }
          })
          .catch(() => null)
        if (data && data.text && data.text.length > 20) return data
      }
      await sleep(1200)
    }
    return null
  }

  /**
   * @param {object} args { task, unit, level, user, segments, options }
   */
  async function solve({ task, unit, level, user, segments, options = {} }) {
    if (!segments || !segments.length) {
      return { ok: false, reason: '关卡没有可朗读的文本（getLevelInfo 未返回 title）' }
    }
    logger?.step(`朗读关卡「${level.levelName}」共 ${segments.length} 句，逐句合成语音`)
    const clips = []
    for (let i = 0; i < segments.length; i += 1) {
      const one = await tts.synthesize([segments[i]], { voice: options.voice, rate: options.rate })
      clips.push(one.items[0])
      logger?.step(`  [${i + 1}/${segments.length}] ${Math.round((one.items[0].durationMs || 0) / 100) / 10}s ${segments[i].slice(0, 42)}…`)
    }

    const page = await ui.openTest({
      userId: user.userId,
      taskId: task.id,
      unitId: unit.unitid || unit.unitId || unit.id,
      levelId: level.levelId,
    })
    try {
      await clickChallengeTab(page)
      const frame0 = page.frames().find((f) => /assessment\//.test(f.url())) || page.frames().find((f) => f !== page.mainFrame())
      const pageText = await ui.textOf(frame0).catch(() => '')
      const wholeMode = PASSAGE_HINT.some((h) => pageText.includes(h) || String(level.levelName || '').includes(h))

      if (wholeMode) {
        const submitted = await browser.feedGroup(page, clips, 260)
        logger?.step(`整段模式：${clips.length} 句打包成 1 次播放（${submitted.filter((x) => x.result).length} 个 frame 已注入）`)
      } else {
        for (const clip of clips) await browser.feedAudio(page, clip)
        const queued = await pickMicStatus(page)
        logger?.step(`逐句模式：队列 ${queued?.queued ?? clips.length} 条就绪`)
      }

      let frame = frame0
      if (!(await clickButtonByText(frame, '开始挑战'))) {
        return { ok: false, reason: '未找到「开始挑战」', snapshot: await ui.snapshot(page) }
      }
      logger?.step('挑战开始，进入录音')

      const rounds = wholeMode ? 1 : clips.length
      let plays = 0
      let gum = 0
      let completed = 0
      for (let i = 0; i < rounds; i += 1) {
        const expectMs = wholeMode
          ? clips.reduce((s, c) => s + (c.durationMs || 0), 0)
          : clips[i].durationMs || 0
        const played = await waitPlays(page, plays, { timeoutMs: Math.max(60_000, expectMs + 45_000) })
        if (!played.ok) logger?.warn(`第 ${i + 1} 段没有等到播放完成：${JSON.stringify(played.status)}`)
        plays = played.status?.plays ?? plays
        gum = played.status?.gumCalls ?? gum
        await sleep(700)

        if (!(await clickButtonByText(frame, '结束录音'))) {
          logger?.warn(`第 ${i + 1} 段点不到「结束录音」，可能已结束`)
          break
        }
        completed += 1
        logger?.step(`第 ${completed}/${rounds} 段已结束录音`)

        if (i < rounds - 1) {
          const next = await waitGum(page, gum, { timeoutMs: 25_000 })
          gum = next.status?.gumCalls ?? gum
          await sleep(500)
          frame = page.frames().find((f) => /assessment\//.test(f.url())) || frame
        }
      }

      const board = await readScoreboard(page)
      return {
        ok: Boolean(board),
        rounds: completed,
        segments: segments.length,
        total: board?.total ?? null,
        success: board?.success ?? null,
        scoreText: board?.text?.slice(0, 400) || null,
        url: page.url(),
      }
    } finally {
      if (!options.keepPage) await page.close().catch(() => {})
    }
  }

  return { solve }
}
