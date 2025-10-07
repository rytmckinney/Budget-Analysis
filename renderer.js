// === CONFIGURATION ===
const CONFIG = {
  MAX_VOCAB_SIZE: 1500,
  MAX_SAMPLES: 1000,
  MIN_SAMPLES: 500,
  SEQUENCE_LENGTH: 20,
  EMBEDDING_DIM_MIN: 16,
  EMBEDDING_DIM_MAX: 32,
  HIDDEN_UNITS_MIN: 32,
  HIDDEN_UNITS_MAX: 64,
  BATCH_SIZE_MIN: 8,
  BATCH_SIZE_MAX: 16,
  EPOCHS_MIN: 15,
  EPOCHS_MAX: 30,
  DROPOUT_RATE_1: 0.4,
  DROPOUT_RATE_2: 0.3
};

const AppState = {
  currentView: 'dashboard',
  columnMapping: null, // Store column mapping preferences
  currentGraphType: 'pie',
  spendingChart: null,
  normalizedData: [],
  rawCsvData: [],
  model: null,
  modelMetadata: null,
  accountNames: {},
  appInitialized: false
};

const Utils = {
  async safeInvoke(channel, ...args) {
    try {
      if (!window.electronAPI) {
        console.warn('Electron API not available, running in browser fallback mode.');
        // Fallback: return dummy success for non-IPC actions
        if (channel.startsWith('load') || channel.startsWith('save') || channel.startsWith('delete')) {
          return { success: true, data: null };
        }
        throw new Error('Electron API not available');
      }
      
      const methodMap = {
        'save-csv-data': 'saveCsvData',
        'load-all-csvs': 'loadAllCsvs',
        'save-user-csv': 'saveUserCsv',
        'load-user-csv': 'loadUserCsv',
        'save-user-csv-data': 'saveUserCsvData',
        'load-all-csv-uploads': 'loadAllCsvUploads',
        'load-csv-upload': 'loadCsvUpload',
        'delete-csv-upload': 'deleteCsvUpload',
        'save-model': 'saveModel',
        'load-model': 'loadModel',
        'delete-model': 'deleteModel',
        'open-model-file': 'openModelFile',
        'read-model-file': 'readModelFile'
      };
      
      const method = methodMap[channel];
      if (!method || !window.electronAPI[method]) {
        throw new Error(`Unknown IPC channel: ${channel}`);
      }
      
      return await window.electronAPI[method](...args);
    } catch (error) {
      console.error(`IPC invoke failed for ${channel}:`, error);
      throw error;
    }
  },

  parseAmount(value) {
    if (typeof value === 'number') return isNaN(value) ? 0 : value;
    if (typeof value !== 'string') return 0;
    let cleaned = value.replace(/[^0-9\-.,()]/g, '').trim();
    if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
      cleaned = '-' + cleaned.slice(1, -1);
    }
    if ((cleaned.match(/,/g) || []).length === 1 && cleaned.indexOf('.') === -1) {
      cleaned = cleaned.replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  },

  formatCurrency(amount) {
    const num = typeof amount === 'number' ? amount : this.parseAmount(amount);
    return `$${Math.abs(num).toFixed(2)}`;
  },

  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  sanitizeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};

const ErrorHandler = {
  show(message, error = null) {
    console.error('Error:', message, error);
    if (error) console.error('Stack trace:', error.stack);
    const userMessage = error?.message ? `${message}\n\nDetails: ${error.message}` : message;
    UI.showAlert(userMessage);
  },
  async handle(operation, callback) {
    try {
      return await callback();
    } catch (error) {
      this.show(`Error during ${operation}`, error);
      throw error;
    }
  }
};

const categories = {
  Housing: ['rent', 'utilities', 'repairs', 'property taxes'],
  Transportation: ['car payments', 'gas', 'insurance', 'repairs', 'parking/tolls'],
  Food: ['groceries', 'dining out/takeout', 'nicotine', 'alcohol'],
  Bills: ['electricity', 'water', 'internet', 'phone', 'cable/streaming services'],
  Online: ['amazon', 'online purchase'],
  Insurance: ['health', 'home/renters', 'life'],
  Debt: ['credit cards', 'student loans', 'personal loans'],
  Entertainment: ['subscriptions', 'hobbies', 'events'],
  ClothingPersonalCare: ['clothes/shoes', 'haircuts/grooming', 'toiletries'],
  Education: ['tuition', 'books/supplies', 'courses'],
  SavingsInvestments: ['emergency fund', 'retirement', 'others'],
  Income: ['wages', 'other'],
  Miscellaneous: ['gifts/donations', 'pet expenses', 'unclassified expenses']
};

const merchantMapping = {
  'RENT': 'Housing > rent',
  'ZG RENTAL': 'Housing > rent',
  'CONWAY CORP': 'Housing > utilities',
  'COSTCO GAS': 'Transportation > gas',
  'SHELL': 'Transportation > gas',
  'KROGER': 'Food > groceries',
  'WAL-MART': 'Food > groceries',
  'WM SUPERCENTER': 'Food > groceries',
  'AMAZON': 'Online > online purchase',
  'DEPOSIT': 'Income > other',
  'PAYROLL': 'Income > wages'
};

const allCategoriesFlat = Object.entries(categories).flatMap(([main, subs]) =>
  subs.length ? subs.map(sub => `${main} > ${sub}`) : [main]
);

