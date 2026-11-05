/* Electron preload —— 通过 contextBridge 向渲染进程暴露原生能力。 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronApi', {
  isElectron: true,
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
});
