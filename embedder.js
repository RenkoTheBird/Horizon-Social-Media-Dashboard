// embedder.js
// WebGPU-based embedding using transformers.js 3.8.0
// Uses Xenova/all-MiniLM-L6-v2 model with automatic download

// Use window object to persist pipeline across dynamic imports
// This ensures the pipeline is only initialized once per page, even if embedder.js is re-imported
const getPipelineState = () => {
  if (typeof window === 'undefined') {
    // Fallback for non-window contexts (shouldn't happen in our use case)
    return {
      pipelinePromise: null,
      pipelineInstance: null,
      transformersModule: null,
      transformersLoadingPromise: null
    };
  }
  
  if (!window.__horizonEmbedderState) {
    window.__horizonEmbedderState = {
      pipelinePromise: null,
      pipelineInstance: null,
      transformersModule: null,
      transformersLoadingPromise: null
    };
  }
  
  return window.__horizonEmbedderState;
};

/**
 * Load transformers.js module (only once)
 * transformers.js 3.8.0 is an ES module, so we use dynamic import
 */
async function loadTransformersModule() {
  const state = getPipelineState();
  
  // Return cached module if already loaded
  if (state.transformersModule) {
    console.log('[Embedder] Using cached transformers module from window');
    return state.transformersModule;
  }
  
  // Return existing loading promise if already loading
  if (state.transformersLoadingPromise) {
    console.log('[Embedder] Transformers module already loading, awaiting existing promise...');
    return state.transformersLoadingPromise;
  }
  
  state.transformersLoadingPromise = (async () => {
    const transformersUrl = chrome.runtime.getURL('libs/transformers/dist/transformers.min.js');
    
    console.log('[Embedder] Loading transformers.js 3.8.0 as ES module from:', transformersUrl);
    
    try {
      // transformers.js 3.8.0 is an ES module, use dynamic import
      state.transformersModule = await import(transformersUrl);
      console.log('[Embedder] transformers.js loaded successfully');
      console.log('[Embedder] Module exports:', Object.keys(state.transformersModule).slice(0, 10).join(', '), '...');
      
      // Configure WASM paths immediately after loading to prevent CDN requests
      const env = state.transformersModule.env;
      if (env?.backends?.onnx?.wasm) {
        let wasmBasePath;
        try {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
            wasmBasePath = chrome.runtime.getURL('libs/transformers/dist/');
          } else if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL) {
            wasmBasePath = browser.runtime.getURL('libs/transformers/dist/');
          }
        } catch (e) {
          console.error('[Embedder] Failed to get WASM base path in loadTransformersModule:', e);
        }
        
        if (wasmBasePath) {
          // Set explicit WASM file paths - only for files that actually exist
          // We only have ort-wasm-simd-threaded.jsep.wasm and ort-wasm-simd-threaded.jsep.mjs
          env.backends.onnx.wasm.wasmPaths = wasmBasePath;
          
          // Set locateFile function to map all WASM requests to the file we have
          env.backends.onnx.wasm.locateFile = (path, prefix) => {
            // Map all WASM file requests to the simd-threaded version we have
            if (path.includes('ort-wasm')) {
              // If it's asking for a specific WASM file, use our simd-threaded version
              if (path.endsWith('.wasm')) {
                return wasmBasePath + 'ort-wasm-simd-threaded.jsep.wasm';
              }
              // If it's asking for the JS file, use our mjs version
              if (path.endsWith('.mjs') || path.endsWith('.js')) {
                return wasmBasePath + 'ort-wasm-simd-threaded.jsep.mjs';
              }
              // Default: append to base path
              return wasmBasePath + path;
            }
            return prefix ? prefix + path : path;
          };
          
          console.log('[Embedder] Pre-configured WASM paths to:', wasmBasePath);
          console.log('[Embedder] Using ort-wasm-simd-threaded.jsep.wasm for all WASM requests');
        } else {
          console.warn('[Embedder] Could not determine WASM base path in loadTransformersModule');
        }
      }
      
      console.log('[Embedder] Transformers module cached in window.__horizonEmbedderState');
      return state.transformersModule;
    } catch (importError) {
      console.error('[Embedder] Failed to import transformers.js:', importError);
      throw new Error('Cannot load transformers.js: ' + importError.message);
    }
  })();
  
  return state.transformersLoadingPromise;
}

