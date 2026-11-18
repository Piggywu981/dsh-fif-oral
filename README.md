# dsh-fif-oral

DeepSeek Harness 插件：自动完成 **FiF 口语训练系统**（fifedu.com）的 **AI 任务**。

一个课程通常由 3 个听力关卡 + 3 个朗读关卡组成（本仓库实测课程：`Section A/B/C` + `Section A/B/C Review`）。插件对两类关卡分别处理：

| 关卡类型 | 做法 |
| --- | --- |
| 听力（Section A/B/C） | `getLevelInfo` 接口直接返回 `right_answer`，按题点选 `.van-radio` 后点右上「完成」，一次提交拿满分；答案写入 `data/answers.json` 可复用 |
| 朗读（\* Review） | edge-tts 逐句合成 WAV → 注入 `getUserMedia` 冒充麦克风 → 每轮录音自动播放一句 → 点「结束录音」→ 平台 AI 评分 |

同目录下的 `test/serve.mjs` 提供一个本地调试服务器（同一套 lib），可在不重启 DSH 的情况下交互式驱动。

## 它怎么绕开"要真实麦克风"

不装虚拟声卡、不用 VB-CABLE、不需要 pulseaudio：

1. 浏览器启动时 `addInitScript` 注入脚本（`lib/mic-inject.js`）；
2. 脚本覆盖 `navigator.mediaDevices.getUserMedia`，返回一个 `MediaStreamAudioDestinationNode` 造出来的合法 `MediaStream`；
3. 插件把 TTS 合成好的 WAV 用 `AudioContext.decodeAudioData` 解码后推进队列，网页每调用一次 `getUserMedia`（即每轮录音）就播一条；
4. 轨道里混了 -64 dBFS 白噪，避免前端把"完全静音"判成没有输入。

FiF 朗读关卡是**逐句录音**：点「开始挑战」后自动开始第 1 句，之后每点一次「结束录音」提交当前句并自动开始下一句。所以实现上是先把 N 句全部入队，每轮 `getUserMedia` 消费一条。

## 实测结果（2026-11，真实账号）

课程 `四六级听力,2025年12月六级真题1`（任务「六级听力7」）：

| 关卡 | 类型 | 结果 |
| --- | --- | --- |
| Section A | 听力 8 题 | 100 / 100 |
| Section B | 听力 7 题 | 100 / 100 |
| Section C | 听力 10 题 | 100 / 100 |
| Section A Review | 朗读 8 句 | 98 分（发音 98 / 流利度 99 / 完整度 100） |
| Section B Review | 朗读 7 句 | 98 分 |
| Section C Review | 朗读 10 句 | 98 分 |

任务完成度回到 **100%**。

## 安装到 DSH

```powershell
# 建 node_modules junction + 往 profile 的 cordis.patch.yml 写一条带标记的 patch
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1

# 卸载（删 junction + 移除 patch 块）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Uninstall

# 重启 DSH 后生效
```

**为什么不用 pnpm install**：DSH 运行时占着 `profile/node_modules`，`pnpm install` 会卡在
`ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`（拒绝访问）。插件自己的依赖（`playwright-core`）
在本仓库 `node_modules` 里，junction 之后 Node 从插件目录向上解析即可，不需要动 profile 的依赖树。

脚本做的事：

1. 在 `<DSH_HOME>\profiles\desktop\node_modules\dsh-fif-oral` 建 junction 指向本仓库；
2. 在 `<DSH_HOME>\profiles\desktop\cordis.patch.yml` 末尾写入
   `# >>> dsh-fif-oral … # <<< dsh-fif-oral` 包住的 insert 条目（幂等，重复执行不会叠加）；
3. 首次修改前备份成 `cordis.patch.yml.bak-fif-oral`。

## 首次使用

```
fif_open            # 弹出浏览器，手动登录一次（cookie 存进 data/profile）
fif_status          # 确认 hasToken=true
fif_tasks           # 列出进行中的 AI 任务
fif_task {taskId}   # 看单元/关卡/题型/当前分数
fif_run             # 后台跑：听力取答案回填 + 朗读 TTS 提交
fif_status          # 轮询进度
```

也可以直接命令行跑（不经过 DSH）：

```powershell
node test/serve.mjs                       # http://127.0.0.1:8901
# 另开一个窗口：
curl.exe -X POST http://127.0.0.1:8901/open   -H "Content-Type: application/json" -d '{"page":"login"}'
curl.exe -X POST http://127.0.0.1:8901/tasks
curl.exe -X POST http://127.0.0.1:8901/solve  -H "Content-Type: application/json" -d '{\"taskId\":\"...\",\"unitId\":\"...\",\"levelId\":\"...\"}'
```

## 工具清单

| 工具 | 作用 |
| --- | --- |
| `fif_status` | 浏览器/登录态/后台进度/最近日志 |
| `fif_open` | 启动持久化浏览器（首次手动登录） |
| `fif_login` | 账号密码自动登录并抓 token |
| `fif_tasks` | 进行中的 AI 任务列表 |
| `fif_task` | 任务结构：单元 → 关卡（题型、分数、朗读段数） |
| `fif_probe` | 打开关卡页 dump 真实 DOM/接口内容（改版排查用） |
| `fif_run` | 后台执行：`mode=all\|listening\|reading` |
| `fif_stop` | 停止后台任务 |
| `fif_log` | 查看运行日志 |
| `fif_voices` | 列出 edge-tts 英文音色 |
| `fif_doctor` | 体检：浏览器内核、Python + edge-tts、音色、登录态 |
| `fif_close` | 关闭浏览器、释放麦克风与 profile 锁 |

## 配置

`cordis.patch.yml`（或 profile 的 `cordis.patch.yml` 里同 id 覆盖）：

