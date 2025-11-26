const session = require("express-session");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { firefox } = require("playwright");
const os = require("os");

// ===================================================================================
// AUTH SOURCE MANAGEMENT MODULE (无敏感信息，保持不变)
// ===================================================================================

class AuthSource {
  constructor(logger) {
    this.logger = logger;
    this.authMode = "file";
    this.availableIndices = [];
    this.initialIndices = [];
    this.accountNameMap = new Map();

    if (process.env.AUTH_JSON_1) {
      this.authMode = "env";
      this.logger.info(
        "[Auth] 检测到 AUTH_JSON_1 环境变量，切换到环境变量认证模式。"
      );
    } else {
      this.logger.info(
        '[Auth] 未检测到环境变量认证，将使用 "auth/" 目录下的文件。'
      );
    }

    this._discoverAvailableIndices();
    this._preValidateAndFilter();

    if (this.availableIndices.length === 0) {
      this.logger.error(
        `[Auth] 致命错误：在 '${this.authMode}' 模式下未找到任何有效的认证源。`
      );
      throw new Error("No valid authentication sources found.");
    }
  }

  _discoverAvailableIndices() {
    let indices = [];
    if (this.authMode === "env") {
      const regex = /^AUTH_JSON_(\d+)$/;
      for (const key in process.env) {
        const match = key.match(regex);
        if (match && match[1]) {
          indices.push(parseInt(match[1], 10));
        }
      }
    } else {
      const authDir = path.join(__dirname, "auth");
      if (!fs.existsSync(authDir)) {
        this.logger.warn('[Auth] "auth/" 目录不存在。');
        this.availableIndices = [];
        return;
      }
      try {
        const files = fs.readdirSync(authDir);
        const authFiles = files.filter((file) => /^auth-\d+\.json$/.test(file));
        indices = authFiles.map((file) =>
          parseInt(file.match(/^auth-(\d+)\.json$/)[1], 10)
        );
      } catch (error) {
        this.logger.error(`[Auth] 扫描 "auth/" 目录失败: ${error.message}`);
        this.availableIndices = [];
        return;
      }
    }

    this.initialIndices = [...new Set(indices)].sort((a, b) => a - b);
    this.availableIndices = [...this.initialIndices];

    this.logger.info(
      `[Auth] 在 '${this.authMode}' 模式下，初步发现 ${
        this.initialIndices.length
      } 个认证源: [${this.initialIndices.join(", ")}]`
    );
  }

  _preValidateAndFilter() {
    if (this.availableIndices.length === 0) return;

    this.logger.info("[Auth] 开始预检验所有认证源的JSON格式...");
    const validIndices = [];
    const invalidSourceDescriptions = [];

    for (const index of this.availableIndices) {
      const authContent = this._getAuthContent(index);
      if (authContent) {
        try {
          const authData = JSON.parse(authContent);
          validIndices.push(index);
          this.accountNameMap.set(
            index,
            authData.accountName || "N/A (未命名)"
          );
        } catch (e) {
          invalidSourceDescriptions.push(`auth-${index}`);
        }
      } else {
        invalidSourceDescriptions.push(`auth-${index} (无法读取)`);
      }
    }

    if (invalidSourceDescriptions.length > 0) {
      this.logger.warn(
        `⚠️ [Auth] 预检验发现 ${
          invalidSourceDescriptions.length
        } 个格式错误或无法读取的认证源: [${invalidSourceDescriptions.join(
          ", "
        )}]，将从可用列表中移除。`
      );
    }

    this.availableIndices = validIndices;
  }

  _getAuthContent(index) {
    if (this.authMode === "env") {
      return process.env[`AUTH_JSON_${index}`];
    } else {
      const authFilePath = path.join(__dirname, "auth", `auth-${index}.json`);
      if (!fs.existsSync(authFilePath)) return null;
      try {
        return fs.readFileSync(authFilePath, "utf-8");
      } catch (e) {
        return null;
      }
    }
  }

  getAuth(index) {
    if (!this.availableIndices.includes(index)) {
      this.logger.error(`[Auth] 请求了无效或不存在的认证索引: ${index}`);
      return null;
    }

    let jsonString = this._getAuthContent(index);
    if (!jsonString) {
      this.logger.error(`[Auth] 在读取时无法获取认证源 #${index} 的内容。`);
      return null;
    }

    try {
      return JSON.parse(jsonString);
    } catch (e) {
      this.logger.error(
        `[Auth] 解析来自认证源 #${index} 的JSON内容失败: ${e.message}`
      );
      return null;
    }
  }
}

// ===================================================================================
// BROWSER MANAGEMENT MODULE (无修改)
// ===================================================================================

class BrowserManager {
  constructor(logger, config, authSource) {
    this.logger = logger;
    this.config = config;
    this.authSource = authSource;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentAuthIndex = 0;
    this.scriptFileName = "black-browser.js";
    this.launchArgs = [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--mute-audio",
      "--safebrowsing-disable-auto-update",
    ];

    if (this.config.browserExecutablePath) {
      this.browserExecutablePath = this.config.browserExecutablePath;
    } else {
      const platform = os.platform();
      if (platform === "linux") {
        this.browserExecutablePath = path.join(
          __dirname,
          "camoufox-linux",
          "camoufox"
        );
      } else {
        throw new Error(`Unsupported operating system: ${platform}`);
      }
    }
  }

  async launchOrSwitchContext(authIndex) {
    if (!this.browser) {
      this.logger.info("🚀 [Browser] 浏览器实例未运行，正在进行首次启动...");
      if (!fs.existsSync(this.browserExecutablePath)) {
        throw new Error(
          `Browser executable not found at path: ${this.browserExecutablePath}`
        );
      }
      this.browser = await firefox.launch({
        headless: true,
        executablePath: this.browserExecutablePath,
        args: this.launchArgs,
      });
      this.browser.on("disconnected", () => {
        this.logger.error("❌ [Browser] 浏览器意外断开连接！(可能是资源不足)");
        this.browser = null;
        this.context = null;
        this.page = null;
      });
      this.logger.info("✅ [Browser] 浏览器实例已成功启动。");
    }
    if (this.context) {
      this.logger.info("[Browser] 正在关闭旧的浏览器上下文...");
      await this.context.close();
      this.context = null;
      this.page = null;
      this.logger.info("[Browser] 旧上下文已关闭。");
    }

    const sourceDescription =
      this.authSource.authMode === "env"
        ? `环境变量 AUTH_JSON_${authIndex}`
        : `文件 auth-${authIndex}.json`;
    this.logger.info("==================================================");
    this.logger.info(
      `🔄 [Browser] 正在为账号 #${authIndex} 创建新的浏览器上下文`
    );
    this.logger.info(`   • 认证源: ${sourceDescription}`);
    this.logger.info("==================================================");

    const storageStateObject = this.authSource.getAuth(authIndex);
    if (!storageStateObject) {
      throw new Error(
        `Failed to get or parse auth source for index ${authIndex}.`
      );
    }
    const buildScriptContent = fs.readFileSync(
      path.join(__dirname, this.scriptFileName),
      "utf-8"
    );

    try {
      this.context = await this.browser.newContext({
        storageState: storageStateObject,
        viewport: { width: 1920, height: 1080 },
      });
      this.page = await this.context.newPage();
      this.page.on("console", (msg) => {
        const msgText = msg.text();
        if (msgText.includes("[BrowserTask]")) {
          this.logger.info(
            `[Browser] ${msgText.replace("[BrowserTask] ", "")}`
          );
        } else if (msg.type() === "error") {
          this.logger.error(`[Browser Page Error] ${msgText}`);
        }
      });

      this.logger.info(`[Browser] 正在导航至目标网页...`);
      const targetUrl =
        "https://aistudio.google.com/u/0/apps/bundled/blank?showPreview=true&showCode=true&showAssistant=true";
      await this.page.goto(targetUrl, {
        timeout: 180000,
        waitUntil: "domcontentloaded",
      });
      this.logger.info("[Browser] 页面加载完成。");

      await this.page.waitForTimeout(3000);

      this.logger.info(`[Browser] 正在检查 Cookie 同意横幅...`);
      try {
        const agreeButton = this.page.locator('button:text("Agree")');
        await agreeButton.waitFor({ state: "visible", timeout: 10000 });
        this.logger.info(
          `[Browser] ✅ 发现 Cookie 同意横幅，正在点击 "Agree"...`
        );
        await agreeButton.click({ force: true });
        await this.page.waitForTimeout(1000);
      } catch (error) {
        this.logger.info(`[Browser] 未发现 Cookie 同意横幅，跳过。`);
      }

      this.logger.info(`[Browser] 正在检查 "Got it" 弹窗...`);
      try {
        const gotItButton = this.page.locator(
          'div.dialog button:text("Got it")'
        );
        await gotItButton.waitFor({ state: "visible", timeout: 15000 });
        this.logger.info(`[Browser] ✅ 发现 "Got it" 弹窗，正在点击...`);
        await gotItButton.click({ force: true });
        await this.page.waitForTimeout(1000);
      } catch (error) {
        this.logger.info(`[Browser] 未发现 "Got it" 弹窗，跳过。`);
      }

      this.logger.info(`[Browser] 正在检查新手引导...`);
      try {
        const closeButton = this.page.locator('button[aria-label="Close"]');
        await closeButton.waitFor({ state: "visible", timeout: 15000 });
        this.logger.info(`[Browser] ✅ 发现新手引导弹窗，正在点击关闭按钮...`);
        await closeButton.click({ force: true });
        await this.page.waitForTimeout(1000);
      } catch (error) {
        this.logger.info(
          `[Browser] 未发现 "It's time to build" 新手引导，跳过。`
        );
      }

      this.logger.info("[Browser] 准备UI交互，强行移除所有可能的遮罩层...");
      await this.page.evaluate(() => {
        const overlays = document.querySelectorAll("div.cdk-overlay-backdrop");
        if (overlays.length > 0) {
          console.log(
            `[BrowserTask] (内部JS) 发现并移除了 ${overlays.length} 个遮罩层。`
          );
          overlays.forEach((el) => el.remove());
        }
      });

      this.logger.info('[Browser] (步骤1/5) 准备点击 "Code" 按钮...');
      for (let i = 1; i <= 5; i++) {
        try {
          this.logger.info(`  [尝试 ${i}/5] 清理遮罩层并点击...`);
          await this.page.evaluate(() => {
            document
              .querySelectorAll("div.cdk-overlay-backdrop")
              .forEach((el) => el.remove());
          });
          await this.page.waitForTimeout(500);

          await this.page
            .locator('button:text("Code")')
            .click({ timeout: 10000 });
          this.logger.info("  ✅ 点击成功！");
          break;
        } catch (error) {
          this.logger.warn(
            `  [尝试 ${i}/5] 点击失败: ${error.message.split("\n")[0]}`
          );
          if (i === 5) {
            try {
              const screenshotPath = path.join(
                __dirname,
                "debug_screenshot_final.png"
              );
              await this.page.screenshot({
                path: screenshotPath,
                fullPage: true,
              });
              this.logger.info(
                `[调试] 最终失败截图已保存到: ${screenshotPath}`
              );
            } catch (screenshotError) {
              this.logger.error(
                `[调试] 保存截图失败: ${screenshotError.message}`
              );
            }
            throw new Error(`多次尝试后仍无法点击 "Code" 按钮，初始化失败。`);
          }
        }
      }

      this.logger.info(
        '[Browser] (步骤2/5) "Code" 按钮点击成功，等待编辑器变为可见...'
      );
      const editorContainerLocator = this.page
        .locator("div.monaco-editor")
        .first();
      await editorContainerLocator.waitFor({
        state: "visible",
        timeout: 60000,
      });

      this.logger.info(
        "[Browser] (清场 #2) 准备点击编辑器，再次强行移除所有可能的遮罩层..."
      );
      await this.page.evaluate(() => {
        const overlays = document.querySelectorAll("div.cdk-overlay-backdrop");
        if (overlays.length > 0) {
          console.log(
            `[BrowserTask] (内部JS) 发现并移除了 ${overlays.length} 个新出现的遮罩层。`
          );
          overlays.forEach((el) => el.remove());
        }
      });
      await this.page.waitForTimeout(250);

      this.logger.info("[Browser] (步骤3/5) 编辑器已显示，聚焦并粘贴脚本...");
      await editorContainerLocator.click({ timeout: 30000 });

      await this.page.evaluate(
        (text) => navigator.clipboard.writeText(text),
        buildScriptContent
      );
      const isMac = os.platform() === "darwin";
      const pasteKey = isMac ? "Meta+V" : "Control+V";
      await this.page.keyboard.press(pasteKey);
      this.logger.info("[Browser] (步骤4/5) 脚本已粘贴。");
      this.logger.info(
        '[Browser] (步骤5/5) 正在点击 "Preview" 按钮以使脚本生效...'
      );
      await this.page.locator('button:text("Preview")').click();
      this.logger.info("[Browser] ✅ UI交互完成，脚本已开始运行。");
      this.currentAuthIndex = authIndex;
      this.logger.info("==================================================");
      this.logger.info(`✅ [Browser] 账号 ${authIndex} 的上下文初始化成功！`);
      this.logger.info("✅ [Browser] 浏览器客户端已准备就绪。");
      this.logger.info("==================================================");
    } catch (error) {
      this.logger.error(
        `❌ [Browser] 账户 ${authIndex} 的上下文初始化失败: ${error.message}`
      );
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      throw error;
    }
  }

