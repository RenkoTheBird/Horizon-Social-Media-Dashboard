// popup.js
// Requests summary from background and renders charts & lists.

const MS_TO_MIN = 1000 * 60;

function formatMinutes(ms) {
  const mins = Math.round(ms / MS_TO_MIN);
  return `${mins} min`;
}

function formatMinutesAndSeconds(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  
  if (minutes === 0) {
    return `${seconds} sec`;
  } else if (seconds === 0) {
    return `${minutes} min`;
  } else {
    return `${minutes} min ${seconds} sec`;
  }
}

function formatDateTime() {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric', 
    year: 'numeric' 
  });
  const time = now.toLocaleTimeString('en-US', { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true 
  });
  return `${date} ${time}`;
}

function updateDateTime() {
  const dateTimeEl = document.getElementById('currentDateTime');
  if (dateTimeEl) {
    dateTimeEl.textContent = formatDateTime();
  }
}

function entropyFromCounts(counts) {
  // counts: array of raw counts (e.g., ms)
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

function topNFromMap(mapObj, n = 5) {
  return Object.entries(mapObj)
    .map(([k, v]) => ({ k, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, n);
}

function renderTopDomains(byDomain, totalMs) {
  const ul = document.getElementById('topDomains');
  ul.innerHTML = '';
  const top = topNFromMap(byDomain, 10);
  for (const item of top) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = item.k;
    const val = document.createElement('strong');
    val.textContent = formatMinutes(item.v);
    li.appendChild(name);
    li.appendChild(val);
    ul.appendChild(li);
  }
  if (top.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No tracking data for today yet.';
    ul.appendChild(li);
  }
}

let pieChart = null;
let barChart = null;
let topicChart = null;
let topicCountChart = null;

function renderCharts(byContentType, byDomain, byTopic, byTopicCounts) {
  // Ensure Chart.js is loaded
  if (typeof Chart === 'undefined') {
    console.error('[Horizon] Chart.js is not loaded');
    return;
  }

  // Define consistent colors for content types
  const contentTypeColors = {
    'video': '#e53e3e',
    'gallery': '#805ad5',
    'article': '#38a169',
    'long_read': '#2b6cb0',
    'short_text': '#d69e2e',
    'unknown': '#718096'
  };

  // Pie: content types
  const pieCtx = document.getElementById('contentPie');
  if (!pieCtx) {
    console.error('[Horizon] Pie chart canvas not found');
    return;
  }
  
  const pieContext = pieCtx.getContext('2d');
  const labels = Object.keys(byContentType).filter(k => byContentType[k] > 0);
  const data = labels.map(k => {
    const minutes = byContentType[k] / MS_TO_MIN;
    return Math.max(0.1, Math.round(minutes * 10) / 10);
  });
  
  // Map colors to labels consistently
  const backgroundColor = labels.map(label => 
    contentTypeColors[label] || '#319795'
  );
  
  // Handle empty data
  if (labels.length === 0) {
    labels.push('No data');
    data.push(0);
    backgroundColor.push('#e2e8f0');
  }
  
  if (pieChart) pieChart.destroy();
  pieChart = new Chart(pieContext, {
    type: 'pie',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: backgroundColor
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { 
          position: 'bottom',
          labels: {
            font: {
              size: 12
            },
            padding: 12
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const label = context.label || '';
              const value = context.parsed || 0;
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
              const originalMs = byContentType[label] || 0;
              const seconds = Math.round(originalMs / 1000);
              if (value < 1) {
                return `${label}: ${seconds} sec (${percentage}%)`;
              }
              return `${label}: ${value.toFixed(1)} min (${percentage}%)`;
            }
          }
        }
      },
      // Ensure small segments are visible
      elements: {
        arc: {
          borderWidth: 2,
          borderColor: '#ffffff'
        }
      }
    }
  });

  // Bar: top domains
  const barCtx = document.getElementById('domainsBar');
  if (!barCtx) {
    console.error('[Horizon] Bar chart canvas not found');
    return;
  }
  
  const barContext = barCtx.getContext('2d');
  const top = topNFromMap(byDomain, 10); // Show top 10 domains
  
  // Color palette for bars (different color per bar)
  const barColors = [
    '#2b6cb0', // blue
    '#38a169', // green
    '#d69e2e', // yellow
    '#e53e3e', // red
    '#805ad5', // purple
    '#319795', // teal
    '#dd6b20', // orange
    '#e83e8c', // pink
    '#4299e1', // light blue
    '#48bb78'  // light green
  ];
  
  // Handle empty data with a message
  let barLabels, barData, barBackgroundColors;
  if (top.length === 0) {
    barLabels = ['No data yet'];
    barData = [0];
    barBackgroundColors = ['#e2e8f0'];
  } else {
    barLabels = top.map(t => {
      // Clean up domain names for display
      const domain = t.k.replace('www.', '');
      return domain.length > 15 ? domain.substring(0, 12) + '...' : domain;
    });
    barData = top.map(t => Math.round(t.v / MS_TO_MIN));
    // Assign a different color to each bar
    barBackgroundColors = barData.map((_, index) => barColors[index % barColors.length]);
  }
  
  if (barChart) barChart.destroy();
  barChart = new Chart(barContext, {
    type: 'bar',
    data: {
      labels: barLabels,
      datasets: [{
        label: 'Minutes',
        data: barData,
        backgroundColor: barBackgroundColors,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              if (context.parsed.y === 0 && top.length === 0) {
                return 'Visit social media sites to see tracking data';
              }
              return context.parsed.y + ' min';
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: function(value) {
              return value + ' min';
            }
          }
        },
        x: {
          ticks: {
            maxRotation: 45,
            minRotation: 0,
            font: {
              size: 10
            }
          }
        }
      }
    }
  });

  // Topic Classifications Chart (Doughnut)
  const topicCtx = document.getElementById('topicChart');
  if (!topicCtx) {
    console.error('[Horizon] Topic chart canvas not found');
    return;
  }
  
  // Get the container div for the topic chart
  const topicChartContainer = topicCtx.parentElement;
  let topicNoDataMessage = document.getElementById('topicNoDataMessage');
  
  // Filter topics with meaningful time (> 1000ms = 1 second minimum)
  const topicLabels = Object.keys(byTopic || {}).filter(k => byTopic[k] >= 1000);
  
  // Check if there's no data
  if (topicLabels.length === 0) {
    // Hide the canvas
    topicCtx.style.display = 'none';
    
    // Destroy existing chart if any
    if (topicChart) {
      topicChart.destroy();
      topicChart = null;
    }
    
    // Create or show the no data message
    if (!topicNoDataMessage) {
      topicNoDataMessage = document.createElement('div');
      topicNoDataMessage.id = 'topicNoDataMessage';
      topicNoDataMessage.style.cssText = 'display: flex; align-items: center; justify-content: center; height: 100%; padding: 20px; text-align: center; color: #718096; font-size: 14px; line-height: 1.6;';
      topicChartContainer.appendChild(topicNoDataMessage);
    }
    topicNoDataMessage.style.display = 'flex';
    topicNoDataMessage.textContent = 'No data has been collected yet. Use the extension for a while to see topic classifications here.';
    return;
  }
  
  // There is data, so hide the message and show the chart
  if (topicNoDataMessage) {
    topicNoDataMessage.style.display = 'none';
  }
  topicCtx.style.display = 'block';
  
  const topicContext = topicCtx.getContext('2d');
  // Convert to minutes, but keep at least 0.1 min for display if there's any time
  const topicData = topicLabels.map(k => {
    const minutes = byTopic[k] / MS_TO_MIN;
    // Round to 1 decimal place, but show at least 0.1 if there's any data
    return Math.max(0.1, Math.round(minutes * 10) / 10);
  });
  
  // Debug logging for topic chart
  console.log('[Horizon Popup] Topic chart data:', {
    rawByTopic: byTopic,
    topicLabels,
    topicData,
    topicDataInMs: topicLabels.map(k => byTopic[k]),
    filtered: Object.keys(byTopic || {}).filter(k => byTopic[k] < 1000)
  });
  
  // Define colors for topics
  const topicColors = {
    'entertainment': '#805ad5',
    'people': '#e83e8c',
    'technology': '#38a169',
    'politics': '#e53e3e',
    'sports': '#2b6cb0',
    'environment': '#48bb78',
    'social': '#4299e1',
    'cryptocurrency': '#f6ad55',
    'health': '#fc8181',
    'science': '#9f7aea',
    'business': '#4fd1c7',
    'finance': '#68d391',
    'investing': '#fbbf24',
    'economy': '#34d399',
    'law': '#a78bfa',
    'unknown': '#718096'
  };
  
  // Map colors to labels consistently
  const topicBackgroundColor = topicLabels.map(label => 
    topicColors[label] || '#319795'
  );
  
  if (topicChart) topicChart.destroy();
  topicChart = new Chart(topicContext, {
    type: 'doughnut',
    data: {
      labels: topicLabels,
      datasets: [{
        data: topicData,
        backgroundColor: topicBackgroundColor
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 1.5,
      plugins: {
        legend: { 
          position: 'bottom',
          labels: {
            font: {
              size: 12
            },
            padding: 12,
            generateLabels: function(chart) {
              const data = chart.data;
              const dataset = data.datasets[0];
              const total = dataset.data.reduce((a, b) => a + b, 0);
              
              return data.labels.map((label, index) => {
                const value = dataset.data[index];
                const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                return {
                  text: `${label} (${percentage}%)`,
                  fillStyle: dataset.backgroundColor[index],
                  hidden: false,
                  index: index
                };
              });
            }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const label = context.label || '';
              const value = context.parsed || 0;
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
              // Get original time in ms for this label
              const labelIndex = context.dataIndex;
              const originalMs = topicLabels[labelIndex] ? byTopic[topicLabels[labelIndex]] : 0;
              const seconds = Math.round(originalMs / 1000);
              // Show seconds if less than 1 minute
              if (value < 1) {
                return `${label}: ${seconds} sec (${percentage}%)`;
              }
              return `${label}: ${value.toFixed(1)} min (${percentage}%)`;
            }
          }
        }
      },
      elements: {
        arc: {
          borderWidth: 2,
          borderColor: '#ffffff'
        }
      }
    }
  });

  // Topic Counts Bar Chart
  const topicCountCanvas = document.getElementById('topicCountBar');
  if (!topicCountCanvas) {
    console.error('[Horizon] Topic count bar canvas not found');
    return;
  }

  const topicCountContext = topicCountCanvas.getContext('2d');
  const countEntries = Object.entries(byTopicCounts || {}).filter(([, count]) => count > 0);

  let topicCountLabels;
  let topicCountData;
  let topicCountColors;

  if (countEntries.length === 0) {
    topicCountLabels = ['No data yet'];
    topicCountData = [0];
    topicCountColors = ['#e2e8f0'];
  } else {
    topicCountLabels = countEntries.map(([label]) => label);
    topicCountData = countEntries.map(([, count]) => count);
    topicCountColors = topicCountLabels.map(label => topicColors[label] || '#319795');
  }

  if (topicCountChart) topicCountChart.destroy();
  topicCountChart = new Chart(topicCountContext, {
    type: 'bar',
    data: {
      labels: topicCountLabels,
      datasets: [{
        label: 'Posts',
        data: topicCountData,
        backgroundColor: topicCountColors,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              if (context.parsed.y === 0 && countEntries.length === 0) {
                return 'Topic classifications will appear here once available';
              }
              const count = context.parsed.y;
              return `${count} post${count !== 1 ? 's' : ''}`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            stepSize: 1,
            callback: function(value) {
              return `${value} post${value !== 1 ? 's' : ''}`;
            }
          }
        },
        x: {
          ticks: {
            maxRotation: 45,
            minRotation: 0,
            font: {
              size: 10
            }
          }
        }
      }
    }
  });
}

