// background_llm.js
// Recommendation system using GPT-4o-mini
// Generates recommendations using OpenAI API with comprehensive user data analysis

// Import GPT recommender
import { generateGPTRecommendations } from './gpt_recommender.js';

// Embedding pipeline - loaded in service worker context
let embeddingPipeline = null;
let embeddingPipelinePromise = null;

// Template usage tracker to avoid repeats across ALL recommendations
let recentTemplates = [];
let recentSentences = []; // Track full sentences to avoid duplicates
const MAX_RECENT_TEMPLATES = 50;
const MAX_RECENT_SENTENCES = 50;

/**
 * Track and avoid repeating templates across recommendations
 */
function trackTemplate(template) {
  recentTemplates.push(template);
  if (recentTemplates.length > MAX_RECENT_TEMPLATES) {
    recentTemplates.shift(); // Remove oldest
  }
}

/**
 * Track full sentences to prevent duplicates across recommendations
 */
function trackSentence(sentence) {
  const normalized = sentence.toLowerCase().trim();
  recentSentences.push(normalized);
  if (recentSentences.length > MAX_RECENT_SENTENCES) {
    recentSentences.shift();
  }
}

/**
 * Check if a sentence (or part of it) has been used recently
 * More robust duplicate detection - checks for similar phrases
 */
function isSentenceDuplicate(sentence) {
  const normalized = sentence.toLowerCase().trim();
  
  // Extract key phrases from the sentence (remove common words)
  const commonWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'it', 'you', 'your', 'this', 'that', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'because', 'since', 'as', 'if', 'when', 'where', 'what', 'who', 'how', 'why'];
  const words = normalized.split(/\s+/).filter(w => w.length > 3 && !commonWords.includes(w));
  const keyPhrase = words.slice(0, 4).join(' '); // Get first 4 meaningful words
  
  // Check if exact sentence matches
  for (const recent of recentSentences) {
    if (normalized === recent) {
      return true;
    }
    // Check if key phrases match (detects similar sentences)
    const recentWords = recent.split(/\s+/).filter(w => w.length > 3 && !commonWords.includes(w));
    const recentKeyPhrase = recentWords.slice(0, 4).join(' ');
    if (keyPhrase && recentKeyPhrase && keyPhrase === recentKeyPhrase) {
      return true;
    }
    // Check for substantial overlap in longer phrases
    if (normalized.length > 30 && recent.length > 30) {
      const overlap = normalized.includes(recent.substring(0, 30)) || recent.includes(normalized.substring(0, 30));
      if (overlap) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Filter out recently used templates
 */
function filterRecentTemplates(candidates) {
  return candidates.filter(t => !recentTemplates.includes(t));
}

/**
 * Clear template tracking (call at start of recommendation generation)
 */
function clearTemplateTracking() {
  recentTemplates = [];
  recentSentences = [];
}

/**
 * Better shuffle algorithm (Fisher-Yates)
 */
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Load the embedding pipeline (similar to background.js)
 */
async function loadEmbeddingPipeline() {
  if (embeddingPipeline) {
    return embeddingPipeline;
  }
  
  if (embeddingPipelinePromise) {
    return embeddingPipelinePromise;
  }
  
  embeddingPipelinePromise = (async () => {
    try {
      if (!transformersModule || !transformersModule.pipeline) {
        throw new Error('transformers module missing pipeline function');
      }
      
      const { pipeline, env } = transformersModule;
      
      // Configure environment
      env.backends = ['wasm'];
      env.allowRemoteModels = true;
      env.useBrowserCache = true;
      
      // Set WASM paths
      const wasmBasePath = chrome.runtime.getURL('libs/transformers/dist/');
      env.paths = env.paths || {};
      env.paths.wasm = wasmBasePath;
      
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = wasmBasePath;
      }
      
      // Create the embedding pipeline
      const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      
      if (!pipe) {
        throw new Error('Pipeline creation returned null/undefined');
      }
      
      embeddingPipeline = pipe;
      return pipe;
    } catch (err) {
      console.error('[Horizon Recommendations] Failed to load embedding pipeline:', err);
      embeddingPipelinePromise = null;
      throw err;
    }
  })();
  
  return embeddingPipelinePromise;
}

/**
 * Generate embedding for text
 */
async function generateEmbedding(text) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return null;
  }
  
  const normalized = text.trim();
  
  try {
    const pipeline = await loadEmbeddingPipeline();
    const output = await pipeline(normalized, {
      pooling: 'mean',
      normalize: true
    });
    
    // Extract embedding array from output
    let embeddingArray = null;
    
    if (Array.isArray(output)) {
      embeddingArray = output[0]?.data || output[0];
    } else if (output?.data) {
      if (output.dims && Array.isArray(output.dims)) {
        const expectedSize = output.dims.reduce((a, b) => a * b, 1);
        if (output.dims.length === 2 && output.dims[0] === 1) {
          const size = output.dims[1];
          embeddingArray = Array.from(output.data.slice(0, size));
        } else if (output.dims.length === 1) {
          embeddingArray = Array.from(output.data);
        } else {
          embeddingArray = Array.from(output.data.slice(0, expectedSize));
        }
      } else {
        embeddingArray = Array.from(output.data);
      }
    } else if (typeof output.tolist === 'function') {
      embeddingArray = output.tolist();
      if (Array.isArray(embeddingArray) && embeddingArray.length === 1) {
        embeddingArray = embeddingArray[0];
      }
    } else if (typeof output.toArray === 'function') {
      embeddingArray = output.toArray();
    } else {
      try {
        embeddingArray = Array.from(output);
      } catch (e) {
        return null;
      }
    }
    
    if (!embeddingArray || !Array.isArray(embeddingArray) || embeddingArray.length === 0) {
      return null;
    }
    
    // Normalize values
    return embeddingArray
      .filter(v => typeof v === 'number' && !isNaN(v) && isFinite(v))
      .map((value) => Number(Number(value).toFixed(6)));
  } catch (error) {
    console.error(`[Horizon Recommendations] Error generating embedding for "${normalized}":`, error);
    return null;
  }
}

