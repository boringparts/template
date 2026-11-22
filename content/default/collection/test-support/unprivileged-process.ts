// Root bypasses directory permission checks on author directories; non-root users keep their current identity.
export const unprivilegedProcessOptions =
  process.geteuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
