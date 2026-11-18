// 端到端验证"TTS → 注入麦克风 → 网页录音"这条链路，不需要 FiF 账号。
// 用法：node test/mic-test.mjs
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTts } from '../lib/tts.js'
import { createLog } from '../lib/log.js'
import { resolveConfig } from '../lib/config.js'
import { MIC_INJECT } from '../lib/mic-inject.js'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

const log = createLog()
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const config = resolveConfig({ dataDir: `${root.replace(/\\/g, '/')}data/mic-test` }, root.replace(/\\/g, '/'))

const HTML = `<!doctype html><meta charset="utf-8"><title>mic-test</title>
<body>
<h3>recording harness</h3>
<button id="go">start</button>
<pre id="out"></pre>
<script>
const out = document.getElementById('out');
window.__done = null;
async function go() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start();
  await new Promise((r) => setTimeout(r, 7000));
  rec.stop();
  await new Promise((r) => { rec.onstop = r; });
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const ab = await blob.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(ab);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  window.__done = { size: ab.byteLength, b64: btoa(bin) };
  out.textContent = 'done ' + ab.byteLength + ' bytes';
}
document.getElementById('go').addEventListener('click', () => { go().catch((e) => { out.textContent = 'ERR ' + e; }); });
</script>`

async function main() {
  await mkdir(config.workDir, { recursive: true })
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(HTML)
  })
  await new Promise((r) => server.listen(8899, '127.0.0.1', r))
  log.info('harness 已启动 http://127.0.0.1:8899')

  const tts = createTts(config, log)
  const synth = await tts.synthesize([
    'The quick brown fox jumps over the lazy dog.',
    'Reading aloud is a skill that improves with practice.',
  ])
  log.info(`TTS 合成 ${synth.items.length} 条，合计约 ${Math.round(synth.durationMs / 100) / 10}s`)

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  })
  const context = await browser.newContext()
  await context.addInitScript({ content: MIC_INJECT })
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:8899/')

  // 组模式：两条连续播
  const fed = await page.evaluate(async (items) => {
    if (!window.__fifOral) return { injected: false }
    return await window.__fifOral.feedGroup(items, 260)
  }, synth.items.map((i) => ({ b64: i.b64, mime: i.mime })))
  log.info(`注入状态：${JSON.stringify(fed)}`)

  await page.click('#go')
  await page.waitForFunction(() => window.__done, null, { timeout: 40_000 })
  const done = await page.evaluate(() => ({ size: window.__done.size, b64: window.__done.b64 }))
  const mic = await page.evaluate(() => (window.__fifOral ? window.__fifOral.status() : null))
  log.info(`网页录到 ${done.size} bytes；注入器状态 ${JSON.stringify(mic)}`)

  const webm = `${config.workDir}/mic-test.webm`
  const wav = `${config.workDir}/mic-test.wav`
  await writeFile(webm, Buffer.from(done.b64, 'base64'))
  await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', webm, wav])
  const { stderr } = await execFileAsync('ffmpeg', ['-hide_banner', '-i', wav, '-af', 'volumedetect', '-f', 'null', '-'])
  log.info(`录入文件：${wav}`)
  const mean = stderr.match(/mean_volume: ([-\d.]+) dB/)
  const max = stderr.match(/max_volume: ([-\d.]+) dB/)
  console.log(`音量检测 mean=${mean?.[1]} dB max=${max?.[1]} dB`)
  await browser.close()
  server.close()
}

main().catch((err) => {
  console.error('FAILED', err)
  process.exit(1)
})
