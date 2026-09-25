"""Capture a private native TUI's actual PTY cells; requires pyte and Pillow."""

import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

import pyte
from PIL import Image, ImageDraw, ImageFont

project, server, session, label, destination = sys.argv[1:]
out = Path(destination)
out.mkdir(parents=True, exist_ok=True)
for width in (130, 180):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 70, width, 0, 0))
    process = subprocess.Popen(
        [
            os.environ.get("OPENCODE_TEST_BINARY", "opencode"),
            project,
            "--server",
            server,
            "--session",
            session,
        ],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        env={
            **os.environ,
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "AGENT_ROUTER_TUI_DEBUG": str(out / f"{label}-debug.log"),
        },
    )
    os.close(slave)
    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ)
    screen = pyte.Screen(width, 70)
    stream = pyte.ByteStream(screen)
    raw = bytearray()
    try:
        end = time.monotonic() + 10
        while time.monotonic() < end and process.poll() is None:
            for _ in selector.select(0.2):
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                raw.extend(chunk)
                stream.feed(chunk)
                if b"\x1b[6n" in chunk:
                    os.write(master, b"\x1b[1;1R")
                if b"\x1b[c" in chunk:
                    os.write(master, b"\x1b[?1;2c")
        base = out / f"{label}-{width}x70"
        base.with_suffix(".txt").write_text("\n".join(screen.display))
        base.with_suffix(".ansi").write_bytes(raw)
        font = ImageFont.truetype("/usr/share/fonts/noto/NotoSansMono-Regular.ttf", 17)
        image = Image.new("RGB", (width * 11, 70 * 23), "#101418")
        draw = ImageDraw.Draw(image)
        cells = []

        def color(value, default):
            return (
                "#" + value
                if len(value) == 6 and all(c in "0123456789abcdefABCDEF" for c in value)
                else default
            )

        for y in range(70):
            for x in range(width):
                cell = screen.buffer[y][x]
                fg, bg = color(cell.fg, "#c8d0d8"), color(cell.bg, "#101418")
                if cell.reverse:
                    fg, bg = bg, fg
                draw.rectangle((x * 11, y * 23, (x + 1) * 11, (y + 1) * 23), fill=bg)
                draw.text((x * 11, y * 23), cell.data, font=font, fill=fg)
                if cell.data.strip():
                    cells.append(
                        {
                            "x": x,
                            "y": y,
                            "text": cell.data,
                            "fg": cell.fg,
                            "bold": cell.bold,
                        }
                    )
        image.save(base.with_suffix(".png"))
        base.with_suffix(".json").write_text(json.dumps(cells))
        if not any(
            "Routing" in line and ("Automatic" in line or "Pinned" in line)
            for line in screen.display
        ):
            raise RuntimeError(f"Native routing status missing: {base}.txt")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        selector.close()
        os.close(master)
