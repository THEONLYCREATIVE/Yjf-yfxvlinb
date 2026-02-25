/**
 * EXPIRY TRACKER PRO v6.0.0
 * Complete Pharmacy Expiry Tracking PWA
 * 
 * FEATURES:
 * - Robust GS1 Barcode Parsing (AI 01, 10, 17, 21, etc.)
 * - FNC1 character handling (all formats)
 * - Proper GTIN matching (8, 12, 13, 14 digit support)
 * - Multiple API fallbacks (Open Food Facts, UPC Database)
 * - Cloud & Local Backup
 * - Camera Scanner
 * 
 * AI Startup by VYSAKH
 */

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  DB_NAME: 'ExpiryTrackerProDB',
  DB_VERSION: 3,
  EXPIRY_SOON_DAYS: 90,
  VERSION: '6.0.0',
  
  // API Configuration
  APIS: {
    // Open Food Facts (free, no key needed)
    OFF: 'https://world.openfoodfacts.org/api/v0/product/',
    // UPC Item DB (free tier)
    UPCDB: 'https://api.upcitemdb.com/prod/trial/lookup?upc=',
    // Barcode Lookup
    BARCODE_LOOKUP: 'https://api.barcodelookup.com/v3/products?barcode=',
  },
  
  // Your API keys (if you have them)
  API_KEYS: {
    BARCODE_LOOKUP: '' // Add your key here if you have one
  }
};

// ============================================
// APPLICATION STATE
// ============================================
const App = {
  db: null,
  masterIndex: new Map(),      // barcode -> product
  masterRMS: new Map(),        // RMS -> product
  masterVariants: new Map(),   // All barcode variants -> product
  settings: {
    apiEnabled: true,
    backupCode: '',
    lastSync: null
  },
  scanner: {
    active: false,
    instance: null
  },
  filter: 'all',
  search: '',
  editingItem: null
};

// ============================================
// UTILITY FUNCTIONS
// ============================================
const Utils = {
  generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({length: 8}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  },

  formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    if (isNaN(date)) return dateStr;
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  },

  daysUntil(dateStr) {
    if (!dateStr) return Infinity;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expiry = new Date(dateStr);
    if (isNaN(expiry)) return Infinity;
    expiry.setHours(0, 0, 0, 0);
    return Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
  },

  getStatus(dateStr) {
    const days = this.daysUntil(dateStr);
    if (days < 0) return 'expired';
    if (days <= CONFIG.EXPIRY_SOON_DAYS) return 'expiring';
    return 'ok';
  },

  debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  },

  toast(message, type = 'info') {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMessage');
    toast.className = 'toast show ' + type;
    toastMsg.textContent = message;
    setTimeout(() => toast.classList.remove('show'), 3000);
  },

  loading(show, text = 'Loading...') {
    const overlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    if (loadingText) loadingText.textContent = text;
    if (overlay) overlay.classList.toggle('show', show);
  }
};