function renderMetrics(byDomain, byContentType, totalMs) {
  const metricsDiv = document.getElementById('metrics');

  const domainCounts = Object.values(byDomain);
  const topicCounts = Object.values(byContentType);

  const ent = entropyFromCounts(topicCounts).toFixed(2);
  // top-3 concentration: percent of time in top 3 domains
  const top3 = topNFromMap(byDomain, 3).reduce((s, x) => s + x.v, 0);
  const concentration = totalMs > 0 ? Math.round((top3 / totalMs) * 100) : 0;

  metricsDiv.innerHTML = `
    <div>Topic entropy: <strong>${ent}</strong></div>
    <div>Top-3 domain concentration: <strong>${concentration}%</strong></div>
  `;
}

function drawUI(cache) {
  try {
    // Ensure cache is a valid object
    if (!cache || typeof cache !== 'object') {
      console.warn('[Horizon Popup] Invalid cache data, using defaults');
      cache = {
        day: new Date().toISOString().slice(0, 10),
        byDomain: {},
        byContentType: {},
        byTopic: {},
        byTopicCounts: {},
        totalMs: 0
      };
    }
    
    const totalMs = cache.totalMs || 0;
    const byDomain = cache.byDomain || {};
    const byContentType = cache.byContentType || {};
    const byTopic = cache.byTopic || {};
    const byTopicCounts = cache.byTopicCounts || {};

    // Debug logging
    console.log('[Horizon Popup] Data received:', {
      totalMs,
      byDomain: Object.keys(byDomain).length,
      byContentType: Object.keys(byContentType).length,
      byTopic: Object.keys(byTopic).length,
      byTopicCounts: Object.keys(byTopicCounts).length,
      byTopicData: byTopic,
      byTopicCountsData: byTopicCounts
    });

    const summarySmallEl = document.getElementById('summarySmall');
    if (summarySmallEl) {
      summarySmallEl.textContent = `Today • ${formatMinutes(totalMs)}`;
    }

    renderCharts(byContentType, byDomain, byTopic, byTopicCounts);
    renderMetrics(byDomain, byContentType, totalMs);
  } catch (error) {
    console.error('[Horizon Popup] Error rendering UI:', error);
    // Show error message but keep popup visible
    const container = document.querySelector('.container');
    if (container) {
      const errorMsg = document.createElement('div');
      errorMsg.style.cssText = 'padding: 20px; color: #e53e3e; background: #fff; border-radius: 8px; margin: 12px;';
      errorMsg.textContent = 'Error rendering data. Please refresh.';
      container.appendChild(errorMsg);
    }
  }
}