/**
 * Cosine similarity between two vectors
 * @param {Array<number>} a - First vector
 * @param {Array<number>} b - Second vector
 * @returns {number} - Cosine similarity (-1 to 1)
 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return 0;
  }
  
  let dot = 0;
  let na = 0;
  let nb = 0;
  
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  
  const magnitude = Math.sqrt(na) * Math.sqrt(nb);
  if (magnitude === 0) return 0;
  
  return dot / magnitude;
}

/**
 * Calculate entropy from counts array
 * @param {Array<number>} counts - Array of counts
 * @returns {number} - Entropy value
 */
function entropyFromCounts(counts) {
  const total = counts.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  
  let ent = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    ent -= p * Math.log2(p);
  }
  return ent;
}

/**
 * Extract top interests from byTopicCounts
 * Returns array of top N topic names sorted by count
 */
function extractTopInterests(byTopicCounts, topN = 10) {
  if (!byTopicCounts || typeof byTopicCounts !== 'object') {
    return [];
  }

  return Object.entries(byTopicCounts)
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
    .map(item => item.topic);
}

/**
 * Topic-specific sub-topics with explanatory sentences
 * Each subtopic has a brief explanation of why it's relevant
 */
const TOPIC_SUBTOPICS = {
  'environment': [
    { name: 'sustainability', reason: 'it focuses on long-term environmental solutions that balance human needs with planetary health' },
    { name: 'climate change', reason: 'understanding current climate science helps you make informed decisions about the future' },
    { name: 'renewable energy', reason: 'this rapidly evolving field offers insights into the energy transition shaping our world' },
    { name: 'conservation', reason: 'learning about conservation efforts connects you to ongoing efforts to protect biodiversity' },
    { name: 'wildlife', reason: 'wildlife topics reveal the interconnectedness of ecosystems and human impact' },
    { name: 'pollution', reason: 'understanding pollution helps you see both problems and innovative solutions' },
    { name: 'ocean health', reason: 'oceans are critical to global systems and face unique environmental challenges' },
    { name: 'forest ecosystems', reason: 'forests play crucial roles in carbon storage and biodiversity' },
    { name: 'plant life', reason: 'botanical topics show how plants adapt and contribute to ecosystem health' },
    { name: 'green technology', reason: 'innovations in green tech are driving sustainable solutions across industries' }
  ],
  'health': [
    { name: 'mental health', reason: 'mental wellness is essential for overall quality of life and personal growth' },
    { name: 'nutrition', reason: 'evidence-based nutrition science helps optimize your health and energy' },
    { name: 'fitness', reason: 'understanding fitness principles can help you build sustainable exercise habits' },
    { name: 'disease prevention', reason: 'preventive medicine focuses on maintaining health rather than treating illness' },
    { name: 'medical research', reason: 'keeping up with medical advances shows what\'s possible in healthcare' },
    { name: 'wellness', reason: 'holistic wellness approaches integrate physical, mental, and emotional health' },
    { name: 'public health', reason: 'public health connects individual choices to community well-being' },
    { name: 'alternative medicine', reason: 'exploring complementary approaches can offer additional health perspectives' },
    { name: 'aging', reason: 'understanding aging helps you prepare for and optimize your later years' },
    { name: 'diet', reason: 'dietary choices have profound impacts on energy, mood, and long-term health' }
  ],
  'technology': [
    { name: 'artificial intelligence', reason: 'AI is transforming industries and reshaping how we interact with technology' },
    { name: 'software development', reason: 'learning about development reveals how digital tools are created and improved' },
    { name: 'cybersecurity', reason: 'cybersecurity knowledge helps protect your digital life and understand online threats' },
    { name: 'blockchain', reason: 'blockchain technology enables new forms of digital trust and decentralized systems' },
    { name: 'quantum computing', reason: 'quantum computing represents the next frontier in computational power' },
    { name: 'robotics', reason: 'robotics combines AI and engineering to create autonomous systems' },
    { name: 'virtual reality', reason: 'VR is creating new immersive experiences across entertainment and work' },
    { name: 'cloud computing', reason: 'cloud services power modern applications and enable scalable solutions' },
    { name: 'mobile apps', reason: 'mobile development shows how apps shape daily interactions and workflows' },
    { name: 'programming', reason: 'programming skills unlock the ability to build and customize digital tools' }
  ],
  'science': [
    { name: 'space exploration', reason: 'space exploration expands humanity\'s understanding of the universe and our place in it' },
    { name: 'biology', reason: 'biology reveals the complexity and beauty of living systems' },
    { name: 'chemistry', reason: 'chemistry explains how matter interacts at the molecular level' },
    { name: 'physics', reason: 'physics uncovers fundamental laws that govern the natural world' },
    { name: 'medical breakthroughs', reason: 'medical advances directly impact quality of life and treatment options' },
    { name: 'research discoveries', reason: 'scientific discoveries expand knowledge and create new possibilities' },
    { name: 'environmental science', reason: 'environmental science addresses critical challenges facing our planet' },
    { name: 'genetics', reason: 'genetics reveals how traits are inherited and how they can be modified' },
    { name: 'neuroscience', reason: 'neuroscience explores the brain and how it creates consciousness' },
    { name: 'astronomy', reason: 'astronomy connects you to the vast scale and wonder of the cosmos' }
  ],
  'politics': [
    { name: 'election news', reason: 'elections determine policy direction and shape governance for years to come' },
    { name: 'government policy', reason: 'government policies directly affect daily life and societal outcomes' },
    { name: 'international relations', reason: 'global politics shape trade, security, and cooperation between nations' },
    { name: 'political campaigns', reason: 'campaigns reveal how candidates communicate and build support' },
    { name: 'legislative updates', reason: 'new legislation changes laws and regulations that affect everyone' },
    { name: 'political analysis', reason: 'political analysis provides context for understanding current events' },
    { name: 'voting rights', reason: 'voting rights determine who participates in democratic processes' },
    { name: 'political movements', reason: 'political movements drive social change and policy reform' },
    { name: 'public policy', reason: 'public policy bridges theory and practice in addressing societal issues' },
    { name: 'democracy', reason: 'democratic institutions protect rights and enable collective decision-making' }
  ],
  'business': [
    { name: 'startups', reason: 'startups drive innovation and create new solutions to old problems' },
    { name: 'entrepreneurship', reason: 'entrepreneurship skills can help you create value and build ventures' },
    { name: 'leadership', reason: 'effective leadership principles apply across all areas of work and life' },
    { name: 'management', reason: 'management practices determine organizational success and team effectiveness' },
    { name: 'corporate news', reason: 'corporate developments reflect economic trends and industry changes' },
    { name: 'business strategy', reason: 'strategic thinking helps businesses adapt and compete effectively' },
    { name: 'venture capital', reason: 'VC funding enables innovation and shapes which ideas get resources' },
    { name: 'marketing', reason: 'marketing connects products and services with people who need them' },
    { name: 'business innovation', reason: 'innovation drives growth and creates competitive advantages' },
    { name: 'industry trends', reason: 'industry trends reveal where markets are heading and opportunities emerging' }
  ],
  'finance': [
    { name: 'personal finance', reason: 'personal finance knowledge helps you build wealth and achieve financial goals' },
    { name: 'investment strategies', reason: 'investment strategies can grow your wealth over time with calculated risk' },
    { name: 'market analysis', reason: 'market analysis reveals patterns and opportunities in financial markets' },
    { name: 'retirement planning', reason: 'planning for retirement ensures financial security in later years' },
    { name: 'budgeting', reason: 'budgeting helps you control spending and allocate resources effectively' },
    { name: 'tax advice', reason: 'tax knowledge can help you minimize obligations and maximize savings' },
    { name: 'financial planning', reason: 'comprehensive financial planning aligns money decisions with life goals' },
    { name: 'economic indicators', reason: 'economic indicators reveal the health and direction of the economy' },
    { name: 'banking', reason: 'understanding banking helps you navigate financial services and products' },
    { name: 'credit', reason: 'credit management affects borrowing costs and financial opportunities' }
  ],
  'entertainment': [
    { name: 'movies', reason: 'films combine storytelling, visual art, and cultural commentary' },
    { name: 'television', reason: 'TV shows reflect and shape cultural conversations and entertainment' },
    { name: 'music', reason: 'music connects emotions, culture, and creative expression across genres' },
    { name: 'gaming', reason: 'gaming combines interactive storytelling, technology, and social connection' },
    { name: 'celebrity news', reason: 'celebrity culture reflects broader social trends and interests' },
    { name: 'streaming', reason: 'streaming has transformed how we consume and discover entertainment' },
    { name: 'concerts', reason: 'live performances offer unique experiences and community connections' },
    { name: 'books', reason: 'books provide deep dives into ideas and immersive storytelling' },
    { name: 'theater', reason: 'theater combines live performance with artistic expression and social commentary' },
    { name: 'comedy', reason: 'comedy reflects culture while providing entertainment and perspective' }
  ],
  'sports': [
    { name: 'basketball', reason: 'basketball combines athleticism, strategy, and fast-paced action' },
    { name: 'football', reason: 'football showcases teamwork, strategy, and physical excellence' },
    { name: 'soccer', reason: 'soccer is the world\'s most popular sport with rich cultural significance' },
    { name: 'baseball', reason: 'baseball offers a blend of strategy, tradition, and athletic skill' },
    { name: 'tennis', reason: 'tennis combines individual excellence with mental and physical discipline' },
    { name: 'olympics', reason: 'the Olympics showcase peak human achievement and international unity' },
    { name: 'athletics', reason: 'track and field celebrates fundamental human physical capabilities' },
    { name: 'team sports', reason: 'team sports demonstrate cooperation, strategy, and collective achievement' },
    { name: 'individual sports', reason: 'individual sports highlight personal discipline and self-improvement' },
    { name: 'sports analysis', reason: 'sports analysis reveals the strategy and statistics behind performance' }
  ],
  'people': [
    { name: 'social issues', reason: 'social issues reflect challenges facing communities and opportunities for change' },
    { name: 'culture', reason: 'cultural topics reveal how communities create meaning and identity' },
    { name: 'society', reason: 'understanding society helps you navigate social dynamics and relationships' },
    { name: 'relationships', reason: 'relationship topics explore human connections and social bonds' },
    { name: 'community', reason: 'community topics show how people come together to support each other' },
    { name: 'social movements', reason: 'social movements drive progress and address systemic issues' },
    { name: 'human interest', reason: 'human interest stories reveal diverse experiences and perspectives' },
    { name: 'lifestyle', reason: 'lifestyle topics explore how people organize their daily lives and values' },
    { name: 'personal stories', reason: 'personal narratives provide insight into human experience and resilience' },
    { name: 'social trends', reason: 'social trends reveal how behaviors and attitudes evolve over time' }
  ],
  'cryptocurrency': [
    { name: 'bitcoin', reason: 'Bitcoin pioneered decentralized digital currency and continues to shape the crypto landscape' },
    { name: 'ethereum', reason: 'Ethereum enables smart contracts and decentralized applications beyond simple currency' },
    { name: 'blockchain technology', reason: 'blockchain enables trustless transactions and new forms of digital interaction' },
    { name: 'crypto trading', reason: 'crypto trading requires understanding market dynamics and risk management' },
    { name: 'DeFi', reason: 'decentralized finance is creating new financial services without traditional intermediaries' },
    { name: 'NFTs', reason: 'NFTs are exploring new models for digital ownership and creator economy' },
    { name: 'cryptocurrency news', reason: 'crypto news tracks rapid developments in this evolving space' },
    { name: 'crypto regulations', reason: 'regulatory changes significantly impact cryptocurrency markets and adoption' },
    { name: 'mining', reason: 'mining secures blockchain networks and can be a way to earn cryptocurrency' },
    { name: 'digital wallets', reason: 'wallets are essential tools for safely storing and managing digital assets' }
  ],
  'law': [
    { name: 'legal news', reason: 'legal developments change rights, responsibilities, and how justice is administered' },
    { name: 'court cases', reason: 'court decisions set precedents and interpret laws affecting everyone' },
    { name: 'legislation', reason: 'new laws change rules that govern behavior and protect rights' },
    { name: 'constitutional law', reason: 'constitutional law defines fundamental rights and government structure' },
    { name: 'criminal justice', reason: 'criminal justice affects public safety and fairness in legal processes' },
    { name: 'civil rights', reason: 'civil rights protect individuals from discrimination and ensure equal treatment' },
    { name: 'legal analysis', reason: 'legal analysis helps understand how laws apply to real situations' },
    { name: 'law enforcement', reason: 'law enforcement topics explore how police and justice systems operate' },
    { name: 'judicial decisions', reason: 'court rulings interpret laws and can have wide-reaching implications' },
    { name: 'legal reform', reason: 'legal reform addresses problems in justice systems and improves fairness' }
  ],
  'economy': [
    { name: 'economic policy', reason: 'economic policies shape growth, employment, and living standards' },
    { name: 'inflation', reason: 'inflation affects purchasing power and economic planning' },
    { name: 'employment', reason: 'employment trends reveal job market conditions and opportunities' },
    { name: 'trade', reason: 'trade policies affect global commerce and economic relationships' },
    { name: 'economic growth', reason: 'growth metrics indicate overall economic health and prosperity' },
    { name: 'market trends', reason: 'market trends show where economic activity is shifting' },
    { name: 'economic indicators', reason: 'indicators help predict economic direction and policy changes' },
    { name: 'global economy', reason: 'global economic trends connect local markets to worldwide forces' },
    { name: 'economic analysis', reason: 'economic analysis reveals underlying patterns and future possibilities' },
    { name: 'fiscal policy', reason: 'fiscal policy uses government spending to influence economic outcomes' }
  ],
  'investing': [
    { name: 'stock market', reason: 'stock markets enable wealth building through company ownership' },
    { name: 'portfolio management', reason: 'portfolio management balances risk and return across investments' },
    { name: 'financial planning', reason: 'financial planning aligns investments with long-term life goals' },
    { name: 'mutual funds', reason: 'mutual funds offer diversified investing for beginners and experts' },
    { name: 'ETF investing', reason: 'ETFs combine diversification with the flexibility of stock trading' },
    { name: 'real estate', reason: 'real estate can provide income, appreciation, and portfolio diversification' },
    { name: 'retirement accounts', reason: 'retirement accounts offer tax advantages for long-term savings' },
    { name: 'investment strategies', reason: 'strategies help you build wealth systematically over time' },
    { name: 'market trends', reason: 'trends reveal opportunities and risks in investment markets' },
    { name: 'wealth building', reason: 'wealth building strategies help you achieve financial independence' }
  ],
  'social': [
    { name: 'social media', reason: 'social platforms shape communication, relationships, and information flow' },
    { name: 'online communities', reason: 'online communities connect people with shared interests worldwide' },
    { name: 'digital culture', reason: 'digital culture reflects how technology changes social interaction' },
    { name: 'internet trends', reason: 'internet trends show how online behaviors and platforms evolve' },
    { name: 'social networking', reason: 'social networking enables professional connections and career growth' },
    { name: 'online behavior', reason: 'understanding online behavior helps navigate digital spaces effectively' },
    { name: 'virtual communities', reason: 'virtual communities create belonging and connection across distances' },
    { name: 'social platforms', reason: 'different platforms serve different communication and sharing needs' },
    { name: 'digital communication', reason: 'digital communication shapes how we connect and collaborate' },
    { name: 'internet culture', reason: 'internet culture reveals how online spaces create new forms of expression' }
  ]
};

