"""Ensemble combiner v3.1 — 7 forensic analyzers, recalibrated."""
import time
import numpy as np
import librosa

from config import WEIGHTS, THRESHOLDS, VERSION, ANALYSIS_SR, ANALYSIS_MONO, MAX_DURATION_SECONDS
from models import AnalysisResult
from analyzers import (
    analyze_spectral_forensics,
    analyze_dynamics_lufs,
    analyze_phase_stereo,
    analyze_harmonic_theory,
    analyze_rhythm_groove,
    analyze_structure,
    analyze_micro_texture,
)


def get_verdict(score: int) -> str:
    if score <= THRESHOLDS['likely_human']:
        return 'likely_human'
    elif score <= THRESHOLDS['uncertain']:
        return 'uncertain'
    elif score <= THRESHOLDS['likely_ai']:
        return 'likely_ai'
    else:
        return 'highly_likely_ai'


def run_analysis(file_path: str) -> AnalysisResult:
    """Run full v3.1 ensemble analysis on an audio file."""
    start_time = time.time()

    y, sr = librosa.load(file_path, sr=ANALYSIS_SR, mono=ANALYSIS_MONO,
                         duration=MAX_DURATION_SECONDS)

    if len(y) < sr * 3:
        return AnalysisResult(
            ai_score=50,
            confidence=0.1,
            verdict='uncertain',
            breakdown={},
            analysis_time_seconds=time.time() - start_time,
            analyzer_version=VERSION,
        )

    results = {}
    confidences = {}

    # Run all 7 analyzers
    score, conf = analyze_rhythm_groove(y, sr)
    results['rhythm_groove'] = score
    confidences['rhythm_groove'] = conf

    score, conf = analyze_spectral_forensics(y, sr)
    results['spectral_forensics'] = score
    confidences['spectral_forensics'] = conf

    score, conf = analyze_dynamics_lufs(y, sr)
    results['dynamics_lufs'] = score
    confidences['dynamics_lufs'] = conf

    score, conf = analyze_structure(y, sr)
    results['structural_analysis'] = score
    confidences['structural_analysis'] = conf

    score, conf = analyze_harmonic_theory(y, sr)
    results['harmonic_theory'] = score
    confidences['harmonic_theory'] = conf

    score, conf = analyze_micro_texture(y, sr)
    results['micro_texture'] = score
    confidences['micro_texture'] = conf

    score, conf = analyze_phase_stereo(file_path, y, sr)
    results['phase_stereo'] = score
    confidences['phase_stereo'] = conf

    # --- Clean NaN/None values ---
    for name in list(results.keys()):
        v = results[name]
        if v is None or np.isnan(v):
            results[name] = 0.5
            confidences[name] = 0.0

    # --- Weighted ensemble ---
    total_weight = 0.0
    weighted_sum = 0.0
    for name, weight in WEIGHTS.items():
        if name in results:
            effective_weight = weight * confidences.get(name, 0.5)
            weighted_sum += results[name] * effective_weight
            total_weight += effective_weight

    raw_score = weighted_sum / total_weight if total_weight > 0 else 0.5

    # --- Non-linear adjustments ---

    # 1. Top-3 agreement boost: if rhythm + spectral + dynamics all agree
    rhythm = results.get('rhythm_groove', 0.5)
    spectral = results.get('spectral_forensics', 0.5)
    dynamics = results.get('dynamics_lufs', 0.5)

    top3_ai = sum(1 for v in [rhythm, spectral, dynamics] if v > 0.60)
    top3_human = sum(1 for v in [rhythm, spectral, dynamics] if v < 0.35)

    if top3_ai >= 2:
        # Two strongest analyzers agree on AI
        boost = 0.04 * top3_ai
        raw_score = min(1.0, raw_score + boost)
    elif top3_human >= 2:
        # Two strongest analyzers agree on human
        reduction = 0.03 * top3_human
        raw_score = max(0.0, raw_score - reduction)

    # 2. Strong rhythm signal amplification
    if rhythm > 0.70:
        boost = (rhythm - 0.70) * 0.20
        raw_score = min(1.0, raw_score + boost)
    elif rhythm < 0.30:
        reduction = (0.30 - rhythm) * 0.15
        raw_score = max(0.0, raw_score - reduction)

    # 3. Strong spectral HF signal
    if spectral > 0.70:
        raw_score = min(1.0, raw_score + 0.03)

    if np.isnan(raw_score):
        raw_score = 0.5
    ai_score = int(round(raw_score * 100))
    ai_score = max(0, min(100, ai_score))

    # Overall confidence
    conf_sum = sum(confidences.get(n, 0) * WEIGHTS.get(n, 0) for n in WEIGHTS)
    weight_sum = sum(WEIGHTS.values())
    overall_confidence = conf_sum / weight_sum if weight_sum > 0 else 0.5

    elapsed = time.time() - start_time

    return AnalysisResult(
        ai_score=ai_score,
        confidence=round(overall_confidence, 3),
        verdict=get_verdict(ai_score),
        breakdown={k: round(v, 3) for k, v in results.items()},
        analysis_time_seconds=round(elapsed, 2),
        analyzer_version=VERSION,
    )
