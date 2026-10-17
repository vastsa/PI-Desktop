// Test-only DNS boundary: this reserved name can never reach an external model.
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
const lookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (hostname !== "remote-mvp.test") return lookup.call(this, hostname, options, callback);
  const done = typeof options === "function" ? options : callback;
  queueMicrotask(() => {
    if (typeof options === "object" && options?.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
    else done(null, "127.0.0.1", 4);
  });
};
syncBuiltinESMExports();