/**
 * Get a single subtopic with explanation for a recommended topic
 * Returns one subtopic at a time for personalization
 */
function getTopicSubtopic(recommendedTopic, byTopicCounts, byTopic, mostViewedTopic) {
  const subtopics = TOPIC_SUBTOPICS[recommendedTopic];
  if (!subtopics || subtopics.length === 0) {
    return null;
  }
  
  const topicCount = byTopicCounts[recommendedTopic] || 0;
  const topicTime = byTopic[recommendedTopic] || 0;
  const hasViewedSome = topicCount > 0 || topicTime > 0;
  
  // Always return one random subtopic - makes it feel more personalized
  const shuffled = shuffleArray([...subtopics]);
  return shuffled[0] || null;
}

/**
 * Compute metrics from consumption data
 * Now includes byTopic (time in ms) and byTopicCounts (post counts)
 */
function computeRecommendationMetrics(consumptionData) {
  const { byTopicCounts = {}, byTopic = {} } = consumptionData;
  
  const totalPosts = Object.values(byTopicCounts).reduce((sum, count) => sum + count, 0);
  const totalTimeMs = Object.values(byTopic).reduce((sum, time) => sum + (time || 0), 0);
  
  if (totalPosts === 0 && totalTimeMs === 0) {
    throw new Error('No post data available for recommendations.');
  }
  
  const topicEntries = Object.entries(byTopicCounts)
    .map(([topic, count]) => ({
      topic,
      count,
      timeMs: byTopic[topic] || 0,
      percentage: totalPosts > 0 ? ((count / totalPosts) * 100).toFixed(1) : '0',
      timePercentage: totalTimeMs > 0 ? (((byTopic[topic] || 0) / totalTimeMs) * 100).toFixed(1) : '0'
    }))
    .sort((a, b) => {
      // Sort by combined score: count (60%) + time proportion (40%)
      const scoreA = (a.count / Math.max(totalPosts, 1)) * 0.6 + ((a.timeMs || 0) / Math.max(totalTimeMs, 1)) * 0.4;
      const scoreB = (b.count / Math.max(totalPosts, 1)) * 0.6 + ((b.timeMs || 0) / Math.max(totalTimeMs, 1)) * 0.4;
      return scoreB - scoreA;
    });
  
  const most_viewed_topics = topicEntries.slice(0, 5).map(t => ({
    topic: t.topic,
    count: t.count,
    timeMs: t.timeMs,
    percentage: t.percentage,
    timePercentage: t.timePercentage
  }));
  
  const topicsWithPosts = topicEntries.filter(t => t.count > 0);
  const least_viewed_topics = topicsWithPosts
    .slice(-5)
    .reverse()
    .map(t => ({
      topic: t.topic,
      count: t.count,
      timeMs: t.timeMs,
      percentage: t.percentage,
      timePercentage: t.timePercentage
    }));
  
  const topicCounts = Object.values(byTopicCounts);
  const topic_entropy = entropyFromCounts(topicCounts);
  
  const numTopics = topicEntries.length;
  const maxEntropy = numTopics > 0 ? Math.log2(numTopics) : 0;
  const diversity_score = maxEntropy > 0 
    ? Math.round((topic_entropy / maxEntropy) * 100) 
    : 0;
  
  // Calculate concentration: if top topic is >50% of total, user is heavily focused
  const topTopicCount = topicEntries.length > 0 ? topicEntries[0].count : 0;
  const concentration = totalPosts > 0 ? (topTopicCount / totalPosts) : 0;
  
  // Calculate temperature: difference between most and least viewed topics
  const mostViewed = topicEntries.length > 0 ? topicEntries[0].count : 0;
  const leastViewed = topicsWithPosts.length > 0 ? topicsWithPosts[topicsWithPosts.length - 1].count : 0;
  const temperature = mostViewed > 0 && leastViewed > 0 ? (mostViewed / leastViewed) : 1;
  
  return {
    most_viewed_topics,
    least_viewed_topics,
    topic_entropy: topic_entropy.toFixed(2),
    diversity_score,
    total_posts: totalPosts,
    total_time_ms: totalTimeMs,
    total_topics: numTopics,
    concentration,
    temperature,
    topTopic: topicEntries.length > 0 ? topicEntries[0].topic : null,
    topicFrequency: {}, // Will be populated later
    topicTimeWeight: {} // Will be populated later
  };
}

