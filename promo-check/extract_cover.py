#!/usr/bin/env python3
"""
extract_cover.py — Extract embedded cover art from audio file using mutagen.
Usage: python3 extract_cover.py --input /path/to/track.mp3 --output-dir /path/to/covers/ --base-url https://example.com/uploads/covers/
Output: JSON {"cover_url": "..."} or {"error": "..."}
"""
import sys
import os
import json
import hashlib
import argparse

def extract_cover(input_path: str, output_dir: str, base_url: str) -> dict:
    try:
        from mutagen.mp3 import MP3
        from mutagen.id3 import ID3, APIC
        from mutagen.flac import FLAC
        from mutagen.mp4 import MP4
        from mutagen.oggvorbis import OggVorbis
    except ImportError:
        return {"error": "mutagen not installed"}

    if not os.path.exists(input_path):
        return {"error": f"File not found: {input_path}"}

    os.makedirs(output_dir, exist_ok=True)
    cover_data = None
    mime_type = "image/jpeg"

    ext = os.path.splitext(input_path)[1].lower()

    try:
        if ext in ('.mp3',):
            try:
                tags = ID3(input_path)
                for key in tags.keys():
                    if key.startswith("APIC"):
                        apic = tags[key]
                        cover_data = apic.data
                        mime_type = apic.mime or "image/jpeg"
                        break
            except Exception:
                pass

        elif ext in ('.flac',):
            audio = FLAC(input_path)
            if audio.pictures:
                pic = audio.pictures[0]
                cover_data = pic.data
                mime_type = pic.mime or "image/jpeg"

        elif ext in ('.m4a', '.aac', '.mp4'):
            audio = MP4(input_path)
            if 'covr' in audio.tags:
                covr = audio.tags['covr'][0]
                cover_data = bytes(covr)
                mime_type = "image/jpeg"

        elif ext in ('.ogg',):
            # OGG stores covers as base64 in METADATA_BLOCK_PICTURE
            import base64, struct
            audio = OggVorbis(input_path)
            for pic_b64 in audio.get("metadata_block_picture", []):
                data = base64.b64decode(pic_b64)
                # Parse the block
                type_ = struct.unpack(">I", data[0:4])[0]
                mime_len = struct.unpack(">I", data[4:8])[0]
                mime_b = data[8:8+mime_len].decode("utf-8")
                desc_len = struct.unpack(">I", data[8+mime_len:12+mime_len])[0]
                offset = 12 + mime_len + desc_len + 16  # skip width,height,depth,colors
                img_len = struct.unpack(">I", data[offset:offset+4])[0]
                cover_data = data[offset+4:offset+4+img_len]
                mime_type = mime_b
                break

    except Exception as e:
        return {"error": f"Parse error: {e}"}

    if not cover_data:
        return {"error": "No cover art found in file"}

    # Determine file extension from mime
    img_ext = ".jpg"
    if "png" in mime_type:
        img_ext = ".png"
    elif "webp" in mime_type:
        img_ext = ".webp"

    # Unique filename from content hash
    content_hash = hashlib.md5(cover_data).hexdigest()[:8]
    base_name = os.path.splitext(os.path.basename(input_path))[0]
    # sanitize
    base_name = "".join(c if c.isalnum() or c in '-_' else '_' for c in base_name)[:40]
    filename = f"{base_name}_cover_{content_hash}{img_ext}"
    out_path = os.path.join(output_dir, filename)

    with open(out_path, "wb") as f:
        f.write(cover_data)

    cover_url = base_url.rstrip("/") + "/" + filename
    return {"cover_url": cover_url, "filename": filename, "size": len(cover_data)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract cover art from audio")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()

    result = extract_cover(args.input, args.output_dir, args.base_url)
    print(json.dumps(result))