function autoCategorizeMerchant(description) {
  if (!description) return '';
  for (const [merchant, category] of Object.entries(merchantMapping)) {
    const regex = new RegExp(`\\b${merchant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (regex.test(description)) return category;
  }
  return '';
}

const ML = {
  buildVocab(texts) {
    const wordFreq = {};
    texts.forEach(text => {
      const tokens = text.split(/\W+/).filter(token => token.length > 1);
      tokens.forEach(tok => {
        const cleanToken = tok.toLowerCase();
        if (cleanToken) wordFreq[cleanToken] = (wordFreq[cleanToken] || 0) + 1;
      });
    });
    const maxVocabSize = Math.min(CONFIG.MAX_VOCAB_SIZE, Math.max(800, Math.floor(texts.length / 2)));
    const sortedWords = Object.entries(wordFreq)
      .sort(([,a], [,b]) => b - a)
      .slice(0, maxVocabSize)
      .map(([word]) => word);
    const vocab = {};
    sortedWords.forEach((word, index) => { vocab[word] = index + 1; });
    return vocab;
  },

  textToSequence(text, vocab, maxLen) {
    const tokens = text.split(/\W+/).filter(token => token.length > 0);
    let seq = tokens.map(t => vocab[t.toLowerCase()] || 0);
    if (seq.length > maxLen) seq = seq.slice(0, maxLen);
    while (seq.length < maxLen) seq.push(0);
    return seq;
  },

  async trainModel(trainingData, progressCallback) {
    let xsTensor, ysTensor;
    try {
      let sampledData = trainingData;
      const maxSamples = Math.min(CONFIG.MAX_SAMPLES, Math.max(CONFIG.MIN_SAMPLES, Math.floor(trainingData.length * 0.8)));
      if (trainingData.length > 500) {
        sampledData = this.stratifiedSample(trainingData, maxSamples);
      }
      
      const texts = sampledData.map(tx => (tx.description || '').toLowerCase().trim());
      const labels = sampledData.map(tx => tx.category);
      const validIndices = texts.map((text, idx) => text.length > 0 ? idx : -1).filter(idx => idx !== -1);
      
      if (validIndices.length === 0) throw new Error('No valid transaction descriptions found');
      
      const validTexts = validIndices.map(idx => texts[idx]);
      const validLabels = validIndices.map(idx => labels[idx]);
      const vocab = this.buildVocab(validTexts);
      const sequences = validTexts.map(text => this.textToSequence(text, vocab, CONFIG.SEQUENCE_LENGTH));
      const labelSet = Array.from(new Set(validLabels));
      const labelToIndex = {};
      labelSet.forEach((lbl, i) => labelToIndex[lbl] = i);
      const ys = validLabels.map(lbl => labelToIndex[lbl]);
      
      xsTensor = tf.tensor2d(sequences, [sequences.length, CONFIG.SEQUENCE_LENGTH]);
      ysTensor = tf.oneHot(tf.tensor1d(ys, 'int32'), labelSet.length);
      
      if (AppState.model) {
        AppState.model.dispose();
        AppState.model = null;
      }
      
      const vocabSize = Object.keys(vocab).length;
      const embeddingDim = Math.min(CONFIG.EMBEDDING_DIM_MAX, Math.max(CONFIG.EMBEDDING_DIM_MIN, Math.floor(vocabSize / 30)));
      const hiddenUnits = Math.min(CONFIG.HIDDEN_UNITS_MAX, Math.max(CONFIG.HIDDEN_UNITS_MIN, Math.floor(validTexts.length / 20)));
      
      AppState.model = tf.sequential();
      AppState.model.add(tf.layers.embedding({inputDim: vocabSize + 1, outputDim: embeddingDim, inputLength: CONFIG.SEQUENCE_LENGTH}));
      AppState.model.add(tf.layers.flatten());
      AppState.model.add(tf.layers.dense({units: hiddenUnits, activation: 'relu'}));
      AppState.model.add(tf.layers.dropout({rate: CONFIG.DROPOUT_RATE_1}));
      AppState.model.add(tf.layers.dense({units: Math.floor(hiddenUnits / 2), activation: 'relu'}));
      AppState.model.add(tf.layers.dropout({rate: CONFIG.DROPOUT_RATE_2}));
      AppState.model.add(tf.layers.dense({units: labelSet.length, activation: 'softmax'}));
      
      AppState.model.compile({optimizer: 'adam', loss: 'categoricalCrossentropy', metrics: ['accuracy']});
      
      const batchSize = Math.min(CONFIG.BATCH_SIZE_MAX, Math.max(CONFIG.BATCH_SIZE_MIN, Math.floor(validTexts.length / 20)));
      const epochs = Math.min(CONFIG.EPOCHS_MAX, Math.max(CONFIG.EPOCHS_MIN, Math.floor(2000 / validTexts.length)));
      
      await AppState.model.fit(xsTensor, ysTensor, {
        epochs, batchSize, validationSplit: 0.2, verbose: 1, callbacks: progressCallback
      });
      
      const modelJSON = await AppState.model.toJSON();
      const weights = AppState.model.getWeights();
      const weightDataArrays = await Promise.all(weights.map(w => w.data()));
      
      // Flatten all weight arrays into a single array
      const weightData = [];
      weightDataArrays.forEach(arr => {
        weightData.push(...Array.from(arr));
      });
      
      const weightSpecs = weights.map(w => ({name: w.name, shape: w.shape, dtype: w.dtype}));
      
      console.log(`Saving model with ${weightData.length} total weight values`);
      console.log('Weight specs:', weightSpecs.map(s => `shape=[${s.shape}], size=${s.shape.reduce((a,b) => a*b, 1)}`));
      
      const modelData = {
        model: {modelTopology: modelJSON, weightsManifest: [{paths: [], weights: weightSpecs}], weightData},
        metadata: {labelSet, vocab, labelToIndex, trainingInfo: {originalDataSize: trainingData.length, sampledDataSize: sampledData.length, vocabularySize: vocabSize, batchSize, epochs}}
      };
      
      const result = await Utils.safeInvoke('save-model', modelData);
      if (!result.success) throw new Error('Failed to save model: ' + result.error);
      
      AppState.modelMetadata = modelData.metadata;
      weights.forEach(w => w.dispose());
      return result;
    } finally {
      if (xsTensor) xsTensor.dispose();
      if (ysTensor) ysTensor.dispose();
    }
  },

  stratifiedSample(data, targetSize) {
    const categoryGroups = {};
    data.forEach(tx => {
      if (!categoryGroups[tx.category]) categoryGroups[tx.category] = [];
      categoryGroups[tx.category].push(tx);
    });
    const sampled = [];
    const categoriesCount = Object.keys(categoryGroups).length;
    Object.entries(categoryGroups).forEach(([category, samples]) => {
      const targetCount = Math.min(samples.length, Math.ceil(targetSize / categoriesCount));
      const shuffled = samples.sort(() => Math.random() - 0.5);
      sampled.push(...shuffled.slice(0, targetCount));
    });
    return sampled.sort(() => Math.random() - 0.5);
  },

  async predict(transactions) {
    if (!AppState.model || !AppState.modelMetadata) throw new Error('Model not loaded');
    const {vocab, labelSet} = AppState.modelMetadata;
    const texts = transactions.map(tx => (tx.description || '').toLowerCase().trim());
    if (texts.length === 0) return [];
    const sequences = texts.map(text => this.textToSequence(text, vocab, CONFIG.SEQUENCE_LENGTH));
    const xsTensor = tf.tensor2d(sequences, [sequences.length, CONFIG.SEQUENCE_LENGTH]);
    try {
      const preds = AppState.model.predict(xsTensor);
      const predIndices = preds.argMax(-1).dataSync();
      const predConfidences = preds.max(-1).dataSync();
      const results = Array.from(predIndices).map((idx, i) => ({category: labelSet[idx], confidence: predConfidences[i]}));
      preds.dispose();
      return results;
    } finally {
      xsTensor.dispose();
    }
  }
};

const UI = {
  showAlert(message) {
    const modal = document.createElement('div');
    modal.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;justify-content:center;align-items:center;z-index:10000;`;
    const content = document.createElement('div');
    content.style.cssText = `background:#ffffff;padding:24px;border-radius:12px;border:1px solid #e5e5e7;min-width:300px;max-width:400px;color:#1d1d1f;box-shadow:0 4px 20px rgba(0,0,0,0.2);`;
    content.innerHTML = `<div style="margin-bottom:16px;">${Utils.sanitizeHTML(message)}</div><div style="display:flex;justify-content:center;"><button id="alertOk" style="padding:10px 20px;border:none;background:#ff6b35;color:white;border-radius:8px;cursor:pointer;font-weight:600;">OK</button></div>`;
    modal.appendChild(content);
    document.body.appendChild(modal);
    const okBtn = content.querySelector('#alertOk');
    okBtn.addEventListener('click', () => document.body.removeChild(modal));
    modal.addEventListener('click', (e) => { if (e.target === modal) document.body.removeChild(modal); });
  },

  showPrompt(message, callback) {
    const modal = document.createElement('div');
    modal.id = 'customPrompt';
    modal.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;justify-content:center;align-items:center;z-index:10000;`;
    const content = document.createElement('div');
    content.style.cssText = `background:#ffffff;padding:24px;border-radius:12px;border:1px solid #e5e5e7;min-width:400px;max-width:500px;color:#1d1d1f;box-shadow:0 4px 20px rgba(0,0,0,0.2);`;
    content.innerHTML = `<div style="margin-bottom:16px;">${Utils.sanitizeHTML(message)}</div><input type="text" id="promptInput" placeholder="Enter value" style="width:100%;padding:12px;border:1px solid #e5e5e7;border-radius:8px;background:#ffffff;color:#1d1d1f;margin-bottom:16px;box-sizing:border-box;font-size:14px;outline:none;"><div style="display:flex;gap:12px;justify-content:flex-end;"><button id="promptCancel" style="padding:10px 20px;border:1px solid #e5e5e7;background:#ffffff;color:#1d1d1f;border-radius:8px;cursor:pointer;font-weight:600;">Cancel</button><button id="promptOk" style="padding:10px 20px;border:none;background:#ff6b35;color:white;border-radius:8px;cursor:pointer;font-weight:600;">OK</button></div>`;
    modal.appendChild(content);
    document.body.appendChild(modal);
    const input = content.querySelector('#promptInput');
    const okBtn = content.querySelector('#promptOk');
    const cancelBtn = content.querySelector('#promptCancel');
    setTimeout(() => { input.focus(); input.select(); }, 100);
    const cleanup = (value) => { document.body.removeChild(modal); callback(value); };
    okBtn.addEventListener('click', () => cleanup(input.value.trim()));
    cancelBtn.addEventListener('click', () => cleanup(null));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); } else if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); } });
    modal.addEventListener('click', (e) => { if (e.target === modal) cancelBtn.click(); });
  },

  updateModelStatus(loaded) {
    const indicator = document.getElementById('modelStatusIndicator');
    if (indicator) {
      if (loaded && AppState.model && AppState.modelMetadata) {
        indicator.textContent = 'Model Loaded';
        indicator.classList.remove('not-loaded');
        indicator.classList.add('loaded');
      } else {
        indicator.textContent = 'Model Not Loaded';
        indicator.classList.remove('loaded');
        indicator.classList.add('not-loaded');
      }
    }
    
    if (AppState.currentView === 'csv') {
      const predictBtn = document.getElementById('predictBtn');
      if (predictBtn && loaded) {
        predictBtn.style.display = 'inline-block';
      }
    }
  },

  updateLoadingBar(status, progress, stats = {}) {
    const container = document.getElementById('loadingContainer');
    const statusEl = document.getElementById('loadingStatus');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    if (!container || !statusEl || !progressBar || !progressText) return;
    container.classList.add('show');
    statusEl.textContent = status;
    progressBar.style.width = `${progress}%`;
    progressText.textContent = `${Math.round(progress)}%`;
    if (stats.epoch !== undefined) {
      const epochStat = document.getElementById('epochStat');
      if (epochStat) epochStat.textContent = stats.epoch;
    }
    if (stats.accuracy !== undefined) {
      const accuracyStat = document.getElementById('accuracyStat');
      if (accuracyStat) accuracyStat.textContent = `${(stats.accuracy * 100).toFixed(1)}%`;
    }
    if (stats.loss !== undefined) {
      const lossStat = document.getElementById('lossStat');
      if (lossStat) lossStat.textContent = stats.loss.toFixed(3);
    }
    if (stats.time !== undefined) {
      const timeStat = document.getElementById('timeStat');
      if (timeStat) timeStat.textContent = `${stats.time}s`;
    }
  },

  hideLoadingBar() {
    const container = document.getElementById('loadingContainer');
    if (container) setTimeout(() => container.classList.remove('show'), 2000);
  }
};