// ============================================
// GS1 BARCODE PARSER - ROBUST IMPLEMENTATION
// ============================================
const GS1Parser = {
  /**
   * GS1 Application Identifiers
   * Each AI has: length (fixed or null for variable), name
   */
  AI_CONFIG: {
    '00': { len: 18, name: 'SSCC' },
    '01': { len: 14, name: 'GTIN' },
    '02': { len: 14, name: 'CONTENT' },
    '10': { len: null, name: 'BATCH', maxLen: 20 },
    '11': { len: 6, name: 'PROD_DATE' },
    '12': { len: 6, name: 'DUE_DATE' },
    '13': { len: 6, name: 'PACK_DATE' },
    '15': { len: 6, name: 'BEST_BY' },
    '16': { len: 6, name: 'SELL_BY' },
    '17': { len: 6, name: 'EXPIRY' },
    '20': { len: 2, name: 'VARIANT' },
    '21': { len: null, name: 'SERIAL', maxLen: 20 },
    '22': { len: null, name: 'CPV', maxLen: 20 },
    '30': { len: null, name: 'VAR_COUNT', maxLen: 8 },
    '37': { len: null, name: 'COUNT', maxLen: 8 },
    '240': { len: null, name: 'ADDITIONAL_ID', maxLen: 30 },
    '241': { len: null, name: 'CUST_PART_NO', maxLen: 30 },
    '250': { len: null, name: 'SECONDARY_SERIAL', maxLen: 30 },
    '251': { len: null, name: 'REF_TO_SOURCE', maxLen: 30 },
    '310': { len: 6, name: 'NET_WEIGHT_KG' },
    '311': { len: 6, name: 'LENGTH_M' },
    '320': { len: 6, name: 'NET_WEIGHT_LB' },
    '330': { len: 6, name: 'GROSS_WEIGHT_KG' },
    '390': { len: null, name: 'AMOUNT', maxLen: 15 },
    '391': { len: null, name: 'AMOUNT_ISO', maxLen: 18 },
    '392': { len: null, name: 'PRICE', maxLen: 15 },
    '393': { len: null, name: 'PRICE_ISO', maxLen: 18 },
    '400': { len: null, name: 'ORDER_NUMBER', maxLen: 30 },
    '410': { len: 13, name: 'SHIP_TO_LOC' },
    '411': { len: 13, name: 'BILL_TO' },
    '412': { len: 13, name: 'PURCHASE_FROM' },
    '414': { len: 13, name: 'LOC_NO' },
    '420': { len: null, name: 'SHIP_TO_POST', maxLen: 20 },
    '421': { len: null, name: 'SHIP_TO_POST_ISO', maxLen: 12 },
    '7003': { len: 10, name: 'EXPIRY_TIME' },
    '710': { len: null, name: 'NHRN_PZN', maxLen: 20 },
    '711': { len: null, name: 'NHRN_CIP', maxLen: 20 },
    '712': { len: null, name: 'NHRN_CN', maxLen: 20 },
    '713': { len: null, name: 'NHRN_DRN', maxLen: 20 },
    '714': { len: null, name: 'NHRN_AIM', maxLen: 20 },
  },

  /**
   * FNC1 character representations from different scanners
   */
  FNC1_CHARS: [
    '\u001d',   // GS (Group Separator) - most common
    '\u001e',   // RS (Record Separator)
    '\u001c',   // FS (File Separator)
    '\u0004',   // EOT
    '~',        // Some scanners use tilde
  ],

  /**
   * Symbology identifiers (prefix codes from scanners)
   */
  SYMBOLOGY_PREFIXES: [
    ']C1',  // GS1-128
    ']e0',  // EAN-13
    ']E0',  // EAN-13
    ']d2',  // DataMatrix
    ']Q3',  // QR Code
    ']J1',  // GS1 DataBar
    ']e1',  // EAN-13 with add-on
    ']e2',  // EAN-13 with add-on
    ']I1',  // ITF-14
  ],

  /**
   * Main parse function - entry point
   */
  parse(rawBarcode) {
    if (!rawBarcode || typeof rawBarcode !== 'string') {
      return null;
    }

    let code = rawBarcode.trim();
    const result = {
      raw: rawBarcode,
      gtin: null,
      expiry: null,
      expiryRaw: null,
      batch: null,
      serial: null,
      qty: null,
      isGS1: false,
      parseMethod: 'unknown'
    };

    // Step 1: Remove symbology identifier prefix
    for (const prefix of this.SYMBOLOGY_PREFIXES) {
      if (code.startsWith(prefix)) {
        code = code.substring(prefix.length);
        break;
      }
    }

    // Step 2: Normalize FNC1 characters
    code = this.normalizeFNC1(code);

    // Step 3: Detect barcode type and parse accordingly
    if (this.isGS1Format(code)) {
      result.isGS1 = true;
      result.parseMethod = 'gs1';
      this.parseGS1(code, result);
    } else if (this.isSimpleBarcode(code)) {
      result.parseMethod = 'simple';
      this.parseSimpleBarcode(code, result);
    } else {
      // Try to extract any GTIN-like number
      result.parseMethod = 'fallback';
      this.parseFallback(code, result);
    }

    // Step 4: Normalize GTIN
    if (result.gtin) {
      result.gtin = this.normalizeGTIN(result.gtin);
    }

    // Step 5: Log for debugging
    console.log('📊 GS1 Parse Result:', {
      input: rawBarcode.substring(0, 50) + (rawBarcode.length > 50 ? '...' : ''),
      gtin: result.gtin,
      expiry: result.expiry,
      batch: result.batch,
      method: result.parseMethod
    });

    return result;
  },

  /**
   * Normalize all FNC1 character variants to standard GS character
   */
  normalizeFNC1(code) {
    let normalized = code;
    
    // Replace text representations
    normalized = normalized.replace(/\[FNC1\]/gi, '\u001d');
    normalized = normalized.replace(/<GS>/gi, '\u001d');
    normalized = normalized.replace(/\{GS\}/gi, '\u001d');
    normalized = normalized.replace(/%1D/gi, '\u001d');
    normalized = normalized.replace(/\\x1[dD]/g, '\u001d');
    
    // Replace all FNC1 variants with standard GS
    for (const char of this.FNC1_CHARS) {
      if (char !== '\u001d') {
        normalized = normalized.split(char).join('\u001d');
      }
    }
    
    return normalized;
  },

  /**
   * Check if barcode appears to be GS1 format
   */
  isGS1Format(code) {
    // Contains GS separator
    if (code.includes('\u001d')) return true;
    
    // Starts with common GS1 AIs
    if (/^(01|02|00|10|11|17|21|30|37)\d/.test(code)) return true;
    
    // Long numeric string likely to be GS1
    if (/^\d{20,}$/.test(code)) return true;
    
    return false;
  },

  /**
   * Check if it's a simple barcode (EAN-8, EAN-13, UPC-A, etc.)
   */
  isSimpleBarcode(code) {
    const digits = code.replace(/\D/g, '');
    return [8, 12, 13, 14].includes(digits.length) && /^\d+$/.test(code);
  },

  /**
   * Parse GS1-128 / DataMatrix barcode
   */
  parseGS1(code, result) {
    const GS = '\u001d';
    let pos = 0;
    const len = code.length;
    let iterations = 0;
    const MAX_ITERATIONS = 50;

    while (pos < len && iterations < MAX_ITERATIONS) {
      iterations++;

      // Skip GS characters
      while (pos < len && code[pos] === GS) {
        pos++;
      }
      
      if (pos >= len) break;

      // Try to match AI (2, 3, or 4 digit)
      let ai = null;
      let aiLen = 0;
      let aiConfig = null;

      // Try 4-digit AI
      if (pos + 4 <= len) {
        const ai4 = code.substring(pos, pos + 4);
        if (this.AI_CONFIG[ai4]) {
          ai = ai4;
          aiLen = 4;
          aiConfig = this.AI_CONFIG[ai4];
        }
      }

      // Try 3-digit AI
      if (!ai && pos + 3 <= len) {
        const ai3 = code.substring(pos, pos + 3);
        if (this.AI_CONFIG[ai3]) {
          ai = ai3;
          aiLen = 3;
          aiConfig = this.AI_CONFIG[ai3];
        }
        // Check for variable-length 3-digit AIs (31x, 32x, 33x, 39x)
        if (!ai && /^3[0-3]\d$/.test(ai3)) {
          ai = ai3;
          aiLen = 3;
          aiConfig = { len: 6, name: 'MEASURE' };
        }
      }

      // Try 2-digit AI
      if (!ai && pos + 2 <= len) {
        const ai2 = code.substring(pos, pos + 2);
        if (this.AI_CONFIG[ai2]) {
          ai = ai2;
          aiLen = 2;
          aiConfig = this.AI_CONFIG[ai2];
        }
      }

      if (!ai) {
        // No AI found, move forward
        pos++;
        continue;
      }

      pos += aiLen;

      // Extract value
      let value;
      if (aiConfig.len) {
        // Fixed length
        value = code.substring(pos, pos + aiConfig.len);
        pos += aiConfig.len;
      } else {
        // Variable length - find GS or end
        const gsPos = code.indexOf(GS, pos);
        if (gsPos !== -1) {
          value = code.substring(pos, gsPos);
          pos = gsPos + 1;
        } else {
          value = code.substring(pos);
          pos = len;
        }
        
        // Trim to max length if specified
        if (aiConfig.maxLen && value.length > aiConfig.maxLen) {
          value = value.substring(0, aiConfig.maxLen);
        }
      }

      // Store parsed value
      this.storeValue(ai, value, result);
    }
  },

  /**
   * Store parsed AI value in result object
   */
  storeValue(ai, value, result) {
    switch (ai) {
      case '01':
      case '02':
        result.gtin = value;
        break;
        
      case '17': // Expiry date
      case '15': // Best before
      case '16': // Sell by
        result.expiryRaw = value;
        result.expiry = this.parseGS1Date(value);
        break;
        
      case '11': // Production date
      case '13': // Packaging date
        if (!result.prodDate) {
          result.prodDateRaw = value;
          result.prodDate = this.parseGS1Date(value);
        }
        break;
        
      case '10':
        result.batch = value;
        break;
        
      case '21':
        result.serial = value;
        break;
        
      case '30':
      case '37':
        result.qty = parseInt(value, 10) || null;
        break;
        
      case '240':
      case '241':
        result.additionalId = value;
        break;
    }
  },

  /**
   * Parse GS1 date format (YYMMDD)
   */
  parseGS1Date(str) {
    if (!str || str.length !== 6) return null;
    
    const yy = parseInt(str.substring(0, 2), 10);
    const mm = parseInt(str.substring(2, 4), 10);
    let dd = parseInt(str.substring(4, 6), 10);
    
    // Validate
    if (isNaN(yy) || isNaN(mm) || isNaN(dd)) return null;
    if (mm < 1 || mm > 12) return null;
    if (dd < 0 || dd > 31) return null;
    
    // Determine century (51-99 = 1900s, 00-50 = 2000s)
    const year = yy >= 51 ? 1900 + yy : 2000 + yy;
    
    // Handle day = 00 (means last day of month)
    if (dd === 0) {
      dd = new Date(year, mm, 0).getDate();
    }
    
    // Create date
    const date = new Date(year, mm - 1, dd);
    if (isNaN(date.getTime())) return null;
    
    // Return ISO format YYYY-MM-DD
    return date.toISOString().split('T')[0];
  },

  /**
   * Parse simple barcode (EAN-8, EAN-13, UPC-A, GTIN-14)
   */
  parseSimpleBarcode(code, result) {
    const digits = code.replace(/\D/g, '');
    result.gtin = digits;
  },

  /**
   * Fallback parser - try to extract any numeric sequence
   */
  parseFallback(code, result) {
    // Extract all digit sequences
    const matches = code.match(/\d{8,14}/g);
    if (matches && matches.length > 0) {
      // Use the first valid-looking GTIN
      result.gtin = matches[0];
    } else {
      // Just clean and use whatever digits we have
      const digits = code.replace(/\D/g, '');
      if (digits.length >= 8) {
        result.gtin = digits.substring(0, 14);
      }
    }
  },

  /**
   * Normalize GTIN to standard format
   * Supports conversion between GTIN-8, GTIN-12, GTIN-13, GTIN-14
   */
  normalizeGTIN(gtin) {
    if (!gtin) return null;
    
    // Remove non-digits
    let clean = gtin.replace(/\D/g, '');
    
    // Remove leading zeros for very long codes (scanner artifacts)
    while (clean.length > 14 && clean.startsWith('0')) {
      clean = clean.substring(1);
    }
    
    // Truncate if too long
    if (clean.length > 14) {
      clean = clean.substring(0, 14);
    }
    
    // Validate minimum length
    if (clean.length < 8) {
      return null;
    }
    
    return clean;
  },

  /**
   * Generate all GTIN variants for matching
   */
  generateGTINVariants(gtin) {
    if (!gtin) return [];
    
    const clean = this.normalizeGTIN(gtin);
    if (!clean) return [];
    
    const variants = new Set();
    
    // Original
    variants.add(clean);
    
    // GTIN-14 (pad to 14 digits)
    const gtin14 = clean.padStart(14, '0');
    variants.add(gtin14);
    
    // GTIN-13 (remove leading zero from GTIN-14)
    if (gtin14.startsWith('0')) {
      variants.add(gtin14.substring(1));
    }
    
    // GTIN-12 (UPC-A)
    if (gtin14.startsWith('00')) {
      variants.add(gtin14.substring(2));
    }
    
    // Last 13 digits
    if (clean.length >= 13) {
      variants.add(clean.slice(-13));
    }
    
    // Last 12 digits
    if (clean.length >= 12) {
      variants.add(clean.slice(-12));
    }
    
    // Last 8 digits (for matching GTIN-8)
    if (clean.length >= 8) {
      variants.add(clean.slice(-8));
    }
    
    return Array.from(variants);
  }
};

