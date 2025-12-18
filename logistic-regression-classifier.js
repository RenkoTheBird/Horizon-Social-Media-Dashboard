// logistic-regression-classifier.js
// Logistic Regression classifier that operates on semantic embeddings
// Uses: logits = X · W^T + b → softmax → label
// Classification ~0.1–1ms, no training needed (model weights precomputed)

// Model weights are loaded from dataset/model_weights.json at startup

function normalizeLabel(label) {
  return typeof label === 'string' ? label.trim().toLowerCase() : '';
}

function sanitizeEmbedding(vector) {
  if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
    return new Float32Array(0);
  }
  // Convert to Float32Array for better performance
  const arr = vector instanceof Float32Array ? vector : new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const val = Number(vector[i]);
    if (Number.isFinite(val)) {
      arr[i] = val;
    } else {
      arr[i] = 0;
    }
  }
  return arr;
}

/**
 * Softmax function: converts logits to probabilities
 * @param {Float32Array|Array<number>} logits - Raw scores for each class
 * @returns {Float32Array} - Probabilities for each class
 */
function softmax(logits) {
  const arr = logits instanceof Float32Array ? logits : new Float32Array(logits);
  const n = arr.length;
  
  // Find max for numerical stability
  let max = arr[0];
  for (let i = 1; i < n; i++) {
    if (arr[i] > max) {
      max = arr[i];
    }
  }
  
  // Compute exp(x - max) and sum
  const expValues = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const expVal = Math.exp(arr[i] - max);
    expValues[i] = expVal;
    sum += expVal;
  }
  
  // Normalize
  const probabilities = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    probabilities[i] = expValues[i] / sum;
  }
  
  return probabilities;
}

export class LogisticRegressionClassifier {
  constructor() {
    this.weights = null; // Shape: [num_classes, num_features] = [15, 384] stored as Float32Array
    this.bias = null;    // Shape: [num_classes] = [15] stored as Float32Array
    this.topics = null;  // Array of topic labels in order (loaded from model_weights.json)
    this.embeddingDim = 384; // Expected embedding dimension
    this.numClasses = 0; // Number of classes (loaded from model_weights.json)
  }

  /**
   * Check if model is loaded
   */
  isLoaded() {
    return this.weights !== null && this.bias !== null;
  }

  /**
   * Classify an embedding vector
   * @param {Array<number>|Float32Array} embedding - The embedding vector (384 dimensions)
   * @returns {Object} - { category: string, confidence: number }
   */
  classify(embedding) {
    if (!this.isLoaded()) {
      return {
        category: 'unknown',
        confidence: 0
      };
    }

    const processedEmbedding = sanitizeEmbedding(embedding);
    
    if (processedEmbedding.length !== this.embeddingDim) {
      console.warn(`[LRClassifier] Embedding dimension mismatch: expected ${this.embeddingDim}, got ${processedEmbedding.length}`);
      return {
        category: 'unknown',
        confidence: 0
      };
    }

    // Compute logits: logits = X · W^T + b
    // embedding (X): [384]
    // weights (W): [num_classes, num_features] = [15, 384]
    // bias (b): [num_classes] = [15]
    // result (logits): [15]
    // logits[c] = sum(embedding[d] * weights[c][d]) + bias[c]
    const startTime = performance.now();
    
    const numClasses = this.numClasses;
    const logits = new Float32Array(numClasses);
    
    // Compute dot product: embedding · W^T + b
    // weights is stored as [num_classes * num_features] in row-major order
    // weights[c * embeddingDim + d] = weights[c][d]
    for (let c = 0; c < numClasses; c++) {
      let sum = this.bias[c];
      const weightOffset = c * this.embeddingDim;
      for (let d = 0; d < this.embeddingDim; d++) {
        sum += processedEmbedding[d] * this.weights[weightOffset + d];
      }
      logits[c] = sum;
    }
    
    // Apply softmax to get probabilities
    const probabilities = softmax(logits);
    
    // Find the class with highest probability
    let bestClass = 0;
    let bestProb = probabilities[0];
    for (let i = 1; i < numClasses; i++) {
      if (probabilities[i] > bestProb) {
        bestProb = probabilities[i];
        bestClass = i;
      }
    }
    
    const elapsed = performance.now() - startTime;
    if (elapsed > 1) {
      console.warn(`[LRClassifier] Classification took ${elapsed.toFixed(2)}ms (expected ~0.1-1ms)`);
    }
    
    return {
      category: this.topics[bestClass] || 'unknown',
      confidence: bestProb,
      probabilities: Array.from(probabilities) // For debugging
    };
  }

