export async function waitForChildExitWithEscalation(
  child,
  {
    termAfterMs = 60_000,
    killAfterMs = 65_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  let killedBy = null;
  const termTimer = setTimer(() => {
    killedBy = "SIGTERM";
    child.kill("SIGTERM");
  }, termAfterMs);
  const killTimer = setTimer(() => {
    killedBy = "SIGKILL";
    child.kill("SIGKILL");
  }, killAfterMs);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, killedBy };
  } finally {
    clearTimer(termTimer);
    clearTimer(killTimer);
  }
}
