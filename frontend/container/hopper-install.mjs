// Image build step: installs Hopper's official demo with this fork's own
// Linux installer. It downloads the current release, checks the publisher's
// PGP signature and launcher identity, retains that evidence under
// $HOME/.cache/rea (mounted from the host), then runs dnf. Usage:
//   node hopper-install.mjs /path/to/rea/checkout

const [repo] = process.argv.slice(2);
if (!repo) {
  console.error("Usage: node hopper-install.mjs /path/to/rea/checkout");
  process.exit(2);
}
const { installLinuxHopper, systemLinuxHopperInstallHost } = await import(
  `${repo}/dist/application/LinuxHopper.js`
);
const host = systemLinuxHopperInstallHost(process.env);
try {
  const result = await installLinuxHopper(host);
  if (result.status !== "installed") {
    console.error(
      `Hopper was not installed (${result.reason}).${result.verificationFailure ? ` ${result.verificationFailure.message}` : ""}${result.packageFailure ? ` ${result.packageFailure.command}: ${result.packageFailure.stderr}` : ""}`,
    );
    process.exit(1);
  }
  console.log(`Hopper installed at ${result.launcherPath}.`);
  if (result.warning) console.log(`Warning: ${result.warning}`);
} finally {
  await host.close?.();
}
