import type { BrowserWindow } from 'electron';

const pending = new WeakMap<BrowserWindow, ReturnType<typeof setTimeout>>();

/** Explicit user activation only; never call from background refresh. */
export function activateWindow(window: BrowserWindow) {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.moveTop();
  window.focus();
  window.webContents.focus();
  if (window.isFocused() || window.isAlwaysOnTop()) return;
  // Windows may deny a plain focus request for a previously covered window.
  window.setAlwaysOnTop(true);
  window.moveTop(); window.focus(); window.webContents.focus();
  const previous = pending.get(window); if (previous) clearTimeout(previous);
  const release = () => {
    const timer=pending.get(window); if(timer)clearTimeout(timer);
    pending.delete(window);
    if(!window.isDestroyed())window.setAlwaysOnTop(false);
    window.removeListener('blur',release);window.removeListener('hide',release);
  };
  pending.set(window,setTimeout(release,200));
  window.once('blur',release);window.once('hide',release);
}
