// background.js  — now safe for MV3 service worker
import { LogisticRegressionClassifier } from './logistic-regression-classifier.js';
// Import LLM functions from dedicated background_llm.js module
import { generateRecommendations as llmGenerateRecommendations } from './background_llm.js';
// Import SmolLM recommender
import { generateSmolLMRecommendations } from './smollm_recommender.js';
// Static import of transformers.js - REQUIRED for MV3 service workers
// Chrome MV3 service workers DO NOT allow dynamic import() - must use static imports
// The transformers.js file is located at libs/transformers/dist/transformers.min.js
import * as transformersModule from './libs/transformers/dist/transformers.min.js';

/**
 * Get local date string in YYYY-MM-DD format (not UTC)
 * This ensures dates match the user's local timezone
 */
function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get yesterday's date string in local timezone
 */
function getYesterdayDateString() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return getLocalDateString(yesterday);
}

// Embedding pipeline - loaded in background service worker using static import
let embeddingPipeline = null;
let embeddingPipelinePromise = null;

let embeddingCacheLoaded = false;
let lrClassifierPromise = null;
const embeddingCache = new Map();
const embeddingCacheOrder = [];

const EMBEDDING_CACHE_KEY = 'embedding_cache_v1';
const MAX_EMBEDDING_CACHE_ENTRIES = 20;


// Embeddings are now handled in background service worker (can load ESM modules)

async function loadLRClassifier() {
  if (!lrClassifierPromise) {
    lrClassifierPromise = (async () => {
      const classifier = new LogisticRegressionClassifier();
      try {
        const loaded = await classifier.load();
        if (!loaded) {
          console.error('[Horizon] Failed to load logistic regression model from dataset/model_weights.json');
          return null;
        }
        console.log('[Horizon] Logistic regression classifier loaded successfully');
      } catch (error) {
        console.error('[Horizon] Failed to load logistic regression classifier:', error);
        return null;
      }
      return classifier;
    })();
  }
  return lrClassifierPromise;
}

/**
 * Clear old daily data (data from previous days)
 * This ensures data is automatically cleared at the end of each day
 * Preserves yesterday's data until recommendations are generated
 */
async function clearOldDailyData() {
  try {
    const today = getLocalDateString();
    const yesterday = getYesterdayDateString();
    const todayKey = `day_${today}`;
    const yesterdayKey = `day_${yesterday}`;
    
    // Get all storage keys
    const allData = await chrome.storage.local.get(null);
    
    // Check if recommendations have been generated and for which date
    const stored = await chrome.storage.local.get(['lastRecommendationDay', 'horizon_recommendations_date']);
    const lastRecommendationDay = stored.lastRecommendationDay || null;
    const recommendationsDate = stored.horizon_recommendations_date || null;
    
    console.log('[Horizon] clearOldDailyData - preserving data for recommendations date:', recommendationsDate);
    
    // Find and remove all day_* keys except today's and the day for which recommendations were generated
    const keysToRemove = [];
    const allDayKeys = Object.keys(allData).filter(k => k.startsWith('day_'));
    console.log('[Horizon] clearOldDailyData - all day_ keys before cleanup:', allDayKeys);
    
    for (const key in allData) {
      if (key.startsWith('day_') && key !== todayKey) {
        // Preserve yesterday's data if we haven't generated recommendations for it yet
        if (key === yesterdayKey && lastRecommendationDay !== yesterday && today !== yesterday) {
          console.log(`[Horizon] Preserving ${yesterdayKey} data until recommendations are generated`);
          continue;
        }
        // Preserve the day's data for which recommendations were generated (so summary can be displayed)
        if (recommendationsDate) {
          const recommendationsKey = `day_${recommendationsDate}`;
          if (key === recommendationsKey) {
            console.log(`[Horizon] Preserving ${recommendationsKey} data for summary display`);
            continue;
          }
        }
        keysToRemove.push(key);
      }
    }
    
    console.log('[Horizon] clearOldDailyData - keys to remove:', keysToRemove);
    
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
      console.log(`[Horizon] Cleared ${keysToRemove.length} old daily data entries:`, keysToRemove);
    }
    
    // Verify the recommendations date data still exists after cleanup
    if (recommendationsDate) {
      const recommendationsKey = `day_${recommendationsDate}`;
      const verifyData = await chrome.storage.local.get([recommendationsKey]);
      console.log('[Horizon] clearOldDailyData - after cleanup, recommendations data exists:', !!verifyData[recommendationsKey]);
    }
  } catch (error) {
    console.error('[Horizon] Error clearing old daily data:', error);
  }
}

// Track the last day for which recommendations were generated
let lastRecommendationDay = null;

/**
 * Check if day has changed and generate recommendations for the previous day if needed
 */
async function checkDayEndAndGenerateRecommendations() {
  try {
    const today = getLocalDateString();
    const yesterday = getYesterdayDateString();
    
    // Get the last recommendation day and current recommendations from storage
    const stored = await chrome.storage.local.get(['lastRecommendationDay', 'horizon_recommendations', 'horizon_recommendations_date']);
    lastRecommendationDay = stored.lastRecommendationDay || null;
    const existingRecommendations = stored.horizon_recommendations;
    const existingRecommendationsDate = stored.horizon_recommendations_date;
    
    // Check if we need to generate recommendations for yesterday
    // Conditions:
    // 1. We haven't generated recommendations for yesterday yet
    // 2. Yesterday is not today (we're in a new day)
    // 3. Either we have no recommendations, or the existing recommendations are not for yesterday
    const needsGeneration = lastRecommendationDay !== yesterday && 
                           today !== yesterday &&
                           (!existingRecommendations || existingRecommendationsDate !== yesterday);
    
    if (needsGeneration) {
      // Get settings
      const { settings } = await chrome.storage.local.get(['settings']);
      
      // Only generate if recommendations are enabled
      if (settings && settings.enableRecommendations === true) {
        // Get all day_* keys to find the most recent day's data (excluding today)
        const allData = await chrome.storage.local.get(null);
        const dayKeys = Object.keys(allData).filter(key => key.startsWith('day_') && key !== `day_${today}`);
        
        // Sort day keys by date (most recent first)
        dayKeys.sort((a, b) => {
          const dateA = a.replace('day_', '');
          const dateB = b.replace('day_', '');
          return dateB.localeCompare(dateA); // Descending order
        });
        
        // Try to find data for yesterday first, then most recent day
        let targetKey = `day_${yesterday}`;
        let targetDate = yesterday;
        let yesterdayData = await chrome.storage.local.get([targetKey]);
        
        // If yesterday's data doesn't exist, use the most recent day's data
        if (!yesterdayData[targetKey] && dayKeys.length > 0) {
          targetKey = dayKeys[0];
          targetDate = targetKey.replace('day_', '');
          yesterdayData = await chrome.storage.local.get([targetKey]);
          console.log(`[Horizon] Yesterday's data not found, using most recent day: ${targetDate}`);
        }
        
        if (yesterdayData[targetKey]) {
          const data = yesterdayData[targetKey];
          
          // Use the date from the data itself if available, otherwise use the target date
          // This ensures we use the correct date even if there's a timezone mismatch
          const dataDate = data.day || targetDate;
          
          // Check if we have enough data (at least 1 minute)
          if (data.totalMs && data.totalMs >= 60000) {
            console.log(`[Horizon] Day ended. Generating recommendations for ${dataDate} (data date: ${data.day || 'not set'}, calculated yesterday: ${yesterday})...`);
            console.log(`[Horizon] Data summary: totalMs=${data.totalMs}, topics=${Object.keys(data.byTopicCounts || {}).length}`);
            
            // Get LLM preference (default to 'smollm')
            const llmPreference = settings.recommendationLLM || 'smollm';
            
            try {
              let recommendations = '';
              
              if (llmPreference === 'chatgpt') {
                // Generate using ChatGPT
                const result = await generateRecommendationsForDate(dataDate, data);
                if (result && result.success) {
                  recommendations = result.recommendations || '';
                } else {
                  console.warn(`[Horizon] Failed to generate ChatGPT recommendations for ${dataDate}:`, result?.error);
                  // Try SmolLM as fallback
                  const fallbackResult = await generateSmolLMRecommendationsForDate(dataDate, data);
                  if (fallbackResult && fallbackResult.success) {
                    recommendations = fallbackResult.recommendations || '';
                    console.log(`[Horizon] Used SmolLM as fallback for ${dataDate}`);
                  }
                }
              } else {
                // Generate using SmolLM
                const result = await generateSmolLMRecommendationsForDate(dataDate, data);
                if (result && result.success) {
                  recommendations = result.recommendations || '';
                } else {
                  console.warn(`[Horizon] Failed to generate SmolLM recommendations for ${dataDate}:`, result?.error);
                }
              }
              
              if (recommendations && recommendations.trim().length > 0) {
                // Store recommendations with the date from the data itself (not calculated yesterday)
                // Also store a snapshot of the summary data so it can be displayed later
                const summarySnapshot = {
                  day: data.day || dataDate,
                  byDomain: data.byDomain || {},
                  byContentType: data.byContentType || {},
                  byTopic: data.byTopic || {},
                  byTopicCounts: data.byTopicCounts || {},
                  totalMs: data.totalMs || 0,
                  embeddingSamples: data.embeddingSamples || [],
                  lrProbabilities: data.lrProbabilities || {},
                  seenPosts: data.seenPosts || {}
                };
                
                await chrome.storage.local.set({
                  'horizon_recommendations': recommendations,
                  'horizon_recommendations_date': dataDate,
                  'lastRecommendationDay': dataDate,
                  'horizon_recommendations_summary': summarySnapshot, // Store snapshot for display
                  'horizon_summary_snapshot': summarySnapshot, // Also store as regular summary snapshot for consistency
                  'horizon_summary_date': dataDate // Store the date for the summary
                });
                console.log(`[Horizon] Recommendations generated and saved for ${dataDate}`);
                console.log(`[Horizon] Summary snapshot stored with ${Object.keys(summarySnapshot.byTopicCounts).length} topics`);
                console.log(`[Horizon] Recommendations preview: ${recommendations.substring(0, 100)}...`);
              } else {
                console.warn(`[Horizon] No recommendations generated for ${dataDate} (empty result)`);
                // Still mark as processed to avoid repeated attempts
                await chrome.storage.local.set({ 'lastRecommendationDay': dataDate });
              }
            } catch (error) {
              console.error(`[Horizon] Error generating recommendations for ${dataDate}:`, error);
              console.error(`[Horizon] Error stack:`, error.stack);
              // Mark as processed even on error to avoid infinite retries
              await chrome.storage.local.set({ 'lastRecommendationDay': dataDate });
            }
          } else {
            console.log(`[Horizon] Not enough data for ${dataDate} to generate recommendations (totalMs: ${data.totalMs || 0})`);
            // Still mark as processed to avoid repeated checks
            await chrome.storage.local.set({ 'lastRecommendationDay': dataDate });
          }
        } else {
          // No data for yesterday, mark as processed
          console.log(`[Horizon] No data found for ${yesterday}, marking as processed`);
          await chrome.storage.local.set({ 'lastRecommendationDay': yesterday });
        }
      } else {
        console.log('[Horizon] Recommendations disabled, skipping automatic generation');
      }
    } else {
      // Log why we're not generating (for debugging)
      if (lastRecommendationDay === yesterday) {
        console.log(`[Horizon] Recommendations already generated for ${yesterday}`);
      } else if (today === yesterday) {
        console.log(`[Horizon] Still the same day (${today}), no recommendations needed yet`);
      } else if (existingRecommendations && existingRecommendationsDate === yesterday) {
        console.log(`[Horizon] Recommendations already exist for ${yesterday}`);
      }
    }
  } catch (error) {
    console.error('[Horizon] Error in checkDayEndAndGenerateRecommendations:', error);
    console.error('[Horizon] Error stack:', error.stack);
  }
}

