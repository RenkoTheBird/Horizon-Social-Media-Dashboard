import json
import numpy as np
from sklearn.linear_model import LogisticRegression

EMBEDDINGS_BIN = "embeddings.bin"
LABELS_JSON = "labels.json"
META_JSON = "meta.json"
OUTPUT_JSON = "model_weights.json"

# ---- Load meta.json ----
with open(META_JSON, "r") as f:
    meta = json.load(f)

num_samples = meta["count"]
embedding_dim = meta["dim"]
dtype = np.float32 if meta.get("dtype", "float32") == "float32" else np.float64

print(f"[Meta] Samples: {num_samples}")
print(f"[Meta] Embedding dim: {embedding_dim}")
print(f"[Meta] Dtype: {dtype}")

# ---- Load embeddings ----
print("[Load] Loading embeddings.bin...")
X = np.fromfile(EMBEDDINGS_BIN, dtype=dtype)
X = X.reshape(num_samples, embedding_dim)
print("[Load] Embeddings loaded:", X.shape)

# ---- Load labels ----
print("[Load] Loading labels.json...")
with open(LABELS_JSON, "r") as f:
    labels_raw = json.load(f)

# Convert labels → integer IDs
if isinstance(labels_raw[0], str):
    unique_labels = sorted(list(set(labels_raw)))
    label_to_id = {lbl: i for i, lbl in enumerate(unique_labels)}
    y = np.array([label_to_id[lbl] for lbl in labels_raw], dtype=np.int32)
else:
    unique_labels = sorted(list(set(labels_raw)))
    y = np.array(labels_raw, dtype=np.int32)
    label_to_id = {str(lbl): lbl for lbl in unique_labels}

print(f"[Labels] {len(unique_labels)} unique classes")

# ---- Train LR ----
print("[Train] Training multinomial logistic regression...")
clf = LogisticRegression(
    max_iter=300,
    solver="lbfgs",
    multi_class="multinomial",
    n_jobs=-1,
)
clf.fit(X, y)
print("[Train] Done.")

# ---- Export model ----
export = {
    "num_classes": len(unique_labels),
    "num_features": embedding_dim,
    "classes": unique_labels,
    "label_to_id": label_to_id,
    "weights": clf.coef_.astype(np.float32).tolist(),   # shape: (classes, features)
    "bias": clf.intercept_.astype(np.float32).tolist()
}

with open(OUTPUT_JSON, "w") as f:
    json.dump(export, f)

print(f"[Save] Saved model to {OUTPUT_JSON}")
