import { once } from "node:events";
import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const [directory, id] = process.argv.slice(2);
await writeFile(join(directory, `${id}.ready`), "");
while (true) {
  try { await access(join(directory, "release")); break; }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await setTimeout(20);
  }
}
const chunk = `${"*".repeat(100)}\n`.repeat(1_000);
for (let batch = 0; batch < 100; batch++) {
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream.write(chunk)) await once(stream, "drain");
  }
}
process.stdout.write(`stdout-done-${id}\n`);
process.stderr.write(`stderr-done-${id}\n`);
