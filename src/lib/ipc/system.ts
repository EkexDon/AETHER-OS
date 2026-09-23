/** System monitor commands (`src-tauri/src/commands/system_commands.rs`). */
import type { SystemMetrics } from "../../types";
import { call } from "./core";

/** One snapshot of CPU, memory, disks, network, processes and battery. */
export const getSystemMetrics = () => call<SystemMetrics>("cmd_get_system_metrics");
