// 只检测两次独立 Shift 轻按，不保存输入内容。长按、组合键和中间其他按键会取消。
export function doubleShift(onDouble: () => void, shifts: readonly number[], interval = 400) {
  let held: number | null = null;
  let downAt = 0;
  let lastTap: number | null = null;
  let interrupted = false;
  return (kind: 'down' | 'up' | 'cancel', code: number, modified = false, now = Date.now()) => {
    if (kind === 'cancel') { held = null; lastTap = null; interrupted = true; return; }
    if (!shifts.includes(code) || modified) {
      lastTap = null; interrupted = true;
      // A modified Shift release must release our state too, or the next tap is lost.
      if (kind === 'up' && held === code) held = null;
      return;
    }
    if (kind === 'down') {
      if (held !== null) { if (held !== code) interrupted = true; return; }
      held = code; downAt = now; interrupted = false;
    } else if (held === code) {
      held = null;
      if (interrupted || now - downAt > 500) { lastTap = null; return; }
      if (lastTap !== null && now - lastTap <= interval) { lastTap = null; onDouble(); }
      else lastTap = now;
    }
  };
}
