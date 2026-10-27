// Tests and recorded environments depend on Bun's built-in TOML parser and
// runtime identity, so checks fail fast on a Bun other than the pinned one.
import packageJson from "../package.json";

const pinned = /^bun@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager)?.[1];
if (pinned === undefined) {
  console.error(`package.json packageManager must pin an exact bun@x.y.z, got ${JSON.stringify(packageJson.packageManager)}`);
  process.exit(1);
}
if (Bun.version !== pinned) {
  console.error(`Bun ${Bun.version} does not match the pinned bun@${pinned}; install it (e.g. \`curl -fsSL https://bun.sh/install | bash -s bun-v${pinned}\`) and retry.`);
  process.exit(1);
}