const Handlers = {
  async handleFileUpload() {
    return ErrorHandler.handle('file upload', async () => {
      const fileInput = document.getElementById('csvFile');
      const file = fileInput?.files[0];
      if (!file) { UI.showAlert('Please select a file'); return; }
      const reader = new FileReader();
      reader.onload = async (e) => {
        const csvText = e.target.result;
        Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
          dynamicTyping: true,
          complete: async (results) => {
            const headers = results.meta.fields;
            const rows = results.data;
            AppState.rawCsvData = rows;
            await Utils.safeInvoke('save-csv-data', csvText, file.name);
            // Show mapping UI after parsing
            const mappingContainer = document.getElementById('columnMappingContainer');
            const confirmBtn = document.getElementById('confirmMappingBtn');
            if (mappingContainer) mappingContainer.style.display = 'block';
            if (confirmBtn) confirmBtn.style.display = 'inline-block';
            Views.showColumnMappingUI(headers, rows);
          },
          error: (err) => { ErrorHandler.show('CSV parsing failed', err); }
        });
      };
      reader.onerror = () => { ErrorHandler.show('Failed to read file'); };
      reader.readAsText(file);
    });
  },

  async handleMappingConfirmation() {
    return ErrorHandler.handle('mapping confirmation', async () => {
      const mapping = {
        date: document.getElementById('map-Date')?.value,
        description: document.getElementById('map-Description')?.value,
        amount: document.getElementById('map-Amount')?.value
      };
      if (!mapping.date || !mapping.description || !mapping.amount) {
        UI.showAlert('Please map all required fields');
        return;
      }
      // Save mapping for future use
      AppState.columnMapping = mapping;
      // Overwrite normalizedData with new CSV
      AppState.normalizedData = AppState.rawCsvData.map(row => {
        const description = row[mapping.description] || '';
        const autoCategory = autoCategorizeMerchant(description);
        return {
          date: row[mapping.date],
          description: description,
          amount: Utils.parseAmount(row[mapping.amount]),
          category: autoCategory,
          account: 'Default Account'
        };
      });
      AppState.accountNames = {};
      AppState.normalizedData.forEach((tx, index) => {
        AppState.accountNames[index] = 'Default Account';
      });
      // Overwrite autosave with new data
      await Utils.safeInvoke('save-user-csv', {
        normalizedData: AppState.normalizedData,
        accountNames: AppState.accountNames,
        rawCsvData: AppState.rawCsvData,
        columnMapping: AppState.columnMapping
      });
      // Update UI to show only new transactions
      Views.displayTransactions(AppState.normalizedData);
      const trainBtn = document.getElementById('trainModelBtn');
      if (trainBtn) trainBtn.style.display = 'inline-block';
      if (AppState.currentView === 'categories') Views.generateCategoriesSummary();
      if (AppState.currentView === 'dailyTransactions') Views.generateDailyTransactionsView();
      Views.updateGraphsView();
      // Hide mapping UI after confirmation
      const mappingContainer = document.getElementById('columnMappingContainer');
      const confirmBtn = document.getElementById('confirmMappingBtn');
      if (mappingContainer) mappingContainer.style.display = 'none';
      if (confirmBtn) confirmBtn.style.display = 'none';
    });
  },

  async handleTrainModel() {
    return ErrorHandler.handle('model training', async () => {
      const unassigned = AppState.normalizedData.filter(tx => !tx.category);
      if (unassigned.length > 0) {
        const proceed = confirm(`${unassigned.length} transactions lack categories. Continue training?`);
        if (!proceed) return;
      }
      const trainingData = AppState.normalizedData.filter(tx => tx.category && tx.category.trim() !== '');
      if (trainingData.length === 0) {
        UI.showAlert('No categorized transactions to train on');
        return;
      }
      if (trainingData.length > 500) {
        const proceed = confirm(`Large dataset detected (${trainingData.length} transactions).\n\nThe system will optimize for performance. Continue?`);
        if (!proceed) return;
      }
      const startTime = Date.now();
      const progressCallback = {
        onEpochBegin: (epoch) => {
          const totalEpochs = Math.min(CONFIG.EPOCHS_MAX, Math.max(CONFIG.EPOCHS_MIN, Math.floor(2000 / trainingData.length)));
          const progress = 45 + ((epoch + 1) / totalEpochs) * 45;
          UI.updateLoadingBar(`Training epoch ${epoch + 1}/${totalEpochs}...`, progress, { epoch: epoch + 1 });
        },
        onEpochEnd: (epoch, logs) => {
          const elapsedTime = Math.round((Date.now() - startTime) / 1000);
          UI.updateLoadingBar(`Training epoch ${epoch + 1}...`, null, {accuracy: logs.acc, loss: logs.loss, time: elapsedTime});
        }
      };
      UI.updateLoadingBar('Preparing data...', 5);
      const result = await ML.trainModel(trainingData, progressCallback);
      UI.updateLoadingBar('Training completed successfully!', 100);
      UI.hideLoadingBar();
      UI.updateModelStatus(true);
      UI.showAlert(`Model trained and saved successfully!\nLocation: ${result.path}`);
    });
  },

  async handlePredict() {
    return ErrorHandler.handle('prediction', async () => {
      if (!AppState.model || !AppState.modelMetadata) {
        UI.showAlert('Load or train a model first');
        return;
      }
      const unpredictedIndices = [];
      const unpredictedTransactions = [];
      AppState.normalizedData.forEach((tx, idx) => {
        if (!tx.category || tx.category.trim() === '') {
          const text = (tx.description || '').toLowerCase().trim();
          if (text.length > 0) {
            unpredictedIndices.push(idx);
            unpredictedTransactions.push(tx);
          }
        }
      });
      if (unpredictedTransactions.length === 0) {
        UI.showAlert('All transactions already have categories');
        return;
      }
      const predictions = await ML.predict(unpredictedTransactions);
      predictions.forEach((pred, i) => {
        const originalIdx = unpredictedIndices[i];
        AppState.normalizedData[originalIdx].previousCategory = AppState.normalizedData[originalIdx].category || 'Uncategorized';
        AppState.normalizedData[originalIdx].category = pred.category;
        AppState.normalizedData[originalIdx].confidence = pred.confidence;
      });
      Views.displayTransactions(AppState.normalizedData);
      Views.displayPredictionResults();
      UI.showAlert(`Successfully predicted ${unpredictedTransactions.length} transactions!`);
    });
  },

  async handleDeleteModel() {
    const proceed = confirm('Delete saved model and retrain?');
    if (!proceed) return;
    return ErrorHandler.handle('model deletion', async () => {
      const result = await Utils.safeInvoke('delete-model');
      if (!result.success) throw new Error(result.error);
      if (AppState.model) AppState.model.dispose();
      AppState.model = null;
      AppState.modelMetadata = null;
      UI.updateModelStatus(false);
      UI.showAlert('Model deleted. You can train a new one now.');
    });
  },

  handleTransactionSearch: Utils.debounce(function(event) {
    const searchTerm = event.target.value.toLowerCase().trim();
    const dailyContainer = document.getElementById('dailyTransactionsContainer');
    const searchContainer = document.getElementById('searchResultsContainer');
    if (!searchTerm) {
      dailyContainer.style.display = 'block';
      searchContainer.style.display = 'none';
      searchContainer.innerHTML = '';
      return;
    }
    const filtered = AppState.normalizedData
      .map((tx, index) => ({ ...tx, originalIndex: index }))
      .filter(tx => (tx.description || '').toLowerCase().includes(searchTerm));
    dailyContainer.style.display = 'none';
    searchContainer.style.display = 'block';
    Views.renderSearchResults(filtered);
  }, 300),

  handleBulkEditAccount() {
    const checked = document.querySelectorAll('.transaction-checkbox:checked');
    if (checked.length === 0) {
      UI.showAlert('Please select transactions to edit');
      return;
    }
    UI.showPrompt(`Selected ${checked.length} transaction(s). Enter new account name:`, (newAccountName) => {
      if (newAccountName === null) return;
      if (newAccountName.trim() === '') {
        UI.showAlert('Please enter an account name');
        return;
      }
      checked.forEach(checkbox => {
        const idx = checkbox.dataset.index;
        if (idx !== undefined) {
          AppState.accountNames[idx] = newAccountName.trim();
          if (AppState.normalizedData[idx]) {
            AppState.normalizedData[idx].account = newAccountName.trim();
          }
        }
      });
      Views.generateDailyTransactionsView();
    });
  },

  handleSelectAllTransactions() {
    const checkboxes = document.querySelectorAll('#dailyTransactionsContainer .transaction-checkbox');
    const btn = document.getElementById('selectAllBtn');
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    checkboxes.forEach(cb => cb.checked = !allChecked);
    if (btn) btn.textContent = allChecked ? 'Select All' : 'Deselect All';
  },

  editAccount(transactionIndex) {
    const accountEl = document.querySelector(`[data-index="${transactionIndex}"] .transaction-account`);
    if (!accountEl || accountEl.classList.contains('editing')) return;
    if (document.getElementById('customPrompt')) return;
    const currentAccount = AppState.accountNames[transactionIndex] || 'Default Account';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'account-input';
    input.value = currentAccount;
    input.placeholder = 'Enter account name';
    accountEl.textContent = '';
    accountEl.appendChild(input);
    accountEl.classList.add('editing');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const saveAccount = () => {
      const newAccount = input.value.trim() || 'Default Account';
      AppState.accountNames[transactionIndex] = newAccount;
      if (AppState.normalizedData[transactionIndex]) {
        AppState.normalizedData[transactionIndex].account = newAccount;
      }
      accountEl.textContent = newAccount;
      accountEl.classList.remove('editing');
    };
    const cancelEdit = () => {
      accountEl.textContent = currentAccount;
      accountEl.classList.remove('editing');
    };
    input.addEventListener('blur', saveAccount);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); saveAccount(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });
  }
};

