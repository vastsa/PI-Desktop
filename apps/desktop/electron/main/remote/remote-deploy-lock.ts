/** Linux kernel-owned deployment lock; unsupported-platform shell fixtures use mkdir. */
export const REMOTE_DEPLOY_LOCK_SCRIPT = `
directory_lock=""
if [ "$(uname -s)" = "Linux" ]; then
  command -v flock >/dev/null 2>&1 || die "missing-flock"
  exec 9>"$base/.deploy.lock"
  flock -w 120 9 || die "deployment-busy"
else
  directory_lock="$base/.deploy-lock"
  mkdir "$directory_lock" 2>/dev/null || die "deployment-busy"
fi
release_deploy_lock() {
  [ -z "$directory_lock" ] || rmdir "$directory_lock" 2>/dev/null || true
}
`;
