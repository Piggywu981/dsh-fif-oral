// FiF 口语（fifedu.com）接口客户端：任务 → 单元 → 关卡 → 题目内容 → 挑战提交。
// 所有请求走浏览器上下文（共享 cookie / 登录态），跨域由 Playwright 的 request 处理。
import { describeError } from './log.js'

export const API = {
  userInfo: 'https://www.fifedu.com/iplatform-zjzx/common/connect',
  taskList: 'https://moral.fifedu.com/kyxl-app/stu/task/teaTaskList',
  taskDetail: 'https://moral.fifedu.com/kyxl-app/task/stu/teaTaskDetail',
  unitInfo: (unitId, taskId) =>
    `https://moral.fifedu.com/kyxl-app/stu/column/stuUnitInfo?unitId=${encodeURIComponent(unitId)}&taskId=${encodeURIComponent(taskId)}`,
  levelInfo: 'https://moral.fifedu.com/kyxl-app/column/getLevelInfo',
  submitChallenge: 'https://moral.fifedu.com/kyxl-app-challenge/evaluation/submitChallengeResults',
}

export const TEST_URL = (userId, taskId, unitId, levelId) =>
  `https://static.fifedu.com/static/fiforal/kyxl-web-static/student-h5/index.html#/pages/webView/testWebView/testWebView?userId=${encodeURIComponent(
    userId,
  )}&taskId=${encodeURIComponent(taskId)}&unitId=${encodeURIComponent(unitId)}&gId=${encodeURIComponent(levelId)}`

/** 题型判定：区分"听力选择题"（带 right_answer/choise_list）与"朗读"（带 recordingTime/title）。 */
export function classifyLevel(levelName = '', qcontent) {
  const name = String(levelName || '')
  const questions = (qcontent?.item || []).flatMap((i) => i.questions || [])
  const hasRightAnswer = questions.some((q) => Array.isArray(q.right_answer) && q.right_answer.length)
  const hasChoice = questions.some((q) => (q.answer || []).some?.((a) => Array.isArray(a.choise_list) && a.choise_list.length))
  if (hasRightAnswer || hasChoice) return 'listening'
  if (/听力|听音|listen/i.test(name)) return 'listening'
  if (/朗读|跟读|read|review/i.test(name)) return 'reading'
  const hasRecording = questions.some((q) => q.recordingTime !== undefined)
  if (hasRecording) return 'reading'
  return 'reading'
}

/** 从 getLevelInfo 的响应里抽出"挑战"模式的题目内容。 */
export function pickChallengeQuestion(body) {
  const moshi = body?.data?.content?.moshi
  if (!Array.isArray(moshi)) return null
  const hit =
    moshi.find((m) => m?.name === '挑战') ||
    moshi.find((m) => /挑战/.test(String(m?.name || ''))) ||
    moshi[0]
  return hit?.question?.qcontent || null
}

