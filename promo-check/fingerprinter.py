"""
Promo.check — Fingerprinting + Watermarking
Uses: fpcalc (Chromaprint) + audiowmark
"""
import subprocess
import json
import secrets
import os
import shutil
import stat
import sys
import tempfile
import logging
import urllib.request
from urllib.parse import unquote
import argparse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [fingerprinter] %(message)s")
log = logging.getLogger(__name__)


def _find_bin(env_name: str, name: str) -> str:
    """Бинарник из переменной окружения, из PATH или из /usr/local/bin.
    Крон root запускает скрипты с PATH=/usr/bin:/bin, а audiowmark стоит в /usr/local/bin:
    с переезда на Арбат (07.10.2026) знак молча не встраивался, шёл fingerprint_only."""
    if os.environ.get(env_name):
        return os.environ[env_name]
    local = f"/usr/local/bin/{name}"
    return shutil.which(name) or (local if os.path.exists(local) else name)


AUDIOWMARK_BIN = _find_bin("AUDIOWMARK_BIN", "audiowmark")
FPCALC_BIN = _find_bin("FPCALC_BIN", "fpcalc")
UPLOADS_DIR = "/var/www/promofm/uploads"
EXISTING_WM_SCORE = 0.7   # шум audiowmark get даёт 0.3–0.4, настоящий знак в исходнике 1.0+


def fingerprint_file(filepath: str) -> dict:
    """Run fpcalc, return {duration: float, fingerprint: [int...]}"""
    result = subprocess.run(
        [FPCALC_BIN, "-raw", "-json", filepath],
        capture_output=True, text=True, timeout=60
    )
    # fpcalc 1.5.1 (FFmpeg 5) отдаёт код 3 «Error decoding audio frame (End of file)»
    # на файлах короче 120 с, хотя отпечаток в stdout корректный
    if result.returncode != 0:
        try:
            data = json.loads(result.stdout)
            if result.returncode == 3 and data.get("fingerprint"):
                return {"duration": data["duration"], "fingerprint": data["fingerprint"]}
        except Exception:
            pass
        raise RuntimeError(f"fpcalc failed: {result.stderr}")
    data = json.loads(result.stdout)
    return {"duration": data["duration"], "fingerprint": data["fingerprint"]}


def generate_watermark_id() -> str:
    """Generate 128-bit hex ID for audiowmark."""
    return secrets.token_hex(16)  # 32 hex chars = 128 bits


def audiowmark_available() -> bool:
    """Check if audiowmark binary is accessible."""
    try:
        result = subprocess.run([AUDIOWMARK_BIN, "--help"],
                                capture_output=True, timeout=5)
        return result.returncode in (0, 1)  # --help may return 1
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def add_watermark(src: str, dst: str, wm_id: str) -> bool:
    """Embed watermark into audio file via audiowmark."""
    result = subprocess.run(
        [AUDIOWMARK_BIN, "add", src, dst, wm_id],
        capture_output=True, timeout=180
    )
    if result.returncode != 0:
        log.warning(f"audiowmark add failed: {result.stderr.decode()[:200]}")
    return result.returncode == 0


def get_watermark(filepath: str) -> str | None:
    """Extract watermark ID from audio chunk. Returns hex ID or None."""
    try:
        result = subprocess.run(
            [AUDIOWMARK_BIN, "get", filepath],
            capture_output=True, text=True, timeout=90
        )
        # Output format: "pattern 0000 <hex_id> <confidence>\n..."
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("pattern"):
                parts = line.split()
                if len(parts) >= 3:
                    return parts[2]
    except Exception as e:
        log.debug(f"audiowmark get error: {e}")
    return None


