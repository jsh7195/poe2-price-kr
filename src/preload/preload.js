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
  priceItem: (rec) => ipcRenderer.invoke('catalog:priceItem', rec),
  favorites: {
    list: () => ipcRenderer.invoke('favorites:list'),
    addCatalog: (rec) => ipcRenderer.invoke('favorites:addCatalog', rec),
    addUrl: (url) => ipcRenderer.invoke('favorites:addUrl', url),
    remove: (key) => ipcRenderer.invoke('favorites:remove', key),
    reprice: (key) => ipcRenderer.invoke('favorites:reprice', key),
  },
  openTradeUrl: (url) => ipcRenderer.invoke('app:openTradeUrl', url),
  /** 즐겨찾기 변경 구독(인게임에서 담아도 반영). 해제 함수 반환. */
  onFavorites: (callback) => {
    const listener = (_evt, list) => callback(list);
    ipcRenderer.on('app:favorites', listener);
    return () => ipcRenderer.removeListener('app:favorites', listener);
  },
  refresh: () => ipcRenderer.invoke('catalog:refresh'),
  setLeague: (name) => ipcRenderer.invoke('league:set', name),
  settings: {
    getHotkeys: () => ipcRenderer.invoke('settings:getHotkeys'),
    setHotkeys: (map) => ipcRenderer.invoke('settings:setHotkeys', map),
    resetHotkeys: () => ipcRenderer.invoke('settings:resetHotkeys'),
  },
  reportError: (payload) => ipcRenderer.invoke('app:reportError', payload),
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
