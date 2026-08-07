"""Diagnostic: compare raw audio features between human and AI tracks."""
import sys
import numpy as np
import librosa
import soundfile as sf

def diagnose(file_path: str, label: str):
    print(f"\n{'='*60}")
    print(f"  {label}: {file_path}")
    print(f"{'='*60}")

    y, sr = librosa.load(file_path, sr=22050, mono=True, duration=600)
    print(f"Duration: {len(y)/sr:.1f}s, SR: {sr}")

    # --- ONSET REGULARITY ---
    onsets = librosa.onset.onset_detect(y=y, sr=sr, units='time')
    iois = np.diff(onsets)
    cv = np.std(iois) / np.mean(iois) if len(iois) > 0 else 0
    dominant_ioi = np.median(iois) if len(iois) > 0 else 0.5
    ratios = iois / dominant_ioi if dominant_ioi > 0 else iois
    snap_targets = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0]
    snap_count = sum(1 for r in ratios if min(abs(r - t) for t in snap_targets) < 0.03)
    snap_ratio = snap_count / len(ratios) if len(ratios) > 0 else 0
    print(f"\n[ONSET REGULARITY]")
    print(f"  Onsets detected: {len(onsets)}")
    print(f"  IOI CV: {cv:.4f}  (lower = more AI-like)")
    print(f"  IOI mean: {np.mean(iois):.4f}s, std: {np.std(iois):.4f}s")
    print(f"  Snap ratio (0.03): {snap_ratio:.4f}  (higher = more AI-like)")

    # --- TIMING JITTER ---
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    tempo_val = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    if len(beat_times) > 1:
        beat_intervals = np.diff(beat_times)
        tempo_cv = np.std(beat_intervals) / np.mean(beat_intervals)
    else:
        tempo_cv = 0
    deviations = []
    beat_period = 60.0 / tempo_val if tempo_val > 0 else 0.5
    for onset in onsets:
        if len(beat_times) > 0:
            dists = np.abs(beat_times - onset)
            min_dist = np.min(dists)
            deviations.append(min_dist / beat_period)
    deviations = np.array(deviations)
    mean_dev = np.mean(deviations) if len(deviations) > 0 else 0
    print(f"\n[TIMING JITTER]")
    print(f"  Tempo: {tempo_val:.1f} BPM, Beats: {len(beat_times)}")
    print(f"  Mean deviation from grid: {mean_dev:.4f}  (lower = more AI-like)")
    print(f"  Tempo CV: {tempo_cv:.4f}  (lower = more AI-like)")
    print(f"  Beat period: {beat_period:.4f}s")

    # --- HARMONIC ANALYSIS ---
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_temporal_var = np.mean(np.var(chroma, axis=1))
    chroma_diff = np.diff(chroma, axis=1)
    mean_diff = np.mean(np.abs(chroma_diff))
    frame_entropies = []
    for i in range(chroma.shape[1]):
        frame = chroma[:, i]
        frame_norm = frame / (np.sum(frame) + 1e-10)
        entropy = -np.sum(frame_norm * np.log2(frame_norm + 1e-10))
        frame_entropies.append(entropy)
    entropy_var = np.var(frame_entropies)
    y_harmonic, y_percussive = librosa.effects.hpss(y)
    h_rms = librosa.feature.rms(y=y_harmonic)[0]
    p_rms = librosa.feature.rms(y=y_percussive)[0]
    hp_frame_ratios = h_rms / (p_rms + 1e-10)
    hp_cv = np.std(hp_frame_ratios) / (np.mean(hp_frame_ratios) + 1e-10)
    print(f"\n[HARMONIC ANALYSIS]")
    print(f"  Chroma temporal var: {chroma_temporal_var:.4f}  (lower = more AI-like)")
    print(f"  Chroma frame diff: {mean_diff:.4f}  (lower = more AI-like)")
    print(f"  Entropy variance: {entropy_var:.4f}  (lower = more AI-like)")
    print(f"  HP ratio CV: {hp_cv:.4f}  (lower = more AI-like)")

    # --- SPECTRAL ANALYSIS ---
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    bandwidth = librosa.feature.spectral_bandwidth(y=y, sr=sr)[0]
    rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr)[0]
    centroid_cv = np.std(centroid) / (np.mean(centroid) + 1e-10)
    bandwidth_cv = np.std(bandwidth) / (np.mean(bandwidth) + 1e-10)
    rolloff_cv = np.std(rolloff) / (np.mean(rolloff) + 1e-10)
    spec = np.abs(librosa.stft(y))
    freq_bins = librosa.fft_frequencies(sr=sr)
    high_freq_idx = int(len(freq_bins) * 0.9)
    high_energy = np.mean(spec[high_freq_idx:, :])
    total_energy = np.mean(spec)
    high_ratio = high_energy / (total_energy + 1e-10)
    print(f"\n[SPECTRAL ANALYSIS]")
    print(f"  Centroid CV: {centroid_cv:.4f}  (lower = more AI-like)")
    print(f"  Bandwidth CV: {bandwidth_cv:.4f}  (lower = more AI-like)")
    print(f"  Rolloff CV: {rolloff_cv:.4f}  (lower = more AI-like)")
    print(f"  High freq ratio: {high_ratio:.4f}  (lower = more AI-like)")
    print(f"  Mean centroid: {np.mean(centroid):.0f} Hz")
    print(f"  Mean rolloff: {np.mean(rolloff):.0f} Hz")

    # --- DYNAMIC RANGE ---
    rms = librosa.feature.rms(y=y)[0]
    rms_nonzero = rms[rms > np.max(rms) * 0.01]
    dynamic_range_db = 20 * np.log10(np.max(rms_nonzero) / (np.min(rms_nonzero) + 1e-10))
    rms_cv = np.std(rms_nonzero) / (np.mean(rms_nonzero) + 1e-10)
    n_sections = min(8, len(rms_nonzero) // 10)
    if n_sections >= 3:
        sections = np.array_split(rms_nonzero, n_sections)
        section_means = [np.mean(s) for s in sections]
        section_cv = np.std(section_means) / (np.mean(section_means) + 1e-10)
    else:
        section_cv = 0.15
    rms_diff = np.abs(np.diff(rms_nonzero))
    diff_cv = np.std(rms_diff) / (np.mean(rms_diff) + 1e-10) if np.mean(rms_diff) > 0 else 0
    print(f"\n[DYNAMIC RANGE]")
    print(f"  Dynamic range: {dynamic_range_db:.1f} dB  (lower = more AI-like)")
    print(f"  RMS CV: {rms_cv:.4f}  (lower = more AI-like)")
    print(f"  Section CV: {section_cv:.4f}  (lower = more AI-like)")
    print(f"  Diff CV: {diff_cv:.4f}  (lower = more AI-like)")

    # --- STEREO FIELD ---
    try:
        y_stereo, sr_orig = sf.read(file_path, always_2d=True)
        if y_stereo.shape[1] >= 2:
            left = y_stereo[:, 0]
            right = y_stereo[:, 1]
            if sr_orig != sr:
                left = librosa.resample(left, orig_sr=sr_orig, target_sr=sr)
                right = librosa.resample(right, orig_sr=sr_orig, target_sr=sr)
            min_len = min(len(left), len(right))
            left, right = left[:min_len], right[:min_len]
            mid = (left + right) / 2.0
            side = (left - right) / 2.0
            side_ratio = np.mean(np.abs(side)) / (np.mean(np.abs(mid)) + 1e-10)
            correlation = np.corrcoef(left, right)[0, 1]
            frame_size = sr
            n_frames = max(1, len(left) // frame_size)
            widths = []
            for i in range(n_frames):
                s, e = i * frame_size, min((i+1) * frame_size, len(left))
                w = np.mean(np.abs(left[s:e] - right[s:e]) / 2) / (np.mean(np.abs(left[s:e] + right[s:e]) / 2) + 1e-10)
                widths.append(w)
            width_cv = np.std(widths) / (np.mean(widths) + 1e-10) if len(widths) > 1 else 0
            print(f"\n[STEREO FIELD]")
            print(f"  Side/Mid ratio: {side_ratio:.4f}  (lower = more AI-like)")
            print(f"  L/R correlation: {correlation:.4f}  (higher = more AI-like)")
            print(f"  Width CV: {width_cv:.4f}  (lower = more AI-like)")
        else:
            print(f"\n[STEREO FIELD] Mono file")
    except Exception as e:
        print(f"\n[STEREO FIELD] Error: {e}")

    # --- NEW FEATURES (candidates for new analyzers) ---
    print(f"\n[ADDITIONAL FEATURES]")

    # Zero-crossing rate regularity
    zcr = librosa.feature.zero_crossing_rate(y)[0]
    zcr_cv = np.std(zcr) / (np.mean(zcr) + 1e-10)
    print(f"  ZCR CV: {zcr_cv:.4f}  (lower = more AI-like)")

    # Spectral flux
    spec = np.abs(librosa.stft(y))
    flux = np.sqrt(np.sum(np.diff(spec, axis=1)**2, axis=0))
    flux_cv = np.std(flux) / (np.mean(flux) + 1e-10)
    print(f"  Spectral flux CV: {flux_cv:.4f}  (lower = more AI-like)")

    # Spectral contrast
    contrast = librosa.feature.spectral_contrast(y=y, sr=sr)
    contrast_var = np.mean(np.var(contrast, axis=1))
    print(f"  Spectral contrast var: {contrast_var:.4f}  (lower = more AI-like)")

    # MFCCs variance pattern
    mfccs = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=20)
    mfcc_vars = np.var(mfccs, axis=1)
    # Higher MFCCs (13-20) — texture coefficients
    high_mfcc_var = np.mean(mfcc_vars[13:])
    low_mfcc_var = np.mean(mfcc_vars[1:6])
    mfcc_ratio = high_mfcc_var / (low_mfcc_var + 1e-10)
    print(f"  High MFCC var (13-20): {high_mfcc_var:.4f}")
    print(f"  Low MFCC var (1-6): {low_mfcc_var:.4f}")
    print(f"  MFCC var ratio (high/low): {mfcc_ratio:.4f}  (lower = more AI-like)")

    # Temporal autocorrelation of RMS
    rms_ac = np.correlate(rms - np.mean(rms), rms - np.mean(rms), mode='full')
    rms_ac = rms_ac[len(rms_ac)//2:]
    rms_ac = rms_ac / (rms_ac[0] + 1e-10)
    # Mean autocorrelation at lags 5-30
    if len(rms_ac) > 30:
        rms_ac_mean = np.mean(rms_ac[5:30])
    else:
        rms_ac_mean = 0
    print(f"  RMS autocorrelation (lag 5-30): {rms_ac_mean:.4f}  (higher = more AI-like)")

    # Onset strength CV
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onset_cv = np.std(onset_env) / (np.mean(onset_env) + 1e-10)
    print(f"  Onset strength CV: {onset_cv:.4f}  (lower = more AI-like)")

    # Spectral bandwidth at high frequencies (> 8kHz)
    # Check for hard cutoff
    mean_spec = np.mean(spec, axis=1)
    freq_bins = librosa.fft_frequencies(sr=sr)
    # Energy above 8kHz vs 4-8kHz
    idx_4k = np.searchsorted(freq_bins, 4000)
    idx_8k = np.searchsorted(freq_bins, 8000)
    energy_4_8k = np.mean(mean_spec[idx_4k:idx_8k])
    energy_8k_plus = np.mean(mean_spec[idx_8k:])
    hf_ratio = energy_8k_plus / (energy_4_8k + 1e-10)
    print(f"  High-freq energy ratio (>8k / 4-8k): {hf_ratio:.4f}  (lower = sharper cutoff = AI-like)")

    # Spectral rolloff mean
    rolloff_mean = np.mean(rolloff)
    rolloff_ratio = rolloff_mean / sr
    print(f"  Rolloff ratio (mean/sr): {rolloff_ratio:.4f}")

    print()


if __name__ == '__main__':
    diagnose('/tmp/testaimusic/Medium-Cry.mp3', 'HUMAN (Medium-Cry)')
    diagnose('/tmp/testaimusic/Medium_Solnce_demo3.mp3', 'SUNO AI (Medium_Solnce_demo3)')
