#!/bin/bash
# Установка конвейера каталога на арендованный GPU (Ubuntu 22.04 + драйвер NVIDIA).
#   HF_TOKEN=hf_... bash setup_gpu.sh
# Ставит ffmpeg, uv, Stable Audio 3 (+ flash-attn под версию python/torch) и ACE-Step 1.5.
set -euo pipefail
: "${HF_TOKEN:?нужен HF_TOKEN (Hugging Face, Read, с принятой лицензией stable-audio-3-medium)}"
ROOT=/opt/catalog
mkdir -p "$ROOT" && cd "$ROOT"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq ffmpeg git curl tmux >/dev/null
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

# Stable Audio 3
[ -d stable-audio-3 ] || git clone -q https://github.com/Stability-AI/stable-audio-3.git
cd stable-audio-3
uv sync -q
PY=$(uv run python -c 'import sys;print(f"cp{sys.version_info.major}{sys.version_info.minor}")')
TV=$(uv run python -c 'import torch;v=torch.__version__.split("+")[0].split(".");print(v[0]+"."+v[1])')
CU=$(uv run python -c 'import torch;print("cu"+(torch.version.cuda or "").replace(".",""))')
echo "python=$PY torch=$TV cuda=$CU"
# flash-attn обязателен для Medium: предсобранное колесо под версии окружения
WHL="https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/download/v0.7.16/flash_attn-2.6.3+${CU}torch${TV}-${PY}-${PY}-linux_x86_64.whl"
uv pip install -q "$WHL" || { echo "Нет готового колеса flash-attn под $PY/$TV/$CU — подобрать вручную: https://github.com/mjun0812/flash-attention-prebuild-wheels/releases"; exit 1; }
uv run huggingface-cli login --token "$HF_TOKEN" >/dev/null
uv run python -c 'from stable_audio_3 import StableAudioModel; StableAudioModel.from_pretrained("medium"); print("SA3 medium: веса загружены")'
cd "$ROOT"

# ACE-Step 1.5 (второй движок для сравнения)
[ -d ACE-Step-1.5 ] || git clone -q https://github.com/ACE-Step/ACE-Step-1.5.git
(cd ACE-Step-1.5 && uv sync -q)
echo "Готово. Скрипты конвейера: $ROOT/promo-air-catalog"
