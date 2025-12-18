---Horizon: Social Media Dashboard---
Created by Cuadra & Ruiz (CAP5610 Final Project)

This folder contains the following files:
    background.js: Sets up caching, scripts, storage, logistic regression classifier, and data management.
    background_llm.js: Sets up recommender system with API. Uses user-collected data to provide insights. Uses GPT-4o-mini.
    smolllm_recommender.js: Implements a SmolLM-135M LLM for user recommendations. Also uses user-collected data to provide insights. Runs locally.
    chart.js: chart.js implementation for data display.
    content_script.js: required Chrome extension content script. Collects post data. 
    HorizonIcon*: extension logo.
    logistic-regression-classifier.js: Full logistic regression implementation.
    manifest.json: required extension information.
    options*: extension options page.
    popup*: for showing collected data.
    train_lr*: trains LR on launch. uses sample weights from dataset.

    dataset folder (not used by extension, here for clarity on workings):
        dataset_3500_en_csv: sample data. 52,500 all-English social posts. (3500 per topic).
        embedder.py: embeds sample data.
        embeddings.bin: the generated sample embeddings.
        labels.json: topic labels of posts.
        meta.json: LR weights metadata.
        model_weights.json: weights of posts, which the extension uses as LR sample data.
        train_lr_from_bin.py: creates the above json files.

    libs folder
        models: holds embedding model (all-MiniLM-L6-V2) and SmolLM-135M (not included due to large files, can be found on HuggingFace)
        transformers: transformers.js implementation (3.8.0) (has to be local for Chrome extension)

    Classification model (uses Logistic Regression) is automatically trained on extension launch.
