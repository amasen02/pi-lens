import teardown from "./git-config-guard.js";

export default function setup(): () => void {
	return teardown;
}