/** 把 qcontent 拆成"按角色顺序的朗读文本数组"（短文朗读 / 角色扮演都适用）。 */
export function extractReadSegments(qcontent) {
  if (!qcontent) return []
  const items = qcontent.item || []
  const questions = []
  for (const item of items) for (const q of item.questions || []) questions.push(q)

  const hasPhoto = questions.some((q) => q.photo !== undefined && q.photo !== null && q.photo !== '')

  const stripTags = (s) =>
    String(s || '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim()

  if (!hasPhoto) {
    return questions.map((q) => stripTags(q.title)).filter(Boolean)
  }

  // 角色扮演：同一角色按 recordingTime 里的序号定位，缺失序号的追加到尾部
  const roleStart = {}
  const answerMap = {}
  for (const q of questions) {
    const raw = String(q.recordingTime || '').trim()
    const idx = raw ? Number.parseInt(raw.split('#')[0], 10) : -1
    if (!Number.isNaN(idx) && idx > 0) roleStart[q.photo] = idx
    else if (!(q.photo in roleStart)) roleStart[q.photo] = 0
  }
  for (const role of Object.keys(roleStart)) {
    answerMap[role] = new Array(roleStart[role] || 0).fill('')
  }
  for (const q of questions) {
    const raw = String(q.recordingTime || '').trim()
    const idx = raw ? Number.parseInt(raw.split('#')[0], 10) : -1
    const text = stripTags(q.title)
    if (!text) continue
    if (!answerMap[q.photo]) answerMap[q.photo] = []
    if (!Number.isNaN(idx) && idx > 0) {
      answerMap[q.photo][idx - 1] = (answerMap[q.photo][idx - 1] || '') + text
    } else {
      answerMap[q.photo].push(text)
    }
  }

  let order = String(qcontent.sample || '')
    .split('#')
    .filter(Boolean)
  if (!order.length) order = Object.keys(answerMap)

  const out = []
  for (const role of order) {
    for (const line of answerMap[role] || []) {
      const t = String(line || '').trim()
      if (t) out.push(t)
    }
  }
  return out
}

/** 把 qcontent 展开成题目列表（听力选择题：选项在 answer[0].choise_list，答案在 right_answer）。 */
export function extractQuestions(qcontent) {
  if (!qcontent) return []
  const items = qcontent.item || []
  const out = []
  let index = 0
  for (const item of items) {
    const stem = String(item.title || item.name || '').trim()
    for (const q of item.questions || []) {
      index += 1
      const choiseList = (q.answer || []).find((a) => Array.isArray(a.choise_list) && a.choise_list.length)?.choise_list || []
      const options = choiseList.length
        ? choiseList.map((c) => ({ key: String(c.choise_name || '').trim(), text: String(c.title || '').trim() }))
        : null
      const right = Array.isArray(q.right_answer) ? q.right_answer.map((x) => String(x).trim()) : q.right_answer ? [String(q.right_answer)] : []
      out.push({
        index,
        stem,
        title: String(q.title || '').trim(),
        group: String(q.group ?? ''),
        type: q.question_type ?? null,
        score: q.score ?? null,
        options,
        answer: right.length ? right : null,
        analysis: String(q.analysis || '').slice(0, 400),
        raw: q,
      })
    }
  }
  return out
}

export function createFifClient({ browser, logger }) {
  async function call(url, options) {
    const page = await browser.ensureH5Page()
    const res = await browser.request(page, url, options)
    if (res.status !== 200) {
      throw new Error(`接口 ${url} HTTP ${res.status}：${JSON.stringify(res.body).slice(0, 400)}`)
    }
    return res.body
  }

  async function userInfo() {
    const body = await call(API.userInfo, { method: 'GET' })
    const data = body?.data || {}
    if (!data.userId) throw new Error(`未取得登录信息，可能尚未登录：${JSON.stringify(body).slice(0, 300)}`)
    return data
  }

  async function taskList(status = 1, pageNo = 1) {
    const user = await userInfo()
    const body = await call(API.taskList, {
      method: 'POST',
      form: { userId: user.userId, status, page: pageNo },
    })
    const list = body?.data?.ttiList || []
    return { user, raw: body, tasks: list }
  }

  async function taskDetail(taskId) {
    const user = await userInfo()
    const body = await call(API.taskDetail, { method: 'POST', form: { userId: user.userId, id: taskId } })
    const list = body?.data?.ttdList || []
    return { raw: body, units: list }
  }

  async function unitInfo(unitId, taskId) {
    const body = await call(API.unitInfo(unitId, taskId), { method: 'GET' })
    return body?.data || {}
  }

  async function levelInfo(levelId) {
    const body = await call(API.levelInfo, { method: 'POST', form: { levelId } })
    if (body?.status !== 1 && !body?.data) {
      throw new Error(`获取关卡内容失败：${JSON.stringify(body).slice(0, 300)}`)
    }
    return body
  }

  /** 关卡全貌：含题型、朗读文本、题目列表、原始内容。 */
  async function describeLevel(level) {
    const body = await levelInfo(level.levelId)
    const qcontent = pickChallengeQuestion(body)
    const levelName = level.levelName || level.name || ''
    const kind = classifyLevel(levelName, qcontent)
    return {
      levelId: level.levelId,
      levelName,
      kind,
      score: level.levelScore,
      lock: level.lockStatus ?? level.lock ?? null,
      segments: extractReadSegments(qcontent),
      questions: extractQuestions(qcontent),
      qcontent,
      raw: body,
    }
  }

  async function submitChallenge(payload) {
    return await call(API.submitChallenge, { method: 'POST', json: payload })
  }

  return { userInfo, taskList, taskDetail, unitInfo, levelInfo, describeLevel, submitChallenge, call }
}