/**
 * Generate recommendations using ChatGPT for a specific date's data
 */
async function generateRecommendationsForDate(date, data) {
  try {
    // Check if we have enough data
    if (!data.totalMs || data.totalMs < 60000) {
      return {
        success: false,
        error: 'Not enough consumption data.'
      };
    }
    
    // Get a random post title from seenPosts
    let randomPostTitle = null;
    if (data.seenPosts && typeof data.seenPosts === 'object') {
      const postEntries = Object.values(data.seenPosts).filter(post => post && post.title && post.title.trim().length > 5);
      if (postEntries.length > 0) {
        const randomIndex = Math.floor(Math.random() * postEntries.length);
        randomPostTitle = postEntries[randomIndex].title;
        console.log('[Horizon] Selected random post title for recommendations:', randomPostTitle.substring(0, 100));
      }
    }
    
    // Generate recommendations using background_llm.js module
    const recommendations = await llmGenerateRecommendations({
      byTopicCounts: data.byTopicCounts || {},
      byTopic: data.byTopic || {},
      lrProbabilities: data.lrProbabilities || {},
      samplePostTitle: randomPostTitle
    });

    return {
      success: true,
      recommendations: recommendations || ''
    };
  } catch (error) {
    console.error('[Horizon] Error generating ChatGPT recommendations:', error);
    return {
      success: false,
      error: error.message || 'Failed to generate recommendations'
    };
  }
}

/**
 * Generate recommendations using SmolLM for a specific date's data
 */
async function generateSmolLMRecommendationsForDate(date, data) {
  try {
    // Check if we have enough data
    if (!data.totalMs || data.totalMs < 60000) {
      return {
        success: false,
        error: 'Not enough consumption data.'
      };
    }
    
    // Get a random post title from seenPosts
    let randomPostTitle = null;
    if (data.seenPosts && typeof data.seenPosts === 'object') {
      const postEntries = Object.values(data.seenPosts).filter(post => post && post.title && post.title.trim().length > 5);
      if (postEntries.length > 0) {
        const randomIndex = Math.floor(Math.random() * postEntries.length);
        randomPostTitle = postEntries[randomIndex].title;
        console.log('[Horizon] Selected random post title for SmolLM recommendations:', randomPostTitle.substring(0, 100));
      }
    }
    
    // Generate recommendations using SmolLM
    const recommendations = await generateSmolLMRecommendations({
      byTopicCounts: data.byTopicCounts || {},
      byTopic: data.byTopic || {},
      samplePostTitle: randomPostTitle
    });

    return {
      success: true,
      recommendations: recommendations || ''
    };
  } catch (error) {
    console.error('[Horizon] Error generating SmolLM recommendations:', error);
    return {
      success: false,
      error: error.message || 'Failed to generate recommendations'
    };
  }
}

// Load classifier on extension startup
(async () => {
  try {
    await loadLRClassifier();
    await loadEmbeddingCacheFromStorage();
    
    // Check for day-end and generate recommendations BEFORE clearing old data
    // This ensures we can access yesterday's data to generate recommendations
    await checkDayEndAndGenerateRecommendations();
    
    // Clear old daily data on startup (after generating recommendations)
    await clearOldDailyData();
    
    // Initialize badge with current tracking data
    const summary = await getTodaySummary();
    await updateBadge(summary.totalMs);
    
    // Set up periodic badge updates (every 15 minutes)
    setInterval(async () => {
      try {
        const summary = await getTodaySummary();
        await updateBadge(summary.totalMs);
      } catch (error) {
        console.log('[Horizon] Periodic badge update skipped:', error.message);
      }
    }, 15 * 60 * 1000); // 15 minutes
    
    // Set up periodic daily data cleanup and day-end check (check every hour)
    setInterval(async () => {
      try {
        // Check for day-end and generate recommendations BEFORE clearing old data
        await checkDayEndAndGenerateRecommendations();
        await clearOldDailyData();
      } catch (error) {
        console.error('[Horizon] Error during periodic data cleanup:', error);
      }
    }, 60 * 60 * 1000); // 1 hour
    
    // Also check for day-end every 15 minutes (more frequent check around midnight)
    setInterval(async () => {
      try {
        await checkDayEndAndGenerateRecommendations();
      } catch (error) {
        console.error('[Horizon] Error during day-end check:', error);
      }
    }, 15 * 60 * 1000); // 15 minutes
    
    console.log('[Horizon] Extension initialized successfully');
  } catch (error) {
    console.error('[Horizon] Error during extension initialization:', error);
  }
})();