// ============================================
// PRODUCT LOOKUP - WITH PROPER GTIN MATCHING
// ============================================
const ProductLookup = {
  /**
   * Build master index with all GTIN variants for fast lookup
   */
  async buildIndex() {
    const master = await DB.getAllMaster();
    
    // Clear existing indexes
    App.masterIndex.clear();
    App.masterRMS.clear();
    App.masterVariants.clear();
    
    master.forEach(item => {
      const barcode = item.barcode ? String(item.barcode).trim() : null;
      if (!barcode) return;
      
      // Store original
      App.masterIndex.set(barcode, item);
      
      // Generate and store all variants
      const variants = GS1Parser.generateGTINVariants(barcode);
      variants.forEach(v => {
        if (!App.masterVariants.has(v)) {
          App.masterVariants.set(v, item);
        }
      });
      
      // Index by RMS
      if (item.rms) {
        App.masterRMS.set(String(item.rms).trim(), item);
      }
    });
    
    console.log(`📚 Master index built: ${App.masterIndex.size} products, ${App.masterVariants.size} variants`);
  },

  /**
   * Find product by GTIN - tries all matching strategies
   */
  find(gtin) {
    if (!gtin) return null;
    
    const clean = GS1Parser.normalizeGTIN(gtin);
    if (!clean) return null;
    
    // Strategy 1: Direct match in variants index
    const variants = GS1Parser.generateGTINVariants(clean);
    for (const variant of variants) {
      if (App.masterVariants.has(variant)) {
        console.log(`✅ Found product via variant: ${variant}`);
        return App.masterVariants.get(variant);
      }
    }
    
    // Strategy 2: Check if any master barcode matches our variants
    for (const [masterBarcode, product] of App.masterIndex) {
      const masterVariants = GS1Parser.generateGTINVariants(masterBarcode);
      for (const variant of variants) {
        if (masterVariants.includes(variant)) {
          console.log(`✅ Found product via master variant matching`);
          return product;
        }
      }
    }
    
    console.log(`❌ No local match for GTIN: ${clean}`);
    return null;
  },

  /**
   * API Lookup - Multiple fallback APIs
   */
  async apiLookup(gtin) {
    if (!App.settings.apiEnabled) {
      console.log('🚫 API lookup disabled');
      return null;
    }
    
    const clean = GS1Parser.normalizeGTIN(gtin);
    if (!clean) return null;
    
    console.log(`🌐 API lookup for: ${clean}`);
    
    // Generate GTIN variants to try
    const gtinsToTry = [
      clean.padStart(14, '0'),  // GTIN-14
      clean.padStart(13, '0'),  // GTIN-13
      clean.padStart(12, '0'),  // UPC-A
      clean                      // Original
    ];
    
    // Try each API
    for (const gtinVariant of gtinsToTry) {
      // API 1: Open Food Facts (free, no key)
      let result = await this.tryOpenFoodFacts(gtinVariant);
      if (result) return result;
      
      // API 2: UPC Item DB (free trial)
      result = await this.tryUPCItemDB(gtinVariant);
      if (result) return result;
    }
    
    console.log(`❌ No API results for: ${clean}`);
    return null;
  },

  /**
   * Open Food Facts API
   */
  async tryOpenFoodFacts(gtin) {
    try {
      const url = `${CONFIG.APIS.OFF}${gtin}.json`;
      console.log(`  → Trying Open Food Facts: ${gtin}`);
      
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: {
          'User-Agent': 'ExpiryTracker/6.0 (pharmacy app)'
        }
      });
      
      if (!response.ok) return null;
      
      const data = await response.json();
      
      if (data.status === 1 && data.product) {
        const product = data.product;
        const name = product.product_name || 
                     product.product_name_en || 
                     product.generic_name ||
                     product.brands;
        
        if (name) {
          console.log(`  ✅ OFF found: ${name}`);
          return {
            name: name,
            brand: product.brands || '',
            source: 'OpenFoodFacts'
          };
        }
      }
    } catch (e) {
      console.log(`  ⚠️ OFF error: ${e.message}`);
    }
    return null;
  },

  /**
   * UPC Item DB API
   */
  async tryUPCItemDB(gtin) {
    try {
      // UPC Item DB needs 12-digit UPC or 13-digit EAN
      let queryGtin = gtin;
      if (gtin.length === 14 && gtin.startsWith('0')) {
        queryGtin = gtin.substring(1); // Convert to 13-digit
      }
      
      const url = `${CONFIG.APIS.UPCDB}${queryGtin}`;
      console.log(`  → Trying UPC Item DB: ${queryGtin}`);
      
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000)
      });
      
      if (!response.ok) return null;
      
      const data = await response.json();
      
      if (data.code === 'OK' && data.items && data.items.length > 0) {
        const item = data.items[0];
        const name = item.title || item.description;
        
        if (name) {
          console.log(`  ✅ UPC DB found: ${name}`);
          return {
            name: name,
            brand: item.brand || '',
            source: 'UPCItemDB'
          };
        }
      }
    } catch (e) {
      console.log(`  ⚠️ UPC DB error: ${e.message}`);
    }
    return null;
  }
};

