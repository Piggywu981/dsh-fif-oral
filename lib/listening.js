// 听力关卡：接口里直接带 right_answer，按题点选后一次提交即可满分。
// 页面结构（2026-11 实测）：listen/index.html frame 内 .ti_container 每题一个、.van-radio 选项、
// 右上「完成」= #topWrap .top_control a；提交后跳到 listen/report.html 显示每题得分与正确答案。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sleep } from './log.js'

const SUBMIT_LABELS = ['完成', '提交', '交卷', '确定']

/** 从 getLevelInfo 的 qcontent 里直接读正确答案（FiF 听力题：right_answer + answer[0].choise_list）。 */
export function answersFromApi(qcontent) {
  if (!qcontent) return null
  const out = []
  let index = 0
  for (const item of qcontent.item || []) {
    for (const q of item.questions || []) {
      index += 1
      const choiseList =
        (q.answer || []).find((a) => Array.isArray(a.choise_list) && a.choise_list.length)?.choise_list || []
      const rawAnswer = q.right_answer ?? q.rightAnswer ?? q.correctAnswer ?? q.rightKeys
      const keys = []
      if (Array.isArray(rawAnswer)) {
        for (const k of rawAnswer) {
          const key = String(k).trim()
          if (key) keys.push(key)
        }
      } else if (rawAnswer !== undefined && rawAnswer !== null && String(rawAnswer).trim()) {
        keys.push(...String(rawAnswer).split(/[,;|#\s]+/).filter(Boolean))
      }
      if (!keys.length) return null
      const texts = []
      for (const key of keys) {
        const hit = choiseList.find((c) => String(c.choise_name) === key)
        if (hit?.title) texts.push(String(hit.title).trim())
      }
      out.push({
        index,
        stem: String(item.title || '').trim().slice(0, 120),
        keys,
        texts,
        options: choiseList.map((c) => ({ key: String(c.choise_name || ''), text: String(c.title || '').trim() })),
      })
    }
  }
  return out.length ? out : null
}

export function createListeningSolver({ browser, ui, tts, logger, config }) {
  const storeFile = config.answersFile

  async function loadStore() {
    try {
      return JSON.parse(await readFile(storeFile, 'utf8'))
    } catch {
      return {}
    }
  }

  async function saveStore(store) {
    await mkdir(dirname(storeFile), { recursive: true })
    await writeFile(storeFile, JSON.stringify(store, null, 2), 'utf8')
  }

  function listenFrame(page) {
    const frames = page.frames()
    return (
      frames.find((f) => /listen\/index\.html/.test(f.url())) ||
      frames.find((f) => /listen/.test(f.url())) ||
      frames.find((f) => f !== page.mainFrame())
    )
  }

  function assessmentFrame(page) {
    return page.frames().find((f) => /assessment\//.test(f.url())) || page.frames().find((f) => f !== page.mainFrame())
  }

  async function clickChallenge(page) {
    const frame = assessmentFrame(page)
    if (!frame) return false
    const ok = await frame
      .evaluate(() => {
        const tab = [...document.querySelectorAll('.el-tabs__item')].find((e) => (e.textContent || '').trim() === '挑战')
        if (!tab) return false
        tab.click()
        return true
      })
      .catch(() => false)
    if (ok) {
      logger?.step('已切到「挑战」')
      await sleep(2500)
    }
    return ok
  }

  async function waitQuestions(page, timeout = 40_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const frame = listenFrame(page)
      if (frame) {
        const count = await frame.evaluate(() => document.querySelectorAll('.ti_container').length).catch(() => 0)
        if (count > 0) return { frame, count }
      }
      await sleep(800)
    }
    return { frame: listenFrame(page), count: 0 }
  }

  async function fillAnswers(frame, answers) {
    const list = answers.map((a) => ({ keys: a.keys || [], texts: a.texts || [] }))
    return await frame.evaluate((items) => {
      const tis = [...document.querySelectorAll('.ti_container')]
      const out = []
      items.forEach((ans, i) => {
        const ti = tis[i]
        if (!ti) {
          out.push({ i: i + 1, ok: false, error: '没有第 ' + (i + 1) + ' 题容器' })
          return
        }
        const radios = [...ti.querySelectorAll('.van-radio')]
        let target = null
        for (const key of ans.keys) {
          target = radios.find((r) => ((r.querySelector('em') || {}).textContent || '').trim() === key)
          if (target) break
        }
        if (!target && ans.texts.length) {
          const want = String(ans.texts[0]).toLowerCase()
          target = radios.find((r) => (r.innerText || '').toLowerCase().includes(want.slice(0, 30)))
        }
        if (target) {
          target.click()
          out.push({ i: i + 1, ok: true, key: ans.keys[0] || null })
        } else {
          out.push({ i: i + 1, ok: false, key: ans.keys[0] || null })
        }
      })
      const checked = document.querySelectorAll('.van-radio.checked').length
      return { total: tis.length, out, checked }
    }, list)
  }

  async function submit(frame) {
    try {
      return await frame.evaluate(() => {
        const btn =
          document.querySelector('#topWrap .top_control a') ||
          [...document.querySelectorAll('a,button')].find((a) => (a.textContent || '').trim() === '完成')
        if (!btn) return false
        btn.click()
        return true
      })
    } catch {
      return false
    }
  }

  async function readReport(page, timeout = 90_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const frame = page.frames().find((f) => /listen\/report\.html/.test(f.url()))
      if (frame) {
        await sleep(1500)
        const data = await frame
          .evaluate(() => {
            const text = document.body.innerText || ''
            const pairs = [...text.matchAll(/(\d{1,3}(?:\.\d)?)\s*分\s*\/\s*(\d{1,3}(?:\.\d)?)\s*分/g)].map((m) => ({
              got: Number(m[1]),
              full: Number(m[2]),
            }))
            const mineBox = text.match(/我的答案\s*([A-D]{1,4})/g) || []
            const rightBox = text.match(/正确答案\s*([A-D]{1,4})/g) || []
            return {
              pairs,
              gotSum: pairs.reduce((s, p) => s + p.got, 0),
              fullSum: pairs.reduce((s, p) => s + p.full, 0),
              mine: mineBox.map((s) => s.replace(/我的答案\s*/, '')),
              right: rightBox.map((s) => s.replace(/正确答案\s*/, '')),
              text: text.slice(0, 1500),
            }
          })
          .catch(() => null)
        return data
      }
      await sleep(1200)
    }
    return null
  }

  async function solve({ task, unit, level, user, qcontent, options = {} }) {
    const apiAnswers = answersFromApi(qcontent)
    const cacheKey = `${task.id}:${level.levelId}`
    const store = await loadStore()
    const cached = store[cacheKey]?.answers || null
    const answers = apiAnswers || cached
    if (!answers) return { ok: false, reason: '接口和缓存里都没有正确答案' }

    const page = await ui.openTest({
      userId: user.userId,
      taskId: task.id,
      unitId: unit.unitid || unit.unitId || unit.id,
      levelId: level.levelId,
    })
    try {
      await clickChallenge(page)
      const { frame, count } = await waitQuestions(page)
      if (!frame || !count) return { ok: false, reason: '听力题目没有加载出来', snapshot: await ui.snapshot(page) }
      logger?.step(`听力题共 ${count} 题，按接口答案填涂`)

      const filled = await fillAnswers(frame, answers)
      logger?.step(`已填 ${filled.out.filter((x) => x.ok).length}/${filled.total} 题`)

      if (!filled.out.every((x) => x.ok)) {
        return { ok: false, reason: '有题目没填上', filled, snapshot: await ui.snapshot(page) }
      }

      const submitted = await submit(frame)
      if (!submitted) return { ok: false, reason: '没有找到「完成」按钮', snapshot: await ui.snapshot(page) }
      logger?.step('已提交，等待报告页')

      const report = await readReport(page)
      const score =
        report && report.fullSum > 0 ? Math.round((report.gotSum / report.fullSum) * 100) : null

      if (apiAnswers) {
        store[cacheKey] = { at: Date.now(), levelName: level.levelName, answers, report: report?.pairs || [] }
        await saveStore(store)
      }

      return {
        ok: Boolean(report),
        score,
        rawScore: report ? `${report.gotSum}/${report.fullSum}` : null,
        mine: report?.mine || [],
        right: report?.right || [],
        answers: answers.map((a) => a.keys.join('')),
        filled: filled.out,
        tail: report?.text?.slice(-600) || '',
      }
    } finally {
      if (!options.keepPage) await page.close().catch(() => {})
    }
  }

  return { solve, loadStore, saveStore, answersFromApi }
}
