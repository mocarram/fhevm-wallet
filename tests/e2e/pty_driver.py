#!/usr/bin/env python3
"""Drive the built CLI in a pseudo-terminal of a fixed size (no native Node modules).

Usage: python3 -I pty_driver.py <script.json>

The script is JSON: {"argv": [...], "env": {...}, "cols": 100, "rows": 32, "steps": [...]}.
Steps:
  {"keys": "text"}          write bytes (use \\u001b for Esc, \\r for Enter, \\u0003 for Ctrl+C)
  {"expect": "text", "timeout": 10}   wait until the current screen contains the text
  {"absent": "text"}        fail if the current screen contains the text
  {"sleep": 0.6}            wait (needed after a bare Esc: readline waits 500 ms for more)
  {"exit": 0, "timeout": 10}  wait for the process to exit with this code

"Current screen" is the text after the last cursor-home sequence, with ANSI codes removed:
the TUI redraws whole frames, so that is what the user sees. On failure the driver prints
the screen and exits with status 1. On success it prints {"ok": true, "screens": [...]}
with the screen after each expect step.
"""

import fcntl
import json
import os
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]")


def screen_of(buf: str) -> str:
    """Text of the most recent frame."""
    i = buf.rfind("\x1b[H")
    frame = buf[i:] if i >= 0 else buf
    return ANSI.sub("", frame).replace("\r", "")


def main() -> int:
    with open(sys.argv[1], encoding="utf-8") as f:
        script = json.load(f)
    cols, rows = script.get("cols", 100), script.get("rows", 32)
    master, slave = os.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    env = dict(script.get("env", {}))
    proc = subprocess.Popen(
        script["argv"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave)
    buf = ""
    screens = []

    def pump(timeout: float) -> None:
        nonlocal buf
        r, _, _ = select.select([master], [], [], timeout)
        if r:
            try:
                data = os.read(master, 65536)
            except OSError:
                return
            buf += data.decode("utf-8", errors="replace")

    def fail(msg: str) -> int:
        sys.stdout.write(json.dumps({"ok": False, "error": msg, "screen": screen_of(buf)}) + "\n")
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        return 1

    for n, step in enumerate(script["steps"]):
        if "keys" in step:
            os.write(master, step["keys"].encode("utf-8"))
            pump(0.05)
            time.sleep(step.get("delay", 0.15))
        elif "sleep" in step:
            end = time.time() + step["sleep"]
            while time.time() < end:
                pump(0.05)
        elif "expect" in step:
            end = time.time() + step.get("timeout", 10)
            while step["expect"] not in screen_of(buf):
                if time.time() > end:
                    return fail(f"step {n}: timed out waiting for {step['expect']!r}")
                if proc.poll() is not None:
                    pump(0.1)
                    if step["expect"] in screen_of(buf):
                        break
                    return fail(f"step {n}: process exited ({proc.returncode}) before {step['expect']!r}")
                pump(0.1)
            screens.append(screen_of(buf))
        elif "absent" in step:
            pump(0.1)
            if step["absent"] in screen_of(buf):
                return fail(f"step {n}: unexpected {step['absent']!r}")
        elif "exit" in step:
            end = time.time() + step.get("timeout", 10)
            while proc.poll() is None:
                if time.time() > end:
                    return fail(f"step {n}: process did not exit")
                pump(0.1)
            for _ in range(5):
                pump(0.05)
            if proc.returncode != step["exit"]:
                return fail(f"step {n}: exit code {proc.returncode}, wanted {step['exit']}")
            i = buf.rfind("\x1b[?1049l")
            tail = ANSI.sub("", buf[i:] if i >= 0 else buf).replace("\r", "")
            screens.append(tail)
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGKILL)
    sys.stdout.write(json.dumps({"ok": True, "screens": screens}) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
