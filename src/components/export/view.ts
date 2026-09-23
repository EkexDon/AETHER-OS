/** The Export view's registry entry (`src/views/registry.tsx`). */
import { lazy } from "react";
import { Share } from "lucide-react";
import type { ViewDefinition } from "../../views/registry";

const ExportView = lazy(() => import("./ExportView").then((m) => ({ default: m.ExportView })));

/** Export & publishing: standalone HTML/PDF, static site, Markdown bundle. */
export const exportView: ViewDefinition = {
  mode: "export",
  label: "Export",
  icon: Share,
  group: "knowledge",
  component: ExportView,
  description: "Publish notes as HTML, PDF, a website or a Markdown bundle",
};
