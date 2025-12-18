// gpt_recommender.js
// GPT-4o-mini based recommendation system
// Uses OpenAI API to generate personalized content recommendations

import { OPENAI_API_KEY } from './api_key.js';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

// Single-threading: Track if a request is in progress
let requestInProgress = false;
let requestQueue = [];

// Deduplication: Track recent recommendations to avoid duplicates
const recentRecommendations = new Set();
const MAX_RECENT_RECOMMENDATIONS = 50;

/**
 * Add recommendation to deduplication cache
 */
function trackRecommendation(recommendation) {
  const normalized = recommendation.toLowerCase().trim();
  recentRecommendations.add(normalized);
  
  // Limit cache size
  if (recentRecommendations.size > MAX_RECENT_RECOMMENDATIONS) {
    const first = recentRecommendations.values().next().value;
    recentRecommendations.delete(first);
  }
}

/**
 * Check if recommendation is a duplicate
 */
function isDuplicate(recommendation) {
  const normalized = recommendation.toLowerCase().trim();
  return recentRecommendations.has(normalized);
}

/**
 * Clear deduplication cache
 */
function clearDeduplicationCache() {
  recentRecommendations.clear();
}

/**
 * Format consumption data for GPT prompt
 */
function formatConsumptionData(consumptionData) {
  const { byTopicCounts = {}, byTopic = {}, lrProbabilities = {}, samplePostTitle } = consumptionData;
  
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
  
  // Calculate topic percentages
  const topicStats = {};
  Object.keys(byTopicCounts).forEach(topic => {
    const count = byTopicCounts[topic] || 0;
    const timeMs = byTopic[topic] || 0;
    const countPercent = totalPosts > 0 ? ((count / totalPosts) * 100).toFixed(1) : '0';
    const timePercent = totalTimeMs > 0 ? (((timeMs || 0) / totalTimeMs) * 100).toFixed(1) : '0';
    const avgConfidence = lrProbabilities[topic] || 0;
    
    topicStats[topic] = {
      posts: count,
      postPercentage: countPercent,
      timeMinutes: Math.round(timeMs / (1000 * 60)),
      timePercentage: timePercent,
      avgConfidence: avgConfidence > 0 ? avgConfidence.toFixed(2) : null
    };
  });
  
  return {
    totalPosts,
    totalMinutes,
    topTopicsByCount,
    topTopicsByTime,
    topicStats,
    allTopics: Object.keys(byTopicCounts),
    samplePostTitle: samplePostTitle || null
  };
}

/**
 * Build the system prompt with background information
 */
function buildSystemPrompt() {
  return `You are an expert content recommendation specialist with deep knowledge of user 
          behavior analysis, content consumption patterns, and personalized recommendation systems. 
          You understand how to analyze browsing habits, topic preferences, engagement metrics, and time spent on 
          different content types to provide insightful, personalized recommendations.

Your expertise includes:
- Analyzing user consumption data to identify patterns and interests
- Understanding topic relationships and suggesting relevant content areas
- Providing actionable recommendations that help users discover new interests
- Balancing between familiar topics and exploration of new areas
- Considering both post count and time spent as indicators of interest
- Using classification confidence scores to understand content quality

You provide recommendations that are:
- Specific and actionable
- Based on clear data-driven insights
- Personalized to the user's actual consumption patterns
- Encouraging exploration while respecting existing interests
- Free from duplicates or repetitive suggestions`;
}

/**
 * Build the user prompt with consumption data and request
 */
