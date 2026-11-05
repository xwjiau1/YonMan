/* Electron 主进程 —— 窗口管理、原生 IPC、按需拉起后端（sidecar）。 */

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { Backend } = require('./backend.cjs');

let mainWindow = null;
let backend = null;

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'YonMan 智能项目管理工作台',
    autoHideMenuBar: true,
    backgroundColor: '#F6F8FA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadURL(url);
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function start() {
  let url;
  if (!app.isPackaged) {
    // dev：加载 Vite 开发服务器（默认 3000，可用 ELECTRON_RENDERER_URL 覆盖），
    // 后端复用终端里已运行的 FastAPI（Vite 代理到 8000）。
    url = process.env.ELECTRON_RENDERER_URL || 'http://localhost:3000';
  } else {
    // prod：拉起内嵌后端（resources/backend/backend.exe），加载后端托管的 dist SPA。
    backend = new Backend({
      resourcesPath: process.resourcesPath,
      userDataDir: app.getPath('userData'),
    });
    const port = await backend.start();
    url = `http://127.0.0.1:${port}`;
  }
  createWindow(url);
}

/* ---------- 原生桥 IPC ---------- */

ipcMain.handle('reveal', (_e, p) => {
  if (!p) return false;
  shell.showItemInFolder(p);
  return true;
});

ipcMain.handle('select-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作区文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

app.whenReady().then(start).catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  dialog.showErrorBox('YonMan 启动失败', msg);
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (backend) backend.stop();
});
