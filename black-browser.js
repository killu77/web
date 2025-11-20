const Logger = {
  enabled: true,
  output(...messages) {
    if (!this.enabled) return;
    const timestamp =
      new Date().toLocaleTimeString("zh-CN", { hour12: false }) +
      "." +
      new Date().getMilliseconds().toString().padStart(3, "0");
    // [伪装] 日志前缀修改
    console.log(`[BrowserTask] ${timestamp}`, ...messages);
    const logElement = document.createElement("div");
    logElement.textContent = `[${timestamp}] ${messages.join(" ")}`;
    document.body.appendChild(logElement);
  },
};

class ConnectionManager extends EventTarget {
  constructor(endpoint = "ws://127.0.0.1:9998") {
    super();
    this.endpoint = endpoint;
    this.socket = null;
    this.isConnected = false;
    this.reconnectDelay = 5000;
    this.reconnectAttempts = 0;
  }

  async establish() {
    if (this.isConnected) return Promise.resolve();
    Logger.output("正在连接到主服务:", this.endpoint);
    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.endpoint);
        this.socket.addEventListener("open", () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          Logger.output("✅ 与主服务连接成功!");
          this.dispatchEvent(new CustomEvent("connected"));
          resolve();
        });
        this.socket.addEventListener("close", () => {
          this.isConnected = false;
          Logger.output("❌ 与主服务连接已断开，准备重连...");
          this.dispatchEvent(new CustomEvent("disconnected"));
          this._scheduleReconnect();
        });
        this.socket.addEventListener("error", (error) => {
          Logger.output(" 通信链路错误:", error);
          this.dispatchEvent(new CustomEvent("error", { detail: error }));
          if (!this.isConnected) reject(error);
        });
        this.socket.addEventListener("message", (event) => {
          this.dispatchEvent(
            new CustomEvent("message", { detail: event.data })
          );
        });
      } catch (e) {
        Logger.output(
          "通信模块初始化失败。请检查地址或浏览器安全策略。",
          e.message
        );
        reject(e);
      }
    });
  }

  transmit(data) {
    if (!this.isConnected || !this.socket) {
      Logger.output("无法发送数据：连接未建立");
      return false;
    }
    this.socket.send(JSON.stringify(data));
    return true;
  }

  _scheduleReconnect() {
    this.reconnectAttempts++;
    setTimeout(() => {
      Logger.output(`正在进行第 ${this.reconnectAttempts} 次重连尝试...`);
      this.establish().catch(() => {});
    }, this.reconnectDelay);
  }
}

// [伪装] 类名修改
class DataFetcher {
  constructor() {
    this.activeOperations = new Map();
    this.cancelledOperations = new Set();
    this.targetDomain = "generativelanguage.googleapis.com";
    this.maxRetries = 3;
    this.retryDelay = 2000;
  }

