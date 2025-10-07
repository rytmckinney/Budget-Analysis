const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // CSV Data Management (encrypted)
  saveCsvData: (csvText, originalName) => ipcRenderer.invoke('save-csv-data', csvText, originalName),
  loadAllCsvs: () => ipcRenderer.invoke('load-all-csvs'),
  
  // User CSV Management (encrypted)
  saveUserCsv: (data) => ipcRenderer.invoke('save-user-csv', data),
  loadUserCsv: () => ipcRenderer.invoke('load-user-csv'),
  
  // CSV Uploads Management (plain JSON in csv_uploads folder)
  saveUserCsvData: (fileName, data) => ipcRenderer.invoke('save-user-csv-data', fileName, data),
  loadAllCsvUploads: () => ipcRenderer.invoke('load-all-csv-uploads'),
  loadCsvUpload: (fileName) => ipcRenderer.invoke('load-csv-upload', fileName),
  deleteCsvUpload: (fileName) => ipcRenderer.invoke('delete-csv-upload', fileName),
  
  // Model Management
  saveModel: (modelData) => ipcRenderer.invoke('save-model', modelData),
  loadModel: () => ipcRenderer.invoke('load-model'),
  deleteModel: () => ipcRenderer.invoke('delete-model'),
  openModelFile: () => ipcRenderer.invoke('open-model-file'),
  readModelFile: (filePath) => ipcRenderer.invoke('read-model-file', filePath),
  
  // App lifecycle
  onAppClosing: (callback) => ipcRenderer.on('app-closing', callback)
});

console.log('Preload script loaded');