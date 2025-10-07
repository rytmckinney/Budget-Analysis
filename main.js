const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const CONFIG = {
  DATA_DIR: path.join(app.getPath('userData'), 'data'),
  CSV_DIR: path.join(app.getPath('userData'), 'data', 'csvs'),
  CSV_UPLOADS_DIR: path.join(__dirname, 'csv_uploads'),
  MODEL_DIR: path.join(app.getPath('userData'), 'models'),
  MODEL_FILE: 'model.json',
  ENCRYPTION_KEY: null
};

let mainWindow;

class SecureStorage {
  constructor() {
    this.algorithm = 'aes-256-gcm';
    this.keyLength = 32;
    this.ivLength = 16;
    this.tagLength = 16;
  }

  async initKey() {
    const keyPath = path.join(CONFIG.DATA_DIR, '.key');
    
    try {
      const keyData = await fs.readFile(keyPath);
      CONFIG.ENCRYPTION_KEY = keyData;
    } catch (error) {
      CONFIG.ENCRYPTION_KEY = crypto.randomBytes(this.keyLength);
      await fs.mkdir(CONFIG.DATA_DIR, { recursive: true });
      await fs.writeFile(keyPath, CONFIG.ENCRYPTION_KEY, { mode: 0o600 });
      console.log('Generated new encryption key');
    }
  }

  encrypt(data) {
    const iv = crypto.randomBytes(this.ivLength);
    const cipher = crypto.createCipheriv(this.algorithm, CONFIG.ENCRYPTION_KEY, iv);
    
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag();
    
    return {
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: encrypted
    };
  }

  decrypt(encryptedData) {
    const decipher = crypto.createDecipheriv(
      this.algorithm,
      CONFIG.ENCRYPTION_KEY,
      Buffer.from(encryptedData.iv, 'hex')
    );
    
    decipher.setAuthTag(Buffer.from(encryptedData.tag, 'hex'));
    
    let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  }
}

const secureStorage = new SecureStorage();

async function setupDirectories() {
  try {
    await fs.mkdir(CONFIG.DATA_DIR, { recursive: true });
    await fs.mkdir(CONFIG.CSV_DIR, { recursive: true });
    await fs.mkdir(CONFIG.CSV_UPLOADS_DIR, { recursive: true });
    await fs.mkdir(CONFIG.MODEL_DIR, { recursive: true });
    console.log('Directories created successfully');
  } catch (error) {
    console.error('Error creating directories:', error);
    throw error;
  }
}

const CSVManager = {
  async save(csvText, originalName) {
    try {
      const timestamp = Date.now();
      const fileName = `csv_${timestamp}.json`;
      const filePath = path.join(CONFIG.CSV_DIR, fileName);
      
      const metadata = {
        fileName,
        originalName,
        uploadedAt: new Date().toISOString(),
        csvText
      };
      
      const encrypted = secureStorage.encrypt(metadata);
      await fs.writeFile(filePath, JSON.stringify(encrypted));
      
      console.log(`CSV saved: ${fileName}`);
      return { success: true, fileName };
    } catch (error) {
      console.error('Error saving CSV:', error);
      return { success: false, error: error.message };
    }
  },

  async loadAll() {
    try {
      const files = await fs.readdir(CONFIG.CSV_DIR);
      const csvFiles = files.filter(f => f.startsWith('csv_') && f.endsWith('.json'));
      
      const csvs = [];
      for (const file of csvFiles) {
        try {
          const filePath = path.join(CONFIG.CSV_DIR, file);
          const encrypted = JSON.parse(await fs.readFile(filePath, 'utf8'));
          const decrypted = secureStorage.decrypt(encrypted);
          csvs.push(decrypted);
        } catch (error) {
          console.error(`Error loading CSV ${file}:`, error);
        }
      }
      
      return { success: true, csvs };
    } catch (error) {
      console.error('Error loading CSVs:', error);
      return { success: false, error: error.message, csvs: [] };
    }
  }
};

const UserDataManager = {
  async saveUserCSV(data) {
    try {
      const filePath = path.join(CONFIG.DATA_DIR, 'user_csv.json');
      const encrypted = secureStorage.encrypt(data);
      await fs.writeFile(filePath, JSON.stringify(encrypted));
      return { success: true };
    } catch (error) {
      console.error('Error saving user CSV:', error);
      return { success: false, error: error.message };
    }
  },

  async loadUserCSV() {
    try {
      const filePath = path.join(CONFIG.DATA_DIR, 'user_csv.json');
      
      try {
        await fs.access(filePath);
      } catch {
        return null;
      }
      
      const encrypted = JSON.parse(await fs.readFile(filePath, 'utf8'));
      return secureStorage.decrypt(encrypted);
    } catch (error) {
      console.error('Error loading user CSV:', error);
      return null;
    }
  }
};

