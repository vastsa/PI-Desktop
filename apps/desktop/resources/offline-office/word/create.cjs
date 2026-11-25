const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const [docx, output, title] = process.argv.slice(2);
  if (path.extname(output).toLowerCase() !== ".docx") throw new Error("Use a .docx output filename.");

  let library;
  try {
    if (require(path.join(docx, "package.json")).version !== "9.16.0") throw new Error("Expected docx 9.16.0.");
    library = require(docx);
  } catch (error) {
    throw new Error(`The bundled Office Runtime is incomplete: ${error.message}`);
  }
  const { Document, HeadingLevel, Packer, Paragraph } = library;
  const lines = fs.readFileSync(0, "utf8").replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const children = lines.map((text) => new Paragraph(text));
  if (title) children.unshift(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }));
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children }] }));

  const scratch = fs.mkdtempSync(path.join(path.dirname(output), ".pie-word-"));
  try {
    const staged = path.join(scratch, "document.docx");
    fs.writeFileSync(staged, bytes);
    fs.linkSync(staged, output);
  } finally {
    fs.rmSync(scratch, { recursive: true });
  }
  console.log(`Created ${output}`);
}

main().catch((error) => {
  console.error(error.code === "EEXIST" ? "Output already exists; choose a new filename." : error.message);
  process.exitCode = 1;
});
