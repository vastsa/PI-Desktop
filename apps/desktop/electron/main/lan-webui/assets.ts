// Bundled into Main by Vite so the packaged app serves the same files.
import indexHtml from "../../../resources/lan-webui/index.html?raw";
import appJs from "../../../resources/lan-webui/app.js?raw";
import stylesCss from "../../../resources/lan-webui/styles.css?raw";
import localeJs from "../../../resources/lan-webui/locale.js?raw";
import kitJs from "../../../resources/lan-webui/kit.js?raw";
import markdownJs from "../../../resources/lan-webui/markdown.js?raw";
import modelPickerJs from "../../../resources/lan-webui/model-picker.js?raw";
import type { LanAsset } from "./server";

export function lanWebUiAssets(): ReadonlyMap<string, LanAsset> {
  return new Map<string, LanAsset>([
    ["/index.html", { type: "text/html; charset=utf-8", body: indexHtml }],
    ["/app.js", { type: "text/javascript; charset=utf-8", body: appJs }],
    ["/locale.js", { type: "text/javascript; charset=utf-8", body: localeJs }],
    ["/kit.js", { type: "text/javascript; charset=utf-8", body: kitJs }],
    ["/markdown.js", { type: "text/javascript; charset=utf-8", body: markdownJs }],
    ["/model-picker.js", { type: "text/javascript; charset=utf-8", body: modelPickerJs }],
    ["/styles.css", { type: "text/css; charset=utf-8", body: stylesCss }],
  ]);
}
