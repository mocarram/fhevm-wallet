// Copy button and screenshot gallery. Plain JS, no dependencies.
(() => {
  // Copy the install command; some app views refuse the clipboard, so fall back to selecting it.
  const btn = document.getElementById('copy-btn');
  const cmd = document.getElementById('install-cmd');
  btn.addEventListener('click', () => {
    const done = () => {
      btn.textContent = 'Copied';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1600);
    };
    const select = () => {
      const r = document.createRange();
      r.selectNodeContents(cmd);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      btn.textContent = 'Selected';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1600);
    };
    try {
      navigator.clipboard.writeText(cmd.textContent.trim()).then(done, select);
    } catch (e) {
      select();
    }
  });

  const SHOTS = [
    [
      'home_sent',
      '.',
      'Home after a send',
      'The result, the command to repeat it next time, and your decrypted balances.',
    ],
    ['command_bar', ':', 'Command bar', 'Type :send bob 0.25 czama from any screen.'],
    [
      'send_review',
      's',
      'Review',
      'Simulated and checked against your decrypted balance before you sign.',
    ],
    [
      'send_countdown',
      'esc',
      'Countdown',
      'Five seconds to change your mind. Nothing is broadcast yet.',
    ],
    ['balances', 'b', 'Balances', 'One signature decrypts every tracked token.'],
    ['wrap_amount', 'w', 'Wrap', 'ZAMA into cZAMA, with an exact approval and the dust shown.'],
    ['history', 'h', 'History', 'Sends, wraps and unwraps, decrypted when you ask.'],
    ['receive', 'r', 'Receive', 'Your address and a QR code a phone wallet can scan.'],
    ['help', '?', 'Keyboard help', 'Every key for the screen you are on.'],
    ['doctor', 'd', 'Doctor', 'Node, data folder, RPC, relayer, gas and tokens at a glance.'],
  ];
  const img = document.getElementById('g-img');
  const key = document.getElementById('g-key');
  const title = document.getElementById('g-title');
  const cap = document.getElementById('g-cap');
  const pos = document.getElementById('g-pos');
  const strip = document.getElementById('g-thumbs');
  let at = 0;
  const thumbs = SHOTS.map(([file, , name], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'thumb';
    b.setAttribute('role', 'listitem');
    b.setAttribute('aria-label', 'Show ' + name);
    const t = document.createElement('img');
    t.src = 'assets/screenshots/' + file + '.png';
    t.alt = '';
    t.loading = 'lazy';
    const s = document.createElement('span');
    s.textContent = name;
    b.append(t, s);
    b.addEventListener('click', () => show(i));
    strip.append(b);
    return b;
  });
  function show(i) {
    at = (i + SHOTS.length) % SHOTS.length;
    const [file, k, name, text] = SHOTS[at];
    img.src = 'assets/screenshots/' + file + '.png';
    img.alt = name + ': ' + text;
    key.textContent = k;
    title.textContent = name;
    cap.textContent = text;
    pos.textContent = at + 1 + ' / ' + SHOTS.length;
    thumbs.forEach((b, j) => b.setAttribute('aria-current', j === at ? 'true' : 'false'));
    const tb = thumbs[at];
    strip.scrollTo({
      left: tb.offsetLeft - strip.offsetLeft - 2,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }
  document.getElementById('g-prev').addEventListener('click', () => show(at - 1));
  document.getElementById('g-next').addEventListener('click', () => show(at + 1));
  // Arrow keys move through the screens while the gallery has focus (not page-wide).
  document.getElementById('gallery').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') {
      show(at + 1);
      e.preventDefault();
    }
    if (e.key === 'ArrowLeft') {
      show(at - 1);
      e.preventDefault();
    }
  });
  // Warm the cache so switching screens is instant.
  SHOTS.forEach(([file]) => {
    const p = new Image();
    p.src = 'assets/screenshots/' + file + '.png';
  });
  show(0);
})();
