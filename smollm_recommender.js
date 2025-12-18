// smollm_recommender.js
// SmolLM-135M based recommendation system
// Uses local SmolLM model with few-shot prompting for autocomplete-based recommendations

// Import transformers module (static import for MV3)
import * as transformersModule from './libs/transformers/dist/transformers.min.js';

// Model path
const MODEL_PATH = 'libs/models/SmolLM-135M';

// Single-threading: Track if a request is in progress
let requestInProgress = false;
let requestQueue = [];

// Model pipeline cache
let textGenerationPipeline = null;
let textGenerationPipelinePromise = null;

/**
 * Load the SmolLM text generation pipeline
 */
async function loadTextGenerationPipeline() {
  if (textGenerationPipeline) {
    return textGenerationPipeline;
  }
  
  if (textGenerationPipelinePromise) {
    return textGenerationPipelinePromise;
  }
  
  textGenerationPipelinePromise = (async () => {
    try {
      if (!transformersModule || !transformersModule.pipeline) {
        throw new Error('transformers module missing pipeline function');
      }
      
      const { pipeline, env } = transformersModule;
      
      // CRITICAL FIX: Configure environment BEFORE calling pipeline()
      // This must run before any pipeline operations
      console.log('[SmolLM Recommender] Configuring environment for local models...');
      
      // Set backend to WASM (required for service workers)
      env.backends = ['wasm'];
      
      // REQUIRED: Allow loading local model files (required for Chrome extensions)
      // This must be set before calling pipeline()
      env.allowLocalModels = true;
      
      // Optional: disable remote model fetching completely
      env.allowRemoteModels = false;
      
      // Enable browser cache
      env.useBrowserCache = true;
      
      console.log('[SmolLM Recommender] Environment configured:', {
        backends: env.backends,
        allowLocalModels: env.allowLocalModels,
        allowRemoteModels: env.allowRemoteModels,
        useBrowserCache: env.useBrowserCache
      });
      
      // Set WASM paths
      const wasmBasePath = chrome.runtime.getURL('libs/transformers/dist/');
      env.paths = env.paths || {};
      env.paths.wasm = wasmBasePath;
      
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = wasmBasePath;
      }
      
      // Get model path - use chrome.runtime.getURL for local files
      const modelBasePath = chrome.runtime.getURL(MODEL_PATH + '/');
      
      console.log('[SmolLM Recommender] Loading model from:', modelBasePath);
      console.log('[SmolLM Recommender] Model path components:', {
        MODEL_PATH,
        modelBasePath,
        expectedFiles: ['model.onnx', 'config.json', 'tokenizer.json', 'tokenizer_config.json']
      });
      
      // Create the text generation pipeline
      // For local models, provide the base path and transformers.js will find the files
      // The model files should be at: modelBasePath/model.onnx, modelBasePath/config.json, etc.
      console.log('[SmolLM Recommender] Creating text-generation pipeline...');
      const pipe = await pipeline('text-generation', modelBasePath);
      
      if (!pipe) {
        throw new Error('Pipeline creation returned null/undefined');
      }
      
      textGenerationPipeline = pipe;
      console.log('[SmolLM Recommender] Model loaded successfully');
      return pipe;
    } catch (err) {
      console.error('[SmolLM Recommender] Failed to load text generation pipeline:', err);
      textGenerationPipelinePromise = null;
      throw err;
    }
  })();
  
  return textGenerationPipelinePromise;
}

/**
 * Format consumption data for the prompt
 */
function formatConsumptionData(consumptionData) {
  const { byTopicCounts = {}, byTopic = {} } = consumptionData;
  
  // Calculate totals
  const totalPosts = Object.values(byTopicCounts).reduce((sum, count) => sum + count, 0);
  const totalTimeMs = Object.values(byTopic).reduce((sum, time) => sum + (time || 0), 0);
  const totalMinutes = Math.round(totalTimeMs / (1000 * 60));
  
  // Get top topics by count
  const topTopicsByCount = Object.entries(byTopicCounts)
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  
  // Get top topics by time
  const topTopicsByTime = Object.entries(byTopic)
    .map(([topic, timeMs]) => ({ topic, timeMs, minutes: Math.round(timeMs / (1000 * 60)) }))
    .sort((a, b) => b.timeMs - a.timeMs)
    .slice(0, 10);
  
  return {
    totalPosts,
    totalMinutes,
    topTopicsByCount,
    topTopicsByTime,
    allTopics: Object.keys(byTopicCounts)
  };
}

/**
 * Build prompt with structured formatting and prefix conditioning
 * Uses few-shot examples with topic-based recommendations format
 * SmolLM responds better to constrained completions with clear structure
 */