async function classifyText(text, tabId = null) {
  try {
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized) {
      return {
        category: 'unknown',
        confidence: 0,
        classifierType: 'none',
        embeddingResult: { embedding: null, hash: null }
      };
    }

    // Get settings for classification
    const { settings } = await chrome.storage.local.get(['settings']);

    // Fallback to logistic regression classification
    // CRITICAL: Generate embedding FIRST, then classify ONLY after embedding is ready
    console.log('[Horizon] STEP 1: Starting embedding generation for logistic regression classification');
    console.log('[Horizon] Text to embed:', normalized);
    console.log('[Horizon] Text length:', normalized.length);
    
    const embeddingResult = await generateEmbeddingInBackground(normalized);
    
    console.log('[Horizon] STEP 2: Embedding generation completed');
    console.log('[Horizon] Embedding result in SW:', {
      hasEmbedding: embeddingResult.hasEmbedding,
      embeddingLength: embeddingResult.embeddingLength,
      hash: embeddingResult.hash ? embeddingResult.hash.substring(0, 8) + '...' : null,
      hasError: !!embeddingResult.error,
      errorMessage: embeddingResult.error || null
    });
    
    // CRITICAL: Only proceed with classification if embedding was successfully generated
    if (!embeddingResult.hasEmbedding || !embeddingResult.embedding || !embeddingResult.embedding.length) {
      console.error('[Horizon] CRITICAL: No embedding generated, cannot proceed with logistic regression classification');
      console.error('[Horizon] Embedding result details:', JSON.stringify(embeddingResult, null, 2));
      console.error('[Horizon] This means the embedding model did not return usable output');
      return {
        category: 'unknown',
        confidence: 0,
        classifierType: 'none',
        embeddingResult: {
          embedding: null,
          hash: embeddingResult.hash || null
        }
      };
    }
    
    // CRITICAL: Embedding is ready, now proceed with logistic regression classification
    console.log('[Horizon] STEP 3: Embedding ready, proceeding with logistic regression classification');
    console.log('[Horizon] Embedding vector length:', embeddingResult.embedding.length);
    console.log('[Horizon] First few embedding values:', embeddingResult.embedding.slice(0, 5));
    
    // Convert to the format expected by the rest of the code
    const embeddingResultFormatted = {
      embedding: embeddingResult.embedding,
      hash: embeddingResult.hash
    };
    
    const lrClassifier = await loadLRClassifier();
    if (!lrClassifier) {
      console.error('[Horizon] Logistic regression classifier failed to load');
      return {
        category: 'unknown',
        confidence: 0,
        classifierType: 'none',
        embeddingResult: embeddingResultFormatted
      };
    }
    
    if (!lrClassifier.isLoaded()) {
      console.warn('[Horizon] Logistic regression classifier model not loaded, cannot classify');
      return {
        category: 'unknown',
        confidence: 0,
        classifierType: 'none',
        embeddingResult: embeddingResultFormatted
      };
    }
    
    // CRITICAL: Now classify using the embedding
    console.log('[Horizon] STEP 4: Calling logistic regression classify with embedding vector');
    const lrResult = lrClassifier.classify(embeddingResult.embedding);
    
    console.log('[Horizon] STEP 5: Logistic regression classification completed');
    console.log('[Horizon] Logistic regression classification result:', {
      text: normalized.substring(0, 50),
      category: lrResult.category,
      confidence: lrResult.confidence
    });
    
    // Normalize the category label to ensure consistency
    // Map all categories from CSV to ensure proper matching
    let normalizedCategory = lrResult.category || 'unknown';
    const categoryLower = normalizedCategory.toLowerCase();
    
    // Complete category mapping based on CSV primary_theme values
    // Categories: Business, Cryptocurrency, Economy, Entertainment, Environment, 
    // Finance, Health, Investing, Law, People, Politics, Science, Social, Sports, Technology
    const categoryMap = {
      // Technology variations
      'tech': 'technology',
      'technology': 'technology',
      // Politics variations
      'politics': 'politics',
      'political': 'politics',
      // Sports variations
      'sports': 'sports',
      'sport': 'sports',
      // Entertainment variations
      'entertainment': 'entertainment',
      'entertain': 'entertainment',
      // Direct mappings for all CSV categories (case-insensitive)
      'business': 'business',
      'cryptocurrency': 'cryptocurrency',
      'economy': 'economy',
      'environment': 'environment',
      'finance': 'finance',
      'health': 'health',
      'investing': 'investing',
      'law': 'law',
      'people': 'people',
      'science': 'science',
      'social': 'social'
    };
    
    // Apply mapping if available, otherwise pass through the category as-is
    if (categoryMap[categoryLower]) {
      normalizedCategory = categoryMap[categoryLower];
    } else if (categoryLower.includes('tech')) {
      normalizedCategory = 'technology';
    }
    // If category is not in map, keep it as-is (already normalized to lowercase)
    // This ensures all categories from CSV are preserved
    
    console.log('[Horizon] Category normalization:', {
      original: lrResult.category,
      normalized: normalizedCategory,
      confidence: lrResult.confidence
    });
    
    return {
      category: normalizedCategory,
      confidence: lrResult.confidence || 0,
      classifierType: 'lr',
      embeddingResult: embeddingResultFormatted
    };
  } catch (error) {
    console.error('[Horizon] Classification error:', error);
    return {
      category: 'unknown',
      confidence: 0,
      classifierType: 'error',
      embeddingResult: { embedding: null, hash: null }
    };
  }
}

/**
 * Load the embedding pipeline in the background service worker
 * This works because service workers CAN load ESM modules
 */
async function loadEmbeddingPipeline() {
  if (embeddingPipeline) {
    console.log('[Horizon][Embed] Using cached pipeline instance');
    return embeddingPipeline;
  }
  
  if (embeddingPipelinePromise) {
    console.log('[Horizon][Embed] Pipeline already loading, awaiting existing promise...');
    return embeddingPipelinePromise;
  }
  
  console.log('[Horizon][Embed] Initializing transformers.js pipeline in SW...');
  
  embeddingPipelinePromise = (async () => {
    try {
      // 1. Use statically imported transformers.js module (no dynamic import allowed in MV3 SW)
      console.log('[Horizon][Embed] Using statically imported transformers module');
      
      if (!transformersModule || !transformersModule.pipeline) {
        const availableExports = transformersModule ? Object.keys(transformersModule).slice(0, 20).join(', ') : 'null';
        throw new Error('transformers module missing pipeline function. Available exports: ' + availableExports);
      }
      
      if (!transformersModule.env) {
        throw new Error('transformers module missing env object');
      }
      
      const { pipeline, env } = transformersModule;
      
      // 2. Configure environment for WASM-only backend in SW
      console.log('[Horizon][Embed] Configuring transformers env for WASM backend...');
      
      // Force WASM backend only (no WebGPU in service workers)
      env.backends = ['wasm'];
      env.allowRemoteModels = true;  // Allow downloading models from HuggingFace
      env.useBrowserCache = true;    // Cache downloaded models
      
      // Set WASM paths
      const wasmBasePath = chrome.runtime.getURL('libs/transformers/dist/');
      env.paths = env.paths || {};
      env.paths.wasm = wasmBasePath;
      
      // Also set the ONNX WASM paths if available
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = wasmBasePath;
      }
      
      console.log('[Horizon][Embed] env.paths.wasm:', env.paths.wasm);
      console.log('[Horizon][Embed] env.backends:', env.backends);
      console.log('[Horizon][Embed] env.allowRemoteModels:', env.allowRemoteModels);
      console.log('[Horizon][Embed] env.useBrowserCache:', env.useBrowserCache);
      
      // 3. Create the embedding pipeline
      console.log('[Horizon][Embed] Creating pipeline for Xenova/all-MiniLM-L6-v2...');
      
      const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      
      if (!pipe) {
        throw new Error('Pipeline creation returned null/undefined');
      }
      
      console.log('[Horizon][Embed] Pipeline created successfully in SW');
      console.log('[Horizon][Embed] Pipeline type:', typeof pipe);
      console.log('[Horizon][Embed] Pipeline device:', pipe.device || 'unknown');
      
      // Test the pipeline immediately
      try {
        console.log('[Horizon][Embed] Testing pipeline with sample text "test"...');
        const testOutput = await pipe('test', { pooling: 'mean', normalize: true });
        
        let testData;
        if (Array.isArray(testOutput)) {
          testData = testOutput[0]?.data ?? testOutput[0];
        } else {
          testData = testOutput?.data ?? testOutput;
        }
        
        if (testData && typeof testData.length === 'number') {
          const testArray = Array.from(testData);
          console.log('[Horizon][Embed] Pipeline test successful, embedding dimensions:', testArray.length);
          if (testArray.length === 0) {
            console.error('[Horizon][Embed] WARNING: Pipeline test returned empty embedding!');
          }
        } else {
          console.warn('[Horizon][Embed] Pipeline test output format unexpected:', {
            type: typeof testOutput,
            isArray: Array.isArray(testOutput),
            hasData: !!testOutput?.data,
            keys: testOutput ? Object.keys(testOutput).slice(0, 10) : []
          });
        }
      } catch (testError) {
        console.error('[Horizon][Embed] Pipeline test failed:', testError.message);
        console.error('[Horizon][Embed] Test error details:', {
          name: testError.name,
          stack: testError.stack
        });
        // Don't throw - pipeline might still work, but log the error
      }
      
      embeddingPipeline = pipe;
      return pipe;
    } catch (err) {
      console.error('[Horizon][Embed] FAILED to init embedding pipeline in SW:', err);
      console.error('[Horizon][Embed] Error details:', {
        name: err.name,
        message: err.message,
        stack: err.stack
      });
      // Reset so we can retry later if needed
      embeddingPipelinePromise = null;
      throw err;
    }
  })();
  
  return embeddingPipelinePromise;
}