const Views = {
  showColumnMappingUI(headers, rows, autoConfirm = false) {
    const container = document.getElementById('columnMappingContainer');
    if (!container) return;
    container.innerHTML = '';
    const requiredFields = ['Date', 'Description', 'Amount'];
    requiredFields.forEach(field => {
      const label = document.createElement('label');
      label.textContent = `Map ${field} to: `;
      const select = document.createElement('select');
      select.id = `map-${field}`;
      headers.forEach(header => {
        const option = document.createElement('option');
        option.value = header;
        option.textContent = header;
        select.appendChild(option);
      });
      // Set saved mapping if available
      const fieldLower = field.toLowerCase();
      if (AppState.columnMapping && AppState.columnMapping[fieldLower]) {
        select.value = AppState.columnMapping[fieldLower];
      } else {
        // Auto-select if header names match common patterns
        const patterns = {
          Date: ['date', 'datetime', 'timestamp', 'trans_date'],
          Description: ['description', 'desc', 'memo', 'payee', 'narrative'],
          Amount: ['amount', 'amt', 'value', 'debit', 'credit', 'transaction_amount']
        };
        const pattern = new RegExp(patterns[field].join('|'), 'i');
        const match = headers.find(h => pattern.test(h));
        if (match) select.value = match;
      }
      label.appendChild(select);
      container.appendChild(label);
      container.appendChild(document.createElement('br'));
    });
    const confirmBtn = document.getElementById('confirmMappingBtn');
    if (confirmBtn) {
      if (autoConfirm) {
        confirmBtn.style.display = 'none';
      } else {
        confirmBtn.style.display = 'inline-block';
      }
    }
  },

  displayTransactions(data) {
    const container = document.getElementById('transactionsList');
    if (!container) return;
    container.innerHTML = '';
    data.forEach((tx, i) => {
      const el = document.createElement('div');
      el.style.marginBottom = '8px';
      if (tx.confidence !== undefined) {
        el.style.backgroundColor = '#ffe5e5';
        el.style.color = '#1d1d1f';
        el.style.padding = '8px';
        el.style.borderRadius = '6px';
        el.style.border = '1px solid #ffcccc';
      }
      const descText = document.createElement('span');
      let amountHtml = '';
      if (typeof tx.amount === 'number' && !isNaN(tx.amount)) {
        if (tx.amount < 0) {
          amountHtml = `<span style="color:#ff3b30;font-weight:700;">${tx.amount.toFixed(2)}</span>`;
        } else if (tx.amount > 0) {
          amountHtml = `<span style="color:#34c759;font-weight:700;">${tx.amount.toFixed(2)}</span>`;
        } else {
          amountHtml = tx.amount.toFixed(2);
        }
      } else {
        amountHtml = tx.amount || '';
      }
      descText.innerHTML = `${i + 1}. ${tx.date || ''} | ${Utils.sanitizeHTML(tx.description || '')} | ${amountHtml} | `;
      const select = document.createElement('select');
      select.dataset.index = i;
      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = '-- Select Category --';
      select.appendChild(defaultOption);
      allCategoriesFlat.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat;
        option.textContent = cat;
        if (tx.category === cat) option.selected = true;
        select.appendChild(option);
      });
        select.addEventListener('change', async (e) => {
          const idx = e.target.dataset.index;
          AppState.normalizedData[idx].category = e.target.value;
          if (AppState.currentView === 'categories') {
            this.generateCategoriesSummary();
          }
          // Autosave immediately when category changes
          await CSVManagement.autosave();
        });
      el.appendChild(descText);
      el.appendChild(select);
      if (tx.confidence !== undefined) {
        const prevCategory = document.createElement('span');
        prevCategory.style.marginLeft = '8px';
        prevCategory.style.color = '#86868b';
        prevCategory.textContent = `(Previously: ${tx.previousCategory || 'Uncategorized'})`;
        el.appendChild(prevCategory);
      }
      container.appendChild(el);
    });
    if (AppState.currentView === 'categories') {
      this.generateCategoriesSummary();
    }
    if (AppState.currentView === 'dailyTransactions') {
      this.generateDailyTransactionsView();
    }
    this.updateGraphsView();
  },

  displayPredictionResults() {
    const container = document.getElementById('predictionResults');
    if (!container) return;
    container.innerHTML = '<h3>Prediction Results</h3>';
    const counts = {};
    const confidenceByCategory = {};
    AppState.normalizedData.forEach(tx => {
      if (tx.category) {
        counts[tx.category] = (counts[tx.category] || 0) + 1;
        if (tx.confidence !== undefined) {
          if (!confidenceByCategory[tx.category]) {
            confidenceByCategory[tx.category] = [];
          }
          confidenceByCategory[tx.category].push(tx.confidence);
        }
      }
    });
    const ul = document.createElement('ul');
    Object.entries(counts).forEach(([cat, count]) => {
      const li = document.createElement('li');
      let text = `${cat}: ${count}`;
      if (confidenceByCategory[cat]) {
        const avg = confidenceByCategory[cat].reduce((a, b) => a + b, 0) / confidenceByCategory[cat].length;
        text += ` (avg confidence: ${avg.toFixed(2)})`;
      }
      li.textContent = text;
      ul.appendChild(li);
    });
    container.appendChild(ul);
  },

  generateCategoriesSummary() {
    const container = document.getElementById('categoriesSummary');
    if (!container) return;
    if (!AppState.normalizedData || AppState.normalizedData.length === 0) {
      container.innerHTML = '<div class="centered-message">No data available. Please upload a CSV file first.</div>';
      return;
    }
    const validTransactions = AppState.normalizedData.filter(tx => tx.date && tx.amount && !isNaN(tx.amount) && tx.amount !== 0);
    if (validTransactions.length === 0) {
      container.innerHTML = '<div class="centered-message">No valid transactions found.</div>';
      return;
    }
    const dates = validTransactions.map(tx => new Date(tx.date)).filter(date => !isNaN(date.getTime()));
    if (dates.length === 0) {
      container.innerHTML = '<div class="centered-message">No valid dates found.</div>';
      return;
    }
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    const timeframe = `${minDate.toLocaleDateString()} - ${maxDate.toLocaleDateString()}`;
    const categoryTotals = {};
    const subcategoryTotals = {};
    validTransactions.forEach(tx => {
      if (tx.category) {
        const [mainCategory] = tx.category.split(' > ');
        categoryTotals[mainCategory] = (categoryTotals[mainCategory] || 0) + Math.abs(tx.amount);
        subcategoryTotals[tx.category] = (subcategoryTotals[tx.category] || 0) + Math.abs(tx.amount);
      }
    });
    const totalIncome = validTransactions.filter(tx => tx.amount > 0).reduce((sum, tx) => sum + tx.amount, 0);
    const totalExpenses = validTransactions.filter(tx => tx.amount < 0).reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
    const net = totalIncome - totalExpenses;
    const sortedCategories = Object.entries(categoryTotals).sort(([,a], [,b]) => b - a);
    let html = `
      <div class="summary-header"><span class="summary-title">Summary</span></div>
      <div class="summary-stats">
        <div class="stat-item"><span class="stat-label">Timeframe:</span><span class="stat-value">${timeframe}</span></div>
        <div class="stat-item"><span class="stat-label">Total Income:</span><span class="stat-value income">${Utils.formatCurrency(totalIncome)}</span></div>
        <div class="stat-item"><span class="stat-label">Total Expenses:</span><span class="stat-value">${Utils.formatCurrency(totalExpenses)}</span></div>
        <div class="stat-item"><span class="stat-label">Net:</span><span class="stat-value ${net >= 0 ? 'net-positive' : 'net-negative'}">${Utils.formatCurrency(net)}</span></div>
      </div>
    `;
    sortedCategories.forEach(([category, total]) => {
      const subcategories = Object.entries(subcategoryTotals)
        .filter(([cat]) => cat.startsWith(category + ' >'))
        .sort(([,a], [,b]) => b - a);
      html += `<div class="category-summary"><div class="category-header"><span>${Utils.sanitizeHTML(category)}</span><div><span class="category-total">${Utils.formatCurrency(total)}</span><span class="category-timeframe">${timeframe}</span></div></div>`;
      if (subcategories.length > 0) {
        subcategories.forEach(([subcat, amount]) => {
          const subcatName = subcat.replace(category + ' > ', '');
          const percentage = ((amount / total) * 100).toFixed(1);
          html += `<div class="subcategory-item"><span class="subcategory-name">${Utils.sanitizeHTML(subcatName)}</span><div><span class="subcategory-amount">${Utils.formatCurrency(amount)}</span><span style="color:#86868b;font-size:0.8em;">(${percentage}%)</span></div></div>`;
        });
      }
      html += '</div>';
    });
    container.innerHTML = html;
  },

  generateDailyTransactionsView() {
    const container = document.getElementById('dailyTransactionsContainer');
    if (!container) return;
    if (!AppState.normalizedData || AppState.normalizedData.length === 0) {
      container.innerHTML = '<div class="centered-message">No data available. Please upload a CSV file first.</div>';
      return;
    }
    const validTransactions = AppState.normalizedData.filter(tx => tx.date && tx.amount && !isNaN(tx.amount) && tx.amount !== 0);
    if (validTransactions.length === 0) {
      container.innerHTML = '<div class="centered-message">No valid transactions found.</div>';
      return;
    }
    const transactionsByDate = {};
    validTransactions.forEach((tx, index) => {
      const date = new Date(tx.date);
      if (isNaN(date.getTime())) return;
      const dateKey = date.toISOString().split('T')[0];
      if (!transactionsByDate[dateKey]) transactionsByDate[dateKey] = [];
      transactionsByDate[dateKey].push({ ...tx, originalIndex: index });
    });
    const sortedDates = Object.keys(transactionsByDate).sort((a, b) => new Date(b) - new Date(a));
    if (sortedDates.length === 0) {
      container.innerHTML = '<div class="centered-message">No valid dates found.</div>';
      return;
    }
    let html = '';
    sortedDates.forEach(dateKey => {
      const transactions = transactionsByDate[dateKey];
      const date = new Date(dateKey);
      const formattedDate = date.toLocaleDateString('en-US', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'});
      const dayTotal = transactions.reduce((sum, tx) => sum + tx.amount, 0);
      const dayTotalClass = dayTotal < 0 ? 'negative' : dayTotal > 0 ? 'positive' : '';
      html += `<div class="day-group"><div class="day-header"><span class="day-date">${formattedDate}</span><span class="day-total ${dayTotalClass}">${Utils.formatCurrency(dayTotal)}</span></div><ul class="transactions-list">`;
      const sortedTransactions = transactions.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
      sortedTransactions.forEach(tx => {
        const amountClass = tx.amount < 0 ? 'negative' : tx.amount > 0 ? 'positive' : '';
        const accountName = AppState.accountNames[tx.originalIndex] || 'Default Account';
        html += `<li class="transaction-item" data-index="${tx.originalIndex}"><input type="checkbox" class="transaction-checkbox" data-index="${tx.originalIndex}"><div class="transaction-info"><div class="transaction-description">${Utils.sanitizeHTML(tx.description || 'No description')}</div><div class="transaction-meta"><span class="transaction-category">${Utils.sanitizeHTML(tx.category || 'Uncategorized')}</span><span class="transaction-account" onclick="Handlers.editAccount(${tx.originalIndex})">${Utils.sanitizeHTML(accountName)}</span></div></div><div class="transaction-amount ${amountClass}">${Utils.formatCurrency(tx.amount)}</div></li>`;
      });
      html += `</ul></div>`;
    });
    container.innerHTML = html;
  },

  renderSearchResults(results) {
    const container = document.getElementById('searchResultsContainer');
    if (!container) return;
    if (results.length === 0) {
      container.innerHTML = '<div class="no-transactions">No transactions match your search.</div>';
      return;
    }
    const html = results.map(tx => {
      const amountClass = tx.amount < 0 ? 'negative' : tx.amount > 0 ? 'positive' : '';
      const accountName = AppState.accountNames[tx.originalIndex] || 'Default Account';
      const transactionDate = tx.date ? new Date(tx.date).toLocaleDateString() : 'No date';
      return `<div class="transaction-item" data-index="${tx.originalIndex}"><div class="transaction-info"><div class="transaction-description">${Utils.sanitizeHTML(tx.description || 'No description')}</div><div class="transaction-meta"><span class="transaction-category">${Utils.sanitizeHTML(tx.category || 'Uncategorized')}</span><span class="transaction-account" onclick="Handlers.editAccount(${tx.originalIndex})">${Utils.sanitizeHTML(accountName)}</span><span>${transactionDate}</span></div></div><div class="transaction-amount ${amountClass}">${Utils.formatCurrency(tx.amount)}</div></div>`;
    }).join('');
    container.innerHTML = html;
  },

  renderSpendingChart() {
    try {
      if (typeof Chart === 'undefined') return;
      const spendingChartEl = document.getElementById('spendingChart');
      if (!spendingChartEl) return;
      const container = spendingChartEl.parentElement;
      const oldCanvas = document.getElementById('spendingChart');
      if (oldCanvas) {
        if (AppState.spendingChart) {
          AppState.spendingChart.destroy();
          AppState.spendingChart = null;
        }
        container.removeChild(oldCanvas);
      }
      const newCanvas = document.createElement('canvas');
      newCanvas.id = 'spendingChart';
      newCanvas.width = 600;
      newCanvas.height = 400;
      newCanvas.style.maxWidth = '100%';
      container.appendChild(newCanvas);
      const ctx = newCanvas.getContext('2d');
      const categoryTotals = {};
      (AppState.normalizedData || []).forEach(tx => {
        if (tx.category) {
          const [mainCategory] = tx.category.split(' > ');
          categoryTotals[mainCategory] = (categoryTotals[mainCategory] || 0) + Math.abs(tx.amount || 0);
        }
      });
      const labels = Object.keys(categoryTotals);
      const data = Object.values(categoryTotals);
      const backgroundColors = ['#ff6b35','#34c759','#ff3b30','#ffcc00','#5ac8fa','#af52de','#ff9500','#30d158','#bf5af2','#ff375f','#1d1d1f','#8e8e93','#c7c7cc'];
      AppState.spendingChart = new Chart(ctx, {
        type: AppState.currentGraphType,
        data: {
          labels,
          datasets: [{
            data,
            backgroundColor: backgroundColors,
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: AppState.currentGraphType === 'pie', position: 'bottom' },
            title: {
              display: true,
              text: AppState.currentGraphType === 'pie' ? 'Spending by Category (Pie)' : 'Spending by Category (Bar)',
              font: { size: 16, weight: 'bold' },
              color: '#1d1d1f'
            }
          },
          scales: AppState.currentGraphType === 'bar' ? { y: { beginAtZero: true } } : {}
        }
      });
    } catch (error) {
      console.error('Error rendering chart:', error);
    }
  },

  updateGraphsView() {
    if (AppState.currentView === 'graphs') {
      this.renderSpendingChart();
    }
  },

  updateModelManagementView() {
    const indicator = document.getElementById('modelStatusIndicator');
    if (!indicator) return;
    if (AppState.model && AppState.modelMetadata) {
      indicator.textContent = 'Model Loaded';
      indicator.classList.remove('not-loaded');
      indicator.classList.add('loaded');
    } else {
      indicator.textContent = 'Model Not Loaded';
      indicator.classList.remove('loaded');
      indicator.classList.add('not-loaded');
    }
  },

  async switchView(view) {
    const views = ['dashboard', 'csv', 'categories', 'graphs', 'dailyTransactions', 'modelManagement', 'csvManagement'];
    const topBarTitle = document.getElementById('topBarTitle');
    const submenuButtons = document.getElementById('submenuButtons');
    views.forEach(v => {
      const viewEl = document.getElementById(`${v}View`);
      const btnEl = document.getElementById(`${v}ViewBtn`);
      if (viewEl) viewEl.classList.remove('active');
      if (btnEl) btnEl.classList.remove('active');
    });
    AppState.currentView = view;
    const currentViewEl = document.getElementById(`${view}View`);
    const currentBtnEl = document.getElementById(`${view}ViewBtn`);
    if (currentViewEl) currentViewEl.classList.add('active');
    if (currentBtnEl) currentBtnEl.classList.add('active');
    const titles = {
      dashboard: 'Dashboard',
      csv: 'CSV Upload',
      categories: 'Categories',
      graphs: 'Spending Graphs',
      dailyTransactions: 'Daily Transactions',
      modelManagement: 'Model Management',
      csvManagement: 'CSV Management'
    };
    if (topBarTitle) topBarTitle.textContent = titles[view] || 'Budget Analysis';
    if (submenuButtons) {
      submenuButtons.innerHTML = '';
    }
    if (view === 'categories') {
      this.generateCategoriesSummary();
    } else if (view === 'graphs') {
      this.renderSpendingChart();
    } else if (view === 'dailyTransactions') {
      this.generateDailyTransactionsView();
    } else if (view === 'modelManagement') {
      this.updateModelManagementView();
    } else if (view === 'csv') {
      // Show column mapping if we have raw data
        // Always load latest autosave when switching to CSV view
        const autosaveResult = await Utils.safeInvoke('load-csv-upload', 'autosave.json');
        if (autosaveResult && autosaveResult.success && autosaveResult.isJson && autosaveResult.data) {
          const data = autosaveResult.data;
          if (Array.isArray(data)) {
            AppState.normalizedData = data;
            AppState.accountNames = {};
            AppState.normalizedData.forEach((tx, i) => AppState.accountNames[i] = tx.account || 'Default Account');
            AppState.rawCsvData = [];
            AppState.columnMapping = null;
          } else {
            AppState.normalizedData = data.normalizedData || [];
            AppState.accountNames = data.accountNames || {};
            AppState.rawCsvData = data.rawCsvData || [];
            AppState.columnMapping = data.columnMapping || null;
          }
          if (AppState.rawCsvData && AppState.rawCsvData.length > 0 && AppState.columnMapping) {
            const headers = Object.keys(AppState.rawCsvData[0]);
            Views.showColumnMappingUI(headers, AppState.rawCsvData);
            Views.displayTransactions(AppState.normalizedData);
          } else if (AppState.normalizedData && AppState.normalizedData.length > 0) {
            Views.displayTransactions(AppState.normalizedData);
          }
        } else {
          // Fallback: Show mapping UI if we have raw data
          if (AppState.rawCsvData && AppState.rawCsvData.length > 0 && AppState.columnMapping) {
            const headers = Object.keys(AppState.rawCsvData[0]);
            Views.showColumnMappingUI(headers, AppState.rawCsvData);
            Views.displayTransactions(AppState.normalizedData);
          } else if (AppState.rawCsvData && AppState.rawCsvData.length > 0) {
            const headers = Object.keys(AppState.rawCsvData[0]);
            Views.showColumnMappingUI(headers, AppState.rawCsvData);
          }
        }
    } else if (view === 'csvManagement') {
      CSVManagement.renderCsvList();
    }
  }
};