  execute(requestSpec, operationId) {
    const IDLE_TIMEOUT_DURATION = 600000;
    const abortController = new AbortController();
    this.activeOperations.set(operationId, abortController);

    let timeoutId = null;

    const startIdleTimeout = () => {
      return new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error(
            `超时: ${IDLE_TIMEOUT_DURATION / 1000} 秒内未收到任何数据`
          );
          abortController.abort();
          reject(error);
        }, IDLE_TIMEOUT_DURATION);
      });
    };

    const cancelTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        Logger.output("已收到数据块，超时限制已解除。");
      }
    };

    const attemptPromise = new Promise(async (resolve, reject) => {
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          Logger.output(
            `执行数据请求 (尝试 ${attempt}/${this.maxRetries}):`,
            requestSpec.method,
            requestSpec.path
          );

          const requestUrl = this._constructUrl(requestSpec);
          const requestConfig = this._buildRequestConfig(
            requestSpec,
            abortController.signal
          );

          const response = await fetch(requestUrl, requestConfig);

          if (!response.ok) {
            const errorBody = await response.text();
            // [伪装] 日志文本修改
            const error = new Error(
              `目标服务返回错误: ${response.status} ${response.statusText} ${errorBody}`
            );
            error.status = response.status;
            throw error;
          }

          resolve(response);
          return;
        } catch (error) {
          if (error.name === "AbortError") {
            reject(error);
            return;
          }
          const isNetworkError = error.message.includes("Failed to fetch");
          const isRetryableServerError =
            error.status && [500, 502, 503, 504].includes(error.status);
          if (
            (isNetworkError || isRetryableServerError) &&
            attempt < this.maxRetries
          ) {
            Logger.output(
              `❌ 请求尝试 #${attempt} 失败: ${error.message.substring(0, 200)}`
            );
            Logger.output(`将在 ${this.retryDelay / 1000}秒后重试...`);
            await new Promise((r) => setTimeout(r, this.retryDelay));
            continue;
          } else {
            reject(error);
            return;
          }
        }
      }
    });

    const responsePromise = Promise.race([attemptPromise, startIdleTimeout()]);

    return { responsePromise, cancelTimeout };
  }

  cancelAllOperations() {
    this.activeOperations.forEach((controller, id) => controller.abort());
    this.activeOperations.clear();
  }

  _constructUrl(requestSpec) {
    let pathSegment = requestSpec.path.startsWith("/")
      ? requestSpec.path.substring(1)
      : requestSpec.path;
    const queryParams = new URLSearchParams(requestSpec.query_params);
    if (requestSpec.streaming_mode === "fake") {
      Logger.output("模拟流式模式激活，正在修改请求...");
      if (pathSegment.includes(":streamGenerateContent")) {
        pathSegment = pathSegment.replace(
          ":streamGenerateContent",
          ":generateContent"
        );
        Logger.output(`目标路径已修改为: ${pathSegment}`);
      }
      if (queryParams.has("alt") && queryParams.get("alt") === "sse") {
        queryParams.delete("alt");
        Logger.output('已移除 "alt=sse" 查询参数。');
      }
    }
    const queryString = queryParams.toString();
    return `https://${this.targetDomain}/${pathSegment}${
      queryString ? "?" + queryString : ""
    }`;
  }

  _generateRandomString(length) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++)
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
  }

  _buildRequestConfig(requestSpec, signal) {
    const config = {
      method: requestSpec.method,
      headers: this._sanitizeHeaders(requestSpec.headers),
      signal,
    };

    if (
      ["POST", "PUT", "PATCH"].includes(requestSpec.method) &&
      requestSpec.body
    ) {
      try {
        let bodyObj = JSON.parse(requestSpec.body);
        const isImageModel =
          requestSpec.path.includes("-image-") ||
          requestSpec.path.includes("imagen");

        if (isImageModel) {
          const incompatibleKeys = ["tool_config", "toolChoice", "tools"];
          incompatibleKeys.forEach((key) => {
            if (bodyObj.hasOwnProperty(key)) delete bodyObj[key];
          });
          if (bodyObj.generationConfig?.thinkingConfig) {
            delete bodyObj.generationConfig.thinkingConfig;
          }
        }
        
        config.body = JSON.stringify(bodyObj);
      } catch (e) {
        Logger.output("处理请求体时发生错误:", e.message);
        config.body = requestSpec.body;
      }
    }

    return config;
  }
  _sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    [
      "host",
      "connection",
      "content-length",
      "origin",
      "referer",
      "user-agent",
      "sec-fetch-mode",
      "sec-fetch-site",
      "sec-fetch-dest",
    ].forEach((h) => delete sanitized[h]);
    return sanitized;
  }
  cancelOperation(operationId) {
    this.cancelledOperations.add(operationId);
    const controller = this.activeOperations.get(operationId);
    if (controller) {
      Logger.output(`收到取消指令，正在中止任务 #${operationId}...`);
      controller.abort();
    }
  }
}

// [伪装] 类名修改
class PageWorker extends EventTarget {
  constructor(websocketEndpoint) {
    super();
    this.connectionManager = new ConnectionManager(websocketEndpoint);
    this.dataFetcher = new DataFetcher();
    this._setupEventHandlers();
  }