// Removed checkLRModelStatus - model is now pre-loaded, no training needed

function updateClassifierStatus() {
  chrome.storage.local.get(['settings'], (res) => {
    const settings = res.settings || {};
    const classifierStatus = document.getElementById('classifierStatus');
    const classifierStatusText = document.getElementById('classifierStatusText');
    
    if (!classifierStatus || !classifierStatusText) return;
    
    // Check logistic regression status
    chrome.runtime.sendMessage({ type: 'check_lr_model' }, (lrResponse) => {
      const lrLoaded = lrResponse && lrResponse.isLoaded === true;
      const mlEnabled = settings.enableML === true;
      
      let statusText = '';
      let showStatus = false;
      
      if (lrLoaded && mlEnabled) {
        // Logistic regression is being used
        statusText = `Using <strong>Logistic Regression</strong> for classification`;
        showStatus = true;
      } else if (mlEnabled && !lrLoaded) {
        // ML enabled but logistic regression not loaded
        statusText = `Classification enabled but <strong>logistic regression model failed to load</strong>`;
        showStatus = true;
      } else {
        // No classification active
        statusText = `Classification <strong>disabled</strong>. Enable it in the extension options menu.`;
        showStatus = true;
      }
    
      if (showStatus) {
        classifierStatusText.innerHTML = statusText;
        classifierStatus.style.display = 'block';
      } else {
        classifierStatus.style.display = 'none';
      }
    });
  });
}

