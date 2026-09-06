const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupAPI', {
  submit: (data) => ipcRenderer.invoke('setup:submit', data),
});