  async initialize() {
    Logger.output("浏览器端工作程序初始化中...");
    try {
      await this.connectionManager.establish();
      Logger.output("初始化完成，等待主服务指令...");
      this.dispatchEvent(new CustomEvent("ready"));
    } catch (error) {
      Logger.output("工作程序初始化失败:", error.message);
      this.dispatchEvent(new CustomEvent("error", { detail: error }));
      throw error;
    }
  }

  _setupEventHandlers() {
    this.connectionManager.addEventListener("message", (e) =>
      this._handleIncomingMessage(e.detail)
    );
    this.connectionManager.addEventListener("disconnected", () =>
      this.dataFetcher.cancelAllOperations()
    );
  }

  async _handleIncomingMessage(messageData) {
    let requestSpec = {};
    try {
      requestSpec = JSON.parse(messageData);

      switch (requestSpec.event_type) {
        case "cancel_request":
          this.dataFetcher.cancelOperation(requestSpec.request_id);
          break;
        default:
          Logger.output(`收到任务: ${requestSpec.method} ${requestSpec.path}`);
          await this._processDataRequest(requestSpec);
          break;
      }
    } catch (error) {
      Logger.output("消息处理错误:", error.message);
      if (
        requestSpec.request_id &&
        requestSpec.event_type !== "cancel_request"
      ) {
        this._sendErrorResponse(error, requestSpec.request_id);
      }
    }
  }

  // [伪装] 函数名和日志修改
  async _processDataRequest(requestSpec) {
    const operationId = requestSpec.request_id;
    const mode = requestSpec.streaming_mode || "fake";
    Logger.output(`浏览器收到任务`);

    try {
      if (this.dataFetcher.cancelledOperations.has(operationId)) {
        throw new DOMException("The user aborted a request.", "AbortError");
      }
      const { responsePromise } = this.dataFetcher.execute(
        requestSpec,
        operationId
      );
      const response = await responsePromise;
      if (this.dataFetcher.cancelledOperations.has(operationId)) {
        throw new DOMException("The user aborted a request.", "AbortError");
      }

      this._transmitHeaders(response, operationId);
      const reader = response.body.getReader();
      const textDecoder = new TextDecoder();
      let fullBody = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = textDecoder.decode(value, { stream: true });

        if (mode === "real") {
          this._transmitChunk(chunk, operationId);
        } else {
          fullBody += chunk;
        }
      }

      Logger.output("数据流已读取完成。");

      if (mode === "fake") {
        this._transmitChunk(fullBody, operationId);
      }

      this._transmitStreamEnd(operationId);
    } catch (error) {
      if (error.name === "AbortError") {
        Logger.output(`[诊断] 任务 #${operationId} 已被用户中止。`);
      } else {
        Logger.output(`❌ 任务处理失败: ${error.message}`);
      }
      this._sendErrorResponse(error, operationId);
    } finally {
      this.dataFetcher.activeOperations.delete(operationId);
      this.dataFetcher.cancelledOperations.delete(operationId);
    }
  }

  _transmitHeaders(response, operationId) {
    const headerMap = {};
    response.headers.forEach((v, k) => {
      headerMap[k] = v;
    });
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "response_headers",
      status: response.status,
      headers: headerMap,
    });
  }

  _transmitChunk(chunk, operationId) {
    if (!chunk) return;
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "chunk",
      data: chunk,
    });
  }

  _transmitStreamEnd(operationId) {
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "stream_close",
    });
    Logger.output("任务完成，已发送结束信号");
  }

  _sendErrorResponse(error, operationId) {
    if (!operationId) return;
    // [伪装] 错误信息修改
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "error",
      status: error.status || 504,
      message: `浏览器端任务执行错误: ${error.message || "未知错误"}`,
    });
    if (error.name === "AbortError") {
      Logger.output("已将“中止”状态发送回主服务");
    } else {
      Logger.output("已将“错误”信息发送回主服务");
    }
  }
}

// [伪装] 函数名和日志修改
async function initializePageWorker() {
  document.body.innerHTML = "";
  const pageWorker = new PageWorker();
  try {
    await pageWorker.initialize();
  } catch (error) {
    console.error("浏览器端工作程序启动失败:", error);
    Logger.output("浏览器端工作程序启动失败:", error.message);
  }
}

initializePageWorker();