  async closeBrowser() {
    if (this.browser) {
      this.logger.info("[Browser] 正在关闭整个浏览器实例...");
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.logger.info("[Browser] 浏览器实例已关闭。");
    }
  }

  async switchAccount(newAuthIndex) {
    this.logger.info(
      `🔄 [Browser] 开始账号切换: 从 ${this.currentAuthIndex} 到 ${newAuthIndex}`
    );
    await this.launchOrSwitchContext(newAuthIndex);
    this.logger.info(
      `✅ [Browser] 账号切换完成，当前账号: ${this.currentAuthIndex}`
    );
  }
}

// ===================================================================================
// SERVER MODULE (无修改)
// ===================================================================================

class LoggingService {
  constructor(serviceName = "AppService") {
    this.serviceName = serviceName;
    this.logBuffer = [];
    this.maxBufferSize = 100;
  }

  _formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    const formatted = `[${level}] ${timestamp} [${this.serviceName}] - ${message}`;
    this.logBuffer.push(formatted);
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }
    return formatted;
  }

  info(message) {
    console.log(this._formatMessage("INFO", message));
  }
  error(message) {
    console.error(this._formatMessage("ERROR", message));
  }
  warn(message) {
    console.warn(this._formatMessage("WARN", message));
  }
  debug(message) {
    console.debug(this._formatMessage("DEBUG", message));
  }
}

class MessageQueue extends EventEmitter {
  constructor(timeoutMs = 600000) {
    super();
    this.messages = [];
    this.waitingResolvers = [];
    this.defaultTimeout = timeoutMs;
    this.closed = false;
  }
  enqueue(message) {
    if (this.closed) return;
    if (this.waitingResolvers.length > 0) {
      const resolver = this.waitingResolvers.shift();
      resolver.resolve(message);
    } else {
      this.messages.push(message);
    }
  }
  async dequeue(timeoutMs = this.defaultTimeout) {
    if (this.closed) {
      throw new Error("Queue is closed");
    }
    return new Promise((resolve, reject) => {
      if (this.messages.length > 0) {
        resolve(this.messages.shift());
        return;
      }
      const resolver = { resolve, reject };
      this.waitingResolvers.push(resolver);
      const timeoutId = setTimeout(() => {
        const index = this.waitingResolvers.indexOf(resolver);
        if (index !== -1) {
          this.waitingResolvers.splice(index, 1);
          reject(new Error("Queue timeout"));
        }
      }, timeoutMs);
      resolver.timeoutId = timeoutId;
    });
  }
  close() {
    this.closed = true;
    this.waitingResolvers.forEach((resolver) => {
      clearTimeout(resolver.timeoutId);
      resolver.reject(new Error("Queue closed"));
    });
    this.waitingResolvers = [];
    this.messages = [];
  }
}

class ConnectionRegistry extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Set();
    this.messageQueues = new Map();
    this.reconnectGraceTimer = null;
  }
  addConnection(websocket, clientInfo) {
    if (this.reconnectGraceTimer) {
      clearTimeout(this.reconnectGraceTimer);
      this.reconnectGraceTimer = null;
      this.logger.info("[Server] 在缓冲期内检测到新连接，已取消断开处理。");
    }

    this.connections.add(websocket);
    this.logger.info(
      `[Server] 浏览器端工作程序已连接 (来自: ${clientInfo.address})`
    );
    websocket.on("message", (data) =>
      this._handleIncomingMessage(data.toString())
    );
    websocket.on("close", () => this._removeConnection(websocket));
    websocket.on("error", (error) =>
      this.logger.error(`[Server] 内部通信链路错误: ${error.message}`)
    );
    this.emit("connectionAdded", websocket);
  }

  _removeConnection(websocket) {
    this.connections.delete(websocket);
    this.logger.warn("[Server] 浏览器端工作程序连接断开。");
    this.logger.info("[Server] 启动5秒重连缓冲期...");
    this.reconnectGraceTimer = setTimeout(() => {
      this.logger.error(
        "[Server] 缓冲期结束，未检测到重连。确认连接丢失，正在清理所有待处理任务..."
      );
      this.messageQueues.forEach((queue) => queue.close());
      this.messageQueues.clear();
      this.emit("connectionLost");
    }, 5000);
    this.emit("connectionRemoved", websocket);
  }

  _handleIncomingMessage(messageData) {
    try {
      const parsedMessage = JSON.parse(messageData);
      const requestId = parsedMessage.request_id;
      if (!requestId) {
        this.logger.warn("[Server] 收到无效消息：缺少 request_id");
        return;
      }
      const queue = this.messageQueues.get(requestId);
      if (queue) {
        this._routeMessage(parsedMessage, queue);
      } else {
        this.logger.warn(`[Server] 收到未知或已过时任务ID的消息: ${requestId}`);
      }
    } catch (error) {
      this.logger.error("[Server] 解析内部消息失败");
    }
  }

  _routeMessage(message, queue) {
    const { event_type } = message;
    switch (event_type) {
      case "response_headers":
      case "chunk":
      case "error":
        queue.enqueue(message);
        break;
      case "stream_close":
        queue.enqueue({ type: "STREAM_END" });
        break;
      default:
        this.logger.warn(`[Server] 未知的内部事件类型: ${event_type}`);
    }
  }
  hasActiveConnections() {
    return this.connections.size > 0;
  }
  getFirstConnection() {
    return this.connections.values().next().value;
  }
  createMessageQueue(requestId) {
    const queue = new MessageQueue();
    this.messageQueues.set(requestId, queue);
    return queue;
  }
  removeMessageQueue(requestId) {
    const queue = this.messageQueues.get(requestId);
    if (queue) {
      queue.close();
      this.messageQueues.delete(requestId);
    }
  }
}

