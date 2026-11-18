// 后台 runner：串起"任务 → 单元 → 关卡 → 听力/朗读"，状态可轮询。
import { describeError, sleep } from './log.js'

export function createRunner({ fif, reading, listening, tts, log, config, browser }) {
  const state = {
    phase: 'idle',
    running: false,
    startedAt: 0,
    finishedAt: 0,
    current: null,
    results: [],
    error: '',
    stopped: false,
  }

  function status() {
    return {
      phase: state.phase,
      running: state.running,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      current: state.current,
      error: state.error,
      results: state.results.slice(-40),
      totalLevels: state.results.length,
      done: state.results.filter((r) => r.ok).length,
      failed: state.results.filter((r) => !r.ok).length,
    }
  }

  function stop() {
    state.stopped = true
    log.warn('收到停止请求，当前关卡结束后停止')
  }

  async function runLevel({ task, unit, user, level, mode }) {
    state.current = { taskId: task.id, taskName: task.taskName || task.name, unitName: unit.unitName, levelId: level.levelId, levelName: level.levelName }
    const detail = await fif.describeLevel(level)
    log.step(`关卡「${detail.levelName}」题型=${detail.kind} 现有分数=${detail.score} 文本段=${detail.segments.length} 题=${detail.questions.length}`)

    const want = mode === 'all' ? detail.kind : mode
    if (want === 'listening' && detail.kind !== 'listening') {
      return { ok: false, skipped: true, reason: `关卡题型为 ${detail.kind}，不按听力处理` }
    }
    if (want === 'reading' && detail.kind !== 'reading') {
      return { ok: false, skipped: true, reason: `关卡题型为 ${detail.kind}，不按朗读处理` }
    }

    if (detail.kind === 'listening') {
      return await listening.solve({ task, unit, user, level, qcontent: detail.qcontent })
    }
    return await reading.solve({ task, unit, user, level, segments: detail.segments })
  }

  async function runOnce({ taskId, mode = 'all' }) {
    const { user, tasks } = await fif.taskList(1, 1)
    log.info(`登录用户 ${user.realName || user.userName || user.userId}，进行中任务 ${tasks.length} 个`)
    if (!tasks.length) return { ok: false, reason: '没有进行中的 AI 任务' }

    const targets = taskId ? tasks.filter((t) => String(t.id) === String(taskId) || String(t.taskId) === String(taskId)) : tasks
    if (!targets.length) return { ok: false, reason: `未找到任务 ${taskId}` }

    for (const task of targets) {
      if (state.stopped) break
      log.step(`任务「${task.taskName || task.name}」id=${task.id}`)
      const { units } = await fif.taskDetail(task.id)
      for (const unit of units) {
        if (state.stopped) break
        log.step(`单元「${unit.unitName}」`)
        const info = await fif.unitInfo(unit.unitid || unit.unitId || unit.id, task.taskId || task.id)
        const levels = info.levelList || []
        for (const level of levels) {
          if (state.stopped) break
          if (config.maxLevels && state.results.length >= config.maxLevels) break
          if (Number(level.levelScore || 0) >= config.targetScore) {
            log.info(`关卡「${level.levelName}」已达标(${level.levelScore})，跳过`)
            continue
          }
          try {
            const result = await runLevel({ task, unit, user, level, mode })
            const got = result.score ?? result.total ?? null
            state.results.push({ at: Date.now(), levelName: level.levelName, levelId: level.levelId, ...result })
            log[result.ok ? 'info' : 'warn'](
              `关卡「${level.levelName}」→ ${result.ok ? '完成' : '未完成'}${got !== null ? `（${got} 分）` : ''}${result.reason ? `：${result.reason}` : ''}`,
            )
          } catch (err) {
            const msg = describeError(err)
            state.results.push({ at: Date.now(), levelName: level.levelName, levelId: level.levelId, ok: false, reason: msg })
            log.error(`关卡「${level.levelName}」异常：${msg}`)
          }
          await sleep(1200)
        }
      }
    }
    return { ok: true }
  }

  function start(opts = {}) {
    if (state.running) return { started: false, reason: '已有任务在跑', status: status() }
    state.running = true
    state.stopped = false
    state.phase = 'running'
    state.startedAt = Date.now()
    state.finishedAt = 0
    state.error = ''
    state.results = []

    ;(async () => {
      try {
        const result = await runOnce(opts)
        if (!result.ok) {
          state.error = result.reason || '未执行'
          state.phase = 'failed'
        } else {
          state.phase = state.stopped ? 'stopped' : 'done'
        }
      } catch (err) {
        state.error = describeError(err)
        state.phase = 'failed'
        log.error(`runner 失败：${state.error}`)
      } finally {
        state.running = false
        state.current = null
        state.finishedAt = Date.now()
      }
    })()

    return { started: true, status: status() }
  }

  return { start, status, stop }
}