function buildPrompt(formattedData) {
  const { topTopicsByCount, samplePostTitle } = formattedData;

  // Format user history as a simple list of topics (capitalize first letter to match examples)
  const userHistoryItems = topTopicsByCount.slice(0, 5).map(item => {
    const topic = item.topic;
    // Capitalize first letter to match the format in examples
    return topic.charAt(0).toUpperCase() + topic.slice(1).toLowerCase();
  });
  const userHistory = userHistoryItems.length > 0
    ? userHistoryItems.join(', ')
    : 'No topics tracked yet';

  // Few-shot examples with topic-based recommendations format
  const examples = `### Task

Based on the user's past content consumption, output only three topic-based recommendations. 

Each recommendation should include:

1. A main topic (from the allowed list)

2. A subtopic or angle to explore

3. A short suggestion on how to engage with that subtopic



Allowed main topics: Entertainment, People, Politics, Technology, Sports, Environment, Social, Cryptocurrency, Health, Science, Business, Finance, Investing, Economy, Law



Format:

- Recommendation 1: <Main Topic> – <Subtopic>. <How to engage.>

- Recommendation 2: <Main Topic> – <Subtopic>. <How to engage.>

- Recommendation 3: <Main Topic> – <Subtopic>. <How to engage.>



---



### User History

Technology, Science, Health



### Recommendations

- Recommendation 1: Technology – Artificial Intelligence trends. Follow AI newsletters or blogs to stay updated.

- Recommendation 2: Science – Space exploration. Listen to podcasts about recent missions and discoveries.

- Recommendation 3: Health – Mental wellness apps. Try guided meditation apps or health trackers to learn more.



---



### User History

Entertainment, Sports



### Recommendations

- Recommendation 1: Entertainment – Independent films. Watch indie film reviews or streaming recommendations.

- Recommendation 2: Sports – Basketball analytics. Follow data-driven sports analysis channels or articles.

- Recommendation 3: Entertainment – Music documentaries. Stream documentary series on emerging artists.



---



### User History

Politics, Business



### Recommendations

- Recommendation 1: Politics – Economic policy. Read policy briefings or news summaries.

- Recommendation 2: Business – Startup ecosystems. Follow newsletters or podcasts about emerging startups.

- Recommendation 3: Politics – International relations. Watch analyses or listen to interviews with diplomats.



---`;

  // Build the prompt for the current user
  let prompt = `${examples}



### User History

${userHistory}`;

  // Add sample post title if available
  if (samplePostTitle && samplePostTitle.trim().length > 0) {
    prompt += `


### Sample Post Viewed

"${samplePostTitle}"`;
  }

  prompt += `


### Recommendations

- `;

  return prompt;
}

/**
 * Generate recommendations using SmolLM with autocomplete-style prompting
 * Uses autocomplete-style generation parameters for better completion behavior
 */
async function generateWithSmolLM(prompt) {
  try {
    const pipeline = await loadTextGenerationPipeline();
    
    console.log('[SmolLM Recommender] Generating with autocomplete-style parameters...');
    console.log('[SmolLM Recommender] Prompt length:', prompt.length);
    
    // Generate text with autocomplete-style completion
    // These parameters are optimized for autocomplete behavior per the write-up
    console.log('[SmolLM Recommender] Generating with autocomplete-style parameters...');
    const outputs = await pipeline(prompt, {
      max_new_tokens: 150, // Shorter for autocomplete-style recommendations
      do_sample: true, // Enable sampling for variety
      top_k: 20, // Limit to top 20 tokens for better quality
      top_p: 0.9, // Nucleus sampling - use tokens with cumulative probability up to 0.9
      temperature: 0.8, // Slightly higher temperature for more creative completions
      return_full_text: false, // Only return generated text (not the prompt)
      pad_token_id: 0, // Use endoftext token as padding
      repetition_penalty: 1.1 // Slight penalty to avoid repetition
    });
    
    if (!outputs || !Array.isArray(outputs) || outputs.length === 0) {
      throw new Error('No output generated from model');
    }
    
    // Extract generated text
    // The output format may vary, so handle different structures
    let generatedText = '';
    if (typeof outputs[0] === 'string') {
      generatedText = outputs[0];
    } else if (outputs[0]?.generated_text) {
      generatedText = outputs[0].generated_text;
    } else if (outputs[0]?.text) {
      generatedText = outputs[0].text;
    } else {
      // Fallback: try to extract from the object
      generatedText = JSON.stringify(outputs[0]);
    }
    
    console.log('[SmolLM Recommender] Generated text length:', generatedText.length);
    console.log('[SmolLM Recommender] Generated text preview:', generatedText.substring(0, 100));
    
    return generatedText.trim();
  } catch (error) {
    console.error('[SmolLM Recommender] Error generating text:', error);
    throw error;
  }
}

