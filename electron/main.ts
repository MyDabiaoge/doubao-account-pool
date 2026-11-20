import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, powerMonitor, session, type Session } from "electron";
import { DailyQuotaTimer } from "./quota-clock.js";
import { doubaoDailyQuotaError } from "./doubao-quota-state.js";
import log from "electron-log/main.js";
import { AppDatabase } from "./database.js";
import { DoubaoExecutor } from "./executor.js";
import { toPublicApiRequest } from "./public-api.js";
import type {
  AccountUpdateInput,
  ApiRequest,
  ApiServerStatus,
  AppSettings,
  AppSettingsUpdateInput,
  DoubaoAspectRatio,
  DoubaoModel,
  GenerateRequestBody
} from "./types.js";
import { resolveCleanVideoUrl, WatermarkError } from "./watermark.js";
import type { WatermarkProviderObserver } from "./watermark-state.js";
import { HttpError } from "./http-error.js";
import { parseMultipartGenerateRequest, readBufferBody, type MultipartFilePart } from "./multipart.js";
import { MAX_GENERATE_REQUEST_BYTES, toReferenceStringList } from "./reference-images.js";
import { prepareReferenceImages } from "./reference-files.js";
import {
  DOUBAO_DURATION_MAX_SECONDS,
  DOUBAO_DURATION_MIN_SECONDS,
  normalizeDoubaoDurationSeconds
} from "./generation-options.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let db: AppDatabase;
let executor: DoubaoExecutor;
let apiServer: LocalApiServer;
let quotaTimer: DailyQuotaTimer | null = null;

const observeWatermarkResponse: WatermarkProviderObserver = (settings, event) => {
  db.recordWatermarkResponse(settings, event);
  notifyDataChanged();
};

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

class LocalApiServer {
  private server: Server | null = null;
  private status: ApiServerStatus = {
    version: app.getVersion(),
    enabled: false,
    running: false,
    port: 0,
    url: null,
    message: "未启动"
  };

  constructor(
    private readonly database: AppDatabase,
    private readonly requestExecutor: DoubaoExecutor
  ) {}