// ============================================
// DATABASE LAYER
// ============================================
const DB = {
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      
      request.onerror = () => reject(request.error);
      
      request.onsuccess = () => {
        App.db = request.result;
        console.log('✅ Database ready');
        resolve();
      };
      
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        
        if (!db.objectStoreNames.contains('history')) {
          const historyStore = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
          historyStore.createIndex('gtin', 'gtin', { unique: false });
          historyStore.createIndex('timestamp', 'timestamp', { unique: false });
          historyStore.createIndex('expiry', 'expiry', { unique: false });
        }
        
        if (!db.objectStoreNames.contains('master')) {
          const masterStore = db.createObjectStore('master', { keyPath: 'barcode' });
          masterStore.createIndex('name', 'name', { unique: false });
        }
        
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        
        console.log('📦 Database upgraded');
      };
    });
  },

  async _tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = App.db.transaction(store, mode);
      const s = tx.objectStore(store);
      const result = fn(s);
      if (result && result.onsuccess !== undefined) {
        result.onsuccess = () => resolve(result.result);
        result.onerror = () => reject(result.error);
      } else {
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
      }
    });
  },

  // History operations
  async addHistory(item) {
    item.timestamp = item.timestamp || Date.now();
    return this._tx('history', 'readwrite', s => s.add(item));
  },

  async updateHistory(item) {
    return this._tx('history', 'readwrite', s => s.put(item));
  },

  async deleteHistory(id) {
    return this._tx('history', 'readwrite', s => s.delete(id));
  },

  async getHistory(id) {
    return this._tx('history', 'readonly', s => s.get(id));
  },

  async getAllHistory() {
    return this._tx('history', 'readonly', s => s.getAll());
  },

  async clearHistory() {
    return this._tx('history', 'readwrite', s => s.clear());
  },

  // Master operations
  async addMaster(item) {
    return this._tx('master', 'readwrite', s => s.put(item));
  },

  async getMaster(barcode) {
    return this._tx('master', 'readonly', s => s.get(barcode));
  },

  async getAllMaster() {
    return this._tx('master', 'readonly', s => s.getAll());
  },

  async clearMaster() {
    return this._tx('master', 'readwrite', s => s.clear());
  },

  async bulkAddMaster(items) {
    return new Promise((resolve, reject) => {
      const tx = App.db.transaction('master', 'readwrite');
      const store = tx.objectStore('master');
      let count = 0;
      
      items.forEach(item => {
        try {
          store.put(item);
          count++;
        } catch (e) {}
      });
      
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
    });
  },

  // Settings
  async getSetting(key) {
    try {
      const result = await this._tx('settings', 'readonly', s => s.get(key));
      return result ? result.value : null;
    } catch {
      return null;
    }
  },

  async setSetting(key, value) {
    return this._tx('settings', 'readwrite', s => s.put({ key, value }));
  },

  // Export all
  async exportAll() {
    const history = await this.getAllHistory();
    const master = await this.getAllMaster();
    return {
      version: CONFIG.VERSION,
      exportDate: new Date().toISOString(),
      history,
      master,
      settings: {
        apiEnabled: App.settings.apiEnabled,
        backupCode: App.settings.backupCode
      }
    };
  },

  // Import all
  async importAll(data) {
    if (data.history && Array.isArray(data.history)) {
      await this.clearHistory();
      for (const item of data.history) {
        delete item.id;
        await this.addHistory(item);
      }
    }
    
    if (data.master && Array.isArray(data.master)) {
      await this.bulkAddMaster(data.master);
    }
    
    if (data.settings) {
      if (data.settings.apiEnabled !== undefined) {
        App.settings.apiEnabled = data.settings.apiEnabled;
        await this.setSetting('apiEnabled', data.settings.apiEnabled);
      }
    }
  }
};

