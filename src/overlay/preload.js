'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onPrice: (callback) => {
    ipcRenderer.on('overlay:price', (_evt, payload) => callback(payload));
  },
});