function buildUserPrompt(formattedData) {
  const { totalPosts, totalMinutes, topTopicsByCount, topTopicsByTime, topicStats, allTopics, samplePostTitle } = formattedData;
  
  let prompt = `Based on the following user consumption data, provide personalized content recommendations.

USER CONSUMPTION DATA:
- Total posts viewed: ${totalPosts}
- Total time spent: ${totalMinutes} minutes
- Number of topics explored: ${allTopics.length}`;

  // Add sample post title if available
  if (samplePostTitle && samplePostTitle.trim().length > 0) {
    prompt += `
- Sample post viewed: "${samplePostTitle}"`;
  }

  prompt += `

TOP TOPICS BY POST COUNT:
`;
  
  if (topTopicsByCount.length > 0) {
    topTopicsByCount.forEach((item, index) => {
      const stats = topicStats[item.topic];
      prompt += `${index + 1}. ${item.topic}: ${item.count} posts (${stats.postPercentage}% of total posts)\n`;
    });
  } else {
    prompt += `No posts tracked yet.\n`;
  }
  
  prompt += `\nTOP TOPICS BY TIME SPENT:\n`;
  if (topTopicsByTime.length > 0) {
    topTopicsByTime.forEach((item, index) => {
      const stats = topicStats[item.topic];
      prompt += `${index + 1}. ${item.topic}: ${item.minutes} minutes (${stats.timePercentage}% of total time)`;
      if (stats.avgConfidence) {
        prompt += ` [Avg classification confidence: ${stats.avgConfidence}]`;
      }
      prompt += `\n`;
    });
  } else {
    prompt += `No time data tracked yet.\n`;
  }
  
  prompt += `\nALL TOPICS WITH STATISTICS:\n`;
  const sortedTopics = Object.entries(topicStats)
    .sort((a, b) => {
      // Sort by combined score: posts (60%) + time (40%)
      const scoreA = (a[1].posts / Math.max(totalPosts, 1)) * 0.6 + (parseFloat(a[1].timePercentage) / 100) * 0.4;
      const scoreB = (b[1].posts / Math.max(totalPosts, 1)) * 0.6 + (parseFloat(b[1].timePercentage) / 100) * 0.4;
      return scoreB - scoreA;
    });
  
  sortedTopics.forEach(([topic, stats]) => {
    prompt += `- ${topic}: ${stats.posts} posts (${stats.postPercentage}%), ${stats.timeMinutes} min (${stats.timePercentage}%)`;
    if (stats.avgConfidence) {
      prompt += `, confidence: ${stats.avgConfidence}`;
    }
    prompt += `\n`;
  });
  
  prompt += `\nBROWSING HABITS ANALYSIS:
`;
  
  // Analyze browsing patterns
  if (totalPosts > 0) {
    const topTopic = topTopicsByCount[0];
    if (topTopic) {
      const topTopicPercent = ((topTopic.count / totalPosts) * 100).toFixed(1);
      prompt += `- Primary interest: ${topTopic.topic} (${topTopicPercent}% of posts)\n`;
    }
    
    const diversity = allTopics.length;
    if (diversity > 10) {
      prompt += `- High topic diversity: User explores ${diversity} different topics\n`;
    } else if (diversity > 5) {
      prompt += `- Moderate topic diversity: User explores ${diversity} different topics\n`;
    } else {
      prompt += `- Focused browsing: User concentrates on ${diversity} main topics\n`;
    }
    
    // Check for concentration
    const top3Count = topTopicsByCount.slice(0, 3).reduce((sum, item) => sum + item.count, 0);
    const top3Percent = ((top3Count / totalPosts) * 100).toFixed(1);
    if (top3Percent > 70) {
      prompt += `- Highly concentrated: Top 3 topics account for ${top3Percent}% of consumption\n`;
    }
  }
  
  prompt += `\nRECOMMENDATION REQUEST:
Please provide 3-5 personalized content recommendations based on this data. For each recommendation:

1. Suggest a specific topic or subtopic to explore
2. Explain why this recommendation is relevant based on the user's browsing habits
3. Provide guidance on how to engage with this content
4. Include any insights about what the current data indicates about the user's interests

Format your response as clear, actionable recommendations. Each recommendation should be on its own line, without bullet points (they will be added by the UI). Make each recommendation specific and personalized to this user's data.`;
  
  return prompt;
}

/**
 * Call OpenAI API to generate recommendations
 */