function updateRecommendationsLLMStatusGlobal() {
  chrome.storage.local.get(['settings'], (res) => {
    const settings = res.settings || {};
    const llmStatusElement = document.getElementById('recommendationsLLMStatusGlobal');
    const llmStatusText = document.getElementById('recommendationsLLMStatusGlobalText');
    
    if (!llmStatusElement || !llmStatusText) return;
    
    const llmPreference = settings.recommendationLLM || 'smollm';
    const recommendationsEnabled = settings.enableRecommendations === true;
    
    if (recommendationsEnabled) {
      if (llmPreference === 'chatgpt') {
        llmStatusText.textContent = 'Using ChatGPT (GPT-4o-mini) for recommendations. Note: ChatGPT may not always be available.';
      } else {
        llmStatusText.textContent = 'Using SmolLM-135M (local model) for recommendations. Note: SmolLM recommendations may not be of the best quality.';
      }
      llmStatusElement.style.display = 'block';
    } else {
      llmStatusText.textContent = 'Recommendations are disabled. Enable them in the extension options to receive automatic recommendations at the end of each day.';
      llmStatusElement.style.display = 'block';
    }
  });
}

function renderPreviousDaySummary(summary) {
  const section = document.getElementById('previousDaySummarySection');
  const dateElement = document.getElementById('previousDayDate');
  const statsElement = document.getElementById('previousDaySummaryStats');
  
  console.log('[Horizon Popup] renderPreviousDaySummary called:', {
    sectionExists: !!section,
    dateElementExists: !!dateElement,
    statsElementExists: !!statsElement,
    summaryExists: !!summary,
    summaryDay: summary?.day
  });
  
  if (!section || !dateElement || !statsElement) {
    console.error('[Horizon Popup] Missing required elements for previous day summary');
    return;
  }
  
  if (!summary || !summary.day) {
    // No previous day data available
    console.log('[Horizon Popup] No previous day data, hiding section');
    section.style.display = 'none';
    return;
  }
  
  // Show the section
  console.log('[Horizon Popup] Showing previous day summary section for:', summary.day);
  section.style.display = 'block';
  section.style.visibility = 'visible';
  section.style.opacity = '1';
  
  // Store the summary snapshot so it persists across popup closes (like recommendations)
  chrome.storage.local.set({
    'horizon_summary_snapshot': summary,
    'horizon_summary_date': summary.day
  }, () => {
    console.log('[Horizon Popup] Summary snapshot stored for persistence');
  });
  
  // Format and display the date
  const dateObj = new Date(summary.day + 'T00:00:00');
  const formattedDate = dateObj.toLocaleDateString('en-US', { 
    month: 'long', 
    day: 'numeric', 
    year: 'numeric' 
  });
  dateElement.textContent = `Summary for: ${formattedDate}`;
  
  // Calculate statistics
  const totalMs = summary.totalMs || 0;
  
  const byDomain = summary.byDomain || {};
  const byContentType = summary.byContentType || {};
  const byTopic = summary.byTopic || {};
  const byTopicCounts = summary.byTopicCounts || {};
  const seenPosts = summary.seenPosts || {};
  
  // Get top domains
  const topDomains = topNFromMap(byDomain, 5);
  const topContentTypes = topNFromMap(byContentType, 5);
  const topTopics = topNFromMap(byTopic, 5);
  
  // Calculate total posts from byTopicCounts (primary source)
  let totalPosts = Object.values(byTopicCounts).reduce((sum, count) => sum + (count || 0), 0);
  
  // Fallback: if byTopicCounts seems incomplete but we have seenPosts, use seenPosts count
  // This helps catch cases where byTopicCounts might not have been properly updated
  if (totalPosts === 0 && Object.keys(seenPosts).length > 0) {
    // Count unique posts from seenPosts that have valid titles and topics
    const validPosts = Object.values(seenPosts).filter(post => 
      post && post.title && post.title.trim().length > 5 && post.topic && post.topic !== 'unknown'
    );
    if (validPosts.length > 0) {
      console.log('[Horizon] Using seenPosts fallback for post count:', validPosts.length);
      totalPosts = validPosts.length;
    }
  }
  
  // Debug logging
  console.log('[Horizon] Previous day summary stats:', {
    totalMs,
    totalPosts,
    byTopicCountsTotal: Object.values(byTopicCounts).reduce((sum, count) => sum + (count || 0), 0),
    seenPostsCount: Object.keys(seenPosts).length,
    byTopicKeys: Object.keys(byTopic).length,
    byDomainKeys: Object.keys(byDomain).length
  });
  
  // Build summary HTML
  let summaryHTML = '';
  
  // Total time - format as minutes and seconds (not rounded)
  if (totalMs > 0) {
    summaryHTML += `<div style="margin-bottom: 12px;"><strong>Total Time:</strong> ${formatMinutesAndSeconds(totalMs)}</div>`;
  } else {
    summaryHTML += `<div style="margin-bottom: 12px;"><strong>Total Time:</strong> Less than 1 second</div>`;
  }
  
  // Total posts
  if (totalPosts > 0) {
    summaryHTML += `<div style="margin-bottom: 12px;"><strong>Total Posts Viewed:</strong> ${totalPosts}</div>`;
  }
  
  // Top domains
  if (topDomains.length > 0) {
    summaryHTML += `<div style="margin-bottom: 12px;"><strong>Top Domains:</strong><ul style="margin: 4px 0 0 20px; padding: 0;">`;
    topDomains.forEach(domain => {
      summaryHTML += `<li>${domain.k}: ${formatMinutesAndSeconds(domain.v)}</li>`;
    });
    summaryHTML += `</ul></div>`;
  }
  
  // Top content types
  if (topContentTypes.length > 0) {
    summaryHTML += `<div style="margin-bottom: 12px;"><strong>Content Types:</strong><ul style="margin: 4px 0 0 20px; padding: 0;">`;
    topContentTypes.forEach(type => {
      summaryHTML += `<li>${type.k}: ${formatMinutesAndSeconds(type.v)}</li>`;
    });
    summaryHTML += `</ul></div>`;
  }
  
  // Top topics
  if (topTopics.length > 0) {
    summaryHTML += `<div style="margin-bottom: 12px;"><strong>Top Topics:</strong><ul style="margin: 4px 0 0 20px; padding: 0;">`;
    topTopics.forEach(topic => {
      const postCount = byTopicCounts[topic.k] || 0;
      summaryHTML += `<li>${topic.k}: ${formatMinutesAndSeconds(topic.v)} (${postCount} post${postCount !== 1 ? 's' : ''})</li>`;
    });
    summaryHTML += `</ul></div>`;
  }
  
  // If no data
  if (totalMs === 0 && totalPosts === 0) {
    summaryHTML = '<div style="color: #718096; font-style: italic;">No consumption data available for this day.</div>';
  }
  
  statsElement.innerHTML = summaryHTML;
}

