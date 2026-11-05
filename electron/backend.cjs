/* Electron 后端进程管理 —— 仅 prod 使用：拉起打包好的 FastAPI 可执行文件并等待就绪。 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForHealth(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(500, () => { req.destroy(); retry(); });
      function retry() {
        if (Date.now() - started > timeoutMs) {
          return reject(new Error('后端启动超时（/api/health 未就绪）'));
        }
        setTimeout(poll, 250);
      }
    };
    poll();
  });
}

class Backend {
  constructor({ resourcesPath, userDataDir }) {
    this.resourcesPath = resourcesPath;
    this.userDataDir = userDataDir;
    this.child = null;
    this.port = null;
  }

  async start() {
    this.port = await findFreePort();
    const exe = path.join(this.resourcesPath, 'backend', 'backend.exe');
    const env = {
      ...process.env,
      PORT: String(this.port),
      YONMAN_DATA_DIR: path.join(this.userDataDir, 'data'),
      YONMAN_DIST_DIR: path.join(this.resourcesPath, 'dist'),
    };
    this.child = spawn(exe, [], { env, windowsHide: true, stdio: 'ignore' });
    this.child.on('exit', () => { this.child = null; });
    await waitForHealth(`http://127.0.0.1:${this.port}/api/health`);
    return this.port;
  }

  stop() {
    if (this.child) {
      try { this.child.kill(); } catch { /* ignore */ }
      this.child = null;
    }
  }
}

module.exports = { Backend, findFreePort };