/**
 * Get entropy range category
 */
function getEntropyRange(entropy, maxEntropy) {
  if (maxEntropy === 0) return 'very_low';
  const normalized = entropy / maxEntropy;
  
  if (normalized < 0.2) return 'very_low';
  if (normalized < 0.4) return 'low';
  if (normalized < 0.6) return 'medium';
  if (normalized < 0.8) return 'high';
  return 'very_high';
}

/**
 * Get recommendation strength based on entropy range
 */
function getRecommendationStrength(entropyRange) {
  const strengths = {
    'very_low': 1.3,  // Stronger recommendations when very focused
    'low': 1.2,
    'medium': 1.0,
    'high': 0.9,
    'very_high': 0.8  // Gentler recommendations when already diverse
  };
  return strengths[entropyRange] || 1.0;
}

/**
 * Build user interest vector by averaging embeddings of consumed topics
 * Weighted by frequency AND time spent (combined score)
 */
async function buildUserInterestVector(byTopicCounts, byTopic = {}, lrProbabilities = {}) {
  const topics = Object.keys(byTopicCounts);
  if (topics.length === 0) {
    return null;
  }
  
  const totalCount = Object.values(byTopicCounts).reduce((sum, count) => sum + count, 0);
  const totalTimeMs = Object.values(byTopic).reduce((sum, time) => sum + (time || 0), 0);
  
  if (totalCount === 0 && totalTimeMs === 0) {
    return null;
  }
  
  // Get embeddings for each topic
  const topicEmbeddings = {};
  for (const topic of topics) {
    try {
      const embedding = await generateEmbedding(topic);
      if (embedding && Array.isArray(embedding) && embedding.length > 0) {
        topicEmbeddings[topic] = embedding;
      }
    } catch (error) {
      console.warn(`[Horizon Recommendations] Failed to embed topic "${topic}":`, error);
    }
  }
  
  if (Object.keys(topicEmbeddings).length === 0) {
    return null;
  }
  
  // Weighted average of topic embeddings
  // Weight combines: post count (40%), time spent (40%), LR probability (20%)
  const embeddingDim = Object.values(topicEmbeddings)[0].length;
  const userVector = new Array(embeddingDim).fill(0);
  
  for (const [topic, embedding] of Object.entries(topicEmbeddings)) {
    const countWeight = totalCount > 0 ? (byTopicCounts[topic] / totalCount) : 0;
    const timeWeight = totalTimeMs > 0 ? ((byTopic[topic] || 0) / totalTimeMs) : 0;
    const lrWeight = lrProbabilities[topic] || 0;
    
    // Combined weight: count (40%), time (40%), LR probability (20%)
    const combinedWeight = (countWeight * 0.4) + (timeWeight * 0.4) + (lrWeight * 0.2);
    
    for (let i = 0; i < embeddingDim; i++) {
      userVector[i] += embedding[i] * combinedWeight;
    }
  }
  
  return userVector;
}