function loadPreviousDaySummary() {
  console.log('[Horizon Popup] Loading previous day summary...');
  
  // First, try to load stored summary snapshot (for persistence, like recommendations)
  chrome.storage.local.get([
    'horizon_summary_snapshot', 
    'horizon_summary_date', 
    'horizon_recommendations_date',
    'horizon_recommendations_summary'
  ], (stored) => {
    const storedSummary = stored.horizon_summary_snapshot;
    const storedSummaryDate = stored.horizon_summary_date;
    const recommendationsDate = stored.horizon_recommendations_date;
    const recommendationsSummary = stored.horizon_recommendations_summary;
    
    // Priority 1: Use summary stored with recommendations (most reliable)
    if (recommendationsSummary && recommendationsSummary.day && recommendationsDate) {
      console.log('[Horizon Popup] Loading summary from recommendations snapshot for:', recommendationsSummary.day);
      renderPreviousDaySummary(recommendationsSummary);
      return;
    }
    
    // Priority 2: Use stored summary snapshot if it matches recommendations date
    if (storedSummary && storedSummary.day && storedSummaryDate === recommendationsDate) {
      console.log('[Horizon Popup] Loading stored summary snapshot for:', storedSummary.day);
      renderPreviousDaySummary(storedSummary);
      return;
    }
    
    // Priority 3: Get it from the background script
    chrome.runtime.sendMessage({ type: 'get_previous_day_summary' }, (summary) => {
      if (chrome.runtime.lastError) {
        console.error('[Horizon Popup] Error loading previous day summary:', chrome.runtime.lastError);
        // If background fails but we have a stored summary, use it anyway
        if (storedSummary && storedSummary.day) {
          console.log('[Horizon Popup] Background failed, using stored summary snapshot');
          renderPreviousDaySummary(storedSummary);
        } else if (recommendationsSummary && recommendationsSummary.day) {
          console.log('[Horizon Popup] Background failed, using recommendations summary snapshot');
          renderPreviousDaySummary(recommendationsSummary);
        }
        return;
      }
      
      console.log('[Horizon Popup] Previous day summary received:', summary ? {
        day: summary.day,
        hasData: !!summary.day,
        totalMs: summary.totalMs,
        byTopicCountsKeys: Object.keys(summary.byTopicCounts || {}).length
      } : 'null');
      
      // If we got a summary from background, use it (it will be stored by renderPreviousDaySummary)
      if (summary && summary.day) {
        renderPreviousDaySummary(summary);
      } else if (storedSummary && storedSummary.day) {
        // Fallback to stored summary if background returns null
        console.log('[Horizon Popup] Background returned null, using stored summary snapshot');
        renderPreviousDaySummary(storedSummary);
      } else if (recommendationsSummary && recommendationsSummary.day) {
        // Fallback to recommendations summary if background returns null
        console.log('[Horizon Popup] Background returned null, using recommendations summary snapshot');
        renderPreviousDaySummary(recommendationsSummary);
      }
    });
  });
}

