"""Run a command in a pseudo-terminal, answer its password prompt, print what it wrote.

Usage: python3 pty-run.py <answer> <timeout-seconds> <command> [args...]
Exits with the command's exit code (124 on timeout). Used by the e2e tests to drive
prompts that refuse to run without a terminal.
"""
import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time

answer, timeout, argv = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
# A new pty is 0x0; spinners then think every line wraps forever. Give it a real size.
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

out = b""
answered = False
deadline = time.time() + timeout
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if not ready:
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break  # the child closed the terminal
    if not chunk:
        break
    out += chunk
    if not answered and b"password" in out.lower():
        os.write(fd, answer.encode() + b"\r")
        answered = True
else:
    os.kill(pid, 9)
    sys.stdout.buffer.write(out)
    sys.exit(124)

_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(status))
