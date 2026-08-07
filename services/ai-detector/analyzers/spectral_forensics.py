"""Spectral forensics — deep spectral analysis.

Detects:
1. HF flatness (unnaturally elevated 8-10kHz+ — neural codec artifact)
2. Micro-noise absence (AI lacks room noise, analog hiss, mechanical sounds)
3. Spectral smoothness (AI has unnaturally smooth spectral evolution)
4. Harmonic regularity (AI harmonics are too clean and evenly spaced)
"""
import numpy as np
import librosa


def analyze_spectral_forensics(y: np.ndarray, sr: int) -> tuple[float, float]:
    """Score 0.0 = human-like, 1.0 = AI-like."""
    try:
        spec = np.abs(librosa.stft(y))
        freq_bins = librosa.fft_frequencies(sr=sr)

        if spec.shape[1] < 10:
            return 0.5, 0.2

        # --- 1. HIGH-FREQUENCY FLATNESS ---
        # AI neural codecs maintain/boost energy above 8kHz artificially
        # Human recordings have natural rolloff
        idx_6k = np.searchsorted(freq_bins, 6000)
        idx_8k = np.searchsorted(freq_bins, 8000)
        idx_10k = np.searchsorted(freq_bins, 10000)

        e_6_8k = np.mean(spec[idx_6k:idx_8k, :])
        e_8_10k = np.mean(spec[idx_8k:idx_10k, :])

        # 8-10kHz / 6-8kHz ratio: Human ~0.80-0.89, AI ~0.97-1.12
        hf_ratio = e_8_10k / (e_6_8k + 1e-10)
        hf_score = np.clip((hf_ratio - 0.75) / 0.40, 0.0, 1.0)

        # Spectral slope above 6kHz
        mean_spec = np.mean(spec, axis=1)
        high_freqs = freq_bins[idx_6k:]
        high_energy = mean_spec[idx_6k:]
        if len(high_freqs) > 2:
            log_energy = np.log10(high_energy + 1e-10)
            slope = np.polyfit(high_freqs / 1000, log_energy, 1)[0]
            # Human ~-0.278, AI ~-0.236 — flatter = more AI
            slope_score = np.clip(1.0 - (abs(slope) - 0.20) / 0.12, 0.0, 1.0)
        else:
            slope_score = 0.5

        # --- 2. MICRO-NOISE ANALYSIS ---
        # Human recordings have background noise floor from room/electronics
        # AI audio has unnaturally clean silence
        # Check noise floor in quiet sections
        rms_frames = librosa.feature.rms(y=y)[0]
        quiet_threshold = np.percentile(rms_frames, 10)
        quiet_mask = rms_frames < quiet_threshold * 1.5
        quiet_frames = np.where(quiet_mask)[0]

        if len(quiet_frames) > 5:
            # Check spectral flatness in quiet sections
            flatness = librosa.feature.spectral_flatness(y=y)[0]
            quiet_flatness = flatness[quiet_frames[quiet_frames < len(flatness)]]
            if len(quiet_flatness) > 0:
                # High flatness in quiet sections = noise-like = human
                # Low flatness = clean silence = AI
                noise_flatness = np.mean(quiet_flatness)
                noise_score = np.clip(1.0 - (noise_flatness / 0.15), 0.0, 1.0)
            else:
                noise_score = 0.5
        else:
            noise_score = 0.5

        # --- 3. SPECTRAL SMOOTHNESS ---
        # AI has smoother frame-to-frame spectral changes
        spectral_flux = np.sqrt(np.sum(np.diff(spec, axis=1)**2, axis=0))
        flux_cv = np.std(spectral_flux) / (np.mean(spectral_flux) + 1e-10)
        # Human has higher flux variation
        smooth_score = np.clip(1.0 - (flux_cv - 0.50) / 0.40, 0.0, 1.0)

        # --- 4. HARMONIC REGULARITY ---
        # AI harmonics are spaced too evenly and too clean
        # Check per-frame harmonic-to-noise ratio stability
        # Use spectral contrast as proxy
        contrast = librosa.feature.spectral_contrast(y=y, sr=sr)
        contrast_cv = np.std(np.mean(contrast, axis=0)) / (np.mean(contrast) + 1e-10)
        harmonic_score = np.clip(1.0 - (contrast_cv / 0.50), 0.0, 1.0)

        score = (0.30 * hf_score + 0.25 * slope_score +
                 0.15 * noise_score + 0.15 * smooth_score + 0.15 * harmonic_score)
        confidence = min(1.0, spec.shape[1] / 200.0)

        return float(np.clip(score, 0.0, 1.0)), float(confidence)

    except Exception:
        return 0.5, 0.0
