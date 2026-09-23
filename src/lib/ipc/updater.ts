/** Update check command (`src-tauri/src/commands/updater_commands.rs`). */
import type { UpdateInfo } from "../../types";
import { call } from "./core";

/** Compare the running version with the latest GitHub release (8 s timeout). */
export const checkForUpdates = () => call<UpdateInfo>("cmd_check_for_updates");