/**
 * Convert tensor result to embedding array
 */
function tensorToArray(result) {
  if (!result) {
    return null;
  }
  
  // If already an array
  if (Array.isArray(result)) {
    return result;
  }
  
  // If has data property (Tensor object)
  if (result.data) {
    if (result.data instanceof Float32Array || 
        result.data instanceof Float64Array ||
        result.data instanceof Int8Array ||
        result.data instanceof Uint8Array ||
        result.data instanceof Array) {
      
      let embeddingArray = null;
      if (result.dims && Array.isArray(result.dims)) {
        if (result.dims.length === 2 && result.dims[0] === 1) {
          // Shape is [1, 384], extract first 384 elements
          const size = result.dims[1];
          embeddingArray = Array.from(result.data.slice(0, size));
        } else if (result.dims.length === 1) {
          // Shape is [384], use all elements
          embeddingArray = Array.from(result.data);
        } else {
          // Multi-dimensional, flatten it
          const expectedSize = result.dims.reduce((a, b) => a * b, 1);
          embeddingArray = Array.from(result.data.slice(0, expectedSize));
        }
      } else {
        // No dims info, use all data
        embeddingArray = Array.from(result.data);
      }
      
      if (embeddingArray && embeddingArray.length > 0) {
        // Normalize values to fixed precision
        return embeddingArray
          .filter(v => typeof v === 'number' && !isNaN(v) && isFinite(v))
          .map((value) => Number(Number(value).toFixed(6)));
      }
    } else if (result.data.length !== undefined) {
      return Array.from(result.data);
    }
  }
  
  // Check for tolist method
  if (typeof result.tolist === 'function') {
    let embeddingArray = result.tolist();
    if (Array.isArray(embeddingArray) && embeddingArray.length === 1 && Array.isArray(embeddingArray[0])) {
      embeddingArray = embeddingArray[0];
    }
    return embeddingArray;
  }
  
  // Check for toArray method
  if (typeof result.toArray === 'function') {
    return result.toArray();
  }
  
  // Last resort: try Array.from
  try {
    return Array.from(result);
  } catch (e) {
    return null;
  }
}

async function hashText(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function loadEmbeddingCacheFromStorage() {
  if (embeddingCacheLoaded) {
    return;
  }
  try {
    const stored = await chrome.storage.local.get([EMBEDDING_CACHE_KEY]);
    const entries = stored[EMBEDDING_CACHE_KEY]?.entries;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (entry.hash && Array.isArray(entry.embedding)) {
          embeddingCache.set(entry.hash, entry.embedding);
          embeddingCacheOrder.push(entry.hash);
        }
      }
    }
  } catch (error) {
    console.error('[Horizon] Failed to load embedding cache:', error);
  } finally {
    embeddingCacheLoaded = true;
  }
}

async function persistEmbeddingCache() {
  const entries = embeddingCacheOrder.map((hash) => ({
    hash,
    embedding: embeddingCache.get(hash)
  }));
  try {
    await chrome.storage.local.set({
      [EMBEDDING_CACHE_KEY]: {
        version: 1,
        entries
      }
    });
  } catch (error) {
    console.error('[Horizon] Failed to persist embedding cache:', error);
  }
}

async function rememberEmbedding(hash, embedding) {
  embeddingCache.set(hash, embedding);
  const existingIndex = embeddingCacheOrder.indexOf(hash);
  if (existingIndex !== -1) {
    embeddingCacheOrder.splice(existingIndex, 1);
  }
  embeddingCacheOrder.push(hash);
  while (embeddingCacheOrder.length > MAX_EMBEDDING_CACHE_ENTRIES) {
    const oldest = embeddingCacheOrder.shift();
    if (oldest) {
      embeddingCache.delete(oldest);
    }
  }
  await persistEmbeddingCache();
}

/**
 * Generate embedding in background service worker
 * This is the main embedding function with explicit error handling
 */
