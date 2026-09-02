"""Embeddings — SigLIP-2 (image + text, 768-d) and bge-m3 (text, 1024-d).

Both models are loaded once per container (see `app.py` `@modal.enter`) and
kept in fp16 on the GPU. Weights are cached under HF_HOME on the Modal volume
so only the first container of a fresh deploy downloads them.

EMBEDDING_VERSION is written to the manifest header and stored on
`mkt_cv_videos.embedding_version` / `mkt_cv_frames`; it must change whenever
the checkpoint, preprocessing or normalisation changes, because vectors from
different versions are not comparable.
"""

from __future__ import annotations

import io
from typing import Iterable

import numpy as np
import torch
from PIL import Image

SIGLIP_ID = "google/siglip2-base-patch16-256"
SIGLIP_DIM = 768
EMBEDDING_VERSION = "siglip2-b16-256-1"
BGE_ID = "BAAI/bge-m3"
BGE_DIM = 1024
BGE_VERSION = "bge-m3-1"

IMAGE_BATCH = 32
TEXT_BATCH = 64


class Embedder:
    def __init__(self, device: str | None = None):
        from sentence_transformers import SentenceTransformer
        from transformers import AutoModel, AutoProcessor

        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.dtype = torch.float16 if self.device == "cuda" else torch.float32
        self.processor = AutoProcessor.from_pretrained(SIGLIP_ID)
        self.siglip = AutoModel.from_pretrained(SIGLIP_ID, torch_dtype=self.dtype).to(self.device).eval()
        self.bge = SentenceTransformer(BGE_ID, device=self.device)
        if self.device == "cuda":
            self.bge.half()
        # SigLIP's learned logit scale / bias — used for zero-shot label probabilities.
        self.logit_scale = float(self.siglip.logit_scale.exp().item())
        self.logit_bias = float(self.siglip.logit_bias.item())

    # ── SigLIP-2 ────────────────────────────────────────────────────────────
    @torch.inference_mode()
    def image_vectors(self, images: Iterable[Image.Image]) -> np.ndarray:
        imgs = [im.convert("RGB") for im in images]
        out: list[np.ndarray] = []
        for i in range(0, len(imgs), IMAGE_BATCH):
            batch = imgs[i : i + IMAGE_BATCH]
            inputs = self.processor(images=batch, return_tensors="pt")
            pixel = inputs["pixel_values"].to(self.device, self.dtype)
            feats = self.siglip.get_image_features(pixel_values=pixel)
            feats = torch.nn.functional.normalize(feats.float(), dim=-1)
            out.append(feats.cpu().numpy())
        return np.concatenate(out, axis=0) if out else np.zeros((0, SIGLIP_DIM), dtype=np.float32)

    def image_vectors_from_bytes(self, blobs: Iterable[bytes]) -> np.ndarray:
        return self.image_vectors(Image.open(io.BytesIO(b)) for b in blobs)

    @torch.inference_mode()
    def siglip_text_vectors(self, texts: list[str]) -> np.ndarray:
        out: list[np.ndarray] = []
        for i in range(0, len(texts), TEXT_BATCH):
            batch = texts[i : i + TEXT_BATCH]
            inputs = self.processor(text=batch, padding="max_length", max_length=64, truncation=True, return_tensors="pt")
            inputs = {k: v.to(self.device) for k, v in inputs.items()}
            feats = self.siglip.get_text_features(**inputs)
            feats = torch.nn.functional.normalize(feats.float(), dim=-1)
            out.append(feats.cpu().numpy())
        return np.concatenate(out, axis=0) if out else np.zeros((0, SIGLIP_DIM), dtype=np.float32)

    # ── bge-m3 ──────────────────────────────────────────────────────────────
    @torch.inference_mode()
    def bge_vectors(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, BGE_DIM), dtype=np.float32)
        vecs = self.bge.encode(texts, batch_size=TEXT_BATCH, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
        return np.asarray(vecs, dtype=np.float32)

    # ── zero-shot labels ────────────────────────────────────────────────────
    def label_bank(self) -> tuple[list[tuple[str, str]], np.ndarray]:
        """(facet,label) list + matrix of normalised prompt embeddings, cached."""
        if getattr(self, "_bank", None) is None:
            from labels import prompt_pairs

            pairs = prompt_pairs()
            mat = self.siglip_text_vectors([p for _, _, p in pairs])
            self._bank = ([(f, l) for f, l, _ in pairs], mat)
        return self._bank

    def zero_shot_labels(self, frame_vecs: np.ndarray) -> list[list[str]]:
        from labels import LABEL_MIN_PROB, LABEL_TOP_K, ZERO_SHOT_FACETS

        keys, bank = self.label_bank()
        logits = (frame_vecs @ bank.T) * self.logit_scale + self.logit_bias  # (n_frames, n_labels)
        facet_cols: dict[str, list[int]] = {}
        for j, (facet, _) in enumerate(keys):
            facet_cols.setdefault(facet, []).append(j)
        result: list[list[str]] = []
        for row in logits:
            labels: list[str] = []
            for facet in ZERO_SHOT_FACETS:
                cols = facet_cols[facet]
                z = row[cols].astype(np.float64)
                z = z - z.max()
                p = np.exp(z) / np.exp(z).sum()
                order = np.argsort(-p)[:LABEL_TOP_K]
                for o in order:
                    if p[o] >= LABEL_MIN_PROB:
                        labels.append(f"{facet}:{keys[cols[o]][1]}")
            result.append(labels)
        return result


def round_vec(v: np.ndarray, nd: int = 5) -> list[float]:
    return [round(float(x), nd) for x in v]
