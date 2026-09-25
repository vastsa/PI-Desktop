import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import {
  decodeMcpStderr,
  discoverNodeExecutable,
  quoteWindowsCmdArg,
  resolveMcpStdioLaunch,
} from "../electron/main/mcp-stdio-launch.ts";
import { mcpProcessEnv } from "../electron/main/plugin-mcp.ts";
import { mcpStdioLauncherChoice } from "../src/components/extensions/mcp-stdio-launcher.ts";

const win = path.win32;

function winFs(files, links = {}) {
  const fileSet = new Set(files.map((file) => file.toLowerCase()));
  const linkMap = Object.fromEntries(
    Object.entries(links).map(([from, to]) => [from.toLowerCase(), to]),
  );
  return {
    isFile: (target) => fileSet.has(target.toLowerCase()),
    realpath: (target) => linkMap[target.toLowerCase()] ?? target,
  };
}

test("npx and uvx are the preset launchers; anything else is custom", () => {
  assert.equal(mcpStdioLauncherChoice("npx"), "npx");
  assert.equal(mcpStdioLauncherChoice("UVX"), "uvx");
  assert.equal(mcpStdioLauncherChoice(""), "custom");
  assert.equal(mcpStdioLauncherChoice(win.join("C:", "tools", "node.exe")), "custom");
});

