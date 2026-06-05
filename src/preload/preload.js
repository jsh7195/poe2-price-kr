'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 렌더러에 노출되는 안전한 API 표면.
 * contextIsolation + sandbox 환경에서 ipcRenderer 를 직접 노출하지 않고
 * 화이트리스트된 함수만 전달한다.
 */
contextBridge.exposeInMainWorld('api', {
  getStatus: () => ipcRenderer.invoke('app:getStatus'),
  search: (query) => ipcRenderer.invoke('catalog:search', query),
  refresh: () => ipcRenderer.invoke('catalog:refresh'),
  setLeague: (name) => ipcRenderer.invoke('league:set', name),
  testOverlay: () => ipcRenderer.invoke('overlay:test'),
  relaunchElevated: () => ipcRenderer.invoke('app:relaunchElevated'),
  hideToTray: () => ipcRenderer.invoke('app:hideToTray'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (callback) => {
    const listener = (_evt, status) => callback(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  /** 메인이 보내는 상태 갱신 구독. 해제 함수를 반환. */
  onStatus: (callback) => {
    const listener = (_evt, status) => callback(status);
    ipcRenderer.on('app:status', listener);
    return () => ipcRenderer.removeListener('app:status', listener);
  },
});