async function callOpenAIAPI(systemPrompt, userPrompt) {
  if (!OPENAI_API_KEY || OPENAI_API_KEY === 'YOUR_API_KEY_HERE') {
    throw new Error('OpenAI API key not configured. Please set your API key in api_key.js');
  }
  
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: userPrompt
        }
      ],
      temperature: 0.7,
      max_tokens: 1000
    })
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}. ${errorData.error?.message || ''}`);
  }
  
  const data = await response.json();
  
  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error('Invalid response format from OpenAI API');
  }
  
  return data.choices[0].message.content.trim();
}

/**
 * Process and deduplicate recommendations
 */
function processRecommendations(rawRecommendations) {
  // Split by newlines
  const lines = rawRecommendations.split('\n').filter(line => line.trim().length > 0);
  
  const processed = [];
  for (const line of lines) {
    // Remove any existing bullets
    let cleaned = line.trim().replace(/^[•\-\*]\s*/, '').trim();
    
    // Skip if empty or too short
    if (cleaned.length < 10) continue;
    
    // Check for duplicates
    if (isDuplicate(cleaned)) {
      console.log('[GPT Recommender] Skipping duplicate:', cleaned.substring(0, 50));
      continue;
    }
    
    // Track this recommendation
    trackRecommendation(cleaned);
    processed.push(cleaned);
  }
  
  // If we got fewer than 3 recommendations, try to split longer ones
  if (processed.length < 3 && lines.length > 0) {
    // Look for recommendations that might be combined (contain multiple sentences)
    const combined = lines.join(' ').split(/[.!?]\s+/).filter(s => s.trim().length > 20);
    for (const rec of combined) {
      const cleaned = rec.trim();
      if (!isDuplicate(cleaned) && cleaned.length > 20) {
        trackRecommendation(cleaned);
        processed.push(cleaned);
        if (processed.length >= 5) break;
      }
    }
  }
  
  return processed.join('\n');
}

/**
 * Main function: Generate recommendations using GPT-4o-mini
 */
export async function generateGPTRecommendations(consumptionData) {
  // Single-threading: Check if request is in progress
  if (requestInProgress) {
    console.log('[GPT Recommender] Request already in progress, queuing...');
    return new Promise((resolve, reject) => {
      requestQueue.push({ resolve, reject, consumptionData });
    });
  }
  
  requestInProgress = true;
  
  try {
    console.log('[GPT Recommender] ========================================');
    console.log('[GPT Recommender] STARTING GPT-4O-MINI RECOMMENDATIONS');
    console.log('[GPT Recommender] ========================================');
    
    // Clear deduplication cache at start of new generation
    clearDeduplicationCache();
    
    // Format consumption data
    console.log('[GPT Recommender] Formatting consumption data...');
    const formattedData = formatConsumptionData(consumptionData);
    
    console.log('[GPT Recommender] Data summary:', {
      totalPosts: formattedData.totalPosts,
      totalMinutes: formattedData.totalMinutes,
      topics: formattedData.allTopics.length
    });
    
    // Build prompts
    console.log('[GPT Recommender] Building prompts...');
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(formattedData);
    
    // Call OpenAI API
    console.log('[GPT Recommender] Calling OpenAI API...');
    const rawRecommendations = await callOpenAIAPI(systemPrompt, userPrompt);
    
    console.log('[GPT Recommender] Received response from OpenAI');
    
    // Process and deduplicate
    console.log('[GPT Recommender] Processing recommendations...');
    const recommendations = processRecommendations(rawRecommendations);
    
    console.log('[GPT Recommender] Recommendations generated successfully');
    console.log('[GPT Recommender] ========================================');
    
    return recommendations;
  } catch (error) {
    console.error('[GPT Recommender] ERROR generating recommendations:', error);
    throw error;
  } finally {
    requestInProgress = false;
    
    // Process queued requests
    if (requestQueue.length > 0) {
      const next = requestQueue.shift();
      // Process next request after a short delay
      setTimeout(() => {
        generateGPTRecommendations(next.consumptionData)
          .then(next.resolve)
          .catch(next.reject);
      }, 100);
    }
  }
}

console.log('[GPT Recommender] ========================================');
console.log('[GPT Recommender] GPT-4O-MINI RECOMMENDATION MODULE LOADED');
console.log('[GPT Recommender] Model: gpt-4o-mini');
console.log('[GPT Recommender] ========================================');