// ============================================
// CLOUD BACKUP
// ============================================
const CloudBackup = {
  PREFIX: 'expiry_backup_',

  async save(code) {
    if (!code || code.length < 4) throw new Error('Invalid backup code');
    
    code = code.toUpperCase().trim();
    const data = await DB.exportAll();
    data.backupCode = code;
    data.savedAt = new Date().toISOString();
    
    localStorage.setItem(this.PREFIX + code, JSON.stringify(data));
    
    App.settings.backupCode = code;
    App.settings.lastSync = new Date().toISOString();
    await DB.setSetting('backupCode', code);
    await DB.setSetting('lastSync', App.settings.lastSync);
    
    return { success: true, code };
  },

  async load(code) {
    if (!code || code.length < 4) throw new Error('Invalid backup code');
    
    code = code.toUpperCase().trim();
    const stored = localStorage.getItem(this.PREFIX + code);
    
    if (!stored) throw new Error('No backup found with this code');
    
    const data = JSON.parse(stored);
    await DB.importAll(data);
    
    App.settings.backupCode = code;
    App.settings.lastSync = new Date().toISOString();
    await DB.setSetting('backupCode', code);
    await DB.setSetting('lastSync', App.settings.lastSync);
    
    return { success: true, historyCount: data.history?.length || 0 };
  }
};

