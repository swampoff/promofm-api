"""Harmonic/music theory analyzer.

AI music tends to:
- Use "safe" chord progressions (I-V-vi-IV etc)
- Have low harmonic complexity
- Lack modulations (key changes)
- Have unnaturally smooth chroma transitions
- Use very consistent harmonic-percussive balance
"""
import numpy as np
import librosa


def analyze_harmonic_theory(y: np.ndarray, sr: int) -> tuple[float, float]:
    """Score 0.0 = human-like (complex harmony), 1.0 = AI-like (simple/repetitive)."""
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        if chroma.shape[1] < 20:
            return 0.5, 0.2

        # --- 1. CHROMA TRANSITION SMOOTHNESS ---
        # AI has smoother chroma changes (0.032 vs human 0.042)
        chroma_diff = np.diff(chroma, axis=1)
        mean_diff = np.mean(np.abs(chroma_diff))
        diff_score = np.clip(1.0 - (mean_diff - 0.02) / 0.04, 0.0, 1.0)

        # --- 2. HARMONIC COMPLEXITY ---
        # Count active pitch classes per frame — AI uses fewer simultaneously
        frame_complexities = []
        for i in range(chroma.shape[1]):
            frame = chroma[:, i]
            # Count pitch classes above threshold
            active = np.sum(frame > 0.3 * np.max(frame))
            frame_complexities.append(active)
        mean_complexity = np.mean(frame_complexities)
        complexity_cv = np.std(frame_complexities) / (mean_complexity + 1e-10)
        # Low CV = AI uses same number of notes consistently
        complexity_score = np.clip(1.0 - (complexity_cv - 0.15) / 0.35, 0.0, 1.0)

        # --- 3. KEY STABILITY / MODULATION DETECTION ---
        # AI rarely modulates; human music has key changes
        # Analyze chroma in 4-bar windows and check key changes
        window_size = max(1, chroma.shape[1] // 8)
        window_keys = []
        for i in range(0, chroma.shape[1] - window_size, window_size):
            window = chroma[:, i:i+window_size]
            key_profile = np.mean(window, axis=1)
            dominant_key = np.argmax(key_profile)
            window_keys.append(dominant_key)

        if len(window_keys) > 2:
            # Count unique keys
            unique_keys = len(set(window_keys))
            key_changes = sum(1 for a, b in zip(window_keys, window_keys[1:]) if a != b)
            # Low unique keys = AI stays in one key
            modulation_score = np.clip(1.0 - (unique_keys - 1) / 4, 0.0, 1.0)
        else:
            modulation_score = 0.5

        # --- 4. CHORD PROGRESSION REPETITIVENESS ---
        # AI repeats same progressions; detect via chroma self-similarity
        # Downsample chroma to beat-level
        hop_frames = max(1, chroma.shape[1] // 50)
        chroma_ds = chroma[:, ::hop_frames]
        if chroma_ds.shape[1] > 4:
            # Compute pairwise cosine similarity
            norms = np.linalg.norm(chroma_ds, axis=0, keepdims=True) + 1e-10
            chroma_norm = chroma_ds / norms
            sim_matrix = chroma_norm.T @ chroma_norm
            # Average off-diagonal similarity — high = repetitive = AI
            mask = ~np.eye(sim_matrix.shape[0], dtype=bool)
            mean_sim = np.mean(sim_matrix[mask])
            repetitive_score = np.clip((mean_sim - 0.5) / 0.40, 0.0, 1.0)
        else:
            repetitive_score = 0.5

        # --- 5. HP RATIO STABILITY ---
        # AI maintains unnaturally stable harmonic/percussive balance
        y_harmonic, y_percussive = librosa.effects.hpss(y)
        h_rms = librosa.feature.rms(y=y_harmonic)[0]
        p_rms = librosa.feature.rms(y=y_percussive)[0]
        if len(h_rms) > 1 and len(p_rms) > 1:
            hp_ratios = h_rms / (p_rms + 1e-10)
            hp_cv = np.std(hp_ratios) / (np.mean(hp_ratios) + 1e-10)
            # Human ~1.73, AI ~1.36 — lower CV = more stable = AI
            hp_score = np.clip(1.0 - (hp_cv - 1.0) / 1.0, 0.0, 1.0)
        else:
            hp_score = 0.5

        score = (0.25 * diff_score + 0.20 * complexity_score + 0.15 * modulation_score +
                 0.20 * repetitive_score + 0.20 * hp_score)
        confidence = min(1.0, chroma.shape[1] / 200.0)

        return float(np.clip(score, 0.0, 1.0)), float(confidence)

    except Exception:
        return 0.5, 0.0