async function generateEmbeddingInBackground(text) {
  console.log('[Horizon][Embed] generateEmbeddingInBackground called with text:', text?.substring(0, 50) || 'null');
  
  try {
    if (!text || typeof text !== 'string' || !text.trim()) {
      console.warn('[Horizon][Embed] Empty or invalid text for embedding');
      return { hasEmbedding: false, embeddingLength: 0, embedding: null };
    }
    
    const normalized = text.trim();
    
    // Check cache first
    await loadEmbeddingCacheFromStorage();
    const hash = await hashText(normalized);
    
    if (embeddingCache.has(hash)) {
      const cachedEmbedding = embeddingCache.get(hash);
      console.log('[Horizon][Embed] Using cached embedding, length:', cachedEmbedding.length);
      return {
        hasEmbedding: true,
        embeddingLength: cachedEmbedding.length,
        embedding: cachedEmbedding,
        hash
      };
    }
    
    // Get pipeline
    console.log('[Horizon][Embed] Getting embedding pipeline...');
    const pipeline = await loadEmbeddingPipeline();
    
    if (!pipeline) {
      console.error('[Horizon][Embed] Pipeline not available after load');
      return { hasEmbedding: false, embeddingLength: 0, embedding: null, hash };
    }
    
    // Call pipeline - THIS IS WHERE TEXT IS PASSED TO THE MODEL
    console.log('[Horizon][Embed] STEP 1: Passing text to embedding model:', normalized);
    console.log('[Horizon][Embed] Text length:', normalized.length, 'characters');
    
    const output = await pipeline(normalized, {
      pooling: 'mean',
      normalize: true
    });
    
    console.log('[Horizon][Embed] STEP 2: Model returned output');
    console.log('[Horizon][Embed] Output structure:', {
      type: typeof output,
      isArray: Array.isArray(output),
      hasData: !!output?.data,
      dataType: output?.data?.constructor?.name,
      dataLength: output?.data?.length,
      hasDims: !!output?.dims,
      dims: output?.dims,
      keys: output ? Object.keys(output).slice(0, 15) : [],
      hasTolist: typeof output?.tolist === 'function',
      hasToArray: typeof output?.toArray === 'function'
    });
    
    // Extract data from output - match embedder.js logic exactly
    // transformers.js 3.x returns a Tensor-like object { data, dims }
    let embeddingArray = null;
    
    if (!output) {
      console.error('[Horizon][Embed] Pipeline returned null/undefined');
      return { hasEmbedding: false, embeddingLength: 0, embedding: null, hash };
    }
    
    // Check if result is already an array (unlikely but possible)
    if (Array.isArray(output)) {
      embeddingArray = output;
      console.log('[Horizon][Embed] Output is already an array, length:', embeddingArray.length);
    }
    // Check if result has a data property (Tensor object) - most common case
    else if (output?.data) {
      // Handle Float32Array, Float64Array, or similar TypedArrays
      if (output.data instanceof Float32Array || 
          output.data instanceof Float64Array ||
          output.data instanceof Int8Array ||
          output.data instanceof Uint8Array ||
          output.data instanceof Array) {
        
        // Calculate expected size from dimensions
        let expectedSize = output.data.length;
        if (output.dims && Array.isArray(output.dims)) {
          expectedSize = output.dims.reduce((a, b) => a * b, 1);
          
          if (output.dims.length === 2 && output.dims[0] === 1) {
            // Shape is [1, 384], extract first 384 elements
            const size = output.dims[1];
            embeddingArray = Array.from(output.data.slice(0, size));
            console.log('[Horizon][Embed] Extracted from [1, 384] shape, got', embeddingArray.length, 'elements');
          } else if (output.dims.length === 1) {
            // Shape is [384], use all elements
            embeddingArray = Array.from(output.data);
            console.log('[Horizon][Embed] Extracted from [384] shape, got', embeddingArray.length, 'elements');
          } else {
            // Multi-dimensional, flatten it
            embeddingArray = Array.from(output.data.slice(0, expectedSize));
            console.log('[Horizon][Embed] Extracted from shape', output.dims, ', got', embeddingArray.length, 'elements');
          }
        } else {
          // No dims info, use all data
          embeddingArray = Array.from(output.data);
          console.log('[Horizon][Embed] No dims info, using all data, got', embeddingArray.length, 'elements');
        }
      } 
      // Handle array-like objects
      else if (output.data.length !== undefined) {
        embeddingArray = Array.from(output.data);
        console.log('[Horizon][Embed] Extracted from array-like data, got', embeddingArray.length, 'elements');
      } else {
        console.error('[Horizon][Embed] output.data is not array-like:', typeof output.data, output.data);
        return { hasEmbedding: false, embeddingLength: 0, embedding: null, hash };
      }
    }
    // Check for tolist method (some tensor implementations)
    else if (typeof output.tolist === 'function') {
      console.log('[Horizon][Embed] Using tolist() method');
      embeddingArray = output.tolist();
      // Flatten if nested
      if (Array.isArray(embeddingArray) && embeddingArray.length === 1 && Array.isArray(embeddingArray[0])) {
        embeddingArray = embeddingArray[0];
      }
      console.log('[Horizon][Embed] Got', embeddingArray.length, 'elements from tolist()');
    }
    // Check for toArray method
    else if (typeof output.toArray === 'function') {
      console.log('[Horizon][Embed] Using toArray() method');
      embeddingArray = output.toArray();
      console.log('[Horizon][Embed] Got', embeddingArray.length, 'elements from toArray()');
    }
    // Last resort: try Array.from
    else {
      try {
        console.log('[Horizon][Embed] Trying Array.from as last resort');
        embeddingArray = Array.from(output);
        console.log('[Horizon][Embed] Got', embeddingArray.length, 'elements from Array.from()');
      } catch (e) {
        console.error('[Horizon][Embed] Cannot convert result to array. Result structure:', {
          type: typeof output,
          keys: Object.keys(output || {}),
          output: output
        });
        return { hasEmbedding: false, embeddingLength: 0, embedding: null, hash };
      }
    }
    
    // Ensure we have a valid array
    if (!embeddingArray || !Array.isArray(embeddingArray) || embeddingArray.length === 0) {
      console.error('[Horizon][Embed] Failed to extract embedding array. Output was:', output);
      return { hasEmbedding: false, embeddingLength: 0, embedding: null, hash };
    }
    
    console.log('[Horizon][Embed] STEP 3: Extracted embedding array, length:', embeddingArray.length);
    
    // Normalize values to fixed precision (for consistency with logistic regression)
    const normalizedEmbedding = embeddingArray
      .filter(v => typeof v === 'number' && !isNaN(v) && isFinite(v))
      .map((value) => Number(Number(value).toFixed(6)));
    
    if (normalizedEmbedding.length === 0) {
      console.error('[Horizon][Embed] Embedding array is empty after filtering invalid values');
      console.error('[Horizon][Embed] Original array length:', embeddingArray.length);
      return { hasEmbedding: false, embeddingLength: 0, embedding: null, hash };
    }
    
    console.log('[Horizon][Embed] STEP 4: Normalized embedding, final length:', normalizedEmbedding.length);
    
    // Cache the embedding
    await rememberEmbedding(hash, normalizedEmbedding);
    
    console.log('[Horizon][Embed] Successfully generated embedding, length:', normalizedEmbedding.length);
    
    return {
      hasEmbedding: true,
      embeddingLength: normalizedEmbedding.length,
      embedding: normalizedEmbedding,
      hash
    };
  } catch (err) {
    console.error('[Horizon][Embed] Error generating embedding in SW:', err);
    console.error('[Horizon][Embed] Error details:', {
      name: err.name,
      message: err.message,
      stack: err.stack
    });
    return { hasEmbedding: false, embeddingLength: 0, embedding: null, error: String(err) };
  }
}

/**
 * Get embedding for text (wrapper for backward compatibility)
 * Now runs in background service worker (can load ESM modules)
 */
async function getEmbedding(text, tabId = null) {
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized) {
    return { embedding: null, hash: null };
  }

  const result = await generateEmbeddingInBackground(normalized);
  
  if (result.hasEmbedding && result.embedding) {
    return { embedding: result.embedding, hash: result.hash };
  } else {
    return { embedding: null, hash: result.hash || null };
  }
}


// Store engagement data
async function storeEngagement(data) {
  const today = getLocalDateString(); // YYYY-MM-DD in local timezone
  const key = `day_${today}`;
  
  // Get existing data for today
  const result = await chrome.storage.local.get([key]);
  const existing = result[key] || {
    day: today,
    byDomain: {},
    byContentType: {},
    byTopic: {},
    byTopicCounts: {},
    totalMs: 0,
    embeddingSamples: [],
    seenPosts: {} // Track seen posts by embedding hash to prevent duplicates
  };
  
  // Initialize byTopic if not present (for backward compatibility)
  if (!existing.byTopic) {
    existing.byTopic = {};
  }
  if (!existing.byTopicCounts) {
    existing.byTopicCounts = {};
  }
  if (!Array.isArray(existing.embeddingSamples)) {
    existing.embeddingSamples = [];
  }
  if (!existing.seenPosts) {
    existing.seenPosts = {};
  }
  
  // Update domain
  const domain = data.domain || 'unknown';
  existing.byDomain[domain] = (existing.byDomain[domain] || 0) + data.deltaMs;
  
  // Update content type
  const contentType = data.contentType || 'unknown';
  existing.byContentType[contentType] = (existing.byContentType[contentType] || 0) + data.deltaMs;
  
  // Skip topic updates if title is empty or invalid
  const hasValidTitle = data.title && typeof data.title === 'string' && data.title.trim().length > 5;
  
  // Update topic classification if available
  // Only count unique posts (by embedding hash) to avoid duplicates
  // IMPORTANT: Don't count "unknown" topics from empty titles
  if (data.topic && data.embeddingHash && hasValidTitle && data.topic !== 'unknown') {
    const topic = data.topic;
    existing.byTopic[topic] = (existing.byTopic[topic] || 0) + data.deltaMs;
    console.log(`[Horizon] Updated topic ${topic}: ${existing.byTopic[topic]}ms total`);
    
    // Only increment count if we haven't seen this post before
    if (!existing.seenPosts[data.embeddingHash]) {
      existing.byTopicCounts[topic] = (existing.byTopicCounts[topic] || 0) + 1;
      existing.seenPosts[data.embeddingHash] = {
        topic: topic,
        firstSeen: data.capturedAt || Date.now(),
        title: data.title || null,
        lrConfidence: data.lrConfidence || null
      };
    
    // Track LR probabilities per topic (average confidence scores)
    if (!existing.lrProbabilities) {
      existing.lrProbabilities = {};
    }
    if (!existing.lrProbabilities[topic]) {
      existing.lrProbabilities[topic] = {
        sum: 0,
        count: 0,
        average: 0
      };
    }
    if (data.lrConfidence && typeof data.lrConfidence === 'number') {
      existing.lrProbabilities[topic].sum += data.lrConfidence;
      existing.lrProbabilities[topic].count += 1;
      existing.lrProbabilities[topic].average = existing.lrProbabilities[topic].sum / existing.lrProbabilities[topic].count;
    }
      console.log(`[Horizon] New post counted for topic ${topic} (hash: ${data.embeddingHash.substring(0, 8)}...)`);
    } else {
      console.log(`[Horizon] Post already seen, skipping count increment (hash: ${data.embeddingHash.substring(0, 8)}...)`);
    }
  } else if (data.topic && hasValidTitle && data.topic !== 'unknown') {
    // If we have a topic but no hash, still update time but don't count
    const topic = data.topic;
    existing.byTopic[topic] = (existing.byTopic[topic] || 0) + data.deltaMs;
  } else if (!hasValidTitle) {
    console.log('[Horizon] Skipping topic update: empty or invalid title');
  }
  
  if (Array.isArray(data.embedding) && data.embedding.length > 0) {
    const sample = {
      domain,
      contentType,
      topic: data.topic || null,
      hash: data.embeddingHash || null,
      embedding: data.embedding,
      capturedAt: data.capturedAt
    };
    existing.embeddingSamples.push(sample);
    if (existing.embeddingSamples.length > 50) {
      existing.embeddingSamples = existing.embeddingSamples.slice(-50);
    }
  }

  // Update total
  existing.totalMs += data.deltaMs;
  
  // Save back
  await chrome.storage.local.set({ [key]: existing });
  
  console.log(`[Horizon] Stored ${data.deltaMs}ms for ${domain}, total today: ${existing.totalMs}ms`);
  
  // Update badge to show tracking is active
  updateBadge(existing.totalMs);
}

