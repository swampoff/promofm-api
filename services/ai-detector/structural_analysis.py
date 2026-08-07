"""Structural analysis — "very powerful" detection method.

AI tracks often:
- Have identical structure: intro → verse → chorus → repeat
- No development across sections
- No unexpected elements
- Repeated sections are TOO similar (copy-paste rather than re-performed)
"""
import numpy as np
import librosa


def analyze_structure(y: np.ndarray, sr: int) -> tuple[float, float]:
    """Score 0.0 = human-like (varied structure), 1.0 = AI-like (repetitive)."""
    try:
        # --- 1. SELF-SIMILARITY MATRIX ---
        # Compute chromagram-based self-similarity
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=4096)
        mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=4096)

        if chroma.shape[1] < 10:
            return 0.5, 0.2

        # Normalize features
        chroma_norm = librosa.util.normalize(chroma, axis=0)
        mfcc_norm = librosa.util.normalize(mfcc, axis=0)

        # Self-similarity matrix from chroma
        sim_chroma = chroma_norm.T @ chroma_norm
        # Self-similarity matrix from MFCC (timbre)
        sim_mfcc = mfcc_norm.T @ mfcc_norm

        n = sim_chroma.shape[0]

        # --- 2. REPETITION DETECTION ---
        # AI has higher off-diagonal similarity (sections repeat more exactly)
        # Exclude main diagonal and near-diagonal
        mask = np.ones_like(sim_chroma, dtype=bool)
        for i in range(-2, 3):
            mask &= ~np.eye(n, k=i, dtype=bool)

        mean_sim_chroma = np.mean(sim_chroma[mask])
        mean_sim_mfcc = np.mean(sim_mfcc[mask])

        # Higher mean similarity = more repetitive = AI-like
        # ALL music has repetition (verse-chorus), so ranges must be generous
        # Only flag extremely high similarity (AI copy-paste vs human re-performance)
        # Chroma: range 0.70-0.95
        chroma_rep_score = np.clip((mean_sim_chroma - 0.70) / 0.25, 0.0, 1.0)
        # MFCC: range 0.60-0.85 (timbre repetition is stronger signal)
        mfcc_rep_score = np.clip((mean_sim_mfcc - 0.60) / 0.25, 0.0, 1.0)

        # --- 3. SECTION SIMILARITY ---
        # Divide track into 4 equal sections
        # Check how similar sections are to each other
        n_sec = 4
        sec_size = n // n_sec
        if sec_size > 2:
            section_sims = []
            for i in range(n_sec):
                for j in range(i + 1, n_sec):
                    si = chroma_norm[:, i*sec_size:(i+1)*sec_size]
                    sj = chroma_norm[:, j*sec_size:(j+1)*sec_size]
                    min_cols = min(si.shape[1], sj.shape[1])
                    si, sj = si[:, :min_cols], sj[:, :min_cols]
                    if min_cols > 0:
                        # Cosine similarity between corresponding frames
                        sim = np.mean(np.sum(si * sj, axis=0) /
                                      (np.linalg.norm(si, axis=0) * np.linalg.norm(sj, axis=0) + 1e-10))
                        section_sims.append(sim)

            if len(section_sims) > 0:
                max_section_sim = np.max(section_sims)
                mean_section_sim = np.mean(section_sims)
                # Only flag VERY high similarity (AI sections are near-identical)
                section_score = np.clip((max_section_sim - 0.80) / 0.15, 0.0, 1.0)
            else:
                section_score = 0.5
        else:
            section_score = 0.5

        # --- 4. DEVELOPMENT/NOVELTY CURVE ---
        # Human music develops over time; AI repeats
        # Compute novelty curve (frame-to-frame change in features)
        combined = np.vstack([chroma_norm, mfcc_norm * 0.5])
        novelty = np.sqrt(np.sum(np.diff(combined, axis=1)**2, axis=0))

        if len(novelty) > 5:
            novelty_cv = np.std(novelty) / (np.mean(novelty) + 1e-10)
            # Low novelty CV = monotonous development = AI
            novelty_score = np.clip(1.0 - (novelty_cv / 0.80), 0.0, 1.0)

            # Check for novelty peaks (structural boundaries)
            # Human music has more dramatic section boundaries
            novelty_peaks = np.sum(novelty > np.mean(novelty) + 2 * np.std(novelty))
            peak_density = novelty_peaks / len(novelty)
            # Low peak density = no drama = AI
            peaks_score = np.clip(1.0 - (peak_density / 0.08), 0.0, 1.0)
        else:
            novelty_score = 0.5
            peaks_score = 0.5

        # Sanitize NaN
        def safe(v):
            return 0.5 if np.isnan(v) else v

        score = (0.25 * safe(chroma_rep_score) + 0.20 * safe(mfcc_rep_score) +
                 0.20 * safe(section_score) + 0.20 * safe(novelty_score) + 0.15 * safe(peaks_score))
        confidence = min(1.0, n / 50.0)

        return float(np.clip(score, 0.0, 1.0)), float(confidence)

    except Exception:
        return 0.5, 0.0
