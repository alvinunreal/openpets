import assert from "node:assert/strict";

import { getLinuxX11RelaunchArgs } from "../src/linux-ozone-startup.js";

assert.deepEqual(
  getLinuxX11RelaunchArgs("linux", false, ["/opt/OpenPets/openpets", "--user-data-dir=/tmp/profile"]),
  ["--user-data-dir=/tmp/profile", "--ozone-platform=x11"],
  "Linux startup should relaunch the browser process itself with the X11 backend",
);
assert.equal(
  getLinuxX11RelaunchArgs("linux", false, ["/opt/OpenPets/openpets", "--ozone-platform=x11"]),
  null,
  "an already-correct X11 process must not relaunch again",
);
assert.deepEqual(
  getLinuxX11RelaunchArgs("linux", false, ["/opt/OpenPets/openpets", "--ozone-platform", "wayland", "--inspect=9229"]),
  ["--inspect=9229", "--ozone-platform=x11"],
  "the forced backend should replace conflicting split-form Ozone arguments without dropping unrelated arguments",
);
assert.deepEqual(
  getLinuxX11RelaunchArgs("linux", false, ["/opt/OpenPets/openpets", "--ozone-platform=auto"]),
  ["--ozone-platform=x11"],
  "the forced backend should replace conflicting equals-form Ozone arguments",
);
assert.equal(
  getLinuxX11RelaunchArgs("linux", true, ["/opt/OpenPets/openpets", "--ozone-platform=wayland"]),
  null,
  "the explicit native Wayland escape hatch must not relaunch",
);
assert.equal(
  getLinuxX11RelaunchArgs("darwin", false, ["/Applications/OpenPets.app/Contents/MacOS/OpenPets"]),
  null,
  "non-Linux startup must remain unchanged",
);

console.log("Linux Ozone startup validation passed.");
