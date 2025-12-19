// options.js
// Wait for page to load and scripts to be available
document.addEventListener('DOMContentLoaded', async () => {
  // Give scripts a moment to load
  await new Promise(resolve => setTimeout(resolve, 100));
  initOptions();
});

async function initOptions() {
  const enableTracking = document.getElementById('enableTracking');
  const enableML = document.getElementById('enableML');
  const recommendationLLMChatGPT = document.getElementById('recommendationLLMChatGPT');
  const recommendationLLMSmolLM = document.getElementById('recommendationLLMSmolLM');
  const enableRecommendations = document.getElementById('enableRecommendations');
  const exportBtn = document.getElementById('exportBtn');
  const clearBtn = document.getElementById('clearBtn');
  const exportDataDiv = document.getElementById('exportData');
  const recommendationModelOptions = document.getElementById('recommendationModelOptions');
  // Check if all required elements exist
  if (!enableTracking || !enableML || !exportBtn || 
      !clearBtn || !exportDataDiv) {
    console.error('[Horizon] Missing required DOM elements in options page');
    return;
  }

  // Function to update recommendation model options visibility
  function updateRecommendationModelOptions() {
    if (recommendationModelOptions && enableRecommendations) {
      const isEnabled = enableRecommendations.checked;
      if (isEnabled) {
        recommendationModelOptions.style.opacity = '1';
        recommendationModelOptions.style.pointerEvents = 'auto';
        if (recommendationLLMChatGPT) recommendationLLMChatGPT.disabled = false;
        if (recommendationLLMSmolLM) recommendationLLMSmolLM.disabled = false;
      } else {
        recommendationModelOptions.style.opacity = '0.5';
        recommendationModelOptions.style.pointerEvents = 'none';
        if (recommendationLLMChatGPT) recommendationLLMChatGPT.disabled = true;
        if (recommendationLLMSmolLM) recommendationLLMSmolLM.disabled = true;
      }
    }
  }

  // Load existing settings
  chrome.storage.local.get(['settings'], (res) => {
    const s = res.settings || {};
    // enableTracking controls both enableTracking and includeTitles
    // Show as checked if either is enabled (backward compatibility)
    enableTracking.checked = s.enableTracking === true || s.includeTitles === true;
    enableML.checked = s.enableML === true;
    enableRecommendations.checked = s.enableRecommendations === true;
    
    // If enableTracking is checked, ensure both are set to true
    if (enableTracking.checked) {
      chrome.storage.local.get(['settings'], (res2) => {
        const s2 = res2.settings || {};
        chrome.storage.local.set({
          settings: {
            ...s2,
            enableTracking: true,
            includeTitles: true
          }
        });
      });
    }
    
    // Set LLM preference (default to 'smollm' if not set)
    const llmPreference = s.recommendationLLM || 'smollm';
    if (recommendationLLMChatGPT && recommendationLLMSmolLM) {
      if (llmPreference === 'chatgpt') {
        recommendationLLMChatGPT.checked = true;
      } else {
        recommendationLLMSmolLM.checked = true;
      }
    }
    
    // Update recommendation model options visibility based on initial state
    updateRecommendationModelOptions();
  });

  // Save settings on change
  // enableTracking controls both enableTracking and includeTitles
  enableTracking.addEventListener('change', () => {
    chrome.storage.local.get(['settings'], (res) => {
      const s = res.settings || {};
      const selectedLLM = recommendationLLMChatGPT?.checked ? 'chatgpt' : 'smollm';
      chrome.storage.local.set({
        settings: {
          ...s,
          enableTracking: enableTracking.checked,
          includeTitles: enableTracking.checked, // Set both to same value
          enableML: enableML.checked,
          enableRecommendations: enableRecommendations.checked,
          recommendationLLM: selectedLLM
        }
      });
    });
  });

  enableML.addEventListener('change', () => {
    chrome.storage.local.get(['settings'], (res) => {
      const s = res.settings || {};
      const selectedLLM = recommendationLLMChatGPT?.checked ? 'chatgpt' : 'smollm';
      chrome.storage.local.set({
        settings: {
          ...s,
          enableTracking: enableTracking.checked,
          includeTitles: enableTracking.checked,
          enableML: enableML.checked,
          enableRecommendations: enableRecommendations.checked,
          recommendationLLM: selectedLLM
        }
      });
    });
  });

  enableRecommendations.addEventListener('change', () => {
    chrome.storage.local.get(['settings'], (res) => {
      const s = res.settings || {};
      const selectedLLM = recommendationLLMChatGPT?.checked ? 'chatgpt' : 'smollm';
      chrome.storage.local.set({
        settings: {
          ...s,
          enableTracking: enableTracking.checked,
          includeTitles: enableTracking.checked,
          enableML: enableML.checked,
          enableRecommendations: enableRecommendations.checked,
          recommendationLLM: selectedLLM
        }
      });
    });
    updateRecommendationModelOptions();
  });

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
    if (confirm('Are you sure you want to export all stored data? This will download a JSON file containing all your extension data.')) {
      chrome.storage.local.get(null, (data) => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `horizon-export-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        exportDataDiv.textContent = "Data exported successfully.";
        exportDataDiv.style.display = 'block';
      });
    }
  });

  // Clear
  clearBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to delete all stored data? This will permanently delete all tracking data, settings, and recommendations. This action cannot be undone.')) {
      chrome.storage.local.clear(() => {
        alert('All data cleared.');
      });
    }
  });

}