/**
 * Load the transformers.js module and create the embedding pipeline
 * Uses WebGPU backend automatically when available
 */
async function loadPipeline() {
  const state = getPipelineState();
  
  // Debug: log state before checking
  console.log('[Embedder] Pipeline state check:', {
    hasInstance: !!state.pipelineInstance,
    hasPromise: !!state.pipelinePromise,
    instanceType: typeof state.pipelineInstance,
    stateKeys: Object.keys(state),
    windowState: typeof window !== 'undefined' ? !!window.__horizonEmbedderState : 'no window'
  });
  
  // Return cached pipeline if already loaded
  if (state.pipelineInstance) {
    console.log('[Embedder] Using cached pipeline instance from window (no re-initialization needed)');
    // Verify the instance is still callable
    if (typeof state.pipelineInstance === 'function') {
      return state.pipelineInstance;
    } else {
      console.warn('[Embedder] Cached instance is not a function, reinitializing');
      state.pipelineInstance = null;
    }
  }
  
  // Return existing promise if already loading
  if (state.pipelinePromise) {
    console.log('[Embedder] Pipeline already loading, awaiting existing promise...');
    try {
      const result = await state.pipelinePromise;
      console.log('[Embedder] Existing promise resolved, pipeline:', !!result, 'type:', typeof result);
      // If the promise resolved but instance wasn't cached, cache it now
      if (result && !state.pipelineInstance) {
        state.pipelineInstance = result;
        state.pipelinePromise = null;
        console.log('[Embedder] Cached pipeline from resolved promise');
      }
      return result;
    } catch (error) {
      console.error('[Embedder] Pipeline promise rejected:', error);
      state.pipelinePromise = null;
      // Fall through to create new promise
    }
  }

  console.log('[Embedder] Creating new pipeline promise...');
  state.pipelinePromise = (async () => {
    try {
      console.log('[Embedder] Starting pipeline load...');
      
      // Load transformers.js module (cached)
      const module = await loadTransformersModule();
      
      console.log('[Embedder] Module loaded:', {
        hasModule: !!module,
        moduleType: typeof module,
        hasPipeline: !!(module?.pipeline),
        hasDefault: !!(module?.default),
        windowTransformers: !!(window.transformers),
        globalThisTransformers: !!(globalThis.transformers)
      });
      
      if (!module) {
        throw new Error('transformers.js module not loaded');
      }

      // Extract pipeline function from ES module
      // transformers.js 3.8.0 exports pipeline directly
      let pipeline;
      
      if (module.pipeline) {
        pipeline = module.pipeline;
        console.log('[Embedder] Found pipeline on module');
      } else if (module.default && module.default.pipeline) {
        pipeline = module.default.pipeline;
        console.log('[Embedder] Found pipeline on module.default');
      } else {
        // Debug: log available keys
        const keys = Object.keys(module || {}).slice(0, 30);
        console.error('[Embedder] Pipeline not found. Available keys:', keys.join(', '), '...');
        console.error('[Embedder] module type:', typeof module);
        throw new Error('transformers.js pipeline function not found. Available keys: ' + keys.join(', '));
      }

      if (typeof pipeline !== 'function') {
        throw new Error('pipeline is not a function. Type: ' + typeof pipeline);
      }

      // Configure environment for WebGPU and local WASM files
      // transformers.js 3.8.0 uses env from the module
      const env = module.env;
      if (env) {
        // Allow model downloads from HuggingFace
        env.allowRemoteModels = true;
        env.useBrowserCache = true;
        
        // Configure WASM paths to use local files instead of CDN
        // This prevents CSP violations
        // Get the base URL for WASM files - works in both extension and page contexts
        let wasmBasePath;
        try {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
            wasmBasePath = chrome.runtime.getURL('libs/transformers/dist/');
          } else if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL) {
            wasmBasePath = browser.runtime.getURL('libs/transformers/dist/');
          } else {
            // Fallback: try to construct from current location
            const scripts = document.getElementsByTagName('script');
            for (let script of scripts) {
              if (script.src && script.src.includes('embedder.js')) {
                const url = new URL(script.src);
                wasmBasePath = url.origin + url.pathname.replace('embedder.js', 'libs/transformers/dist/');
                break;
              }
            }
          }
        } catch (e) {
          console.error('[Embedder] Failed to get WASM base path:', e);
        }
        
        if (wasmBasePath && env.backends?.onnx?.wasm) {
          // Set WASM base path - transformers.js will use locateFile to find specific files
          env.backends.onnx.wasm.wasmPaths = wasmBasePath;
          
          // Set locateFile function to map all WASM requests to the file we have
          // We only have ort-wasm-simd-threaded.jsep.wasm, so map all requests to it
          env.backends.onnx.wasm.locateFile = (path, prefix) => {
            // Map all WASM file requests to the simd-threaded version we have
            if (path.includes('ort-wasm')) {
              // If it's asking for a specific WASM file, use our simd-threaded version
              if (path.endsWith('.wasm')) {
                return wasmBasePath + 'ort-wasm-simd-threaded.jsep.wasm';
              }
              // If it's asking for the JS file, use our mjs version
              if (path.endsWith('.mjs') || path.endsWith('.js')) {
                return wasmBasePath + 'ort-wasm-simd-threaded.jsep.mjs';
              }
              // Default: append to base path
              return wasmBasePath + path;
            }
            return prefix ? prefix + path : path;
          };
          
          console.log('[Embedder] Configured WASM paths to:', wasmBasePath);
          console.log('[Embedder] Using ort-wasm-simd-threaded.jsep.wasm for all WASM requests');
        } else {
          console.warn('[Embedder] ONNX backend not found or WASM base path unavailable, WASM paths not configured');
          if (!wasmBasePath) {
            console.error('[Embedder] Could not determine WASM base path');
          }
        }
        
        // Explicitly configure WebGPU backend
        // transformers.js 3.8.0 supports WebGPU natively
        if (env.backends) {
          console.log('[Embedder] Available backends:', Object.keys(env.backends));
        }
        
        console.log('[Embedder] Transformers.js environment configured');
        console.log('[Embedder] Environment settings:', {
          allowRemoteModels: env.allowRemoteModels,
          useBrowserCache: env.useBrowserCache,
          backends: Object.keys(env.backends || {}),
          wasmPaths: env.backends?.onnx?.wasm?.wasmPaths
        });
      } else {
        console.warn('[Embedder] env not found on module, using defaults');
      }

      // Create the feature extraction pipeline
      // Model will be auto-downloaded on first use
      console.log('[Embedder] Creating pipeline for Xenova/all-MiniLM-L6-v2...');
      
      // Create pipeline - transformers.js 3.8.0 will automatically use WebGPU if available
      // The device parameter format may vary, so we'll let it auto-detect
      const extractor = await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2'
      );

      if (!extractor) {
        throw new Error('Pipeline creation returned null/undefined');
      }

      console.log('[Embedder] Pipeline created successfully');
      console.log('[Embedder] Testing pipeline with sample text...');
      
      // Test the pipeline with a simple text to verify it works
      try {
        const testResult = await extractor('test', { pooling: 'mean', normalize: true });
        console.log('[Embedder] Test result:', {
          type: typeof testResult,
          isArray: Array.isArray(testResult),
          hasData: !!testResult?.data,
          dataType: testResult?.data?.constructor?.name,
          dataLength: testResult?.data?.length,
          dims: testResult?.dims,
          keys: Object.keys(testResult || {}).slice(0, 20)
        });
        
        // Verify we can extract the embedding
        if (testResult?.data) {
          const testArray = Array.from(testResult.data);
          console.log('[Embedder] Test embedding extracted:', testArray.length, 'dimensions');
          if (testArray.length === 0) {
            console.error('[Embedder] Test embedding is empty! Result structure:', testResult);
          }
        } else {
          console.warn('[Embedder] Test result has no data property. Full result:', testResult);
        }
      } catch (testError) {
        console.error('[Embedder] Pipeline test failed:', testError);
        console.error('[Embedder] Test error details:', {
          name: testError.name,
          message: testError.message,
          stack: testError.stack
        });
        throw testError;
      }

      // Cache the pipeline instance in window state BEFORE returning
      state.pipelineInstance = extractor;
      // Clear the promise so future calls can check the instance directly
      state.pipelinePromise = null;
      console.log('[Embedder] Pipeline loaded and tested successfully');
      console.log('[Embedder] Pipeline instance cached in window.__horizonEmbedderState');
      console.log('[Embedder] Pipeline instance type:', typeof state.pipelineInstance, 'Value:', !!state.pipelineInstance);
      console.log('[Embedder] State after caching:', {
        hasInstance: !!state.pipelineInstance,
        hasPromise: !!state.pipelinePromise,
        stateKeys: Object.keys(state)
      });
      
      return extractor;
    } catch (error) {
      console.error('[Embedder] Failed to load pipeline:', error);
      state.pipelinePromise = null; // Reset on error so we can retry
      state.pipelineInstance = null; // Also reset instance on error
      throw error;
    }
  })();

  return state.pipelinePromise;
}

