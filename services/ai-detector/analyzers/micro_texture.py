"""Micro-texture analyzer — noise floor, ZCR, amplitude patterns.

AI audio is unnaturally "clean":
- No room noise or ambience
- No analog hiss or hum
- Too smooth zero-crossing patterns

BUT: clean studio human recordings can also lack room noise!
So noise floor features get reduced weight.
"""
import numpy as np
import librosa


def analyze_micro_texture(y: np.ndarray, sr: int) -> tuple[float, float]:
    """Score 0.0 = human-like (textured), 1.0 = AI-like (sterile)."""
    try:
        # --- 1. ZCR REGULARITY ---
        # AI has more regular ZCR patterns
        zcr = librosa.feature.zero_crossing_rate(y)[0]
        if len(zcr) > 10:
            zcr_cv = np.std(zcr) / (np.mean(zcr) + 1e-10)
            # Human ~1.05-1.15, AI ~0.81-0.95
            # But Cry(Human)=1.15, Tochka(AI)=1.09 — overlap exists
            # Sierra(Human)=0.81 — very regular, close to AI range
            # Widen range to reduce false positives
            zcr_score = np.clip(1.0 - (zcr_cv - 0.60) / 0.70, 0.0, 1.0)
        else:
            zcr_score = 0.5

        # --- 2. SPECTRAL CENTROID MICRO-VARIATION ---
        # Human audio has more centroid jitter from natural production
        centroid = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=512)[0]
        if len(centroid) > 20:
            centroid_diff = np.abs(np.diff(centroid))
            centroid_diff_cv = np.std(centroid_diff) / (np.mean(centroid_diff) + 1e-10)
            # All tracks show similar values (1.12-1.34), limited discrimination
            # Higher = more varied = human
            centroid_jitter_score = np.clip(1.0 - (centroid_diff_cv - 0.50) / 1.20, 0.0, 1.0)
        else:
            centroid_jitter_score = 0.5

        # --- 3. MICRO-LEVEL AMPLITUDE VARIATION ---
        micro_frame = min(256, len(y) // 100)
        if micro_frame > 10:
            n_micro = len(y) // micro_frame
            micro_rms = []
            for i in range(n_micro):
                chunk = y[i * micro_frame:(i + 1) * micro_frame]
                micro_rms.append(np.sqrt(np.mean(chunk**2)))
            micro_rms = np.array(micro_rms)
            micro_diff = np.abs(np.diff(micro_rms))
            micro_diff_cv = np.std(micro_diff) / (np.mean(micro_diff) + 1e-10)
            # All tracks ~1.0-1.2 — low discrimination, reduce weight
            micro_score = np.clip(1.0 - (micro_diff_cv - 0.8) / 2.5, 0.0, 1.0)
        else:
            micro_score = 0.5

        # --- 4. NOISE FLOOR ANALYSIS (reduced weight — penalizes clean human recordings) ---
        rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
        if len(rms) < 20:
            noise_floor_score = 0.5
        else:
            quiet_threshold = np.percentile(rms, 10) * 2
            quiet_mask = rms < quiet_threshold
            flatness = librosa.feature.spectral_flatness(y=y, hop_length=512)[0]
            quiet_flatness_vals = flatness[quiet_mask[:len(flatness)]]
            if len(quiet_flatness_vals) > 3:
                mean_quiet_flatness = np.mean(quiet_flatness_vals)
                # High flatness = noise-like = human room noise
                # But clean studio human (Sierra 0.024) ≈ AI (Solnce 0.023)
                # Only flag VERY clean (< 0.01) as AI
                noise_floor_score = np.clip(1.0 - (mean_quiet_flatness / 0.05), 0.0, 1.0)
            else:
                noise_floor_score = 0.5

        # --- 5. SPECTRAL BANDWIDTH VARIATION ---
        # Human has more varied bandwidth over time
        bandwidth = librosa.feature.spectral_bandwidth(y=y, sr=sr, hop_length=512)[0]
        if len(bandwidth) > 20:
            bw_cv = np.std(bandwidth) / (np.mean(bandwidth) + 1e-10)
            # Higher CV = more varied = human
            bw_score = np.clip(1.0 - (bw_cv - 0.15) / 0.35, 0.0, 1.0)
        else:
            bw_score = 0.5

        score = (0.25 * zcr_score + 0.25 * centroid_jitter_score +
                 0.15 * micro_score + 0.15 * noise_floor_score + 0.20 * bw_score)
        confidence = min(1.0, len(zcr) / 200.0) if len(zcr) > 10 else 0.2

        return float(np.clip(score, 0.0, 1.0)), float(confidence)

    except Exception:
        return 0.5, 0.0
