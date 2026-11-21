#!/usr/bin/env python3
"""Drive the built CLI in a pseudo-terminal of a fixed size (no native Node modules).

Usage: python3 -I pty_driver.py <script.json>

The script is JSON: {"argv": [...], "env": {...}, "cols": 100, "rows": 32, "steps": [...]}.
Steps:
  {"keys": "text"}          write bytes (use \\u001b for Esc, \\r for Enter, \\u0003 for Ctrl+C)
  {"expect": "text", "timeout": 10}   wait until the current screen contains the text
  {"absent": "text"}        fail if the current screen contains the text
  {"sleep": 0.3}            wait (e.g. after a bare Esc, which the TUI reports after 25 ms)
  {"exit": 0, "timeout": 10}  wait for the process to exit with this code
  {"raw_last": ["a", "b"]}  fail unless the raw output's last "b" comes after its last "a"
                            (e.g. bracketed paste switched off after it was switched on)

"Current screen" is what a terminal would show: the output is run through a small screen
emulator (cursor moves, line clears, the alternate screen), because the TUI rewrites only
the rows that changed. On failure the driver prints
the screen and exits with status 1. On success it prints {"ok": true, "screens": [...]}
with the screen after each expect step.
"""

import codecs
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


SEQ = re.compile(r"\x1b\[([0-9;?]*)([ -/]*)([@-~])|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]")


class Screen:
    """Just enough of a terminal for the TUI: text, CR/LF, cursor position, erase."""

    def __init__(self, cols: int, rows: int) -> None:
        self.cols, self.rows = cols, rows
        self.clear()

    def clear(self) -> None:
        self.grid = [[" "] * self.cols for _ in range(self.rows)]
        self.r = self.c = 0

    def feed(self, data: str) -> None:
        i = 0
        while i < len(data):
            ch = data[i]
            if ch == "\x1b":
                m = SEQ.match(data, i)
                if not m:
                    i += 1
                    continue
                i = m.end()
                if m.group(3) is None:
                    continue
                params, final = m.group(1), m.group(3)
                if final in "Hf":
                    nums = [int(x) if x else 1 for x in (params.split(";") if params else [])]
                    self.r = min(self.rows - 1, max(0, (nums[0] if nums else 1) - 1))
                    self.c = min(self.cols - 1, max(0, (nums[1] if len(nums) > 1 else 1) - 1))
                elif final == "K":
                    for x in range(self.c, self.cols):
                        self.grid[self.r][x] = " "
                elif final == "J" and params == "2":
                    self.grid = [[" "] * self.cols for _ in range(self.rows)]
                elif final in "hl" and params == "?1049":
                    self.clear()
                continue
            i += 1
            if ch == "\r":
                self.c = 0
            elif ch == "\n":
                self.newline()
            elif ch >= " ":
                if self.c >= self.cols:
                    self.c = 0
                    self.newline()
                self.grid[self.r][self.c] = ch
                self.c += 1

    def newline(self) -> None:
        if self.r < self.rows - 1:
            self.r += 1
        else:
            self.grid = self.grid[1:] + [[" "] * self.cols]

    def text(self) -> str:
        return "\n".join("".join(row).rstrip() for row in self.grid)


SCREEN = Screen(100, 32)


def screen_of(_buf: str) -> str:
    """What the terminal shows now."""
    return SCREEN.text()


def main() -> int:
    with open(sys.argv[1], encoding="utf-8") as f:
        script = json.load(f)
    cols, rows = script.get("cols", 100), script.get("rows", 32)
    global SCREEN
    # A pty that reports 0x0 is drawn at 80x24 by the TUI.
    SCREEN = Screen(cols or 80, rows or 24)
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
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    def pump(timeout: float) -> None:
        nonlocal buf
        r, _, _ = select.select([master], [], [], timeout)
        if r:
            try:
                data = os.read(master, 65536)
            except OSError:
                return
            text = decoder.decode(data)
            buf += text
            SCREEN.feed(text)

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
        elif "raw_last" in step:
            first, then = step["raw_last"]
            a, b = buf.rfind(first), buf.rfind(then)
            if a < 0 or b < a:
                return fail(f"step {n}: {then!r} does not follow the last {first!r}")
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
