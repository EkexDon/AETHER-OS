/** Version of the running build, taken from `package.json` at build time. */
import pkg from "../../../package.json";

/** The app version (`0.2.0`), compared with `version_seen` for "What's new". */
export const APP_VERSION: string = pkg.version;
