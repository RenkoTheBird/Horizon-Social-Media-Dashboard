// train-lr.js
// Train logistic regression model offline: load CSV, embed, train LR, save weights + bias
// Uses local transformers.js via embedder.js (no CDNs)

(async () => {
  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    await new Promise(resolve => {
      document.addEventListener('DOMContentLoaded', resolve);
    });
  }

  try {
    const { csvToObjects } = await import(chrome.runtime.getURL('csv-parser.js'));
    const { LogisticRegressionClassifier } = await import(chrome.runtime.getURL('logistic-regression-classifier.js'));

    // ---------- DOM elements ----------
    const statusDiv = document.getElementById('status');
    const loadBtn = document.getElementById('loadBtn');
    const trainBtn = document.getElementById('trainBtn');
    const stopBtn = document.getElementById('stopBtn');
    const saveBtn = document.getElementById('saveBtn');

    if (!statusDiv || !loadBtn || !trainBtn || !stopBtn || !saveBtn) {
      console.error('[Train LR] Missing required DOM elements');
      if (statusDiv) {
        statusDiv.className = 'status error';
        statusDiv.textContent = '[ERROR] Missing required DOM elements. Please refresh the page.';
      }
      return;
    }

    let trainingData = [];
    let isTraining = false;
    let shouldStopTraining = false;

    function log(message, isError = false) {
      const timestamp = new Date().toLocaleTimeString();
      const className = isError ? 'error' : '';
      statusDiv.className = `status ${className}`;
      statusDiv.textContent += `[${timestamp}] ${message}\n`;
      statusDiv.scrollTop = statusDiv.scrollHeight;
      console.log(message);
    }

    function clearLog() {
      statusDiv.textContent = '';
      statusDiv.className = 'status';
    }

    // Load precomputed embeddings and labels
    async function loadCSV() {
      clearLog();
      log('Loading precomputed embeddings and labels...');

      try {
        // Load metadata
        log('Loading meta.json...');
        const metaResponse = await fetch(chrome.runtime.getURL('meta.json'));
        if (!metaResponse.ok) throw new Error(`Failed to load meta.json: ${metaResponse.statusText}`);
        const meta = await metaResponse.json();
        log(`Metadata loaded: ${meta.count} embeddings, ${meta.dim} dimensions, dtype: ${meta.dtype}`);

        // Load labels
        log('Loading labels.json...');
        const labelsResponse = await fetch(chrome.runtime.getURL('labels.json'));
        if (!labelsResponse.ok) throw new Error(`Failed to load labels.json: ${labelsResponse.statusText}`);
        const labels = await labelsResponse.json();
        log(`Labels loaded: ${labels.length} labels`);

        // Verify counts match
        if (labels.length !== meta.count) {
          log(`Warning: Label count (${labels.length}) doesn't match metadata count (${meta.count})`, true);
        }

        // Load embeddings binary file
        log('Loading embeddings.bin...');
        const embeddingsResponse = await fetch(chrome.runtime.getURL('embeddings.bin'));
        if (!embeddingsResponse.ok) throw new Error(`Failed to load embeddings.bin: ${embeddingsResponse.statusText}`);
        const embeddingsBuffer = await embeddingsResponse.arrayBuffer();
        log(`Embeddings binary loaded: ${embeddingsBuffer.byteLength} bytes`);

        // Convert to Float32Array
        const embeddingsArray = new Float32Array(embeddingsBuffer);
        const expectedSize = meta.count * meta.dim;
        if (embeddingsArray.length !== expectedSize) {
          throw new Error(`Embedding size mismatch: expected ${expectedSize} floats, got ${embeddingsArray.length}`);
        }
        log(`Embeddings converted to Float32Array: ${embeddingsArray.length} values`);

        // Create training data by pairing embeddings with labels
        log('\nCreating training data pairs...');
        trainingData = [];
        for (let i = 0; i < meta.count && i < labels.length; i++) {
          const label = labels[i];
          if (!label || typeof label !== 'string' || label.trim().length === 0) {
            continue;
          }

          // Extract embedding for this sample
          const embeddingStart = i * meta.dim;
          const embeddingEnd = embeddingStart + meta.dim;
          const embedding = embeddingsArray.slice(embeddingStart, embeddingEnd);

          trainingData.push({
            label: label.trim().toLowerCase(),
            embedding: embedding
          });
        }

        log(`Created ${trainingData.length} training examples`);

        // Calculate label distribution
        const labelCounts = {};
        trainingData.forEach(item => {
          const label = item.label;
          labelCounts[label] = (labelCounts[label] || 0) + 1;
        });

        log('\nLabel distribution (normalized to lowercase) - BEFORE filtering:');
        const sortedLabels = Object.entries(labelCounts).sort((a, b) => b[1] - a[1]);
        sortedLabels.forEach(([label, count]) => {
          log(`  ${label}: ${count} examples`);
        });
        
        // Filter out categories with less than 10 examples
        const MIN_EXAMPLES_PER_CATEGORY = 10;
        const validCategories = new Set(
          Object.entries(labelCounts)
            .filter(([label, count]) => count >= MIN_EXAMPLES_PER_CATEGORY)
            .map(([label]) => label)
        );
        
        const filteredOutCategories = Object.entries(labelCounts)
          .filter(([label, count]) => count < MIN_EXAMPLES_PER_CATEGORY)
          .map(([label, count]) => ({ label, count }));
        
        if (filteredOutCategories.length > 0) {
          log(`\nFiltering out ${filteredOutCategories.length} categories with less than ${MIN_EXAMPLES_PER_CATEGORY} examples:`);
          filteredOutCategories.forEach(({ label, count }) => {
            log(`  - ${label}: ${count} examples (removed)`);
          });
        }
        
        // Filter training data to only include valid categories
        const originalCount = trainingData.length;
        trainingData = trainingData.filter(item => {
          return validCategories.has(item.label);
        });
        
        const removedCount = originalCount - trainingData.length;
        if (removedCount > 0) {
          log(`\nRemoved ${removedCount} examples from categories with insufficient data.`);
        }
        
        log(`\nAfter filtering: ${trainingData.length} examples remaining across ${validCategories.size} categories`);
        
        // Recalculate label counts after filtering
        const filteredLabelCounts = {};
        trainingData.forEach(item => {
          const label = item.label;
          filteredLabelCounts[label] = (filteredLabelCounts[label] || 0) + 1;
        });
        
        log('\nFinal label distribution (after filtering):');
        const sortedFilteredLabels = Object.entries(filteredLabelCounts).sort((a, b) => b[1] - a[1]);
        sortedFilteredLabels.forEach(([label, count]) => {
          log(`  ${label}: ${count} examples`);
        });

        trainBtn.disabled = false;
        log('\n✓ Precomputed data loaded successfully. Click "Train Model" to begin training.');
      } catch (error) {
        log(`Error loading precomputed data: ${error.message}`, true);
        console.error(error);
      }
    }

    /**
     * Simple logistic regression training using gradient descent
     * Multi-class logistic regression with softmax
     * Made async to allow UI updates during training
     */
    async function trainLogisticRegression(X, y, numClasses, embeddingDim, learningRate = 0.01, maxIterations = 1000) {
      const numSamples = X.length;
      
      // Initialize weights and bias
      // weights: [embeddingDim, numClasses]
      // bias: [numClasses]
      let weights = new Float32Array(embeddingDim * numClasses);
      let bias = new Float32Array(numClasses);
      
      // Initialize with small random values
      for (let i = 0; i < weights.length; i++) {
        weights[i] = (Math.random() - 0.5) * 0.01;
      }
      for (let i = 0; i < bias.length; i++) {
        bias[i] = (Math.random() - 0.5) * 0.01;
      }
      
      log(`Training logistic regression: ${numSamples} samples, ${embeddingDim} features, ${numClasses} classes`);
      log(`Learning rate: ${learningRate}, Max iterations: ${maxIterations}`);
      
      // Helper function to yield control to browser for UI updates
      const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));
      
      // Gradient descent
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (shouldStopTraining) {
          log('\nTraining stopped by user.', true);
          break;
        }
        
        // Compute gradients
        const gradWeights = new Float32Array(embeddingDim * numClasses);
        const gradBias = new Float32Array(numClasses);
        
        let totalLoss = 0;
        
        // Process samples in batches to allow periodic UI updates
        const BATCH_SIZE = Math.max(1, Math.floor(numSamples / 10)); // Process in ~10 batches
        for (let batchStart = 0; batchStart < numSamples; batchStart += BATCH_SIZE) {
          const batchEnd = Math.min(batchStart + BATCH_SIZE, numSamples);
          
          for (let i = batchStart; i < batchEnd; i++) {
            const x = X[i]; // [embeddingDim]
            const trueClass = y[i]; // integer class index
            
            // Compute logits: x • W + b
            const logits = new Float32Array(numClasses);
            for (let c = 0; c < numClasses; c++) {
              let sum = bias[c];
              for (let d = 0; d < embeddingDim; d++) {
                sum += x[d] * weights[d * numClasses + c];
              }
              logits[c] = sum;
            }
            
            // Apply softmax
            let maxLogit = logits[0];
            for (let c = 1; c < numClasses; c++) {
              if (logits[c] > maxLogit) maxLogit = logits[c];
            }
            
            const expLogits = new Float32Array(numClasses);
            let sumExp = 0;
            for (let c = 0; c < numClasses; c++) {
              expLogits[c] = Math.exp(logits[c] - maxLogit);
              sumExp += expLogits[c];
            }
            
            const probs = new Float32Array(numClasses);
            for (let c = 0; c < numClasses; c++) {
              probs[c] = expLogits[c] / sumExp;
            }
            
            // Cross-entropy loss
            totalLoss -= Math.log(Math.max(probs[trueClass], 1e-10));
            
            // Compute gradients
            for (let c = 0; c < numClasses; c++) {
              const error = probs[c] - (c === trueClass ? 1 : 0);
              gradBias[c] += error;
              
              for (let d = 0; d < embeddingDim; d++) {
                gradWeights[d * numClasses + c] += error * x[d];
              }
            }
          }
          
          // Yield control to browser after each batch to allow UI updates
          if (batchEnd < numSamples) {
            await yieldToBrowser();
          }
        }
        
        // Average gradients
        for (let i = 0; i < gradWeights.length; i++) {
          gradWeights[i] /= numSamples;
        }
        for (let i = 0; i < gradBias.length; i++) {
          gradBias[i] /= numSamples;
        }
        
        // Update weights and bias
        for (let i = 0; i < weights.length; i++) {
          weights[i] -= learningRate * gradWeights[i];
        }
        for (let i = 0; i < bias.length; i++) {
          bias[i] -= learningRate * gradBias[i];
        }
        
        // Log progress and yield to browser
        if (iteration % 100 === 0 || iteration === maxIterations - 1) {
          const avgLoss = totalLoss / numSamples;
          log(`  Iteration ${iteration + 1}/${maxIterations}: Loss = ${avgLoss.toFixed(4)}`);
          // Yield after logging to ensure log message is displayed
          await yieldToBrowser();
        } else if (iteration % 10 === 0) {
          // Yield every 10 iterations even without logging to keep UI responsive
          await yieldToBrowser();
        }
      }
      
      return { weights, bias };
    }

    // Main training flow
    async function trainModel() {
      if (!trainingData || trainingData.length === 0) {
        log('No training data available. Please load precomputed data first.', true);
        return;
      }

      clearLog();
      log('Starting training...');
      log(`Total training examples: ${trainingData.length}`);

      // Disable buttons during training
      trainBtn.disabled = true;
      loadBtn.disabled = true;
      stopBtn.disabled = false;
      isTraining = true;
      shouldStopTraining = false;

      try {
        log('\nUsing precomputed embeddings (no embedding generation needed)...');

        if (trainingData.length === 0) {
          log('No valid training data available. Cannot proceed.', true);
          return;
        }

        if (trainingData.length < 15) {
          log(`Warning: Only ${trainingData.length} examples available. LR may not work well.`, true);
        }

        // Get unique categories and create label mapping
        const uniqueCategories = Array.from(new Set(trainingData.map(e => e.label))).sort();
        const numClasses = uniqueCategories.length;
        const embeddingDim = trainingData[0].embedding.length;
        
        log(`\nFound ${numClasses} unique categories: ${uniqueCategories.join(', ')}`);
        log(`Embedding dimension: ${embeddingDim}`);
        
        // Create label to index mapping
        const labelToIndex = {};
        uniqueCategories.forEach((label, index) => {
          labelToIndex[label] = index;
        });
        
        // Prepare training data: X (embeddings) and y (class indices)
        log('\nPreparing training data...');
        const X = trainingData.map(e => {
          // Embedding is already a Float32Array from the binary file
          return e.embedding;
        });
        const y = trainingData.map(e => labelToIndex[e.label]);
        
        log(`Training data prepared: ${X.length} samples, ${embeddingDim} features, ${numClasses} classes`);
        
        // Train logistic regression
        log('\nTraining logistic regression model...');
        log('This may take a few minutes depending on dataset size...');
        const trainingStartTime = Date.now();
        
        const { weights, bias } = await trainLogisticRegression(
          X,
          y,
          numClasses,
          embeddingDim,
          0.01, // learning rate
          1000  // max iterations
        );
        
        const trainingTime = ((Date.now() - trainingStartTime) / 1000).toFixed(1);
        log(`\n✓ Training completed in ${trainingTime}s`);
        
        // Store model for saving
        window.trainedModel = {
          weights,
          bias,
          categories: uniqueCategories,
          embeddingDim
        };
        
        log(`✓ Model trained successfully!`);
        log(`  Weights shape: [${embeddingDim}, ${numClasses}] = ${weights.length} values`);
        log(`  Bias shape: [${numClasses}] = ${bias.length} values`);
        log('\n✓ Training complete! Click "Save Model" to persist the trained model.');
        saveBtn.disabled = false;

      } catch (error) {
        log(`Error during training: ${error.message}`, true);
        log('Please check the browser console for details.', true);
        console.error('[Train LR] Training error:', error);
      } finally {
        // Re-enable buttons
        isTraining = false;
        shouldStopTraining = false;
        trainBtn.disabled = false;
        loadBtn.disabled = false;
        stopBtn.disabled = true;
      }
    }

    async function saveModel() {
      if (!window.trainedModel) {
        log('No trained model available. Please train first.', true);
        return;
      }

      try {
        log('Saving model to Chrome storage...');
        log(`Model has ${window.trainedModel.categories.length} classes`);
        
        const classifier = new LogisticRegressionClassifier();
        
        // Note: The classifier expects weights in a specific format
        // We need to ensure the weights match the expected topic order
        // The topics in the classifier are fixed: business, cryptocurrency, economy, etc.
        // We need to map our trained categories to these topics
        
        const expectedTopics = classifier.topics;
        const trainedCategories = window.trainedModel.categories;
        const numClasses = expectedTopics.length;
        const embeddingDim = window.trainedModel.embeddingDim;
        
        // Create mapping from trained categories to expected topics
        const categoryToTopicIndex = {};
        trainedCategories.forEach((cat, idx) => {
          // Find matching topic in expected topics (case-insensitive)
          const topicIndex = expectedTopics.findIndex(t => t.toLowerCase() === cat.toLowerCase());
          if (topicIndex >= 0) {
            categoryToTopicIndex[cat] = topicIndex;
          }
        });
        
        // Create weights and bias arrays matching expected topic order
        const finalWeights = new Float32Array(embeddingDim * numClasses);
        const finalBias = new Float32Array(numClasses);
        
        // Initialize with zeros
        for (let i = 0; i < finalWeights.length; i++) {
          finalWeights[i] = 0;
        }
        for (let i = 0; i < finalBias.length; i++) {
          finalBias[i] = 0;
        }
        
        // Map trained weights to expected topic positions
        trainedCategories.forEach((cat, trainedIdx) => {
          const topicIndex = categoryToTopicIndex[cat];
          if (topicIndex >= 0) {
            // Copy weights for this class
            for (let d = 0; d < embeddingDim; d++) {
              finalWeights[d * numClasses + topicIndex] = window.trainedModel.weights[d * trainedCategories.length + trainedIdx];
            }
            // Copy bias
            finalBias[topicIndex] = window.trainedModel.bias[trainedIdx];
          }
        });
        
        // Save the model
        const saved = await classifier.save(finalWeights, finalBias);
        if (saved) {
          log('✓ Model saved successfully!');
          statusDiv.className = 'status success';
        } else {
          log('Failed to save model. Check console for details.', true);
        }
      } catch (error) {
        log(`Error saving model: ${error.message}`, true);
        log('Check browser console for full error details.', true);
        console.error('[Train LR] Save error:', error);
        console.error('[Train LR] Error stack:', error.stack);
      }
    }

    // Stop training function
    function stopTraining() {
      if (isTraining) {
        shouldStopTraining = true;
        log('\nStopping training...', true);
      }
    }

    // Attach event listeners
    loadBtn.addEventListener('click', loadCSV);
    trainBtn.addEventListener('click', trainModel);
    stopBtn.addEventListener('click', stopTraining);
    saveBtn.addEventListener('click', saveModel);

    log('✓ Training page initialized');
  } catch (error) {
    console.error('[Train LR] Initialization error:', error);
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
      statusDiv.className = 'status error';
      statusDiv.textContent = `[ERROR] Failed to initialize: ${error.message}\n\nPlease check the browser console for details.`;
    }
  }
})();