/**
 * Get all available topics (including unexplored ones)
 */
function getAllAvailableTopics(consumptionData) {
  const { byTopicCounts = {} } = consumptionData;
  const exploredTopics = Object.keys(byTopicCounts);
  
  const allTopics = [
    'environment', 'health', 'technology', 'science', 'politics',
    'business', 'finance', 'entertainment', 'sports', 'people',
    'cryptocurrency', 'law', 'economy', 'investing', 'social'
  ];
  
  // Find unexplored topics
  const unexploredTopics = allTopics.filter(topic => !exploredTopics.includes(topic) || (byTopicCounts[topic] || 0) === 0);
  
  return { exploredTopics, unexploredTopics, allTopics };
}

/**
 * Generate candidate topics for recommendations
 * Uses existing topics plus some variations/adjacent topics
 */
function generateCandidateTopics(consumptionData, metrics) {
  const { byTopicCounts = {} } = consumptionData;
  const existingTopics = Object.keys(byTopicCounts).filter(t => (byTopicCounts[t] || 0) > 0);
  
  const { unexploredTopics, allTopics } = getAllAvailableTopics(consumptionData);
  
  // Base topics
  const baseTopics = [...allTopics];
  
  // Topic expansions - adjacent/related topics
  const topicExpansions = {
    'environment': ['sustainability', 'climate policy', 'renewable energy', 'conservation'],
    'health': ['health research', 'nutrition', 'fitness', 'mental health'],
    'technology': ['artificial intelligence', 'software development', 'cybersecurity', 'innovation'],
    'science': ['research', 'discoveries', 'space exploration', 'biology'],
    'politics': ['policy', 'government', 'democracy', 'international relations'],
    'business': ['entrepreneurship', 'startups', 'leadership', 'management'],
    'finance': ['personal finance', 'investment strategies', 'market analysis'],
    'entertainment': ['movies', 'music', 'television', 'gaming'],
    'sports': ['athletics', 'competition', 'fitness', 'teams'],
    'people': ['social issues', 'culture', 'society', 'relationships'],
    'cryptocurrency': ['blockchain', 'digital assets', 'crypto trading'],
    'law': ['legal news', 'justice', 'court cases', 'legislation'],
    'economy': ['economic policy', 'markets', 'trade', 'growth'],
    'investing': ['stocks', 'portfolio management', 'financial planning'],
    'social': ['community', 'networks', 'communication', 'social media']
  };
  
  const candidates = new Set();
  
  // Add existing topics (for diversity recommendations)
  existingTopics.forEach(t => candidates.add(t));
  
  // Add base topics
  baseTopics.forEach(t => candidates.add(t));
  
  // Add expansions for existing topics
  existingTopics.forEach(topic => {
    if (topicExpansions[topic]) {
      topicExpansions[topic].forEach(exp => candidates.add(exp));
    }
  });
  
  // Remove topics user has already consumed heavily (top 3)
  const topTopics = extractTopInterests(byTopicCounts, 3);
  topTopics.forEach(t => candidates.delete(t));
  
  // Occasionally (30% chance) add an unexplored topic if available
  if (unexploredTopics.length > 0 && Math.random() < 0.3) {
    const randomUnexplored = unexploredTopics[Math.floor(Math.random() * unexploredTopics.length)];
    candidates.add(randomUnexplored);
  }
  
  return Array.from(candidates);
}

