#!/usr/bin/env python3
"""
Promo.FM Radio Announcer — Gemini Native Audio Live API → PCM overlay
Генерирует живые приветствия ведущих через Gemini Live API (WebSocket).
Возвращает PCM 44.1kHz stereo для наложения поверх музыки (ducking).
"""

import os
import sys
import json
import base64
import random
import struct
import asyncio
import logging
import datetime
import subprocess

logging.basicConfig(level=logging.INFO, format='%(asctime)s [Announcer] %(message)s')
logger = logging.getLogger(__name__)

# ─── Config ───
GEMINI_PROXY_URL = os.getenv("GEMINI_PROXY_URL", "http://187.77.85.42:8088")
GEMINI_PROXY_KEY = os.getenv("GEMINI_PROXY_KEY", "promofm-gemini-2026")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_LIVE_MODEL = "models/gemini-3.1-flash-live-preview"
FIFO_PATH = "/tmp/promofm.fifo"

# WS proxy endpoint
WS_PROXY = GEMINI_PROXY_URL.replace("http://", "ws://").replace("https://", "wss://") + "/ws/live"

DJS = [
    # DJ Ден убран 2026-08-07 (владелец): единственный со стилем «уличный,
    # как будто общается с друзьями» — в эфире звучал по-пацански. Остальные
    # ведущие профессиональные. В подкастах (engine.mjs) он описан иначе
    # («спокойно, аргументированно, без клубного жаргона») и там оставлен.
    {
        "name": "Сандра",
        "full": "Сандра",
        "gender": "female",
        "gemini_voice": "Kore",
        "style": "тёплая, уверенная, профессиональная, с лёгкой иронией",
    },
    {
        "name": "Макс",
        "full": "Макс",
        "gender": "male",
        "gemini_voice": "Fenrir",
        "style": "спокойный, расслабленный, как ночной DJ на FM-станции",
    },
    {
        "name": "Лиана",
        "full": "Лиана",
        "gender": "female",
        "gemini_voice": "Aoede",
        "style": "жизнерадостная, молодёжная, с энтузиазмом",
    },
    {
        "name": "Стелла",
        "full": "Стелла",
        "gender": "female",
        "gemini_voice": "Kore",
        "style": "глубокая, вдумчивая, как ведущая культурного радио",
    },
    {
        "name": "Марк",
        "full": "Марк",
        "gender": "male",
        # Был "Puck" — звучал по-подростковому/неприятно для делового стиля
        # ведущего новостей. "Charon" — глубокий, зрелый мужской голос.
        "gemini_voice": "Charon",
        "style": "деловой, информативный, чёткий, как ведущий новостей",
    },
]


def get_time_of_day_ru():
    utc = datetime.datetime.now(datetime.timezone.utc)
    msk = utc + datetime.timedelta(hours=3)
    h = msk.hour
    if 5 <= h < 12:
        return "утро", "Доброе утро"
    elif 12 <= h < 17:
        return "день", "Добрый день"
    elif 17 <= h < 22:
        return "вечер", "Добрый вечер"
    else:
        return "ночь", "Доброй ночи"


