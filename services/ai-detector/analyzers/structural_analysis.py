"""Structural analysis — repetition and development detection.

AI tracks often:
- Have sections that are copy-paste identical (not re-performed)
- No development across the track
- Predictable structure with no surprises
"""
import numpy as np
import librosa


def analyze_structure(y: np.ndarray, sr: int) -> tuple[float, float]:
    """Score 0.0 = human-like (varied structure), 1.0 = AI-like (repetitive)."""
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=4096)
        mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=4096)

        if chroma.shape[1] < 10:
            return 0.5, 0.2

        n = chroma.shape[1]

        # --- 1. CHROMA SELF-SIMILARITY (proper cosine) ---
        # L2-normalize each column for true cosine similarity
        chroma_norms = np.linalg.norm(chroma, axis=0, keepdims=True) + 1e-10
        chroma_unit = chroma / chroma_norms
        sim_chroma = chroma_unit.T @ chroma_unit  # Now in [-1, 1]

        # Same for MFCC
        mfcc_norms = np.linalg.norm(mfcc, axis=0, keepdims=True) + 1e-10
        mfcc_unit = mfcc / mfcc_norms
        sim_mfcc = mfcc_unit.T @ mfcc_unit

        # Exclude main diagonal and near-diagonal (±3 frames)
        mask = np.ones((n, n), dtype=bool)
        for i in range(-3, 4):
            mask &= ~np.eye(n, k=i, dtype=bool)

        mean_sim_chroma = np.mean(sim_chroma[mask])
        mean_sim_mfcc = np.mean(sim_mfcc[mask])

        # Chroma cosine sim: all music has some repetition
        # Human ~0.45-0.65, AI ~0.60-0.85
        chroma_rep_score = np.clip((mean_sim_chroma - 0.45) / 0.35, 0.0, 1.0)
        # MFCC timbre sim: AI timbres repeat more exactly
        # Human ~0.25-0.50, AI ~0.40-0.70
        mfcc_rep_score = np.clip((mean_sim_mfcc - 0.25) / 0.40, 0.0, 1.0)

        # --- 2. SECTION SIMILARITY (4 quarters) ---
        n_sec = 4
        sec_size = n // n_sec
        if sec_size > 2:
            section_sims = []
            for i in range(n_sec):
                for j in range(i + 1, n_sec):
                    si = chroma_unit[:, i*sec_size:(i+1)*sec_size]
                    sj = chroma_unit[:, j*sec_size:(j+1)*sec_size]
                    min_cols = min(si.shape[1], sj.shape[1])
                    si, sj = si[:, :min_cols], sj[:, :min_cols]
                    if min_cols > 0:
                        # Mean cosine similarity between corresponding frames
                        frame_sims = np.sum(si * sj, axis=0)
                        sim = np.mean(frame_sims)
                        section_sims.append(sim)

            if len(section_sims) > 0:
                max_section_sim = np.max(section_sims)
                # Human sections: max ~0.50-0.75 (verses differ from chorus)
                # AI sections: max ~0.70-0.95 (copy-paste)
                section_score = np.clip((max_section_sim - 0.55) / 0.35, 0.0, 1.0)
            else:
                section_score = 0.5
        else:
            section_score = 0.5

        # --- 3. NOVELTY / DEVELOPMENT CURVE ---
        combined = np.vstack([chroma_unit, mfcc_unit * 0.5])
        novelty = np.sqrt(np.sum(np.diff(combined, axis=1)**2, axis=0))

        if len(novelty) > 5:
            novelty_cv = np.std(novelty) / (np.mean(novelty) + 1e-10)
            # Low novelty CV = monotonous = AI-like
            # Human ~0.50-0.80, AI ~0.30-0.50
            novelty_score = np.clip(1.0 - (novelty_cv - 0.30) / 0.50, 0.0, 1.0)

            # Novelty peaks = structural boundaries (section changes)
            novelty_peaks = np.sum(novelty > np.mean(novelty) + 2 * np.std(novelty))
            peak_density = novelty_peaks / len(novelty)
            # Low density = no structural surprises = AI
            peaks_score = np.clip(1.0 - (peak_density / 0.06), 0.0, 1.0)
        else:
            novelty_score = 0.5
            peaks_score = 0.5

        # Sanitize NaN
        def safe(v):
            return 0.5 if (v is None or np.isnan(v)) else v

        score = (0.25 * safe(chroma_rep_score) + 0.20 * safe(mfcc_rep_score) +
                 0.25 * safe(section_score) + 0.15 * safe(novelty_score) +
                 0.15 * safe(peaks_score))
        confidence = min(1.0, n / 50.0)

        return float(np.clip(score, 0.0, 1.0)), float(confidence)

    except Exception:
        return 0.5, 0.0