function renderRecommendations(recommendations, date = null, saveToStorage = true) {
  const section = document.getElementById('recommendationsSection');
  const list = document.getElementById('recommendationsList');
  const loading = document.getElementById('recommendationsLoading');
  const error = document.getElementById('recommendationsError');
  const dateElement = document.getElementById('recommendationsDate');
  
  if (!section || !list) return;
  
  // Hide loading and error
  if (loading) loading.style.display = 'none';
  if (error) {
    error.style.display = 'none';
    error.textContent = '';
    // Reset error styling
    error.style.background = '#fed7d7';
    error.style.color = '#e53e3e';
    error.style.border = '1px solid #e53e3e';
  }
  
  // Always show the section
  section.style.display = 'block';
  
  // Ensure previous day summary section remains visible (they should coexist)
  const previousDaySection = document.getElementById('previousDaySummarySection');
  if (previousDaySection && previousDaySection.style.display === 'block') {
    // Previous day summary is already visible, keep it that way
    console.log('[Horizon Popup] Previous day summary section is visible, keeping it visible');
  }
  
  // Check if recommendations are enabled
  chrome.storage.local.get(['settings'], (res) => {
    const settings = res.settings || {};
    const recommendationsEnabled = settings.enableRecommendations === true;
    
    if (!recommendationsEnabled) {
      // Recommendations are disabled - clear the list and don't show recommendations
      // The status message is already shown by updateRecommendationsLLMStatus() called in DOMContentLoaded
      list.innerHTML = '';
      const noteElement = document.getElementById('recommendationsNote');
      if (noteElement) {
        noteElement.style.display = 'none';
      }
      if (dateElement) {
        dateElement.style.display = 'none';
      }
      return;
    }
    
    // Recommendations are enabled - proceed with normal rendering
    // Get note element and show it when rendering recommendations
    const noteElement = document.getElementById('recommendationsNote');
    if (noteElement) {
      noteElement.style.display = 'block';
    }
    
    // Display date if provided (format: "Month day-day after", e.g., "December 7-8")
    if (dateElement) {
      if (date) {
        const dateObj = new Date(date);
        const nextDay = new Date(dateObj);
        nextDay.setDate(nextDay.getDate() + 1);
        
        // Format as "Month day-day after" (e.g., "December 7-8")
        const month = dateObj.toLocaleDateString('en-US', { month: 'long' });
        const day = dateObj.getDate();
        const nextDayNum = nextDay.getDate();
        
        const formattedDate = `${month} ${day}-${nextDayNum}`;
        dateElement.textContent = `Generated for: ${formattedDate}`;
        dateElement.style.display = 'block';
      } else {
        dateElement.style.display = 'none';
      }
    }
    
    // Render recommendations with proper bullet point formatting
    // Keep existing recommendations visible if no new ones provided
    if (!recommendations || recommendations.trim().length === 0) {
      // Only show "no recommendations" if list is empty
      if (list.innerHTML.trim().length === 0) {
        list.innerHTML = '<div style="padding: 16px; color: #718096; text-align: center; line-height: 1.6;">No recommendations have been generated yet! Use the extension for a while. Recommendations will be generated at the end of the day.</div>';
      }
      return;
    }
    
    // Save recommendations to storage so they persist across popup closes
    if (saveToStorage) {
      chrome.storage.local.set({ 
        'horizon_recommendations': recommendations,
        'horizon_recommendations_date': date || new Date().toISOString().slice(0, 10)
      }, () => {
        console.log('[Horizon] Recommendations saved to storage');
      });
    }
    
    list.innerHTML = '';
    const recDiv = document.createElement('div');
    recDiv.style.cssText = 'padding: 16px; background: #f7fafc; border-left: 4px solid #2b6cb0; border-radius: 4px; line-height: 1.8;';
    
    // Parse recommendations text and format as bullet points
    // Handle plain text lines (bullets will be added by this function)
    let formattedText = recommendations.trim();
    
    // Remove any existing bullets to prevent double bullets
    formattedText = formattedText.replace(/^[•\-\*]\s*/gm, ''); // Remove leading bullets
    formattedText = formattedText.replace(/\s*[•\-\*]\s*/g, ' '); // Remove any bullets in text
    
    // Split by newlines to get individual recommendations
    const lines = formattedText.split('\n').filter(line => line.trim().length > 0);
    
    // If we have multiple lines, each is a recommendation
    if (lines.length > 1) {
      formattedText = lines.map(line => {
        const trimmed = line.trim();
        // Remove any remaining bullets just in case
        const clean = trimmed.replace(/^[•\-\*]\s*/, '').trim();
        return clean;
      }).filter(line => line.length > 0).join('\n');
    } else if (lines.length === 1) {
      // Single line - remove any bullets
      formattedText = lines[0].trim().replace(/^[•\-\*]\s*/, '');
    }
    
    // Convert to HTML with proper line breaks and SINGLE bullet styling
    const htmlContent = formattedText
      .split('\n')
      .map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        
        // Remove any bullets that might still be there
        const cleanContent = trimmed.replace(/^[•\-\*]\s*/, '').trim();
        
        if (cleanContent) {
          // Add SINGLE bullet point
          return `<div style="margin-bottom: 8px; padding-left: 4px;">• ${cleanContent}</div>`;
        }
        return '';
      })
      .filter(html => html.length > 0)
      .join('');
    
    recDiv.innerHTML = htmlContent || recommendations; // Fallback to plain text if parsing fails
    list.appendChild(recDiv);
  });
}

function updateRecommendationsLLMStatus() {
  chrome.storage.local.get(['settings'], (res) => {
    const settings = res.settings || {};
    const llmStatusElement = document.getElementById('recommendationsLLMStatus');
    const llmStatusText = document.getElementById('recommendationsLLMStatusText');
    
    if (!llmStatusElement || !llmStatusText) return;
    
    const llmPreference = settings.recommendationLLM || 'smollm';
    const recommendationsEnabled = settings.enableRecommendations === true;
    
    if (recommendationsEnabled) {
      if (llmPreference === 'chatgpt') {
        llmStatusText.textContent = 'Using ChatGPT (GPT-4o-mini) for recommendations. Note: ChatGPT may not always be available.';
      } else {
        llmStatusText.textContent = 'Using SmolLM-135M (local model) for recommendations. Note: SmolLM recommendations may not be of the best quality.';
      }
      llmStatusElement.style.display = 'block';
    } else {
      llmStatusText.textContent = 'Recommendations must be enabled in the options menu to receive them.';
      llmStatusElement.style.display = 'block';
    }
  });
}