async def generate_audio_live(dj: dict) -> bytes | None:
    """
    Gemini Live API: отправляет промпт, получает стримом PCM 24kHz.
    Возвращает сырой PCM (24kHz mono).
    """
    import websockets

    time_period, greeting = get_time_of_day_ru()

    prompt = f"""Произнеси вслух текст радио-приветствия. Ты — {dj['full']}, живой радиоведущий ПРОМО.ФМ ({dj['style']}). Сейчас {time_period} по Москве.

ЖЁСТКИЕ ПРАВИЛА (нарушение недопустимо):
- Выдай ТОЛЬКО сам текст, который звучит в эфире. Ничего больше.
- МАКСИМУМ 5 коротких предложений. Только утверждения.
- НИ ОДНОГО вопроса. Запрещены любые вопросы и фразы: «ну что», «как вам», «как тебе», «как тебе такой вариант», «звучит убедительно», «что-то добавить», «что думаете», «согласны», «правда круто», «пишите», «звоните».
- НИКОГДА не комментируй свою речь, не спрашивай мнения, не обращайся к оператору или редактору.
- НИКОГДА не упоминай, что ты ИИ, ассистент, модель, нейросеть или голосовой помощник, и что текст сгенерирован. Ты — живой человек-ведущий.

Содержание: представься по имени ({dj['name']}), скажи что это ПРОМО.ФМ — платформа для артистов, и что в эфире играет музыка артистов платформы. Говори естественно и уверенно."""

    url = f"{WS_PROXY}?key={GEMINI_API_KEY}&proxy_key={GEMINI_PROXY_KEY}"

    try:
        async with websockets.connect(url, open_timeout=15) as ws:
            # Setup — system instruction + voice in setup
            setup = {
                "setup": {
                    "model": GEMINI_LIVE_MODEL,
                    "generationConfig": {
                        "responseModalities": ["AUDIO"],
                        "speechConfig": {
                            "voiceConfig": {
                                "prebuiltVoiceConfig": {"voiceName": dj["gemini_voice"]}
                            }
                        }
                    },
                    "systemInstruction": {
                        "parts": [{"text": (
                            f"Ты — {dj['full']}, живой радиоведущий ПРОМО.ФМ ({dj['style']}). "
                            "Ты ОЗВУЧИВАЕШЬ эфир: произноси только сам текст приветствия, который "
                            "слышат слушатели, и больше НИЧЕГО. Максимум 5 коротких предложений, "
                            "только утверждения. КАТЕГОРИЧЕСКИ запрещено: задавать любые вопросы, "
                            "спрашивать мнение, говорить «ну что», «как вам», «звучит убедительно», "
                            "«что-то добавить», «как тебе вариант»; комментировать свою речь или "
                            "обращаться к оператору/редактору; упоминать что ты ИИ, ассистент, "
                            "модель или голосовой помощник. Никто не должен понять, что это не "
                            "живой человек."
                        )}]
                    }
                }
            }
            await ws.send(json.dumps(setup))
            resp = await asyncio.wait_for(ws.recv(), timeout=10)
            data = json.loads(resp)

            if "setupComplete" not in data:
                logger.error(f"Setup failed: {data}")
                return None

            # 3.1 format: realtimeInput instead of clientContent
            msg = {"realtimeInput": {"text": prompt}}
            await ws.send(json.dumps(msg))

            # Collect audio chunks
            pcm_chunks = []
            while True:
                try:
                    resp = await asyncio.wait_for(ws.recv(), timeout=20)
                    data = json.loads(resp)

                    if "serverContent" in data:
                        sc = data["serverContent"]
                        if "modelTurn" in sc:
                            for part in sc["modelTurn"].get("parts", []):
                                inline = part.get("inlineData")
                                if inline and inline.get("data"):
                                    pcm_chunks.append(base64.b64decode(inline["data"]))

                        if sc.get("turnComplete"):
                            break
                    # 3.1: ignore sessionResumptionUpdate and other meta
                except asyncio.TimeoutError:
                    logger.warning("Timeout waiting for audio chunks")
                    break

            if not pcm_chunks:
                logger.error("No audio received from Live API")
                return None

            pcm_data = b"".join(pcm_chunks)
            logger.info(f"Live API OK: {dj['name']}, voice={dj['gemini_voice']}, "
                        f"{len(pcm_chunks)} chunks, {len(pcm_data)} bytes PCM")
            return pcm_data

    except Exception as e:
        logger.error(f"Live API error: {e}")
        return None


def resample_pcm(pcm_24k_mono: bytes) -> bytes | None:
    """PCM 24kHz mono → 44.1kHz stereo через FFmpeg, с нормализацией и фейдами."""
    cmd = [
        "ffmpeg", "-y",
        "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
        "-af", "loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:d=0.3,afade=t=out:st={:.1f}:d=0.5".format(
            max(0, len(pcm_24k_mono) / (24000 * 2) - 0.5)
        ),
        "-f", "s16le", "-ar", "44100", "-ac", "2",
        "pipe:1"
    ]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        stdout_data, _ = proc.communicate(input=pcm_24k_mono, timeout=30)
        if proc.returncode != 0 or not stdout_data:
            logger.error(f"FFmpeg resample failed (code {proc.returncode})")
            return None
        logger.info(f"Resampled: {len(pcm_24k_mono)} → {len(stdout_data)} bytes (44.1kHz stereo)")
        return stdout_data
    except subprocess.TimeoutExpired:
        proc.kill()
        logger.error("FFmpeg timeout")
        return None
    except Exception as e:
        logger.error(f"Resample error: {e}")
        return None


def generate_announcement_pcm() -> bytes | None:
    """Полный цикл: DJ → Live API → resample → PCM 44.1kHz stereo."""
    dj = random.choice(DJS)
    logger.info(f"Selected DJ: {dj['full']} ({dj['gender']}, voice={dj['gemini_voice']})")

    pcm_24k = asyncio.run(generate_audio_live(dj))
    if not pcm_24k:
        return None

    return resample_pcm(pcm_24k)


def pcm_to_fifo(pcm_44k_stereo: bytes) -> bool:
    """Пишет готовый PCM 44.1kHz stereo в FIFO (standalone режим)."""
    if not os.path.exists(FIFO_PATH):
        logger.error(f"FIFO not found: {FIFO_PATH}")
        return False
    try:
        with open(FIFO_PATH, 'wb') as fifo:
            fifo.write(pcm_44k_stereo)
        logger.info("Audio sent to FIFO")
        return True
    except Exception as e:
        logger.error(f"FIFO write error: {e}")
        return False


if __name__ == "__main__":
    logger.info("=== Promo.FM Radio Announcer (Gemini Live API) ===")
    pcm = generate_announcement_pcm()
    if pcm:
        # Standalone: пишем в FIFO
        if pcm_to_fifo(pcm):
            print("OK")
        else:
            sys.exit(1)
    else:
        logger.error("Announcement failed")
        sys.exit(1)