const CSVManagement = {
  async renderCsvList() {
    const container = document.getElementById('csvManagementListContainer');
    if (!container) return;
    
    container.innerHTML = '<div class="centered-message">Loading CSVs from csv_uploads folder...</div>';
    
    try {
      console.log('Requesting CSV list from csv_uploads folder...');
      const result = await Utils.safeInvoke('load-all-csv-uploads');
      console.log('CSV list result:', result);
      
      if (!result.success) {
        console.error('Failed to load CSVs:', result.error);
        container.innerHTML = `<div class="centered-message">Error: ${result.error}</div>`;
        return;
      }
      
      if (!result.csvs || result.csvs.length === 0) {
        container.innerHTML = '<div class="centered-message">No saved CSVs found in csv_uploads folder.</div>';
        return;
      }
      
      console.log(`Found ${result.csvs.length} CSV files:`, result.csvs.map(c => c.fileName));
      
      const sortedCsvs = result.csvs.sort((a, b) => {
        if (a.fileName === 'autosave.json') return -1;
        if (b.fileName === 'autosave.json') return 1;
        return new Date(b.uploadedAt) - new Date(a.uploadedAt);
      });
      
      let html = '<div style="margin-bottom:16px;padding:12px;background:#fff3e0;border-radius:8px;color:#1d1d1f;font-size:0.9em;">📁 Loading from: <strong>csv_uploads</strong> folder</div>';
      html += '<div style="display: flex; flex-direction: column; gap: 12px;">';
      
      sortedCsvs.forEach(csv => {
        const isAutosave = csv.fileName === 'autosave.json';
        const displayName = isAutosave ? 'Autosave' : (csv.originalName || csv.fileName).replace(/\.csv$/i, '').replace(/\.json$/i, '');
        const timestamp = new Date(csv.uploadedAt).toLocaleString();
        const badge = isAutosave ? '<span style="background:#ff6b35;color:white;padding:2px 8px;border-radius:4px;font-size:0.8em;margin-left:8px;">AUTO</span>' : '';
        
        html += `
          <div style="display:flex;align-items:center;padding:16px;background:#f5f5f7;border-radius:8px;border:1px solid #e5e5e7;">
            <div style="flex:1;">
              <div style="font-weight:600;color:#1d1d1f;margin-bottom:4px;">${Utils.sanitizeHTML(displayName)}${badge}</div>
              <div style="font-size:0.85em;color:#86868b;">${timestamp}</div>
              <div style="font-size:0.75em;color:#c7c7cc;margin-top:4px;">${Utils.sanitizeHTML(csv.fileName)}</div>
            </div>
            <button class="primary-btn load-csv-btn" data-filename="${Utils.sanitizeHTML(csv.fileName)}" style="margin-left:12px;">Load</button>
            <button class="primary-btn delete-csv-btn" data-filename="${Utils.sanitizeHTML(csv.fileName)}" style="margin-left:8px; background-color:#ff3b30;">Delete</button>
          </div>
        `;
      });
      html += '</div>';
      container.innerHTML = html;
      
      container.querySelectorAll('.load-csv-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const filename = e.target.getAttribute('data-filename');
          console.log('Loading CSV file:', filename);
          await CSVManagement.loadCsv(filename);
        });
      });

      container.querySelectorAll('.delete-csv-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const filename = e.target.getAttribute('data-filename');
          const confirmed = confirm(`Are you sure you want to delete ${filename}? This action cannot be undone.`);
          if (!confirmed) return;

          try {
            const result = await Utils.safeInvoke('delete-csv-upload', filename);
            if (result.success) {
              UI.showAlert(`Successfully deleted ${filename}`);
              await CSVManagement.renderCsvList(); // Refresh the list
            } else {
              UI.showAlert('Error deleting file: ' + result.error);
            }
          } catch (err) {
            console.error('Error deleting CSV:', err);
            UI.showAlert('Error deleting file: ' + err.message);
          }
        });
      });
    } catch (err) {
      console.error('Error rendering CSV list:', err);
      container.innerHTML = `<div class="centered-message">Error loading CSVs: ${err.message}</div>`;
    }
  },
  
  async loadCsv(filename) {
    try {
      console.log('Loading CSV from csv_uploads:', filename);
      const result = await Utils.safeInvoke('load-csv-upload', filename);
      
      if (!result || !result.success) {
        console.error('Load failed:', result);
        UI.showAlert('Failed to load CSV: ' + (result ? result.error : 'Unknown error'));
        return;
      }

      console.log('Load result:', { isJson: result.isJson, hasData: !!result.data });

      if (!result.isJson) {
        // Parse CSV text
        Papa.parse(result.data, {
          header: true,
          skipEmptyLines: true,
          dynamicTyping: true,
          complete: (parseRes) => {
            const rows = parseRes.data.map(r => ({
              date: r.date || r.Date || r.date_time || r.datetime || r.Timestamp || r.timestamp,
              description: r.description || r.Description || r.Memo || r.Payee || r.PayeeName || r['Description/Payee'] || '',
              amount: Utils.parseAmount(r.amount || r.Amount || r.AMT || r.Value || r.AmountUSD || 0),
              category: r.category || r.Category || '',
              account: r.account || r.Account || 'Default Account'
            }));

            AppState.normalizedData = rows;
            AppState.accountNames = {};
            AppState.normalizedData.forEach((tx, i) => AppState.accountNames[i] = tx.account || 'Default Account');

            if (AppState.normalizedData.length === 0) {
              UI.showAlert('CSV file is empty or invalid.');
              return;
            }

            Views.generateCategoriesSummary();
            Views.generateDailyTransactionsView();
            Views.updateGraphsView();
            UI.showAlert(`Loaded ${AppState.normalizedData.length} transactions from ${filename}`);
            console.log(`Loaded CSV (CSV text): ${filename} with ${AppState.normalizedData.length} transactions`);
          },
          error: (err) => {
            ErrorHandler.show('Failed to parse CSV', err);
          }
        });
      } else {
        // JSON data
        const data = result.data;
        if (!data || (!Array.isArray(data.normalizedData) && !Array.isArray(data))) {
          UI.showAlert('Saved file does not contain expected transaction data');
          return;
        }

        // Accept two possible shapes: { normalizedData, accountNames, rawCsvData } OR an array of transactions
        if (Array.isArray(data)) {
          AppState.normalizedData = data;
          AppState.accountNames = {};
          AppState.normalizedData.forEach((tx, i) => AppState.accountNames[i] = tx.account || 'Default Account');
        } else {
          AppState.normalizedData = data.normalizedData || [];
          AppState.accountNames = data.accountNames || {};
          AppState.rawCsvData = data.rawCsvData || [];
        }

        if (AppState.normalizedData.length === 0) {
          UI.showAlert('CSV file is empty or invalid.');
          return;
        }

        Views.generateCategoriesSummary();
        Views.generateDailyTransactionsView();
        Views.updateGraphsView();
        UI.showAlert(`Loaded ${AppState.normalizedData.length} transactions from ${filename}`);
        console.log(`Loaded CSV (JSON): ${filename} with ${AppState.normalizedData.length} transactions`);
      }
    } catch (err) {
      console.error('Error loading CSV:', err);
      UI.showAlert('Error loading CSV: ' + err.message);
    }
  },
  
  async saveCurrentCsv(customName = null, isAutosave = false) {
    if (!AppState.normalizedData || AppState.normalizedData.length === 0) {
      if (!isAutosave) UI.showAlert('No CSV data to save.');
      return;
    }
    
    const saveData = {
      normalizedData: AppState.normalizedData,
      accountNames: AppState.accountNames,
      rawCsvData: AppState.rawCsvData,
      columnMapping: AppState.columnMapping
    };
    
    const doSave = async (name) => {
      try {
        const fileName = isAutosave ? 'autosave' : name.replace(/[^a-zA-Z0-9-_\s]/g, '_');
        console.log('Saving CSV to csv_uploads as:', fileName);
        const result = await Utils.safeInvoke('save-user-csv-data', fileName, saveData);
        
        if (result.success) {
          if (!isAutosave) {
            UI.showAlert(`CSV saved successfully as "${result.fileName}"!\n\nSaved to: csv_uploads folder`);
            if (AppState.currentView === 'csvManagement') {
              await CSVManagement.renderCsvList();
            }
          }
          console.log(`CSV saved: ${result.fileName} at ${result.path}`);
        } else {
          if (!isAutosave) UI.showAlert('Failed to save CSV: ' + result.error);
        }
      } catch (err) {
        console.error('Error saving CSV:', err);
        if (!isAutosave) UI.showAlert('Error saving CSV: ' + err.message);
      }
    };
    
    if (isAutosave) {
      await doSave('autosave');
    } else if (customName) {
      await doSave(customName);
    } else {
      UI.showPrompt('Enter a name for your CSV:', async (name) => {
        if (!name || name.trim() === '') return;
        await doSave(name.trim());
      });
    }
  },
  
  async autosave() {
    await CSVManagement.saveCurrentCsv(null, true);
  }
};

