import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/index.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/system/ErrorBoundary";
import { installGlobalErrorHandlers } from "./lib/diagnostics";
import { installOverflowTitles } from "./ui/overflowTitle";

installGlobalErrorHandlers();
installOverflowTitles();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary name="AETHER-OS" root>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
