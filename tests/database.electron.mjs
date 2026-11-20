import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import Database from 'better-sqlite3'
import http from 'node:http'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-isolated-db-'))
app.setPath('userData', profile)
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  app.dock?.hide()
  let exitCode = 0
  try {
  const file = path.join(profile, 'doubao-manager.sqlite3')
  const legacy = new Database(file)
  legacy.exec(`CREATE TABLE api_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, source TEXT NOT NULL DEFAULT 'local',
    model TEXT NOT NULL, account_id INTEGER, status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL,
    reference_image_path TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  legacy.prepare(`INSERT INTO api_requests(request_id, model, status, prompt, reference_image_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('legacy-image', 'seedance_2_0_mini', 'success', 'legacy fixture',
    '/legacy/reference.png', '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z')
  legacy.exec(`CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, partition TEXT NOT NULL UNIQUE,
    login_status TEXT NOT NULL DEFAULT 'logged_in', daily_quota_limit INTEGER NOT NULL DEFAULT 10,
    quota_remaining INTEGER NOT NULL DEFAULT 4, quota_used_today INTEGER NOT NULL DEFAULT 6,
    last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); INSERT INTO accounts(name,partition,created_at,updated_at) VALUES ('legacy','persist:doubao_account_001','2026-10-19T00:00:00.000Z','2026-10-19T00:00:00.000Z');`)
  legacy.close()
  const { AppDatabase } = await import('../dist-electron/database.js')
  const database = new AppDatabase()
  const migrated = new Database(file, { readonly: true })
  assert.ok(migrated.prepare('PRAGMA table_info(api_requests)').all().some(column => column.name === 'reference_image_paths'))
  assert.ok(migrated.prepare('PRAGMA table_info(api_requests)').all().some(column => column.name === 'duration_seconds'))
  assert.equal(JSON.parse(migrated.prepare("SELECT reference_image_paths FROM api_requests WHERE request_id = 'legacy-image'").get().reference_image_paths)[0], '/legacy/reference.png')
  migrated.close()
  const legacyImage = database.getApiRequest('legacy-image')
  assert.deepEqual(legacyImage.referenceImagePaths, ['/legacy/reference.png'])
  assert.equal(legacyImage.referenceImagePath, '/legacy/reference.png')

  const multiPaths = ['C:\\图片\\a.png', '/images/b.png', '/images/c.png']
  const multi = database.createApiRequest({ requestId: 'multi-image', model: 'seedance_2_0_mini', status: 'running', prompt: 'fixture', referenceImagePaths: multiPaths })
  assert.deepEqual(multi.referenceImagePaths, multiPaths)
  assert.equal(multi.referenceImagePath, multiPaths[0])
  assert.deepEqual(database.getApiRequest('multi-image').referenceImagePaths, multiPaths)
  assert.deepEqual(database.listApiRequests(10).find(item => item.requestId === 'multi-image').referenceImagePaths, multiPaths)

  const timed = database.createApiRequest({ requestId: 'duration-task', model: 'seedance_2_0_mini', aspectRatio: '9:16', durationSeconds: 12, status: 'running', prompt: 'fixture' })
  assert.equal(timed.aspectRatio, '9:16')
  assert.equal(timed.durationSeconds, 12)
  assert.equal(database.getApiRequest('duration-task').durationSeconds, 12)
  assert.equal(database.listApiRequests(10).find(item => item.requestId === 'duration-task').durationSeconds, 12)
  assert.equal(database.createApiRequest({ requestId: 'duration-legacy', model: 'seedance_2_0_mini', status: 'running', prompt: 'fixture' }).durationSeconds, null)
  assert.equal(database.createApiRequest({ requestId: 'duration-invalid', model: 'seedance_2_0_mini', durationSeconds: 30, status: 'running', prompt: 'fixture' }).durationSeconds, null)
  const mirror = new Database(file)
  const mirrorRow = mirror.prepare("SELECT reference_image_path, reference_image_paths FROM api_requests WHERE request_id = 'multi-image'").get()
  assert.equal(mirrorRow.reference_image_path, multiPaths[0])
  assert.deepEqual(JSON.parse(mirrorRow.reference_image_paths), multiPaths)
  mirror.prepare("UPDATE api_requests SET reference_image_paths = 'not-json' WHERE request_id = 'multi-image'").run()
  mirror.close()
  assert.deepEqual(database.getApiRequest('multi-image').referenceImagePaths, [multiPaths[0]])
  database.updateApiRequest({ requestId: 'multi-image', status: 'running', message: 'unchanged images' })
  assert.deepEqual(database.getApiRequest('multi-image').referenceImagePaths, [multiPaths[0]])

  const queuedPaths = ['/queued/1.png', '/queued/2.png']
  database.createApiRequest({ requestId: 'multi-queued', model: 'seedance_2_0_mini', status: 'accepted', executionPhase: 'queued', prompt: 'fixture', referenceImagePaths: queuedPaths })
  assert.ok(database.prepareQueueAfterRestart().includes('multi-queued'))
  assert.deepEqual(database.getApiRequest('multi-queued').referenceImagePaths, queuedPaths)

  assert.equal(database.getAccount(1).quotaRemaining, 4)
  assert.equal(database.getAccount(1).quotaUsedToday, 6)
  assert.ok(database.getAccount(1).quotaDate)
  const settings = database.updateSettings({ apiServiceEnabled: false, executorEnabled: false, watermarkApiToken: 'fixture-A' })
  assert.equal(database.getWatermarkStatus().usage, null)
  database.recordWatermarkResponse(settings, { checkedAt: new Date().toISOString(), usage: { totalLimit: 100, usedCount: 12, remainingCount: 88 }, error: null })
  assert.equal(database.getWatermarkStatus().usage.remainingCount, 88)
  database.updateSettings({ watermarkApiToken: 'fixture-B' })
  assert.equal(database.getWatermarkStatus().usage, null)
  database.updateSettings({ watermarkApiToken: 'fixture-A' })
  assert.equal(database.getWatermarkStatus().usage.remainingCount, 88)

  const account = database.createAccount({ remark: 'isolated fixture' })
  const failure = { stage: 'watermark', code: 'quota_exhausted', title: '去水印次数已耗尽', detail: '次数已耗尽', suggestion: '补充次数后恢复结果', retryable: false }
  database.createApiRequest({ requestId: 'isolated-failure', model: 'seedance_2_0_mini', accountId: account.id, status: 'running', prompt: 'fixture' })
  database.updateApiRequest({ requestId: 'isolated-failure', status: 'failed', message: '次数已耗尽', error: failure, doubaoThreadUrl: 'https://www.doubao.com/thread/fixture' })
  assert.deepEqual(database.getApiRequest('isolated-failure').error, failure)
  database.updateApiRequest({ requestId: 'isolated-failure', status: 'running', message: '恢复结果' })
  assert.equal(database.getApiRequest('isolated-failure').error, null)
  for (let index = 0; index < 103; index++) {
    const requestId = `isolated-success-${index}`
    database.createApiRequest({ requestId, model: 'seedance_2_0_mini', status: 'running', prompt: 'fixture' })
    database.updateApiRequest({ requestId, status: 'success', cleanVideoUrl: 'https://example.invalid/video.mp4' })
  }
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const end = new Date(start); end.setDate(end.getDate() + 1)
  assert.equal(database.getRequestStats(start.toISOString(), end.toISOString()).todaySuccess, 103)
  assert.equal(database.listApiRequests(100).length, 100)
  const inspect = new Database(file, { readonly: true })
  const scopes = inspect.prepare('SELECT scope, value FROM service_state').all()
  assert.equal(JSON.stringify(scopes).includes('fixture-A'), false)
  const tokenTime = inspect.prepare("SELECT updated_at FROM settings WHERE key='watermarkApiToken'").get().updated_at
  database.updateSettings({ outputDir: path.join(profile, 'output') })
  assert.equal(inspect.prepare("SELECT updated_at FROM settings WHERE key='watermarkApiToken'").get().updated_at, tokenTime)
  inspect.close()
  const { waitForSubmissionStarted } = await import('../dist-electron/executor.js')
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true } })
  const check = async (html) => {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return waitForSubmissionStarted(win, 'seedance_2_0_mini', '新对话', '用户的原始提示词', 1)
  }
  const promiseOnly = await check('<p>已生成代码</p><p>正在渲染，请等待成片输出。</p><textarea></textarea>')
  assert.equal(promiseOnly.confirmed || promiseOnly.pending, false)
  const nativeTask = await check('<div class="video-task">视频生成中</div><textarea></textarea>')
  assert.equal(nativeTask.pending, true)
  const formal = await check('<p>本次使用 Seedance 2.0 Mini 生成，预计等待 10 分钟。视频生成好后，我会主动发送给你。</p><textarea></textarea>')
  assert.equal(formal.confirmed, true)
  const manualInput = await check('<p>正在渲染，请等待成片输出。</p><textarea>手动输入中的文字</textarea><button aria-label="停止回答">停止</button>')
  assert.equal(manualInput.hasDraft, true)
  assert.equal(manualInput.responding, true)
  win.destroy()
  const { selectDoubaoDuration, submitPromptAndWait } = await import('../dist-electron/executor.js')

  const durationWindow = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, backgroundThrottling: false } })
  const durationHtml = `<!doctype html><html><body style="margin:0">
<style>
#composer { position: fixed; left: 0; bottom: 0; width: 900px; height: 90px; }
#editor { width: 500px; height: 50px; }
#popover { position: fixed; left: 20px; bottom: 110px; width: 380px; background: #fff; border: 1px solid #ccc; }
#popover[hidden] { display: none; }
#duration { position: relative; width: 340px; padding: 10px 20px; }
#slider { position: relative; width: 300px; height: 20px; margin: 28px 0 18px; }
.rail { position: absolute; left: 0; right: 0; top: 8px; height: 4px; background: #ddd; }
.fill { position: absolute; left: 0; top: 8px; height: 4px; background: #06f; }
.thumb { position: absolute; top: 0; width: 16px; height: 16px; border-radius: 50%; background: #06f; }
#bubble { position: absolute; top: -18px; font-size: 12px; transform: translateX(-50%); }
.end { display: inline-block; width: 24px; }
</style>
<div id="composer">
  <textarea id="editor"></textarea>
  <button id="trigger" aria-haspopup="dialog">自动 · 10s</button>
</div>
<div id="popover" hidden>
  <div>比例</div>
  <div><button>自动</button><button>9:16</button><button>16:9</button></div>
  <div id="duration">
    <div>时长</div>
    <div id="slider">
      <div class="rail"></div><div class="fill"></div>
      <div class="thumb" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="11" aria-valuenow="6"></div>
      <span id="bubble">10s</span>
    </div>
    <span class="end">4s</span><span class="end" style="margin-left:230px">15s</span>
  </div>
</div>
<script>
  var min = 4, max = 15, value = 10;
  var trigger = document.getElementById('trigger');
  var popover = document.getElementById('popover');
  var slider = document.getElementById('slider');
  var thumb = document.querySelector('.thumb');
  var bubble = document.getElementById('bubble');
  var fill = document.querySelector('.fill');
  function span() { return slider.getBoundingClientRect().width - 16; }
  function render() {
    var ratio = (value - min) / (max - min);
    thumb.style.left = Math.round(ratio * span()) + 'px';
    fill.style.width = (thumb.offsetLeft + 8) + 'px';
    bubble.style.left = (thumb.offsetLeft + 8) + 'px';
    thumb.setAttribute('aria-valuenow', String(value - min));
    bubble.textContent = value + 's';
    trigger.textContent = '自动 · ' + value + 's';
  }
  trigger.addEventListener('click', function () { popover.hidden = !popover.hidden; });
  var dragging = false;
  thumb.addEventListener('mousedown', function () { dragging = true; });
  document.addEventListener('mousemove', function (event) {
    if (!dragging) return;
    var rect = slider.getBoundingClientRect();
    var ratio = Math.min(1, Math.max(0, (event.clientX - rect.left - 8) / span()));
    value = Math.round(min + ratio * (max - min));
    render();
  });
  document.addEventListener('mouseup', function () { dragging = false; });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') popover.hidden = true;
    if (popover.hidden) return;
    if (event.key === 'ArrowRight') { value = Math.min(max, value + 1); render(); }
    if (event.key === 'ArrowLeft') { value = Math.max(min, value - 1); render(); }
  });
  render();
</script></body></html>`
  await durationWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(durationHtml))
  assert.equal(await durationWindow.webContents.executeJavaScript("document.getElementById('trigger').textContent"), '自动 · 10s')
  const firstDuration = await selectDoubaoDuration(durationWindow, 7)
  assert.equal(firstDuration.after, 7)
  assert.match(firstDuration.detail, /键盘/)
  assert.equal(await durationWindow.webContents.executeJavaScript("document.getElementById('trigger').textContent"), '自动 · 7s')
  assert.equal(await durationWindow.webContents.executeJavaScript("document.getElementById('popover').hidden"), true)
  const secondDuration = await selectDoubaoDuration(durationWindow, 14)
  assert.equal(secondDuration.after, 14)
  assert.equal(await durationWindow.webContents.executeJavaScript("document.getElementById('trigger').textContent"), '自动 · 14s')
  durationWindow.destroy()

  const windows = [0, 1, 2].map(() => new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, backgroundThrottling: false, partition: 'persist:parallel-test' } }))
  const prompts = ['same original prompt', 'different original prompt', 'same original prompt']
  const html = prompt => `<textarea style="width:700px;height:80px">${prompt}</textarea><div id="reply"></div><script>
    document.querySelector('textarea').focus();
    document.addEventListener('keydown', event => { if(event.key === 'Enter') { window.sent = document.querySelector('textarea').value; document.querySelector('textarea').value = ''; } });
  </script>`
  await Promise.all(windows.map((window, index) => window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html(prompts[index])))))
  const submissions = windows.map((window, index) => submitPromptAndWait(window, 'seedance_2_0_mini', prompts[index]))
  let sent = []
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    sent = await Promise.all(windows.map(window => window.webContents.executeJavaScript('window.sent || null')))
    if (sent.every(Boolean)) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.deepEqual(sent, prompts, 'All three windows must receive their own send before any acknowledgement')
  await Promise.all(windows.map(window => window.webContents.executeJavaScript(`document.getElementById('reply').innerText = '本次使用 Seedance 2.0 Mini 生成，预计等待 10 分钟。视频生成好后，我会主动发送给你。'`)))
  assert.deepEqual(await Promise.all(submissions), ['confirmed', 'confirmed', 'confirmed'])
  windows.forEach(window => window.destroy())
  const seen = []
  let origin
  const mock = http.createServer((req, res) => {
    if (req.url.startsWith('/video.mp4')) {
      res.writeHead(206, { 'content-type': 'video/mp4' }); res.end(Buffer.from('00000018667479706d703432', 'hex'))
    } else {
      seen.push([req.url.split('?')[0], req.headers.authorization])
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 200, data: { url: `${origin}/video.mp4`, usage: { remainingCount: 91 } } }))
    }
  })
  try {
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${mock.address().port}`
    const oldSettings = database.updateSettings({ watermarkApiUrl: `${origin}/old`, watermarkApiToken: 'fixture-old' })
    const task = database.createApiRequest({ requestId: 'executor-live-settings', model: 'seedance_2_0_mini', status: 'running', prompt: 'fixture' })
    database.updateSettings({ watermarkApiUrl: `${origin}/new`, watermarkApiToken: 'fixture-new' })
    const { DoubaoExecutor } = await import('../dist-electron/executor.js')
    const executor = new DoubaoExecutor(database, () => {}, (settings, event) => database.recordWatermarkResponse(settings, event))
    await executor.resolveCleanVideoWithProgress(task, oldSettings, 'https://www.doubao.com/thread/fixture', 1)
    assert.deepEqual(seen, [['/new', 'fixture-new']])
    assert.equal(database.getWatermarkStatus().usage.remainingCount, 91)
    database.recordWatermarkResponse(oldSettings, { checkedAt: new Date().toISOString(), usage: { remainingCount: 0 }, error: failure })
    assert.equal(database.getWatermarkStatus().usage.remainingCount, 91, 'Late old-token responses cannot replace the current token balance')
  } finally { await new Promise(resolve => mock.close(resolve)) }
  console.log('ISOLATED_DATABASE_OK')
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* Chromium may still hold profile files until the process exits. */ }
}
  app.exit(exitCode)
})