const Sidebar = {
  init() {
    const viewButtons = {
      dashboard: document.getElementById('dashboardViewBtn'),
      csv: document.getElementById('csvViewBtn'),
      categories: document.getElementById('categoriesViewBtn'),
      graphs: document.getElementById('graphsViewBtn'),
      dailyTransactions: document.getElementById('dailyTransactionsViewBtn'),
      modelManagement: document.getElementById('modelManagementViewBtn'),
      csvManagement: document.getElementById('csvManagementViewBtn')
    };
    Object.entries(viewButtons).forEach(([view, btn]) => {
      if (btn) {
        btn.addEventListener('click', async () => {
          await Views.switchView(view);
        });
      }
    });
  },

  initGraphToggle() {
    const toggleBtn = document.getElementById('toggleGraphTypeBtn');
    if (!toggleBtn) return;
    const handleToggle = () => {
      AppState.currentGraphType = AppState.currentGraphType === 'pie' ? 'bar' : 'pie';
      toggleBtn.textContent = AppState.currentGraphType === 'pie' ? 'Show Bar Chart' : 'Show Pie Chart';
      Views.renderSpendingChart();
    };
    toggleBtn.removeEventListener('click', handleToggle);
    toggleBtn.addEventListener('click', handleToggle);
    toggleBtn.textContent = AppState.currentGraphType === 'pie' ? 'Show Bar Chart' : 'Show Pie Chart';
  }
};

