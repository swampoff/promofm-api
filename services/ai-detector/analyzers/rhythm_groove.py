"""Rhythm & groove analyzer — tempo stability + onset patterns.

AI rhythm is:
- Too perfectly quantized (no microtiming)
- Ultra-stable tempo (no tempo drift)
- Machine-perfect onset regularity
- Consistent onset strengths (no accents)
"""
import numpy as np
import librosa


def analyze_rhythm_groove(y: np.ndarray, sr: int) -> tuple[float, float]:
    """Score 0.0 = human-like (groovy), 1.0 = AI-like (robotic)."""
    try:
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        tempo_val = float(np.atleast_1d(tempo)[0])
        beat_times = librosa.frames_to_time(beat_frames, sr=sr)

        onsets = librosa.onset.onset_detect(y=y, sr=sr, units='time')

        if len(beat_times) < 4 or len(onsets) < 8:
            return 0.5, 0.2

        beat_period = 60.0 / tempo_val if tempo_val > 0 else 0.5

        # --- 1. TEMPO STABILITY (strongest signal!) ---
        # Human ~0.053-0.059, AI ~0.020-0.023
        beat_intervals = np.diff(beat_times)
        tempo_cv = np.std(beat_intervals) / np.mean(beat_intervals)
        # Range 0.015-0.065
        tempo_score = np.clip(1.0 - (tempo_cv - 0.015) / 0.050, 0.0, 1.0)

        # --- 2. ONSET GRID DEVIATION ---
        # How far onsets deviate from nearest beat grid point
        deviations = []
        for onset in onsets:
            dists = np.abs(beat_times - onset)
            deviations.append(np.min(dists) / beat_period)
        mean_dev = np.mean(deviations)
        # Human ~0.25-0.30, AI ~0.15-0.23
        dev_score = np.clip(1.0 - (mean_dev - 0.12) / 0.20, 0.0, 1.0)

        # --- 3. ONSET STRENGTH VARIATION ---
        # Human has varied onset strengths (accents, dynamics)
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        onset_peaks_idx = librosa.onset.onset_detect(y=y, sr=sr, units='frames')
        if len(onset_peaks_idx) > 5:
            valid_idx = onset_peaks_idx[onset_peaks_idx < len(onset_env)]
            peak_strengths = onset_env[valid_idx]
            strength_cv = np.std(peak_strengths) / (np.mean(peak_strengths) + 1e-10)
            # Higher CV = more accent variation = human
            # Human ~0.45-0.55, AI ~0.50-0.52 (narrow difference, low weight)
            strength_score = np.clip(1.0 - (strength_cv - 0.35) / 0.30, 0.0, 1.0)
        else:
            strength_score = 0.5

        # --- 4. IOI REGULARITY ---
        # AI has more regular inter-onset intervals
        iois = np.diff(onsets)
        if len(iois) > 5:
            ioi_cv = np.std(iois) / np.mean(iois)
            # Human ~0.70-0.85, AI ~0.50-0.70
            # But some human tracks (pop/electronic) can have low IOI CV too
            # Widen range to reduce false positives
            ioi_score = np.clip(1.0 - (ioi_cv - 0.40) / 0.50, 0.0, 1.0)
        else:
            ioi_score = 0.5

        # --- 5. BEAT INTERVAL AUTOCORRELATION ---
        # AI has more periodic beat intervals (copy-paste rhythm)
        if len(beat_intervals) > 8:
            bi_centered = beat_intervals - np.mean(beat_intervals)
            ac = np.correlate(bi_centered, bi_centered, mode='full')
            ac = ac[len(ac)//2:]
            ac = ac / (ac[0] + 1e-10)
            # Check autocorrelation at 4-beat and 8-beat lags
            lag_4 = min(4, len(ac) - 1)
            lag_8 = min(8, len(ac) - 1)
            ac_periodic = max(ac[lag_4], ac[lag_8]) if lag_8 > lag_4 else ac[lag_4]
            # High AC at musical intervals = AI (copy-paste rhythm patterns)
            ac_score = np.clip(ac_periodic / 0.5, 0.0, 1.0)
        else:
            ac_score = 0.5

        # Tempo stability is strongest — weight it highest
        score = (0.40 * tempo_score + 0.20 * dev_score + 0.15 * strength_score +
                 0.10 * ioi_score + 0.15 * ac_score)
        confidence = min(1.0, len(onsets) / 40.0)

        return float(np.clip(score, 0.0, 1.0)), float(confidence)

    except Exception:
        return 0.5, 0.0