```yaml
- id: fif-oral
  name: dsh-fif-oral
  config:
    browser:
      channel: auto          # auto | chrome | msedge | chromium
      headless: false        # 建议 false：首次登录要看窗口
      profileDir: ""         # 默认 <dataDir>/profile
    tts:
      engine: edge           # edge | sapi（离线兜底）
      voice: en-US-AriaNeural
      rate: "+0%"
      pythonPath: python     # 也可以是 ["python","python3","py"] 依次探测
    dataDir: ""              # 默认 ~/.dsh/fif-oral
    targetScore: 60          # 关卡分数 ≥ 它则跳过
    maxLevels: 0             # 0 = 不限制
```

## 接口（逆向所得）

| 用途 | 端点 |
| --- | --- |
| 用户信息 | `GET https://www.fifedu.com/iplatform-zjzx/common/connect` |
| 任务列表 | `POST https://moral.fifedu.com/kyxl-app/stu/task/teaTaskList` |
| 任务详情 | `POST https://moral.fifedu.com/kyxl-app/task/stu/teaTaskDetail` |
| 单元关卡 | `GET https://moral.fifedu.com/kyxl-app/stu/column/stuUnitInfo?unitId=&taskId=` |
| 关卡内容（含答案） | `POST https://moral.fifedu.com/kyxl-app/column/getLevelInfo` |
| 挑战提交 | `POST https://moral.fifedu.com/kyxl-app-challenge/evaluation/submitChallengeResults` |

鉴权头：`Authorization: Bearer <localStorage.Authorization>` + `source: <localStorage.source>`。

听力答案位置：`data.content.moshi[name=挑战].question.qcontent.item[].questions[].right_answer`
（选项在同级 `answer[0].choise_list[].choise_name / title`）。

## 页面结构要点（2026-11 快照）

- 关卡容器：`student-h5/#/pages/webView/testWebView/testWebView?...&gId=<levelId>`
- 听力题：`listen/index.html` frame，每題 `.ti_container`，选项 `.van-radio`（`<em>A</em>` 是题号），提交按钮 `#topWrap .top_control a`（文案「完成」），提交后跳 `listen/report.html`
- 朗读题：`assessment/#/dekaronData/dekaronMain` frame，`.el-tabs__item`「挑战」→ `button`「开始挑战」→ 逐句 `button.taste-button`「结束录音」，完成后跳 `dubbingScene` 成绩单

## 依赖

| 依赖 | 是否必需 | 说明 |
| --- | --- | --- |
| Node 20+ | 必需 | DSH 自带运行时即可 |
| `playwright-core` | 必需 | npm 依赖，安装时自动拉取 |
| Chrome / Edge | 必需（二选一） | 默认 `channel: auto`，按 chrome → msedge → 内置 chromium 顺序探测 |
| Python 3 + `edge-tts` | 推荐 | `python -m pip install --user edge-tts`；缺失时自动回退 Windows SAPI |
| ffmpeg | **不需要** | 音频解码在浏览器里用 `decodeAudioData` 完成 |

`fif_doctor` 会一次性体检这几项。

## 打包与发行

插件是标准的 DSH bundle 包（`package.json` → `dsh.bundle.patch` → `cordis.patch.yml`），三种装法都验证过：

```powershell
# A. 从本地目录（开发）
dsh plugin --profile desktop add link:D:\Github\FiF-TTS
# 或直接跑本仓库的脚本（会顺带把 id 加进 dsh.profile.bundles）
pwsh -File .\scripts\install.ps1

# B. 从 tarball（离线分发）
npm pack                                     # → dsh-fif-oral-1.0.0.tgz
dsh plugin --profile desktop add file:D:\path\to\dsh-fif-oral-1.0.0.tgz

# C. 从 npm / git（公开发行）
npm publish                                  # 需要你自己的 npm 账号
dsh plugin --profile desktop add dsh-fif-oral
dsh plugin --profile desktop add github:PiggyWu981/dsh-fif-oral
```

装完重启 DSH，对话里出现 `fif_*` 工具即生效。

### 发布到 npm

```powershell
npm login                                          # 只需一次
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish.ps1 -DryRun   # 预检
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish.ps1           # 发布
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish.ps1 -Tag      # 发布并打 git tag
```

`publish.ps1` 会先校验：npm 是否登录、这个版本号是否已被占用、`npm pack` 内容里有没有混进
`data/`（**含登录 cookie，绝不能发布**）、`node_modules/`、`test/`。任何一项不过直接退出。

### 进插件市场

DSH 支持多个插件索引源（`plugin-market` 的 `indexes`）。把 `scripts/market-index.example.json` 里的 `repository` / `commit` / `publishTimestamp` 改成真实值，放到任意静态托管（GitHub Pages 即可）作为 `index.json`，然后在 DSH 设置里把这个 URL 加进索引列表。

### 打包内容

`npm pack` 产出 18 个文件 / 约 28 kB（只有 `index.js`、`lib/`、`cordis.patch.yml`、`icon.svg`、`scripts/`、文档），`data/`、`test/`、`node_modules/` 不会进包。运行时数据默认写 `~/.dsh/fif-oral/`（可用 `dataDir` 改），不会污染 `node_modules`。


## 已知限制

- 朗读分数量级取决于 TTS 音色与语速；实测 Aria 稳定 97–99，想要更高分可换 `en-US-AndrewNeural` / `en-US-JennyNeural` 并微调 `rate`。
- 平台改版会破坏选择器；`fif_probe` 用来重新抓结构。
- 挑战是有时限的（每句约 179 秒、约 3 分钟总时长），脚本按播放时长等待，句子特别长时需要调 `answerWaitMs`。
- 插件只处理 AI 任务里的听力与朗读；问答/角色扮演等题型未覆盖。