  async applySettings(settings: AppSettings) {
    await this.stop();

    this.status = {
      version: app.getVersion(),
      enabled: settings.apiServiceEnabled,
      running: false,
      port: settings.apiPort,
      url: null,
      message: settings.apiServiceEnabled ? "启动中" : "已关闭"
    };

    if (!settings.apiServiceEnabled) return this.status;

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve) => {
      this.server!.once("error", (error) => {
        this.status = {
          version: app.getVersion(),
          enabled: true,
          running: false,
          port: settings.apiPort,
          url: null,
          message: `启动失败：${error.message}`
        };
        resolve();
      });

      this.server!.listen(settings.apiPort, "127.0.0.1", () => {
        this.status = {
          version: app.getVersion(),
          enabled: true,
          running: true,
          port: settings.apiPort,
          url: `http://127.0.0.1:${settings.apiPort}`,
          message: "运行中"
        };
        resolve();
      });
    });

    return this.status;
  }

  async stop() {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  getStatus() {
    return this.status;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const settings = this.database.getSettings();

    try {
      if (request.method === "OPTIONS") {
        sendJson(response, 204, null);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "doubao-account-pool",
          api: this.getStatus()
        });
        return;
      }

      if (!isAuthorized(request, settings.apiKey)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/accounts") {
        refreshQuotas();
        sendJson(response, 200, { accounts: this.database.listAccounts() });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/watermark/status") {
        sendJson(response, 200, this.database.getWatermarkStatus());
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/generate") {
        const requestId = `doubao-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const parsed = await readGenerateRequest(request);
        const body = parsed.body;
        const prompt = body.prompt?.trim();
        if (!prompt) {
          sendJson(response, 400, { error: "prompt is required" });
          return;
        }

        const model = normalizeModel(body.model || settings.defaultModel);
        if (!model) {
          sendJson(response, 400, { error: "unsupported model" });
          return;
        }

        const aspectRatio = normalizeAspectRatio(body.aspectRatio) || "16:9";
        const rawAspectRatio = typeof body.aspectRatio === "string" ? body.aspectRatio.trim() : body.aspectRatio;
        if (rawAspectRatio !== undefined && rawAspectRatio !== null && rawAspectRatio !== "" && !normalizeAspectRatio(body.aspectRatio)) {
          sendJson(response, 400, { error: "aspectRatio must be 9:16 or 16:9" });
          return;
        }

        const rawDuration = body.durationSeconds ?? body.duration;
        const durationSeconds = normalizeDoubaoDurationSeconds(rawDuration);
        const rawDurationText = rawDuration === undefined || rawDuration === null ? "" : String(rawDuration).trim();
        if (rawDurationText && durationSeconds === null) {
          sendJson(response, 400, {
            error: `durationSeconds must be an integer between ${DOUBAO_DURATION_MIN_SECONDS} and ${DOUBAO_DURATION_MAX_SECONDS}`,
            code: "invalid_duration"
          });
          return;
        }

        const accountId = body.accountId === undefined ? undefined : Number(body.accountId);
        if (accountId !== undefined && (!Number.isSafeInteger(accountId) || accountId < 1)) {
          sendJson(response, 400, { error: "accountId must be a positive integer" });
          return;
        }
        const uploadDir = path.join(app.getPath("userData"), "uploads", new Date().toISOString().slice(0, 10));
        const referenceImagePaths = await prepareReferenceImages({
          requestId,
          uploadDir,
          uploads: parsed.uploads,
          localPaths: parsed.localPaths,
          urls: parsed.urls
        });
        const referenceImagePath = referenceImagePaths[0] ?? null;
        refreshQuotas();
        const created = this.database.acceptApiRequest({ requestId, source: body.source, model, aspectRatio,
          durationSeconds, prompt, referenceImagePath, referenceImagePaths, removeWatermark: true, callbackUrl: body.callbackUrl }, accountId);

        if (!created) {
          const pinnedExhausted = accountId ? this.database.getAccount(accountId)?.dailyQuotaExhausted : false;
          const failed = this.database.createApiRequest({
            requestId,
            source: body.source,
            model,
            aspectRatio,
            durationSeconds,
            status: "failed",
            message: pinnedExhausted ? "豆包今日免费次数已用完；本任务指定了账号，不自动换号" : accountId ? "指定账号未登录、不存在或该模型剩余额度不足" : "没有可用账号，或该模型剩余额度不足",
            accountId: pinnedExhausted ? accountId : undefined,
            requestedAccountId: accountId,
            prompt,
            referenceImagePath,
            referenceImagePaths,
            removeWatermark: true,
            callbackUrl: body.callbackUrl
          });
          if (pinnedExhausted) this.database.updateApiRequest({ requestId, error: doubaoDailyQuotaError(this.database.getAccount(accountId!)?.quotaExhaustedReason || failed.message) });
          this.database.appendOperationLog({
            requestId,
            action: "分配账号",
            status: "failed",
            message: failed.message
          });
          notifyDataChanged();
          const finalFailure = this.database.getApiRequest(requestId)!;
          void postCallback(finalFailure);
          sendJson(response, 409, toPublicApiRequest(finalFailure));
          return;
        }

        this.requestExecutor.enqueue(created.requestId);
        this.database.appendOperationLog({
          requestId,
          accountId: created.accountId,
          action: "接收接口请求",
          status: "success",
          message: created.message
        });
        notifyDataChanged();
        void postCallback(created);
        sendJson(response, 202, toPublicApiRequest(created));
        return;
      }

      const recoveryMatch = requestUrl.pathname.match(/^\/api\/requests\/([^/]+)\/retry-result$/);
      if (request.method === "POST" && recoveryMatch) {
        const requestId = decodeURIComponent(recoveryMatch[1]);
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found" });
          return;
        }
        if (!apiRequest.accountId) {
          sendJson(response, 409, { error: "request has no assigned account" });
          return;
        }
        if (apiRequest.status === "running" || apiRequest.status === "accepted" && apiRequest.executionPhase !== "paused") {
          sendJson(response, 409, { error: "request is already active; stop or wait before retrying its result" });
          return;
        }
        this.requestExecutor.enqueueRecovery(requestId);
        this.database.appendOperationLog({
          requestId,
          accountId: apiRequest.accountId,
          action: "恢复视频结果",
          status: "info",
          message: "已进入结果恢复队列，不会重新提交视频生成"
        });
        sendJson(response, 202, {
          requestId,
          status: "accepted",
          message: "已进入结果恢复队列，不会重新提交视频生成"
        });
        return;
      }

      const stopMatch = requestUrl.pathname.match(/^\/api\/requests\/([^/]+)\/stop$/);
      if (request.method === "POST" && stopMatch) {
        const requestId = decodeURIComponent(stopMatch[1]);
        const result = this.requestExecutor.stop(requestId);
        if (!result.stopped) {
          sendJson(response, 409, {
            ...toPublicApiRequest(result.request),
            error: "only accepted or running requests can be stopped"
          });
          return;
        }
        sendJson(response, 200, toPublicApiRequest(result.request));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/api/requests/")) {
        const requestId = decodeURIComponent(requestUrl.pathname.replace("/api/requests/", ""));
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found" });
          return;
        }
        sendJson(response, 200, toPublicApiRequest(apiRequest));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/watermark/parse") {
        const body = await readJsonBody<{ url?: string }>(request);
        const sourceUrl = body.url?.trim();
        if (!sourceUrl) {
          sendJson(response, 400, { error: "url is required" });
          return;
        }
        try {
          const cleanVideoUrl = await resolveCleanVideoUrl(settings, sourceUrl, undefined, { onProviderResponse: observeWatermarkResponse, getSettings: () => this.database.getSettings() });
          recordOperation(null, null, "独立去水印解析", "success", "已验证真实 MP4 地址", sourceUrl);
          sendJson(response, 200, {
            status: "success",
            message: "去水印 MP4 地址已验证",
            cleanVideoUrl,
            outputVideoPath: null
          });
        } catch (error) {
          recordOperation(
            null,
            null,
            "独立去水印解析",
            "failed",
            error instanceof Error ? error.message : "去水印解析失败",
            sourceUrl
          );
          sendJson(response, 422, {
            status: "failed",
            error: error instanceof WatermarkError ? error.info : null,
            message: error instanceof Error ? error.message : "去水印解析失败",
            cleanVideoUrl: null,
            outputVideoPath: null
          });
        }
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, {
          error: error.message,
          ...(error.code ? { code: error.code } : {})
        });
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      sendJson(response, 500, { error: message });
    }
  }
}

const configuredDownloadSessions = new WeakSet<Session>();

function configureSessionDownloads(target: Session) {
  if (configuredDownloadSessions.has(target)) return;
  configuredDownloadSessions.add(target);
  target.on("will-download", (event, item) => {
    const saveDir = db.getSettings().outputDir.trim();
    if (!saveDir) {
      event.preventDefault();
      return;
    }
    try {
      fs.mkdirSync(saveDir, { recursive: true });
      item.setSavePath(uniqueDownloadPath(saveDir, item.getFilename()));
    } catch {
      event.preventDefault();
    }
  });
}

function uniqueDownloadPath(dir: string, filename: string) {
  const safeName = path.basename(filename || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  const base = safeName || `doubao-video-${Date.now()}.mp4`;
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let target = path.join(dir, base);
  let index = 2;
  while (fs.existsSync(target)) target = path.join(dir, `${stem}-${index++}${ext}`);
  return target;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    title: "豆包账号池接口服务",
    webPreferences: {
      preload: path.join(__dirname, "preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

function createDoubaoWindow(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const titleName = account.remark || account.name;
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    title: `豆包 - ${titleName}`,
    webPreferences: {
      partition: account.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  void win.loadURL("https://www.doubao.com/chat");
}

async function detectLoginStatus(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const accountSession = session.fromPartition(account.partition);
  const cookies = await accountSession.cookies.get({ url: "https://www.doubao.com" });
  const activeRequest = account.runningTaskCount + account.queuedTaskCount > 0;
  return db.updateAccount({
    id: accountId,
    loginStatus: cookies.length > 0 ? "logged_in" : "logged_out",
    currentStatus: cookies.length > 0
      ? activeRequest
        ? "busy"
        : "idle"
      : "login_required"
  });
}

async function detectAllLoginStatuses() {
  const accounts = db.listAccounts();
  for (const account of accounts) {
    await detectLoginStatus(account.id);
  }
  return db.listAccounts();
}

async function clearAccountSession(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const accountSession = session.fromPartition(account.partition);
  await accountSession.clearStorageData();
  await accountSession.clearCache();
  return db.updateAccount({
    id: accountId,
    loginStatus: "logged_out",
    currentStatus: "login_required"
  });
}

function registerIpc() {
  ipcMain.handle("accounts:list", () => { refreshQuotas(); return db.listAccounts(); });
  ipcMain.handle("accounts:create", (_event, remark?: string) => {
    const account = db.createAccount({ remark });
    recordOperation(null, account.id, "创建账号", "success", `已创建 ${account.partition}`);
    return account;
  });
  ipcMain.handle("accounts:update", (_event, input: AccountUpdateInput) => {
    const account = db.updateAccount(input);
    recordOperation(null, account.id, "修改账号设置", "success", "已保存账号备注和额度设置");
    return account;
  });
  ipcMain.handle("accounts:delete", async (_event, id: number) => {
    const account = db.getAccount(id);
    await clearAccountSession(id);
    db.deleteAccount(id);
    recordOperation(null, id, "删除账号", "success", `已删除 ${account?.partition || id}`);
    return true;
  });
  ipcMain.handle("accounts:open", (_event, id: number) => {
    const result = createDoubaoWindow(id);
    recordOperation(null, id, "打开豆包窗口", "success", "已打开独立账号窗口");
    return result;
  });
  ipcMain.handle("accounts:relogin", async (_event, id: number) => {
    await clearAccountSession(id);
    createDoubaoWindow(id);
    recordOperation(null, id, "重新登录账号", "success", "已清空登录状态并打开登录窗口");
    return true;
  });
  ipcMain.handle("accounts:detect-login", async (_event, id: number) => {
    const account = await detectLoginStatus(id);
    recordOperation(null, id, "检测登录状态", "success", `当前状态：${account.loginStatus}`);
    return account;
  });
  ipcMain.handle("accounts:detect-all", async () => {
    const accounts = await detectAllLoginStatuses();
    recordOperation(null, null, "检测全部账号", "success", `已检测 ${accounts.length} 个账号`);
    return accounts;
  });
  ipcMain.handle("accounts:reset-quota", (_event, id: number) => {
    const accounts = db.resetAccountQuota(id);
    recordOperation(null, id, "重置账号额度", "success", "已重置今日额度");
    return accounts;
  });
  ipcMain.handle("accounts:reset-all-quotas", () => {
    const accounts = db.resetAllQuotas();
    recordOperation(null, null, "重置全部额度", "success", `已重置 ${accounts.length} 个账号`);
    return accounts;
  });

  ipcMain.handle("settings:get", () => db.getSettings());
  ipcMain.handle("settings:update", async (_event, input: AppSettingsUpdateInput) => {
    const previous = db.getSettings();
    const settings = db.updateSettings(input);
    executor.wake();
    if (previous.apiPort !== settings.apiPort || previous.apiServiceEnabled !== settings.apiServiceEnabled || previous.apiKey !== settings.apiKey) {
      await apiServer.applySettings(settings);
    }
    const watermarkChanged = previous.watermarkApiUrl !== settings.watermarkApiUrl || previous.watermarkApiToken !== settings.watermarkApiToken;
    recordOperation(null, null, "保存配置", "success", watermarkChanged ? "去水印配置已保存，后续解析尝试使用新配置；已发出的请求不撤回，已失败任务可恢复结果" : "配置已保存并应用");
    return settings;
  });

  ipcMain.handle("api-server:status", () => apiServer.getStatus());
  ipcMain.handle("api-server:restart", async () => apiServer.applySettings(db.getSettings()));

  ipcMain.handle("api-requests:list", (_event, limit?: number) => db.listApiRequests(limit || 100));
  ipcMain.handle("watermark:status", () => db.getWatermarkStatus());
  ipcMain.handle("api-requests:stats", (_event, startIso: string, endIso: string) => db.getRequestStats(startIso, endIso));
  ipcMain.handle("api-requests:recover", (_event, requestId: string) => {
    const request = db.getApiRequest(requestId);
    if (!request?.accountId || request.status === "running" || request.status === "accepted" && request.executionPhase !== "paused") throw new Error("任务当前无法恢复结果");
    executor.enqueueRecovery(requestId);
    return true;
  });
  ipcMain.handle("api-requests:stop", (_event, requestId: string) => executor.stop(requestId));
  ipcMain.handle("api-requests:today-success-count", (_event, startIso: string, endIso: string) =>
    db.countSuccessfulVideosBetween(startIso, endIso)
  );
  ipcMain.handle("api-requests:clear", () => {
    db.clearApiRequests();
    return true;
  });
  ipcMain.handle("operation-logs:list", (_event, limit?: number) => db.listOperationLogs(limit || 500));
  ipcMain.handle("operation-logs:clear", () => {
    db.clearOperationLogs();
    return true;
  });
}

function recordOperation(
  requestId: string | null,
  accountId: number | null,
  action: string,
  status: "info" | "success" | "failed",
  message: string,
  targetUrl?: string | null
) {
  db.appendOperationLog({ requestId, accountId, action, status, message, targetUrl });
  notifyDataChanged();
}

function refreshQuotas() {
  if (db.refreshDailyQuotas() > 0) {
    executor.wake();
    notifyDataChanged();
  }
}

function notifyDataChanged() {
  mainWindow?.webContents.send("data:changed");
}

function normalizeModel(model: string): DoubaoModel | null {
  if (model === "seedance_2_0_mini" || model === "seedance_2_0_fast") return model;
  return null;
}

function normalizeAspectRatio(value: unknown): DoubaoAspectRatio | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).replace(/\s+/g, "").trim();
  if (normalized === "9:16" || normalized === "16:9") return normalized;
  return null;
}

function isAuthorized(request: IncomingMessage, apiKey: string) {
  if (!apiKey.trim()) return true;
  return request.headers.authorization === `Bearer ${apiKey}`;
}

interface ParsedGenerateRequest {
  body: GenerateRequestBody;
  uploads: MultipartFilePart[];
  localPaths: string[];
  urls: string[];
}

async function readGenerateRequest(request: IncomingMessage): Promise<ParsedGenerateRequest> {
  const contentType = String(request.headers["content-type"] || "");
  if (contentType.includes("multipart/form-data")) {
    const parsed = parseMultipartGenerateRequest(
      await readBufferBody(request, MAX_GENERATE_REQUEST_BYTES),
      contentType
    );
    return {
      body: parsed.body,
      uploads: parsed.files,
      localPaths: toReferenceStringList(parsed.body.referenceImages, "referenceImages"),
      urls: toReferenceStringList(parsed.body.referenceImageUrls, "referenceImageUrls")
    };
  }

  const body = await readJsonBody<GenerateRequestBody>(request, MAX_GENERATE_REQUEST_BYTES);
  return {
    body,
    uploads: [],
    localPaths: [
      ...toReferenceStringList(body.referenceImages, "referenceImages"),
      ...toReferenceStringList(body.referenceImagePath, "referenceImagePath")
    ],
    urls: [
      ...toReferenceStringList(body.referenceImageUrls, "referenceImageUrls"),
      ...toReferenceStringList(body.referenceImageUrl, "referenceImageUrl")
    ]
  };
}

async function readJsonBody<T>(request: IncomingMessage, maxBytes = MAX_GENERATE_REQUEST_BYTES): Promise<T> {
  const raw = (await readBufferBody(request, maxBytes)).toString("utf8");
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError("请求 JSON 格式无效", 400, "invalid_json");
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  });
  if (statusCode === 204) {
    response.end();
    return;
  }
  response.end(JSON.stringify(payload, null, 2));
}

async function postCallback(payload: ApiRequest) {
  if (!payload.callbackUrl) return;
  await fetch(payload.callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toPublicApiRequest(payload))
  }).catch(() => undefined);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    log.initialize();
    db = new AppDatabase();
    executor = new DoubaoExecutor(db, notifyDataChanged, observeWatermarkResponse);
    apiServer = new LocalApiServer(db, executor);
    app.on("web-contents-created", (_event, contents) => configureSessionDownloads(contents.session));
    configureSessionDownloads(session.defaultSession);
    const queuedRequests = db.prepareQueueAfterRestart();
    quotaTimer = new DailyQuotaTimer(refreshQuotas);
    quotaTimer.start();
    powerMonitor.on("resume", () => quotaTimer?.refresh());
    registerIpc();
    await apiServer.applySettings(db.getSettings());
    for (const requestId of queuedRequests) executor.enqueue(requestId);
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  }).catch((error) => {
    log.error(error);
  });
}

app.on("before-quit", async () => {
  quotaTimer?.stop();
  await apiServer?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