// ===================================================================================
// TASK HANDLER MODULE (核心修改区)
// ===================================================================================
class TaskHandler {
  constructor(
    serverSystem,
    connectionRegistry,
    logger,
    browserManager,
    config,
    authSource
  ) {
    this.serverSystem = serverSystem;
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
    this.browserManager = browserManager;
    this.config = config;
    this.authSource = authSource;
    this.maxRetries = this.config.maxRetries;
    this.retryDelay = this.config.retryDelay;
    this.failureCount = 0;
    this.usageCount = 0;
    this.isAuthSwitching = false;
    this.needsSwitchingAfterRequest = false;
    this.isSystemBusy = false;
  }
  get currentAuthIndex() {
    return this.browserManager.currentAuthIndex;
  }
  _getMaxAuthIndex() {
    return this.authSource.getMaxIndex();
  }
  _getNextAuthIndex() {
    const available = this.authSource.availableIndices;
    if (available.length === 0) return null;
    const currentIndexInArray = available.indexOf(this.currentAuthIndex);
    if (currentIndexInArray === -1) {
      this.logger.warn(
        `[Auth] 当前索引 ${this.currentAuthIndex} 不在可用列表中，将切换到第一个可用索引。`
      );
      return available[0];
    }
    const nextIndexInArray = (currentIndexInArray + 1) % available.length;
    return available[nextIndexInArray];
  }
  async _switchToNextAuth() {
    if (this.authSource.availableIndices.length <= 1) {
      this.logger.warn("[Auth] 😕 检测到只有一个可用账号，拒绝切换操作。");
      throw new Error("Only one account is available, cannot switch.");
    }
    if (this.isAuthSwitching) {
      this.logger.info("🔄 [Auth] 正在切换账号，跳过重复操作");
      return { success: false, reason: "Switch already in progress." };
    }
    this.isSystemBusy = true;
    this.isAuthSwitching = true;
    try {
      const previousAuthIndex = this.currentAuthIndex;
      const nextAuthIndex = this._getNextAuthIndex();
      this.logger.info("==================================================");
      this.logger.info(`🔄 [Auth] 开始账号切换流程`);
      this.logger.info(`   • 当前账号: #${previousAuthIndex}`);
      this.logger.info(`   • 目标账号: #${nextAuthIndex}`);
      this.logger.info("==================================================");
      try {
        await this.browserManager.switchAccount(nextAuthIndex);
        this.failureCount = 0;
        this.usageCount = 0;
        this.logger.info(
          `✅ [Auth] 成功切换到账号 #${this.currentAuthIndex}，计数已重置。`
        );
        return { success: true, newIndex: this.currentAuthIndex };
      } catch (error) {
        this.logger.error(
          `❌ [Auth] 切换到账号 #${nextAuthIndex} 失败: ${error.message}`
        );
        this.logger.warn(
          `🚨 [Auth] 切换失败，正在尝试回退到上一个可用账号 #${previousAuthIndex}...`
        );
        try {
          await this.browserManager.launchOrSwitchContext(previousAuthIndex);
          this.logger.info(`✅ [Auth] 成功回退到账号 #${previousAuthIndex}！`);
          this.failureCount = 0;
          this.usageCount = 0;
          this.logger.info("[Auth] 失败和使用计数已在回退成功后重置为0。");
          return {
            success: false,
            fallback: true,
            newIndex: this.currentAuthIndex,
          };
        } catch (fallbackError) {
          this.logger.error(
            `FATAL: ❌❌❌ [Auth] 紧急回退到账号 #${previousAuthIndex} 也失败了！服务可能中断。`
          );
          throw fallbackError;
        }
      }
    } finally {
      this.isAuthSwitching = false;
      this.isSystemBusy = false;
    }
  }

  async _switchToSpecificAuth(targetIndex) {
    if (this.isAuthSwitching) {
      this.logger.info("🔄 [Auth] 正在切换账号，跳过重复操作");
      return { success: false, reason: "Switch already in progress." };
    }
    if (!this.authSource.availableIndices.includes(targetIndex)) {
      return {
        success: false,
        reason: `切换失败：账号 #${targetIndex} 无效或不存在。`,
      };
    }
    this.isSystemBusy = true;
    this.isAuthSwitching = true;
    try {
      this.logger.info(`🔄 [Auth] 开始切换到指定账号 #${targetIndex}...`);
      await this.browserManager.switchAccount(targetIndex);
      this.failureCount = 0;
      this.usageCount = 0;
      this.logger.info(
        `✅ [Auth] 成功切换到账号 #${this.currentAuthIndex}，计数已重置。`
      );
      return { success: true, newIndex: this.currentAuthIndex };
    } catch (error) {
      this.logger.error(
        `❌ [Auth] 切换到指定账号 #${targetIndex} 失败: ${error.message}`
      );
      throw error;
    } finally {
      this.isAuthSwitching = false;
      this.isSystemBusy = false;
    }
  }

  async _handleRequestFailureAndSwitch(errorDetails, res) {
    if (this.config.failureThreshold > 0) {
      this.failureCount++;
      this.logger.warn(
        `⚠️ [Auth] 任务处理失败 - 失败计数: ${this.failureCount}/${this.config.failureThreshold} (当前账号索引: ${this.currentAuthIndex})`
      );
    }
    const isImmediateSwitch = this.config.immediateSwitchStatusCodes.includes(
      errorDetails.status
    );
    const isThresholdReached =
      this.config.failureThreshold > 0 &&
      this.failureCount >= this.config.failureThreshold;
    if (isImmediateSwitch || isThresholdReached) {
      if (isImmediateSwitch) {
        this.logger.warn(
          `🔴 [Auth] 收到状态码 ${errorDetails.status}，触发立即切换账号...`
        );
      } else {
        this.logger.warn(
          `🔴 [Auth] 达到失败阈值 (${this.failureCount}/${this.config.failureThreshold})！准备切换账号...`
        );
      }
      try {
        await this._switchToNextAuth();
        const successMessage = `🔄 目标账户无效，已自动回退至账号 #${this.currentAuthIndex}。`;
        this.logger.info(`[Auth] ${successMessage}`);
        if (res) this._sendErrorChunkToClient(res, successMessage);
      } catch (error) {
        let userMessage = `❌ 致命错误：发生未知切换错误: ${error.message}`;
        if (error.message.includes("Only one account is available")) {
          userMessage = "❌ 切换失败：只有一个可用账号。";
          this.logger.info("[Auth] 只有一个可用账号，失败计数已重置。");
          this.failureCount = 0;
        } else if (error.message.includes("回退失败原因")) {
          userMessage = `❌ 致命错误：自动切换和紧急回退均失败，服务可能已中断，请检查日志！`;
        } else if (error.message.includes("切换到账号")) {
          userMessage = `⚠️ 自动切换失败：已自动回退到账号 #${this.currentAuthIndex}，请检查目标账号是否存在问题。`;
        }
        this.logger.error(`[Auth] 后台账号切换任务最终失败: ${error.message}`);
        if (res) this._sendErrorChunkToClient(res, userMessage);
      }
      return;
    }
  }
  
  async processRequest(req, res) {
    const taskId = this._generateTaskId();
    res.on("close", () => {
      if (!res.writableEnded) {
        this.logger.warn(
          `[Task] 客户端已提前关闭任务 #${taskId} 的连接。`
        );
        this._cancelTaskInBrowser(taskId);
      }
    });

    if (!this.connectionRegistry.hasActiveConnections()) {
      if (this.isSystemBusy) {
        this.logger.warn(
          "[System] 检测到连接断开，但系统正在进行切换/恢复，拒绝新任务。"
        );
        return this._sendErrorResponse(
          res,
          503,
          "服务器正在进行内部维护（账号切换/恢复），请稍后重试。"
        );
      }

      this.logger.error(
        "❌ [System] 检测到浏览器通信链路已断开！可能是进程崩溃。正在尝试恢复..."
      );
      this.isSystemBusy = true;
      try {
        await this.browserManager.launchOrSwitchContext(this.currentAuthIndex);
        this.logger.info(`✅ [System] 浏览器已成功恢复！`);
      } catch (error) {
        this.logger.error(`❌ [System] 浏览器自动恢复失败: ${error.message}`);
        return this._sendErrorResponse(
          res,
          503,
          "服务暂时不可用：后端浏览器实例崩溃且无法自动恢复，请联系管理员。"
        );
      } finally {
        this.isSystemBusy = false;
      }
    }

    if (this.isSystemBusy) {
      this.logger.warn(
        "[System] 收到新任务，但系统正在进行切换/恢复，拒绝新任务。"
      );
      return this._sendErrorResponse(
        res,
        503,
        "服务器正在进行内部维护（账号切换/恢复），请稍后重试。"
      );
    }

    const isGenerativeRequest =
      req.method === "POST" &&
      (req.path.includes("generateContent") ||
        req.path.includes("streamGenerateContent"));
    if (this.config.switchOnUses > 0 && isGenerativeRequest) {
      this.usageCount++;
      this.logger.info(
        `[Task] 生成式任务 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`
      );
      if (this.usageCount >= this.config.switchOnUses) {
        this.needsSwitchingAfterRequest = true;
      }
    }

    const taskData = this._prepareTaskData(req, taskId);
    taskData.is_generative = isGenerativeRequest;
    
    const messageQueue = this.connectionRegistry.createMessageQueue(taskId);
    const wantsStreamByHeader =
      req.headers.accept && req.headers.accept.includes("text/event-stream");
    const wantsStreamByPath = req.path.includes(":streamGenerateContent");
    const wantsStream = wantsStreamByHeader || wantsStreamByPath;

    try {
      if (wantsStream) {
        this.logger.info(
          `[Task] 客户端启用流式传输 (${this.serverSystem.streamingMode})，进入流式处理模式...`
        );
        if (this.serverSystem.streamingMode === "fake") {
          await this._handlePseudoStreamResponse(
            taskData,
            messageQueue,
            req,
            res
          );
        } else {
          await this._handleRealStreamResponse(taskData, messageQueue, res);
        }
      } else {
        taskData.streaming_mode = "fake";
        await this._handleNonStreamResponse(taskData, messageQueue, res);
      }
    } catch (error) {
      this._handleTaskError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(taskId);
      if (this.needsSwitchingAfterRequest) {
        this.logger.info(
          `[Auth] 轮换计数已达到切换阈值 (${this.usageCount}/${this.config.switchOnUses})，将在后台自动切换账号...`
        );
        this._switchToNextAuth().catch((err) => {
          this.logger.error(`[Auth] 后台账号切换任务失败: ${err.message}`);
        });
        this.needsSwitchingAfterRequest = false;
      }
    }
  }