/**
 * Score a candidate topic based on similarity, novelty, diversity, and time spent
 */
function scoreTopic(topic, topicVector, userVector, metrics, entropyRange, timeWeight = 0) {
  if (!topicVector || !userVector || topicVector.length !== userVector.length) {
    return 0;
  }
  
  // Similarity to user's interests (0-1)
  const similarity = (cosine(topicVector, userVector) + 1) / 2; // Normalize to 0-1
  
  // Novelty: inverse of frequency (1 = never seen, 0 = always seen)
  const frequency = metrics.topicFrequency[topic] || 0;
  const novelty = 1 - frequency;
  
  // Time weight factor: if user spends less time on a topic relative to others, boost it
  const timeBoost = timeWeight < 0.1 ? 0.2 : (timeWeight < 0.2 ? 0.1 : 0);
  
  // Diversity boost: favor topics that are different from heavily consumed ones
  const diversityBoost = frequency < 0.1 ? 0.3 : (frequency < 0.2 ? 0.1 : 0);
  
  // Combine scores: similarity (45%), novelty (25%), diversity (15%), time boost (15%)
  let score = (similarity * 0.45) + (novelty * 0.25) + (diversityBoost * 0.15) + (timeBoost * 0.15);
  
  // Adjust based on entropy range (recommendation strength)
  const strength = getRecommendationStrength(entropyRange);
  score *= strength;
  
  return score;
}

/**
 * Get diversification message templates (when user is too focused)
 */
function getDiversificationTemplates(concentration, topTopic, temperature) {
  if (concentration < 0.5) return null; // Not concentrated enough
  
  const templates = [
    `While ${topTopic} is clearly a strong interest of yours, branching out into other areas could provide fresh perspectives and new insights.`,
    `You've explored ${topTopic} extensively—consider diversifying your feed to discover new passions and broaden your knowledge.`,
    `Your reading heavily focuses on ${topTopic}. Exploring different topics might help you see connections you hadn't noticed before.`,
    `It's great that you're passionate about ${topTopic}, but adding variety to your content consumption could lead to interesting discoveries.`
  ];
  
  // More urgent if concentration is very high
  if (concentration > 0.7) {
    templates.push(
      `Your content consumption is very focused on ${topTopic} (over ${Math.round(concentration * 100)}%). Consider exploring entirely different areas to balance your perspective.`
    );
  }
  
  const filtered = filterRecentTemplates(templates);
  const selected = filtered.length > 0 ? filtered[0] : templates[Math.floor(Math.random() * templates.length)];
  trackTemplate(selected);
  return selected;
}

/**
 * Get template sentences based on content viewed, entropy, and temperature
 * Enhanced with better randomization and tracking
 */
function getRecommendationTemplates(similarity, frequency, entropy, entropyRange, temperature, totalPosts) {
  const templates = [];
  
  // High similarity templates
  if (similarity > 0.6) {
    templates.push(...[
      "it aligns well with your current interests",
      "it closely matches topics you've been engaging with",
      "it's a natural extension of what you're already reading",
      "it complements your existing reading patterns",
      "it builds on topics you've shown interest in",
      "it resonates with your established preferences",
      "it fits seamlessly into your content stream",
      "it mirrors interests you've demonstrated"
    ]);
  } else if (similarity > 0.4) {
    templates.push(...[
      "it relates to topics you've been exploring",
      "it connects with some of your current interests",
      "it's adjacent to areas you've looked into",
      "it shares themes with content you've consumed",
      "it's in the same domain as your recent reading",
      "it has connections to what you've been viewing"
    ]);
  }
  
  // Frequency-based templates
  if (frequency < 0.05) {
    templates.push(...[
      "you haven't explored this area much yet",
      "this is largely unexplored territory for you",
      "you've barely scratched the surface here",
      "this could open up a new area of interest",
      "this represents a fresh direction for you",
      "you've only dipped into this topic briefly"
    ]);
  } else if (frequency < 0.1) {
    templates.push(...[
      "there's more depth to discover here",
      "this could add diversity to your reading",
      "you've only touched on this topic briefly",
      "there's untapped potential in this area",
      "this area deserves more of your attention",
      "exploring this would expand your horizons"
    ]);
  } else if (frequency < 0.2) {
    templates.push(...[
      "it can add diversity to your reading",
      "this would help balance your content mix",
      "it's an underrepresented area in your feed",
      "this could round out your interests",
      "exploring this would add variety"
    ]);
  }
  
  // Entropy-based templates
  const entropyValue = parseFloat(entropy);
  if (entropyRange === 'very_low') {
    templates.push(...[
      "it would significantly diversify your content consumption",
      "breaking out of your current focus would be valuable",
      "this could help balance your reading portfolio",
      "diversifying into new areas would enrich your perspective",
      "expanding beyond your current focus is beneficial",
      "this would add meaningful variety to your feed"
    ]);
  } else if (entropyRange === 'low') {
    templates.push(...[
      "it helps diversify your content consumption",
      "adding variety would be beneficial",
      "this would broaden your reading horizons",
      "it would enhance the diversity of your interests",
      "exploring this adds valuable perspective"
    ]);
  } else if (entropyRange === 'high' || entropyRange === 'very_high') {
    templates.push(...[
      "it fits well with your diverse reading habits",
      "it complements your well-rounded interests",
      "it's a natural next step in your exploration",
      "it aligns with your broad reading pattern",
      "it would fit nicely into your varied interests"
    ]);
  }
  
  // Temperature-based templates (difference between most/least viewed)
  if (temperature > 10) {
    templates.push(...[
      "exploring this would help balance your content distribution",
      "this could help even out your reading patterns",
      "adding variety would reduce the gap in your consumption",
      "this would help normalize your content spread"
    ]);
  }
  
  // Total posts templates (encourage exploration for users with lots of content)
  if (totalPosts > 100) {
    templates.push(...[
      "with your extensive reading history, this could offer something new",
      "given your content consumption, this might surprise you",
      "this could be a fresh direction for someone with your reading habits",
      "given your reading volume, this area might surprise you"
    ]);
  }
  
  // Default templates
  if (templates.length === 0) {
    templates.push(...[
      "it could be an interesting addition to your reading",
      "this might catch your interest",
      "it's worth exploring",
      "this could broaden your perspective",
      "it's an area worth investigating",
      "this might align with your evolving interests"
    ]);
  }
  
  // Filter out recently used templates, then shuffle for true randomness
  const filtered = filterRecentTemplates(templates);
  
  // If we filtered out too many, mix in some originals to ensure we have options
  const candidates = filtered.length >= 3 ? filtered : 
                     (filtered.length > 0 ? shuffleArray([...filtered, ...templates.slice(0, 5)]) : templates);
  
  // Shuffle multiple times for better randomization
  let shuffled = shuffleArray(candidates);
  shuffled = shuffleArray(shuffled); // Double shuffle for better randomness
  
  // Select 1-2 templates - only filter exact template matches, not similar sentences
  const selected = [];
  for (const template of shuffled) {
    // Only check if exact template was used recently, allow similar but not identical ones
    if (!recentTemplates.includes(template)) {
      selected.push(template);
      if (selected.length >= 2) break; // Get up to 2 templates
    }
  }
  
  // Always return at least one template, even if it was used before (variety is more important than perfect uniqueness)
  const finalSelected = selected.length > 0 ? selected : shuffled.slice(0, Math.min(2, shuffled.length));
  
  // Track templates for future filtering
  finalSelected.forEach(t => {
    if (!recentTemplates.includes(t)) {
      trackTemplate(t);
    }
  });
  
  return finalSelected;
}

