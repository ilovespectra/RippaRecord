'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rippa', {
  onState: (cb) => ipcRenderer.on('state', (_e, data) => cb(data)),
  indicatorAction: (action) => ipcRenderer.send('indicator-action', action),
  widgetAction: (id) => ipcRenderer.send('widget-action', id),
  getSetupData: () => ipcRenderer.invoke('rippa:setup-data'),
  pickSetupPath: (kind) => ipcRenderer.invoke('rippa:pick-path', kind),
  saveSetup: (settings) => ipcRenderer.invoke('rippa:save-settings', settings),
});
