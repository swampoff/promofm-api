"""Phase & stereo forensics.

AI tracks often have:
- Strange stereo width (too narrow or artificially wide)
- Phase wandering (inconsistent phase relationship)
- No real center image (phantom center vs panned center)
- Unnaturally stable stereo field
"""
import numpy as np
import librosa
import soundfile as sf


def analyze_phase_stereo(file_path: str, y_mono: np.ndarray, sr: int) -> tuple[float, float]:
    """Score 0.0 = human-like, 1.0 = AI-like."""
    try:
        y_stereo, sr_orig = sf.read(file_path, always_2d=True)

        if y_stereo.shape[1] < 2:
            return 0.5, 0.3  # Mono — can't analyze

        left = y_stereo[:, 0]
        right = y_stereo[:, 1]

        if sr_orig != sr:
            left = librosa.resample(left, orig_sr=sr_orig, target_sr=sr)
            right = librosa.resample(right, orig_sr=sr_orig, target_sr=sr)

        min_len = min(len(left), len(right))
        left, right = left[:min_len], right[:min_len]

        mid = (left + right) / 2.0
        side = (left - right) / 2.0

        # --- 1. L/R CORRELATION STABILITY ---
        # AI has unnaturally stable correlation over time
        frame_size = sr  # 1-second windows
        n_frames = max(1, len(left) // frame_size)
        correlations = []
        widths = []
        for i in range(n_frames):
            s, e = i * frame_size, min((i + 1) * frame_size, len(left))
            lf, rf = left[s:e], right[s:e]
            if len(lf) > 100:
                corr = np.corrcoef(lf, rf)[0, 1]
                if not np.isnan(corr):
                    correlations.append(corr)
                sf_frame = (lf - rf) / 2.0
                mf_frame = (lf + rf) / 2.0
                w = np.mean(np.abs(sf_frame)) / (np.mean(np.abs(mf_frame)) + 1e-10)
                widths.append(w)

        if len(correlations) < 3:
            return 0.5, 0.3

        # Correlation CV — human has more varied correlation
        corr_cv = np.std(correlations) / (np.mean(np.abs(correlations)) + 1e-10)
        corr_score = np.clip(1.0 - (corr_cv / 0.30), 0.0, 1.0)

        # --- 2. STEREO WIDTH VARIATION ---
        # AI has more stable width (low CV)
        width_cv = np.std(widths) / (np.mean(widths) + 1e-10) if len(widths) > 1 else 0
        width_score = np.clip(1.0 - (width_cv / 0.60), 0.0, 1.0)

        # --- 3. PHASE COHERENCE ---
        # Compute short-time phase difference between L and R
        stft_l = librosa.stft(left)
        stft_r = librosa.stft(right)
        phase_l = np.angle(stft_l)
        phase_r = np.angle(stft_r)
        phase_diff = np.abs(phase_l - phase_r)
        # Normalize to [0, pi]
        phase_diff = np.minimum(phase_diff, 2 * np.pi - phase_diff)

        # Mean phase difference — AI often has more uniform phase
        phase_mean = np.mean(phase_diff)
        phase_cv = np.std(np.mean(phase_diff, axis=0)) / (phase_mean + 1e-10)
        # Lower phase CV = more uniform phase = AI-like
        phase_score = np.clip(1.0 - (phase_cv / 0.40), 0.0, 1.0)

        # --- 4. CENTER IMAGE QUALITY ---
        # Human recordings have a clear center image (vocals, bass)
        # Check how much energy is in mid vs side across frequency bands
        stft_mid = librosa.stft(mid)
        stft_side = librosa.stft(side)
        # Low-frequency center (< 300Hz) — should be mostly mid
        freq_bins_stft = librosa.fft_frequencies(sr=sr)
        idx_300 = np.searchsorted(freq_bins_stft, 300)
        low_mid = np.mean(np.abs(stft_mid[:idx_300, :]))
        low_side = np.mean(np.abs(stft_side[:idx_300, :]))
        low_center_ratio = low_mid / (low_side + 1e-10)
        # Very high = strong center = human. Low = AI has low-freq in side
        center_score = np.clip(1.0 - (low_center_ratio - 5) / 15, 0.0, 1.0)

        score = 0.25 * corr_score + 0.25 * width_score + 0.30 * phase_score + 0.20 * center_score
        confidence = 0.6

        return float(np.clip(score, 0.0, 1.0)), float(confidence)

    except Exception:
        return 0.5, 0.0