test("the stdio environment copies profile keys and still strips host secrets", () => {
  const env = mcpProcessEnv(
    "com.example.mcp",
    { TOKEN: "t0ken" },
    {
      PATH: "/usr/bin",
      HOME: "/Users/pi",
      USERPROFILE: "C:\\Users\\pi",
      LOCALAPPDATA: "C:\\Users\\pi\\AppData\\Local",
      PATHEXT: ".EXE;.CMD",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PI_LEAKED_SECRET: "must-not-cross",
      OPENAI_API_KEY: "sk-no",
    },
  );
  assert.equal(env.PI_PLUGIN_ID, "com.example.mcp");
  assert.equal(env.TOKEN, "t0ken");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/Users/pi");
  assert.equal(env.USERPROFILE, "C:\\Users\\pi");
  assert.equal(env.LOCALAPPDATA, "C:\\Users\\pi\\AppData\\Local");
  assert.equal(env.PATHEXT, ".EXE;.CMD");
  assert.equal(env.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(env.PI_LEAKED_SECRET, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("fnm default node is discovered off PATH on Windows", () => {
  const local = win.join("C:", "Users", "zhao", "AppData", "Local");
  const version = win.join(local, "fnm", "node-versions", "v22.14.0");
  const installation = win.join(version, "installation");
  const node = win.join(installation, "node.exe");
  const found = discoverNodeExecutable({
    platform: "win32",
    home: win.join("C:", "Users", "zhao"),
    hostEnv: { LOCALAPPDATA: local, PATH: win.join("C:", "Windows", "System32") },
    fs: winFs(
      [node],
      { [win.join(local, "fnm", "aliases", "default")]: version },
    ),
  });
  assert.equal(found, node);
});

test("PATH node wins over an fnm install", () => {
  const local = win.join("C:", "Users", "zhao", "AppData", "Local");
  const pathNode = win.join("C:", "Program Files", "nodejs", "node.exe");
  const version = win.join(local, "fnm", "node-versions", "v22.14.0");
  const fnmNode = win.join(version, "installation", "node.exe");
  const found = discoverNodeExecutable({
    platform: "win32",
    home: win.join("C:", "Users", "zhao"),
    hostEnv: {
      LOCALAPPDATA: local,
      PATH: win.join("C:", "Program Files", "nodejs"),
      PATHEXT: ".EXE;.CMD",
    },
    fs: winFs(
      [pathNode, fnmNode],
      { [win.join(local, "fnm", "aliases", "default")]: version },
    ),
  });
  assert.equal(found.toLowerCase(), pathNode.toLowerCase());
});

test("npx rewrites to node plus npx-cli.js on macOS fnm", () => {
  const posix = path.posix;
  const home = "/Users/zhao";
  const version = posix.join(home, ".local", "share", "fnm", "node-versions", "v22.14.0");
  const node = posix.join(version, "installation", "bin", "node");
  const cli = posix.join(version, "installation", "lib", "node_modules", "npm", "bin", "npx-cli.js");
  const alias = posix.join(home, ".local", "share", "fnm", "aliases", "default");
  const launch = resolveMcpStdioLaunch({
    command: "npx",
    args: ["-y", "pkg"],
    env: { PATH: "/usr/bin" },
    platform: "darwin",
    home,
    hostEnv: { PATH: "/usr/bin", XDG_DATA_HOME: posix.join(home, ".local", "share") },
    fs: {
      isFile: (target) => target === node || target === cli,
      realpath: (target) => (target === alias ? version : target),
    },
  });
  assert.equal(launch.command, node);
  assert.deepEqual(launch.args, [cli, "-y", "pkg"]);
  assert.equal(launch.windowsHide, undefined);
});

test("npx rewrites to node plus npx-cli.js and prepends the install dir", () => {
  const local = win.join("C:", "Users", "zhao", "AppData", "Local");
  const version = win.join(local, "fnm", "node-versions", "v22.14.0");
  const installation = win.join(version, "installation");
  const node = win.join(installation, "node.exe");
  const cli = win.join(installation, "node_modules", "npm", "bin", "npx-cli.js");
  const launch = resolveMcpStdioLaunch({
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    env: { PATH: win.join("C:", "Windows", "System32") },
    platform: "win32",
    home: win.join("C:", "Users", "zhao"),
    hostEnv: { LOCALAPPDATA: local, PATH: win.join("C:", "Windows", "System32") },
    fs: winFs(
      [node, cli],
      { [win.join(local, "fnm", "aliases", "default")]: version },
    ),
  });
  assert.equal(launch.command, node);
  assert.deepEqual(launch.args, [cli, "-y", "@upstash/context7-mcp"]);
  assert.ok(launch.env.PATH.startsWith(`${installation}${win.delimiter}`));
  assert.equal(launch.windowsHide, true);
  assert.equal(launch.windowsVerbatimArguments, undefined);
});

test("official Windows Node rewrites npx to node.exe plus npx-cli.js", () => {
  const root = win.join("C:", "Program Files", "nodejs");
  const node = win.join(root, "node.exe");
  const cli = win.join(root, "node_modules", "npm", "bin", "npx-cli.js");
  const npxCmd = win.join(root, "npx.cmd");
  const npxSh = win.join(root, "npx");
  const launch = resolveMcpStdioLaunch({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env: { PATH: root },
    platform: "win32",
    home: win.join("C:", "Users", "alice"),
    hostEnv: { PATH: root, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    fs: winFs([node, cli, npxCmd, npxSh]),
  });
  assert.equal(launch.command.toLowerCase(), node.toLowerCase());
  assert.deepEqual(launch.args, [cli, "-y", "@modelcontextprotocol/server-memory"]);
  assert.equal(launch.windowsVerbatimArguments, undefined);
  assert.ok(launch.env.PATH.toLowerCase().includes(root.toLowerCase()));
});

test("official Windows Node prefers npx.cmd over the Git-Bash shim", () => {
  const root = win.join("C:", "Program Files", "nodejs");
  const node = win.join(root, "node.exe");
  const npxCmd = win.join(root, "npx.cmd");
  const npxSh = win.join(root, "npx");
  const comspec = win.join("C:", "Windows", "System32", "cmd.exe");
  const launch = resolveMcpStdioLaunch({
    command: "npx",
    args: ["-y", "pkg"],
    env: { PATH: root },
    platform: "win32",
    home: win.join("C:", "Users", "alice"),
    hostEnv: {
      PATH: root,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      ComSpec: comspec,
    },
    fs: winFs([node, npxCmd, npxSh]),
  });
  assert.equal(launch.command, comspec);
  // args[3] is the entire line wrapped in outer quotes for cmd.exe /s /c
  assert.match(launch.args[3] ?? "", /npx\.cmd/i);
  assert.ok(launch.args[3].startsWith('"'), "outer quote wraps the line");
});

test("uvx uses a sibling uvx.exe when present", () => {
  const bin = win.join("C:", "Users", "zhao", ".local", "bin");
  const uv = win.join(bin, "uv.exe");
  const uvx = win.join(bin, "uvx.exe");
  const launch = resolveMcpStdioLaunch({
    command: "uvx",
    args: ["mcp-server-git"],
    env: { PATH: win.join("C:", "Windows", "System32") },
    platform: "win32",
    home: win.join("C:", "Users", "zhao"),
    hostEnv: { PATH: win.join("C:", "Windows", "System32") },
    fs: winFs([uv, uvx]),
  });
  assert.equal(launch.command, uvx);
  assert.deepEqual(launch.args, ["mcp-server-git"]);
});

test("uvx falls back to uv tool run when uvx.exe is missing", () => {
  const bin = win.join("C:", "Users", "zhao", ".local", "bin");
  const uv = win.join(bin, "uv.exe");
  const launch = resolveMcpStdioLaunch({
    command: "uvx",
    args: ["mcp-server-git"],
    env: { PATH: win.join("C:", "Windows", "System32") },
    platform: "win32",
    home: win.join("C:", "Users", "zhao"),
    hostEnv: { PATH: win.join("C:", "Windows", "System32") },
    fs: winFs([uv]),
  });
  assert.equal(launch.command, uv);
  assert.deepEqual(launch.args, ["tool", "run", "mcp-server-git"]);
});

test("a remaining Windows .cmd shim is wrapped by cmd.exe with literal args", () => {
  const npxCmd = win.join("C:", "Users", "zhao", "AppData", "Roaming", "npm", "npx.cmd");
  const comspec = win.join("C:", "Windows", "System32", "cmd.exe");
  const launch = resolveMcpStdioLaunch({
    command: npxCmd,
    args: ["-y", "pkg&whoami"],
    env: { PATH: win.join("C:", "Windows", "System32") },
    platform: "win32",
    home: win.join("C:", "Users", "zhao"),
    hostEnv: {
      PATH: win.dirname(npxCmd),
      ComSpec: comspec,
      PATHEXT: ".EXE;.CMD",
    },
    fs: winFs([npxCmd]),
  });
  assert.equal(launch.command, comspec);
  assert.equal(launch.args[0], "/d");
  assert.equal(launch.args[1], "/s");
  assert.equal(launch.args[2], "/c");
  // The whole line is wrapped: "<cmd> <args>"
  assert.ok(launch.args[3].startsWith('"'), "outer quote wraps the line");
  assert.match(launch.args[3], /npx\.cmd/i);
  assert.match(launch.args[3], /"pkg&whoami"/);
  assert.equal(launch.windowsHide, true);
  assert.equal(launch.windowsVerbatimArguments, true);
});

test("cmd quoting keeps metacharacters inside one argument", () => {
  assert.equal(quoteWindowsCmdArg("ok"), "ok");
  assert.equal(quoteWindowsCmdArg("pkg&whoami"), '"pkg&whoami"');
  assert.equal(quoteWindowsCmdArg('say "hi"'), '"say ""hi"""');
  // % is doubled so cmd.exe does not expand environment variables
  assert.equal(quoteWindowsCmdArg("hello%PATH%world"), '"hello%%PATH%%world"');
  assert.equal(quoteWindowsCmdArg("%FOO%"), '"%%FOO%%"');
});

test("Windows stderr strings stay intact and buffers decode without throwing", () => {
  const text = '"node" is not recognized as an internal or external command';
  assert.equal(decodeMcpStderr(text, "win32"), text);
  assert.equal(decodeMcpStderr(Buffer.from(text, "utf8"), "darwin"), text);
  const chinese = "找不到命令: npx";
  assert.equal(decodeMcpStderr(Buffer.from(chinese, "utf8"), "win32"), chinese);
  const gbkNode = Buffer.from([0x27, 0x6e, 0x6f, 0x64, 0x65, 0x27]);
  assert.match(decodeMcpStderr(gbkNode, "win32", true), /node/);
});

test("wrapCmdShim outer-quotes survive when .cmd path contains spaces", () => {
  const npxCmd = win.join("C:", "Program Files", "nodejs", "npx.cmd");
  const comspec = win.join("C:", "Windows", "System32", "cmd.exe");
  const launch = resolveMcpStdioLaunch({
    command: npxCmd,
    args: ["-y", "pkg&whoami", 'say "hi"'],
    env: { PATH: win.join("C:", "Windows", "System32") },
    platform: "win32",
    home: win.join("C:", "Users", "alice"),
    hostEnv: {
      PATH: win.dirname(npxCmd),
      ComSpec: comspec,
      PATHEXT: ".EXE;.CMD",
    },
    fs: winFs([npxCmd]),
  });
  assert.equal(launch.command, comspec);
  const line = launch.args[3];
  // The whole line is wrapped in one pair of outer quotes for /s /c.
  assert.ok(line.startsWith('"'), "starts with outer quote");
  assert.ok(line.endsWith('"'), "ends with outer quote");
  // After /s strips the outer quotes, the inner structure stays intact:
  // "<path with spaces>" -y "pkg&whoami" "say ""hi"""
  const inner = line.slice(1, -1);
  assert.match(inner, /^"[^"]*npx\.cmd"/i, "path is quoted");
  assert.match(inner, /"pkg&whoami"/, "metachar arg stays quoted");
  assert.match(inner, /"say ""hi"""/, "embedded quotes doubled");
});
