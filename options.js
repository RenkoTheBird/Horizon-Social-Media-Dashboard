// options.js
// Wait for page to load and scripts to be available
document.addEventListener('DOMContentLoaded', async () => {
  // Give scripts a moment to load
  await new Promise(resolve => setTimeout(resolve, 100));
  initOptions();
});

async function initOptions() {
  const enableTracking = document.getElementById('enableTracking');
  const includeTitles = document.getElementById('includeTitles');
  const enableML = document.getElementById('enableML');
  const recommendationLLMChatGPT = document.getElementById('recommendationLLMChatGPT');
  const recommendationLLMSmolLM = document.getElementById('recommendationLLMSmolLM');
  const enableRecommendations = document.getElementById('enableRecommendations');
  const exportBtn = document.getElementById('exportBtn');
  const clearBtn = document.getElementById('clearBtn');
  const exportDataDiv = document.getElementById('exportData');
  const lrStatus = document.getElementById('lrStatus');
  // Check if all required elements exist
  if (!enableTracking || !includeTitles || !enableML || !exportBtn || 
      !clearBtn || !exportDataDiv) {
    console.error('[Horizon] Missing required DOM elements in options page');
    return;
  }

  // Load existing settings
  chrome.storage.local.get(['settings'], (res) => {
    const s = res.settings || {};
    enableTracking.checked = s.enableTracking === true;
    includeTitles.checked = s.includeTitles === true;
    enableML.checked = s.enableML === true;
    enableRecommendations.checked = s.enableRecommendations === true;
    
    // Set LLM preference (default to 'smollm' if not set)
    const llmPreference = s.recommendationLLM || 'smollm';
    if (recommendationLLMChatGPT && recommendationLLMSmolLM) {
      if (llmPreference === 'chatgpt') {
        recommendationLLMChatGPT.checked = true;
      } else {
        recommendationLLMSmolLM.checked = true;
      }
    }
  });

  // Save settings on change
  const settingsElements = [enableTracking, includeTitles, enableML, enableRecommendations];
  
  settingsElements.forEach(el =>
    el.addEventListener('change', () => {
      chrome.storage.local.get(['settings'], (res) => {
        const s = res.settings || {};
        const selectedLLM = recommendationLLMChatGPT?.checked ? 'chatgpt' : 'smollm';
        chrome.storage.local.set({
          settings: {
            ...s,
            enableTracking: enableTracking.checked,
            includeTitles: includeTitles.checked,
            enableML: enableML.checked,
            enableRecommendations: enableRecommendations.checked,
            recommendationLLM: selectedLLM
          }
        });
      });
    })
  );

  // Handle LLM preference radio button changes
  if (recommendationLLMChatGPT) {
    recommendationLLMChatGPT.addEventListener('change', () => {
      if (recommendationLLMChatGPT.checked) {
        chrome.storage.local.get(['settings'], (res) => {
          const s = res.settings || {};
          chrome.storage.local.set({
            settings: {
              ...s,
              recommendationLLM: 'chatgpt'
            }
          });
        });
      }
    });
  }

  if (recommendationLLMSmolLM) {
    recommendationLLMSmolLM.addEventListener('change', () => {
      if (recommendationLLMSmolLM.checked) {
        chrome.storage.local.get(['settings'], (res) => {
          const s = res.settings || {};
          chrome.storage.local.set({
            settings: {
              ...s,
              recommendationLLM: 'smollm'
            }
          });
        });
      }
    });
  }

  // Export
  exportBtn.addEventListener('click', () => {
    chrome.storage.local.get(null, (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `horizon-export-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      exportDataDiv.textContent = "Data exported successfully.";
    });
  });

  // Clear
  clearBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to delete all stored data?')) {
      chrome.storage.local.clear(() => {
        alert('All data cleared.');
      });
    }
  });

  // Check logistic regression model status
  if (lrStatus) {
    chrome.runtime.sendMessage({ type: 'check_lr_model' }, (response) => {
      if (response && response.isLoaded) {
        const modelInfo = response.modelInfo || {};
        const numClasses = modelInfo.numClasses || 15;
        const embeddingDim = modelInfo.embeddingDim || 384;
        lrStatus.innerHTML = `
          <div style="color: #38a169; font-weight: 600; margin-bottom: 8px; margin-top: 12px;">
            Logistic Regression Model Loaded
          </div>
          <div style="font-size: 14px; color: #4a5568; line-height: 1.6;">
            <strong>Classes:</strong> ${numClasses}<br>
            <strong>Embedding dimension:</strong> ${embeddingDim}<br>
            <span style="color: #718096; font-size: 12px; margin-top: 4px; display: block;">
              The logistic regression classifier uses pre-trained weights and will be used for topic classification when enabled.
            </span>
          </div>
        `;
      } else {
        lrStatus.innerHTML = `
          <div style="color: #e53e3e; font-weight: 600; margin-bottom: 8px; margin-top: 12px;">
            Logistic Regression Model Failed to Load
          </div>
          <div style="font-size: 14px; color: #4a5568; line-height: 1.6;">
            <span style="color: #718096; font-size: 12px; margin-top: 4px; display: block;">
              Check the browser console for error details. The model weights should be in dataset/model_weights.json.
            </span>
          </div>
        `;
      }
    });
  }
}