function loadSummary() {
  // Load today's summary without triggering recommendation generation
  // (recommendations are generated after summary is loaded if needed)
  chrome.runtime.sendMessage({ type: 'get_today_summary', skipRecommendationCheck: true }, (res) => {
    if (chrome.runtime.lastError) {
      console.error('[Horizon Popup] Error loading summary:', chrome.runtime.lastError);
      // Use empty data structure if there's an error
      const cache = { 
        day: new Date().toISOString().slice(0,10), 
        byDomain: {}, 
        byContentType: {}, 
        byTopic: {}, 
        byTopicCounts: {}, 
        totalMs: 0 
      };
      drawUI(cache);
      return;
    }
    
    // Ensure we have a valid response object
    const cache = res || { 
      day: new Date().toISOString().slice(0,10), 
      byDomain: {}, 
      byContentType: {}, 
      byTopic: {}, 
      byTopicCounts: {}, 
      totalMs: 0 
    };
    
    // Ensure all required properties exist
    if (!cache.byDomain) cache.byDomain = {};
    if (!cache.byContentType) cache.byContentType = {};
    if (!cache.byTopic) cache.byTopic = {};
    if (!cache.byTopicCounts) cache.byTopicCounts = {};
    if (typeof cache.totalMs !== 'number') cache.totalMs = 0;
    
    drawUI(cache);
  });
}

