#!/usr/bin/env python3
"""
promo.fm DJ Oracle
Smart track rotation based on Camelot wheel, energy curves, separation rules.
Adapted from Soul FM DJ Den Oracle for promo-music.ru/air/
"""

import os
import json
import random
import datetime
import logging
import re
import requests

logging.basicConfig(level=logging.INFO, format='%(asctime)s [Oracle] %(message)s')
logger = logging.getLogger(__name__)

# ─── Config ───
MUSIC_DIR = "/mnt/data/promofm-music/tracks"
METADATA_FILE = "/opt/promofm-autodj/metadata.json"
HISTORY_FILE = "/opt/promofm-autodj/play_history.json"
ANALYTICS_FILE = "/opt/promofm-autodj/analytics.json"
STATUS_URL = "http://127.0.0.1:8086/status"

# ─── Separation Rules ───
TRACK_REPEAT_HOURS = 48
ARTIST_REPEAT_HOURS = 8
MAX_SAME_REGION_CONSECUTIVE = 2
MAX_SAME_FOLDER_CONSECUTIVE = 3
MAX_VOCAL_CONSECUTIVE = 3


def normalize_artist(name: str) -> str:
    if not name:
        return "Unknown"
    name = re.sub(r'^[0-9]+[\.\s\-_]+', '', name)
    return name.strip()


# ─── Energy Curve (0-10, Moscow time UTC+3) ───
ENERGY_TARGETS = {
    0: 2, 1: 2, 2: 2, 3: 2, 4: 3, 5: 3,
    6: 4, 7: 5, 8: 6, 9: 7, 10: 7, 11: 7,
    12: 6, 13: 7, 14: 7, 15: 7, 16: 8, 17: 8,
    18: 7, 19: 7, 20: 6, 21: 5, 22: 4, 23: 3,
}

# ─── Modes ───
MODE_STANDARD = "standard"
MODE_NIGHT = "night"
MODE_DRIVE = "drive"
MODE_EMERGENCY = "emergency"


def camelot_compatible(key1, key2):
    """Check if two Camelot keys are harmonically compatible"""
    if not key1 or not key2:
        return False
    try:
        num1, letter1 = int(key1[:-1]), key1[-1]
        num2, letter2 = int(key2[:-1]), key2[-1]
    except (ValueError, IndexError):
        return False
    if num1 == num2:
        return True
    if letter1 == letter2:
        diff = abs(num1 - num2)
        if diff == 1 or diff == 11:
            return True
    return False


class PlayHistory:
    def __init__(self):
        self.history = []
        self.load()

    def load(self):
        try:
            if os.path.exists(HISTORY_FILE):
                with open(HISTORY_FILE, 'r') as f:
                    self.history = json.load(f)
        except Exception:
            self.history = []

    def save(self):
        os.makedirs(os.path.dirname(HISTORY_FILE), exist_ok=True)
        self.history = self.history[-2000:]
        with open(HISTORY_FILE, 'w') as f:
            json.dump(self.history, f, indent=2, ensure_ascii=False)

    def add(self, track_meta):
        entry = {
            "file": track_meta.get("file"),
            "artist": track_meta.get("artist", "Unknown"),
            "genre": track_meta.get("genre", "Unknown"),
            "region": track_meta.get("region", "Global"),
            "energy": track_meta.get("energy", 5),
            "bpm": track_meta.get("bpm"),
            "key": track_meta.get("key"),
            "timestamp": datetime.datetime.now().isoformat(),
        }
        self.history.append(entry)
        self.save()

    def recent_tracks(self, hours=4):
        cutoff = datetime.datetime.now() - datetime.timedelta(hours=hours)
        # Defensive: history entries may carry 'timestamp' (canonical, from
        # add()) OR 'played_at' (from dj.py's batch pre-record), and some may
        # lack either / be malformed. A single bad entry used to raise
        # KeyError 'timestamp' and drop the WHOLE pick to shuffle — coalesce
        # the key and skip unparseable rows.
        out = []
        for h in self.history:
            ts = h.get('timestamp') or h.get('played_at')
            if not ts:
                continue
            try:
                if datetime.datetime.fromisoformat(ts) > cutoff:
                    out.append(h)
            except (ValueError, TypeError):
                continue
        return out

    def recent_artists(self, hours=2):
        return {normalize_artist(h['artist']) for h in self.recent_tracks(hours)}

    def last_n(self, n=5):
        return self.history[-n:] if len(self.history) >= n else self.history

    def consecutive_region_count(self):
        if not self.history:
            return 0, None
        last_region = self.history[-1].get('region', 'Global')
        count = 0
        for h in reversed(self.history):
            if h.get('region') == last_region:
                count += 1
            else:
                break
        return count, last_region

    def consecutive_folder_count(self):
        if not self.history:
            return 0, None
        last_file = self.history[-1].get('file', '')
        last_folder = os.path.dirname(last_file)
        count = 0
        for h in reversed(self.history):
            if os.path.dirname(h.get('file', '')) == last_folder:
                count += 1
            else:
                break
        return count, last_folder

    def average_energy(self, minutes=15):
        cutoff = datetime.datetime.now() - datetime.timedelta(minutes=minutes)
        # Same defensive read as recent_tracks: tolerate 'timestamp'/'played_at'
        # and skip malformed rows instead of crashing the pick.
        recent = []
        for h in self.history:
            ts = h.get('timestamp') or h.get('played_at')
            if not ts:
                continue
            try:
                if datetime.datetime.fromisoformat(ts) > cutoff and h.get('energy') is not None:
                    recent.append(h['energy'])
            except (ValueError, TypeError):
                continue
        if not recent:
            return 5.0
        return sum(recent) / len(recent)


