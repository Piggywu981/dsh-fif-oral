// TTS 层：文本 → 音频（edge-tts 输出 mp3，SAPI 兜底输出 wav）。
// 不再依赖 ffmpeg：解码交给页面里的 AudioContext.decodeAudioData。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describeError } from './log.js'

const execFileAsync = promisify(execFile)

// edge-tts 默认输出 24kHz / 48kbps 单声道 mp3，用来估算时长足够
const EDGE_BITRATE = 48_000

function sha1(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 20)
}

export function createTts(config, logger) {
  const cacheDir = join(config.workDir, 'tts-cache')
  const tmpDir = join(config.workDir, 'tmp')
  const pythonCandidates = Array.isArray(config.pythonPath) ? config.pythonPath : [config.pythonPath, 'python3', 'py']

  let resolvedPython = null

  async function pickPython() {
    if (resolvedPython) return resolvedPython
    for (const candidate of pythonCandidates) {
      if (!candidate) continue
      try {
        await execFileAsync(candidate, ['-c', 'import edge_tts'], { windowsHide: true, timeout: 20_000 })
        resolvedPython = candidate
        logger?.info(`TTS 使用 Python: ${candidate}`)
        return candidate
      } catch {
        /* 试下一个 */
      }
    }
    resolvedPython = null
    return null
  }

  async function runEdge(text, voice, rate, outFile) {
    const python = await pickPython()
    if (!python) throw new Error('找不到带 edge_tts 的 Python（pip install edge-tts），也没有 ffmpeg/SAPI 兜底可用')
    await execFileAsync(python, ['-m', 'edge_tts', '--text', text, '--voice', voice, '--rate', rate, '--write-media', outFile], {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    })
  }

  async function runSapi(text, voice, outFile) {
    if (process.platform !== 'win32') throw new Error('SAPI 只在 Windows 可用')
    const script = [
      'Add-Type -AssemblyName System.Speech',
      '$ErrorActionPreference = "Stop"',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `try { $s.SelectVoice('${String(voice).replace(/'/g, "''")}') } catch {}`,
      `$s.SetOutputToWaveFile('${String(outFile).replace(/'/g, "''")}')`,
      '$text = [Console]::In.ReadToEnd()',
      '$s.Speak($text)',
      '$s.Dispose()',
    ].join('\n')
    await new Promise((resolve, reject) => {
      const child = execFile(
        process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) reject(new Error(`SAPI 合成失败: ${describeError(err)} ${stderr || ''}`))
          else resolve()
        },
      )
      child.stdin.end(text)
    })
  }

  /** 单句合成 → { b64, mime, durationMs }（磁盘缓存）。 */
  async function synthOne(text, voice, rate) {
    const key = sha1(`${config.engine}|${voice}|${rate}|${text}`)
    for (const ext of ['mp3', 'wav']) {
      const cacheFile = join(cacheDir, `${key}.${ext}`)
      try {
        const st = await stat(cacheFile)
        if (st.size > 800) {
          const body = await readFile(cacheFile)
          const mime = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav'
          const durationMs = ext === 'mp3' ? Math.round((body.length * 8 * 1000) / EDGE_BITRATE) : null
          return { b64: body.toString('base64'), mime, durationMs, bytes: body.length }
        }
      } catch {
        /* 未命中 */
      }
    }

    await mkdir(cacheDir, { recursive: true })
    await mkdir(tmpDir, { recursive: true })
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const mp3 = join(tmpDir, `tts-${stamp}.mp3`)
    const wav = join(tmpDir, `tts-${stamp}.wav`)

    try {
      if (config.engine !== 'sapi') {
        try {
          await runEdge(text, voice, rate, mp3)
          const body = await readFile(mp3)
          await writeFile(join(cacheDir, `${key}.mp3`), body).catch(() => {})
          return { b64: body.toString('base64'), mime: 'audio/mpeg', durationMs: Math.round((body.length * 8 * 1000) / EDGE_BITRATE), bytes: body.length }
        } catch (err) {
          logger?.warn(`edge-tts 不可用，回退 SAPI：${describeError(err)}`)
        }
      }
      await runSapi(text, config.sapiVoice, wav)
      const body = await readFile(wav)
      await writeFile(join(cacheDir, `${key}.wav`), body).catch(() => {})
      return { b64: body.toString('base64'), mime: 'audio/wav', durationMs: null, bytes: body.length }
    } finally {
      await rm(mp3, { force: true }).catch(() => {})
      await rm(wav, { force: true }).catch(() => {})
    }
  }

  /**
   * 把一个"录音回合"需要的文本合成好。
   * @param {string[]} segments
   * @returns {Promise<{items:{b64,mime,durationMs}[], durationMs:number, segments:string[]}>}
   */
  async function synthesize(segments, opts = {}) {
    const voice = opts.voice || config.voice
    const rate = opts.rate || config.rate
    const texts = segments.map((s) => String(s || '').trim()).filter(Boolean)
    if (!texts.length) throw new Error('没有可朗读的文本')
    const items = []
    let durationMs = 0
    for (const text of texts) {
      const one = await synthOne(text, voice, rate)
      items.push(one)
      durationMs += one.durationMs || 0
    }
    return { items, durationMs, segments: texts }
  }

  async function listVoices() {
    const python = await pickPython()
    if (!python) return ['找不到带 edge_tts 的 Python，无法列音色']
    try {
      const { stdout } = await execFileAsync(python, ['-m', 'edge_tts', '--list-voices'], {
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      return stdout
        .split(/\r?\n/)
        .filter((line) => /en-US|en-GB|en-AU/.test(line))
        .slice(0, 60)
    } catch (err) {
      return [`音色列表不可用：${describeError(err)}`]
    }
  }

  async function doctor() {
    const python = await pickPython()
    return {
      engine: config.engine,
      python: python || '未找到（edge-tts 需要 pip install edge-tts）',
      voice: config.voice,
      rate: config.rate,
      sapiVoice: config.sapiVoice,
      ffmpeg: '不需要（解码在浏览器里做）',
    }
  }

  return { synthesize, listVoices, doctor }
}