/**
 * Get unexplored topic encouragement templates
 * Returns DIFFERENT, RANDOM templates each time to avoid duplicates
 */
function getUnexploredTopicTemplates(topic) {
  const allTemplates = [
    `Consider exploring ${topic}—you haven't viewed any content in this area yet, and it could open up entirely new interests.`,
    `${topic} is completely new territory for you. Taking a look might reveal something unexpectedly engaging.`,
    `You haven't engaged with ${topic} at all. Branching out into unfamiliar areas can be rewarding.`,
    `${topic} represents an unexplored area in your reading. Sometimes the best discoveries come from stepping outside your comfort zone.`,
    `Dive into ${topic}—it's uncharted territory in your reading journey and could spark new interests.`,
    `${topic} hasn't appeared in your feed yet. Exploring it could lead to surprising discoveries.`,
    `Exploring ${topic} would be a fresh departure from your current reading patterns.`,
    `${topic} offers an opportunity to discover content you haven't encountered before.`,
    `Since ${topic} is new to you, exploring it could introduce perspectives you haven't considered.`,
    `Try venturing into ${topic}—new areas often reveal unexpected interests.`,
    `${topic} is waiting to be explored and might surprise you with its relevance.`,
    `Step into ${topic} territory and see what new insights await you.`
  ];
  
  // Filter out recently used templates, then shuffle for true randomness
  const filtered = filterRecentTemplates(allTemplates);
  const candidates = filtered.length > 0 ? filtered : allTemplates;
  const shuffled = shuffleArray(candidates);
  
  // Select a random one from the shuffled list
  const selected = shuffled[0];
  
  // Track both the full template and key phrases to avoid duplicates
  trackTemplate(selected);
  trackSentence(selected);
  
  return selected;
}

/**
 * Explain why a topic is recommended with diverse templates
 * Now tracks templates across all recommendations to avoid duplicates
 */
function explainRecommendation(topic, similarity, frequency, entropy, entropyRange, temperature, totalPosts, isUnexplored = false) {
  if (isUnexplored) {
    return getUnexploredTopicTemplates(topic);
  }
  
  const templates = getRecommendationTemplates(similarity, frequency, entropy, entropyRange, temperature, totalPosts);
  
  if (templates.length === 0) {
    const defaultTemplate = "it could be an interesting addition to your reading";
    // Check if this default was already used
    if (isSentenceDuplicate(defaultTemplate)) {
      return "this might catch your interest";
    }
    trackTemplate(defaultTemplate);
    trackSentence(defaultTemplate);
    return defaultTemplate;
  }
  
  // Join 1-2 templates with 'and' or comma, but check for duplicates
  // Prefer single template to avoid combining duplicates
  let combined;
  
  // Use templates without overly strict duplicate checking
  // Allow some variation to ensure we get good recommendations
  let uniqueTemplates = templates.filter(t => !recentTemplates.includes(t));
  
  // If we filtered out too many, use the original templates but still prefer unused ones
  if (uniqueTemplates.length === 0 && templates.length > 0) {
    uniqueTemplates = templates;
  }
  
  // Shuffle to get variety
  const shuffled = shuffleArray(uniqueTemplates);
  
  if (shuffled.length > 0) {
    // Use 1-2 templates
    if (shuffled.length === 1) {
      combined = shuffled[0];
    } else {
      combined = shuffled.slice(0, 2).join(' and ');
    }
  } else {
    // Only use generic as last resort
    const genericTemplates = [
      "it could be an interesting addition to your reading",
      "this might catch your interest",
      "it's worth exploring",
      "this could broaden your perspective"
    ];
    combined = genericTemplates[Math.floor(Math.random() * genericTemplates.length)];
  }
  
  // Track the template (but don't block similar ones too aggressively)
  if (combined && !recentTemplates.includes(combined)) {
    trackTemplate(combined);
  }
  
  return combined;
}

/**
 * Create natural language recommendation for a topic
 * Enhanced: One subtopic at a time with explanation
 */