class DJOracle:
    def __init__(self):
        self.metadata = self._load_metadata()
        self.history = PlayHistory()
        self.manual_mode = None
        self.mode = MODE_STANDARD
        self._update_mode()

    def _load_metadata(self):
        try:
            with open(METADATA_FILE, 'r') as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Cannot load metadata: {e}")
            return {"tracks": []}

    def reload_metadata(self):
        self.metadata = self._load_metadata()

    def _get_moscow_hour(self):
        """Get current hour in Moscow timezone (UTC+3)"""
        utc_now = datetime.datetime.utcnow()
        msk = utc_now + datetime.timedelta(hours=3)
        return msk.hour

    def _update_mode(self):
        if self.manual_mode:
            self.mode = self.manual_mode
            return
        hour = self._get_moscow_hour()
        if 0 <= hour < 6:
            self.mode = MODE_NIGHT
        elif 7 <= hour < 10 or 16 <= hour < 20:
            self.mode = MODE_DRIVE
        else:
            self.mode = MODE_STANDARD

    def get_listeners_count(self):
        try:
            res = requests.get(STATUS_URL, timeout=2)
            if res.status_code == 200:
                data = res.json()
                mounts = data.get('mounts', [])
                total = 0
                for mount in mounts:
                    total += mount.get('meta', {}).get('listeners', 0)
                return total
        except Exception:
            pass
        return 0

    def get_target_energy(self):
        hour = self._get_moscow_hour()
        target = ENERGY_TARGETS.get(hour, 5)

        # Dynamic scaling by listener count
        listeners = self.get_listeners_count()
        if listeners >= 5:
            bonus = min(2, listeners // 5)
            target += bonus
            logger.info(f"Dynamic Energy: +{bonus} (Listeners: {listeners})")

        if self.mode == MODE_NIGHT:
            target = min(target, 4)
        elif self.mode == MODE_DRIVE:
            target = max(target, 7)

        return min(10, target)

    def pick_next_track(self, current_track=None):
        self._update_mode()
        tracks = self.metadata.get('tracks', [])
        if not tracks:
            logger.warning("No tracks in metadata!")
            return None

        candidates = list(tracks)

        # Separation: exclude recently played tracks
        recent_files = {h['file'] for h in self.history.recent_tracks(TRACK_REPEAT_HOURS)}
        candidates = [t for t in candidates if t['file'] not in recent_files]

        # Separation: exclude recently played artists
        recent_artists = self.history.recent_artists(ARTIST_REPEAT_HOURS)
        candidates = [t for t in candidates
                      if normalize_artist(t.get('artist')) not in recent_artists
                      or normalize_artist(t.get('artist')) == 'Unknown']

        # Region diversity
        region_count, last_region = self.history.consecutive_region_count()
        if region_count >= MAX_SAME_REGION_CONSECUTIVE and last_region:
            preferred = [t for t in candidates if t.get('region') != last_region]
            if preferred:
                candidates = preferred

        # Folder diversity
        folder_count, last_folder = self.history.consecutive_folder_count()
        if folder_count >= MAX_SAME_FOLDER_CONSECUTIVE and last_folder:
            preferred = [t for t in candidates if os.path.dirname(t.get('file', '')) != last_folder]
            if preferred:
                candidates = preferred

        # Relax — мягко: треки всё равно не должны повторяться часто
        if len(candidates) < 5:
            # Сохраняем track-repeat (recent_files), релаксируем ТОЛЬКО artist-repeat
            recent_4h_artists = self.history.recent_artists(4)
            candidates = [t for t in tracks
                          if t['file'] not in recent_files
                          and normalize_artist(t.get('artist')) not in recent_4h_artists]
        if len(candidates) < 3:
            # Последний крайний случай — не повторять только последние 12ч
            very_recent_files = {h['file'] for h in self.history.recent_tracks(12)}
            candidates = [t for t in tracks if t['file'] not in very_recent_files]
        if len(candidates) < 1:
            # Если уж совсем никак — только last hour
            last_hour_files = {h['file'] for h in self.history.recent_tracks(1)}
            candidates = [t for t in tracks if t['file'] not in last_hour_files]
        if len(candidates) < 1:
            # Ну ОЧЕНЬ маленькая библиотека — берём всё кроме сейчас играющего
            last_file = self.history.history[-1].get('file', '') if self.history.history else ''
            candidates = [t for t in tracks if t['file'] != last_file]

        # Scoring
        target_energy = self.get_target_energy()
        current_avg = self.history.average_energy(15)
        last_tracks = self.history.last_n(3)
        last_key = last_tracks[-1].get('key') if last_tracks else None
        last_bpm = last_tracks[-1].get('bpm') if last_tracks else None

        scored = []
        for track in candidates:
            score = 100

            # Freshness bonus
            played_count = sum(1 for h in self.history.history if h['file'] == track['file'])
            if played_count == 0:
                score += 50
            elif played_count == 1:
                score += 25

            # Friday-release / new arrival BOOST (last 7 days → +100, last 14 → +50)
            track_date = track.get('date')
            if track_date:
                try:
                    import datetime as _dt
                    if isinstance(track_date, str):
                        d = _dt.datetime.fromisoformat(track_date.replace('Z','').split('T')[0]).date()
                    else:
                        d = track_date
                    days_old = (_dt.date.today() - d).days
                    if days_old <= 7:
                        score += 100  # свежак — гарантированно в ротации
                    elif days_old <= 14:
                        score += 50
                    elif days_old <= 30:
                        score += 20
                except Exception:
                    pass
            elif played_count >= 3:
                score -= 15

            # Long-term artist diversity
            long_recent = self.history.recent_artists(12)
            if normalize_artist(track.get('artist')) not in long_recent:
                score += 15

            # Energy matching — metadata may store energy as null; dict.get's
            # default fills only a MISSING key, NOT an explicit None, so a null
            # energy returned None and crashed `None - target_energy`, which
            # threw out of pick_next_track and dropped the WHOLE air to dumb
            # shuffle (silent эфир when no files / every pick). Coalesce → 5.
            track_energy = track.get('energy')
            if track_energy is None:
                track_energy = 5
            energy_diff = abs(track_energy - target_energy)
            if current_avg < target_energy - 1:
                if track_energy > current_avg:
                    score += 15
            elif current_avg > target_energy + 1:
                if track_energy < current_avg:
                    score += 15
            if energy_diff <= 1:
                score += 20
            elif energy_diff <= 2:
                score += 10
            elif energy_diff > 4:
                score -= 20

            # Camelot harmonic compatibility
            if last_key and track.get('key'):
                if camelot_compatible(last_key, track['key']):
                    score += 25

            # BPM proximity
            if last_bpm and track.get('bpm'):
                bpm_diff = abs(last_bpm - track['bpm'])
                if bpm_diff <= 3:
                    score += 20
                elif bpm_diff <= 5:
                    score += 10
                elif bpm_diff > 15:
                    score -= 10

            # Genre diversity
            recent_genres = [h.get('genre') for h in last_tracks]
            if track.get('genre') not in recent_genres:
                score += 5

            # Mode-specific boosts
            if self.mode == MODE_NIGHT:
                if (track.get('duration') or 0) > 300:
                    score += 5
                if track_energy <= 4:
                    score += 10
            elif self.mode == MODE_DRIVE:
                if track_energy >= 6:
                    score += 10
                if track.get('bpm') and track['bpm'] >= 115:
                    score += 5

            # Random variance
            score += random.randint(-10, 10)
            scored.append((score, track))

        scored.sort(key=lambda x: x[0], reverse=True)
        top_n = min(3, len(scored))
        if top_n == 0:
            return None

        winner_score, winner = random.choice(scored[:top_n])
        logger.info(
            f"Selected: {winner.get('filename', winner.get('file'))} "
            f"(score={winner_score}, energy={winner.get('energy')}, mode={self.mode})"
        )
        return winner

    def record_play(self, track_meta):
        self.history.add(track_meta)

    def get_stats(self):
        hour = self._get_moscow_hour()
        return {
            "mode": self.mode,
            "target_energy": self.get_target_energy(),
            "listeners": self.get_listeners_count(),
            "current_avg_energy": round(self.history.average_energy(15), 1),
            "tracks_in_library": len(self.metadata.get('tracks', [])),
            "tracks_played_today": len(self.history.recent_tracks(24)),
            "hour_msk": hour,
        }


if __name__ == "__main__":
    oracle = DJOracle()
    print(json.dumps(oracle.get_stats(), indent=2))
