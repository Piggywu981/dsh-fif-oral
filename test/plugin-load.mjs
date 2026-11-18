// 不启动 DSH、不启动浏览器，只验证插件能否被 cordis 正常装配：inject 声明、工具注册、effect 清理。
// 用法：node test/plugin-load.mjs
import { apply, inject } from '../index.js'

const registered = []
const disposers = []

const ctx = {
  logger: { info: (...a) => console.log('[ctx.logger]', ...a), warn: () => {} },
  effect(fn, label) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push({ label, dispose })
    return () => {}
  },
  tools: {
    register(def) {
      registered.push({ name: def.name, hasSchema: Boolean(def.parameters), hasRender: Boolean(def.output?.render) })
      return () => {}
    },
  },
}

apply(ctx, { browser: { headless: true }, tts: { engine: 'edge' }, targetScore: 60 })

console.log('inject =', inject)
console.log('注册工具数 =', registered.length)
for (const t of registered) {
  console.log(` - ${t.name}${t.hasSchema ? '' : ' [缺 parameters]'}${t.hasRender ? '' : ' [缺 render]'}`)
}
console.log('effect 清理器 =', disposers.length)

const missing = registered.filter((t) => !t.hasSchema || !t.hasRender)
if (missing.length) {
  console.error('FAIL: 有工具缺 schema/render', missing)
  process.exit(1)
}
console.log('OK')