/**
 * Process and clean recommendations
 * Parses various formats that SmolLM might generate
 */
function processRecommendations(rawText) {
  // Remove the prompt if it's still in the output
  let cleaned = rawText.trim();
  
  console.log('[SmolLM Recommender] Processing raw text (first 200 chars):', cleaned.substring(0, 200));
  
  // Try to extract recommendations in the expected format
  // Pattern: "Recommendation N: <Main Topic> – <Subtopic>. <How to engage.>"
  const recommendationPattern = /Recommendation\s+\d+:\s*([^–]+)–\s*([^.]+)\.\s*(.+?)(?=\n|$|Recommendation)/gi;
  const matches = [...cleaned.matchAll(recommendationPattern)];
  
  if (matches.length > 0) {
    // Format: "Recommendation N: <Main Topic> – <Subtopic>. <How to engage.>"
    const recommendations = matches.map(match => {
      const mainTopic = match[1].trim();
      const subtopic = match[2].trim();
      const howToEngage = match[3].trim();
      return `Recommendation ${matches.indexOf(match) + 1}: ${mainTopic} – ${subtopic}. ${howToEngage}`;
    });
    
    if (recommendations.length >= 1) {
      console.log('[SmolLM Recommender] Parsed', recommendations.length, 'recommendations using pattern 1');
      return recommendations.join('\n');
    }
  }
  
  // Fallback: Try to find lines starting with "Recommendation" or "- Recommendation"
  const lines = cleaned.split('\n').filter(line => {
    const trimmed = line.trim();
    return trimmed.length > 20 && 
           (trimmed.match(/^[-•]\s*Recommendation\s+\d+:/i) || 
            trimmed.match(/^Recommendation\s+\d+:/i));
  });
  
  if (lines.length > 0) {
    // Clean up the lines
    const recommendations = lines.map(line => {
      let cleaned = line.trim();
      // Remove leading dash/bullet if present
      cleaned = cleaned.replace(/^[-•]\s*/, '');
      return cleaned;
    }).filter(rec => rec.length > 20 && rec.length < 400);
    
    if (recommendations.length >= 1) {
      console.log('[SmolLM Recommender] Parsed', recommendations.length, 'recommendations using pattern 2');
      return recommendations.join('\n');
    }
  }
  
  // NEW: Handle percentage-based format like "100% - Cryptocurrencies have a steady rise..."
  const percentagePattern = /(\d+%)\s*[-–]\s*(.+?)(?=\n|$|\d+%)/gi;
  const percentageMatches = [...cleaned.matchAll(percentagePattern)];
  
  if (percentageMatches.length > 0) {
    const recommendations = percentageMatches.slice(0, 5).map((match, index) => {
      const percentage = match[1].trim();
      const text = match[2].trim();
      // Clean up the text
      let cleanedText = text.replace(/^[-–]\s*/, '').trim();
      // Ensure it ends with proper punctuation
      if (!cleanedText.match(/[.!?]$/)) {
        cleanedText += '.';
      }
      return `Recommendation ${index + 1} (${percentage}): ${cleanedText}`;
    }).filter(rec => rec.length > 30 && rec.length < 400);
    
    if (recommendations.length >= 1) {
      console.log('[SmolLM Recommender] Parsed', recommendations.length, 'recommendations using percentage pattern');
      return recommendations.join('\n');
    }
  }
  
  // NEW: Handle simple sentence-based recommendations (extract meaningful sentences)
  // Split by periods, newlines, or common separators
  const sentences = cleaned
    .split(/[.\n]/)
    .map(s => s.trim())
    .filter(s => {
      // Filter for meaningful sentences (not too short, not too long, contains actual content)
      return s.length > 30 && 
             s.length < 300 && 
             !s.match(/^(Recommendation|Example|Note|Tip)/i) &&
             !s.match(/^\d+%$/); // Not just a percentage
    });
  
  if (sentences.length > 0) {
    const recommendations = sentences.slice(0, 5).map((sentence, index) => {
      // Clean up the sentence
      let cleaned = sentence.trim();
      // Remove leading dashes/bullets
      cleaned = cleaned.replace(/^[-–•]\s*/, '');
      // Ensure proper capitalization
      if (cleaned.length > 0) {
        cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
      }
      // Ensure it ends with punctuation
      if (!cleaned.match(/[.!?]$/)) {
        cleaned += '.';
      }
      return `Recommendation ${index + 1}: ${cleaned}`;
    }).filter(rec => rec.length > 30 && rec.length < 400);
    
    if (recommendations.length >= 1) {
      console.log('[SmolLM Recommender] Parsed', recommendations.length, 'recommendations using sentence extraction');
      return recommendations.join('\n');
    }
  }
  
  // Fallback: Try to extract any lines with the format "X – Y. Z" (em dash)
  const dashPattern = /([A-Z][^–]+)–\s*([^.]+)\.\s*(.+?)(?=\n|$)/g;
  const dashMatches = [...cleaned.matchAll(dashPattern)];
  
  if (dashMatches.length > 0) {
    const recommendations = dashMatches.slice(0, 3).map((match, index) => {
      const mainTopic = match[1].trim();
      const subtopic = match[2].trim();
      const howToEngage = match[3].trim();
      return `Recommendation ${index + 1}: ${mainTopic} – ${subtopic}. ${howToEngage}`;
    });
    
    if (recommendations.length >= 1) {
      console.log('[SmolLM Recommender] Parsed', recommendations.length, 'recommendations using dash pattern');
      return recommendations.join('\n');
    }
  }
  
  // Last resort: return the cleaned text if it's meaningful, otherwise return error message
  const finalCleaned = cleaned
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 20 && line.length < 400)
    .slice(0, 5)
    .join('\n');
  
  if (finalCleaned.length > 30) {
    console.log('[SmolLM Recommender] Returning cleaned raw text as fallback');
    return finalCleaned;
  }
  
  console.log('[SmolLM Recommender] Could not parse recommendations, returning error message');
  return 'Unable to generate specific recommendations. Please try again or use more content data.';
}