const ModelManager = {
  async save(modelData) {
    try {
      const modelPath = path.join(CONFIG.MODEL_DIR, CONFIG.MODEL_FILE);
      
      if (!modelData.model || !modelData.metadata) {
        throw new Error('Invalid model data structure');
      }
      
      const encrypted = secureStorage.encrypt(modelData);
      await fs.writeFile(modelPath, JSON.stringify(encrypted, null, 2));
      
      console.log('Model saved successfully');
      return { success: true, path: modelPath };
    } catch (error) {
      console.error('Error saving model:', error);
      return { success: false, error: error.message };
    }
  },

  async load() {
    try {
      const modelPath = path.join(CONFIG.MODEL_DIR, CONFIG.MODEL_FILE);
      
      try {
        await fs.access(modelPath);
      } catch {
        console.log('No saved model found');
        return null;
      }
      
      const encrypted = JSON.parse(await fs.readFile(modelPath, 'utf8'));
      const modelData = secureStorage.decrypt(encrypted);
      
      if (!modelData.model || !modelData.metadata) {
        throw new Error('Invalid model data structure');
      }
      
      console.log('Model loaded successfully');
      return modelData;
    } catch (error) {
      console.error('Error loading model:', error);
      return null;
    }
  },

  async delete() {
    try {
      const modelPath = path.join(CONFIG.MODEL_DIR, CONFIG.MODEL_FILE);
      
      try {
        await fs.access(modelPath);
        await fs.unlink(modelPath);
        console.log('Model deleted successfully');
        return { success: true };
      } catch {
        console.log('No model file to delete');
        return { success: true };
      }
    } catch (error) {
      console.error('Error deleting model:', error);
      return { success: false, error: error.message };
    }
  },

  async openFileDialog() {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Model File',
        defaultPath: CONFIG.MODEL_DIR,
        filters: [
          { name: 'Model Files', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
      });
      
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { canceled: true };
      }
      
      return { canceled: false, filePath: result.filePaths[0] };
    } catch (error) {
      console.error('Error opening file dialog:', error);
      return { canceled: true, error: error.message };
    }
  },

  async readFile(filePath) {
    try {
      console.log('ModelManager.readFile called with path:', filePath);
      if (!filePath) {
        throw new Error('No file path provided');
      }
      const fileContent = await fs.readFile(filePath, 'utf8');
      console.log('File read successfully, parsing JSON...');
      let modelData;
      try {
        const encrypted = JSON.parse(fileContent);
        modelData = secureStorage.decrypt(encrypted);
      } catch (parseError) {
        // If decryption fails, try treating it as unencrypted data
        console.log('Trying to parse as unencrypted data...');
        modelData = JSON.parse(fileContent);
      }

      // Validate model structure
      if (!modelData.model?.modelTopology || !modelData.model?.weightsManifest) {
        throw new Error('Invalid model format: missing required components');
      }

      const weightsManifest = modelData.model.weightsManifest[0];
      if (!weightsManifest?.weights || !Array.isArray(weightsManifest.weights)) {
        throw new Error('Invalid weights manifest');
      }

      if (!modelData.model.weightData || !Array.isArray(modelData.model.weightData)) {
        throw new Error('Weight data must be an array');
      }

      // Check total expected values
      const totalExpectedValues = weightsManifest.weights.reduce((total, spec) => {
        const size = spec.shape.reduce((a, b) => a * b, 1);
        console.log(`Layer shape: [${spec.shape}], size: ${size}`);
        return total + size;
      }, 0);

      console.log(`Total expected values: ${totalExpectedValues}, actual values: ${modelData.model.weightData.length}`);
      if (modelData.model.weightData.length !== totalExpectedValues) {
        throw new Error(`Weight data mismatch: expected ${totalExpectedValues} values but got ${modelData.model.weightData.length}`);
      }

      console.log('Model data validated successfully');
      return { success: true, data: JSON.stringify(modelData) };
    } catch (error) {
      console.error('Error reading model file:', error);
      return { success: false, error: error.message };
    }
  }
};