const ModelLoader = {
  async loadExistingModel() {
    let weights = [];
    try {
      console.log('Attempting to load existing model...');
      if (typeof tf === 'undefined') {
        throw new Error('TensorFlow.js not available');
      }
      const modelData = await Utils.safeInvoke('load-model');
      if (!modelData || !modelData.model || !modelData.metadata) {
        console.log('No valid model data found');
        UI.updateModelStatus(false);
        return;
      }
      if (AppState.model) {
        AppState.model.dispose();
        AppState.model = null;
      }
      
      let modelTopology = modelData.model.modelTopology;
      if (typeof modelTopology === 'string') {
        modelTopology = JSON.parse(modelTopology);
      }
      
      console.log('Creating model from topology...');
      AppState.model = await tf.models.modelFromJSON(modelTopology);
      
      console.log('Processing weights...');
      const weightSpecs = modelData.model.weightsManifest[0].weights;
      const weightData = modelData.model.weightData;
      
      if (!Array.isArray(weightData)) {
        throw new Error('Weight data must be an array');
      }
      
      // Calculate total expected values
      const totalExpectedValues = weightSpecs.reduce((total, spec) => {
        return total + spec.shape.reduce((a, b) => a * b, 1);
      }, 0);
      
      console.log(`Expected total values: ${totalExpectedValues}, actual: ${weightData.length}`);
      if (weightData.length !== totalExpectedValues) {
        throw new Error(`Weight data length mismatch: expected ${totalExpectedValues} but got ${weightData.length}`);
      }
      
      // Create tensors from weight data
      let offset = 0;
      for (const spec of weightSpecs) {
        const size = spec.shape.reduce((a, b) => a * b, 1);
        console.log(`Creating tensor: shape=${spec.shape}, size=${size}, dtype=${spec.dtype}`);
        
        if (offset + size > weightData.length) {
          throw new Error(`Insufficient data for tensor: need ${size} values at offset ${offset}`);
        }
        
        const values = weightData.slice(offset, offset + size);
        const tensorValues = Array.from(values);
        if (tensorValues.length !== size) {
          throw new Error(`Value count mismatch: expected ${size} but got ${tensorValues.length}`);
        }
        
        const tensor = tf.tensor(tensorValues, spec.shape, spec.dtype);
        weights.push(tensor);
        offset += size;
      }
      
      console.log('Setting model weights...');
      await AppState.model.setWeights(weights);
      AppState.modelMetadata = modelData.metadata;
      UI.updateModelStatus(true);
      console.log('Model loaded successfully from storage');
    } catch (error) {
      console.error('Error loading model:', error);
      if (AppState.model) {
        AppState.model.dispose();
        AppState.model = null;
      }
      UI.updateModelStatus(false);
    } finally {
      // Clean up tensors
      weights.forEach(w => w.dispose());
    }
  },

  async loadFromFile() {
    let weights = [];
    try {
      console.log('Opening file dialog...');
      const result = await Utils.safeInvoke('open-model-file');
      if (result.canceled) {
        console.log('Model file selection canceled');
        return;
      }
      if (!result.filePath) {
        throw new Error('No file path returned from file dialog');
      }
      
      console.log('Loading model from:', result.filePath);
      const modelDataRaw = await Utils.safeInvoke('read-model-file', result.filePath);
      if (!modelDataRaw?.success || !modelDataRaw.data) {
        throw new Error('Failed to read model file: ' + (modelDataRaw?.error || 'No data received'));
      }
      
      console.log('Parsing model data...');
      const modelData = JSON.parse(modelDataRaw.data);
      console.log('Model data structure:', {
        hasModel: !!modelData.model,
        hasTopology: !!modelData.model?.modelTopology,
        hasWeightsManifest: !!modelData.model?.weightsManifest,
        hasWeightData: !!modelData.model?.weightData,
        weightDataLength: modelData.model?.weightData?.length
      });
      
      // Clean up existing model if any
      if (AppState.model) {
        AppState.model.dispose();
        AppState.model = null;
      }
      
      // Validate model structure
      if (!modelData.model?.modelTopology) {
        throw new Error('Invalid model: missing topology');
      }
      
      if (!modelData.model.weightsManifest?.[0]?.weights) {
        throw new Error('Invalid model: missing weights manifest');
      }
      
      if (!Array.isArray(modelData.model.weightData)) {
        throw new Error('Invalid model: weight data must be an array');
      }
      
      // Create the model from topology
      let modelTopology = modelData.model.modelTopology;
      if (typeof modelTopology === 'string') {
        modelTopology = JSON.parse(modelTopology);
      }
      
      console.log('Creating model from topology...');
      AppState.model = await tf.models.modelFromJSON(modelTopology);
      
      // Process weights
      const weightSpecs = modelData.model.weightsManifest[0].weights;
      const weightData = modelData.model.weightData;
      
      // Calculate and verify total expected values
      const totalExpectedValues = weightSpecs.reduce((total, spec) => {
        const size = spec.shape.reduce((a, b) => a * b, 1);
        return total + size;
      }, 0);
      
      console.log(`Total expected weight values: ${totalExpectedValues}, actual: ${weightData.length}`);
      
      if (weightData.length !== totalExpectedValues) {
        throw new Error(`Weight data mismatch: expected ${totalExpectedValues} values but got ${weightData.length}`);
      }
      
      // Create tensors from weight data
      let offset = 0;
      for (const spec of weightSpecs) {
        const size = spec.shape.reduce((a, b) => a * b, 1);
        console.log(`Creating tensor: shape=[${spec.shape}], size=${size}, dtype=${spec.dtype}`);
        
        const values = weightData.slice(offset, offset + size);
        const tensor = tf.tensor(Array.from(values), spec.shape, spec.dtype);
        weights.push(tensor);
        offset += size;
      }
      
      console.log('Setting model weights...');
      await AppState.model.setWeights(weights);
      AppState.modelMetadata = modelData.metadata;
      UI.updateModelStatus(true);
      UI.showAlert('Model loaded successfully from file!');
    } catch (error) {
      console.error('Error loading model from file:', error);
      ErrorHandler.show('Failed to load model from file', error);
      if (AppState.model) {
        AppState.model.dispose();
        AppState.model = null;
      }
      UI.updateModelStatus(false);
    } finally {
      // Clean up tensors
      weights.forEach(w => w.dispose());
    }
  }
};

