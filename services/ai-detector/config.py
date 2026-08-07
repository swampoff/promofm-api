"""Configuration for AI music detector v3.1 — recalibrated weights."""

ANALYSIS_SR = 22050
ANALYSIS_MONO = True

# Weights based on REAL diagnostic data from 4 labeled tracks
# Best discriminators: tempo CV, HF ratio/slope, section dynamics CV
WEIGHTS = {
    'rhythm_groove': 0.28,         # Tempo stability = strongest signal
    'spectral_forensics': 0.22,    # HF flatness + slope = strong signal
    'dynamics_lufs': 0.20,         # Section dynamics CV = strong signal
    'structural_analysis': 0.10,   # Fixed normalization, moderate signal
    'harmonic_theory': 0.10,       # Moderate signal
    'micro_texture': 0.07,         # Weak — penalizes clean human recordings
    'phase_stereo': 0.03,          # Weakest — studio mixes ≈ AI
}

THRESHOLDS = {
    'likely_human': 35,
    'uncertain': 55,
    'likely_ai': 70,
    # above 70 = highly_likely_ai
}

VERSION = '3.1.0'
MAX_DURATION_SECONDS = 600
