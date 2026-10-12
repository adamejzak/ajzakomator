/**
 * Options of an OS notification. It is always silent: the app plays the sound the user chose for the event itself
 * (preset, system beep or own file), so the OS notification sound would double it, and "sound off" must really be silent.
 */
export function notificationOptions(n: { title: string; body: string }): { title: string; body: string; silent: true } {
  return { title: String(n.title).slice(0, 200), body: String(n.body).slice(0, 500), silent: true };
}
