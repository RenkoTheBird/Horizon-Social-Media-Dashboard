import numpy as np
import pandas as pd
import json
from tqdm import tqdm
from sentence_transformers import SentenceTransformer

# ========= USER CONFIG =========
CSV_PATH = "dataset_3500_en.csv"            # Your 55k-post CSV
TEXT_COLUMN = "original_text"           # Column with English posts
LABEL_COLUMN = "primary_theme"          # Column with topic labels
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
BATCH_SIZE = 256                        # Adjust based on GPU/CPU RAM
EMBED_OUT = "embeddings.bin"            # Float32Array for extension
LABEL_OUT = "labels.json"
META_OUT = "meta.json"
NORMALIZE = True                        # Recommended for KNN / LR
# =================================


def main():
    print("Loading CSV…")
    df = pd.read_csv(CSV_PATH, usecols=[TEXT_COLUMN, LABEL_COLUMN])

    df = df.dropna(subset=[TEXT_COLUMN, LABEL_COLUMN])
    texts = df[TEXT_COLUMN].astype(str).tolist()
    labels = df[LABEL_COLUMN].astype(str).tolist()

    print(f"Loaded {len(texts)} posts.")

    print(f"Loading model: {MODEL_NAME}")
    model = SentenceTransformer(MODEL_NAME)

    all_embeddings = []
    print("Computing embeddings…")

    for start in tqdm(range(0, len(texts), BATCH_SIZE)):
        batch_texts = texts[start:start + BATCH_SIZE]
        batch_emb = model.encode(
            batch_texts,
            batch_size=BATCH_SIZE,
            show_progress_bar=False,
            convert_to_numpy=True,
            normalize_embeddings=NORMALIZE
        )
        all_embeddings.append(batch_emb)

    # ─── Combine batches ───────────────────────────────────────────────────────
    embeddings = np.vstack(all_embeddings).astype(np.float32)
    num_samples, dim = embeddings.shape

    print(f"Embedding shape: {embeddings.shape}")

    # ─── Write embeddings to binary (Float32Array) ─────────────────────────────
    print(f"Saving Float32 embeddings → {EMBED_OUT}")
    embeddings.tofile(EMBED_OUT)

    # ─── Write labels JSON ─────────────────────────────────────────────────────
    print(f"Saving labels → {LABEL_OUT}")
    with open(LABEL_OUT, "w", encoding="utf-8") as f:
        json.dump(labels, f, ensure_ascii=False)

    # ─── Write metadata JSON ───────────────────────────────────────────────────
    meta = {
        "count": int(num_samples),
        "dim": int(dim),
        "dtype": "float32",
        "model": MODEL_NAME,
        "normalized": NORMALIZE
    }
    print(f"Saving metadata → {META_OUT}")
    with open(META_OUT, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print("\nDone!")
    print(f"Embeddings stored as raw Float32Array ({num_samples} × {dim})")
    print("Import ready for Chrome extension.")


if __name__ == "__main__":
    main()