  async processOpenAIRequest(req, res) {
    const taskId = this._generateTaskId();
    const isOpenAIStream = req.body.stream === true;
    const model = req.body.model || "gemini-1.5-pro-latest";

    let googleBody;
    try {
      googleBody = this._translateOpenAIToGoogle(req.body, model);
    } catch (error) {
      this.logger.error(`[CompatLayer] OpenAI格式输入转换失败: ${error.message}`);
      return this._sendErrorResponse(
        res,
        400,
        "Invalid OpenAI request format."
      );
    }

    const googleEndpoint = isOpenAIStream
      ? "streamGenerateContent"
      : "generateContent";
    const taskData = {
      path: `/v1beta/models/${model}:${googleEndpoint}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      query_params: isOpenAIStream ? { alt: "sse" } : {},
      body: JSON.stringify(googleBody),
      request_id: taskId,
      is_generative: true,
      streaming_mode: "real",
      client_wants_stream: true,
    };

    const messageQueue = this.connectionRegistry.createMessageQueue(taskId);

    try {
      this._sendTaskToBrowser(taskData);
      const initialMessage = await messageQueue.dequeue();

      if (initialMessage.event_type === "error") {
        this.logger.error(
          `[CompatLayer] 收到来自浏览器的错误，将触发切换逻辑。状态码: ${initialMessage.status}, 消息: ${initialMessage.message}`
        );

        await this._handleRequestFailureAndSwitch(initialMessage, res);

        if (isOpenAIStream) {
          if (!res.writableEnded) {
            // [修复] 即使上游报错，也要给客户端一个标准的结束信号，防止客户端一直等待
            this._sendErrorChunkToClient(res, initialMessage.message);
            res.write("data: [DONE]\n\n");
            res.end();
          }
        } else {
          this._sendErrorResponse(
            res,
            initialMessage.status || 500,
            initialMessage.message
          );
        }
        return;
      }

      if (this.failureCount > 0) {
        this.logger.info(
          `✅ [Auth] 兼容模式任务成功 - 失败计数已从 ${this.failureCount} 重置为 0`
        );
        this.failureCount = 0;
      }

      if (isOpenAIStream) {
        // [修复] 强制设置流式响应头，即使上游返回的 Content-Type 不正确（例如报错时是 text/plain）
        res.status(initialMessage.status || 200).set({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        let lastGoogleChunk = "";
        while (true) {
          const message = await messageQueue.dequeue(300000);
          if (message.type === "STREAM_END") {
            res.write("data: [DONE]\n\n");
            break;
          }
           if (message.event_type === 'chunk' && message.data) {
            const translatedChunk = this._translateGoogleToOpenAIStream(
              message.data,
              model
            );
            if (translatedChunk) {
              res.write(translatedChunk);
            }
            lastGoogleChunk = message.data;
          }
        }
        try {
          if (lastGoogleChunk.startsWith("data: ")) {
            const jsonString = lastGoogleChunk.substring(6).trim();
            if (jsonString) {
              const lastResponse = JSON.parse(jsonString);
              const finishReason =
                lastResponse.candidates?.[0]?.finishReason || "UNKNOWN";
              this.logger.info(
                `✅ [Task] 兼容模式流式响应结束，原因: ${finishReason}，任务ID: ${taskId}`
              );
            }
          }
        } catch (e) {}
      } else {
        let fullBody = "";
        while (true) {
          const message = await messageQueue.dequeue(300000);
          if (message.type === "STREAM_END") {
            break;
          }
          if (message.event_type === "chunk" && message.data) {
            fullBody += message.data;
          }
        }

        const googleResponse = JSON.parse(fullBody);
        const candidate = googleResponse.candidates?.[0];
        let responseContent = "";
        if (
          candidate &&
          candidate.content &&
          Array.isArray(candidate.content.parts)
        ) {
          const imagePart = candidate.content.parts.find((p) => p.inlineData);
          if (imagePart) {
            const image = imagePart.inlineData;
            responseContent = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
            this.logger.info(
              "[CompatLayer] 从 parts.inlineData 中成功解析到图片。"
            );
          } else {
            responseContent =
              candidate.content.parts
                .filter((p) => !p.thought)
                .map((p) => p.text)
                .join("\n") || "";
          }
        }

        const messageObj = { role: "assistant", content: responseContent };
        if (
          candidate &&
          candidate.content &&
          Array.isArray(candidate.content.parts)
        ) {
          const thoughtPart = candidate.content.parts.find((p) => p.thought);
          if (thoughtPart) {
            messageObj.reasoning_content = thoughtPart.text;
          }
        }

        const openaiResponse = {
          id: `chatcmpl-${taskId}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [
            {
              index: 0,
              message: messageObj,
              finish_reason: candidate?.finishReason || "UNKNOWN",
            },
          ],
        };
        const finishReason = candidate?.finishReason || "UNKNOWN";
        this.logger.info(
          `✅ [Task] 兼容模式非流式响应结束，原因: ${finishReason}，任务ID: ${taskId}`
        );
        res.status(200).json(openaiResponse);
      }
    } catch (error) {
      this._handleTaskError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(taskId);
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  // [新增] 动态获取模型列表的方法
  async processModelListRequest(req, res) {
    const taskId = this._generateTaskId();
    const taskData = this._prepareTaskData(req, taskId);

    // 1. 强制将请求路径和方法修正为获取 Google 模型列表的真实 API
    taskData.path = "/v1beta/models";
    taskData.method = "GET";
    taskData.body = null; // GET请求没有 body
    taskData.is_generative = false;
    taskData.streaming_mode = "fake"; // 非流式请求

    // 2. [关键] 设置一个较大的 pageSize 来获取所有可用模型。
    // Google API 默认一次只返回很少的模型，设置 100 足够覆盖所有当前和未来的模型。
    taskData.query_params = { ...req.query, pageSize: 100 };

    this.logger.info(`[CompatLayer] 收到模型列表请求，正在通过浏览器转发至 Google API (pageSize=100)... (任务ID: ${taskId})`);

    const messageQueue = this.connectionRegistry.createMessageQueue(taskId);

    try {
      this._sendTaskToBrowser(taskData);

      // 等待浏览器返回的响应头
      const headerMessage = await messageQueue.dequeue(60000); // 60秒超时
      if (headerMessage.event_type === "error") {
        throw new Error(headerMessage.message || "获取模型列表时上游API出错");
      }

      // 聚合所有数据块
      let fullBody = "";
      while (true) {
        const message = await messageQueue.dequeue(60000);
        if (message.type === "STREAM_END") break;
        if (message.event_type === "chunk" && message.data) {
          fullBody += message.data;
        }
      }

      let googleModels = [];
      try {
        const googleResponse = JSON.parse(fullBody);
        googleModels = googleResponse.models || [];
      } catch (e) {
        this.logger.warn(`[CompatLayer] 解析Google模型列表JSON失败: ${e.message}`);
      }
      
      // 将 Google 返回的格式转换为 OpenAI 兼容的格式
      const openaiModels = googleModels.map(model => {
        const id = model.name.replace("models/", "");
        return {
          id: id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "google",
        };
      });

      res.status(200).json({
        object: "list",
        data: openaiModels
      });
      
      this.logger.info(`[CompatLayer] ✅ 成功获取并向客户端返回了 ${openaiModels.length} 个模型。`);

    } catch (error) {
      this.logger.error(`[CompatLayer] ❌ 获取模型列表失败: ${error.message}`);
      this._sendErrorResponse(res, 500, `Failed to fetch model list from upstream: ${error.message}`);
    } finally {
      this.connectionRegistry.removeMessageQueue(taskId);
    }
  }
  
  _cancelTaskInBrowser(taskId) {
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection) {
      this.logger.info(
        `[Task] 正在向浏览器发送取消任务 #${taskId} 的指令...`
      );
      connection.send(
        JSON.stringify({
          event_type: "cancel_request",
          request_id: taskId,
        })
      );
    } else {
      this.logger.warn(
        `[Task] 无法发送取消指令：没有可用的浏览器通信连接。`
      );
    }
  }

  _generateTaskId() {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
  _prepareTaskData(req, taskId) {
    let requestBody = "";
    if (req.body && Object.keys(req.body).length > 0) {
      requestBody = JSON.stringify(req.body);
    }
    return {
      path: req.path,
      method: req.method,
      headers: req.headers,
      query_params: req.query,
      body: requestBody,
      request_id: taskId,
      streaming_mode: this.serverSystem.streamingMode,
    };
  }
  _sendTaskToBrowser(taskData) {
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection) {
      connection.send(JSON.stringify(taskData));
    } else {
      throw new Error("无法转发任务：没有可用的通信连接。");
    }
  }
  _sendErrorChunkToClient(res, errorMessage) {
    const errorPayload = {
      error: {
        message: `[系统提示] ${errorMessage}`,
        type: "internal_error",
        code: "internal_error",
      },
    };
    const chunk = `data: ${JSON.stringify(errorPayload)}\n\n`;
    if (res && !res.writableEnded) {
      res.write(chunk);
      this.logger.info(`[Task] 已向客户端发送标准错误信号: ${errorMessage}`);
    }
  }

  async _handlePseudoStreamResponse(taskData, messageQueue, req, res) {
    this.logger.info(
      "[Task] 客户端启用流式传输 (fake)，进入模拟流式处理模式..."
    );
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const connectionMaintainer = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, 15000);

    try {
      let lastMessage,
        requestFailed = false;

      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        if (attempt > 1) {
          this.logger.info(
            `[Task] 任务尝试 #${attempt}/${this.maxRetries}...`
          );
        }
        this._sendTaskToBrowser(taskData);
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error("Response from browser timed out after 300 seconds")
                ),
              300000
            )
          );
          lastMessage = await Promise.race([
            messageQueue.dequeue(),
            timeoutPromise,
          ]);
        } catch (timeoutError) {
          this.logger.error(`[Task] 致命错误: ${timeoutError.message}`);
          lastMessage = {
            event_type: "error",
            status: 504,
            message: timeoutError.message,
          };
        }

        if (lastMessage.event_type === "error") {
          if (
            !(
              lastMessage.message &&
              lastMessage.message.includes("The user aborted a request")
            )
          ) {
            this.logger.warn(
              `[Task] 尝试 #${attempt} 失败: 收到 ${
                lastMessage.status || "未知"
              } 错误。 - ${lastMessage.message}`
            );
          }
          if (attempt < this.maxRetries) {
            await new Promise((resolve) =>
              setTimeout(resolve, this.retryDelay)
            );
            continue;
          }
          requestFailed = true;
        }
        break;
      }
      if (requestFailed) {
        if (
          lastMessage.message &&
          lastMessage.message.includes("The user aborted a request")
        ) {
          this.logger.info(
            `[Task] 任务 #${taskData.request_id} 已由用户妥善取消，不计入失败统计。`
          );
        } else {
          this.logger.error(
            `[Task] 所有 ${this.maxRetries} 次重试均失败，将计入失败统计。`
          );
          await this._handleRequestFailureAndSwitch(lastMessage, res);
          this._sendErrorChunkToClient(
            res,
            `任务最终失败: ${lastMessage.message}`
          );
        }
        return;
      }
      if (taskData.is_generative && this.failureCount > 0) {
        this.logger.info(
          `✅ [Auth] 生成任务成功 - 失败计数已从 ${this.failureCount} 重置为 0`
        );
        this.failureCount = 0;
      }
      const dataMessage = await messageQueue.dequeue();
      const endMessage = await messageQueue.dequeue();
      if (dataMessage.data) {
        res.write(`data: ${dataMessage.data}\n\n`);
      }
      if (endMessage.type !== "STREAM_END") {
        this.logger.warn("[Task] 未收到预期的流结束信号。");
      }
      try {
        const fullResponse = JSON.parse(dataMessage.data);
        const finishReason =
          fullResponse.candidates?.[0]?.finishReason || "UNKNOWN";
        this.logger.info(
          `✅ [Task] 响应结束，原因: ${finishReason}，任务ID: ${taskData.request_id}`
        );
      } catch (e) {}
      res.write("data: [DONE]\n\n");
    } catch (error) {
      this._handleTaskError(error, res);
    } finally {
      clearInterval(connectionMaintainer);
      if (!res.writableEnded) {
        res.end();
      }
      this.logger.info(
        `[Task] 响应处理结束，任务ID: ${taskData.request_id}`
      );
    }
  }

  async _handleRealStreamResponse(taskData, messageQueue, res) {
    this.logger.info(`[Task] 任务已派发给浏览器端处理...`);
    this._sendTaskToBrowser(taskData);
    const headerMessage = await messageQueue.dequeue();

    if (headerMessage.event_type === "error") {
      if (
        headerMessage.message &&
        headerMessage.message.includes("The user aborted a request")
      ) {
        this.logger.info(
          `[Task] 任务 #${taskData.request_id} 已被用户妥善取消，不计入失败统计。`
        );
      } else {
        this.logger.error(`[Task] 任务处理失败，将计入失败统计。`);
        await this._handleRequestFailureAndSwitch(headerMessage, null);
        return this._sendErrorResponse(
          res,
          headerMessage.status,
          headerMessage.message
        );
      }
      if (!res.writableEnded) res.end();
      return;
    }

    if (taskData.is_generative && this.failureCount > 0) {
      this.logger.info(
        `✅ [Auth] 生成任务成功 - 失败计数已从 ${this.failureCount} 重置为 0`
      );
      this.failureCount = 0;
    }
    this._setResponseHeaders(res, headerMessage);
    this.logger.info("[Task] 开始流式传输...");
    try {
      let lastChunk = "";
      while (true) {
        const dataMessage = await messageQueue.dequeue(30000);
        if (dataMessage.type === "STREAM_END") {
          this.logger.info("[Task] 收到流结束信号。");
          break;
        }
        if (dataMessage.data) {
          res.write(dataMessage.data);
          lastChunk = dataMessage.data;
        }
      }
      try {
        if (lastChunk.startsWith("data: ")) {
          const jsonString = lastChunk.substring(6).trim();
          if (jsonString) {
            const lastResponse = JSON.parse(jsonString);
            const finishReason =
              lastResponse.candidates?.[0]?.finishReason || "UNKNOWN";
            this.logger.info(
              `✅ [Task] 响应结束，原因: ${finishReason}，任务ID: ${taskData.request_id}`
            );
          }
        }
      } catch (e) {}
    } catch (error) {
      if (error.message !== "Queue timeout") throw error;
      this.logger.warn("[Task] 真流式响应超时，可能流已正常结束。");
    } finally {
      if (!res.writableEnded) res.end();
      this.logger.info(
        `[Task] 真流式响应连接已关闭，任务ID: ${taskData.request_id}`
      );
    }
  }

  async _handleNonStreamResponse(taskData, messageQueue, res) {
    this.logger.info(`[Task] 进入非流式处理模式...`);
    this._sendTaskToBrowser(taskData);
    try {
      const headerMessage = await messageQueue.dequeue();
      if (headerMessage.event_type === "error") {
        if (headerMessage.message?.includes("The user aborted a request")) {
          this.logger.info(
            `[Task] 任务 #${taskData.request_id} 已被用户妥善取消。`
          );
        } else {
          this.logger.error(
            `[Task] 浏览器端返回错误: ${headerMessage.message}`
          );
          await this._handleRequestFailureAndSwitch(headerMessage, null);
        }
        return this._sendErrorResponse(
          res,
          headerMessage.status || 500,
          headerMessage.message
        );
      }
      let fullBody = "";
      while (true) {
        const message = await messageQueue.dequeue(300000);
        if (message.type === "STREAM_END") {
          this.logger.info("[Task] 收到结束信号，数据接收完毕。");
          break;
        }
        if (message.event_type === "chunk" && message.data) {
          fullBody += message.data;
        }
      }
      if (taskData.is_generative && this.failureCount > 0) {
        this.logger.info(
          `✅ [Auth] 非流式生成任务成功 - 失败计数已从 ${this.failureCount} 重置为 0`
        );
        this.failureCount = 0;
      }
      try {
        let parsedBody = JSON.parse(fullBody);
        let needsReserialization = false;
        const candidate = parsedBody.candidates?.[0];
        if (candidate?.content?.parts) {
          const imagePartIndex = candidate.content.parts.findIndex(
            (p) => p.inlineData
          );
          if (imagePartIndex > -1) {
            this.logger.info(
              "[Handler] 检测到响应中的图片数据，正在转换为Markdown..."
            );
            const imagePart = candidate.content.parts[imagePartIndex];
            const image = imagePart.inlineData;
            const markdownTextPart = {
              text: `![Generated Image](data:${image.mimeType};base64,${image.data})`,
            };
            candidate.content.parts[imagePartIndex] = markdownTextPart;
            needsReserialization = true;
          }
        }
        if (needsReserialization) {
          fullBody = JSON.stringify(parsedBody);
        }
      } catch (e) {
        this.logger.warn(
          `[Handler] 响应体不是有效的JSON，或在处理图片时出错: ${e.message}`
        );
      }
      try {
        const fullResponse = JSON.parse(fullBody);
        const finishReason =
          fullResponse.candidates?.[0]?.finishReason || "UNKNOWN";
        this.logger.info(
          `✅ [Task] 响应结束，原因: ${finishReason}，任务ID: ${taskData.request_id}`
        );
      } catch (e) {}

      res
        .status(headerMessage.status || 200)
        .type("application/json")
        .send(fullBody || "{}");
      this.logger.info(`[Task] 已向客户端发送完整的非流式响应。`);
    } catch (error) {
      this._handleTaskError(error, res);
    }
  }

  _getKeepAliveChunk(req) {
    if (req.path.includes("chat/completions")) {
      const payload = {
        id: `chatcmpl-${this._generateTaskId()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-4",
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
      return `data: ${JSON.stringify(payload)}\n\n`;
    }
    if (
      req.path.includes("generateContent") ||
      req.path.includes("streamGenerateContent")
    ) {
      const payload = {
        candidates: [
          {
            content: { parts: [{ text: "" }], role: "model" },
            finishReason: null,
            index: 0,
            safetyRatings: [],
          },
        ],
      };
      return `data: ${JSON.stringify(payload)}\n\n`;
    }
    return "data: {}\n\n";
  }

  _setResponseHeaders(res, headerMessage) {
    res.status(headerMessage.status || 200);
    const headers = headerMessage.headers || {};
    Object.entries(headers).forEach(([name, value]) => {
      if (name.toLowerCase() !== "content-length") res.set(name, value);
    });
  }
  _handleTaskError(error, res) {
    if (res.headersSent) {
      this.logger.error(`[Task] 任务处理错误 (头已发送): ${error.message}`);
      if (this.serverSystem.streamingMode === "fake")
        this._sendErrorChunkToClient(res, `处理失败: ${error.message}`);
      if (!res.writableEnded) res.end();
    } else {
      this.logger.error(`[Task] 任务处理错误: ${error.message}`);
      const status = error.message.includes("超时") ? 504 : 500;
      this._sendErrorResponse(res, status, `服务内部错误: ${error.message}`);
    }
  }

  _sendErrorResponse(res, status, message) {
    if (!res.headersSent) {
      const errorPayload = {
        error: {
          code: status || 500,
          message: message,
          status: "SERVICE_UNAVAILABLE",
        },
      };
      res
        .status(status || 500)
        .type("application/json")
        .send(JSON.stringify(errorPayload));
    }
  }
  
  _translateOpenAIToGoogle(openaiBody, modelName = "") {
    this.logger.info("[CompatLayer] 开始将OpenAI格式输入翻译为Google格式...");
    let systemInstruction = null;
    const googleContents = [];
    const systemMessages = openaiBody.messages.filter(
      (msg) => msg.role === "system"
    );
    if (systemMessages.length > 0) {
      const systemContent = systemMessages.map((msg) => msg.content).join("\n");
      systemInstruction = {
        role: "system",
        parts: [{ text: systemContent }],
      };
    }
    const conversationMessages = openaiBody.messages.filter(
      (msg) => msg.role !== "system"
    );
    for (const message of conversationMessages) {
      const googleParts = [];
      if (typeof message.content === "string") {
        googleParts.push({ text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text") {
            googleParts.push({ text: part.text });
          } else if (part.type === "image_url" && part.image_url) {
            const dataUrl = part.image_url.url;
            const match = dataUrl.match(/^data:(image\/.*?);base64,(.*)$/);
            if (match) {
              googleParts.push({
                inlineData: {
                  mimeType: match[1],
                  data: match[2],
                },
              });
            }
          }
        }
      }
      googleContents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: googleParts,
      });
    }
    const googleRequest = {
      contents: googleContents,
      ...(systemInstruction && {
        systemInstruction: { parts: systemInstruction.parts },
      }),
    };
    const generationConfig = {
      temperature: openaiBody.temperature,
      topP: openaiBody.top_p,
      topK: openaiBody.top_k,
      maxOutputTokens: openaiBody.max_tokens,
      stopSequences: openaiBody.stop,
    };

    if (modelName.includes("gemini-3-pro-preview")) {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingLevel: "HIGH",
      };
    }

    googleRequest.generationConfig = generationConfig;
    googleRequest.safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ];
    this.logger.info("[CompatLayer] 输入格式翻译完成。");
    return googleRequest;
  }

  _translateGoogleToOpenAIStream(googleChunk, modelName = "gemini-pro") {
    if (!googleChunk || googleChunk.trim() === "") {
      return null;
    }
    let jsonString = googleChunk;
    if (jsonString.startsWith("data: ")) {
      jsonString = jsonString.substring(6).trim();
    }
    if (!jsonString || jsonString === "[DONE]") return null;
    let googleResponse;
    try {
      googleResponse = JSON.parse(jsonString);
    } catch (e) {
      this.logger.warn(`[CompatLayer] 无法解析目标服务返回的JSON块: ${jsonString}`);
      return null;
    }
    const candidate = googleResponse.candidates?.[0];
    if (!candidate) {
      if (googleResponse.promptFeedback) {
        this.logger.warn(
          `[CompatLayer] 目标服务返回了promptFeedback，可能已被拦截: ${JSON.stringify(
            googleResponse.promptFeedback
          )}`
        );
        const errorText = `[系统错误] 请求因安全设置被阻止. 完成原因: ${googleResponse.promptFeedback.blockReason}`;
        return `data: ${JSON.stringify({
          id: `chatcmpl-${this._generateTaskId()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [
            { index: 0, delta: { content: errorText }, finish_reason: "stop" },
          ],
        })}\n\n`;
      }
      return null;
    }
    let content = "";
    let reasoningContent = null;

    if (candidate.content && Array.isArray(candidate.content.parts)) {
      const thoughtPart = candidate.content.parts.find((p) => p.thought);
      if (thoughtPart) {
        reasoningContent = thoughtPart.text;
      }

      const imagePart = candidate.content.parts.find((p) => p.inlineData);
      if (imagePart) {
        const image = imagePart.inlineData;
        content = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
        this.logger.info("[CompatLayer] 从流式响应块中成功解析到图片。");
      } else {
        content =
          candidate.content.parts
            .filter((p) => !p.thought)
            .map((p) => p.text)
            .join("") || "";
      }
    }

    const delta = {};
    if (content) delta.content = content;
    if (reasoningContent) delta.reasoning_content = reasoningContent;

    const finishReason = candidate.finishReason;
    const openaiResponse = {
      id: `chatcmpl-${this._generateTaskId()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [
        {
          index: 0,
          delta: delta,
          finish_reason: finishReason || null,
        },
      ],
    };
    return `data: ${JSON.stringify(openaiResponse)}\n\n`;
  }
}

// ===================================================================================
// APPLICATION CORE (核心修改区)
// ===================================================================================
class ApplicationCore extends EventEmitter {
  constructor() {
    super();
    this.logger = new LoggingService("CoreService");
    this._loadConfiguration();
    this.streamingMode = this.config.streamingMode;
    this.authSource = new AuthSource(this.logger);
    this.browserManager = new BrowserManager(
      this.logger,
      this.config,
      this.authSource
    );
    this.connectionRegistry = new ConnectionRegistry(this.logger);
    this.requestHandler = new TaskHandler(
      this,
      this.connectionRegistry,
      this.logger,
      this.browserManager,
      this.config,
      this.authSource
    );
    this.httpServer = null;
    this.wsServer = null;
  }

  _loadConfiguration() {
    let config = {
      httpPort: 7860,
      host: "0.0.0.0",
      wsPort: 9998,
      streamingMode: "real",
      failureThreshold: 3,
      switchOnUses: 40,
      maxRetries: 1,
      retryDelay: 2000,
      browserExecutablePath: null,
      apiKeys: [],
      immediateSwitchStatusCodes: [429, 503],
      apiKeySource: "未设置",
    };
    const configPath = path.join(__dirname, "config.json");
    try {
      if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        config = { ...config, ...fileConfig };
        this.logger.info("[System] 已从 config.json 加载配置。");
      }
    } catch (error) {
      this.logger.warn(`[System] 无法读取或解析 config.json: ${error.message}`);
    }
    if (process.env.PORT)
      config.httpPort = parseInt(process.env.PORT, 10) || config.httpPort;
    if (process.env.HOST) config.host = process.env.HOST;
    if (process.env.STREAMING_MODE)
      config.streamingMode = process.env.STREAMING_MODE;
    if (process.env.FAILURE_THRESHOLD)
      config.failureThreshold =
        parseInt(process.env.FAILURE_THRESHOLD, 10) || config.failureThreshold;
    if (process.env.SWITCH_ON_USES)
      config.switchOnUses =
        parseInt(process.env.SWITCH_ON_USES, 10) || config.switchOnUses;
    if (process.env.MAX_RETRIES)
      config.maxRetries =
        parseInt(process.env.MAX_RETRIES, 10) || config.maxRetries;
    if (process.env.RETRY_DELAY)
      config.retryDelay =
        parseInt(process.env.RETRY_DELAY, 10) || config.retryDelay;
    if (process.env.CAMOUFOX_EXECUTABLE_PATH)
      config.browserExecutablePath = process.env.CAMOUFOX_EXECUTABLE_PATH;
    if (process.env.API_KEYS) {
      config.apiKeys = process.env.API_KEYS.split(",");
    }
    let rawCodes = process.env.IMMEDIATE_SWITCH_STATUS_CODES;
    let codesSource = "环境变量";
    if (
      !rawCodes &&
      config.immediateSwitchStatusCodes &&
      Array.isArray(config.immediateSwitchStatusCodes)
    ) {
      rawCodes = config.immediateSwitchStatusCodes.join(",");
      codesSource = "config.json 文件或默认值";
    }
    if (rawCodes && typeof rawCodes === "string") {
      config.immediateSwitchStatusCodes = rawCodes
        .split(",")
        .map((code) => parseInt(String(code).trim(), 10))
        .filter((code) => !isNaN(code) && code >= 400 && code <= 599);
      if (config.immediateSwitchStatusCodes.length > 0) {
        this.logger.info(`[System] 已从 ${codesSource} 加载“立即切换报错码”。`);
      }
    } else {
      config.immediateSwitchStatusCodes = [];
    }
    if (Array.isArray(config.apiKeys)) {
      config.apiKeys = config.apiKeys
        .map((k) => String(k).trim())
        .filter((k) => k);
    } else {
      config.apiKeys = [];
    }
    if (config.apiKeys.length > 0) {
      config.apiKeySource = "自定义";
    } else {
      config.apiKeys = ["123456"];
      config.apiKeySource = "默认";
      this.logger.info("[System] 未设置任何访问密钥，已启用默认密码: 123456");
    }
    
    // [删除] 移除加载 models.json 的逻辑
    // 我们不再需要静态模型列表，将通过 API 动态获取
    this.logger.info("[System] 模型列表将通过 API 动态获取，已忽略本地 models.json 文件。");

    this.config = config;
    this.logger.info("================ [ 生效配置 ] ================");
    this.logger.info(`  HTTP 服务端口: ${this.config.httpPort}`);
    this.logger.info(`  监听地址: ${this.config.host}`);
    this.logger.info(`  流式模式: ${this.config.streamingMode}`);
    this.logger.info(
      `  轮换计数切换阈值: ${
        this.config.switchOnUses > 0
          ? `每 ${this.config.switchOnUses} 次任务后切换`
          : "已禁用"
      }`
    );
    this.logger.info(
      `  失败计数切换: ${
        this.config.failureThreshold > 0
          ? `失败${this.config.failureThreshold} 次后切换`
          : "已禁用"
      }`
    );
    this.logger.info(
      `  立即切换报错码: ${
        this.config.immediateSwitchStatusCodes.length > 0
          ? this.config.immediateSwitchStatusCodes.join(", ")
          : "已禁用"
      }`
    );
    this.logger.info(`  单次任务最大重试: ${this.config.maxRetries}次`);
    this.logger.info(`  重试间隔: ${this.config.retryDelay}ms`);
    this.logger.info(`  访问密钥来源: ${this.config.apiKeySource}`);
    this.logger.info(
      "============================================================="
    );
  }

  async start(initialAuthIndex = null) {
    this.logger.info("[System] 开始弹性启动流程...");
    const allAvailableIndices = this.authSource.availableIndices;
    if (allAvailableIndices.length === 0) {
      throw new Error("没有任何可用的认证源，无法启动。");
    }
    let startupOrder = [...allAvailableIndices];
    if (initialAuthIndex && allAvailableIndices.includes(initialAuthIndex)) {
      this.logger.info(
        `[System] 检测到指定启动索引 #${initialAuthIndex}，将优先尝试。`
      );
      startupOrder = [
        initialAuthIndex,
        ...allAvailableIndices.filter((i) => i !== initialAuthIndex),
      ];
    } else {
      if (initialAuthIndex) {
        this.logger.warn(
          `[System] 指定的启动索引 #${initialAuthIndex} 无效或不可用，将按默认顺序启动。`
        );
      }
      this.logger.info(
        `[System] 未指定有效启动索引，将按默认顺序 [${startupOrder.join(
          ", "
        )}] 尝试。`
      );
    }
    let isStarted = false;
    for (const index of startupOrder) {
      try {
        this.logger.info(`[System] 尝试使用账号 #${index} 启动服务...`);
        await this.browserManager.launchOrSwitchContext(index);
        isStarted = true;
        this.logger.info(`[System] ✅ 使用账号 #${index} 成功启动！`);
        break;
      } catch (error) {
        this.logger.error(
          `[System] ❌ 使用账号 #${index} 启动失败。原因: ${error.message}`
        );
      }
    }
    if (!isStarted) {
      throw new Error("所有认证源均尝试失败，服务器无法启动。");
    }
    await this._startHttpServer();
    await this._startWebSocketServer();
    this.logger.info(`[System] 应用服务系统启动完成。`);
    this.emit("started");
  }
  
  _createAuthMiddleware() {
    const basicAuth = require("basic-auth");
    return (req, res, next) => {
      const serverApiKeys = this.config.apiKeys;
      if (!serverApiKeys || serverApiKeys.length === 0) {
        return next();
      }
      let clientKey = null;
      if (req.headers["x-goog-api-key"]) {
        clientKey = req.headers["x-goog-api-key"];
      } else if (
        req.headers.authorization &&
        req.headers.authorization.startsWith("Bearer ")
      ) {
        clientKey = req.headers.authorization.substring(7);
      } else if (req.headers["x-api-key"]) {
        clientKey = req.headers["x-api-key"];
      } else if (req.query.key) {
        clientKey = req.query.key;
      }
      if (clientKey && serverApiKeys.includes(clientKey)) {
        this.logger.info(
          `[Auth] 访问密钥验证通过 (来自: ${
            req.headers["x-forwarded-for"] || req.ip
          })`
        );
        if (req.query.key) {
          delete req.query.key;
        }
        return next();
      }
      if (req.path !== "/favicon.ico") {
        const clientIp = req.headers["x-forwarded-for"] || req.ip;
        this.logger.warn(
          `[Auth] 访问密码错误或缺失，已拒绝。IP: ${clientIp}, Path: ${req.path}`
        );
      }
      return res.status(401).json({
        error: {
          message:
            "Access denied. A valid access key was not found or is incorrect.",
        },
      });
    };
  }

  async _startHttpServer() {
    const app = this._createExpressApp();
    this.httpServer = http.createServer(app);
    this.httpServer.keepAliveTimeout = 15000;
    this.httpServer.headersTimeout = 20000;
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        this.logger.info(
          `[System] HTTP服务器已在 http://${this.config.host}:${this.config.httpPort} 上监听`
        );
        this.logger.info(
          `[System] Keep-Alive 超时已设置为 ${
            this.httpServer.keepAliveTimeout / 1000
          } 秒。`
        );
        resolve();
      });
    });
  }

  _createExpressApp() {
    const app = express();
    app.set('trust proxy', 1); 

    app.use((req, res, next) => {
      if (
        req.path !== "/api/status" &&
        req.path !== "/" &&
        req.path !== "/favicon.ico" &&
        req.path !== "/login" &&
        req.path !== "/logout"
      ) {
        this.logger.info(
          `[Entrypoint] 收到一个请求: ${req.method} ${req.path}`
        );
      }
      next();
    });
    
    app.use(express.json({ limit: "100mb" }));
    app.use(express.urlencoded({ extended: true }));

    const sessionSecret =
      (this.config.apiKeys && this.config.apiKeys[0]) ||
      crypto.randomBytes(20).toString("hex");
    
    app.use(cookieParser());
    app.use(
      session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: true,
        cookie: { 
            secure: true,
            sameSite: 'none',
            maxAge: 86400000 
        },
      })
    );
    
    const isAuthenticated = (req, res, next) => {
      if (req.session.isAuthenticated) {
        return next();
      }
      res.redirect("/login");
    };

    app.get("/login", (req, res) => {
      if (req.session.isAuthenticated) {
        return res.redirect("/status");
      }
      const loginHtml = `
      <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>✨ 魔法少女登录 ✨</title>
      <style>
        body {
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: linear-gradient(135deg, #fdfbfb 0%, #ebedee 100%);
          background-image: url('https://img.freepik.com/free-vector/hand-drawn-kawaii-pattern-design_23-2149636655.jpg'); /* 可爱的背景图 */
          background-size: cover;
          margin: 0;
        }
        .overlay {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(255, 255, 255, 0.6); /* 半透明遮罩 */
            z-index: 0;
        }
        form {
          position: relative;
          z-index: 1;
          background: rgba(255, 255, 255, 0.9);
          padding: 50px;
          border-radius: 25px;
          box-shadow: 0 10px 25px rgba(255, 182, 193, 0.4);
          text-align: center;
          border: 3px solid #ffb6c1;
          max-width: 350px;
          width: 100%;
        }
        h2 {
          color: #ff69b4;
          margin-bottom: 30px;
          font-size: 24px;
          text-shadow: 1px 1px 2px #fff;
        }
        input {
          width: 100%;
          padding: 15px;
          margin-top: 15px;
          border: 2px solid #ffc0cb;
          border-radius: 15px;
          box-sizing: border-box;
          font-size: 16px;
          outline: none;
          transition: border-color 0.3s;
        }
        input:focus {
          border-color: #ff69b4;
        }
        button {
          width: 100%;
          padding: 15px;
          background-color: #ff69b4;
          color: white;
          border: none;
          border-radius: 15px;
          margin-top: 30px;
          cursor: pointer;
          font-size: 18px;
          font-weight: bold;
          transition: background-color 0.3s, transform 0.2s;
          box-shadow: 0 4px 6px rgba(255, 105, 180, 0.3);
        }
        button:hover {
          background-color: #ff1493;
          transform: translateY(-2px);
        }
        button:active {
          transform: translateY(0);
        }
        .error {
          color: #ff4500;
          margin-top: 15px;
          font-weight: bold;
        }
        .decoration {
            font-size: 40px;
            margin-bottom: -20px;
            display: block;
        }
      </style>
      </head><body>
      <div class="overlay"></div>
      <form action="/login" method="post">
      <span class="decoration">🌸</span>
      <h2>✨ 请输入魔法咒语 ✨</h2>
      <input type="password" name="apiKey" placeholder="Access Key" required autofocus>
      <button type="submit">开启魔法之门</button>
      ${
        req.query.error ? '<p class="error">咒语念错啦! (密钥错误)</p>' : ""
      }</form></body></html>`;
      res.send(loginHtml);
    });

    app.post("/login", (req, res) => {
      const { apiKey } = req.body;
      if (apiKey && this.config.apiKeys.includes(apiKey)) {
        req.session.isAuthenticated = true;
        res.redirect("/status");
      } else {
        res.redirect("/login?error=1");
      }
    });

    app.get('/logout', (req, res) => {
        req.session.destroy(() => {
            res.redirect('/login');
        });
    });

    app.get("/", (req, res) => {
        if (req.session.isAuthenticated) {
            return res.redirect('/status');
        }
        res.sendFile(path.join(__dirname, 'index.html'));
    });
    
    app.get("/status", isAuthenticated, (req, res) => {
      const { config, requestHandler, authSource, browserManager } = this;
      const initialIndices = authSource.initialIndices || [];
      const availableIndices = authSource.availableIndices || [];
      const invalidIndices = initialIndices.filter(
        (i) => !availableIndices.includes(i)
      );
      const logs = this.logger.logBuffer || [];

      const accountNameMap = authSource.accountNameMap;
      const accountDetailsHtml = initialIndices
        .map((index) => {
          const isInvalid = invalidIndices.includes(index);
          const name = isInvalid
            ? "N/A (JSON格式错误)"
            : accountNameMap.get(index) || "N/A (未命名)";
          return `<span class="label" style="padding-left: 20px;">账号${index}</span>: ${name}`;
        })
        .join("\n");

      const accountOptionsHtml = availableIndices
        .map((index) => `<option value="${index}" ${index === requestHandler.currentAuthIndex ? 'selected' : ''}>账号 #${index}</option>`)
        .join("");

      const statusHtml = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>✨ 魔法服务状态 ✨</title>
        <style>
        body {
            font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
            background-color: #fff0f5;
            background-image: linear-gradient(to right, #ffecd2 0%, #fcb69f 100%);
            color: #555;
            padding: 2em;
            margin: 0;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
            background: rgba(255, 255, 255, 0.95);
            padding: 2em;
            border-radius: 20px;
            box-shadow: 0 10px 20px rgba(255, 182, 193, 0.3);
            border: 2px solid #ffe4e1;
        }
        h1, h2 {
            color: #ff69b4;
            border-bottom: 2px dashed #ffb6c1;
            padding-bottom: 0.5em;
            text-align: center;
        }
        h1 { font-size: 2em; }
        h2 { font-size: 1.5em; margin-top: 1.5em; }
        
        pre {
            background: #fff5f8;
            color: #444;
            font-size: 1em;
            padding: 1.5em;
            border-radius: 15px;
            white-space: pre-wrap;
            word-wrap: break-word;
            line-height: 1.8;
            border: 1px solid #ffc0cb;
            font-family: 'Consolas', monospace;
        }
        #log-container {
            font-size: 0.9em;
            max-height: 400px;
            overflow-y: auto;
            background: #2d2d2d; /* 日志保持深色背景以便阅读 */
            color: #f0f0f0;
            border: 2px solid #ffb6c1;
        }
        
        .status-ok { color: #32cd32; font-weight: bold; }
        .status-error { color: #ff4500; font-weight: bold; }
        .label { display: inline-block; width: 220px; box-sizing: border-box; color: #888; font-weight: 500; }
        
        .dot {
            height: 12px;
            width: 12px;
            background-color: #ff69b4;
            border-radius: 50%;
            display: inline-block;
            margin-left: 10px;
            animation: blink 1s infinite alternate;
            box-shadow: 0 0 5px #ff69b4;
        }
        @keyframes blink { from { opacity: 0.4; transform: scale(0.8); } to { opacity: 1; transform: scale(1.2); } }
        
        .action-group {
            display: flex;
            flex-wrap: wrap;
            gap: 15px;
            align-items: center;
            justify-content: center;
            background: #fff0f5;
            padding: 20px;
            border-radius: 15px;
        }
        
        .action-group button, .action-group select {
            font-size: 1em;
            border: 2px solid #ffb6c1;
            padding: 10px 20px;
            border-radius: 25px;
            cursor: pointer;
            transition: all 0.3s ease;
            outline: none;
        }
        
        .action-group select {
            background-color: #fff;
            color: #ff69b4;
        }
        
        .action-group button {
            font-weight: bold;
            box-shadow: 0 3px 5px rgba(0,0,0,0.1);
        }
        
        .action-group button:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 8px rgba(0,0,0,0.15);
        }
        
        #switch-btn { background-color: #ff69b4; color: white; border-color: #ff69b4; }
        #switch-btn:hover { background-color: #ff1493; }
        
        #mode-btn { background-color: #87ceeb; color: white; border-color: #87ceeb; }
        #mode-btn:hover { background-color: #00bfff; }
        
        #logout-btn { background-color: #ff7f50; color: white; border-color: #ff7f50; }
        #logout-btn:hover { background-color: #ff4500; }
        
        @media (max-width: 600px) {
            body { padding: 0.5em; }
            .container { padding: 1em; margin: 0.5em; width: auto; }
            pre { padding: 1em; font-size: 0.9em; }
            .label { width: auto; display: inline; }
            .action-group { flex-direction: column; align-items: stretch; }
            .action-group select, .action-group button { width: 100%; }
        }
        
        /* 滚动条美化 */
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #fff0f5; }
        ::-webkit-scrollbar-thumb { background: #ffb6c1; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #ff69b4; }
        </style>
    </head>
    <body>
        <div class="container">
        <h1>✨ 魔法服务状态 ✨ <span class="dot" title="魔法能量充盈中..."></span></h1>
        <div id="status-section">
            <pre>
<span class="label">🌟 服务状态</span>: <span class="status-ok">运行中 (Running)</span>
<span class="label">🌐 浏览器连接</span>: <span class="${
        browserManager.browser ? "status-ok" : "status-error"
      }">${!!browserManager.browser ? "已连接 (Connected)" : "断开 (Disconnected)"}</span>
--- ⚙️ 魔法配置 ---
<span class="label">🌊 流模式</span>: ${
        config.streamingMode
      } (仅启用流式传输时生效)
<span class="label">⚡ 立即切换 (状态码)</span>: ${
        config.immediateSwitchStatusCodes.length > 0
          ? `[${config.immediateSwitchStatusCodes.join(", ")}]`
          : "已禁用"
      }
<span class="label">🔑 访问密钥</span>: ${config.apiKeySource}
--- 👤 账号状态 ---
<span class="label">👉 当前使用账号</span>: #${requestHandler.currentAuthIndex}
<span class="label">📊 使用次数计数</span>: ${requestHandler.usageCount} / ${
        config.switchOnUses > 0 ? config.switchOnUses : "N/A"
      }
<span class="label">❌ 连续失败计数</span>: ${requestHandler.failureCount} / ${
        config.failureThreshold > 0 ? config.failureThreshold : "N/A"
      }
<span class="label">📋 扫描到的总帐号</span>: [${initialIndices.join(
        ", "
      )}] (总数: ${initialIndices.length})
      ${accountDetailsHtml}
<span class="label">⚠️ 格式错误 (已忽略)</span>: [${invalidIndices.join(
        ", "
      )}] (总数: ${invalidIndices.length})
            </pre>
        </div>
        <div id="log-section" style="margin-top: 2em;">
            <h2>📜 魔法日志 (最近 ${logs.length} 条)</h2>
            <pre id="log-container">${logs.join("\n")}</pre>
        </div>
        <div id="actions-section" style="margin-top: 2em;">
            <h2>🎮 魔法控制台</h2>
            <div class="action-group">
                <select id="accountIndexSelect">${accountOptionsHtml}</select>
                <button id="switch-btn" onclick="switchSpecificAccount()">✨ 切换指定账号</button>
                <button id="mode-btn" onclick="toggleStreamingMode()">🌊 切换流模式</button>
                <button id="logout-btn" onclick="window.location.href='/logout'">🚪 退出魔法屋</button>
            </div>
        </div>
        </div>
        <script>
        function updateContent() {
            fetch('/api/status').then(response => {
                if (response.redirected) {
                    window.location.href = response.url;
                    return;
                }
                if (!response.ok) { throw new Error('Network response was not ok'); }
                return response.json();
            }).then(data => {
                if (!data) return;
                const statusPre = document.querySelector('#status-section pre');
                const accountDetailsHtml = data.status.accountDetails.map(acc => {
                  return '<span class="label" style="padding-left: 20px;">账号' + acc.index + '</span>: ' + acc.name;
                }).join('\\n');
                statusPre.innerHTML = 
                    '<span class="label">服务状态</span>: <span class="status-ok">Running</span>\\n' +
                    '<span class="label">浏览器连接</span>: <span class="' + (data.status.browserConnected ? "status-ok" : "status-error") + '">' + data.status.browserConnected + '</span>\\n' +
                    '--- 服务配置 ---\\n' +
                    '<span class="label">流模式</span>: ' + data.status.streamingMode + '\\n' +
                    '<span class="label">立即切换 (状态码)</span>: ' + data.status.immediateSwitchStatusCodes + '\\n' +
                    '<span class="label">访问密钥</span>: ' + data.status.apiKeySource + '\\n' +
                    '--- 账号状态 ---\\n' +
                    '<span class="label">当前使用账号</span>: #' + data.status.currentAuthIndex + '\\n' +
                    '<span class="label">使用次数计数</span>: ' + data.status.usageCount + '\\n' +
                    '<span class="label">连续失败计数</span>: ' + data.status.failureCount + '\\n' +
                    '<span class="label">扫描到的总账号</span>: ' + data.status.initialIndices + '\\n' +
                    accountDetailsHtml + '\\n' +
                    '<span class="label">格式错误 (已忽略)</span>: ' + data.status.invalidIndices;
                
                const logContainer = document.getElementById('log-container');
                const logTitle = document.querySelector('#log-section h2');
                const isScrolledToBottom = logContainer.scrollHeight - logContainer.clientHeight <= logContainer.scrollTop + 1;
                logTitle.innerText = \`实时日志 (最近 \${data.logCount} 条)\`;
                logContainer.innerText = data.logs;
                if (isScrolledToBottom) { logContainer.scrollTop = logContainer.scrollHeight; }

                const select = document.getElementById('accountIndexSelect');
                 const currentSelection = select.value;
                const newIndex = data.status.currentAuthIndex.toString();
                if(currentSelection !== newIndex) {
                    select.value = newIndex;
                }
            }).catch(error => { 
                console.error('Error fetching new content:', error)
                setTimeout(() => window.location.reload(), 1500);
            });
        }
        function switchSpecificAccount() {
            const selectElement = document.getElementById('accountIndexSelect');
            const targetIndex = selectElement.value;
            if (!targetIndex || !confirm(\`确定要切换到账号 #\${targetIndex} 吗？这会重置浏览器会话。\`)) {
                return;
            }
            fetch('/api/switch-account', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetIndex: parseInt(targetIndex, 10) })
            })
            .then(res => res.text()).then(data => { alert(data); updateContent(); })
            .catch(err => { alert('操作失败: ' + err); updateContent(); });
        }
        function toggleStreamingMode() { 
            const newMode = prompt('请输入新的流模式 (real 或 fake):', '${
              this.config.streamingMode
            }');
            if (newMode === 'fake' || newMode === 'real') {
                fetch('/api/set-mode', { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ mode: newMode }) 
                })
                .then(res => res.text()).then(data => { alert(data); updateContent(); })
                .catch(err => alert('设置失败: ' + err));
            } else if (newMode !== null) { 
                alert('无效的模式！请只输入 "real" 或 "fake"。'); 
            } 
        }
        document.addEventListener('DOMContentLoaded', () => {
            updateContent(); 
            setInterval(updateContent, 5000);
        });
        </script>
    </body>
    </html>
    `;
      res.status(200).send(statusHtml);
    });

    app.get("/api/status", isAuthenticated, (req, res) => {
        const { config, requestHandler, authSource, browserManager } = this;
        const initialIndices = authSource.initialIndices || [];
        const invalidIndices = initialIndices.filter(
            (i) => !authSource.availableIndices.includes(i)
        );
        const logs = this.logger.logBuffer || [];
        const accountNameMap = authSource.accountNameMap;
        const accountDetails = initialIndices.map((index) => {
            const isInvalid = invalidIndices.includes(index);
            const name = isInvalid
                ? "N/A (JSON格式错误)"
                : accountNameMap.get(index) || "N/A (未命名)";
            return { index, name };
        });
        const data = {
            status: {
                streamingMode: `${this.streamingMode} (仅启用流式传输时生效)`,
                browserConnected: !!browserManager.browser,
                immediateSwitchStatusCodes:
                    config.immediateSwitchStatusCodes.length > 0
                        ? `[${config.immediateSwitchStatusCodes.join(", ")}]`
                        : "已禁用",
                apiKeySource: config.apiKeySource,
                currentAuthIndex: requestHandler.currentAuthIndex,
                usageCount: `${requestHandler.usageCount} / ${config.switchOnUses > 0 ? config.switchOnUses : "N/A"
                    }`,
                failureCount: `${requestHandler.failureCount} / ${config.failureThreshold > 0 ? config.failureThreshold : "N/A"
                    }`,
                initialIndices: `[${initialIndices.join(", ")}] (总数: ${initialIndices.length
                    })`,
                accountDetails: accountDetails,
                invalidIndices: `[${invalidIndices.join(", ")}] (总数: ${invalidIndices.length
                    })`,
            },
            logs: logs.join("\n"),
            logCount: logs.length,
        };
        res.json(data);
    });
    app.post("/api/switch-account", isAuthenticated, async (req, res) => {
        try {
            const { targetIndex } = req.body;
            if (targetIndex !== undefined && targetIndex !== null) {
                this.logger.info(
                    `[WebUI] 收到切换到指定账号 #${targetIndex} 的请求...`
                );
                const result = await this.requestHandler._switchToSpecificAuth(
                    targetIndex
                );
                if (result.success) {
                    res.status(200).send(`切换成功！已激活账号 #${result.newIndex}。`);
                } else {
                    res.status(400).send(result.reason);
                }
            } else {
                this.logger.info("[WebUI] 收到手动切换下一个账号的请求...");
                if (this.authSource.availableIndices.length <= 1) {
                    return res
                        .status(400)
                        .send("切换操作已取消：只有一个可用账号，无法切换。");
                }
                const result = await this.requestHandler._switchToNextAuth();
                if (result.success) {
                    res
                        .status(200)
                        .send(`切换成功！已切换到账号 #${result.newIndex}。`);
                } else if (result.fallback) {
                    res
                        .status(200)
                        .send(`切换失败，但已成功回退到账号 #${result.newIndex}。`);
                } else {
                    res.status(409).send(`操作未执行: ${result.reason}`);
                }
            }
        } catch (error) {
            res
                .status(500)
                .send(`致命错误：操作失败！请检查日志。错误: ${error.message}`);
        }
    });
    app.post("/api/set-mode", isAuthenticated, (req, res) => {
        const newMode = req.body.mode;
        if (newMode === "fake" || newMode === "real") {
            this.streamingMode = newMode;
            this.logger.info(
                `[WebUI] 流式模式已由认证用户切换为: ${this.streamingMode}`
            );
            res.status(200).send(`流式模式已切换为: ${this.streamingMode}`);
        } else {
            res.status(400).send('无效模式. 请用 "fake" 或 "real".');
        }
    });
    
    // --- 路由修改区 ---
    app.use(this._createAuthMiddleware());

    // [修改] 将 /v1/models 路由指向新的动态处理方法
    app.get("/v1/models", (req, res) => {
      this.requestHandler.processModelListRequest(req, res);
    });

    app.post("/v1/chat/completions", (req, res) => {
      this.requestHandler.processOpenAIRequest(req, res);
    });
    app.all(/(.*)/, (req, res) => {
      this.requestHandler.processRequest(req, res);
    });

    return app;
  }


  async _startWebSocketServer() {
    this.wsServer = new WebSocket.Server({
      port: this.config.wsPort,
      host: this.config.host,
    });
    this.wsServer.on("connection", (ws, req) => {
      this.connectionRegistry.addConnection(ws, {
        address: req.socket.remoteAddress,
      });
    });
  }
}

async function initializeServer() {
  const initialAuthIndex = parseInt(process.env.INITIAL_AUTH_INDEX, 10) || 1;
  try {
    const serverSystem = new ApplicationCore();
    await serverSystem.start(initialAuthIndex);
  } catch (error) {
    console.error("❌ 服务器启动失败:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  initializeServer();
}

module.exports = { ApplicationCore, BrowserManager, initializeServer };