async function initializeApp() {
  try {
    console.log('=== Initializing Application ===');
    if (AppState.appInitialized) {
      console.log('App already initialized');
      return;
    }
    if (typeof tf === 'undefined') {
      throw new Error('TensorFlow.js not loaded');
    }
    console.log('TensorFlow.js version:', tf.version.tfjs);
    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve);
      });
    }
    console.log('Setting up event listeners...');
    const uploadBtn = document.getElementById('uploadBtn');
    if (uploadBtn) uploadBtn.addEventListener('click', Handlers.handleFileUpload);
    const confirmMappingBtn = document.getElementById('confirmMappingBtn');
    if (confirmMappingBtn) confirmMappingBtn.addEventListener('click', Handlers.handleMappingConfirmation);
    const trainModelBtn = document.getElementById('trainModelBtn');
    if (trainModelBtn) trainModelBtn.addEventListener('click', Handlers.handleTrainModel);
    const predictBtn = document.getElementById('predictBtn');
    if (predictBtn) predictBtn.addEventListener('click', Handlers.handlePredict);
    const deleteModelBtn = document.getElementById('deleteModelBtn');
    if (deleteModelBtn) deleteModelBtn.addEventListener('click', Handlers.handleDeleteModel);
    const addModelBtn = document.getElementById('addModelBtn');
    // Fix: use arrow function to preserve context
    if (addModelBtn) addModelBtn.addEventListener('click', () => ModelLoader.loadFromFile());
    const searchInput = document.getElementById('transactionSearchInput');
    if (searchInput) searchInput.addEventListener('input', Handlers.handleTransactionSearch);
    const bulkEditBtn = document.getElementById('bulkEditAccountBtn');
    if (bulkEditBtn) bulkEditBtn.addEventListener('click', Handlers.handleBulkEditAccount);
    const selectAllBtn = document.getElementById('selectAllBtn');
    if (selectAllBtn) selectAllBtn.addEventListener('click', Handlers.handleSelectAllTransactions);
    const saveCurrentCsvBtn = document.getElementById('saveCurrentCsvBtn');
    if (saveCurrentCsvBtn) saveCurrentCsvBtn.addEventListener('click', () => CSVManagement.saveCurrentCsv());
    
    Sidebar.init();
    Sidebar.initGraphToggle();
    
    if (window.electronAPI && window.electronAPI.onAppClosing) {
      window.electronAPI.onAppClosing(() => {
        console.log('App closing - autosaving...');
        CSVManagement.autosave();
      });
    }
    
    await ModelLoader.loadExistingModel();
    if (window.electronAPI) {
      try {
        const savedData = await Utils.safeInvoke('load-user-csv');
        if (savedData && (Array.isArray(savedData) || savedData.normalizedData)) {
          if (Array.isArray(savedData)) {
            // Handle legacy format
            AppState.normalizedData = savedData;
            AppState.accountNames = {};
            savedData.forEach((tx, index) => {
              AppState.accountNames[index] = tx.account || 'Default Account';
            });
          } else {
            // Handle new format with raw data
            AppState.normalizedData = savedData.normalizedData || [];
            AppState.accountNames = savedData.accountNames || {};
            AppState.rawCsvData = savedData.rawCsvData || [];
            AppState.columnMapping = savedData.columnMapping || null;
          }
          console.log(`Loaded ${AppState.normalizedData.length} saved transactions`);
          
          // Show column mapping if we have raw data
          if (AppState.rawCsvData && AppState.rawCsvData.length > 0 && AppState.columnMapping) {
            const headers = Object.keys(AppState.rawCsvData[0]);
            Views.showColumnMappingUI(headers, AppState.rawCsvData, true);
            // Auto confirm the mapping
            await Handlers.handleMappingConfirmation();
          } else if (AppState.rawCsvData && AppState.rawCsvData.length > 0) {
            const headers = Object.keys(AppState.rawCsvData[0]);
            Views.showColumnMappingUI(headers, AppState.rawCsvData);
          }
        }
      } catch (e) {
        console.warn('No saved transaction data:', e);
      }
    }
    Views.switchView('dashboard');
    AppState.appInitialized = true;
    console.log('=== Application Initialized ===');
  } catch (error) {
    ErrorHandler.show('Failed to initialize application', error);
  }
}

// On app load, hide mapping UI
window.addEventListener('DOMContentLoaded', () => {
  const mappingContainer = document.getElementById('columnMappingContainer');
  const confirmBtn = document.getElementById('confirmMappingBtn');
  if (mappingContainer) mappingContainer.style.display = 'none';
  if (confirmBtn) confirmBtn.style.display = 'none';
});

window.Handlers = Handlers;
window.editAccount = Handlers.editAccount;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}

window.addEventListener('load', () => {
  if (!AppState.appInitialized) {
    console.log('Backup initialization triggered');
    initializeApp();
  }
});

window.AppState = AppState;
window.Utils = Utils;
window.ML = ML;
window.Views = Views;
window.CSVManagement = CSVManagement;

console.log('=== RENDERER SCRIPT LOADED ===');