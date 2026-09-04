import mascotFramesUrl from "../assets/home-mascot/mascot-frames.png";

export function HomeMascotLogo() {
  return (
    <svg
      className="home-mascot-logo"
      data-testid="home-mascot-logo"
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
    >
      <g className="home-mascot-orbit">
        <circle className="home-mascot-orbit-ring" cx="50" cy="50" r="30" />
        <circle className="home-mascot-orbit-dot" cx="50" cy="20" r="2.5" />
      </g>
      <g className="home-mascot-core">
        <path className="home-mascot-antenna" d="M50 31V24" />
        <circle className="home-mascot-antenna-dot" cx="50" cy="21" r="2.5" />
        <image
          className="home-mascot-frames"
          href={mascotFramesUrl}
          x="25"
          y="31"
          width="50"
          height="200"
        />
        <g className="home-mascot-eyes">
          <circle className="home-mascot-eye" cx="44" cy="50" r="2.5" />
          <circle className="home-mascot-eye" cx="56" cy="50" r="2.5" />
        </g>
        <path className="home-mascot-mouth" d="M45 55c1.5 1.5 3.5 2.25 5 2.25s3.5-.75 5-2.25" />
        <path className="home-mascot-feet" d="M37 71v4m26-4v4" />
      </g>
    </svg>
  );
}