// Update extension badge with tracked time
async function updateBadge(totalMs) {
  try {
    const minutes = Math.round(totalMs / (1000 * 60));
    if (minutes > 0) {
      // Show minutes on badge (max 99+ for display)
      const badgeText = minutes > 99 ? '99+' : String(minutes);
      await chrome.action.setBadgeText({ text: badgeText });
      await chrome.action.setBadgeBackgroundColor({ color: '#2b6cb0' });
    } else {
      // Clear badge if no tracking data
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (error) {
    // Ignore badge update errors (may fail in some contexts)
    console.log('[Horizon] Badge update skipped:', error.message);
  }
}

// Get today's summary
async function getTodaySummary(skipRecommendationCheck = false) {
  const today = getLocalDateString();
  const key = `day_${today}`;
  
  // Only check for day-end and generate recommendations if not skipped
  // This allows the popup to load summary first, then generate recommendations separately
  if (!skipRecommendationCheck) {
    await checkDayEndAndGenerateRecommendations();
  }
  
  // Clear old daily data when accessing today's summary
  // This ensures old data is cleaned up when the popup is opened
  // BUT: We preserve yesterday's data if recommendations haven't been generated yet
  await clearOldDailyData();
  
  const result = await chrome.storage.local.get([key]);
  const summary = result[key] || {
    day: today,
    byDomain: {},
    byContentType: {},
    byTopic: {},
    byTopicCounts: {},
    totalMs: 0,
    embeddingSamples: []
  };
  
  // Ensure byTopic exists for backward compatibility
  if (!summary.byTopic) {
    summary.byTopic = {};
  }
  if (!summary.byTopicCounts) {
    summary.byTopicCounts = {};
  }
  if (!Array.isArray(summary.embeddingSamples)) {
    summary.embeddingSamples = [];
  }
  if (!summary.lrProbabilities) {
    summary.lrProbabilities = {};
  }
  
  // Aggregate LR probabilities into simple map for recommendations
  const lrProbMap = {};
  if (summary.lrProbabilities && typeof summary.lrProbabilities === 'object') {
    Object.keys(summary.lrProbabilities).forEach(topic => {
      const probData = summary.lrProbabilities[topic];
      if (probData && typeof probData.average === 'number') {
        lrProbMap[topic] = probData.average;
      }
    });
  }
  summary.lrProbabilities = lrProbMap;
  
  // Debug logging
  console.log('[Horizon] Summary requested:', {
    day: today,
    byTopicKeys: Object.keys(summary.byTopic),
    byTopicValues: summary.byTopic,
    totalMs: summary.totalMs,
    lrProbabilities: Object.keys(summary.lrProbabilities).length
  });
  
  return summary;
}

// Get previous day's summary (the data used for recommendations)
async function getPreviousDaySummary() {
  try {
    // First, try to get the stored summary snapshot (most reliable)
    const stored = await chrome.storage.local.get(['horizon_recommendations_date', 'horizon_recommendations_summary']);
    const summarySnapshot = stored.horizon_recommendations_summary;
    let recommendationsDate = stored.horizon_recommendations_date;
    
    console.log('[Horizon] getPreviousDaySummary - recommendationsDate from storage:', recommendationsDate);
    console.log('[Horizon] getPreviousDaySummary - summary snapshot exists:', !!summarySnapshot);
    
    // If we have a stored snapshot, use it (this is the most reliable source)
    if (summarySnapshot && summarySnapshot.day) {
      console.log('[Horizon] getPreviousDaySummary - using stored summary snapshot for:', summarySnapshot.day);
      // Ensure all required fields exist
      const summary = {
        day: summarySnapshot.day,
        byDomain: summarySnapshot.byDomain || {},
        byContentType: summarySnapshot.byContentType || {},
        byTopic: summarySnapshot.byTopic || {},
        byTopicCounts: summarySnapshot.byTopicCounts || {},
        totalMs: summarySnapshot.totalMs || 0,
        embeddingSamples: summarySnapshot.embeddingSamples || [],
        lrProbabilities: summarySnapshot.lrProbabilities || {},
        seenPosts: summarySnapshot.seenPosts || {}
      };
      
      // Debug logging
      console.log('[Horizon] Previous day summary retrieved from snapshot:', {
        day: summary.day,
        totalMs: summary.totalMs,
        byTopicCountsKeys: Object.keys(summary.byTopicCounts),
        byTopicCountsTotal: Object.values(summary.byTopicCounts).reduce((sum, count) => sum + count, 0),
        byTopicKeys: Object.keys(summary.byTopic),
        byTopicTotal: Object.values(summary.byTopic).reduce((sum, time) => sum + (time || 0), 0),
        seenPostsCount: Object.keys(summary.seenPosts).length
      });
      
      return summary;
    }
    
    // If no snapshot but we have a recommendations date, the data should still be in storage
    // (preserved by clearOldDailyData). Try to get it from storage.
    
    // If no snapshot, try to get the data from storage (fallback)
    // If no recommendations date, try to get yesterday's data
    if (!recommendationsDate) {
      const yesterday = getYesterdayDateString();
      const yesterdayKey = `day_${yesterday}`;
      const yesterdayData = await chrome.storage.local.get([yesterdayKey]);
      
      console.log('[Horizon] getPreviousDaySummary - no recommendations date, checking yesterday:', yesterday, 'found:', !!yesterdayData[yesterdayKey]);
      
      if (yesterdayData[yesterdayKey]) {
        recommendationsDate = yesterday;
      } else {
        // Try to find the most recent day's data (excluding today)
        const today = getLocalDateString();
        const allData = await chrome.storage.local.get(null);
        const dayKeys = Object.keys(allData).filter(key => key.startsWith('day_') && key !== `day_${today}`);
        
        console.log('[Horizon] getPreviousDaySummary - searching for most recent day, found keys:', dayKeys);
        
        if (dayKeys.length > 0) {
          // Sort day keys by date (most recent first)
          dayKeys.sort((a, b) => {
            const dateA = a.replace('day_', '');
            const dateB = b.replace('day_', '');
            return dateB.localeCompare(dateA); // Descending order
          });
          
          const mostRecentKey = dayKeys[0];
          recommendationsDate = mostRecentKey.replace('day_', '');
          console.log('[Horizon] getPreviousDaySummary - using most recent day:', recommendationsDate);
        } else {
          // No previous day data available
          console.log('[Horizon] getPreviousDaySummary - no previous day data available');
          return null;
        }
      }
    }
    
    // Get the data for that date
    const key = `day_${recommendationsDate}`;
    console.log('[Horizon] getPreviousDaySummary - looking for data with key:', key);
    const result = await chrome.storage.local.get([key]);
    const data = result[key];
    
    console.log('[Horizon] getPreviousDaySummary - data found:', !!data, 'keys in result:', Object.keys(result));
    
    if (!data) {
      // Data might have been cleared already - let's check all day_ keys
      const allData = await chrome.storage.local.get(null);
      const allDayKeys = Object.keys(allData).filter(k => k.startsWith('day_'));
      console.log('[Horizon] getPreviousDaySummary - data not found. All day_ keys in storage:', allDayKeys);
      return null;
    }
    
    // Ensure all required fields exist and are properly initialized
    const summary = {
      day: data.day || recommendationsDate,
      byDomain: data.byDomain || {},
      byContentType: data.byContentType || {},
      byTopic: data.byTopic || {},
      byTopicCounts: data.byTopicCounts || {},
      totalMs: data.totalMs || 0,
      embeddingSamples: data.embeddingSamples || [],
      lrProbabilities: data.lrProbabilities || {},
      seenPosts: data.seenPosts || {} // Include seenPosts for potential fallback calculations
    };
    
    // Ensure byTopicCounts is properly initialized (should already be, but double-check)
    if (!summary.byTopicCounts || typeof summary.byTopicCounts !== 'object') {
      summary.byTopicCounts = {};
    }
    
    // Debug logging to help diagnose data issues
    console.log('[Horizon] Previous day summary retrieved:', {
      day: summary.day,
      totalMs: summary.totalMs,
      byTopicCountsKeys: Object.keys(summary.byTopicCounts),
      byTopicCountsTotal: Object.values(summary.byTopicCounts).reduce((sum, count) => sum + count, 0),
      byTopicKeys: Object.keys(summary.byTopic),
      byTopicTotal: Object.values(summary.byTopic).reduce((sum, time) => sum + (time || 0), 0),
      seenPostsCount: Object.keys(summary.seenPosts).length
    });
    
    return summary;
  } catch (error) {
    console.error('[Horizon] Error getting previous day summary:', error);
    return null;
  }
}

// Generate recommendations using SmolLM-135M (wrapper function)
async function generateSmolLMRecommendationsWrapper() {
  try {
    // Get settings
    const { settings } = await chrome.storage.local.get(['settings']);

    // Get consumption data
    const summary = await getTodaySummary();
    
    // Check if we have enough data
    if (summary.totalMs < 60000) { // Less than 1 minute
      return {
        success: false,
        error: 'Not enough consumption data. Use the extension for a while to get recommendations.'
      };
    }
    
    // Get a random post title from seenPosts
    let randomPostTitle = null;
    if (summary.seenPosts && typeof summary.seenPosts === 'object') {
      const postEntries = Object.values(summary.seenPosts).filter(post => post && post.title && post.title.trim().length > 5);
      if (postEntries.length > 0) {
        const randomIndex = Math.floor(Math.random() * postEntries.length);
        randomPostTitle = postEntries[randomIndex].title;
        console.log('[Horizon] Selected random post title for SmolLM recommendations:', randomPostTitle.substring(0, 100));
      }
    }
    
    // Generate recommendations using SmolLM
    console.log('[Horizon] 📞 Calling generateSmolLMRecommendations from smollm_recommender.js');
    console.log('[Horizon] Consumption data:', {
      topics: Object.keys(summary.byTopicCounts || {}).length,
      totalPosts: Object.values(summary.byTopicCounts || {}).reduce((a, b) => a + b, 0),
      totalTimeMs: summary.totalMs || 0,
      hasSamplePost: !!randomPostTitle
    });
    const recommendations = await generateSmolLMRecommendations({
      byTopicCounts: summary.byTopicCounts || {},
      byTopic: summary.byTopic || {},
      lrProbabilities: summary.lrProbabilities || {},
      samplePostTitle: randomPostTitle
    });
    console.log('[Horizon] Recommendations received from SmolLM (length:', recommendations.length, 'chars)');
    console.log('[Horizon] Recommendations preview:', recommendations.substring(0, 200));

    // Check if we got a valid response (not the error message)
    const errorMessage = 'Unable to generate specific recommendations';
    if (recommendations && recommendations.includes(errorMessage)) {
      console.warn('[Horizon] Received error message from SmolLM, treating as failure');
      return {
        success: false,
        error: 'SmolLM generated an error message. The model output may not match the expected format. Please try again.'
      };
    }

    // Check if recommendations are too short (likely invalid)
    if (!recommendations || recommendations.trim().length < 20) {
      console.warn('[Horizon] Recommendations too short, treating as failure');
      return {
        success: false,
        error: 'Generated recommendations are too short or empty. Please try again.'
      };
    }

    // Store the generation time
    await chrome.storage.local.set({ 
      lastSmolLMRecommendationTime: Date.now()
    });

    return {
      success: true,
      recommendations: recommendations || ''
    };
  } catch (error) {
    console.error('[Horizon] Error generating SmolLM recommendations:', error);
    
    return {
      success: false,
      error: error.message || 'Failed to generate recommendations with SmolLM. Please try again later.'
    };
  }
}

// Generate recommendations using embedding-based analysis via background_llm.js
async function generateRecommendations() {
  try {
    // Get settings
    const { settings } = await chrome.storage.local.get(['settings']);

    // Get consumption data
    const summary = await getTodaySummary();
    
    // Check if we have enough data
    if (summary.totalMs < 60000) { // Less than 1 minute
      return {
        success: false,
        error: 'Not enough consumption data. Use the extension for a while to get recommendations.'
      };
    }
    
    // Get a random post title from seenPosts
    let randomPostTitle = null;
    if (summary.seenPosts && typeof summary.seenPosts === 'object') {
      const postEntries = Object.values(summary.seenPosts).filter(post => post && post.title && post.title.trim().length > 5);
      if (postEntries.length > 0) {
        const randomIndex = Math.floor(Math.random() * postEntries.length);
        randomPostTitle = postEntries[randomIndex].title;
        console.log('[Horizon] Selected random post title for ChatGPT recommendations:', randomPostTitle.substring(0, 100));
      }
    }
    
    // Generate recommendations using background_llm.js module (dedicated LLM handler)
    // Send post counts per topic (byTopicCounts) and time spent (byTopic)
    console.log('[Horizon] 📞 Calling llmGenerateRecommendations from background_llm.js');
    console.log('[Horizon] Consumption data:', {
      topics: Object.keys(summary.byTopicCounts || {}).length,
      totalPosts: Object.values(summary.byTopicCounts || {}).reduce((a, b) => a + b, 0),
      totalTimeMs: summary.totalMs || 0,
      hasSamplePost: !!randomPostTitle
    });
    const recommendations = await llmGenerateRecommendations({
      byTopicCounts: summary.byTopicCounts || {},
      byTopic: summary.byTopic || {},
      lrProbabilities: summary.lrProbabilities || {},
      samplePostTitle: randomPostTitle
    });
    console.log('[Horizon] Recommendations received from background_llm.js (length:', recommendations.length, 'chars)');

    // Store the generation time (both for 4-hour cooldown and 30-second cooldown)
    await chrome.storage.local.set({ 
      lastRecommendationTime: Date.now(),
      lastLLMRequest: Date.now() // Also store for 30-second cooldown
    });

    return {
      success: true,
      recommendations: recommendations || ''
    };
  } catch (error) {
    console.error('[Horizon] Error generating recommendations:', error);
    
    // Check if it's a cooldown error
    if (error.cooldownRemaining) {
      return {
        success: false,
        error: error.message || 'Please wait before requesting again.',
        cooldownRemaining: error.cooldownRemaining
      };
    }
    
    return {
      success: false,
      error: error.message || 'Failed to generate recommendations'
    };
  }
}

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    
    if (msg.type === 'engagement_time') {
      const { settings } = await chrome.storage.local.get(['settings']);
      if (!settings || settings.enableTracking !== true) {
        console.log('[Horizon] Tracking disabled; engagement message ignored.');
        sendResponse({ success: false, disabled: true });
        return;
      }
      if (settings.includeTitles !== true && msg.title) {
        delete msg.title;
      }
      // Try to classify if ML is enabled (logistic regression)
      let topic = null;
      let embeddingResult = { embedding: null, hash: null };
      let lrConfidence = null;
      try {
        console.log('[Horizon] Settings check:', { 
          enableML: settings.enableML,
          hasTitle: !!(msg.title),
          titleLength: msg.title?.length || 0
        });
        
        // Check if logistic regression classification is enabled
        if (settings.enableML === true) {
          const title = msg.title || '';
          console.log('[Horizon] Title received:', title.substring(0, 100));
          
          if (title && title.length > 5) {
            // Get tabId from sender for embedding generation
            const tabId = sender?.tab?.id || null;
            console.log('[Horizon] Classifying post:', title.substring(0, 100));
            console.log('[Horizon] Calling classifyText with tabId:', tabId);
            
            try {
              const classificationResult = await classifyText(title, tabId);
              
              console.log('[Horizon] Classification result received:', {
                category: classificationResult?.category,
                confidence: classificationResult?.confidence,
                classifierType: classificationResult?.classifierType,
                hasEmbedding: !!(classificationResult?.embeddingResult?.embedding)
              });
              
              topic = classificationResult?.category || 'unknown';
              embeddingResult = classificationResult?.embeddingResult || { embedding: null, hash: null };
              lrConfidence = classificationResult?.confidence || null;
              
              console.log('[Horizon] Final topic:', topic, 'confidence:', classificationResult?.confidence, 'classifier:', classificationResult?.classifierType);
              
              if (topic === 'unknown') {
                console.warn('[Horizon] Classification returned unknown topic. Check classifier configuration.');
                console.warn('[Horizon] Diagnostic info:', {
                  enableML: settings.enableML,
                  classifierType: classificationResult?.classifierType,
                  confidence: classificationResult?.confidence
                });
              }
            } catch (classifyError) {
              console.error('[Horizon] Classification threw an error:', {
                error: classifyError.message,
                stack: classifyError.stack,
                title: title.substring(0, 50)
              });
              topic = 'unknown';
              embeddingResult = { embedding: null, hash: null };
              lrConfidence = null;
            }
          } else {
            console.log('[Horizon] Title too short or empty, skipping classification. Title length:', title.length);
          }
        } else {
          console.log('[Horizon] Classification not enabled in settings (logistic regression)');
          console.log('[Horizon] Current settings:', {
            enableML: settings.enableML
          });
        }
      } catch (error) {
        console.error('[Horizon] Error during classification:', {
          error: error.message,
          stack: error.stack,
          title: msg.title?.substring(0, 50) || 'no title'
        });
        // Continue even if classification fails
      }
      
      // Skip storing if title is empty or invalid (don't pollute statistics)
      const hasValidTitle = msg.title && typeof msg.title === 'string' && msg.title.trim().length > 5;
      if (!hasValidTitle && settings.enableML === true) {
        console.log('[Horizon] Skipping storage: empty or invalid title');
        sendResponse({ success: true, topic: null, embeddingHash: null, skipped: true });
        return;
      }
      
      // Store the engagement data (with topic if available)
      await storeEngagement({
        ...msg,
        topic,
        embedding: embeddingResult.embedding,
        embeddingHash: embeddingResult.hash,
        lrConfidence: lrConfidence
      });
      if (topic) {
        console.log('[Horizon] Stored engagement with topic:', topic, 'for', msg.deltaMs, 'ms');
      } else {
        console.log('[Horizon] Stored engagement without topic');
      }
      sendResponse({ success: true, topic, embeddingHash: embeddingResult.hash });
    } else if (msg.type === 'get_today_summary') {
      const skipRecommendationCheck = msg.skipRecommendationCheck || false;
      const summary = await getTodaySummary(skipRecommendationCheck);
      // Update badge when popup requests summary
      await updateBadge(summary.totalMs);
      sendResponse(summary);
    } else if (msg.type === 'get_previous_day_summary') {
      const summary = await getPreviousDaySummary();
      sendResponse(summary);
    } else if (msg.type === 'generate_recommendations_for_data') {
      // Generate recommendations using data that was already loaded (to avoid redundant retrieval)
      const data = msg.data;
      const dataDate = msg.date;
      if (!data || !dataDate) {
        sendResponse({ success: false, error: 'Missing data or date' });
        return;
      }
      
      // Get settings
      const { settings } = await chrome.storage.local.get(['settings']);
      
      // Only generate if recommendations are enabled
      if (!settings || settings.enableRecommendations !== true) {
        sendResponse({ success: false, error: 'Recommendations are disabled' });
        return;
      }
      
      // Check if we have enough data
      if (!data.totalMs || data.totalMs < 60000) {
        sendResponse({ success: false, error: 'Not enough consumption data' });
        return;
      }
      
      // Get LLM preference (default to 'smollm')
      const llmPreference = settings.recommendationLLM || 'smollm';
      
      try {
        let recommendations = '';
        
        if (llmPreference === 'chatgpt') {
          // Generate using ChatGPT
          const result = await generateRecommendationsForDate(dataDate, data);
          if (result && result.success) {
            recommendations = result.recommendations || '';
          } else {
            console.warn(`[Horizon] Failed to generate ChatGPT recommendations for ${dataDate}:`, result?.error);
            // Try SmolLM as fallback
            const fallbackResult = await generateSmolLMRecommendationsForDate(dataDate, data);
            if (fallbackResult && fallbackResult.success) {
              recommendations = fallbackResult.recommendations || '';
              console.log(`[Horizon] Used SmolLM as fallback for ${dataDate}`);
            }
          }
        } else {
          // Generate using SmolLM
          const result = await generateSmolLMRecommendationsForDate(dataDate, data);
          if (result && result.success) {
            recommendations = result.recommendations || '';
          } else {
            console.warn(`[Horizon] Failed to generate SmolLM recommendations for ${dataDate}:`, result?.error);
          }
        }
        
        if (recommendations && recommendations.trim().length > 0) {
          // Store recommendations with the date from the data itself
          // Also store a snapshot of the summary data so it can be displayed later
          const summarySnapshot = {
            day: data.day || dataDate,
            byDomain: data.byDomain || {},
            byContentType: data.byContentType || {},
            byTopic: data.byTopic || {},
            byTopicCounts: data.byTopicCounts || {},
            totalMs: data.totalMs || 0,
            embeddingSamples: data.embeddingSamples || [],
            lrProbabilities: data.lrProbabilities || {},
            seenPosts: data.seenPosts || {}
          };
          
          await chrome.storage.local.set({
            'horizon_recommendations': recommendations,
            'horizon_recommendations_date': dataDate,
            'lastRecommendationDay': dataDate,
            'horizon_recommendations_summary': summarySnapshot, // Store snapshot for display
            'horizon_summary_snapshot': summarySnapshot, // Also store as regular summary snapshot for consistency
            'horizon_summary_date': dataDate // Store the date for the summary
          });
          console.log(`[Horizon] Recommendations generated and saved for ${dataDate} (using provided data)`);
          console.log(`[Horizon] Summary snapshot stored with ${Object.keys(summarySnapshot.byTopicCounts).length} topics`);
          sendResponse({ success: true, recommendations: recommendations });
        } else {
          console.warn(`[Horizon] No recommendations generated for ${dataDate} (empty result)`);
          // Still mark as processed to avoid repeated attempts
          await chrome.storage.local.set({ 'lastRecommendationDay': dataDate });
          sendResponse({ success: false, error: 'No recommendations generated' });
        }
      } catch (error) {
        console.error(`[Horizon] Error generating recommendations for ${dataDate}:`, error);
        // Mark as processed even on error to avoid infinite retries
        await chrome.storage.local.set({ 'lastRecommendationDay': dataDate });
        sendResponse({ success: false, error: error.message || 'Failed to generate recommendations' });
      }
    } else if (msg.type === 'check_lr_model') {
      // Check if logistic regression model is loaded
      try {
        const classifier = await loadLRClassifier();
        sendResponse({ 
          isLoaded: classifier !== null && classifier.isLoaded(),
          modelInfo: classifier ? classifier.getInfo() : null
        });
      } catch (error) {
        console.error('[Horizon] Error checking logistic regression model:', error);
        sendResponse({ isLoaded: false, modelInfo: null });
      }
    } else if (msg.type === 'clear_today_data') {
      // Clear today's data (only consumption data, not logistic regression model or settings)
      try {
        const today = getLocalDateString();
        const key = `day_${today}`;
        
        // Remove today's data from storage
        await chrome.storage.local.remove([key]);
        
        // Clear badge after clearing data
        await updateBadge(0);
        
        console.log(`[Horizon] Cleared consumption data for ${today}`);
        sendResponse({ success: true, day: today });
      } catch (error) {
        console.error('[Horizon] Error clearing today\'s data:', error);
        sendResponse({ success: false, error: error.message });
      }
    } else if (msg.type === 'get_recommendations') {
      // Generate recommendations using GPT
      const result = await generateRecommendations();
      sendResponse(result);
    } else if (msg.type === 'get_smollm_recommendations') {
      // Generate recommendations using SmolLM
      const result = await generateSmolLMRecommendationsWrapper();
      sendResponse(result);
    } else if (msg.type === 'get_embedding') {
      // Handle embedding requests (for compatibility with train-lr.js)
      const result = await getEmbedding(msg.text);
      sendResponse(result);
    }
  })();
  return true; // keep the message channel open for async reply
});
