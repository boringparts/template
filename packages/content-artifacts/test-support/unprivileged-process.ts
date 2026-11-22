// root bypasses author directory permissions; non-root users keep their current identity.
export const unprivilegedProcessOptions =
  process.geteuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
