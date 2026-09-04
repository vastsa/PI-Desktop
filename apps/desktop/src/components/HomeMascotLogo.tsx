import mascotMotionUrl from "../assets/home-mascot.gif";
import mascotStillUrl from "../assets/home-mascot-still.png";

export function HomeMascotLogo() {
  return (
    <span
      className="home-mascot-logo"
      data-testid="home-mascot-logo"
      aria-hidden="true"
    >
      <img
        className="home-mascot-motion"
        src={mascotMotionUrl}
        alt=""
        width={100}
        height={100}
        draggable={false}
      />
      <img
        className="home-mascot-still"
        src={mascotStillUrl}
        alt=""
        width={100}
        height={100}
        draggable={false}
      />
    </span>
  );
}