/**
 * Main function: Generate recommendations using SmolLM-135M
 */
export async function generateSmolLMRecommendations(consumptionData) {
  // Single-threading: Check if request is in progress
  if (requestInProgress) {
    console.log('[SmolLM Recommender] Request already in progress, queuing...');
    return new Promise((resolve, reject) => {
      requestQueue.push({ resolve, reject, consumptionData });
    });
  }
  
  requestInProgress = true;
  
  try {
    console.log('[SmolLM Recommender] ========================================');
    console.log('[SmolLM Recommender] STARTING SMOLLM-135M RECOMMENDATIONS');
    console.log('[SmolLM Recommender] ========================================');
    
    // Format consumption data
    console.log('[SmolLM Recommender] Formatting consumption data...');
    const formattedData = formatConsumptionData(consumptionData);
    
    // Include sample post title if provided
    if (consumptionData.samplePostTitle) {
      formattedData.samplePostTitle = consumptionData.samplePostTitle;
    }
    
    console.log('[SmolLM Recommender] Data summary:', {
      totalPosts: formattedData.totalPosts,
      totalMinutes: formattedData.totalMinutes,
      topics: formattedData.allTopics.length,
      hasSamplePost: !!formattedData.samplePostTitle
    });
    
    // Build prompt with few-shot examples
    console.log('[SmolLM Recommender] Building prompt with few-shot examples...');
    const prompt = buildPrompt(formattedData);
    
    // Generate with SmolLM
    console.log('[SmolLM Recommender] Generating with SmolLM-135M...');
    const rawRecommendations = await generateWithSmolLM(prompt);
    
    console.log('[SmolLM Recommender] Received response from SmolLM');
    console.log('[SmolLM Recommender] Raw output length:', rawRecommendations.length);
    
    // Process and clean recommendations
    console.log('[SmolLM Recommender] Processing recommendations...');
    const recommendations = processRecommendations(rawRecommendations);
    
    console.log('[SmolLM Recommender] Recommendations generated successfully');
    console.log('[SmolLM Recommender] ========================================');
    
    return recommendations;
  } catch (error) {
    console.error('[SmolLM Recommender] ERROR generating recommendations:', error);
    throw error;
  } finally {
    requestInProgress = false;
    
    // Process queued requests
    if (requestQueue.length > 0) {
      const next = requestQueue.shift();
      // Process next request after a short delay
      setTimeout(() => {
        generateSmolLMRecommendations(next.consumptionData)
          .then(next.resolve)
          .catch(next.reject);
      }, 100);
    }
  }
}

console.log('[SmolLM Recommender] ========================================');
console.log('[SmolLM Recommender] SMOLLM-135M RECOMMENDATION MODULE LOADED');
console.log('[SmolLM Recommender] Model: SmolLM-135M (Local)');
console.log('[SmolLM Recommender] ========================================');

