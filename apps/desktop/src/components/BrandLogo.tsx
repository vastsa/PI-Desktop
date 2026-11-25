// This renderer-sized copy is derived from build/icon_1024.png.
import brandLogoUrl from "../assets/brand/logo.png";

export function BrandLogo({ size = 16 }: { size?: number }) {
  return (
    <img
      className="brand-logo"
      src={brandLogoUrl}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
