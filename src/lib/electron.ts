/* Electron 原生桥 —— Web 版下为 null，桌面版下暴露 window.electronApi。 */

export interface ElectronApi {
  isElectron: boolean;
  reveal: (path: string) => Promise<boolean>;
  selectFolder: () => Promise<string | null>;
}

declare global {
  interface Window {
    electronApi?: ElectronApi;
  }
}

export const electron: ElectronApi | null =
  typeof window !== "undefined" && window.electronApi ? window.electronApi : null;
