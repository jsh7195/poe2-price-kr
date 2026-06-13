'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 인터랙티브 옵션 시세 창에 노출되는 안전한 API.
 */
contextBridge.exposeInMainWorld('pricerApi', {
  /** 메인이 보내는 아이템(메타+모드목록) 구독. 해제 함수 반환. */
  onItem: (callback) => {
    const listener = (_evt, item) => callback(item);
    ipcRenderer.on('pricer:item', listener);
    return () => ipcRenderer.removeListener('pricer:item', listener);
  },
  /** 선택한 옵션 필터로 시세 조회. filters:[{id,min?,max?}], opts:{category,ilvl,rarity} */
  price: (filters, opts) => ipcRenderer.invoke('pricer:price', filters, opts),
  /** GGG 거래 페이지를 기본 브라우저로 연다. */
  openUrl: (url) => ipcRenderer.invoke('pricer:openUrl', url),
  /** 현재 아이템+선택옵션을 즐겨찾기에 추가(메인창 적재). */
  addFavorite: (data) => ipcRenderer.invoke('favorites:addRare', data),
  /** 창 닫기(숨김). */
  close: () => ipcRenderer.invoke('pricer:close'),
});
