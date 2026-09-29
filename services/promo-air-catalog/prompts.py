#!/usr/bin/env python3
"""Матрица описаний для фонового каталога ПРОМО.ЭИР (27.09.2026).

11 форматов × 100 описаний × 20 вариаций (разный seed и длина) = 22 000 заданий.
Описания детерминированные: один и тот же запуск даёт тот же список, поэтому
у каждого трека есть воспроизводимый провенанс (id, промпт, seed).

  python3 prompts.py --per-genre 100 --variations 20 --model sa3-medium > tasks.jsonl   # весь каталог
  python3 prompts.py --per-genre 10  --variations 10 --model sa3-medium > pilot_sa3.jsonl  # пилот
"""
import argparse
import hashlib
import itertools
import json
import random
import sys

NEGATIVE = ("vocals, singing, voice, lyrics, speech, choir, rap, distortion, noise, clipping, "
            "low quality, lo-fi hiss, abrupt ending, harsh high frequencies, muddy mix, mono, "
            "amateur, out of tune, glitches, artifacts, repetitive loop, sudden cuts, low bitrate")

TEXTURES = [
    "spacious and smooth", "gentle steady groove", "soft dynamics", "warm analog feel",
    "clean modern production", "subtle evolving layers", "intimate and cozy", "airy and bright",
]

GENRES = {
    "lounge": dict(
        styles=["smooth lounge", "nu-jazz lounge", "downtempo lounge", "chill lounge house", "bossa lounge"],
        moods=["relaxed", "sophisticated", "warm", "late-night", "sunset"],
        instruments=["Rhodes electric piano and soft bass", "vibraphone and brushed drums", "muted trumpet and warm pads",
                     "nylon guitar and shaker", "smooth saxophone and upright bass"],
        settings=["cocktail bar", "rooftop terrace", "hotel lobby lounge", "evening lounge"],
        bpm=(90, 110), duration=(170, 240)),
    "cafe": dict(
        styles=["acoustic cafe", "bossa nova", "light jazz", "indie folk instrumental", "french cafe musette"],
        moods=["cozy", "cheerful", "calm morning", "sunny", "friendly"],
        instruments=["acoustic guitar and piano", "upright bass and brushed snare", "ukulele and glockenspiel",
                     "accordion and nylon guitar", "piano trio"],
        settings=["coffee shop", "bakery cafe", "street cafe", "breakfast cafe"],
        bpm=(80, 110), duration=(150, 220)),
    "deep-house": dict(
        styles=["deep house", "melodic deep house", "soulful deep house", "lounge deep house", "organic house"],
        moods=["warm", "hypnotic", "elegant", "groovy", "late-night"],
        instruments=["deep chords and sub bass", "warm pads and shuffled hi-hats", "Rhodes stabs and rolling bassline",
                     "plucked synths and soft kick", "organic percussion and bass"],
        settings=["stylish bar", "boutique store", "beach club", "evening restaurant"],
        bpm=(118, 124), duration=(200, 300)),
    "chillout": dict(
        styles=["chillout", "downtempo", "ambient chill", "balearic chill", "trip-hop instrumental"],
        moods=["dreamy", "laid-back", "mellow", "sunset", "calm"],
        instruments=["soft pads and mellow beats", "ambient guitars and warm bass", "electric piano and vinyl texture",
                     "flute and gentle percussion", "synth textures and slow groove"],
        settings=["lounge area", "terrace", "chill zone", "beach bar"],
        bpm=(80, 100), duration=(180, 260)),
    "sport": dict(
        styles=["energetic electronic", "sport rock instrumental", "electro pop instrumental", "big beat", "upbeat funk rock"],
        moods=["energetic", "motivating", "powerful", "driving", "confident"],
        instruments=["driving drums and electric guitars", "punchy synth bass and claps", "brass stabs and funky bass",
                     "arpeggiated synths and big drums", "distorted bass and snare rolls"],
        settings=["sports store", "stadium bar", "sports club", "sneaker shop"],
        bpm=(125, 140), duration=(150, 210)),
    "workout": dict(
        styles=["workout EDM", "high-energy electro house", "drum and bass", "tech house", "power synthwave"],
        moods=["intense", "pumping", "high-energy", "relentless", "uplifting"],
        instruments=["pounding kick and saw synths", "fast breakbeats and reese bass", "rolling bassline and hi-hats",
                     "big synth leads and risers", "punchy drums and pulsing bass"],
        settings=["gym", "fitness studio", "cycling class", "crossfit box"],
        bpm=(128, 150), duration=(150, 210)),
    "meditation": dict(
        styles=["meditation ambient", "drone ambient", "tibetan bowls ambient", "healing soundscape", "slow piano ambient"],
        moods=["peaceful", "serene", "deeply calm", "grounding", "contemplative"],
        instruments=["singing bowls and soft drones", "warm pads and gentle chimes", "soft piano and long reverb",
                     "handpan and airy textures", "low strings and bells"],
        settings=["meditation room", "yoga studio", "relaxation space", "quiet retreat"],
        bpm=(50, 70), duration=(240, 360)),
    "focus": dict(
        styles=["minimal piano", "lo-fi instrumental", "ambient electronica", "modern classical", "study beats"],
        moods=["focused", "steady", "clear", "calm", "unobtrusive"],
        instruments=["felt piano and soft pads", "mellow beats and electric piano", "pulsing synths and light percussion",
                     "string quartet and piano", "guitar harmonics and soft keys"],
        settings=["coworking space", "office", "library cafe", "workspace"],
        bpm=(70, 90), duration=(180, 260)),
    "restaurant": dict(
        styles=["jazz trio", "bossa nova", "soft soul instrumental", "italian dinner jazz", "classical crossover"],
        moods=["elegant", "romantic", "warm", "refined", "intimate"],
        instruments=["piano, upright bass and brushed drums", "nylon guitar and soft percussion", "strings and piano",
                     "saxophone and piano", "mandolin and acoustic guitar"],
        settings=["fine dining restaurant", "family restaurant", "wine bar", "dinner terrace"],
        bpm=(70, 100), duration=(170, 240)),
    "hotel": dict(
        styles=["elegant lounge", "nu-jazz", "modern classical", "chill house", "sophisticated downtempo"],
        moods=["luxurious", "welcoming", "calm", "polished", "graceful"],
        instruments=["grand piano and soft strings", "Rhodes and deep bass", "harp and gentle pads",
                     "acoustic guitar and light percussion", "cello and piano"],
        settings=["hotel lobby", "hotel restaurant", "boutique hotel", "reception area"],
        bpm=(90, 115), duration=(180, 260)),
    "spa": dict(
        styles=["spa ambient", "new age", "zen ambient", "soft piano ambient", "nature-inspired ambient"],
        moods=["soothing", "tranquil", "gentle", "restorative", "weightless"],
        instruments=["harp and soft pads", "bamboo flute and chimes", "soft piano and airy synths",
                     "koto and gentle drones", "warm strings and bells"],
        settings=["spa", "massage room", "wellness center", "beauty salon"],
        bpm=(60, 80), duration=(240, 360)),
}