function createRecommendation(topic, similarity, frequency, entropy, entropyRange, temperature, totalPosts, isUnexplored = false, subtopic = null) {
  if (isUnexplored) {
    let rec = explainRecommendation(topic, similarity, frequency, entropy, entropyRange, temperature, totalPosts, true);
    // Add single subtopic with explanation for unexplored topics
    if (subtopic && subtopic.name && subtopic.reason) {
      rec += ` Try exploring ${subtopic.name}—${subtopic.reason}.`;
    }
    return rec;
  }
  
  const reason = explainRecommendation(topic, similarity, frequency, entropy, entropyRange, temperature, totalPosts, false);
  
  // If we have a subtopic, make it the primary focus with explanation
  if (subtopic && subtopic.name && subtopic.reason) {
    return `Explore ${subtopic.name} within ${topic}—${subtopic.reason}. ${reason}.`;
  }
  
  // No subtopic, use standard format
  let recommendation = `You may enjoy exploring ${topic}, because ${reason}.`;
  
  return recommendation;
}

/**
 * Build recommendation text from top topics
 * Fixed: Removed double bullet points and ensures no duplicate sentences
 */
function buildRecommendations(topTopics, topicData, metrics, diversificationMessage) {
  if (topTopics.length === 0) {
    return 'Unable to generate recommendations. Please consume more content to get personalized suggestions.';
  }
  
  let output = '';
  
  // Add diversification message if user is too focused
  if (diversificationMessage) {
    output += diversificationMessage + '\n\n';
    trackSentence(diversificationMessage);
  }
  
  // Generate recommendations and check for duplicates
  const recommendations = [];
  const usedRecommendations = new Set(); // Track exact recommendations to avoid repeats
  const usedPhrases = new Set(); // Track key phrases to avoid similar recommendations
  
  for (const topic of topTopics) {
    const data = topicData[topic];
    let rec = null;
    let attempts = 0;
    const maxAttempts = 8; // More attempts for better variety
    
    // Generate recommendation - be less strict about duplicates
    // Allow some variation rather than rejecting everything
    rec = createRecommendation(
      topic,
      data.similarity,
      data.frequency,
      data.entropy,
      data.entropyRange,
      data.temperature,
      data.totalPosts,
      data.isUnexplored || false,
      data.subtopic || null
    );
    
    // Only check for exact duplicates, allow similar ones
    let normalizedRec = rec.toLowerCase().trim();
    const isExactDuplicate = usedRecommendations.has(normalizedRec);
    
    // If exact duplicate, try one more time with template clearing
    if (isExactDuplicate && attempts === 0) {
      // Clear some templates to get a different one
      const clearCount = Math.min(5, recentTemplates.length);
      if (clearCount > 0) {
        recentTemplates.splice(-clearCount);
      }
      
      // Try again
      rec = createRecommendation(
        topic,
        data.similarity,
        data.frequency,
        data.entropy,
        data.entropyRange,
        data.temperature,
        data.totalPosts,
        data.isUnexplored || false,
        data.subtopic || null
      );
      // Update normalized version
      normalizedRec = rec.toLowerCase().trim();
    }
    
    // Use the recommendation even if similar - variety is better than perfection
    
    // Track this recommendation to avoid duplicates
    const keyWords = normalizedRec.split(/\s+/).filter(w => w.length > 4);
    const keyPhrase = keyWords.slice(0, 5).join(' ');
    
    usedRecommendations.add(normalizedRec);
    if (keyPhrase) {
      usedPhrases.add(keyPhrase);
    }
    trackSentence(rec);
    
    recommendations.push(rec);
  }
  
  // Format recommendations as plain text lines (popup.js will add bullets)
  // Ensure NO bullets are present to avoid double-bullet issues
  // Each recommendation should be on its own line
  output += recommendations
    .map(rec => {
      let trimmed = rec.trim();
      // Remove ANY existing bullets/prefixes completely (bullet point, dash, asterisk)
      trimmed = trimmed.replace(/^[•\-\*]\s*/g, ''); // Remove all leading bullets
      trimmed = trimmed.replace(/\s*[•\-\*]\s*/g, ' '); // Remove any bullets in middle
      trimmed = trimmed.replace(/\n[•\-\*]\s*/g, '\n'); // Remove bullets after newlines
      // Ensure no double spaces
      trimmed = trimmed.replace(/\s+/g, ' ').trim();
      return trimmed;
    })
    .filter(rec => rec.length > 0)
    .join('\n'); // Single newline between recommendations
  
  return output;
}

/**
 * Main function: Generate recommendations using GPT-4o-mini
 */
export async function generateRecommendations(consumptionData) {
  try {
    console.log('[Horizon Recommendations] ========================================');
    console.log('[Horizon Recommendations] STARTING GPT-4O-MINI RECOMMENDATIONS');
    console.log('[Horizon Recommendations] ========================================');
    
    // Check if we have enough data
    const totalPosts = Object.values(consumptionData.byTopicCounts || {}).reduce((sum, count) => sum + count, 0);
    const totalTimeMs = Object.values(consumptionData.byTopic || {}).reduce((sum, time) => sum + (time || 0), 0);
    
    if (totalPosts === 0 && totalTimeMs === 0) {
      return 'Unable to generate recommendations. Please consume more content to get personalized suggestions.';
    }
    
    // Call GPT recommender (handles single-threading and deduplication internally)
    const recommendations = await generateGPTRecommendations(consumptionData);
    
    console.log('[Horizon Recommendations] Recommendations generated successfully');
    console.log('[Horizon Recommendations] ========================================');
    
    return recommendations;
  } catch (error) {
    console.error('[Horizon Recommendations] ERROR generating recommendations:', error);
    console.error('[Horizon Recommendations] Error details:', {
      message: error.message,
      stack: error.stack
    });
    
    // Provide helpful error messages
    if (error.message && error.message.includes('API key')) {
      return 'Unable to generate recommendations: API key not configured. Please set your OpenAI API key in api_key.js';
    }
    
    return 'Unable to generate recommendations at this time. Please try again later.';
  }
}

console.log('[Horizon Recommendations] ========================================');
console.log('[Horizon Recommendations] GPT-4O-MINI RECOMMENDATION MODULE LOADED');
console.log('[Horizon Recommendations] Using: OpenAI GPT-4o-mini');
console.log('[Horizon Recommendations] ========================================');