def hamming_distance_aligned(chunk: list, full: list) -> float:
    """
    Sliding-window Hamming distance: find the best alignment of chunk
    within the full track fingerprint. Returns minimum BER found.
    """
    if not chunk or not full:
        return 1.0
    chunk_len = len(chunk)
    full_len = len(full)
    if chunk_len >= full_len:
        # Chunk is longer or equal — compare directly
        n = min(chunk_len, full_len)
        errors = sum(bin(x ^ y).count("1") for x, y in zip(chunk[:n], full[:n]))
        return errors / (n * 32)
    # Slide chunk over full track, step by step
    best_ber = 1.0
    step = max(1, chunk_len // 4)  # slide in quarter-chunk steps for speed
    for offset in range(0, full_len - chunk_len + 1, step):
        window = full[offset:offset + chunk_len]
        errors = sum(bin(x ^ y).count("1") for x, y in zip(chunk, window))
        ber = errors / (chunk_len * 32)
        if ber < best_ber:
            best_ber = ber
    return best_ber


def match_fingerprint(fp: list, db_rows: list, threshold: float = 0.35) -> dict | None:
    """Find best Chromaprint match using sliding window. Returns {track_id, watermark_id, confidence} or None."""
    best = None
    best_dist = threshold
    for row in db_rows:
        stored = row["fingerprint"]
        if not stored:
            continue
        dist = hamming_distance_aligned(fp, stored)
        if dist < best_dist:
            best_dist = dist
            best = {
                "track_id": str(row["track_id"]),
                "watermark_id": row["watermark_id"],
                "confidence": round(1.0 - dist, 3),
            }
    return best


def resolve_audio_path(audio_url: str) -> tuple[str | None, str | None]:
    """
    Convert audio_url to (local_path, upload_path).
    local_path: file to process (may be temp download)
    upload_path: permanent upload file to replace with watermarked version (or None)
    """
    if not audio_url:
        return None, None
    # Local path via uploads dir. Two roots on prod:
    #   /uploads/...         -> /var/www/promofm/uploads/...
    #   /server/uploads/...  -> /opt/promofm-api/uploads/... (nginx alias)
    UPLOAD_ROOTS = [
        ("/server/uploads/", "/opt/promofm-api/uploads"),
        ("/uploads/",         "/var/www/promofm/uploads"),
    ]
    for prefix, root in UPLOAD_ROOTS:
        if audio_url.startswith(prefix):
            rel = unquote(audio_url[len(prefix):])  # URL-decode %20 -> space
            local = os.path.join(root, rel)
            if os.path.exists(local):
                return local, local
    # HTTP URL — check if it maps to local uploads
    if audio_url.startswith("http"):
        # Try to extract path and map to local uploads
        for marker in ["/uploads/", "/server/uploads/"]:
            idx = audio_url.find(marker)
            if idx >= 0:
                rel = unquote(audio_url[idx + len(marker):])  # URL-decode %20 -> space
                local = os.path.join(UPLOADS_DIR, rel)
                if os.path.exists(local):
                    log.info(f"Resolved URL to local file: {local}")
                    return local, local
        # Download to temp
        tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        try:
            urllib.request.urlretrieve(audio_url, tmp.name)
            return tmp.name, None  # no permanent path to update
        except Exception as e:
            log.error(f"Failed to download {audio_url}: {e}")
            try:
                os.unlink(tmp.name)
            except Exception:
                pass
    return None, None


def existing_watermark(filepath: str, score_min: float = EXISTING_WM_SCORE):
    """Знак, уже вшитый в файл: (hex_id, score) с лучшим score >= score_min или None.
    Смотрим первые 90 с. Нужно, чтобы не наложить второй знак поверх старого и не потерять id,
    который уже ловится в эфире; и чтобы проверить свежевшитый знак перед заменой файла."""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    try:
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", filepath, "-t", "90",
                            "-ac", "2", "-ar", "44100", tmp.name], capture_output=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError(f"ffmpeg excerpt failed: {r.stderr.decode()[:200]}")
        res = subprocess.run([AUDIOWMARK_BIN, "get", tmp.name], capture_output=True, text=True, timeout=180)
        best = None
        for line in res.stdout.splitlines():
            p = line.strip().split()
            if len(p) >= 4 and p[0] == "pattern":
                try:
                    score = float(p[3])
                except ValueError:
                    continue
                if score >= score_min and (best is None or score > best[1]):
                    best = (p[2], score)
        return best
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def _probe_audio(path: str):
    """(codec_name, bit_rate) первой аудиодорожки."""
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0",
                        "-show_entries", "stream=codec_name,bit_rate:format=bit_rate", "-of", "json", path],
                       capture_output=True, text=True, timeout=30)
    d = json.loads(r.stdout or "{}")
    s = (d.get("streams") or [{}])[0]
    br = s.get("bit_rate") or (d.get("format") or {}).get("bit_rate") or 0
    return s.get("codec_name"), int(br)