  /**
   * Load model weights from dataset/model_weights.json
   * @returns {Promise<boolean>} - True if loaded successfully
   */
  async load() {
    try {
      // Load model weights from the dataset folder
      const modelUrl = chrome.runtime.getURL('dataset/model_weights.json');
      console.log('[LRClassifier] Loading model weights from:', modelUrl);
      
      const response = await fetch(modelUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch model weights: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Validate data structure
      if (!data.weights || !Array.isArray(data.weights) || !Array.isArray(data.bias)) {
        console.error('[LRClassifier] Invalid model data structure:', {
          hasWeights: !!data.weights,
          weightsIsArray: Array.isArray(data.weights),
          biasIsArray: Array.isArray(data.bias)
        });
        return false;
      }
      
      if (!data.classes || !Array.isArray(data.classes)) {
        console.error('[LRClassifier] Missing or invalid classes array');
        return false;
      }
      
      // Validate dimensions
      const numClasses = data.num_classes || data.classes.length;
      const numFeatures = data.num_features || this.embeddingDim;
      
      // weights is stored as [num_classes][num_features] 2D array
      // We need to flatten it to [num_classes * num_features] in row-major order
      const weights2D = data.weights;
      if (weights2D.length !== numClasses) {
        console.error(`[LRClassifier] Weight array length mismatch: expected ${numClasses}, got ${weights2D.length}`);
        return false;
      }
      
      // Flatten weights to [num_classes * num_features] in row-major order
      // weights[c * num_features + d] = weights2D[c][d]
      const weightsFlat = new Float32Array(numClasses * numFeatures);
      for (let c = 0; c < numClasses; c++) {
        if (!Array.isArray(weights2D[c]) || weights2D[c].length !== numFeatures) {
          console.error(`[LRClassifier] Invalid weight row ${c}: expected ${numFeatures} features, got ${weights2D[c]?.length || 0}`);
          return false;
        }
        const offset = c * numFeatures;
        for (let d = 0; d < numFeatures; d++) {
          weightsFlat[offset + d] = weights2D[c][d];
        }
      }
      
      // Convert bias to Float32Array
      if (data.bias.length !== numClasses) {
        console.error(`[LRClassifier] Bias length mismatch: expected ${numClasses}, got ${data.bias.length}`);
        return false;
      }
      
      // Store normalized class names (lowercase)
      this.topics = data.classes.map(c => normalizeLabel(c));
      this.numClasses = numClasses;
      this.weights = weightsFlat;
      this.bias = new Float32Array(data.bias);
      this.embeddingDim = numFeatures;
      
      console.log('[LRClassifier] Model loaded successfully:', {
        embeddingDim: this.embeddingDim,
        numClasses: this.numClasses,
        weightsSize: this.weights.length,
        biasSize: this.bias.length,
        topics: this.topics
      });
      
      return true;
    } catch (error) {
      console.error('[LRClassifier] Failed to load model:', error);
      return false;
    }
  }

  /**
   * Get model info (for debugging/status)
   */
  getInfo() {
    return {
      isLoaded: this.isLoaded(),
      embeddingDim: this.embeddingDim,
      numClasses: this.numClasses,
      topics: this.topics || []
    };
  }
}