function setupIPC() {
  ipcMain.handle('save-csv-data', async (event, csvText, originalName) => {
    return await CSVManager.save(csvText, originalName);
  });

  ipcMain.handle('load-all-csvs', async () => {
    return await CSVManager.loadAll();
  });

  ipcMain.handle('save-user-csv', async (event, data) => {
    return await UserDataManager.saveUserCSV(data);
  });

  ipcMain.handle('load-user-csv', async () => {
    return await UserDataManager.loadUserCSV();
  });

  ipcMain.handle('save-model', async (event, modelData) => {
    return await ModelManager.save(modelData);
  });

  ipcMain.handle('load-model', async () => {
    return await ModelManager.load();
  });

  ipcMain.handle('delete-model', async () => {
    return await ModelManager.delete();
  });

  ipcMain.handle('open-model-file', async () => {
    return await ModelManager.openFileDialog();
  });

  ipcMain.handle('read-model-file', async (event, filePath) => {
    console.log('Reading model file from:', filePath);
    if (!filePath) {
      console.error('No file path provided to read-model-file');
      return { success: false, error: 'No file path provided' };
    }
    return await ModelManager.readFile(filePath);
  });

  // Save a named user CSV snapshot into the csv_uploads directory (no encryption)
  ipcMain.handle('save-user-csv-data', async (event, fileName, data) => {
    try {
      await fs.mkdir(CONFIG.CSV_UPLOADS_DIR, { recursive: true });
      let outName = fileName || `transactions_${Date.now()}`;
      if (!path.extname(outName)) outName = outName + '.json';
      const filePath = path.join(CONFIG.CSV_UPLOADS_DIR, outName);
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
      console.log(`CSV saved to: ${filePath}`);
      return { success: true, path: filePath, fileName: outName };
    } catch (error) {
      console.error('Error saving user CSV snapshot:', error);
      return { success: false, error: error.message };
    }
  });

    // Delete a CSV file from csv_uploads directory
  ipcMain.handle('delete-csv-upload', async (event, fileName) => {
    try {
      if (!fileName) return { success: false, error: 'No filename provided' };
      const filePath = path.join(CONFIG.CSV_UPLOADS_DIR, fileName);
      await fs.unlink(filePath);
      return { success: true };
    } catch (error) {
      console.error('Error deleting CSV file:', error);
      return { success: false, error: error.message };
    }
  });

  // Load all CSV files from csv_uploads directory
  /*...*/
  ipcMain.handle('load-all-csv-uploads', async () => {
    try {
      await fs.mkdir(CONFIG.CSV_UPLOADS_DIR, { recursive: true });
      const files = await fs.readdir(CONFIG.CSV_UPLOADS_DIR);
      const csvFiles = files.filter(f => f.endsWith('.json') || f.endsWith('.csv'));
      
      const csvs = [];
      for (const file of csvFiles) {
        try {
          const filePath = path.join(CONFIG.CSV_UPLOADS_DIR, file);
          const stats = await fs.stat(filePath);
          csvs.push({
            fileName: file,
            originalName: file,
            uploadedAt: stats.mtime.toISOString(),
            size: stats.size
          });
        } catch (error) {
          console.error(`Error loading CSV metadata ${file}:`, error);
        }
      }
      
      return { success: true, csvs };
    } catch (error) {
      console.error('Error loading CSV uploads:', error);
      return { success: false, error: error.message, csvs: [] };
    }
  });

  // Load a saved CSV/JSON from csv_uploads directory
  ipcMain.handle('load-csv-upload', async (event, fileName) => {
    try {
      if (!fileName) return { success: false, error: 'No filename provided' };
      await fs.mkdir(CONFIG.CSV_UPLOADS_DIR, { recursive: true });
      const filePath = path.join(CONFIG.CSV_UPLOADS_DIR, fileName);
      const content = await fs.readFile(filePath, 'utf8');

      const isJson = fileName.toLowerCase().endsWith('.json');
      if (isJson) {
        try {
          const parsed = JSON.parse(content);
          return { success: true, isJson: true, data: parsed };
        } catch (err) {
          // If JSON parse fails, return as CSV text
          return { success: true, isJson: false, data: content };
        }
      }

      // It's a CSV file
      return { success: true, isJson: false, data: content };
    } catch (error) {
      console.error('Error loading CSV upload:', error);
      return { success: false, error: error.message };
    }
  });

  console.log('IPC handlers registered');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'money.png'),
    backgroundColor: '#1e1e2f'
  });

  mainWindow.loadFile('index.html');

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  console.log('Window created');
}

app.whenReady().then(async () => {
  try {
    console.log('App ready, initializing...');
    await setupDirectories();
    await secureStorage.initKey();
    setupIPC();
    createWindow();
    console.log('Initialization complete');
  } catch (error) {
    console.error('Failed to initialize app:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

console.log('Main process started');