// 配置归一化：路径默认落在用户目录，避免写进 node_modules 里的插件包。
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function defaultDataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'fif-oral')
}

export function resolveConfig(raw, pluginRoot) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const dataDir = resolve(String(cfg.dataDir || defaultDataDir()))
  const browser = cfg.browser || {}
  const tts = cfg.tts || {}
  const python = tts.pythonPath
  return {
    pluginRoot,
    dataDir,
    workDir: join(dataDir, 'work'),
    profileDir: resolve(String(browser.profileDir || join(dataDir, 'profile'))),
    answersFile: join(dataDir, 'answers.json'),
    channel: String(browser.channel || 'auto'),
    headless: Boolean(browser.headless),
    pythonPath: Array.isArray(python) ? python : String(python || 'python'),
    engine: tts.engine === 'sapi' ? 'sapi' : 'edge',
    voice: String(tts.voice || 'en-US-AriaNeural'),
    sapiVoice: String(tts.sapiVoice || 'Microsoft Zira Desktop'),
    rate: String(tts.rate || '+0%'),
    targetScore: Number.isFinite(Number(cfg.targetScore)) ? Number(cfg.targetScore) : 60,
    maxLevels: Number(cfg.maxLevels || 0),
    retries: Number(cfg.retries || 1),
    autoLogin: Boolean(cfg.autoLogin),
    credentials: cfg.credentials || null,
    answerWaitMs: Number(cfg.answerWaitMs || 30_000),
  }
}