def encode_like(wm_wav: str, original: str, dst: str) -> bool:
    """audiowmark всегда пишет WAV. Возвращаем исходный формат (теги и обложку берём из оригинала):
    иначе в файле .mp3 оказывался WAV в 10 раз больше — так было со всеми треками, помеченными
    на старом сервере. Знак переживает MP3 128k (score ~1.2), поэтому MP3 не ниже 192k.
    False = формат не поддержан, оставляем WAV как раньше."""
    codec, br = _probe_audio(original)
    if codec == "mp3":
        kbps = min(320, max(192, round(br / 1000))) if br else 320
        enc = ["-map", "1:v?", "-c:v", "copy", "-c:a", "libmp3lame", "-b:a", f"{kbps}k",
               "-id3v2_version", "3", "-f", "mp3"]
    elif codec in ("pcm_s16le", "pcm_s24le"):
        enc = ["-c:a", codec, "-f", "wav"]
    elif codec == "flac":
        enc = ["-c:a", "flac", "-f", "flac"]
    else:
        return False
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wm_wav, "-i", original,
                        "-map", "0:a:0", "-map_metadata", "1"] + enc + [dst],
                       capture_output=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg re-encode failed: {r.stderr.decode()[:300]}")
    return True


def _process(content_id, audio_url, save_fn, id_key, label, current_wm_id=None):
    """Общий конвейер watermark+fingerprint. save_fn(id, fingerprint, wm_id, duration, watermarked=).
    Знак вшивается в сам аудиофайл, который отдаётся станциям (os.replace). Правки 23.10.2026:
    - пишем в настоящий файл (realpath): у части треков путь загрузки = симлинк на файл эфира
      в /mnt/data, прежний os.replace подменял симлинк отдельной копией от root;
    - владелец и права исходника сохраняются;
    - если файл уже несёт знак, второй не накладываем (id из БД — только отмечаем дату);
    - свежий знак проверяется чтением ДО замены файла;
    - если знак вшить нельзя (нет audiowmark, нет локального файла, ошибка) — выходим с ошибкой
      и ничего не пишем в БД: раньше сохранялся случайный watermark_id, которого нет ни в одном файле."""
    src_path, upload_path = resolve_audio_path(audio_url)
    if not src_path:
        raise RuntimeError(f"Cannot resolve audio file for {label} {content_id} url={audio_url}")
    if not upload_path:
        # файл только скачан во временный: вшить знак в отдаваемый станциям файл нельзя
        if src_path.startswith(tempfile.gettempdir()) and os.path.exists(src_path):
            os.unlink(src_path)
        raise RuntimeError(f"No local file for {label} {content_id} (url={audio_url}): watermark not embedded")
    if not audiowmark_available():
        raise RuntimeError(f"audiowmark not available ({AUDIOWMARK_BIN}): watermark not embedded for {label} {content_id}")

    target = os.path.realpath(upload_path)
    st = os.stat(target)

    found = existing_watermark(target)
    if found:
        wid, score = found
        if current_wm_id and wid == current_wm_id:
            fp_data = fingerprint_file(target)
            save_fn(content_id, fp_data["fingerprint"], wid, fp_data["duration"], watermarked=True)
            log.info(f"{label} {content_id}: file already carries its watermark {wid} (score {score:.2f}), recorded")
            return {id_key: content_id, "watermark_id": wid, "duration": fp_data["duration"],
                    "fingerprint_len": len(fp_data["fingerprint"]), "method": "existing-watermark"}
        raise RuntimeError(f"{label} {content_id}: file {target} already carries watermark {wid} "
                           f"(score {score:.2f}), DB has {current_wm_id}; not re-embedding, needs manual check")

    wm_id = generate_watermark_id()
    ext = os.path.splitext(target)[1] or ".mp3"
    # временные файлы рядом с настоящим (та же ФС для атомарного replace), скрытые от сканеров эфира
    base = os.path.join(os.path.dirname(target), f".{os.path.basename(target)}")
    wm_wav = base + ".wm.wav"          # то, что пишет audiowmark (всегда WAV)
    wm_dst = base + ".wmenc" + ext     # тот же формат, что у оригинала
    try:
        if not add_watermark(target, wm_wav, wm_id):
            raise RuntimeError(f"audiowmark add failed for {label} {content_id}")
        if encode_like(wm_wav, target, wm_dst):
            os.unlink(wm_wav)
        else:
            log.warning(f"{label} {content_id}: format of {target} not re-encodable, keeping WAV data as before")
            os.replace(wm_wav, wm_dst)
        check = existing_watermark(wm_dst)
        if not check or check[0] != wm_id:
            raise RuntimeError(f"watermark verification failed for {label} {content_id}: read {check}, expected {wm_id}")
        os.chown(wm_dst, st.st_uid, st.st_gid)
        os.chmod(wm_dst, stat.S_IMODE(st.st_mode))
        os.replace(wm_dst, target)
    except Exception:
        for p in (wm_wav, wm_dst):
            if os.path.exists(p):
                os.unlink(p)
        raise
    log.info(f"Watermark {wm_id} embedded and verified (score {check[1]:.2f}) for {label} {content_id}: {target}")

    fp_data = fingerprint_file(target)
    save_fn(content_id, fp_data["fingerprint"], wm_id, fp_data["duration"], watermarked=True)
    log.info(f"{label} {content_id} processed: duration={fp_data['duration']:.1f}s "
             f"fp_len={len(fp_data['fingerprint'])} method=fingerprint+watermark")
    return {
        id_key: content_id,
        "watermark_id": wm_id,
        "duration": fp_data["duration"],
        "fingerprint_len": len(fp_data["fingerprint"]),
        "method": "fingerprint+watermark",
    }


