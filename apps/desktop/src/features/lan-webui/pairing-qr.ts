import qrcode from "qrcode-generator";

export function pairingQr(origin: string, code: string) {
  const url = new URL(origin);
  // Loopback points at the device scanning the code, not at this computer.
  if (url.hostname === "127.0.0.1") return null;
  // Fragments stay in the browser; the HTTP request does not contain the code.
  url.hash = `pair=${code}`;
  const qr = qrcode(0, "M");
  qr.addData(url.toString());
  qr.make();
  const count = qr.getModuleCount();
  const quietZone = 4;
  const path: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path.push(`M${col + quietZone} ${row + quietZone}h1v1h-1z`);
    }
  }
  return { size: count + quietZone * 2, path: path.join("") };
}
