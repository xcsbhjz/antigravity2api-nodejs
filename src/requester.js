import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch } from 'os';
import zlib from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 检测是否在 pkg 打包环境中运行
const isPkg = typeof process.pkg !== 'undefined';

// gzip 解压辅助函数
function decompressGzip(buffer) {
  return new Promise((resolve, reject) => {
    zlib.gunzip(buffer, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

class FingerprintRequester {
  constructor(options = {}) {
    this.binDir = options.binDir || this._detectBinDir();
    this.binaryPath = options.binaryPath || this._detectBinary();
    this.configPath = options.configPath || join(__dirname, 'bin', 'config.json');
    this.defaults = {
      timeout: options.timeout || 30, // seconds
      proxy: options.proxy || null,
    };
    this.activeProcesses = new Set();
    // 用于长连接模式的进程管理
    this.proc = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.buffer = '';
    this.writeQueue = Promise.resolve();
  }

  _detectBinDir() {
    // pkg 环境下优先使用可执行文件旁边的 bin 目录
    if (isPkg) {
      const exeDir = dirname(process.execPath);
      const exeBinDir = join(exeDir, 'bin');
      if (existsSync(exeBinDir)) {
        return exeBinDir;
      }
      // 其次使用当前工作目录的 bin 目录
      const cwdBinDir = join(process.cwd(), 'bin');
      if (existsSync(cwdBinDir)) {
        return cwdBinDir;
      }
    }
    // 开发环境
    return join(__dirname, 'bin');
  }

  _detectBinary() {
    const platformMap = {
      win32: 'windows',
      linux: 'linux',
      android: 'android',
      darwin: 'linux', // fallback to linux for macOS
    };

    const archMap = {
      x64: 'amd64',
      arm64: 'arm64',
    };

    const os = platformMap[platform()];
    const cpuArch = archMap[arch()];

    if (!os || !cpuArch) {
      throw new Error(`Unsupported platform: ${platform()} ${arch()}`);
    }

    const ext = platform() === 'win32' ? '.exe' : '';
    const binaryName = `fingerprint_${os}_${cpuArch}${ext}`;
    const binaryPath = join(this.binDir, binaryName);

    if (!existsSync(binaryPath)) {
      throw new Error(`Binary not found: ${binaryPath}`);
    }

    return binaryPath;
  }

  async request(config) {
    const {
      method = 'GET',
      url,
      headers = {},
      data = '',
      timeout,
      proxy,
      responseType = 'text',
      onDownloadProgress,
      validateStatus = (status) => status >= 200 && status < 300,
      signal,
      skipGzipDecompress = false, // 是否跳过 gzip 解压（流式响应应设为 true）
    } = config;

    if (!url) {
      throw new Error('URL is required');
    }

    const requestPayload = {
      method: method.toUpperCase(),
      url,
      headers,
      body: typeof data === 'string' ? data : JSON.stringify(data),
      config_path: this.configPath,
    };

    // Add timeout if specified (in seconds)
    const timeoutSec = timeout || this.defaults.timeout;
    if (timeoutSec) {
      requestPayload.timeout = {
        connect: timeoutSec,
        read: timeoutSec,
      };
    }

    // Add proxy if specified
    const proxyUrl = proxy || this.defaults.proxy;
    if (proxyUrl) {
      const proxyType = proxyUrl.startsWith('socks') ? 'socks5' : 'http';
      requestPayload.proxy = {
        enabled: true,
        type: proxyType,
        url: proxyUrl,
      };
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaryPath);
      this.activeProcesses.add(proc);
      let headersParsed = false;
      let responseHeaders = {};
      let responseStatus = 200;
      let responseStatusText = 'OK';
      let headerBuffer = '';
      let bodyChunks = [];
      let totalLoaded = 0;
      let stderrData = '';

      const timeoutId = setTimeout(() => {
        proc.kill();
        const error = new Error('Request timeout');
        error.code = 'ECONNABORTED';
        error.config = config;
        reject(error);
      }, timeoutSec * 1000);

      // Support request cancellation
      if (signal) {
        signal.addEventListener('abort', () => {
          proc.kill();
          clearTimeout(timeoutId);
          const error = new Error('Request aborted');
          error.code = 'ERR_CANCELED';
          error.config = config;
          reject(error);
        });
      }

      proc.stdout.on('data', (chunk) => {
        if (!headersParsed) {
          headerBuffer += chunk.toString();
          const headerEndIndex = headerBuffer.indexOf('\r\n\r\n');
          
          if (headerEndIndex !== -1) {
            // Parse headers
            const headerPart = headerBuffer.substring(0, headerEndIndex);
            const bodyPart = headerBuffer.substring(headerEndIndex + 4);
            
            const lines = headerPart.split('\r\n');
            const statusMatch = lines[0].match(/HTTP\/[\d.]+ (\d+) (.+)/);
            responseStatus = statusMatch ? parseInt(statusMatch[1]) : 200;
            responseStatusText = statusMatch ? statusMatch[2] : 'OK';
            
            for (let i = 1; i < lines.length; i++) {
              const [key, ...valueParts] = lines[i].split(': ');
              if (key) responseHeaders[key.toLowerCase()] = valueParts.join(': ');
            }
            
            headersParsed = true;
            
            // Clear timeout for streaming responses
            clearTimeout(timeoutId);
            
            // 先调用 validateStatus 让外部知道状态码
            if (validateStatus) {
              validateStatus(responseStatus);
            }
            
            // Process body part after headers
            if (bodyPart) {
              bodyChunks.push(Buffer.from(bodyPart));
              totalLoaded += bodyPart.length;
              if (onDownloadProgress) {
                onDownloadProgress({
                  loaded: totalLoaded,
                  total: parseInt(responseHeaders['content-length']) || 0,
                  chunk: bodyPart,
                  status: responseStatus,
                });
              }
            }
          }
        } else {
          // Headers already parsed, process body chunks
          const chunkStr = chunk.toString();
          bodyChunks.push(chunk);
          totalLoaded += chunk.length;
          if (onDownloadProgress) {
            onDownloadProgress({
              loaded: totalLoaded,
              total: parseInt(responseHeaders['content-length']) || 0,
              chunk: chunkStr,
              status: responseStatus,
            });
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        stderrData += chunk.toString();
      });

      proc.on('close', async (code) => {
        clearTimeout(timeoutId);
        this.activeProcesses.delete(proc);

        if (code !== 0) {
          let errorInfo = { error: `Process exited with code ${code}`, error_type: 'UNKNOWN_ERROR' };
          if (stderrData) {
            try {
              errorInfo = JSON.parse(stderrData);
            } catch (e) {
              errorInfo.error = stderrData;
            }
          }
          const error = new Error(errorInfo.error);
          error.code = code === 3 ? 'ECONNABORTED' : code === 4 ? 'ERR_CONFIG' : 'ERR_NETWORK';
          error.errorType = errorInfo.error_type;
          error.exitCode = code;
          error.config = config;
          return reject(error);
        }

        try {
          let bodyBuffer = Buffer.concat(bodyChunks);
          
          // 检查是否需要 gzip 解压
          const contentEncoding = responseHeaders['content-encoding'] || '';
          if (!skipGzipDecompress && contentEncoding.toLowerCase().includes('gzip')) {
            try {
              bodyBuffer = await decompressGzip(bodyBuffer);
            } catch (gzipErr) {
              // gzip 解压失败，使用原始数据
              console.warn('Gzip decompression failed, using raw data:', gzipErr.message);
            }
          }
          
          const body = bodyBuffer.toString('utf8');
          let parsedData = body;
          
          if (responseType === 'json') {
            try {
              parsedData = JSON.parse(body);
            } catch (e) {
              // keep as text if parse fails
            }
          }

          const response = {
            data: parsedData,
            status: responseStatus,
            statusText: responseStatusText,
            headers: responseHeaders,
            config,
          };
          
          if (!validateStatus(responseStatus)) {
            const error = new Error(`Request failed with status code ${responseStatus}`);
            error.code = responseStatus >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST';
            error.response = response;
            error.config = config;
            return reject(error);
          }
          
          resolve(response);
        } catch (err) {
          const error = new Error(`Response processing failed: ${err.message}`);
          error.code = 'ERR_RESPONSE_PROCESSING';
          error.config = config;
          reject(error);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        const error = new Error(`Failed to spawn process: ${err.message}`);
        error.code = 'ERR_SPAWN';
        error.config = config;
        reject(error);
      });

      proc.stdin.write(JSON.stringify(requestPayload));
      proc.stdin.end();
    });
  }

  async get(url, config = {}) {
    return this.request({ ...config, method: 'GET', url });
  }

  async post(url, data, config = {}) {
    return this.request({ ...config, method: 'POST', url, data });
  }

  async put(url, data, config = {}) {
    return this.request({ ...config, method: 'PUT', url, data });
  }

  async delete(url, config = {}) {
    return this.request({ ...config, method: 'DELETE', url });
  }

  async patch(url, data, config = {}) {
    return this.request({ ...config, method: 'PATCH', url, data });
  }

  async head(url, config = {}) {
    return this.request({ ...config, method: 'HEAD', url });
  }

  async options(url, config = {}) {
    return this.request({ ...config, method: 'OPTIONS', url });
  }

  stream(config) {
    // Ensure onDownloadProgress is set for streaming
    const onProgress = config.onData || config.onDownloadProgress;
    if (!onProgress) {
      console.warn('[stream] No onData or onDownloadProgress callback provided');
    }
    return this.request({
      ...config,
      skipGzipDecompress: true, // 流式响应不需要 gzip 解压
      onDownloadProgress: onProgress || (() => {}),
    });
  }

  // ==================== 兼容 AntigravityRequester 的接口 ====================
  
  /**
   * 兼容 AntigravityRequester.antigravity_fetch 的接口
   * 返回一个类似 fetch Response 的对象
   */
  async antigravity_fetch(url, options = {}) {
    const config = {
      method: options.method || 'GET',
      url,
      headers: options.headers || {},
      data: options.body || '',
      timeout: options.timeout_ms ? Math.ceil(options.timeout_ms / 1000) : this.defaults.timeout,
      proxy: options.proxy || this.defaults.proxy,
      skipGzipDecompress: false, // 非流式请求需要 gzip 解压
    };

    const response = await this.request(config);
    
    // 返回兼容 AntigravityRequester 的响应对象
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      headers: new Map(Object.entries(response.headers)),
      url,
      redirected: false,
      _data: response.data,
      async text() {
        return typeof this._data === 'string' ? this._data : JSON.stringify(this._data);
      },
      async json() {
        return typeof this._data === 'string' ? JSON.parse(this._data) : this._data;
      },
      async buffer() {
        return Buffer.from(typeof this._data === 'string' ? this._data : JSON.stringify(this._data), 'utf8');
      }
    };
  }

  /**
   * 兼容 AntigravityRequester.antigravity_fetchStream 的接口
   * 返回一个 StreamResponse 对象
   */
  antigravity_fetchStream(url, options = {}) {
    const streamResponse = new StreamResponse();
    
    const config = {
      method: options.method || 'GET',
      url,
      headers: options.headers || {},
      data: options.body || '',
      timeout: options.timeout_ms ? Math.ceil(options.timeout_ms / 1000) : this.defaults.timeout,
      proxy: options.proxy || this.defaults.proxy,
      skipGzipDecompress: true, // 流式响应不需要 gzip 解压
      onDownloadProgress: ({ chunk, status }) => {
        if (!streamResponse._started) {
          streamResponse._started = true;
          streamResponse.status = status;
          if (streamResponse._onStart) {
            streamResponse._onStart({ status, headers: streamResponse.headers });
          }
        }
        if (streamResponse._onData) {
          streamResponse._onData(chunk);
        }
        streamResponse.chunks.push(chunk);
      },
      validateStatus: (status) => {
        streamResponse.status = status;
        return true; // 不在这里抛错，让流式处理继续
      },
    };

    this.request(config)
      .then((response) => {
        streamResponse.headers = new Map(Object.entries(response.headers));
        streamResponse._ended = true;
        streamResponse._finalText = streamResponse.chunks.join('');
        if (streamResponse._textPromiseResolve) {
          streamResponse._textPromiseResolve(streamResponse._finalText);
        }
        if (streamResponse._onEnd) {
          streamResponse._onEnd();
        }
        streamResponse.chunks = [];
      })
      .catch((error) => {
        streamResponse._ended = true;
        streamResponse._error = error;
        if (streamResponse._textPromiseReject) {
          streamResponse._textPromiseReject(error);
        }
        if (streamResponse._onError) {
          streamResponse._onError(error);
        }
        streamResponse.chunks = [];
      });

    return streamResponse;
  }

  close() {
    this.activeProcesses.forEach(proc => proc.kill());
    this.activeProcesses.clear();
  }
}

/**
 * 流式响应对象，兼容 AntigravityRequester 的 StreamResponse
 */
class StreamResponse {
  constructor() {
    this.status = null;
    this.statusText = null;
    this.headers = new Map();
    this.chunks = [];
    this._onStart = null;
    this._onData = null;
    this._onEnd = null;
    this._onError = null;
    this._ended = false;
    this._error = null;
    this._started = false;
    this._textPromiseResolve = null;
    this._textPromiseReject = null;
    this._finalText = null;
  }

  onStart(callback) {
    this._onStart = callback;
    return this;
  }

  onData(callback) {
    this._onData = callback;
    return this;
  }

  onEnd(callback) {
    this._onEnd = callback;
    return this;
  }

  onError(callback) {
    this._onError = callback;
    return this;
  }

  async text() {
    if (this._ended) {
      if (this._error) throw this._error;
      return this._finalText || '';
    }
    return new Promise((resolve, reject) => {
      this._textPromiseResolve = resolve;
      this._textPromiseReject = reject;
    });
  }
}

export function create(options) {
  return new FingerprintRequester(options);
}

export default {
  create,
  FingerprintRequester,
};
