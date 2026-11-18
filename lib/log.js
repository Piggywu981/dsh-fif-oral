// 内存环形日志：工具结果、后台 runner 与面板共用一份。
export function createLog(limit = 1200) {
  /** @type {{t:number,level:string,msg:string}[]} */
  const lines = []
  const listeners = new Set()

  function push(level, msg) {
    const line = { t: Date.now(), level, msg: String(msg ?? '') }
    lines.push(line)
    if (lines.length > limit) lines.splice(0, lines.length - limit)
    for (const fn of listeners) {
      try {
        fn(line)
      } catch {
        /* 监听器异常不影响主流程 */
      }
    }
    return line
  }

  return {
    info: (m) => push('info', m),
    step: (m) => push('step', m),
    warn: (m) => push('warn', m),
    error: (m) => push('error', m),
    push,
    tail: (n = 80) => lines.slice(-Math.max(1, Math.min(limit, n))),
    all: () => lines.slice(),
    clear: () => {
      lines.length = 0
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

export function describeError(err) {
  if (!err) return '未知错误'
  if (typeof err === 'string') return err
  const parts = []
  if (err.message) parts.push(err.message)
  else parts.push(String(err))
  if (err.stack && !err.message) parts.push(err.stack.split('\n').slice(0, 3).join(' | '))
  return parts.join(' :: ')
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
