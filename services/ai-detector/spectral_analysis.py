"""Spectral analysis v2.1 — added high-frequency flatness detection.

Key Suno artifact: unnaturally elevated energy in 8-10kHz+ range.
Human recordings have steeper spectral rolloff above 6kHz.
AI neural codecs maintain or boost high frequencies artificially.
"""
import numpy as np
import librosa


def analyze_spectral(y: np.ndarray, sr: int) -> tuple[float, float]:
    """Score 0.0 = human-like, 1.0 = AI-like (spectral artifacts)."""
    try:
        centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
        bandwidth = librosa.feature.spectral_bandwidth(y=y, sr=sr)[0]
        rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr)[0]

        if len(centroid) < 10:
            return 0.5, 0.2

        spec = np.abs(librosa.stft(y))
        freq_bins = librosa.fft_frequencies(sr=sr)

        # 1. Centroid CV — calibrated range 0.35-0.70
        centroid_cv = np.std(centroid) / (np.mean(centroid) + 1e-10)
        centroid_score = np.clip(1.0 - (centroid_cv - 0.35) / 0.35, 0.0, 1.0)

        # 2. Bandwidth CV — calibrated range 0.18-0.45
        bandwidth_cv = np.std(bandwidth) / (np.mean(bandwidth) + 1e-10)
        bw_score = np.clip(1.0 - (bandwidth_cv - 0.18) / 0.27, 0.0, 1.0)

        # 3. Rolloff CV — calibrated range 0.30-0.70
        rolloff_cv = np.std(rolloff) / (np.mean(rolloff) + 1e-10)
        rolloff_score = np.clip(1.0 - (rolloff_cv - 0.30) / 0.40, 0.0, 1.0)

        # 4. HIGH-FREQUENCY FLATNESS — key Suno artifact
        # AI has unnaturally elevated 8-10kHz relative to 6-8kHz
        # Human avg ~0.845, AI avg ~1.045
        idx_6k = np.searchsorted(freq_bins, 6000)
        idx_8k = np.searchsorted(freq_bins, 8000)
        idx_10k = np.searchsorted(freq_bins, 10000)

        e_6_8k = np.mean(spec[idx_6k:idx_8k, :])
        e_8_10k = np.mean(spec[idx_8k:idx_10k, :])
        e_10k_plus = np.mean(spec[idx_10k:, :])

        # 8-10k / 6-8k ratio: Human ~0.80-0.89, AI ~0.97-1.12
        # Calibrated range 0.75-1.15
        hf_ratio = e_8_10k / (e_6_8k + 1e-10)
        hf_score = np.clip((hf_ratio - 0.75) / 0.40, 0.0, 1.0)

        # 5. Spectral slope above 6kHz — flatter = more AI-like
        # Human ~-0.278, AI ~-0.236
        mean_spec = np.mean(spec, axis=1)
        high_freqs = freq_bins[idx_6k:]
        high_energy = mean_spec[idx_6k:]
        if len(high_freqs) > 2:
            log_energy = np.log10(high_energy + 1e-10)
            slope = np.polyfit(high_freqs / 1000, log_energy, 1)[0]
            # Slope range: -0.30 (steep, human) to -0.20 (flat, AI)
            slope_score = np.clip(1.0 - (abs(slope) - 0.20) / 0.12, 0.0, 1.0)
        else:
            slope_score = 0.5

        # 6. 10kHz+ relative energy
        total_energy = np.mean(spec)
        r_10k = e_10k_plus / (total_energy + 1e-10)
        # This is less discriminative, keep low weight

        # Weight high-frequency features heavily — they're the strongest signal
        score = (0.12 * centroid_score + 0.10 * bw_score +
                 0.10 * rolloff_score + 0.35 * hf_score + 0.33 * slope_score)
        confidence = min(1.0, len(centroid) / 200.0)

        return float(np.clip(score, 0.0, 1.0)), float(confidence)

    except Exception:
        return 0.5, 0.0
