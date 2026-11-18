// dsh-fif-oral：FiF 口语训练系统（AI 任务）自动答题插件 Host 半。
// 听力走"取答案→回填提交"，朗读走"TTS→注入麦克风→录音提交"。
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './lib/config.js'
import { createLog } from './lib/log.js'
import { createBrowserHost } from './lib/browser.js'
import { createFifClient } from './lib/fif.js'
import { createUi } from './lib/ui.js'
import { createTts } from './lib/tts.js'
import { createReadingSolver } from './lib/reading.js'
import { createListeningSolver } from './lib/listening.js'
import { createRunner } from './lib/runner.js'
import { registerTools } from './lib/tools.js'

export const inject = ['tools']

export function apply(ctx, rawConfig) {
  const pluginRoot = dirname(fileURLToPath(import.meta.url))
  const config = resolveConfig(rawConfig, pluginRoot)
  const log = createLog()

  mkdir(config.workDir, { recursive: true }).catch(() => {})

  const browser = createBrowserHost({ config, logger: log })
  const fif = createFifClient({ browser, logger: log })
  const ui = createUi({ browser, logger: log })
  const tts = createTts(config, log)
  const reading = createReadingSolver({ browser, ui, tts, logger: log })
  const listening = createListeningSolver({ browser, ui, tts, logger: log, config })
  const runner = createRunner({ fif, reading, listening, tts, log, config, browser })

  registerTools({ ctx, config, log, browser, fif, ui, tts, reading, listening, runner })

  ctx.effect(() => () => browser.close().catch(() => {}), 'fif-oral.browser')

  ctx.logger?.info?.('fif-oral: 已加载（profile=%s, voice=%s）', config.profileDir, config.voice)
}