def process_track(track_id, audio_url):
    """Back-compat обёртка — прежний контракт (ключ track_id)."""
    from db import save_fingerprint, get_current_watermark_id
    return _process(track_id, audio_url, save_fingerprint, "track_id", "track",
                    current_wm_id=get_current_watermark_id("promo_check_fingerprints", "track_id", track_id))


def process_mix(mix_id, audio_url):
    """DJ-микс -> dj_mix_fingerprints (миграция 132 + db.save_mix_fingerprint)."""
    from db import save_mix_fingerprint, get_current_watermark_id
    return _process(mix_id, audio_url, save_mix_fingerprint, "mix_id", "mix",
                    current_wm_id=get_current_watermark_id("dj_mix_fingerprints", "mix_id", mix_id))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Promo.check fingerprinter")
    g = parser.add_mutually_exclusive_group(required=True)   # ровно один из --track-id / --mix-id
    g.add_argument("--track-id")
    g.add_argument("--mix-id")
    parser.add_argument("--audio-url", required=False)
    parser.add_argument("--mode", choices=["process"], default="process")
    args = parser.parse_args()

    if args.mode == "process":
        if args.mix_id:
            from db import get_mix_audio_url
            url = args.audio_url or get_mix_audio_url(args.mix_id)
            if not url:
                log.error(f"No audio_url found for mix {args.mix_id}")
                sys.exit(1)
            print(json.dumps(process_mix(args.mix_id, url)))
        else:
            from db import get_track_audio_url
            url = args.audio_url or get_track_audio_url(args.track_id)
            if not url:
                log.error(f"No audio_url found for track {args.track_id}")
                sys.exit(1)
            print(json.dumps(process_track(args.track_id, url)))


def get_watermark_matches(filepath: str, known_wm_map: dict, score_min: float = 0.5) -> list:
    """Independent watermark detection. Runs `audiowmark get`; returns [(track_id, score)]
    for patterns whose hex id is a KNOWN embedded watermark (present in known_wm_map) and
    whose sync score >= score_min. Noise patterns carry random ids absent from the DB and
    are filtered out. Survives the radio air chain (loudnorm/re-encode) that breaks Chromaprint."""
    out = []
    try:
        result = subprocess.run([AUDIOWMARK_BIN, "get", filepath],
                                capture_output=True, text=True, timeout=90)
        for line in result.stdout.splitlines():
            p = line.strip().split()
            if len(p) >= 4 and p[0] == "pattern":
                wid = p[2]
                try:
                    score = float(p[3])
                except Exception:
                    score = 0.0
                if score >= score_min and wid in known_wm_map:
                    out.append((known_wm_map[wid], score))
    except Exception as e:
        log.debug(f"get_watermark_matches error: {e}")
    return out
