// 注入到每个 frame 的麦克风替身。
// 把插件合成的语音伪装成麦克风输入，网页录音时录到的就是"我们想让它听到的声音"。
// 不依赖虚拟声卡 / VB-CABLE / pulseaudio；音频解码在页面里做，支持 mp3 与 wav，因此不需要 ffmpeg。
//
// 页面内 API：
//   __fifOral.feed(base64, mime)        压入单条音频（每轮 getUserMedia 消费一条）
//   __fifOral.feedGroup([{b64,mime}])   压入一组，一次录音里连播（整段朗读用）
//   __fifOral.playNext()                手动播队首
//   __fifOral.status()                  队列/播放/调用计数
//   __fifOral.lastRecording             最近一次录到的内容（诊断）
export const MIC_INJECT = String.raw`(() => {
  if (window.__fifOral) return;

  const SAMPLE_RATE = 48000;
  const state = {
    ctx: null,
    queue: [],
    playing: false,
    gumCalls: 0,
    plays: 0,
    lastError: '',
    lastRecording: null,
    gain: 0.95,
    activeMaster: null
  };
  window.__fifOral = state;

  function ensureCtx() {
    if (!state.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('AudioContext 不可用');
      state.ctx = new AC({ sampleRate: SAMPLE_RATE });
    }
    if (state.ctx.state === 'suspended') state.ctx.resume().catch(() => {});
    return state.ctx;
  }

  function newChannel() {
    const ctx = ensureCtx();
    const dest = ctx.createMediaStreamDestination();
    const master = ctx.createGain();
    master.gain.value = state.gain;
    master.connect(dest);

    // 低电平白噪底：防止前端把"完全静音"当成没有输入而提前结束录音
    const len = Math.floor(ctx.sampleRate * 1.0);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * 0.0006;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    noise.connect(master);
    try { noise.start(); } catch (e) {}

    state.activeMaster = master;
    return { dest, master };
  }

  async function decode(b64, mime) {
    const ctx = ensureCtx();
    const res = await fetch('data:' + (mime || 'audio/wav') + ';base64,' + b64);
    const ab = await res.arrayBuffer();
    return await ctx.decodeAudioData(ab);
  }

  state.feed = async (b64, mime) => {
    const audio = await decode(b64, mime);
    state.queue.push({ buffers: [audio], gapMs: 0 });
    return { queued: state.queue.length, duration: audio.duration };
  };

  state.feedGroup = async (items, gapMs) => {
    const buffers = [];
    for (const it of items) buffers.push(await decode(it.b64, it.mime));
    const total = buffers.reduce((s, b) => s + b.duration, 0);
    state.queue.push({ buffers, gapMs: gapMs || 0 });
    return { queued: state.queue.length, duration: total };
  };

  state.clear = () => { state.queue.length = 0; };

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  state.playNext = async () => {
    const ctx = ensureCtx();
    const job = state.queue.shift();
    if (!job) return { played: false, queued: 0 };
    const master = state.activeMaster || newChannel().master;
    state.playing = true;
    let played = 0;
    for (let i = 0; i < job.buffers.length; i += 1) {
      if (i > 0 && job.gapMs > 0) await wait(job.gapMs);
      const audio = job.buffers[i];
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(master);
      await new Promise((resolve) => {
        src.onended = () => resolve();
        try { src.start(); } catch (e) { state.lastError = String(e); resolve(); }
      });
      played += 1;
    }
    state.playing = false;
    state.plays += 1;
    return { played: true, segments: played, queued: state.queue.length };
  };

  state.status = () => ({
    queued: state.queue.length,
    playing: state.playing,
    plays: state.plays,
    gumCalls: state.gumCalls,
    ctxState: state.ctx ? state.ctx.state : null,
    lastError: state.lastError
  });

  // ---- getUserMedia 拦截 ----
  const md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === 'function') {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async function (constraints) {
      const wantsAudio = !constraints || constraints.audio !== false;
      if (!wantsAudio) return orig(constraints);
      if (constraints && constraints.video) return orig(constraints);
      state.gumCalls += 1;
      const channel = newChannel();
      setTimeout(() => {
        state.playNext().catch((e) => { state.lastError = String(e); });
      }, 300);
      return channel.dest.stream;
    };
  }

  // ---- 录到的内容留档，便于诊断 ----
  const OrigMR = window.MediaRecorder;
  if (OrigMR) {
    const Patched = class extends OrigMR {
      constructor(stream, options) {
        super(stream, options);
        this.__chunks = [];
        this.addEventListener('dataavailable', (e) => {
          if (e.data && e.data.size) this.__chunks.push(e.data);
        });
        this.addEventListener('stop', async () => {
          try {
            const type = this.mimeType || 'audio/webm';
            const blob = new Blob(this.__chunks, { type });
            const ab = await blob.arrayBuffer();
            state.lastRecording = { size: ab.byteLength, mime: type, at: Date.now() };
          } catch (e) {
            state.lastRecording = { error: String(e) };
          }
        });
      }
    };
    try { window.MediaRecorder = Patched; } catch (e) {}
  }
})();`