def stable_int(*parts) -> int:
    return int(hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:12], 16)


def genre_prompts(genre: str, n: int) -> list:
    g = GENRES[genre]
    combos = list(itertools.product(g["styles"], g["moods"], g["instruments"], g["settings"], TEXTURES))
    rnd = random.Random(stable_int("prompts", genre))
    rnd.shuffle(combos)
    out = []
    for i, (style, mood, inst, setting, texture) in enumerate(combos[:n]):
        bpm = rnd.randint(*g["bpm"])
        out.append({
            "prompt_id": f"{genre}-p{i:03d}",
            "prompt": f"{mood} {style} instrumental for a {setting}, {inst}, {texture}, {bpm} BPM, "
                      f"full arrangement with intro, gradual development and smooth outro, high-fidelity professional studio recording, "
                      f"rich wide stereo mix, clear detailed instruments, no vocals",
            "bpm": bpm,
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-genre", type=int, default=100)
    ap.add_argument("--variations", type=int, default=20)
    ap.add_argument("--model", default="sa3-medium")
    ap.add_argument("--genres", default=",".join(GENRES))
    a = ap.parse_args()
    for genre in a.genres.split(","):
        lo, hi = GENRES[genre]["duration"]
        for p in genre_prompts(genre, a.per_genre):
            for v in range(a.variations):
                seed = stable_int(p["prompt_id"], v) % 2_000_000_000
                rnd = random.Random(seed)
                task = {
                    "id": f"{p['prompt_id']}-v{v:02d}-{a.model}",
                    "genre": genre, "prompt_id": p["prompt_id"], "variation": v,
                    "prompt": p["prompt"], "negative_prompt": NEGATIVE, "bpm": p["bpm"],
                    "duration": rnd.randint(lo, hi), "seed": seed, "model": a.model,
                }
                sys.stdout.write(json.dumps(task, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
