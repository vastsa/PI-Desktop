/**
 * Executable resolution tests.
 *
 * These run against real files in a temp directory, because the whole point of
 * the module is filesystem behaviour. Only `env` and `platform` are injected,
 * so the Windows code path is exercised on any machine.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveAcpExecutable } from "../src/resolve.ts"

const WIN_ENV = {
  PATH: "",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
} as NodeJS.ProcessEnv

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "acp-resolve-"))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\@scope\\cli\\bin\\tool.exe"   %*
`

test("a bare .exe on PATH is used directly", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "agent.exe"), "")
    const r = resolveAcpExecutable("agent", { ...WIN_ENV, PATH: dir }, "win32")
    assert.equal(r.command, join(dir, "agent.exe"))
    assert.equal(r.viaShell, false)
    assert.equal(r.source, "path:.exe")
  })
})

test("an npm .cmd shim resolves to the real binary, with no shell", () => {
  withTempDir((dir) => {
    const binDir = join(dir, "node_modules", "@scope", "cli", "bin")
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, "tool.exe"), "")
    writeFileSync(join(dir, "agent.cmd"), NPM_SHIM)

    const r = resolveAcpExecutable("agent", { ...WIN_ENV, PATH: dir }, "win32")
    // This is the whole point: the shim is never handed to a shell.
    assert.equal(r.command, join(binDir, "tool.exe"))
    assert.equal(r.viaShell, false)
    assert.equal(r.source, "npm-shim")
    assert.deepEqual(r.prefixArgs, [])
  })
})

test("an unparseable shim falls back to cmd.exe and says so", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "agent.cmd"), "@ECHO off\r\nREM nothing to parse here\r\n")
    const r = resolveAcpExecutable("agent", { ...WIN_ENV, PATH: dir }, "win32")
    assert.equal(r.viaShell, true)
    assert.equal(r.source, "unparsed-shim")
    assert.equal(r.command, WIN_ENV.ComSpec)
    assert.equal(r.prefixArgs[0], "/d")
  })
})

test("a shim pointing at a missing binary is not trusted", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "agent.cmd"), NPM_SHIM)
    const r = resolveAcpExecutable("agent", { ...WIN_ENV, PATH: dir }, "win32")
    // No real binary behind the shim, so we do not pretend we found one.
    assert.equal(r.viaShell, true)
  })
})

test("a command that is nowhere falls back to cmd.exe", () => {
  withTempDir((dir) => {
    const r = resolveAcpExecutable("nope-not-here", { ...WIN_ENV, PATH: dir }, "win32")
    assert.equal(r.viaShell, true)
    assert.equal(r.source, "comspec-fallback")
  })
})

test("PATH lookup is case-insensitive, like Windows", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "Agent.CMD"), NPM_SHIM.replace("tool.exe", "other.exe"))
    const r = resolveAcpExecutable("agent", { ...WIN_ENV, PATH: dir }, "win32")
    assert.match(r.source, /shim/)
  })
})

test("posix is passed through untouched", () => {
  const r = resolveAcpExecutable("opencode", {}, "linux")
  assert.equal(r.command, "opencode")
  assert.equal(r.viaShell, false)
  assert.equal(r.source, "posix")
})

test("an absolute path is honoured without a PATH lookup", () => {
  withTempDir((dir) => {
    const exe = join(dir, "custom-agent.exe")
    writeFileSync(exe, "")
    const r = resolveAcpExecutable(exe, { ...WIN_ENV, PATH: "" }, "win32")
    assert.equal(r.command, exe)
    assert.equal(r.viaShell, false)
  })
})