/**
 * Get embedding for a text string
 * Returns the embedding array directly (for compatibility with train-lr.js)
 * 
 * @param {string} text - The text to embed
 * @returns {Promise<Array<number>>} - The embedding vector as an array
 */
export async function getEmbedding(text) {
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized) {
    console.warn('[Embedder] Empty or invalid text provided');
    return [];
  }

  try {
    // Load pipeline if not already loaded (cached after first load)
    const extractor = await loadPipeline();
    
    if (!extractor) {
      console.error('[Embedder] Pipeline not available');
      return [];
    }

    // Generate embedding
    let result;
    try {
      console.log('[Embedder] Calling extractor with text:', normalized.substring(0, 50));
      result = await extractor(normalized, {
        pooling: 'mean',
        normalize: true
      });
      console.log('[Embedder] Extractor returned:', {
        type: typeof result,
        isArray: Array.isArray(result),
        hasData: !!result?.data,
        dataLength: result?.data?.length,
        hasDims: !!result?.dims,
        dims: result?.dims,
        keys: result ? Object.keys(result).slice(0, 10) : []
      });
    } catch (extractError) {
      console.error('[Embedder] Error calling extractor:', extractError);
      console.error('[Embedder] Error details:', {
        name: extractError.name,
        message: extractError.message,
        stack: extractError.stack
      });
      throw extractError;
    }

    // Convert tensor to array
    // transformers.js returns a Tensor object with a `data` property (Float32Array)
    // The tensor may have dimensions like [1, 384] which we need to flatten to [384]
    let embeddingArray = null;
    
    if (!result) {
      console.error('[Embedder] Pipeline returned null/undefined for text:', normalized.substring(0, 50));
      return [];
    }
    
    // Debug logging for first few calls only
    if (!window._embedderDebugCount) {
      window._embedderDebugCount = 0;
    }
    if (window._embedderDebugCount < 3) {
      window._embedderDebugCount++;
      console.log('[Embedder] Result structure:', {
        type: typeof result,
        isArray: Array.isArray(result),
        hasData: !!result?.data,
        dataType: result?.data?.constructor?.name,
        dataLength: result?.data?.length,
        hasDims: !!result?.dims,
        dims: result?.dims,
        hasTolist: typeof result?.tolist === 'function',
        hasToArray: typeof result?.toArray === 'function',
        keys: Object.keys(result || {})
      });
    }

    // transformers.js 3.8.0 feature extraction returns a Tensor object
    // The result should have a .data property (TypedArray) and .dims property
    
    // Check if result is already an array (unlikely but possible)
    if (Array.isArray(result)) {
      embeddingArray = result;
      console.log('[Embedder] Result is already an array, length:', embeddingArray.length);
    }
    // Check if result has a data property (Tensor object) - this is the most common case for transformers.js 3.8.0
    else if (result?.data) {
      // transformers.js 3.8.0 returns Tensor with .data (TypedArray) and .dims
      // Handle Float32Array, Float64Array, or similar TypedArrays
      if (result.data instanceof Float32Array || 
          result.data instanceof Float64Array ||
          result.data instanceof Int8Array ||
          result.data instanceof Uint8Array ||
          result.data instanceof Array) {
        
        // For mean pooling with normalize, result.dims should be [1, 384] or [384]
        // Calculate expected size from dimensions
        let expectedSize = result.data.length;
        if (result.dims && Array.isArray(result.dims)) {
          // Calculate total size from dimensions
          expectedSize = result.dims.reduce((a, b) => a * b, 1);
          
          if (result.dims.length === 2 && result.dims[0] === 1) {
            // Shape is [1, 384], extract first 384 elements
            const size = result.dims[1];
            embeddingArray = Array.from(result.data.slice(0, size));
            if (window._embedderDebugCount <= 3) {
              console.log('[Embedder] Extracted from [1, 384] shape, got', embeddingArray.length, 'elements');
            }
          } else if (result.dims.length === 1) {
            // Shape is [384], use all elements
            embeddingArray = Array.from(result.data);
            if (window._embedderDebugCount <= 3) {
              console.log('[Embedder] Extracted from [384] shape, got', embeddingArray.length, 'elements');
            }
          } else {
            // Multi-dimensional, flatten it
            embeddingArray = Array.from(result.data.slice(0, expectedSize));
            if (window._embedderDebugCount <= 3) {
              console.log('[Embedder] Extracted from shape', result.dims, ', got', embeddingArray.length, 'elements');
            }
          }
        } else {
          // No dims info, use all data
          embeddingArray = Array.from(result.data);
          if (window._embedderDebugCount <= 3) {
            console.log('[Embedder] No dims info, using all data, got', embeddingArray.length, 'elements');
          }
        }
      } 
      // Handle array-like objects
      else if (result.data.length !== undefined) {
        embeddingArray = Array.from(result.data);
        if (window._embedderDebugCount <= 3) {
          console.log('[Embedder] Extracted from array-like data, got', embeddingArray.length, 'elements');
        }
      } else {
        console.error('[Embedder] Result.data is not array-like:', typeof result.data, result.data);
        return [];
      }
    }
    // Check for tolist method (some tensor implementations)
    else if (typeof result.tolist === 'function') {
      embeddingArray = result.tolist();
      // Flatten if nested
      if (Array.isArray(embeddingArray) && embeddingArray.length === 1 && Array.isArray(embeddingArray[0])) {
        embeddingArray = embeddingArray[0];
      }
    }
    // Check for toArray method
    else if (typeof result.toArray === 'function') {
      embeddingArray = result.toArray();
    }
    // Try to extract from tensor dimensions
    else if (result.dims && result.size !== undefined) {
      // For mean pooling, we expect [1, 384] or [384] dimensions
      // Extract the actual embedding vector
      if (result.dims.length === 2 && result.dims[0] === 1) {
        // Shape is [1, 384], extract the [384] part
        const embeddingSize = result.dims[1];
        if (result.data && result.data.length >= embeddingSize) {
          embeddingArray = Array.from(result.data.slice(0, embeddingSize));
        } else {
          console.error('[Embedder] Cannot extract embedding from tensor. dims:', result.dims, 'data length:', result.data?.length);
          return [];
        }
      } else if (result.dims.length === 1) {
        // Shape is [384], use all data
        if (result.data) {
          embeddingArray = Array.from(result.data);
        } else {
          console.error('[Embedder] Tensor has no data property:', result);
          return [];
        }
      } else {
        console.error('[Embedder] Unexpected tensor dimensions:', result.dims);
        return [];
      }
    }
    // Last resort: try Array.from
    else {
      try {
        embeddingArray = Array.from(result);
      } catch (e) {
        console.error('[Embedder] Cannot convert result to array. Result structure:', {
          type: typeof result,
          keys: Object.keys(result || {}),
          result: result
        });
        return [];
      }
    }

    // Ensure we have a valid array
    if (!embeddingArray || !Array.isArray(embeddingArray) || embeddingArray.length === 0) {
      console.error('[Embedder] Failed to extract embedding array. Result was:', result);
      return [];
    }

    // Normalize values to fixed precision (for consistency with logistic regression)
    const embeddingVector = embeddingArray
      .filter(v => typeof v === 'number' && !isNaN(v) && isFinite(v))
      .map((value) => Number(Number(value).toFixed(6)));

    if (!embeddingVector.length) {
      console.error('[Embedder] Empty embedding vector after filtering. Original array length:', embeddingArray.length);
      return [];
    }

    return embeddingVector;
  } catch (error) {
    console.error('[Embedder] Error generating embedding:', error);
    return [];
  }
}

// Expose getEmbedding on window for access from injected scripts (after function is defined)
if (typeof window !== 'undefined') {
  // Only expose if not already exposed (to avoid overwriting)
  if (!window.__horizonGetEmbedding) {
    window.__horizonGetEmbedding = getEmbedding;
    console.log('[Embedder] Exposed getEmbedding on window.__horizonGetEmbedding');
  }
}