function clearTodayData() {
  if (!confirm('Are you sure you want to clear all data for today? This action cannot be undone.\n\nThis will restart the extension and may take a few minutes.')) {
    return;
  }
  
  const clearBtn = document.getElementById('clearBtn');
  const clearingMsg = document.getElementById('clearingMessage');
  const originalText = clearBtn.textContent;
  
  // Show clearing message and disable button
  if (clearingMsg) {
    clearingMsg.style.display = 'block';
  }
  clearBtn.disabled = true;
  clearBtn.textContent = 'Clearing...';
  
  chrome.runtime.sendMessage({ type: 'clear_today_data' }, (response) => {
    // Hide clearing message
    if (clearingMsg) {
      clearingMsg.style.display = 'none';
    }
    clearBtn.disabled = false;
    clearBtn.textContent = originalText;
    
    if (chrome.runtime.lastError) {
      console.error('[Horizon] Error clearing data:', chrome.runtime.lastError);
      alert('Failed to clear today\'s data: ' + chrome.runtime.lastError.message);
      return;
    }
    
    if (response && response.success) {
      // Reload the summary to show empty state
      // Use a small delay to ensure storage is updated
      setTimeout(() => {
        loadSummary();
        console.log('[Horizon] Today\'s data cleared successfully');
      }, 100);
    } else {
      console.error('[Horizon] Failed to clear today\'s data:', response);
      alert('Failed to clear today\'s data. Please try again.');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // Show initializing message
  const initializingMsg = document.getElementById('initializingMessage');
  if (initializingMsg) {
    initializingMsg.style.display = 'block';
  }
  
  // Update date and time immediately and set up periodic updates
  updateDateTime();
  setInterval(updateDateTime, 60000); // Update every minute
  
  // Update classifier status
  updateClassifierStatus();
  
  // Show recommendations section only if recommendations are enabled
  // (It will be shown/hidden by renderRecommendations based on settings)
  // Don't force it to show here - let renderRecommendations handle it
  
  // Load previous day's summary
  loadPreviousDaySummary();
  
  // Update LLM status (this will be called by updateClassifierStatus)
  // Also update recommendations LLM status in the recommendations section
  updateRecommendationsLLMStatus();
  
  // Load and display stored recommendations if they exist, otherwise show "no recommendations" message
  // Also trigger a check for recommendation generation (in case they need to be generated)
  chrome.storage.local.get(['horizon_recommendations', 'horizon_recommendations_date'], (result) => {
    if (result.horizon_recommendations && result.horizon_recommendations.trim().length > 0) {
      console.log('[Horizon] Loading stored recommendations');
      renderRecommendations(result.horizon_recommendations, result.horizon_recommendations_date || null, false); // Don't save again, just display
      // Ensure previous day summary is also loaded when recommendations exist
      // Use a small delay to ensure data is available
      setTimeout(() => {
        loadPreviousDaySummary();
      }, 100);
    } else {
      // No stored recommendations - show the "no recommendations" message
      console.log('[Horizon] No stored recommendations found');
      renderRecommendations(null, null, false);
      
      // Trigger a check for recommendation generation by requesting today's summary
      // This will call checkDayEndAndGenerateRecommendations() in the background
      // We do this asynchronously so it doesn't block the popup from loading
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'get_today_summary' }, (summaryResponse) => {
          if (chrome.runtime.lastError) {
            console.error('[Horizon] Error getting summary:', chrome.runtime.lastError);
            return;
          }
          // After getting summary, check again for recommendations (they might have been generated)
          // Wait a bit longer for async recommendation generation to complete
          setTimeout(() => {
            chrome.storage.local.get(['horizon_recommendations', 'horizon_recommendations_date'], (updatedResult) => {
              if (updatedResult.horizon_recommendations && updatedResult.horizon_recommendations.trim().length > 0) {
                console.log('[Horizon] Recommendations were generated, updating display');
                renderRecommendations(updatedResult.horizon_recommendations, updatedResult.horizon_recommendations_date || null, false);
                // Also refresh previous day summary in case it was just generated (with a small delay to ensure snapshot is stored)
                setTimeout(() => {
                  loadPreviousDaySummary();
                }, 500);
              }
            });
          }, 2000); // Wait 2 seconds for recommendation generation to complete
        });
      }, 500); // Small delay to ensure background script is ready
    }
  });
  
  // Wait for Chart.js to be fully loaded
  if (typeof Chart !== 'undefined') {
    // Load today's summary without triggering recommendation generation
    // (recommendations will be generated after summary is loaded if needed)
    chrome.runtime.sendMessage({ type: 'get_today_summary', skipRecommendationCheck: true }, (res) => {
      if (chrome.runtime.lastError) {
        console.error('[Horizon Popup] Error loading summary:', chrome.runtime.lastError);
        // Use empty data structure if there's an error
        const cache = { 
          day: new Date().toISOString().slice(0,10), 
          byDomain: {}, 
          byContentType: {}, 
          byTopic: {}, 
          byTopicCounts: {}, 
          totalMs: 0 
        };
        drawUI(cache);
        return;
      }
      
      // Ensure we have a valid response object
      const cache = res || { 
        day: new Date().toISOString().slice(0,10), 
        byDomain: {}, 
        byContentType: {}, 
        byTopic: {}, 
        byTopicCounts: {}, 
        totalMs: 0 
      };
      
      // Ensure all required properties exist
      if (!cache.byDomain) cache.byDomain = {};
      if (!cache.byContentType) cache.byContentType = {};
      if (!cache.byTopic) cache.byTopic = {};
      if (!cache.byTopicCounts) cache.byTopicCounts = {};
      if (typeof cache.totalMs !== 'number') cache.totalMs = 0;
      
      drawUI(cache);
    });
    
    document.getElementById('refreshBtn').addEventListener('click', () => {
      // Refresh also skips recommendation check to avoid redundant generation
      chrome.runtime.sendMessage({ type: 'get_today_summary', skipRecommendationCheck: true }, (res) => {
        if (chrome.runtime.lastError) {
          console.error('[Horizon Popup] Error loading summary:', chrome.runtime.lastError);
          return;
        }
        const cache = res || { 
          day: new Date().toISOString().slice(0,10), 
          byDomain: {}, 
          byContentType: {}, 
          byTopic: {}, 
          byTopicCounts: {}, 
          totalMs: 0 
        };
        if (!cache.byDomain) cache.byDomain = {};
        if (!cache.byContentType) cache.byContentType = {};
        if (!cache.byTopic) cache.byTopic = {};
        if (!cache.byTopicCounts) cache.byTopicCounts = {};
        if (typeof cache.totalMs !== 'number') cache.totalMs = 0;
        drawUI(cache);
        updateClassifierStatus(); // Update classifier status on refresh
      });
    });
    document.getElementById('clearBtn').addEventListener('click', clearTodayData);
  } else {
        // If Chart.js isn't loaded yet, wait a bit and try again
        setTimeout(() => {
          if (typeof Chart !== 'undefined') {
            // Load today's summary without triggering recommendation generation
            chrome.runtime.sendMessage({ type: 'get_today_summary', skipRecommendationCheck: true }, (res) => {
              if (chrome.runtime.lastError) {
                console.error('[Horizon Popup] Error loading summary:', chrome.runtime.lastError);
                return;
              }
              const cache = res || { 
                day: new Date().toISOString().slice(0,10), 
                byDomain: {}, 
                byContentType: {}, 
                byTopic: {}, 
                byTopicCounts: {}, 
                totalMs: 0 
              };
              if (!cache.byDomain) cache.byDomain = {};
              if (!cache.byContentType) cache.byContentType = {};
              if (!cache.byTopic) cache.byTopic = {};
              if (!cache.byTopicCounts) cache.byTopicCounts = {};
              if (typeof cache.totalMs !== 'number') cache.totalMs = 0;
              drawUI(cache);
            });
            
            document.getElementById('refreshBtn').addEventListener('click', () => {
              chrome.runtime.sendMessage({ type: 'get_today_summary', skipRecommendationCheck: true }, (res) => {
                if (chrome.runtime.lastError) {
                  console.error('[Horizon Popup] Error loading summary:', chrome.runtime.lastError);
                  return;
                }
                const cache = res || { 
                  day: new Date().toISOString().slice(0,10), 
                  byDomain: {}, 
                  byContentType: {}, 
                  byTopic: {}, 
                  byTopicCounts: {}, 
                  totalMs: 0 
                };
                if (!cache.byDomain) cache.byDomain = {};
                if (!cache.byContentType) cache.byContentType = {};
                if (!cache.byTopic) cache.byTopic = {};
                if (!cache.byTopicCounts) cache.byTopicCounts = {};
                if (typeof cache.totalMs !== 'number') cache.totalMs = 0;
                drawUI(cache);
                updateClassifierStatus(); // Update classifier status on refresh
              });
            });
            document.getElementById('clearBtn').addEventListener('click', clearTodayData);
          } else {
            console.error('[Horizon] Chart.js failed to load');
            document.body.innerHTML = '<div style="padding: 20px; color: #e53e3e;">Error: Chart.js library failed to load. Please refresh the extension.</div>';
          }
        }, 500);
      }
});