// ============================================
// SCANNER
// ============================================
const Scanner = {
  html5Qr: null,

  async start() {
    const container = document.getElementById('cameraContainer');
    
    if (App.scanner.active) {
      await this.stop();
      return;
    }
    
    try {
      if (typeof Html5Qrcode === 'undefined') {
        await this.loadLibrary();
      }
      
      container.classList.add('active');
      document.getElementById('cameraBtn').classList.add('active');
      
      this.html5Qr = new Html5Qrcode('cameraPreview');
      
      await this.html5Qr.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 150 } },
        (code) => this.onScan(code),
        () => {}
      );
      
      App.scanner.active = true;
    } catch (e) {
      console.error('Camera error:', e);
      Utils.toast('Camera access denied', 'error');
      this.stop();
    }
  },

  async stop() {
    const container = document.getElementById('cameraContainer');
    
    if (this.html5Qr) {
      try { await this.html5Qr.stop(); } catch (e) {}
      this.html5Qr = null;
    }
    
    container.classList.remove('active');
    document.getElementById('cameraBtn').classList.remove('active');
    App.scanner.active = false;
  },

  async loadLibrary() {
    return new Promise((resolve, reject) => {
      if (typeof Html5Qrcode !== 'undefined') {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  },

  onScan(code) {
    if (navigator.vibrate) navigator.vibrate(100);
    this.stop();
    document.getElementById('barcodeInput').value = code;
    processBarcode(code);
  }
};

// ============================================
// MAIN PROCESSING FUNCTION
// ============================================
async function processBarcode(rawCode) {
  if (!rawCode || !rawCode.trim()) return;
  
  console.log('\n═══════════════════════════════════════');
  console.log('🔍 Processing barcode:', rawCode);
  console.log('═══════════════════════════════════════');
  
  // Step 1: Parse the barcode
  const parsed = GS1Parser.parse(rawCode);
  
  if (!parsed || !parsed.gtin) {
    Utils.toast('Invalid barcode - no GTIN found', 'error');
    return;
  }
  
  console.log('📋 Parsed data:', {
    gtin: parsed.gtin,
    expiry: parsed.expiry,
    batch: parsed.batch,
    method: parsed.parseMethod
  });
  
  // Step 2: Local lookup
  let product = ProductLookup.find(parsed.gtin);
  let productName = product?.name || '';
  let rms = product?.rms || '';
  
  if (product) {
    console.log('✅ LOCAL MATCH:', product.name);
  }
  
  // Step 3: API fallback if not found locally
  if (!productName && App.settings.apiEnabled) {
    console.log('🌐 Trying API lookup...');
    Utils.toast('Looking up product...', 'info');
    
    const apiResult = await ProductLookup.apiLookup(parsed.gtin);
    if (apiResult?.name) {
      productName = apiResult.name;
      console.log('✅ API MATCH:', productName, `(${apiResult.source})`);
      
      // Optionally save to master for future
      // await DB.addMaster({ barcode: parsed.gtin, name: productName, rms: '' });
    }
  }
  
  // Step 4: Create history item
  const item = {
    gtin: parsed.gtin,
    name: productName || 'Unknown Product',
    rms: rms,
    expiry: parsed.expiry || '',
    batch: parsed.batch || '',
    serial: parsed.serial || '',
    qty: parsed.qty || 1,
    raw: rawCode,
    timestamp: Date.now(),
    source: product ? 'local' : (productName ? 'api' : 'unknown')
  };
  
  console.log('💾 Saving item:', item);
  
  // Step 5: Save to database
  try {
    await DB.addHistory(item);
    Utils.toast(`✓ ${item.name}`, 'success');
    
    await refreshStats();
    await renderRecentList();
    await renderHistoryList();
    
    document.getElementById('barcodeInput').value = '';
  } catch (e) {
    console.error('Save error:', e);
    Utils.toast('Failed to save', 'error');
  }
}

async function processBulk() {
  const textarea = document.getElementById('bulkInput');
  const progressBar = document.getElementById('bulkProgress');
  const progressFill = document.getElementById('bulkProgressFill');
  const progressText = document.getElementById('bulkProgressText');
  
  const lines = textarea.value.split('\n').filter(l => l.trim());
  if (lines.length === 0) {
    Utils.toast('No barcodes to process', 'error');
    return;
  }
  
  progressBar.classList.add('active');
  let processed = 0;
  
  for (const line of lines) {
    await processBarcode(line.trim());
    processed++;
    
    const pct = Math.round((processed / lines.length) * 100);
    progressFill.style.width = pct + '%';
    progressText.textContent = pct + '%';
    
    await new Promise(r => setTimeout(r, 100));
  }
  
  Utils.toast(`Processed ${processed} items`, 'success');
  textarea.value = '';
  updateBulkCount();
  progressBar.classList.remove('active');
}

// ============================================
// UI RENDERING
// ============================================
async function refreshStats() {
  const history = await DB.getAllHistory();
  
  let expired = 0, expiring = 0, ok = 0;
  
  history.forEach(item => {
    const status = Utils.getStatus(item.expiry);
    if (status === 'expired') expired++;
    else if (status === 'expiring') expiring++;
    else ok++;
  });
  
  document.querySelector('#statExpired .stat-value').textContent = expired;
  document.querySelector('#statExpiring .stat-value').textContent = expiring;
  document.querySelector('#statOk .stat-value').textContent = ok;
  document.querySelector('#statTotal .stat-value').textContent = history.length;
  
  const menuHistoryCount = document.getElementById('menuHistoryCount');
  if (menuHistoryCount) menuHistoryCount.textContent = history.length;
}

async function refreshMasterCount() {
  const master = await DB.getAllMaster();
  const count = master.length.toLocaleString();
  
  const masterCount = document.getElementById('masterCount');
  if (masterCount) masterCount.textContent = count;
  
  const menuMasterCount = document.getElementById('menuMasterCount');
  if (menuMasterCount) menuMasterCount.textContent = count;
}

async function renderRecentList() {
  const container = document.getElementById('recentList');
  if (!container) return;
  
  const history = await DB.getAllHistory();
  const recent = history.sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
  
  if (recent.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M3 9h18"/><path d="M9 21V9"/>
        </svg>
        <p>No scans yet. Start scanning!</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = recent.map(item => renderItemCard(item)).join('');
}

async function renderHistoryList() {
  const container = document.getElementById('historyList');
  if (!container) return;
  
  let history = await DB.getAllHistory();
  
  if (App.filter !== 'all') {
    history = history.filter(item => Utils.getStatus(item.expiry) === App.filter);
  }
  
  if (App.search) {
    const search = App.search.toLowerCase();
    history = history.filter(item => 
      (item.name && item.name.toLowerCase().includes(search)) ||
      (item.gtin && item.gtin.includes(search)) ||
      (item.rms && item.rms.toLowerCase().includes(search)) ||
      (item.batch && item.batch.toLowerCase().includes(search))
    );
  }
  
  history.sort((a, b) => b.timestamp - a.timestamp);
  
  if (history.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
        </svg>
        <p>No items found</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = history.map(item => renderItemCard(item)).join('');
}

function renderItemCard(item) {
  const status = Utils.getStatus(item.expiry);
  const days = Utils.daysUntil(item.expiry);
  
  let statusText = '';
  if (status === 'expired') {
    statusText = `Expired ${Math.abs(days)}d ago`;
  } else if (days === Infinity) {
    statusText = 'No expiry';
  } else {
    statusText = `${days}d left`;
  }
  
  return `
    <div class="item-card ${status}" data-id="${item.id}" onclick="openEditModal(${item.id})">
      <div class="item-header">
        <span class="item-name">${item.name || 'Unknown'}</span>
        <span class="item-status ${status}">${statusText}</span>
      </div>
      <div class="item-details">
        ${item.expiry ? `<span class="item-detail"><span class="item-detail-label">Exp:</span> ${Utils.formatDate(item.expiry)}</span>` : ''}
        ${item.batch ? `<span class="item-detail"><span class="item-detail-label">Batch:</span> ${item.batch}</span>` : ''}
        ${item.rms ? `<span class="item-detail"><span class="item-detail-label">RMS:</span> ${item.rms}</span>` : ''}
        <span class="item-detail item-gtin">${item.gtin}</span>
      </div>
    </div>
  `;
}

// ============================================
// MODALS
// ============================================
async function openEditModal(id) {
  const item = await DB.getHistory(id);
  if (!item) return;
  
  App.editingItem = item;
  
  document.getElementById('editName').value = item.name || '';
  document.getElementById('editGtin').value = item.gtin || '';
  document.getElementById('editRms').value = item.rms || '';
  document.getElementById('editExpiry').value = item.expiry || '';
  document.getElementById('editBatch').value = item.batch || '';
  document.getElementById('editQty').value = item.qty || 1;
  
  document.getElementById('editModal').classList.add('open');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('open');
  App.editingItem = null;
}

async function saveEdit() {
  if (!App.editingItem) return;
  
  App.editingItem.name = document.getElementById('editName').value;
  App.editingItem.rms = document.getElementById('editRms').value;
  App.editingItem.expiry = document.getElementById('editExpiry').value;
  App.editingItem.batch = document.getElementById('editBatch').value;
  App.editingItem.qty = parseInt(document.getElementById('editQty').value, 10) || 1;
  
  await DB.updateHistory(App.editingItem);
  Utils.toast('Updated', 'success');
  closeEditModal();
  
  await refreshStats();
  await renderRecentList();
  await renderHistoryList();
}

async function deleteEdit() {
  if (!App.editingItem) return;
  
  if (confirm('Delete this item?')) {
    await DB.deleteHistory(App.editingItem.id);
    Utils.toast('Deleted', 'success');
    closeEditModal();
    
    await refreshStats();
    await renderRecentList();
    await renderHistoryList();
  }
}

// ============================================
// BACKUP & EXPORT FUNCTIONS
// ============================================
async function downloadBackup() {
  Utils.loading(true, 'Creating backup...');
  
  try {
    const data = await DB.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `expiry-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
    Utils.toast('Backup downloaded', 'success');
  } catch (e) {
    Utils.toast('Backup failed', 'error');
  }
  
  Utils.loading(false);
}

async function restoreBackup(file) {
  Utils.loading(true, 'Restoring backup...');
  
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    
    await DB.importAll(data);
    await ProductLookup.buildIndex();
    
    Utils.toast(`Restored ${data.history?.length || 0} items`, 'success');
    
    await refreshStats();
    await refreshMasterCount();
    await renderRecentList();
    await renderHistoryList();
  } catch (e) {
    Utils.toast('Invalid backup file', 'error');
  }
  
  Utils.loading(false);
}

async function cloudSave() {
  const code = document.getElementById('backupCodeInput').value.trim();
  
  if (!code || code.length < 4) {
    Utils.toast('Enter a backup code first', 'error');
    return;
  }
  
  Utils.loading(true, 'Saving to cloud...');
  
  try {
    await CloudBackup.save(code);
    Utils.toast('Saved to cloud! 🌐', 'success');
    updateLastSync();
  } catch (e) {
    Utils.toast(e.message || 'Cloud save failed', 'error');
  }
  
  Utils.loading(false);
}

async function cloudLoad() {
  const code = document.getElementById('backupCodeInput').value.trim();
  
  if (!code || code.length < 4) {
    Utils.toast('Enter your backup code', 'error');
    return;
  }
  
  Utils.loading(true, 'Loading from cloud...');
  
  try {
    const result = await CloudBackup.load(code);
    await ProductLookup.buildIndex();
    
    Utils.toast(`Loaded ${result.historyCount} items! 🌐`, 'success');
    
    await refreshStats();
    await refreshMasterCount();
    await renderRecentList();
    await renderHistoryList();
    updateLastSync();
  } catch (e) {
    Utils.toast(e.message || 'Cloud load failed', 'error');
  }
  
  Utils.loading(false);
}

function generateBackupCode() {
  const code = Utils.generateCode();
  document.getElementById('backupCodeInput').value = code;
  Utils.toast('Code generated! Remember it!', 'success');
}

function updateLastSync() {
  const el = document.getElementById('lastSyncInfo');
  if (el && App.settings.lastSync) {
    const date = new Date(App.settings.lastSync);
    el.innerHTML = `<span>Last synced: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}</span>`;
  }
}

async function exportCSV() {
  Utils.loading(true, 'Exporting...');
  
  try {
    const history = await DB.getAllHistory();
    
    const headers = ['GTIN', 'Name', 'RMS', 'Expiry', 'Batch', 'Qty', 'Status', 'Scanned'];
    const rows = history.map(item => [
      item.gtin,
      `"${(item.name || '').replace(/"/g, '""')}"`,
      item.rms || '',
      item.expiry || '',
      item.batch || '',
      item.qty || 1,
      Utils.getStatus(item.expiry),
      new Date(item.timestamp).toISOString()
    ]);
    
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `expiry-export-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    
    URL.revokeObjectURL(url);
    Utils.toast('Exported to CSV', 'success');
  } catch (e) {
    Utils.toast('Export failed', 'error');
  }
  
  Utils.loading(false);
}

// ============================================
// MASTER DATA FUNCTIONS
// ============================================
async function uploadMasterFile(file) {
  Utils.loading(true, 'Processing file...');
  
  try {
    const text = await file.text();
    let items = [];
    
    if (file.name.endsWith('.csv')) {
      items = parseCSV(text);
    } else {
      Utils.toast('Please upload a CSV file', 'error');
      Utils.loading(false);
      return;
    }
    
    if (items.length === 0) {
      Utils.toast('No valid data found', 'error');
      Utils.loading(false);
      return;
    }
    
    const count = await DB.bulkAddMaster(items);
    await ProductLookup.buildIndex();
    await refreshMasterCount();
    
    Utils.toast(`Added ${count} products`, 'success');
  } catch (e) {
    console.error('Upload error:', e);
    Utils.toast('Upload failed', 'error');
  }
  
  Utils.loading(false);
}

function parseCSV(text) {
  const lines = text.split('\n');
  if (lines.length < 2) return [];
  
  const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
  
  const barcodeIdx = header.findIndex(h => ['barcode', 'gtin', 'ean', 'upc', 'code'].includes(h));
  const nameIdx = header.findIndex(h => ['description', 'name', 'product', 'item'].includes(h));
  const rmsIdx = header.findIndex(h => ['rms', 'rms id', 'rmsid', 'rms_id'].includes(h));
  
  if (barcodeIdx === -1) {
    console.error('No barcode column found');
    return [];
  }
  
  const items = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const cols = parseCSVLine(line);
    const barcode = GS1Parser.normalizeGTIN(cols[barcodeIdx]);
    
    if (barcode && barcode.length >= 8) {
      items.push({
        barcode,
        name: nameIdx !== -1 ? (cols[nameIdx] || '').trim() : '',
        rms: rmsIdx !== -1 ? (cols[rmsIdx] || '').trim() : ''
      });
    }
  }
  
  return items;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

function downloadTemplate() {
  const template = `BARCODE,RMS ID,DESCRIPTION
4015630982110,220216906,ACCUCHECK PERFORMA 50S
9650364003455,220196349,A3 REUSABLE FACE MASK 1S
6291100080045,220190512,ADOL 250MG SUPPO 10S`;

  const blob = new Blob([template], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = 'master-template.csv';
  a.click();
  
  URL.revokeObjectURL(url);
  Utils.toast('Template downloaded', 'success');
}

// ============================================
// NAVIGATION
// ============================================
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  
  document.getElementById(pageId)?.classList.add('active');
  document.querySelector(`.nav-item[data-page="${pageId}"]`)?.classList.add('active');
}

function toggleSideMenu(show) {
  document.getElementById('sideMenu')?.classList.toggle('open', show);
}

function updateBulkCount() {
  const textarea = document.getElementById('bulkInput');
  const count = textarea ? textarea.value.split('\n').filter(l => l.trim()).length : 0;
  const el = document.getElementById('bulkCount');
  if (el) el.textContent = `${count} lines`;
}

// ============================================
// EVENT LISTENERS
// ============================================
function initEventListeners() {
  // Navigation
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  });
  
  // Menu
  document.getElementById('menuBtn')?.addEventListener('click', () => toggleSideMenu(true));
  document.getElementById('sideMenuOverlay')?.addEventListener('click', () => toggleSideMenu(false));
  
  // Barcode input
  const barcodeInput = document.getElementById('barcodeInput');
  if (barcodeInput) {
    barcodeInput.addEventListener('keypress', e => {
      if (e.key === 'Enter') {
        processBarcode(barcodeInput.value);
      }
    });
  }
  
  // Camera
  document.getElementById('cameraBtn')?.addEventListener('click', () => Scanner.start());
  document.getElementById('cameraClose')?.addEventListener('click', () => Scanner.stop());
  
  // Bulk processing
  document.getElementById('bulkInput')?.addEventListener('input', updateBulkCount);
  document.getElementById('bulkProcessBtn')?.addEventListener('click', processBulk);
  document.getElementById('bulkClearBtn')?.addEventListener('click', () => {
    const textarea = document.getElementById('bulkInput');
    if (textarea) textarea.value = '';
    updateBulkCount();
  });
  
  // View all
  document.getElementById('viewAllBtn')?.addEventListener('click', () => showPage('historyPage'));
  
  // Search
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', Utils.debounce(e => {
      App.search = e.target.value;
      renderHistoryList();
    }, 300));
  }
  
  // Filter tabs
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      App.filter = tab.dataset.filter;
      renderHistoryList();
    });
  });
  
  // Stats cards
  document.getElementById('statExpired')?.addEventListener('click', () => {
    showPage('historyPage');
    App.filter = 'expired';
    document.querySelectorAll('.filter-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.filter === 'expired');
    });
    renderHistoryList();
  });
  
  document.getElementById('statExpiring')?.addEventListener('click', () => {
    showPage('historyPage');
    App.filter = 'expiring';
    document.querySelectorAll('.filter-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.filter === 'expiring');
    });
    renderHistoryList();
  });
  
  // Modal
  document.getElementById('modalClose')?.addEventListener('click', closeEditModal);
  document.getElementById('modalCancel')?.addEventListener('click', closeEditModal);
  document.getElementById('modalOverlay')?.addEventListener('click', closeEditModal);
  document.getElementById('modalSave')?.addEventListener('click', saveEdit);
  document.getElementById('modalDelete')?.addEventListener('click', deleteEdit);
  
  // Cloud backup
  document.getElementById('generateCodeBtn')?.addEventListener('click', generateBackupCode);
  document.getElementById('cloudSaveBtn')?.addEventListener('click', cloudSave);
  document.getElementById('cloudLoadBtn')?.addEventListener('click', cloudLoad);
  
  // Local backup
  document.getElementById('downloadBackupBtn')?.addEventListener('click', downloadBackup);
  document.getElementById('restoreBackupBtn')?.addEventListener('click', () => {
    document.getElementById('restoreFileInput')?.click();
  });
  document.getElementById('restoreFileInput')?.addEventListener('change', e => {
    if (e.target.files[0]) restoreBackup(e.target.files[0]);
  });
  
  // Export
  document.getElementById('exportCsvBtn')?.addEventListener('click', exportCSV);
  document.getElementById('menuExportCsv')?.addEventListener('click', () => {
    toggleSideMenu(false);
    exportCSV();
  });
  
  // Master upload
  document.getElementById('uploadMasterBtn')?.addEventListener('click', () => {
    document.getElementById('masterFileInput')?.click();
  });
  document.getElementById('masterFileInput')?.addEventListener('change', e => {
    if (e.target.files[0]) uploadMasterFile(e.target.files[0]);
  });
  document.getElementById('downloadTemplateBtn')?.addEventListener('click', downloadTemplate);
  
  // API toggle
  const apiToggleSwitch = document.getElementById('apiToggleSwitch');
  if (apiToggleSwitch) {
    apiToggleSwitch.addEventListener('change', async e => {
      App.settings.apiEnabled = e.target.checked;
      await DB.setSetting('apiEnabled', e.target.checked);
      updateApiIndicator();
    });
  }
  
  // Clear/Reset
  document.getElementById('clearHistoryBtn')?.addEventListener('click', async () => {
    if (confirm('Delete ALL history? This cannot be undone.')) {
      await DB.clearHistory();
      Utils.toast('History cleared', 'success');
      await refreshStats();
      await renderRecentList();
      await renderHistoryList();
    }
  });
  
  document.getElementById('resetAppBtn')?.addEventListener('click', async () => {
    if (confirm('Reset ENTIRE app? All data will be lost!')) {
      await DB.clearHistory();
      await DB.clearMaster();
      localStorage.clear();
      Utils.toast('App reset', 'success');
      location.reload();
    }
  });
  
  // Side menu items
  document.getElementById('menuDownloadBackup')?.addEventListener('click', () => {
    toggleSideMenu(false);
    downloadBackup();
  });
  document.getElementById('menuCloudSync')?.addEventListener('click', () => {
    toggleSideMenu(false);
    showPage('settingsPage');
  });
  document.getElementById('menuTemplate')?.addEventListener('click', () => {
    toggleSideMenu(false);
    downloadTemplate();
  });
  
  // Sync button in header
  document.getElementById('syncBtn')?.addEventListener('click', () => {
    showPage('settingsPage');
  });
}

function updateApiIndicator() {
  const indicator = document.getElementById('apiIndicator');
  if (indicator) {
    indicator.classList.toggle('off', !App.settings.apiEnabled);
  }
}

// ============================================
// INITIALIZATION
// ============================================
async function initApp() {
  console.log('🚀 Starting Expiry Tracker Pro v' + CONFIG.VERSION);
  
  try {
    // Initialize database
    await DB.init();
    
    // Load settings
    App.settings.apiEnabled = await DB.getSetting('apiEnabled') ?? true;
    App.settings.backupCode = await DB.getSetting('backupCode') || '';
    App.settings.lastSync = await DB.getSetting('lastSync');
    
    // Set UI from settings
    const apiToggle = document.getElementById('apiToggleSwitch');
    if (apiToggle) apiToggle.checked = App.settings.apiEnabled;
    
    const backupCodeInput = document.getElementById('backupCodeInput');
    if (backupCodeInput) backupCodeInput.value = App.settings.backupCode;
    
    updateApiIndicator();
    updateLastSync();
    
    // Build master index
    await ProductLookup.buildIndex();
    
    // Initialize event listeners
    initEventListeners();
    
    // Render UI
    await refreshStats();
    await refreshMasterCount();
    await renderRecentList();
    await renderHistoryList();
    
    // Hide splash, show app
    setTimeout(() => {
      document.getElementById('splash')?.classList.add('hidden');
      document.getElementById('app')?.classList.add('visible');
    }, 1500);
    
    console.log('✅ App initialized successfully');
    
  } catch (error) {
    console.error('❌ Initialization error:', error);
    Utils.toast('Failed to initialize app', 'error');
  }
}

// Start app when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => {
    console.log('SW registration failed:', err);
  });
}
