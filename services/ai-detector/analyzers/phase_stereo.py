"""Phase & stereo forensics.

AI tracks often have:
- Strange stereo width patterns
- Phase wandering
- No real center image

NOTE: Well-mixed human demos can have very stable stereo,
so this analyzer gets low weight and conservative thresholds.
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

        # --- 1. OVERALL MID/SIDE ENERGY RATIO ---
        # AI often has less real stereo separation
        mid_energy = np.mean(mid**2)
        side_energy = np.mean(side**2)
        ms_ratio = side_energy / (mid_energy + 1e-10)
        # Low ratio = mostly mono = more AI-like
        # Human ~0.03-0.10, AI varies
        # This is weak discriminator — just a mild signal
        ms_score = np.clip(1.0 - (ms_ratio / 0.10), 0.0, 1.0)

        # --- 2. L/R CORRELATION ---
        # Very high constant correlation = more AI-like
        frame_size = sr  # 1-second windows
        n_frames = max(1, len(left) // frame_size)
        correlations = []
        for i in range(n_frames):
            s, e = i * frame_size, min((i + 1) * frame_size, len(left))
            lf, rf = left[s:e], right[s:e]
            if len(lf) > 100:
                corr = np.corrcoef(lf, rf)[0, 1]
                if not np.isnan(corr):
                    correlations.append(corr)

        if len(correlations) < 3:
            return 0.5, 0.3

        mean_corr = np.mean(correlations)
        # Very high mean correlation AND low variation = AI (fake stereo)
        # But human studio demos also have high correlation
        # Only flag if mean > 0.95 (near-mono)
        corr_score = np.clip((mean_corr - 0.85) / 0.15, 0.0, 1.0)

        # --- 3. CENTER IMAGE QUALITY ---
        # Human recordings have a clear center (vocals, bass)
        # Check low-frequency center
        stft_mid = librosa.stft(mid)
        stft_side = librosa.stft(side)
        freq_bins = librosa.fft_frequencies(sr=sr)
        idx_300 = np.searchsorted(freq_bins, 300)
        low_mid_e = np.mean(np.abs(stft_mid[:idx_300, :]))
        low_side_e = np.mean(np.abs(stft_side[:idx_300, :]))
        low_center_ratio = low_mid_e / (low_side_e + 1e-10)
        # High ratio = strong center = human-like
        # But both human and AI can have strong center
        # Only flag very LOW center ratio (bad mixing)
        center_score = np.clip(1.0 - (low_center_ratio - 3) / 12, 0.0, 1.0)

        score = 0.35 * ms_score + 0.35 * corr_score + 0.30 * center_score
        confidence = 0.4  # Low confidence — stereo is weak discriminator

        return float(np.clip(score, 0.0, 1.0)), float(confidence)

    except Exception:
        return 0.5, 0.0
